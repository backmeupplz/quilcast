//! The app's state and everything that changes it: routes, loading from the node, signing in, and writes.
//! Views (view.rs) only read it. Every change comes from an event, a finished request or a timer (lib.rs), after
//! which the page is drawn again.

use crate::api::*;
use crate::dom::Dom;
use crate::mutes::Mutes;
use crate::{fc, host, text};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// the account in use
pub(crate) const ACCOUNT_KEY: &str = "quilcast-wasm:account";
/// every account signed in here, the one in use among them (src/me.rs)
pub(crate) const ACCOUNTS_KEY: &str = "quilcast-wasm:accounts";
const SETTINGS_KEY: &str = "quilcast-wasm:settings";
const LOCAL_KEY: &str = "quilcast-wasm:local-follows";
const RECENTS_KEY: &str = "quilcast-wasm:browsed";
pub const DEFAULT_NODE: &str = "https://haatz.quilibrium.com";
pub const OPTIMISM_RPC: &str = "https://mainnet.optimism.io";
/// Bytes a cast may hold (over 320 it's sent as a long cast).
pub const MAX_CAST: usize = 1024;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Tab {
    People,
    Casts,
    Channels,
}

#[derive(Clone, PartialEq, Debug)]
pub enum Route {
    /// Home: the Following feed, or Trending (`true`)
    Home(bool),
    /// Home as someone else (`/?as=<username or fid>`): their Following feed, read-only
    Browse(String),
    Cast(String),
    /// Who liked ("likes"), recast ("recasts") or quoted ("quotes") a cast
    Who(String, &'static str),
    /// A profile by name or FID, its replies tab when `true`
    User(String, bool),
    /// Whom someone follows ("following") or who follows them ("followers")
    Follows(String, &'static str),
    Channels,
    Channel(String),
    Notifications,
    Search(String, Tab),
    Join,
    Settings,
    NotFound,
}

/// Who `?as=` asks for: a FID or a username (fnames and ENS names), else None (src/browse.ts asOf).
pub fn as_of(q: &str) -> Option<String> {
    let v = text::param(q, "as")?.trim().trim_start_matches('@').to_lowercase();
    let digits = !v.is_empty() && v.len() <= 10 && v.bytes().all(|b| b.is_ascii_digit());
    let name = v.len() <= 64 && v.bytes().next().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) && v.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b));
    (digits || name).then_some(v)
}

/// A channel id as farcaster.xyz writes them.
pub fn is_channel_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub fn parse_route(path_q: &str) -> Route {
    let (path, q) = path_q.split_once('?').unwrap_or((path_q, ""));
    let path = path.split('#').next().unwrap_or("");
    let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    match parts.as_slice() {
        [] => match as_of(q) {
            Some(who) => Route::Browse(who),
            None => Route::Home(text::param(q, "feed").as_deref() == Some("trending")),
        },
        ["c", h] if fc::is_hash(h) => Route::Cast(h.trim_start_matches("0x").to_lowercase()),
        ["c", h, k @ ("likes" | "recasts" | "quotes")] if fc::is_hash(h) => Route::Who(h.trim_start_matches("0x").to_lowercase(), if *k == "likes" { "likes" } else if *k == "recasts" { "recasts" } else { "quotes" }),
        ["u", id] => Route::User(text::decode(id), false),
        ["u", id, "replies"] => Route::User(text::decode(id), true),
        ["u", id, k @ ("followers" | "following")] => Route::Follows(text::decode(id), if *k == "followers" { "followers" } else { "following" }),
        ["channels"] => Route::Channels,
        ["channel", id] if is_channel_id(&text::decode(id).to_lowercase()) => Route::Channel(text::decode(id).to_lowercase()),
        ["notifications"] => Route::Notifications,
        ["search"] => Route::Search(
            text::param(q, "q").unwrap_or_default(),
            match text::param(q, "tab").as_deref() {
                Some("casts") => Tab::Casts,
                Some("channels") => Tab::Channels,
                _ => Tab::People,
            },
        ),
        ["join"] => Route::Join,
        ["settings"] => Route::Settings,
        _ => Route::NotFound,
    }
}

/// The signed-in account. Its signing key stays in the browser: a non-extractable WebCrypto key the shell keeps in
/// IndexedDB (`raw` false), or, in browsers without Ed25519 in WebCrypto, a raw key sealed in the shell's vault.
/// The recovery phrase is never stored.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Account {
    pub fid: u64,
    pub custody: String,
    pub username: Option<String>,
    pub display: Option<String>,
    pub pfp: Option<String>,
    #[serde(rename = "pub")]
    pub key: String,
    pub raw: bool,
    pub nonce: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Settings {
    pub node: String,
    pub theme: String,
    /// spam casts and spam accounts' casts: "show" (labelled) or "hide", and the score from which they count, in
    /// percent (src/spam.ts, the same names as quilcast.com's settings)
    pub spam: String,
    #[serde(rename = "spamAccounts")]
    pub spam_accounts: String,
    #[serde(rename = "spamAt")]
    pub spam_at: u32,
}
impl Default for Settings {
    fn default() -> Self {
        Settings { node: DEFAULT_NODE.into(), theme: "system".into(), spam: "show".into(), spam_accounts: "show".into(), spam_at: 70 }
    }
}

pub enum Load<T> {
    Loading,
    Ready(T),
    Failed(String),
}

pub struct Feed<T> {
    pub items: Vec<T>,
    pub cursor: Option<String>,
    pub loading: bool,
    pub done: bool,
    pub error: Option<String>,
    /// bumped by a refresh, so an answer for the list before it is dropped
    pub gen: u32,
}
impl<T> Default for Feed<T> {
    fn default() -> Self {
        Feed { items: Vec::new(), cursor: None, loading: false, done: false, error: None, gen: 0 }
    }
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Unfurl {
    pub url: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
}

#[derive(Default)]
pub struct Compose {
    /// which composer this is: answers for an earlier one are dropped (compose.rs live)
    pub gen: u32,
    /// the posts of the cast or thread, each with its pictures, videos and GIFs (compose.rs): never empty once open
    pub posts: Vec<crate::compose::Post>,
    /// the post being written in, which attachments, emoji and @mention suggestions go to
    pub at: usize,
    /// the @name being typed (in post `at`), and the people it could be
    pub typing: Option<crate::compose::Typing>,
    pub suggest: Vec<User>,
    /// bumped to put the caret back in the text after a suggestion is picked
    pub focus: u32,
    /// the drafts list, the scheduled list or the GIF search, over the text
    pub panel: Option<crate::compose::Panel>,
    /// the draft (by id) or scheduled cast it was opened from
    pub draft: Option<String>,
    pub sched: Option<crate::compose::Sched>,
    /// what it held when opened, to tell whether closing loses anything
    pub base: String,
    /// closing asked whether to keep it as a draft
    pub asking: bool,
    /// a datetime-local value: when it goes out, empty for now
    pub when: String,
    pub timing: bool,
    /// a reopened draft's quoted cast, by 0x hash, until the node answers
    pub quote_wait: Option<String>,
    /// a reopened reply whose cast can't be found (and whose author isn't known): it can only be kept as a draft
    pub parent_lost: bool,
    /// the last post of a thread that went out, when the rest failed
    pub posted: Option<fc::CastRef>,
    pub parent: Option<Cast>,
    pub quote: Option<Cast>,
    /// the channel a new cast goes into, by id
    pub channel: Option<String>,
    /// the channel list is open, searching for this
    pub picking: Option<String>,
    /// the chosen channel is members-only and the account isn't a member
    pub closed: bool,
    pub sending: bool,
    pub error: Option<String>,
}

/// A menu or form over the page.
pub enum Sheet {
    /// a cast's ⋯ menu
    Cast(Cast),
    /// a profile's ⋯ menu
    User(User),
    /// how long to mute (or block, `true`) someone
    Mute(bool, User),
    Report(Report),
}
pub struct Report {
    pub fid: u64,
    pub hash: Option<String>,
    pub who: String,
    pub reason: &'static str,
    pub text: String,
    pub sending: bool,
    pub error: Option<String>,
}
pub const REASONS: [(&str, &str); 6] = [("spam", "Spam"), ("abuse", "Harassment or hate"), ("sexual", "Sexual content"), ("violence", "Violence or threats"), ("illegal", "Illegal"), ("other", "Other")];

/// Someone followed on this device (anonymous mode, src/local.ts).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Local {
    pub fid: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}
/// The most accounts followed on this device; imports stop there.
pub const LOCAL_MAX: usize = 300;
/// How many of the device feed's accounts (or imported names) are read at once.
const LOCAL_AT_ONCE: usize = 8;

/// An account browsed as lately (src/browse.ts Recent), newest first.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Recent {
    pub fid: u64,
    pub username: Option<String>,
    pub display_name: Option<String>,
    pub pfp_url: Option<String>,
}
impl Recent {
    pub fn user(&self) -> User {
        User { fid: self.fid, username: self.username.clone(), display_name: self.display_name.clone(), pfp_url: self.pfp_url.clone(), ..Default::default() }
    }
}
pub const RECENTS: usize = 5;

/// One followed account's casts in anonymous mode's merged Following feed: read a page at a time and handed on
/// newest first once no other account can still have something newer.
#[derive(Default)]
pub struct Lane {
    pub buf: Vec<Cast>,
    pub cursor: Option<String>,
    pub done: bool,
    /// the oldest cast read so far, kept or not (replies to strangers are left out of `buf`): anything still unread
    /// is older than this
    pub oldest: Option<f64>,
}

#[derive(Default, Clone, Copy, PartialEq, Debug)]
pub enum JoinStep {
    #[default]
    Idle,
    Finding,
    AddingKey,
    Waiting,
}
#[derive(Default)]
pub struct Join {
    pub phrase: String,
    pub step: JoinStep,
    pub error: Option<String>,
}

/// Things a view found missing while drawing; fetched right after.
pub enum Want {
    Unfurl(String),
    Quote(String),
    /// someone's name and face, by FID
    User(u64),
    /// someone's pinned cast
    Pin(u64),
    /// the account's drafts, once this browser is known to hold their key
    Drafts,
    /// a cast's spam score, by bare hash, and an account's, by FID
    Spam(String),
    SpamAccount(u64),
}

type Done = Box<dyn FnOnce(&mut App, i32, Vec<u8>)>;

pub struct App {
    pub dom: Dom,
    pub path: String,
    pub route: Route,
    pub settings: Settings,
    pub account: Option<Account>,
    /// every account signed in to in this browser (src/me.rs), in the order they were added
    pub accounts: Vec<Account>,
    /// the raw keys taken out of the vault (browsers without Ed25519 in WebCrypto), found by their public key
    pub(crate) raw_seeds: Vec<[u8; 32]>,
    /// Settings → Profile while it's being edited
    pub edit: Option<crate::me::Edit>,
    /// the generation the next feed or list starts at: never reused, so an answer for a dropped feed (another
    /// account's, say) can't land in a new one
    feed_gen: u32,
    pub feeds: HashMap<String, Feed<Cast>>,
    pub notes: Feed<Notification>,
    pub threads: HashMap<String, Load<Cast>>,
    pub profiles: HashMap<String, Load<User>>,
    pub people: HashMap<String, Load<Vec<User>>>,
    pub quotes: HashMap<String, Load<Cast>>,
    pub unfurls: HashMap<String, Load<Option<Unfurl>>>,
    pub follows: HashMap<u64, bool>,
    pub mine_likes: HashSet<String>,
    pub mine_recasts: HashSet<String>,
    /// likes and recasts tapped this visit, by kind + hash, with the count the cast showed then (src/api.ts taps)
    pub taps: HashMap<String, (bool, u64)>,
    pub compose: Option<Compose>,
    pub sheet: Option<Sheet>,
    /// pages of people: who liked or recast a cast, someone's followers and following
    pub lists: HashMap<String, Feed<User>>,
    pub channel_lists: HashMap<String, Load<Vec<Channel>>>,
    pub channels: HashMap<String, Load<Option<Channel>>>,
    /// old-style parent URLs (chain://…) and their channel ids
    pub legacy: HashMap<String, String>,
    pub channel_text: String,
    pub channel_term: String,
    channel_gen: u32,
    pub mutes: Mutes,
    mutes_touched: bool,
    pub removed: crate::mutes::Removed,
    pub word_text: String,
    /// how long a word is muted for: an index into mutes::SPANS
    pub word_span: usize,
    /// people followed on this device (anonymous mode)
    pub local: Vec<Local>,
    lanes: HashMap<u64, Lane>,
    /// bumped whenever the device feed starts over, so answers for an earlier list are dropped (a feed's own gen
    /// restarts when the feed is dropped)
    local_gen: u32,
    local_round: u32,
    local_empty_rounds: u32,
    pub import_text: String,
    pub recents: Vec<Recent>,
    pub join: Join,
    /// the account's FID and drafts key, made from the phrase while signing in, until the key is kept
    join_secret: Option<(u64, [u8; 32])>,
    pub attach_seq: u32,
    pub compose_seq: u32,
    pub gifs: HashMap<String, Load<Vec<crate::compose::Gif>>>,
    pub gif_gen: u32,
    pub mention_gen: u32,
    /// whether this browser holds the account's drafts key (None: not asked yet)
    pub drafts_key: Option<bool>,
    pub drafts: Option<Load<Vec<crate::compose::Draft>>>,
    pub scheduled: Option<Load<Vec<crate::compose::Scheduled>>>,
    /// the account's sticker packs, for the composer's picker
    pub stickers: Option<Load<Vec<crate::compose::Pack>>>,
    pub spam: crate::spam::Spam,
    /// each profile's pinned cast, by bare hash
    pub pins: HashMap<u64, Load<Option<String>>>,
    pub search_text: String,
    pub node_text: String,
    /// what the browser can do for push notifications (src/alerts.rs), as the shell last said
    pub push: crate::alerts::Push,
    /// bumped by each spam setting change, so only the last one tells the server
    pub(crate) alerts_gen: u32,
    pub toast: Option<String>,
    toast_gen: u32,
    pub wants: RefCell<Vec<Want>>,
    pub busy: HashSet<String>,
    pending: HashMap<u32, Done>,
    pub(crate) next_id: u32,
    last_toggle: u64,
    scroll_saved: HashMap<String, f64>,
    scroll_after: Option<f64>,
    /// pages visited inside the app, so Back leaves it only when it was opened on this page
    depth: u32,
}

impl App {
    pub fn new() -> App {
        let settings: Settings = host::get(SETTINGS_KEY).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let account: Option<Account> = host::get(ACCOUNT_KEY).and_then(|s| serde_json::from_str(&s).ok()).filter(|a: &Account| a.fid > 0 && !a.key.is_empty());
        let mut accounts: Vec<Account> = host::get(ACCOUNTS_KEY).and_then(|s| serde_json::from_str::<Vec<Account>>(&s).ok()).unwrap_or_default();
        accounts.retain(|a| a.fid > 0 && !a.key.is_empty());
        // a session from before several accounts (or the list's copy of the one in use, which may be older)
        if let Some(a) = &account {
            match accounts.iter_mut().find(|x| x.fid == a.fid) {
                Some(x) => *x = a.clone(),
                None => accounts.push(a.clone()),
            }
        }
        let mut path = host::here();
        let mut account = account;
        // a window a tapped push notification opened starts as the account it was for, when it's signed in here
        if let Some((p, fid)) = crate::alerts::notified_as(&path) {
            path = p;
            host::go(&path, true);
            if let Some(a) = fid.and_then(|f| accounts.iter().find(|a| a.fid == f)) {
                account = Some(a.clone());
            }
        }
        let local = read_local();
        let recents = host::get(RECENTS_KEY).and_then(|s| serde_json::from_str::<Vec<Recent>>(&s).ok()).unwrap_or_default().into_iter().filter(|r| r.fid > 0).take(RECENTS).collect();
        App {
            dom: Dom::default(),
            route: parse_route(&path),
            path,
            node_text: settings.node.clone(),
            settings,
            account,
            accounts,
            raw_seeds: Vec::new(),
            edit: None,
            feed_gen: 0,
            feeds: HashMap::new(),
            notes: Feed::default(),
            threads: HashMap::new(),
            profiles: HashMap::new(),
            people: HashMap::new(),
            quotes: HashMap::new(),
            unfurls: HashMap::new(),
            follows: HashMap::new(),
            mine_likes: HashSet::new(),
            mine_recasts: HashSet::new(),
            taps: HashMap::new(),
            compose: None,
            sheet: None,
            lists: HashMap::new(),
            channel_lists: HashMap::new(),
            channels: HashMap::new(),
            legacy: HashMap::new(),
            channel_text: String::new(),
            channel_term: String::new(),
            channel_gen: 0,
            mutes: Mutes::default(),
            mutes_touched: false,
            removed: crate::mutes::removed(),
            word_text: String::new(),
            word_span: 3,
            local,
            lanes: HashMap::new(),
            local_gen: 0,
            local_round: 0,
            local_empty_rounds: 0,
            import_text: String::new(),
            recents,
            join: Join::default(),
            join_secret: None,
            attach_seq: 0,
            compose_seq: 0,
            gifs: HashMap::new(),
            gif_gen: 0,
            mention_gen: 0,
            drafts_key: None,
            drafts: None,
            scheduled: None,
            stickers: None,
            spam: Default::default(),
            pins: HashMap::new(),
            search_text: String::new(),
            push: Default::default(),
            alerts_gen: 0,
            toast: None,
            toast_gen: 0,
            wants: RefCell::new(Vec::new()),
            busy: HashSet::new(),
            pending: HashMap::new(),
            next_id: 0,
            last_toggle: 0,
            scroll_saved: HashMap::new(),
            scroll_after: None,
            depth: 0,
        }
    }

    pub fn start(&mut self) {
        self.read_mutes();
        self.get::<HashMap<String, String>>("/api/channels/legacy".into(), |app, r| {
            if let Ok(m) = r {
                app.legacy = m;
            }
        });
        if let Some(a) = self.account.clone() {
            // a raw key comes out of the vault first (without it the account can read but not write), and reading
            // the account's mutes is signed, so it waits for the key
            self.use_account(a);
        }
        if let Route::Search(q, _) = &self.route {
            self.search_text = q.clone();
        }
        self.load_route();
        self.refresh_alerts();
        self.take_scheduled();
    }

    /// A failed scheduled cast's push (server/scheduled.mjs) opens `/?scheduled`: the composer with its Scheduled list.
    fn take_scheduled(&mut self) {
        let Some((path, q)) = self.path.split_once('?') else { return };
        if text::param(q, "scheduled").is_none() {
            return;
        }
        let rest: Vec<&str> = q.split('&').filter(|kv| !kv.is_empty() && text::decode(kv.split('=').next().unwrap_or("")) != "scheduled").collect();
        let clean = if rest.is_empty() { path.to_string() } else { format!("{path}?{}", rest.join("&")) };
        host::go(&clean, true);
        self.path = clean;
        if self.account.is_some() && self.compose.is_none() {
            self.open_compose(None, None);
            self.open_scheduled();
        }
    }

    /// A tapped push notification (public/sw.js) opens its page in this window, as the account it was for when
    /// that one is signed in here.
    pub fn open_notified(&mut self, path: &str, fid: u64) {
        if !path.starts_with('/') || path.starts_with("//") {
            return;
        }
        if fid > 0 && self.me() != Some(fid) {
            if let Some(a) = self.accounts.iter().find(|a| a.fid == fid).cloned() {
                // a cast or a profile still going out stays with its account, and the page waits too, so it isn't
                // opened as the wrong one (account_busy says why)
                if self.account_busy() {
                    return;
                }
                let name = a.username.clone().map_or_else(|| format!("!{}", a.fid), |u| format!("@{u}"));
                self.use_account(a);
                self.say(format!("Using {name}"));
            }
        }
        self.navigate(path, false);
        self.take_scheduled();
    }

    pub fn me(&self) -> Option<u64> {
        self.account.as_ref().map(|a| a.fid)
    }

    /// Whether a cast stays out of sight (src/mutes.ts hides): taken down for everyone, written by someone muted or
    /// blocked, or saying a muted word. The account's own casts never do, and on `owner`'s profile their casts show
    /// even when muted (not when blocked).
    pub fn hidden(&self, c: &Cast, owner: Option<u64>) -> bool {
        let fid = c.author.fid;
        let now = host::ms() as u64;
        if self.removed.fids.contains(&fid) || self.removed.casts.iter().any(|h| h.trim_start_matches("0x").eq_ignore_ascii_case(&c.bare_hash())) {
            return true;
        }
        if Some(fid) == self.me() {
            return false;
        }
        if self.mutes.blocked(fid, now) {
            return true;
        }
        if Some(fid) == owner {
            return false;
        }
        self.mutes.muted(fid, now) || self.mutes.word_in(&crate::view::shown_text(c), now).is_some() || self.hides_spam(c)
    }

    // --- drawing ---

    pub fn render(&mut self) {
        let mut dom = std::mem::take(&mut self.dom);
        let ops = dom.render(crate::view::page(self));
        self.dom = dom;
        host::apply(&ops);
        if let Some(y) = self.scroll_after.take() {
            host::scroll_to(y);
        }
        let wants: Vec<Want> = self.wants.borrow_mut().drain(..).collect();
        let mut fids = Vec::new();
        let (mut spam, mut spam_fids) = (Vec::new(), Vec::new());
        for w in wants {
            match w {
                Want::Spam(h) => spam.push(h),
                Want::SpamAccount(f) => spam_fids.push(f),
                Want::Unfurl(u) => self.load_unfurl(u),
                Want::Quote(h) => self.load_quote(h),
                Want::User(fid) => fids.push(fid),
                Want::Pin(fid) => self.load_pin(fid),
                Want::Drafts => {
                    if self.drafts.is_none() {
                        self.load_drafts();
                    }
                }
            }
        }
        self.load_users(fids);
        self.ask_spam(spam, spam_fids);
        host::set_title(&crate::view::title(self));
    }

    // --- async plumbing: every request, key operation and timer answers through `done` ---

    pub(crate) fn wait(&mut self, f: impl FnOnce(&mut App, i32, Vec<u8>) + 'static) -> u32 {
        self.next_id += 1;
        self.pending.insert(self.next_id, Box::new(f));
        self.next_id
    }
    pub fn done(&mut self, id: u32, code: i32, bytes: Vec<u8>) {
        if let Some(f) = self.pending.remove(&id) {
            f(self, code, bytes);
        }
    }
    pub fn later(&mut self, ms: f64, f: impl FnOnce(&mut App) + 'static) {
        let id = self.wait(move |app, _, _| f(app));
        host::after(id, ms);
    }
    pub fn http(&mut self, method: &str, url: &str, body: &[u8], ctype: &str, f: impl FnOnce(&mut App, i32, Vec<u8>) + 'static) {
        let id = self.wait(f);
        host::http(id, method, url, body, ctype);
    }
    pub fn get<T: DeserializeOwned + 'static>(&mut self, url: String, f: impl FnOnce(&mut App, Result<T, (i32, String)>) + 'static) {
        self.http("GET", &url, &[], "", move |app, status, body| {
            let r = if (200..300).contains(&status) {
                serde_json::from_slice(&body).map_err(|_| (status, "The node sent something unexpected.".to_string()))
            } else {
                Err((status, error_text(status, &body)))
            };
            f(app, r)
        });
    }
    /// A node address; /v2 reads say whether the viewer liked, recast or follows (Hypersnap PR #43).
    pub fn node(&self, path: &str, q: &[(&str, String)]) -> String {
        let mut q: Vec<(&str, String)> = q.iter().filter(|(_, v)| !v.is_empty()).cloned().collect();
        if let (Some(fid), true) = (self.me(), path.starts_with("/v2/farcaster/")) {
            q.insert(0, ("viewer_fid", fid.to_string()));
        }
        let qs: Vec<String> = q.iter().map(|(k, v)| format!("{k}={}", text::encode(v))).collect();
        format!("{}{path}?{}", self.settings.node.trim_end_matches('/'), qs.join("&"))
    }

    pub fn say(&mut self, s: impl Into<String>) {
        self.toast = Some(s.into());
        self.toast_gen += 1;
        let g = self.toast_gen;
        self.later(4000.0, move |app| {
            if app.toast_gen == g {
                app.toast = None;
            }
        });
    }

    // --- navigation ---

    pub fn navigate(&mut self, path: &str, pop: bool) {
        self.scroll_saved.insert(self.path.clone(), host::scroll_y());
        let same = path == self.path;
        if pop {
            self.depth = self.depth.saturating_sub(1);
        } else if !same {
            // the page you're on isn't pushed again: Back would only lead to it once more
            host::go(path, false);
            self.depth += 1;
        }
        self.path = path.to_string();
        self.route = parse_route(path);
        self.sheet = None;
        if let Route::Search(q, _) = &self.route {
            self.search_text = q.clone();
        }
        self.scroll_after = Some(if pop { self.scroll_saved.get(path).copied().unwrap_or(0.0) } else { 0.0 });
        // tapping the page you're on reads it again
        if same && !pop {
            self.refresh();
        } else {
            self.load_route();
        }
    }

    pub fn back(&mut self) {
        if self.depth > 0 {
            host::history_back();
        } else {
            self.navigate("/", false);
        }
    }

    /// Home's feed: the account's Following, the people followed on this device (anonymous mode), or Trending.
    pub fn home_key(&self, trending: bool) -> String {
        match (trending, self.me()) {
            (false, Some(fid)) => format!("following:{fid}"),
            (false, None) if !self.local.is_empty() => "local".into(),
            _ => "trending".into(),
        }
    }

    /// A profile that has been read, by name or FID.
    pub fn user_by(&self, id: &str) -> Option<&User> {
        match self.profiles.get(&id.to_lowercase()) {
            Some(Load::Ready(u)) => Some(u),
            _ => None,
        }
    }

    /// The feed or list the current page shows, once what it needs is known.
    fn page_key(&self) -> Option<String> {
        Some(match &self.route {
            Route::Home(t) => self.home_key(*t),
            Route::Browse(id) => format!("following:{}", self.user_by(id)?.fid),
            Route::User(id, r) => format!("{}:{}", if *r { "replies" } else { "casts" }, self.user_by(id)?.fid),
            Route::Follows(id, k) => format!("{k}:{}", self.user_by(id)?.fid),
            Route::Who(h, "quotes") => format!("quotes:{h}"),
            Route::Who(h, k) => format!("{k}:{h}"),
            Route::Channel(id) => match self.channels.get(id) {
                Some(Load::Ready(_)) => format!("channel:{}", self.channel_url(id)),
                _ => return None,
            },
            Route::Search(q, Tab::Casts) if !q.trim().is_empty() => format!("search:{}", q.trim()),
            _ => return None,
        })
    }

    pub fn load_route(&mut self) {
        match self.route.clone() {
            Route::Cast(h) => {
                if !matches!(self.threads.get(&h), Some(Load::Ready(_)) | Some(Load::Loading)) {
                    self.load_thread(h);
                }
                return;
            }
            Route::Browse(id) | Route::User(id, _) | Route::Follows(id, _) => {
                if !matches!(self.profiles.get(&id.to_lowercase()), Some(Load::Ready(_)) | Some(Load::Loading)) {
                    return self.fetch_profile(id);
                }
                if let (Route::Browse(_), Some(u)) = (&self.route, self.user_by(&id)) {
                    let u = u.clone();
                    self.remember(&u);
                }
            }
            Route::Channel(id) => {
                if !self.channels.contains_key(&id) {
                    return self.load_channel(id);
                }
            }
            Route::Channels => {
                let q = self.channel_term.clone();
                self.load_channels(q);
            }
            Route::Notifications => {
                if self.me().is_some() {
                    self.load_notes(false, true);
                }
                return;
            }
            Route::Search(q, Tab::People) if !q.trim().is_empty() => return self.load_people(q.trim().to_string()),
            Route::Settings => {
                self.push_check(|_| {});
                return self.load_edit();
            }
            Route::Search(q, Tab::Channels) if !q.trim().is_empty() => return self.load_channels(q.trim().to_string()),
            _ => {}
        }
        let Some(k) = self.page_key() else { return };
        match &self.route {
            Route::Follows(..) | Route::Who(_, "likes") | Route::Who(_, "recasts") => {
                if !self.lists.contains_key(&k) {
                    self.load_list(k, false);
                }
            }
            _ => {
                if !self.feeds.contains_key(&k) {
                    self.load_feed(k, false);
                }
            }
        }
    }

    /// Read the current page again from the start.
    pub fn refresh(&mut self) {
        match self.route.clone() {
            Route::Cast(h) => return self.load_thread(h),
            Route::Browse(id) | Route::User(id, _) | Route::Follows(id, _) => {
                // the profile is read again, then its feed or list (the key needs the profile, so it comes first)
                if let Some(k) = self.page_key() {
                    self.feeds.remove(&k);
                    self.lists.remove(&k);
                }
                self.profiles.remove(&id.to_lowercase());
                return self.fetch_profile(id);
            }
            Route::Notifications => return self.load_notes(false, true),
            Route::Search(q, Tab::People) => {
                self.people.remove(q.trim());
                return self.load_people(q.trim().to_string());
            }
            Route::Search(q, Tab::Channels) => {
                self.channel_lists.remove(q.trim());
                return self.load_channels(q.trim().to_string());
            }
            Route::Channels => {
                self.channel_lists.remove(&self.channel_term.clone());
            }
            _ => {}
        }
        match self.page_key() {
            Some(k) if matches!(self.route, Route::Who(_, "likes") | Route::Who(_, "recasts")) => self.load_list(k, false),
            Some(k) => self.load_feed(k, false),
            None => self.load_route(),
        }
    }

    // --- reads ---

    fn feed_url(&self, key: &str, cursor: &str) -> String {
        let c = cursor.to_string();
        let (kind, arg) = key.split_once(':').unwrap_or((key, ""));
        match kind {
            "following" => self.node("/v2/farcaster/feed/following", &[("fid", arg.into()), ("limit", "50".into()), ("cursor", c), ("with_recasts", "true".into())]),
            "casts" => self.node("/v2/farcaster/feed/user/casts", &[("fid", arg.into()), ("limit", "25".into()), ("cursor", c)]),
            "replies" => self.node("/v2/farcaster/feed/user/replies_and_recasts", &[("fid", arg.into()), ("limit", "25".into()), ("cursor", c)]),
            "search" => self.node("/v2/farcaster/cast/search", &[("q", arg.into()), ("limit", "25".into()), ("cursor", c)]),
            "channel" => self.node("/v2/farcaster/feed/parent_urls", &[("parent_urls", arg.into()), ("limit", "25".into()), ("cursor", c)]),
            "quotes" => self.node("/v2/farcaster/cast/quotes", &[("identifier", arg.into()), ("type", "hash".into()), ("limit", "100".into()), ("cursor", c)]),
            _ => self.node("/v2/farcaster/feed/trending", &[("limit", "50".into()), ("cursor", c)]),
        }
    }

    /// The first page of a feed (`more` false: read again from the top), or its next page.
    pub fn load_feed(&mut self, key: String, more: bool) {
        if key == "local" {
            return self.load_local(more);
        }
        self.feed_gen += 1;
        let gen0 = self.feed_gen;
        let f = self.feeds.entry(key.clone()).or_default();
        if more && (f.loading || f.done || f.cursor.is_none()) {
            return;
        }
        if !more {
            f.gen = gen0;
            f.cursor = None;
            f.done = false;
        }
        f.loading = true;
        f.error = None;
        let gen = f.gen;
        let cursor = if more { f.cursor.clone().unwrap_or_default() } else { String::new() };
        let url = self.feed_url(&key, &cursor);
        let search = key.starts_with("search:");
        self.get::<serde_json::Value>(url, move |app, r| {
            let Some(f) = app.feeds.get_mut(&key) else { return };
            if f.gen != gen {
                return;
            }
            f.loading = false;
            match r.and_then(|v| {
                if search {
                    serde_json::from_value::<SearchCasts>(v).map(|s| if s.result.casts.is_empty() { CastPage { casts: s.casts, next: s.next } } else { s.result }).map_err(|_| (0, "The node sent something unexpected.".into()))
                } else {
                    serde_json::from_value::<CastPage>(v).map_err(|_| (0, "The node sent something unexpected.".into()))
                }
            }) {
                Ok(p) => {
                    let had: HashSet<String> = if more { f.items.iter().map(|c| format!("{}:{}", c.hash, c.recaster.as_ref().map_or(0, |u| u.fid))).collect() } else { HashSet::new() };
                    if !more {
                        f.items.clear();
                    }
                    let n = p.casts.len();
                    f.items.extend(p.casts.into_iter().filter(|c| !had.contains(&format!("{}:{}", c.hash, c.recaster.as_ref().map_or(0, |u| u.fid)))));
                    f.done = n == 0 || p.next.cursor.is_none();
                    f.cursor = p.next.cursor;
                }
                Err((_, e)) => f.error = Some(e),
            }
        });
    }

    pub fn load_thread(&mut self, hash: String) {
        if !self.threads.contains_key(&hash) {
            self.threads.insert(hash.clone(), Load::Loading);
        }
        let url = self.node("/v2/farcaster/cast/conversation", &[("identifier", hash.clone()), ("type", "hash".into()), ("reply_depth", "2".into())]);
        self.get::<Conversation>(url, move |app, r| {
            let v = match r {
                Ok(c) => match c.conversation.cast {
                    Some(c) => Load::Ready(c),
                    None => Load::Failed("This cast isn't on the network.".into()),
                },
                Err((404, _)) | Err((400, _)) => Load::Failed("This cast isn't on the network.".into()),
                Err((_, e)) => Load::Failed(e),
            };
            app.threads.insert(hash, v);
        });
    }

    /// A page of people (`likes:<hash>`, `recasts:<hash>`, `followers:<fid>`, `following:<fid>`), the first or the next.
    pub fn load_list(&mut self, key: String, more: bool) {
        self.feed_gen += 1;
        let gen0 = self.feed_gen;
        let f = self.lists.entry(key.clone()).or_default();
        if more && (f.loading || f.done || f.cursor.is_none()) {
            return;
        }
        if !more {
            f.gen = gen0;
            f.cursor = None;
            f.done = false;
        }
        f.loading = true;
        f.error = None;
        let gen = f.gen;
        let c = if more { f.cursor.clone().unwrap_or_default() } else { String::new() };
        let (kind, arg) = key.split_once(':').unwrap_or((&key, ""));
        let url = match kind {
            "followers" | "following" => self.node(&format!("/v2/farcaster/{kind}"), &[("fid", arg.into()), ("limit", "100".into()), ("cursor", c)]),
            _ => self.node("/v2/farcaster/reactions/cast", &[("hash", arg.into()), ("types", kind.into()), ("limit", "100".into()), ("cursor", c)]),
        };
        self.get::<serde_json::Value>(url, move |app, r| {
            let Some(f) = app.lists.get_mut(&key) else { return };
            if f.gen != gen {
                return;
            }
            f.loading = false;
            match r {
                Ok(v) => {
                    let (users, next) = users_page(&v);
                    if !more {
                        f.items.clear();
                    }
                    let had: HashSet<u64> = f.items.iter().map(|u| u.fid).collect();
                    f.done = users.is_empty() || next.is_none();
                    f.items.extend(users.into_iter().filter(|u| !had.contains(&u.fid)));
                    f.cursor = next;
                }
                Err((_, e)) => f.error = Some(e),
            }
        });
    }

    /// Read a profile by name or FID; the page that needs it loads the rest once it's here.
    pub fn fetch_profile(&mut self, id: String) {
        let k = id.to_lowercase();
        if matches!(self.profiles.get(&k), Some(Load::Loading)) {
            return;
        }
        self.profiles.insert(k.clone(), Load::Loading);
        let numeric = !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit());
        let url = if numeric { self.node("/v2/farcaster/user", &[("fid", id.clone())]) } else { self.node("/v2/farcaster/user/by-username", &[("username", k.clone())]) };
        self.get::<UserResp>(url, move |app, r| {
            match r {
                Ok(UserResp { user: Some(u) }) => app.got_user(k, u),
                Ok(_) | Err((404, _)) => {
                    app.profiles.insert(k, Load::Failed("There's no one by that name.".into()));
                }
                Err((_, e)) => {
                    app.profiles.insert(k, Load::Failed(e));
                }
            }
        });
    }

    fn load_follow(&mut self, target: u64) {
        let Some(me) = self.me() else { return };
        let url = self.node("/v1/linkById", &[("fid", me.to_string()), ("target_fid", target.to_string()), ("link_type", "follow".into())]);
        self.http("GET", &url, &[], "", move |app, status, _| {
            if status != 0 && !(500..600).contains(&status) && app.me() == Some(me) {
                app.follows.insert(target, (200..300).contains(&status));
            }
        });
    }

    pub fn load_people(&mut self, q: String) {
        if matches!(self.people.get(&q), Some(Load::Ready(_)) | Some(Load::Loading)) {
            return;
        }
        self.people.insert(q.clone(), Load::Loading);
        let term = q.trim_start_matches('@').to_lowercase();
        let url = self.node("/v2/farcaster/user/search", &[("q", term.clone()), ("limit", "50".into())]);
        self.get::<UsersResp>(url, move |app, r| {
            let v = match r {
                Ok(r) => {
                    let mut users = if r.users.is_empty() { r.result.map(|x| x.users).unwrap_or_default() } else { r.users };
                    // that exact handle first, then handles starting with it, then the most followed (src/api.ts findUsers)
                    let rank = |u: &User| {
                        let n = u.username.clone().unwrap_or_default();
                        (if n == term || n == format!("{term}.eth") { 1e12 } else if n.starts_with(&term) { 1e10 } else { 0.0 }) + u.follower_count as f64
                    };
                    users.sort_by(|a, b| rank(b).partial_cmp(&rank(a)).unwrap_or(std::cmp::Ordering::Equal));
                    Load::Ready(users)
                }
                Err((_, e)) => Load::Failed(e),
            };
            app.people.insert(q, v);
        });
    }

    pub fn load_notes(&mut self, more: bool, fresh: bool) {
        let Some(me) = self.me() else { return };
        self.feed_gen += 1;
        let gen0 = self.feed_gen;
        let f = &mut self.notes;
        if more && (f.loading || f.done || f.cursor.is_none()) {
            return;
        }
        if !more {
            if f.loading && !fresh {
                return;
            }
            f.gen = gen0;
        }
        f.loading = true;
        f.error = None;
        let gen = f.gen;
        let cursor = if more { f.cursor.clone().unwrap_or_default() } else { String::new() };
        let url = self.node("/v2/farcaster/notifications", &[("fid", me.to_string()), ("limit", "50".into()), ("cursor", cursor), ("include_quotes_and_deep_replies", "true".into())]);
        self.get::<NotePage>(url, move |app, r| {
            if app.me() != Some(me) {
                return;
            }
            let f = &mut app.notes;
            if f.gen != gen {
                return;
            }
            f.loading = false;
            match r {
                Ok(p) => {
                    if !more {
                        f.items.clear();
                    }
                    f.done = p.notifications.is_empty() || p.next.cursor.is_none();
                    f.items.extend(p.notifications);
                    f.cursor = p.next.cursor;
                }
                Err((_, e)) => f.error = Some(e),
            }
        });
    }

    fn load_quote(&mut self, hash: String) {
        if self.quotes.contains_key(&hash) {
            return;
        }
        self.quotes.insert(hash.clone(), Load::Loading);
        let url = self.node("/v2/farcaster/cast", &[("identifier", hash.clone()), ("type", "hash".into())]);
        self.get::<CastResp>(url, move |app, r| {
            let v = match r {
                Ok(CastResp { cast: Some(c) }) => Load::Ready(c),
                Ok(_) => Load::Failed("This cast isn't on the network.".into()),
                Err((_, e)) => Load::Failed(e),
            };
            app.quotes.insert(hash, v);
        });
    }

    fn load_unfurl(&mut self, url: String) {
        if self.unfurls.contains_key(&url) {
            return;
        }
        self.unfurls.insert(url.clone(), Load::Loading);
        let api = format!("/api/unfurl?v=2&url={}", text::encode(&url));
        self.get::<Option<Unfurl>>(api, move |app, r| {
            app.unfurls.insert(url, match r {
                Ok(u) => Load::Ready(u),
                Err((_, e)) => Load::Failed(e),
            });
        });
    }

    /// What the account recently liked and recast, so the buttons show filled on nodes without viewer_context.
    fn load_mine(&mut self) {
        let Some(fid) = self.me() else { return };
        for kind in ["Like", "Recast"] {
            let url = self.node("/v1/reactionsByFid", &[("fid", fid.to_string()), ("reaction_type", kind.into()), ("pageSize", "200".into()), ("reverse", "true".into())]);
            self.get::<V1Messages>(url, move |app, r| {
                let Ok(m) = r else { return };
                if app.me() != Some(fid) {
                    return;
                }
                let set = if kind == "Like" { &mut app.mine_likes } else { &mut app.mine_recasts };
                for msg in m.messages {
                    if let Some(t) = msg.data.reaction_body.and_then(|b| b.target_cast_id) {
                        set.insert(t.hash.trim_start_matches("0x").to_lowercase());
                    }
                }
            });
        }
    }

    /// People's names and faces by FID (for lists that only keep FIDs), kept with the profiles under the FID, read
    /// 100 at a time.
    fn load_users(&mut self, fids: Vec<u64>) {
        let mut todo: Vec<u64> = fids.into_iter().filter(|f| !self.profiles.contains_key(&f.to_string())).collect();
        todo.sort_unstable();
        todo.dedup();
        for chunk in todo.chunks(100) {
            let chunk = chunk.to_vec();
            for f in &chunk {
                self.profiles.insert(f.to_string(), Load::Loading);
            }
            let list: Vec<String> = chunk.iter().map(|f| f.to_string()).collect();
            let url = self.node("/v2/farcaster/user/bulk", &[("fids", list.join(","))]);
            self.get::<UsersResp>(url, move |app, r| {
                let users = match r {
                    Ok(r) => r.users,
                    Err(_) => Vec::new(),
                };
                for fid in chunk {
                    match users.iter().find(|u| u.fid == fid) {
                        Some(u) => app.got_user(fid.to_string(), u.clone()),
                        None => {
                            app.profiles.insert(fid.to_string(), Load::Failed("Couldn't read this account.".into()));
                        }
                    }
                }
            });
        }
    }

    /// A profile read under `k` (a name or FID): kept, with whether the account follows them, and the page waiting
    /// for it goes on.
    fn got_user(&mut self, k: String, u: User) {
        if let Some(f) = u.viewer_context.as_ref().and_then(|v| v.following) {
            self.follows.insert(u.fid, f);
        } else if self.me().is_some_and(|m| m != u.fid) && !self.follows.contains_key(&u.fid) {
            self.load_follow(u.fid);
        }
        self.profiles.insert(k.clone(), Load::Ready(u));
        if let Route::User(rid, _) | Route::Browse(rid) | Route::Follows(rid, _) = &self.route {
            if rid.to_lowercase() == k {
                self.load_route();
            }
        }
    }

    // --- channels ---

    /// The channel a cast was posted in, by its parent URL.
    pub fn channel_of(&self, url: Option<&str>) -> Option<String> {
        let u = url?;
        if let Some(id) = self.legacy.get(u) {
            return Some(id.clone());
        }
        let i = u.find("warpcast.com/~/channel/").map(|i| i + 23).or_else(|| u.find("farcaster.xyz/~/channel/").map(|i| i + 24))?;
        let id: String = u[i..].chars().take_while(|c| !matches!(c, '/' | '?' | '#')).collect();
        is_channel_id(&id).then_some(id)
    }

    /// The URL casts go under for channel `id`: the directory's, else farcaster.xyz's usual one.
    pub fn channel_url(&self, id: &str) -> String {
        match self.channels.get(id) {
            Some(Load::Ready(Some(c))) if !c.url.is_empty() => c.url.clone(),
            // an old-style channel's URL is also in the legacy map
            _ => self.legacy.iter().filter(|(_, v)| v.as_str() == id).map(|(u, _)| u).min().cloned().unwrap_or_else(|| default_channel_url(id)),
        }
    }

    pub fn load_channel(&mut self, id: String) {
        if self.channels.contains_key(&id) {
            return;
        }
        self.channels.insert(id.clone(), Load::Loading);
        let url = format!("/api/channel/{}", text::encode(&id));
        self.http("GET", &url, &[], "", move |app, status, body| {
            let v = match status {
                200..=299 => Load::Ready(serde_json::from_slice::<Channel>(&body).ok().filter(|c| !c.id.is_empty())),
                // not in the directory: casts under the usual URL still show
                404 => Load::Ready(None),
                // couldn't tell, so nothing is cast under a guessed URL
                _ => Load::Failed(error_text(status, &body)),
            };
            app.channels.insert(id.clone(), v);
            if app.route == Route::Channel(id) {
                app.load_route();
            }
        });
    }

    /// The top channels by followers, or the ones matching `q`.
    pub fn load_channels(&mut self, q: String) {
        if matches!(self.channel_lists.get(&q), Some(Load::Ready(_)) | Some(Load::Loading)) {
            return;
        }
        self.channel_lists.insert(q.clone(), Load::Loading);
        let url = if q.is_empty() { "/api/channels?n=50".to_string() } else { format!("/api/channels?q={}&n=50", text::encode(&q)) };
        self.get::<Vec<Channel>>(url, move |app, r| {
            let v = match r {
                Ok(list) => {
                    for c in &list {
                        app.channels.insert(c.id.clone(), Load::Ready(Some(c.clone())));
                    }
                    Load::Ready(list)
                }
                Err((_, e)) => Load::Failed(e),
            };
            app.channel_lists.insert(q, v);
        });
    }

    /// Typing in a channel search box: it looks once the typing stops for a moment.
    pub fn type_channel(&mut self, v: &str, picker: bool) {
        if picker {
            if let Some(c) = self.compose.as_mut() {
                c.picking = Some(v.to_string());
            }
        } else {
            self.channel_text = v.to_string();
        }
        self.channel_gen += 1;
        let g = self.channel_gen;
        let q = v.trim().to_lowercase();
        self.later(300.0, move |app| {
            if app.channel_gen == g {
                if !picker {
                    app.channel_term = q.clone();
                }
                app.load_channels(q);
            }
        });
    }

    // --- browsing as someone else ---

    /// The page that browses as `u` (src/browse.ts browsePath): by name, or by FID for a nameless or all-digit one.
    pub fn browse_path(u: &User) -> String {
        match &u.username {
            Some(n) if !n.is_empty() && !n.starts_with("fid:") && !n.bytes().all(|b| b.is_ascii_digit()) => format!("/?as={}", text::encode(&n.to_lowercase())),
            _ => format!("/?as={}", u.fid),
        }
    }

    fn remember(&mut self, u: &User) {
        if self.recents.first().is_some_and(|r| r.fid == u.fid) {
            return;
        }
        self.recents.retain(|r| r.fid != u.fid);
        self.recents.insert(0, Recent { fid: u.fid, username: u.username.clone(), display_name: u.display_name.clone(), pfp_url: u.pfp_url.clone() });
        self.recents.truncate(RECENTS);
        host::set(RECENTS_KEY, &serde_json::to_string(&self.recents).unwrap_or_default());
    }

    // --- anonymous mode: following people on this device ---

    pub fn is_local(&self, fid: u64) -> bool {
        self.local.iter().any(|l| l.fid == fid)
    }

    fn save_local(&mut self) {
        if self.local.is_empty() {
            host::del(LOCAL_KEY);
        } else {
            host::set(LOCAL_KEY, &serde_json::to_string(&self.local).unwrap_or_default());
        }
        // the merged feed is read again with the new list
        self.feeds.remove("local");
        self.lanes.clear();
        self.local_gen += 1;
        // Home shows that feed (or Trending once the list is empty), so it is read again now
        if matches!(self.route, Route::Home(_)) {
            self.load_route();
        }
    }

    /// Follow (`on`) or unfollow someone on this device; nothing is published.
    pub fn set_local(&mut self, u: &User, on: bool) {
        if on == self.is_local(u.fid) {
            return;
        }
        if on && self.local.len() >= LOCAL_MAX {
            return self.say(format!("You can follow up to {LOCAL_MAX} accounts on this device."));
        }
        if on {
            self.local.push(Local { fid: u.fid, username: u.username.clone().filter(|n| local_name(n)) });
            self.say(format!("Following @{} on this device only. Nothing is published.", u.handle()));
        } else {
            self.local.retain(|l| l.fid != u.fid);
            self.say(format!("Unfollowed @{}", u.handle()));
        }
        self.save_local();
    }

    /// Adds what was pasted under Settings → Following on this device: an export, a JSON list, or FIDs and @names.
    pub fn import_local(&mut self) {
        let (mut found, names) = parse_import(&self.import_text);
        if found.is_empty() && names.is_empty() {
            return self.say("There are no FIDs or @names in that.");
        }
        self.import_text.clear();
        if names.is_empty() {
            return self.add_local(found);
        }
        // more names than the list could take aren't looked up
        let mut names: Vec<String> = names.into_iter().take(LOCAL_MAX).collect();
        names.reverse();
        let left = Rc::new(RefCell::new(names.len()));
        let got: Rc<RefCell<Vec<Local>>> = Rc::new(RefCell::new(Vec::new()));
        let first = Rc::new(RefCell::new(std::mem::take(&mut found)));
        let queue = Rc::new(RefCell::new(names));
        for _ in 0..LOCAL_AT_ONCE {
            self.next_name(queue.clone(), left.clone(), got.clone(), first.clone());
        }
    }
    fn next_name(&mut self, queue: Rc<RefCell<Vec<String>>>, left: Rc<RefCell<usize>>, got: Rc<RefCell<Vec<Local>>>, first: Rc<RefCell<Vec<Local>>>) {
        let Some(n) = queue.borrow_mut().pop() else { return };
        self.fid_by_name(n.clone(), move |app, fid| {
            if let Some(Some(fid)) = fid {
                got.borrow_mut().push(Local { fid, username: Some(n) });
            }
            *left.borrow_mut() -= 1;
            if *left.borrow() == 0 {
                let mut all: Vec<Local> = first.borrow().clone();
                all.extend(got.borrow().iter().cloned());
                app.add_local(all);
            } else {
                app.next_name(queue, left, got, first);
            }
        });
    }

    fn add_local(&mut self, us: Vec<Local>) {
        let mut n = 0;
        let mut cut = 0;
        for u in us {
            if self.is_local(u.fid) {
                continue;
            }
            if self.local.len() >= LOCAL_MAX {
                cut += 1;
                continue;
            }
            self.local.push(u);
            n += 1;
        }
        self.save_local();
        self.say(if cut > 0 { format!("Added {n}; {cut} didn't fit (the list holds {LOCAL_MAX}).") } else { format!("Added {n}.") });
    }

    /// The device's list as a file another device (or quilcast.com) can import.
    pub fn export_local(&self) -> String {
        serde_json::to_string_pretty(&serde_json::json!({"type": "quilcast-local-follows", "version": 1, "follows": self.local})).unwrap_or_default()
    }

    /// Signed in: follow everyone on the device's list with the account, one at a time.
    pub fn follow_local_all(&mut self) {
        if self.account.is_none() || self.busy.contains("follow-all") {
            return;
        }
        let todo: Vec<u64> = self.local.iter().map(|l| l.fid).filter(|f| Some(*f) != self.me() && self.follows.get(f) != Some(&true)).collect();
        if todo.is_empty() {
            return self.say("You already follow all of them.");
        }
        self.busy.insert("follow-all".into());
        self.follow_next(todo, 0);
    }
    fn follow_next(&mut self, mut todo: Vec<u64>, n: usize) {
        let Some(fid) = todo.pop() else {
            self.busy.remove("follow-all");
            if let Some(me) = self.me() {
                self.feeds.remove(&format!("following:{me}"));
            }
            return self.say(format!("Followed {n} on Farcaster."));
        };
        self.follows.insert(fid, true);
        self.send(fc::mt::LINK_ADD, fc::follow_body(fid), move |app, r| match r {
            Ok(_) => app.follow_next(todo, n + 1),
            Err(e) => {
                app.follows.remove(&fid);
                app.busy.remove("follow-all");
                app.say(format!("Followed {n}, then: {e}"));
            }
        });
    }

    /// Anonymous mode's Following feed (src/local.ts): each followed account's casts, read a page at a time, merged
    /// newest first. A page ends where some account that still has older casts to read stops, so nothing newer can
    /// turn up later. Recasts aren't in it yet.
    fn load_local(&mut self, more: bool) {
        let f = self.feeds.entry("local".into()).or_default();
        if more && (f.loading || f.done) {
            return;
        }
        if !more {
            f.items.clear();
            f.done = false;
            self.lanes.clear();
            self.local_gen += 1;
        }
        let f = self.feeds.get_mut("local").expect("feed");
        f.loading = true;
        f.error = None;
        f.cursor = Some("local".into());
        let gen = self.local_gen;
        for l in &self.local {
            self.lanes.entry(l.fid).or_default();
        }
        let need: Vec<(u64, String)> = self.lanes.iter().filter(|(_, l)| l.buf.is_empty() && !l.done).map(|(fid, l)| (*fid, l.cursor.clone().unwrap_or_default())).collect();
        if need.is_empty() {
            return self.merge_local();
        }
        let left = Rc::new(RefCell::new(need.len()));
        let queue = Rc::new(RefCell::new(need));
        // a few at a time, so a long list doesn't send hundreds of requests at once
        for _ in 0..LOCAL_AT_ONCE {
            self.next_lane(queue.clone(), left.clone(), gen);
        }
    }
    fn next_lane(&mut self, queue: Rc<RefCell<Vec<(u64, String)>>>, left: Rc<RefCell<usize>>, gen: u32) {
        let Some((fid, cursor)) = queue.borrow_mut().pop() else { return };
        let url = self.node("/v2/farcaster/feed/user/casts", &[("fid", fid.to_string()), ("limit", "25".into()), ("cursor", cursor)]);
        self.get::<CastPage>(url, move |app, r| {
            if app.local_gen != gen {
                return;
            }
            let followed: HashSet<u64> = app.local.iter().map(|l| l.fid).collect();
            if let Some(lane) = app.lanes.get_mut(&fid) {
                match r {
                    Ok(p) => {
                        lane.done = p.casts.is_empty() || p.next.cursor.is_none();
                        if let Some(t) = p.casts.iter().filter_map(|c| text::parse_time(&c.timestamp)).reduce(f64::min) {
                            lane.oldest = Some(lane.oldest.map_or(t, |o| o.min(t)));
                        }
                        // a reply shows only when it answers someone followed here (src/local.ts)
                        lane.buf.extend(p.casts.into_iter().filter(|c| c.parent_hash.is_none() || c.parent_author.fid.is_some_and(|f| followed.contains(&f))));
                        lane.cursor = p.next.cursor;
                    }
                    // an account that can't be read is left out rather than holding up everyone else
                    Err(_) => lane.done = true,
                }
            }
            *left.borrow_mut() -= 1;
            if *left.borrow() == 0 {
                app.merge_local();
            } else {
                app.next_lane(queue, left, gen);
            }
        });
    }
    fn merge_local(&mut self) {
        // a cast without a readable time goes out at once rather than waiting forever below the bound
        let time = |c: &Cast| text::parse_time(&c.timestamp).unwrap_or(f64::MAX);
        // the newest of the oldest casts read from accounts that have more (counting replies left out): nothing older
        // is sure yet
        let bound = self.lanes.values().filter(|l| !l.done).filter_map(|l| l.oldest.or_else(|| l.buf.iter().map(time).reduce(f64::min))).reduce(f64::max).unwrap_or(f64::MIN);
        let mut out: Vec<Cast> = Vec::new();
        for l in self.lanes.values_mut() {
            let (keep, go): (Vec<Cast>, Vec<Cast>) = std::mem::take(&mut l.buf).into_iter().partition(|c| time(c) < bound);
            l.buf = keep;
            out.extend(go);
        }
        out.sort_by(|a, b| time(b).partial_cmp(&time(a)).unwrap_or(std::cmp::Ordering::Equal));
        let finished = self.lanes.values().all(|l| l.done && l.buf.is_empty());
        let f = self.feeds.entry("local".into()).or_default();
        f.loading = false;
        let mut had: HashSet<String> = f.items.iter().map(|c| c.bare_hash()).collect();
        let before = f.items.len();
        f.items.extend(out.into_iter().filter(|c| had.insert(c.bare_hash())));
        let none = f.items.len() == before;
        f.done = finished;
        self.local_round += 1;
        // a new cursor each round, so the view's "more" node is new and is seen again while it's on screen
        f.cursor = (!finished).then(|| format!("local:{}", self.local_round));
        // nothing new yet (the account holding the others back had only replies to strangers): its next page is read
        // right away, a few rounds at most, and after that the view offers Load more
        if none && !finished {
            if self.local_empty_rounds < 10 {
                self.local_empty_rounds += 1;
                return self.load_local(true);
            }
        }
        self.local_empty_rounds = 0;
    }

    // --- mutes, blocks and reports ---

    fn mutes_key(&self) -> String {
        format!("quilcast-wasm:mutes:{}", self.me().map_or("local".to_string(), |f| f.to_string()))
    }
    /// The list for the account (or this device, signed out) as last kept here.
    fn read_mutes(&mut self) {
        let now = host::ms() as u64;
        self.mutes = host::get(&self.mutes_key()).and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()).map(|v| crate::mutes::clean(&v, now)).unwrap_or_default();
        self.mutes_touched = false;
    }
    /// The account's list from Quilcast's server: another device may have changed it.
    pub fn sync_mutes(&mut self) {
        let Some(fid) = self.me() else { return };
        self.key_fetch("GET", format!("/api/mutes/{fid}"), "quilcast-mutes-read", String::new(), "", move |app, status, body| {
            if !(200..300).contains(&status) || app.mutes_touched || app.me() != Some(fid) {
                return;
            }
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&body) {
                app.mutes = crate::mutes::clean(&v, host::ms() as u64);
                host::set(&app.mutes_key(), &serde_json::to_string(&app.mutes).unwrap_or_default());
            }
        });
    }
    fn mutes_changed(&mut self) {
        self.mutes_touched = true;
        host::set(&self.mutes_key(), &serde_json::to_string(&self.mutes).unwrap_or_default());
        let Some(fid) = self.me() else { return };
        let body = serde_json::to_string(&self.mutes).unwrap_or_default();
        self.key_fetch("PUT", format!("/api/mutes/{fid}"), "quilcast-mutes", body, "", |app, status, body| {
            if !(200..300).contains(&status) {
                // kept here either way; the server gets the whole list with the next change
                app.say(format!("Saved on this device, but not on Quilcast's server: {}", error_text(status, &body)));
            }
        });
    }
    /// Mute or block (`block`) someone until `until` (ms; None is for good), or lift it (`on` false).
    pub fn mute(&mut self, block: bool, u: &User, on: bool, until: Option<u64>) {
        self.mutes.set_fid(block, u.fid, on, until);
        if block && on {
            // a blocked person isn't followed either
            if self.follows.get(&u.fid) == Some(&true) {
                self.follow(u.fid);
            }
            if self.is_local(u.fid) {
                self.local.retain(|l| l.fid != u.fid);
                self.save_local();
            }
        }
        self.mutes_changed();
        let what = if block { if on { "Blocked" } else { "Unblocked" } } else if on { "Muted" } else { "Unmuted" };
        self.say(format!("{what} @{}", u.handle()));
    }
    pub fn mute_word(&mut self, w: &str, on: bool, until: Option<u64>) {
        if w.trim().is_empty() {
            return;
        }
        self.mutes.set_word(w, on, until);
        self.mutes_changed();
    }

    pub fn open_report(&mut self, u: &User, hash: Option<String>) {
        self.sheet = Some(Sheet::Report(Report { fid: u.fid, hash, who: u.handle(), reason: "spam", text: String::new(), sending: false, error: None }));
    }
    /// Sends the report to Quilcast's moderators (server/report.mjs). Signed in, this browser's key signs it.
    pub fn send_report(&mut self) {
        let Some(Sheet::Report(r)) = self.sheet.as_mut() else { return };
        if r.sending {
            return;
        }
        r.sending = true;
        r.error = None;
        // the server takes 4 KB: the text is cut to fit, whatever its script
        let mut text = r.text.trim().to_string();
        while text.len() > 3000 {
            text.pop();
        }
        let mut j = serde_json::json!({"fid": r.fid, "reason": r.reason, "text": text});
        if let Some(h) = &r.hash {
            j["hash"] = serde_json::Value::String(format!("0x{h}"));
        }
        let body = j.to_string();
        let unsigned = body.clone();
        let done = move |app: &mut App, status: i32, body: Vec<u8>| {
            if status == SIGN_FAILED {
                // without a working key here, it goes out anonymously, as quilcast.com's does
                return app.http("POST", "/api/report", unsigned.as_bytes(), "application/json", report_done);
            }
            report_done(app, status, body)
        };
        match self.me() {
            Some(me) => self.key_fetch("POST", "/api/report".into(), "quilcast-report", body, &format!("\nx-fid: {me}"), done),
            None => self.http("POST", "/api/report", body.as_bytes(), "application/json", report_done),
        }
    }

    /// A request to Quilcast's server signed by this browser's key over `<what>:<fid>:<ts>:<body>` (src/write.ts
    /// keyFetch), which the server checks belongs to the account. `extra` adds header lines.
    /// It answers SIGN_FAILED when this browser has no working key. A 403 (the node hasn't listed a key added a
    /// moment ago) is tried twice more, 3 s apart, as quilcast.com does for scheduled casts and uploads.
    pub fn key_fetch(&mut self, method: &str, url: String, what: &str, body: String, extra: &str, f: impl FnOnce(&mut App, i32, Vec<u8>) + 'static) {
        let Some(a) = self.account.clone() else { return f(self, SIGN_FAILED, br#"{"error":"Sign in first."}"#.to_vec()) };
        self.key_fetch_try(a, method.to_string(), url, what.to_string(), body, extra.to_string(), 2, f)
    }
    /// The same, signed as `a`, which needn't be the account in use (push notifications for each account here).
    #[allow(clippy::too_many_arguments)]
    pub fn key_fetch_as(&mut self, a: Account, method: &str, url: String, what: &str, body: String, extra: &str, f: impl FnOnce(&mut App, i32, Vec<u8>) + 'static) {
        let (method, what, extra) = (method.to_string(), what.to_string(), extra.to_string());
        self.load_key(&a.clone(), move |app| app.key_fetch_try(a, method, url, what, body, extra, 2, f))
    }
    /// `a`'s raw key out of the vault first when it isn't yet (only the account in use has it from the start),
    /// then `f`; a WebCrypto key needs nothing.
    pub(crate) fn load_key(&mut self, a: &Account, f: impl FnOnce(&mut App) + 'static) {
        if !a.raw || self.has_seed(&a.key) {
            return f(self);
        }
        let id = self.wait(move |app, code, bytes| {
            if let (1, Ok(s)) = (code, <[u8; 32]>::try_from(bytes.as_slice())) {
                app.keep_seed(s);
            }
            f(app)
        });
        host::vget(id, &format!("raw:{}", a.key));
    }
    /// Whether this browser can sign as `a` (its key is here and works), without sending anything.
    pub(crate) fn can_sign(&mut self, a: &Account, f: impl FnOnce(&mut App, bool) + 'static) {
        let key = fc::unhex(&a.key);
        self.load_key(a, move |app| app.sign(&key, b"quilcast-wasm: key check", move |app, r| f(app, r.is_ok())))
    }
    #[allow(clippy::too_many_arguments)]
    fn key_fetch_try(&mut self, a: Account, method: String, url: String, what: String, body: String, extra: String, tries: u32, f: impl FnOnce(&mut App, i32, Vec<u8>) + 'static) {
        let ts = host::ms() as u64;
        let msg = format!("{what}:{}:{ts}:{body}", a.fid);
        let key = fc::unhex(&a.key);
        self.sign(&key, msg.as_bytes(), move |app, sig| match sig {
            Ok(sig) => {
                let headers = signed_headers(&method, &a.key, ts, &sig, &extra);
                let sent = body.clone();
                app.http(&method.clone(), &url.clone(), sent.as_bytes(), &headers, move |app, status, answer| {
                    if status == 403 && tries > 0 && app.me() == Some(a.fid) {
                        app.later(3000.0, move |app| app.key_fetch_try(a, method, url, what, body, extra, tries - 1, f));
                    } else {
                        f(app, status, answer)
                    }
                })
            }
            Err(e) => f(app, SIGN_FAILED, serde_json::json!({"error": e}).to_string().into_bytes()),
        });
    }

    // --- likes and recasts ---

    /// Whether a like (1) or recast (2) is on, and the count to show: a tap this visit wins (src/api.ts tapped).
    pub fn tapped(&self, kind: u64, c: &Cast) -> (bool, u64) {
        let h = c.bare_hash();
        let mine = if kind == 1 { &self.mine_likes } else { &self.mine_recasts };
        let vc = c.viewer_context.as_ref().and_then(|v| if kind == 1 { v.liked } else { v.recasted });
        let was = vc.unwrap_or_else(|| mine.contains(&h));
        let count = if kind == 1 { c.reactions.likes_count } else { c.reactions.recasts_count };
        match self.taps.get(&format!("{kind}{h}")) {
            None => (was, count),
            Some(&(on, at)) => (on, (on as u64).max(if at == count { (count + on as u64).saturating_sub(was as u64) } else { count })),
        }
    }

    pub fn react(&mut self, kind: u64, c: &Cast) {
        if self.account.is_none() {
            return self.navigate("/join", false);
        }
        let (on, _) = self.tapped(kind, c);
        let h = c.bare_hash();
        let key = format!("{kind}{h}");
        let count = if kind == 1 { c.reactions.likes_count } else { c.reactions.recasts_count };
        let before = self.taps.get(&key).copied();
        let at = before.map_or(count, |b| b.1);
        self.taps.insert(key.clone(), (!on, at));
        let body = fc::reaction_body(kind, &fc::CastRef { fid: c.author.fid, hash: h });
        let t = if on { fc::mt::REACTION_REMOVE } else { fc::mt::REACTION_ADD };
        self.send(t, body, move |app, r| {
            if let Err(e) = r {
                match before {
                    Some(b) => app.taps.insert(key, b),
                    None => app.taps.remove(&key),
                };
                app.say(e);
            }
        });
    }

    /// Follow or unfollow someone: with the account, or signed out on this device only (anonymous mode).
    pub fn follow_user(&mut self, u: &User) {
        if self.account.is_none() {
            let on = !self.is_local(u.fid);
            return self.set_local(u, on);
        }
        self.follow(u.fid);
    }

    pub fn follow(&mut self, fid: u64) {
        if self.account.is_none() {
            return self.navigate("/join", false);
        }
        let on = self.follows.get(&fid).copied().unwrap_or(false);
        self.follows.insert(fid, !on);
        self.send(if on { fc::mt::LINK_REMOVE } else { fc::mt::LINK_ADD }, fc::follow_body(fid), move |app, r| {
            if let Err(e) = r {
                app.follows.insert(fid, on);
                app.say(e);
            } else if !on {
                // the Following feed has someone new in it
                if let Some(me) = app.me() {
                    app.feeds.remove(&format!("following:{me}"));
                }
            }
        });
    }

    pub fn delete_cast(&mut self, c: &Cast) {
        if !host::ask("Delete this cast?") {
            return;
        }
        let h = c.bare_hash();
        self.send(fc::mt::CAST_REMOVE, fc::cast_remove_body(&h), move |app, r| match r {
            Ok(_) => {
                for f in app.feeds.values_mut() {
                    f.items.retain(|x| x.bare_hash() != h);
                }
                for t in app.threads.values_mut() {
                    if let Load::Ready(root) = t {
                        drop_reply(root, &h);
                    }
                }
                app.say("Deleted");
                if app.route == Route::Cast(h.clone()) {
                    app.navigate("/", false);
                }
            }
            Err(e) => app.say(e),
        });
    }

    // --- composing ---

    pub fn open_compose(&mut self, parent: Option<Cast>, quote: Option<Cast>) {
        if self.account.is_none() {
            return self.navigate("/join", false);
        }
        if self.compose.as_ref().is_some_and(|c| c.sending) {
            return;
        }
        self.sheet = None;
        if let Some(old) = self.compose.take() {
            App::drop_files(&old);
        }
        self.compose_seq += 1;
        let mut c = Compose::new(self.compose_seq);
        c.parent = parent;
        c.quote = quote;
        c.base = crate::compose::snapshot(&c);
        self.compose = Some(c);
        if self.drafts_key.is_none() {
            self.check_drafts_key();
        }
    }

    /// A new cast into channel `id` (a channel page's Cast here).
    pub fn compose_in(&mut self, id: &str) {
        self.open_compose(None, None);
        self.pick_channel(Some(id.to_string()));
    }

    /// Choose the channel the new cast goes into (or none). farcaster.xyz leaves non-members' casts out of a
    /// members-only channel, so that gets a warning.
    pub fn pick_channel(&mut self, id: Option<String>) {
        let Some(c) = self.compose.as_mut() else { return };
        c.channel = id.clone();
        c.picking = None;
        c.closed = false;
        let (Some(id), Some(me)) = (id, self.me()) else { return };
        let closed = matches!(self.channels.get(&id), Some(Load::Ready(Some(ch))) if !ch.open);
        if !closed {
            return;
        }
        let url = format!("/api/channel/{}/member/{me}", text::encode(&id));
        self.get::<serde_json::Value>(url, move |app, r| {
            let out = r.ok().and_then(|v| v.get("member").and_then(|m| m.as_bool())) == Some(false);
            if let Some(c) = app.compose.as_mut() {
                if c.channel.as_deref() == Some(&id) {
                    c.closed = out;
                }
            }
        });
    }

    /// Escape or ✕: a panel closes first; then a cast with something new in it asks whether to keep it as a draft.
    pub fn close_compose(&mut self) {
        let Some(c) = self.compose.as_mut() else { return };
        if c.sending {
            return;
        }
        if c.panel.take().is_some() || std::mem::take(&mut c.typing).is_some() {
            c.suggest.clear();
            return;
        }
        if c.asking {
            c.asking = false;
            return;
        }
        let empty = c.empty();
        let changed = crate::compose::snapshot(c) != c.base;
        if !empty && changed {
            if self.drafts_key == Some(true) {
                c.asking = true;
                return;
            }
            if !host::ask("Discard this cast?") {
                return;
            }
        }
        self.discard_compose();
    }
    pub fn discard_compose(&mut self) {
        if let Some(c) = self.compose.take() {
            App::drop_files(&c);
        }
    }

    /// A name's FID: Some(None) when there's no such user, None when the node couldn't say. ENS names, which the
    /// node's by-username doesn't know, come from search (exact match only).
    pub(crate) fn fid_by_name(&mut self, name: String, f: impl FnOnce(&mut App, Option<Option<u64>>) + 'static) {
        let url = self.node("/v2/farcaster/user/by-username", &[("username", name.clone())]);
        self.get::<UserResp>(url, move |app, r| match r {
            Ok(UserResp { user: Some(u) }) => f(app, Some(Some(u.fid))),
            Ok(_) | Err((404, _)) if name.contains('.') => {
                let url = app.node("/v2/farcaster/user/search", &[("q", name.clone()), ("limit", "50".into())]);
                app.get::<UsersResp>(url, move |app, r| match r {
                    Ok(r) => {
                        let users = if r.users.is_empty() { r.result.map(|x| x.users).unwrap_or_default() } else { r.users };
                        f(app, Some(users.iter().find(|u| u.username.as_deref().map(|s| s.to_lowercase()) == Some(name.clone())).map(|u| u.fid)))
                    }
                    Err(_) => f(app, None),
                })
            }
            Ok(_) | Err((404, _)) => f(app, Some(None)),
            Err(_) => f(app, None),
        });
    }

    /// A cast just sent shows where it belongs before the node has indexed it.
    pub(crate) fn show_posted(&mut self, hash: String, text: String, parent: Option<Cast>, quote: Option<fc::CastRef>, channel: Option<String>, media: Vec<String>) {
        let Some(a) = self.account.clone() else { return };
        let author = User { fid: a.fid, username: a.username.clone(), display_name: a.display.clone(), pfp_url: a.pfp.clone(), ..Default::default() };
        let c = Cast {
            hash: hash.clone(),
            text,
            timestamp: iso_now(),
            author,
            parent_hash: parent.as_ref().map(|p| p.bare_hash()),
            parent_author: ParentAuthor { fid: parent.as_ref().map(|p| p.author.fid) },
            parent_url: channel.clone(),
            embeds: media.into_iter().map(|u| EmbedJ { url: Some(u), cast_id: None }).chain(quote.map(|q| EmbedJ { url: None, cast_id: Some(CastIdJ { fid: q.fid, hash: q.hash }) })).collect(),
            ..Default::default()
        };
        match &parent {
            Some(p) => {
                let ph = p.bare_hash();
                for t in self.threads.values_mut() {
                    if let Load::Ready(root) = t {
                        add_reply(root, &ph, &c);
                    }
                }
            }
            None => {
                let mut keys = vec![format!("following:{}", a.fid), format!("casts:{}", a.fid)];
                keys.extend(channel.map(|u| format!("channel:{u}")));
                for k in keys {
                    if let Some(f) = self.feeds.get_mut(&k) {
                        f.items.insert(0, c.clone());
                    }
                }
            }
        }
    }

    // --- signing and sending ---

    /// Sign a message as the account and submit it; `f` hears its hash or what went wrong.
    pub fn send(&mut self, kind: u64, body: Vec<u8>, f: impl FnOnce(&mut App, Result<String, String>) + 'static) {
        let Some(a) = self.account.clone() else { return f(self, Err("Sign in first.".into())) };
        let now = fc::fc_time(host::ms());
        let at = fc::stamp(kind, now, 0, &mut self.last_toggle);
        let u = fc::prepare(kind, a.fid, at, &body);
        let key = fc::unhex(&a.key);
        let hash = u.hash.clone();
        let signer = key.clone();
        self.sign(&signer, &hash, move |app, sig| match sig {
            Ok(sig) => {
                let msg = fc::seal(&u, &sig, &key);
                app.submit(msg, fc::hex(&u.hash), 0, f)
            }
            Err(e) => f(app, Err(e)),
        });
    }

    pub(crate) fn sign(&mut self, key: &[u8], msg: &[u8], f: impl FnOnce(&mut App, Result<Vec<u8>, String>) + 'static) {
        for seed in &self.raw_seeds {
            use ed25519_dalek::Signer;
            let k = ed25519_dalek::SigningKey::from_bytes(seed);
            if k.verifying_key().as_bytes()[..] == key[..] {
                return f(self, Ok(k.sign(msg).to_bytes().to_vec()));
            }
        }
        let id = self.wait(move |app, code, sig| f(app, if code == 1 && sig.len() == 64 { Ok(sig) } else { Err("This browser's key is gone. Sign out and sign in again.".into()) }));
        host::edsign(id, key, msg);
    }

    /// A node turning messages away for a moment gets the same bytes again after 1, 2 and 4 s (src/write.ts submit).
    fn submit(&mut self, msg: Vec<u8>, hash: String, tries: u32, f: impl FnOnce(&mut App, Result<String, String>) + 'static) {
        let url = format!("{}/v1/submitMessage", self.settings.node.trim_end_matches('/'));
        let again = msg.clone();
        self.http("POST", &url, &msg, "application/octet-stream", move |app, status, body| {
            if (200..300).contains(&status) {
                return f(app, Ok(hash));
            }
            let e = error_text(status, &body);
            let busy = e.to_lowercase().contains("unavailable") || e.to_lowercase().contains("mempool");
            if busy && tries < 3 {
                app.later(1000.0 * (1 << tries) as f64, move |app| app.submit(again, hash, tries + 1, f));
            } else if busy {
                f(app, Err("Couldn't reach the Farcaster node. Try again.".into()))
            } else if e.contains("invalid signer") || e.contains("unknown signer") || e.contains("last_used_at expired") {
                f(app, Err("The network no longer takes this browser's key. Sign out and sign in again.".into()))
            } else {
                f(app, Err(e))
            }
        });
    }

    // --- signing in and out ---

    pub fn sign_in(&mut self) {
        if self.join.step != JoinStep::Idle {
            return;
        }
        let phrase = fc::normal_phrase(&self.join.phrase);
        let words = phrase.split(' ').filter(|w| !w.is_empty()).count();
        if ![12, 15, 18, 21, 24].contains(&words) || !phrase.bytes().all(|b| b.is_ascii_lowercase() || b == b' ') {
            self.join.error = Some("A recovery phrase is 12 or 24 words.".into());
            return;
        }
        let Some(custody) = fc::custody_key(&phrase) else {
            self.join.error = Some("That recovery phrase doesn't make a key.".into());
            return;
        };
        // the phrase is used for this sign-in and not kept
        self.join.phrase = String::new();
        self.join.error = None;
        self.join.step = JoinStep::Finding;
        let addr = fc::address(&custody);
        self.fid_for(addr.clone(), move |app, fid| match fid {
            // an account already signed in here gets no second key: it's switched to (and keeps its drafts key, which
            // a session from before drafts may not have had)
            Ok(Some(fid)) if app.accounts.iter().any(|a| a.fid == fid) => {
                app.join = Join::default();
                if app.me() != Some(fid) {
                    app.switch_account(fid);
                }
                if app.me() == Some(fid) {
                    app.keep_drafts_key(fid, fc::drafts_secret(fid, &custody));
                    app.navigate("/", false);
                    app.say("That account is already signed in here.");
                }
            }
            Ok(Some(fid)) => {
                // the drafts key needs the custody, so it's made now, while the phrase is in hand (src/write.ts draftKey)
                app.join_secret = Some((fid, fc::drafts_secret(fid, &custody)));
                app.add_key(fid, addr, custody)
            }
            Ok(None) => app.join_failed("No Farcaster account uses this recovery phrase. You can create one at quilcast.com.".into()),
            Err(e) => app.join_failed(e),
        });
    }

    fn join_failed(&mut self, e: String) {
        self.join_secret = None;
        self.join.step = JoinStep::Idle;
        self.join.error = Some(e);
    }

    /// The FID whose custody address this is: Hypersnap first, then its native accounts, then Optimism's IdRegistry
    /// (src/join.tsx fidFor).
    fn fid_for(&mut self, addr: String, f: impl FnOnce(&mut App, Result<Option<u64>, String>) + 'static) {
        let url = self.node("/v2/farcaster/user/custody-address", &[("custody_address", addr.clone())]);
        self.get::<UserResp>(url, move |app, r| {
            if let Ok(UserResp { user: Some(u) }) = &r {
                if u.fid > 0 && u.custody_address.as_deref().map(|c| c.to_lowercase()) == Some(addr.clone()) {
                    return f(app, Ok(Some(u.fid)));
                }
            }
            let url = format!("{}/v1/nativeAccount?custody={addr}", app.settings.node.trim_end_matches('/'));
            app.http("GET", &url, &[], "", move |app, status, body| {
                let j: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
                let fid = j.get("fid").and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))).unwrap_or(0);
                if (200..300).contains(&status) && fid > 0 {
                    return f(app, Ok(Some(fid)));
                }
                let call = serde_json::json!({"jsonrpc": "2.0", "id": 1, "method": "eth_call", "params": [{"to": fc::ID_REGISTRY, "data": fc::id_of_call(&addr)}, "latest"]});
                app.http("POST", OPTIMISM_RPC, call.to_string().as_bytes(), "application/json", move |app, status, body| {
                    let j: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
                    match j.get("result").and_then(|v| v.as_str()) {
                        Some(h) if (200..300).contains(&status) => {
                            let b = fc::unhex(h);
                            let fid = b.iter().rev().take(8).rev().fold(0u64, |n, x| n << 8 | *x as u64);
                            f(app, Ok((fid > 0).then_some(fid)))
                        }
                        _ => f(app, Err("Couldn't look up the account. Try again.".into())),
                    }
                });
            });
        });
    }

    /// A new key for this browser, added to the account with a KEY_ADD the custody signs (no gas: Hypersnap's
    /// gasless signers), then the account is ready once the node lists the key.
    fn add_key(&mut self, fid: u64, custody_addr: String, custody: [u8; 32]) {
        self.join.step = JoinStep::AddingKey;
        let id = self.wait(move |app, code, pubk| {
            if code == 1 && pubk.len() == 32 {
                app.key_add(fid, custody_addr, custody, pubk, false);
            } else {
                // no Ed25519 in this browser's WebCrypto: a raw key, sealed in the vault
                let mut seed = [0u8; 32];
                host::fill(&mut seed);
                let pubk = ed25519_dalek::SigningKey::from_bytes(&seed).verifying_key().to_bytes().to_vec();
                let key = format!("raw:{}", fc::hex(&pubk));
                let id = app.wait(move |app, code, _| {
                    if code != 1 {
                        return app.join_failed("This browser can't keep a key. Try another browser.".into());
                    }
                    app.raw_seeds.push(seed);
                    app.key_add(fid, custody_addr, custody, pubk, true);
                });
                host::vset(id, &key, &seed);
            }
        });
        host::ednew(id);
    }

    fn key_add(&mut self, fid: u64, custody_addr: String, custody: [u8; 32], pubk: Vec<u8>, raw: bool) {
        let now = fc::fc_time(host::ms());
        let nonce = (host::ms() / 1000.0) as u64;
        let body = fc::key_add_body(fid, &custody, &pubk, nonce, now);
        let u = fc::prepare(fc::mt::KEY_ADD, fid, now, &body);
        let hash = u.hash.clone();
        let key = pubk.clone();
        self.sign(&key, &hash, move |app, sig| {
            let sig = match sig {
                Ok(s) => s,
                Err(e) => return app.join_failed(e),
            };
            let msg = fc::seal(&u, &sig, &pubk);
            app.submit(msg, fc::hex(&u.hash), 0, move |app, r| match r {
                Ok(_) => {
                    app.join.step = JoinStep::Waiting;
                    let a = Account { fid, custody: custody_addr, key: fc::hex(&pubk), raw, nonce, ..Default::default() };
                    app.wait_listed(a, 0);
                }
                Err(e) => app.join_failed(e),
            });
        });
    }

    /// Until the node lists the new key (a few seconds), writes would be refused.
    fn wait_listed(&mut self, a: Account, tries: u32) {
        let url = self.node("/v1/signer", &[("fid", a.fid.to_string()), ("signer", format!("0x{}", a.key))]);
        self.http("GET", &url, &[], "", move |app, status, _| {
            if (200..300).contains(&status) || tries >= 15 {
                app.finish_join(a);
            } else {
                app.later(2000.0, move |app| app.wait_listed(a, tries + 1));
            }
        });
    }

    fn finish_join(&mut self, mut a: Account) {
        let url = self.node("/v2/farcaster/user", &[("fid", a.fid.to_string())]);
        self.get::<UserResp>(url, move |app, r| {
            if let Ok(UserResp { user: Some(u) }) = r {
                a.username = u.username;
                a.display = u.display_name;
                a.pfp = u.pfp_url;
            }
            app.join_done(a);
        });
    }

    /// The new account takes over, once nothing of the one in use is still going out (an account added while a
    /// thread or a profile was being sent would cut it off halfway).
    pub(crate) fn join_done(&mut self, a: Account) {
        if self.sending() {
            return self.later(1000.0, move |app| app.join_done(a));
        }
        self.join = Join::default();
        let secret = self.join_secret.take().filter(|(f, _)| *f == a.fid);
        self.set_account(Some(a));
        if let Some((fid, s)) = secret {
            self.keep_drafts_key(fid, s);
        }
        self.navigate("/", false);
        self.say("Signed in");
    }

    pub(crate) fn set_account(&mut self, a: Option<Account>) {
        match &a {
            Some(a) => {
                host::set(ACCOUNT_KEY, &serde_json::to_string(a).unwrap_or_default());
                match self.accounts.iter_mut().find(|x| x.fid == a.fid) {
                    Some(x) => *x = a.clone(),
                    None => self.accounts.push(a.clone()),
                }
                self.save_accounts();
            }
            None => host::del(ACCOUNT_KEY),
        }
        self.account = a;
        self.drop_edit();
        // the account's own mutes (or this device's, signed out) take over
        self.read_mutes();
        self.sync_mutes();
        // what was read for the previous viewer goes
        self.feeds.clear();
        self.lists.clear();
        self.lanes.clear();
        self.local_gen += 1;
        self.sheet = None;
        self.notes = Feed::default();
        self.threads.clear();
        self.profiles.clear();
        self.follows.clear();
        self.mine_likes.clear();
        self.mine_recasts.clear();
        self.taps.clear();
        self.drafts = None;
        self.scheduled = None;
        self.stickers = None;
        self.drafts_key = None;
        self.pins.clear();
        self.discard_compose();
        self.load_mine();
        self.check_drafts_key();
    }

    /// Sign out: this browser's key revokes itself (so a copy of it stops working too), then it's deleted.
    pub fn sign_out(&mut self) {
        let Some(a) = self.account.clone() else { return };
        // a thread still going out would stop halfway, with nothing to say so
        if self.account_busy() {
            return;
        }
        let name = a.username.clone().map_or_else(|| format!("!{}", a.fid), |u| format!("@{u}"));
        if !host::ask(&format!("Sign out of {name}? This browser's key is revoked, and signing in again needs your recovery phrase.")) {
            return;
        }
        self.busy.insert("signout".into());
        // a raw key still on its way out of the vault (just switched to) is waited for, so it's revoked, not just
        // forgotten here
        if a.raw && !self.has_seed(&a.key) {
            let vkey = format!("raw:{}", a.key);
            let id = self.wait(move |app, code, bytes| {
                if let (1, Ok(s)) = (code, <[u8; 32]>::try_from(bytes.as_slice())) {
                    app.keep_seed(s);
                }
                app.revoke(a, name);
            });
            return host::vget(id, &vkey);
        }
        self.revoke(a, name);
    }

    /// Signs and sends the KEY_REMOVE of `a`'s key, then forgets the account here.
    fn revoke(&mut self, a: Account, name: String) {
        let key = fc::unhex(&a.key);
        let now = fc::fc_time(host::ms());
        let u = fc::prepare(fc::mt::KEY_REMOVE, a.fid, now, &fc::key_remove_self_body(&key, (host::ms() / 1000.0) as u64, now));
        let hash = u.hash.clone();
        let k2 = key.clone();
        let finish = move |app: &mut App| {
            app.busy.remove("signout");
            if a.raw {
                host::vdel(&format!("raw:{}", a.key));
            } else {
                host::eddrop(&k2);
            }
            let pubk = k2.clone();
            app.raw_seeds.retain(|s| ed25519_dalek::SigningKey::from_bytes(s).verifying_key().as_bytes()[..] != pubk[..]);
            host::adrop(&App::drafts_name(a.fid));
            // its push notifications stop reaching this browser
            app.forget_alerts(a.fid);
            app.accounts.retain(|x| x.fid != a.fid);
            app.save_accounts();
            // the next account signed in here takes over, if there is one
            match app.accounts.first().cloned() {
                Some(next) => {
                    let other = next.username.clone().map_or_else(|| format!("!{}", next.fid), |u| format!("@{u}"));
                    app.use_account(next);
                    app.navigate("/", false);
                    app.say(format!("Signed out of {name}. Using {other}"));
                }
                None => {
                    app.set_account(None);
                    app.navigate("/", false);
                    app.say("Signed out");
                }
            }
        };
        let signer = key.clone();
        self.sign(&signer, &hash, move |app, sig| match sig {
            Ok(sig) => {
                let msg = fc::seal(&u, &sig, &key);
                app.submit(msg, fc::hex(&u.hash), 0, move |app, r| match r {
                    // a key the network already dropped needs no revoking
                    Ok(_) => finish(app),
                    Err(e) if e.contains("no longer takes") => finish(app),
                    Err(e) => {
                        app.busy.remove("signout");
                        app.say(format!("Couldn't revoke this browser's key: {e}"));
                    }
                })
            }
            // a key this browser no longer has can't be used by anyone
            Err(_) => finish(app),
        });
    }

    pub fn save_settings(&mut self) {
        host::set(SETTINGS_KEY, &serde_json::to_string(&self.settings).unwrap_or_default());
    }

    pub fn set_node(&mut self) {
        let n = self.node_text.trim().trim_end_matches('/').to_string();
        let n = if n.is_empty() { DEFAULT_NODE.to_string() } else { n };
        if text::safe_url(&n).is_none() && !n.starts_with("http://localhost") && !n.starts_with("http://127.0.0.1") {
            return self.say("The node has to be an http(s) address.");
        }
        self.settings.node = n.clone();
        self.node_text = n;
        self.save_settings();
        self.feeds.clear();
        self.lists.clear();
        self.lanes.clear();
        self.local_gen += 1;
        self.threads.clear();
        self.profiles.clear();
        self.notes = Feed::default();
        self.say("Node saved");
    }
}

/// What `key_fetch` answers when it couldn't sign (no account, or no working key in this browser).
pub const SIGN_FAILED: i32 = -1;

/// The header lines (web/shell.js fetch) of a request signed by the account's key `pubk` (hex) at `ts`: what
/// server/looks.mjs keySigned reads. Every value is hex or a number, so none can break a line.
pub fn signed_headers(method: &str, pubk: &str, ts: u64, sig: &[u8], extra: &str) -> String {
    let ct = if method == "GET" { "" } else { "application/json" };
    format!("{ct}\nx-key: 0x{pubk}\nx-ts: {ts}\nx-sig: {}{extra}", fc::hex(sig))
}

fn report_done(app: &mut App, status: i32, body: Vec<u8>) {
    if (200..300).contains(&status) {
        app.sheet = None;
        app.say("Thanks. The report was sent to Quilcast's moderators.");
    } else if let Some(Sheet::Report(r)) = app.sheet.as_mut() {
        r.sending = false;
        r.error = Some(if status == 0 { "The report couldn't be sent. Try again.".into() } else { error_text(status, &body) });
    }
}

pub fn default_channel_url(id: &str) -> String {
    format!("https://warpcast.com/~/channel/{id}")
}

/// A username as plain text may spell it (lowercase fname or ENS-style name).
fn local_name(n: &str) -> bool {
    (1..=64).contains(&n.len()) && n.bytes().next().is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit()) && n.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}

fn clean_local(xs: &serde_json::Value) -> Vec<Local> {
    let mut out: Vec<Local> = Vec::new();
    for x in xs.as_array().into_iter().flatten() {
        let fid = x.get("fid").and_then(|f| f.as_u64().or_else(|| f.as_str().and_then(|s| s.parse().ok()))).unwrap_or(0);
        if fid == 0 || fid > (1 << 53) - 1 || out.iter().any(|l| l.fid == fid) {
            continue;
        }
        let username = x.get("username").and_then(|n| n.as_str()).filter(|n| local_name(n)).map(String::from);
        out.push(Local { fid, username });
    }
    out
}

fn read_local() -> Vec<Local> {
    host::get(LOCAL_KEY).and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok()).map(|v| clean_local(&v)).unwrap_or_default()
}

/// What an import holds (src/local.ts parseImport): an export, a JSON list (of FIDs, usernames or {fid, username}),
/// or plain text with FIDs and @usernames (also profile links). `names` are usernames still to look up.
pub fn parse_import(t: &str) -> (Vec<Local>, Vec<String>) {
    let mut follows: Vec<Local> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    let items: Vec<serde_json::Value> = match serde_json::from_str::<serde_json::Value>(t.trim()) {
        Ok(serde_json::Value::Array(a)) => a,
        Ok(v) if v.get("follows").is_some_and(|f| f.is_array()) => v["follows"].as_array().cloned().unwrap_or_default(),
        _ => t.split(|c: char| c.is_whitespace() || ",;".contains(c)).filter(|s| !s.is_empty()).map(|s| serde_json::Value::String(s.into())).collect(),
    };
    for x in items {
        let s = match &x {
            serde_json::Value::Object(_) => {
                let l = clean_local(&serde_json::Value::Array(vec![x.clone()]));
                if let Some(l) = l.into_iter().next() {
                    if !follows.iter().any(|f| f.fid == l.fid) {
                        follows.push(l);
                    }
                    continue;
                }
                match x.get("username").and_then(|n| n.as_str()) {
                    Some(n) => format!("@{n}"),
                    None => continue,
                }
            }
            serde_json::Value::Number(n) => n.to_string(),
            serde_json::Value::String(s) => s.clone(),
            _ => continue,
        };
        let s = s.trim().trim_matches(|c| c == '"' || c == '\'');
        // a profile link counts by its name or FID (quilcast.com/u/name, farcaster.xyz/name, warpcast.com/~/profiles/123)
        let s = match s.split_once("://").map_or(s, |(_, r)| r).split_once('/') {
            Some((host, rest)) if host.contains('.') => {
                let rest = rest.split(['?', '#']).next().unwrap_or("");
                let parts: Vec<&str> = rest.split('/').filter(|p| !p.is_empty()).collect();
                match parts.as_slice() {
                    ["u", n] | ["~", "profiles", n] | [n] => n.to_string(),
                    _ => continue,
                }
            }
            _ => s.to_string(),
        };
        let s = s.trim_start_matches('@').to_lowercase();
        if !s.is_empty() && s.len() <= 16 && s.bytes().all(|b| b.is_ascii_digit()) {
            if let Ok(fid) = s.parse::<u64>() {
                if fid > 0 && !follows.iter().any(|l| l.fid == fid) {
                    follows.push(Local { fid, username: None });
                }
            }
        } else if local_name(&s) && !names.contains(&s) {
            names.push(s);
        }
    }
    (follows, names)
}

fn drop_reply(c: &mut Cast, hash: &str) {
    c.direct_replies.retain(|r| r.bare_hash() != hash);
    for r in &mut c.direct_replies {
        drop_reply(r, hash);
    }
}
fn add_reply(c: &mut Cast, parent: &str, reply: &Cast) {
    if c.bare_hash() == parent {
        c.direct_replies.insert(0, reply.clone());
        c.replies.count += 1;
        return;
    }
    for r in &mut c.direct_replies {
        add_reply(r, parent, reply);
    }
}
fn iso_now() -> String {
    text::iso(host::ms())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes() {
        assert_eq!(parse_route("/"), Route::Home(false));
        assert_eq!(parse_route("/?feed=trending"), Route::Home(true));
        assert_eq!(parse_route("/c/0x6BA6089BB1D3304B82FA17DBB34AA7C691713B0F"), Route::Cast("6ba6089bb1d3304b82fa17dbb34aa7c691713b0f".into()));
        assert_eq!(parse_route("/c/nothash"), Route::NotFound);
        assert_eq!(parse_route("/u/dwr"), Route::User("dwr".into(), false));
        assert_eq!(parse_route("/u/dwr/replies"), Route::User("dwr".into(), true));
        assert_eq!(parse_route("/search?q=gm%20there&tab=casts"), Route::Search("gm there".into(), Tab::Casts));
        assert_eq!(parse_route("/search?q=x&tab=channels"), Route::Search("x".into(), Tab::Channels));
        assert_eq!(parse_route("/search?q=x"), Route::Search("x".into(), Tab::People));
        assert_eq!(parse_route("/?as=@DWR"), Route::Browse("dwr".into()));
        assert_eq!(parse_route("/?as=3"), Route::Browse("3".into()));
        assert_eq!(parse_route("/?as=no%20way"), Route::Home(false), "a name that can't be one is ignored");
        assert_eq!(parse_route("/c/0x6ba6089bb1d3304b82fa17dbb34aa7c691713b0f/likes"), Route::Who("6ba6089bb1d3304b82fa17dbb34aa7c691713b0f".into(), "likes"));
        assert_eq!(parse_route("/c/6ba6089bb1d3304b82fa17dbb34aa7c691713b0f/quotes"), Route::Who("6ba6089bb1d3304b82fa17dbb34aa7c691713b0f".into(), "quotes"));
        assert_eq!(parse_route("/u/dwr/followers"), Route::Follows("dwr".into(), "followers"));
        assert_eq!(parse_route("/channels"), Route::Channels);
        assert_eq!(parse_route("/channel/Memes"), Route::Channel("memes".into()));
        assert_eq!(parse_route("/channel/no_way"), Route::NotFound);
        assert_eq!(parse_route("/notifications"), Route::Notifications);
        assert_eq!(parse_route("/nope"), Route::NotFound);
    }

    #[test]
    fn imports_lists_names_and_links() {
        let (f, n) = parse_import("3, @DWR quilcast.com/u/v https://warpcast.com/~/profiles/99 quilcast.com/c/0xab 'x.eth' 0");
        assert_eq!(f.iter().map(|l| l.fid).collect::<Vec<_>>(), vec![3, 99]);
        assert_eq!(n, vec!["dwr", "v", "x.eth"]);
        let (f, n) = parse_import(r#"{"type":"quilcast-local-follows","version":1,"follows":[{"fid":5,"username":"a"},{"fid":5},{"username":"b"},{"fid":"6","username":"<script>"}]}"#);
        assert_eq!(f, vec![Local { fid: 5, username: Some("a".into()) }, Local { fid: 6, username: None }]);
        assert_eq!(n, vec!["b"]);
        let (f, _) = parse_import("[7, 8]");
        assert_eq!(f.len(), 2);
    }

    fn at(fid: u64, h: &str, ts: &str) -> Cast {
        Cast { hash: h.into(), timestamp: ts.into(), author: User { fid, ..Default::default() }, ..Default::default() }
    }

    #[test]
    fn the_device_feed_merges_newest_first_and_waits_for_slow_accounts() {
        let mut app = App::new();
        app.lanes.insert(1, Lane { buf: vec![at(1, "a3", "2026-01-03T00:00:00Z"), at(1, "a1", "2026-01-01T00:00:00Z")], cursor: Some("c".into()), done: false, oldest: None });
        app.lanes.insert(2, Lane { buf: vec![at(2, "b4", "2026-01-04T00:00:00Z"), at(2, "b2", "2026-01-02T00:00:00Z")], cursor: None, done: true, oldest: None });
        app.merge_local();
        let f = &app.feeds["local"];
        // account 1 may still have casts between its oldest read (01) and the rest: nothing older than 01 is shown yet
        assert_eq!(f.items.iter().map(|c| c.hash.as_str()).collect::<Vec<_>>(), vec!["b4", "a3", "b2", "a1"]);
        assert!(!f.done);
        app.lanes.get_mut(&1).unwrap().done = true;
        app.merge_local();
        assert!(app.feeds["local"].done);
        app.lanes.insert(3, Lane { buf: vec![at(3, "c5", "2026-01-05T00:00:00Z"), at(3, "c0", "2025-12-31T00:00:00Z")], cursor: Some("x".into()), done: false, oldest: None });
        app.lanes.insert(4, Lane { buf: vec![at(4, "d1", "2026-01-01T12:00:00Z")], cursor: Some("y".into()), done: false, oldest: None });
        app.merge_local();
        let shown: Vec<&str> = app.feeds["local"].items.iter().skip(4).map(|c| c.hash.as_str()).collect();
        assert_eq!(shown, vec!["c5", "d1"], "c0 waits until account 4 has been read further");
    }

    #[test]
    fn replies_left_out_still_hold_back_older_casts() {
        sent();
        let mut app = App::new();
        app.local = vec![Local { fid: 1, username: None }, Local { fid: 2, username: None }];
        app.load_feed("local".into(), false);
        let day = |d: u32| format!("2026-01-{d:02}T00:00:00Z");
        let page = |fid: u64, casts: Vec<serde_json::Value>, more: bool| serde_json::json!({"casts": casts, "next": {"cursor": if more { Some(format!("p{fid}")) } else { None }}}).to_string().into_bytes();
        let reply = |n: u32| serde_json::json!({"hash": format!("{:040x}", 100 + n), "timestamp": day(n), "author": {"fid": 1}, "parent_hash": "ab", "parent_author": {"fid": 999}});
        let top = |fid: u64, n: u32| serde_json::json!({"hash": format!("{:040x}", fid * 1000 + n as u64), "timestamp": day(n), "author": {"fid": fid}});
        for (id, what, _) in sent() {
            if what.contains("fid=1&") || what.ends_with("fid=1") {
                // a page of nothing but replies to a stranger
                app.done(id, 200, page(1, (20..=28).rev().map(reply).collect(), true));
            } else {
                app.done(id, 200, page(2, vec![top(2, 27), top(2, 10)], false));
            }
        }
        let days = |app: &App| app.feeds["local"].items.iter().map(|c| c.timestamp[8..10].to_string()).collect::<Vec<_>>();
        assert_eq!(days(&app), vec!["27"], "day 10 waits: account 1 may still have something newer");
        app.load_feed("local".into(), true);
        for (id, _, _) in sent() {
            app.done(id, 200, page(1, vec![top(1, 15)], false));
        }
        assert_eq!(days(&app), vec!["27", "15", "10"]);
    }

    #[test]
    fn a_first_page_of_only_replies_to_strangers_reads_on() {
        sent();
        let mut app = App::new();
        app.local = vec![Local { fid: 1, username: None }, Local { fid: 2, username: None }];
        app.load_feed("local".into(), false);
        let day = |d: u32| format!("2026-01-{d:02}T00:00:00Z");
        let page = |casts: Vec<serde_json::Value>, more: bool| serde_json::json!({"casts": casts, "next": {"cursor": if more { Some("next") } else { None }}}).to_string().into_bytes();
        let reply = |n: u32| serde_json::json!({"hash": format!("{:040x}", 100 + n), "timestamp": day(n), "author": {"fid": 1}, "parent_hash": "ab", "parent_author": {"fid": 999}});
        let top = |fid: u64, n: u32| serde_json::json!({"hash": format!("{:040x}", fid * 1000 + n as u64), "timestamp": day(n), "author": {"fid": fid}});
        for (id, what, _) in sent() {
            let one = what.split("fid=").nth(1).is_some_and(|r| r.starts_with("1&") || r == "1");
            app.done(id, 200, if one { page((20..=28).rev().map(reply).collect(), true) } else { page(vec![top(2, 10), top(2, 5)], true) });
        }
        // nothing could be shown yet, so account 1's next page is asked for at once
        let next = sent();
        assert_eq!(next.len(), 1, "{next:?}");
        assert!(app.feeds["local"].loading);
        app.done(next[0].0, 200, page(vec![top(1, 12)], false));
        let f = &app.feeds["local"];
        assert_eq!(f.items.iter().map(|c| c.timestamp[8..10].to_string()).collect::<Vec<_>>(), vec!["12", "10", "05"], "account 2 is the only one left, so all of it shows");
    }

    #[test]
    fn channels_by_parent_url() {
        let mut app = App::new();
        app.legacy.insert("https://onchainsummer.xyz".into(), "base".into());
        assert_eq!(app.channel_of(Some("https://warpcast.com/~/channel/memes")).as_deref(), Some("memes"));
        assert_eq!(app.channel_of(Some("https://farcaster.xyz/~/channel/wasm?x=1")).as_deref(), Some("wasm"));
        assert_eq!(app.channel_of(Some("https://onchainsummer.xyz")).as_deref(), Some("base"));
        assert_eq!(app.channel_of(Some("https://example.com")), None);
        assert_eq!(app.channel_url("memes"), "https://warpcast.com/~/channel/memes");
        app.channels.insert("base".into(), Load::Ready(Some(Channel { id: "base".into(), url: "https://onchainsummer.xyz".into(), ..Default::default() })));
        assert_eq!(app.channel_url("base"), "https://onchainsummer.xyz");
    }

    #[test]
    fn mutes_hide_casts_but_not_your_own_or_on_their_profile() {
        let mut app = App::new();
        app.account = Some(Account { fid: 9, key: "00".into(), ..Default::default() });
        let c = |fid: u64, t: &str| Cast { hash: "ab".into(), text: t.into(), author: User { fid, ..Default::default() }, ..Default::default() };
        app.mutes.set_fid(false, 5, true, None);
        app.mutes.set_fid(true, 6, true, None);
        app.mutes.set_word("rug", true, None);
        assert!(app.hidden(&c(5, "hi"), None));
        assert!(!app.hidden(&c(5, "hi"), Some(5)), "a muted person's own profile still shows them");
        assert!(app.hidden(&c(6, "hi"), Some(6)), "a blocked one's doesn't");
        assert!(app.hidden(&c(7, "a RUG pull"), None));
        assert!(!app.hidden(&c(9, "my rug"), None), "your own casts always show");
        assert!(!app.hidden(&c(7, "rugged"), None));
    }

    #[test]
    fn blocking_someone_followed_on_this_device_reloads_home() {
        sent();
        let mut app = App::new();
        app.route = Route::Home(false);
        app.local = vec![Local { fid: 1, username: None }, Local { fid: 2, username: None }];
        app.load_route();
        assert!(app.feeds.contains_key("local"));
        sent();
        app.mute(true, &User { fid: 1, ..Default::default() }, true, None);
        assert!(app.feeds.contains_key(&app.home_key(false)), "Home reads its feed again instead of spinning");
        assert!(sent().iter().any(|(_, w, _)| w.contains("fid=2")), "{:?}", app.local);
        // the last one: Home falls back to Trending, which is read too
        app.mute(true, &User { fid: 2, ..Default::default() }, true, None);
        assert_eq!(app.home_key(false), "trending");
        assert!(app.feeds.contains_key("trending"));
    }

    #[test]
    fn refreshing_a_profile_page_reads_its_feed_and_list_again() {
        let mut app = App::new();
        let u = User { fid: 4, username: Some("al".into()), ..Default::default() };
        app.profiles.insert("al".into(), Load::Ready(u));
        for (r, k) in [(Route::Browse("al".into()), "following:4"), (Route::User("al".into(), false), "casts:4")] {
            app.route = r;
            app.feeds.insert(k.into(), Default::default());
            app.refresh();
            assert!(!app.feeds.contains_key(k), "{k} is dropped");
            app.profiles.insert("al".into(), Load::Ready(User { fid: 4, username: Some("al".into()), ..Default::default() }));
        }
        app.route = Route::Follows("al".into(), "followers");
        app.lists.insert("followers:4".into(), Default::default());
        app.refresh();
        assert!(!app.lists.contains_key("followers:4"));
    }

    fn sent() -> Vec<(u32, String, Vec<u8>)> {
        host::SENT.with(|s| s.borrow_mut().drain(..).collect())
    }

    #[test]
    fn requests_to_our_server_are_signed_like_quilcast_com() {
        use ed25519_dalek::{Signature, SigningKey, Verifier};
        sent();
        let mut app = App::new();
        let seed = [7u8; 32];
        let k = SigningKey::from_bytes(&seed);
        app.raw_seeds = vec![seed];
        app.account = Some(Account { fid: 77, key: fc::hex(k.verifying_key().as_bytes()), raw: true, ..Default::default() });
        app.key_fetch("PUT", "/api/mutes/77".into(), "quilcast-mutes", r#"{"words":[]}"#.into(), "\nx-fid: 77", |_, _, _| {});
        let (_, what, body) = sent().pop().expect("a request");
        let lines: Vec<&str> = what.split('\n').collect();
        assert_eq!(lines[0], "PUT /api/mutes/77");
        assert_eq!(lines[1], "application/json");
        let h = |n: &str| lines.iter().find_map(|l| l.strip_prefix(&format!("{n}: "))).expect(n).to_string();
        assert_eq!(lines.len(), 6, "{lines:?}");
        assert_eq!(h("x-key"), format!("0x{}", fc::hex(k.verifying_key().as_bytes())));
        assert_eq!(h("x-fid"), "77");
        let ts = h("x-ts");
        let sig = Signature::from_slice(&fc::unhex(&h("x-sig"))).unwrap();
        let msg = format!("quilcast-mutes:77:{ts}:{}", String::from_utf8(body).unwrap());
        assert!(k.verifying_key().verify(msg.as_bytes(), &sig).is_ok(), "signed over <what>:<fid>:<ts>:<body>");
        // a GET has no content type and signs an empty body
        app.key_fetch("GET", "/api/mutes/77".into(), "quilcast-mutes-read", String::new(), "", |_, _, _| {});
        let (_, what, _) = sent().pop().unwrap();
        assert!(what.starts_with("GET /api/mutes/77\n\nx-key: 0x"), "{what}");
        // without a key here, it says so rather than sending anything
        app.raw_seeds.clear();
        app.account = None;
        let got = Rc::new(RefCell::new(0));
        let g = got.clone();
        app.key_fetch("GET", "/x".into(), "w", String::new(), "", move |_, s, _| *g.borrow_mut() = s);
        assert_eq!(*got.borrow(), SIGN_FAILED);
        assert!(sent().is_empty());
    }

    /// An app signed in as FID 77 with a raw key, so signing happens at once (no WebCrypto here).
    fn with_posts(texts: &[&str]) -> Compose {
        let mut c = Compose::new(1);
        c.posts = texts.iter().enumerate().map(|(i, t)| crate::compose::Post { id: i as u32, text: t.to_string(), ..Default::default() }).collect();
        c
    }

    fn signed_in() -> (App, ed25519_dalek::SigningKey) {
        sent();
        let mut app = App::new();
        let seed = [9u8; 32];
        let k = ed25519_dalek::SigningKey::from_bytes(&seed);
        app.raw_seeds = vec![seed];
        app.account = Some(Account { fid: 77, key: fc::hex(k.verifying_key().as_bytes()), raw: true, ..Default::default() });
        (app, k)
    }
    fn answer(app: &mut App, id: u32, status: i32, body: &str) {
        app.done(id, status, body.as_bytes().to_vec());
    }

    #[test]
    fn scheduling_signs_each_post_for_its_time() {
        use crate::compose::{b64, unb64};
        use ed25519_dalek::Signer;
        let (mut app, k) = signed_in();
        let at = host::ms() + 3_600_000.0 + 400.0;
        let mut c = with_posts(&["later", "two"]);
        c.when = at.to_string();
        app.compose = Some(c);
        app.send_compose();
        // the list is read first, so a key the node doesn't list yet is waited for
        let (id, what, _) = sent().pop().expect("a read");
        assert!(what.starts_with("GET /api/scheduled/77\n"), "{what}");
        answer(&mut app, id, 200, "[]");
        let (id, what, body) = sent().pop().expect("the item");
        assert!(what.starts_with("PUT /api/scheduled/77\napplication/json\nx-key: "), "{what}");
        let j: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(j["id"].as_str().unwrap().len(), 36);
        assert_eq!(j["draft"]["parts"][1]["text"], "two");
        let msgs: Vec<Vec<u8>> = j["msgs"].as_array().unwrap().iter().map(|m| unb64(m.as_str().unwrap()).unwrap()).collect();
        // the same bytes as signing them here by hand: on the second, the time asked for; the reply a second later
        let start = (at / 1000.0).floor() * 1000.0;
        let one = fc::prepare(fc::mt::CAST_ADD, 77, fc::fc_time(start), &fc::cast_body("later", &[], &[], &[], &fc::Parent::None));
        assert_eq!(msgs[0], fc::seal(&one, &k.sign(&one.hash).to_bytes(), k.verifying_key().as_bytes()));
        let parent = fc::Parent::Cast(fc::CastRef { fid: 77, hash: fc::hex(&one.hash) });
        let two = fc::prepare(fc::mt::CAST_ADD, 77, fc::fc_time(start + 1000.0), &fc::cast_body("two", &[], &[], &[], &parent));
        assert_eq!(msgs[1], fc::seal(&two, &k.sign(&two.hash).to_bytes(), k.verifying_key().as_bytes()));
        assert_eq!(b64(&msgs[0]), j["msgs"][0].as_str().unwrap());
        answer(&mut app, id, 200, "{}");
        assert!(app.compose.is_none());
        assert!(app.toast.as_deref().unwrap_or("").starts_with("Scheduled for"));
        // too soon is turned down before anything is signed
        let mut c = with_posts(&["now-ish"]);
        c.when = (host::ms() + 1000.0).to_string();
        app.compose = Some(c);
        app.send_compose();
        assert!(sent().is_empty());
        assert_eq!(app.compose.as_ref().unwrap().error.as_deref(), Some("Pick a time at least a minute from now."));
    }

    #[test]
    fn uploads_go_in_signed_pieces_and_end_up_as_embeds() {
        let (mut app, k) = signed_in();
        app.open_compose(None, None);
        sent();
        app.attach(r#"[{"id":5,"type":"image/gif","size":2500000,"name":"a.gif"}]"#);
        let (id, what, _) = sent().pop().expect("the start");
        let lines: Vec<&str> = what.split('\n').collect();
        assert_eq!(lines[0], "POST /api/upload");
        assert!(lines.contains(&"content-type: image/gif") && lines.contains(&"x-fid: 77") && lines.contains(&"x-size: 2500000"), "{lines:?}");
        let ts = lines.iter().find_map(|l| l.strip_prefix("x-ts: ")).unwrap();
        let sig = lines.iter().find_map(|l| l.strip_prefix("x-sig: ")).unwrap();
        use ed25519_dalek::Verifier;
        let sig = ed25519_dalek::Signature::from_slice(&fc::unhex(sig)).unwrap();
        assert!(k.verifying_key().verify(format!("quilcast-upload:77:{ts}:").as_bytes(), &sig).is_ok());
        answer(&mut app, id, 200, r#"{"id":"0b6c2c7e-7b1a-4c39-9a51-1e7c8f1b2c3d","chunk":8388608}"#);
        assert!(!App::can_send(app.compose.as_ref().unwrap()), "not while it's uploading");
        // pieces of 1 MiB, each read from the file when it's its turn
        let mut off = 0usize;
        while off < 2_500_000 {
            let read = app.next_id;
            let n = (2_500_000 - off).min(1 << 20);
            app.done(read, 1, vec![1; n]);
            let (id, what, body) = sent().pop().expect("a piece");
            assert_eq!(what, format!("PUT /api/upload/0b6c2c7e-7b1a-4c39-9a51-1e7c8f1b2c3d?offset={off}\napplication/octet-stream"));
            assert_eq!(body.len(), n);
            off += n;
            answer(&mut app, id, 200, &format!(r#"{{"received":{off}}}"#));
        }
        let (id, what, _) = sent().pop().expect("done");
        assert_eq!(what, "POST /api/upload/0b6c2c7e-7b1a-4c39-9a51-1e7c8f1b2c3d/done");
        answer(&mut app, id, 200, r#"{"state":"sending"}"#);
        let timer = app.next_id;
        app.done(timer, 1, vec![]);
        let (id, what, _) = sent().pop().expect("a poll");
        assert_eq!(what, "GET /api/upload/0b6c2c7e-7b1a-4c39-9a51-1e7c8f1b2c3d");
        answer(&mut app, id, 200, r#"{"state":"ready","url":"https://quilcast.com/m/0123456789abcdef01234567.gif"}"#);
        let c = app.compose.as_mut().unwrap();
        assert_eq!(c.posts[0].media[0].url.as_deref(), Some("https://quilcast.com/m/0123456789abcdef01234567.gif"));
        c.posts[0].text = "look".into();
        app.send_compose();
        let (submit, what, msg) = sent().pop().expect("the cast");
        assert!(what.ends_with("/v1/submitMessage\napplication/octet-stream"), "{what}");
        let body = fc::cast_body("look", &[], &[], &[fc::Embed::Url("https://quilcast.com/m/0123456789abcdef01234567.gif".into())], &fc::Parent::None);
        assert!(msg.windows(body.len()).any(|w| w == body), "the upload is the cast's embed");
        // the file stays while the composer shows it, and goes once it's out
        assert!(!host::DROPPED.with(|d| d.borrow().contains(&5)));
        answer(&mut app, submit, 200, "{}");
        assert!(host::DROPPED.with(|d| d.borrow().contains(&5)), "the sent file is let go");
        assert!(app.compose.is_none());
        // a fifth file doesn't fit beside four
        app.compose = Some(Compose::new(1));
        app.attach_seq = 0;
        app.attach(r#"[{"id":6,"type":"image/gif","size":10},{"id":7,"type":"image/gif","size":10},{"id":8,"type":"image/gif","size":10},{"id":12,"type":"image/gif","size":10},{"id":13,"type":"image/gif","size":10}]"#);
        assert_eq!(app.compose.as_ref().unwrap().posts[0].media.len(), 4);
        assert!(host::DROPPED.with(|d| d.borrow().contains(&13)), "the one turned away is let go");
        app.attach(r#"[{"id":9,"type":"application/pdf","size":10}]"#);
        assert_eq!(app.compose.as_ref().unwrap().posts[0].media.len(), 4);
    }

    #[test]
    fn drafts_are_sealed_before_they_leave_and_opened_when_read() {
        use crate::compose::Draft;
        let (mut app, _) = signed_in();
        app.drafts_key = Some(true);
        app.open_compose(None, None);
        app.compose.as_mut().unwrap().posts[0].text = "keep me".into();
        // closing something new asks whether to keep it
        app.close_compose();
        assert!(app.compose.as_ref().unwrap().asking);
        sent();
        app.save_draft();
        // the shell seals it (IV, then ciphertext) with the key it holds
        let seal = app.next_id;
        app.done(seal, 1, (0..40).collect());
        let (id, what, body) = sent().pop().expect("the draft");
        assert!(what.starts_with("PUT /api/drafts/77\napplication/json\nx-key: "), "{what}");
        let j: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(j["box"], crate::compose::draft_box(&(0..40).collect::<Vec<u8>>()));
        let did = j["id"].as_str().unwrap().to_string();
        answer(&mut app, id, 200, "{}");
        assert!(app.compose.is_none());
        assert_eq!(app.toast.as_deref(), Some("Draft saved"));
        // read back: each box is opened in the shell
        app.load_drafts();
        let (id, what, _) = sent().pop().expect("the list");
        assert!(what.starts_with("GET /api/drafts/77\n"), "{what}");
        answer(&mut app, id, 200, &format!(r#"[{{"id":"{did}","box":"{}"}}]"#, crate::compose::draft_box(&[5; 30])));
        let open = app.next_id;
        app.done(open, 1, br#"{"at":5,"parts":[{"text":"keep me","media":[]}],"channel":"memes"}"#.to_vec());
        let l = match &app.drafts {
            Some(Load::Ready(l)) => l.clone(),
            _ => panic!("drafts"),
        };
        assert_eq!(l, vec![Draft { id: did.clone(), at: 5, parts: vec![crate::compose::Part { text: "keep me".into(), media: vec![] }], channel: Some("memes".into()), ..Default::default() }]);
        // opened again it's the same draft, and posting it deletes it
        app.open_compose(None, None);
        let d = l[0].clone();
        app.open_draft(&d, None);
        let c = app.compose.as_ref().unwrap();
        assert_eq!((c.posts[0].text.as_str(), c.channel.as_deref(), c.draft.as_deref()), ("keep me", Some("memes"), Some(did.as_str())));
    }

    #[test]
    fn a_send_landing_after_the_composer_changed_leaves_the_new_one_alone() {
        use crate::compose::Draft;
        let (mut app, _) = signed_in();
        app.open_compose(None, None);
        app.compose.as_mut().unwrap().posts[0].text = "first".into();
        sent();
        app.send_compose();
        let (id, what, _) = sent().pop().expect("the cast");
        assert!(what.contains("/v1/submitMessage"), "{what}");
        // nothing else opens while it's on its way
        let d = Draft { id: "d1".into(), parts: vec![crate::compose::Part { text: "mine".into(), media: vec![] }], ..Default::default() };
        app.open_draft(&d, None);
        app.open_compose(None, None);
        assert_eq!(app.compose.as_ref().unwrap().posts[0].text, "first");
        // and if another composer is there anyway when it lands, that one keeps its draft and its text
        let mut c = with_posts(&["mine"]);
        c.gen = 99;
        c.draft = Some("d1".into());
        app.compose = Some(c);
        answer(&mut app, id, 200, "{}");
        let c = app.compose.as_ref().expect("still open");
        assert_eq!((c.posts[0].text.as_str(), c.draft.as_deref()), ("mine", Some("d1")));
        assert!(sent().iter().all(|(_, w, _)| !w.starts_with("PUT /api/drafts")), "the draft isn't deleted");
    }

    #[test]
    fn reopened_threads_skip_empty_posts_and_lost_parents_stay_lost() {
        use crate::compose::{Draft, Part};
        let (mut app, _) = signed_in();
        app.open_compose(None, None);
        let p = |t: &str| Part { text: t.into(), media: vec![] };
        let d = Draft { id: "d2".into(), parts: vec![p("A"), p(" "), p("B"), p("C")], parent: Some(format!("0x{}", "cd".repeat(20))), pfid: Some(0), ..Default::default() };
        app.open_draft(&d, None);
        let c = app.compose.as_ref().unwrap();
        assert_eq!(App::parts(c), vec![p("A"), p("B"), p("C")], "indexes line up with what's sent");
        assert_eq!(c.posts.len(), 3);
        assert!(c.parent_lost, "an author of 0 is no author");
        assert!(!App::can_send(c));
        assert_eq!(app.draft_of(c).pfid, None);
    }

    #[test]
    fn a_thread_is_written_post_by_post_and_goes_out_as_replies() {
        let (mut app, _) = signed_in();
        app.open_compose(None, None);
        sent();
        // nothing to add a post after yet
        app.add_post();
        assert_eq!(app.compose.as_ref().unwrap().posts.len(), 1);
        app.type_post(0, "3|one");
        app.add_post();
        app.type_post(1, "3|two");
        // an empty post on the end is left out, and Backspace-style removal takes one out with its files
        app.add_post();
        app.add_post();
        assert_eq!(app.compose.as_ref().unwrap().posts.len(), 3, "not after an empty one");
        app.compose.as_mut().unwrap().at = 2;
        app.attach(r#"[{"id":21,"type":"image/gif","size":10}]"#);
        app.remove_post(2);
        assert!(host::DROPPED.with(|d| d.borrow().contains(&21)), "its file is let go");
        app.add_post();
        let c = app.compose.as_ref().unwrap();
        assert_eq!((c.posts.len(), c.at), (3, 2));
        assert_eq!(App::parts(c).iter().map(|p| p.text.as_str()).collect::<Vec<_>>(), vec!["one", "two"]);
        sent();
        app.send_compose();
        let (id, _, msg) = sent().pop().expect("the first post");
        let one = fc::cast_body("one", &[], &[], &[], &fc::Parent::None);
        assert!(msg.windows(one.len()).any(|w| w == one));
        answer(&mut app, id, 200, "{}");
        let first = app.compose.as_ref().unwrap().posted.clone().expect("the first went out");
        let (id, _, msg) = sent().pop().expect("the second post");
        let two = fc::cast_body("two", &[], &[], &[], &fc::Parent::Cast(first));
        assert!(msg.windows(two.len()).any(|w| w == two), "a reply to the first");
        answer(&mut app, id, 200, "{}");
        assert!(app.compose.is_none());
        assert_eq!(app.toast.as_deref(), Some("Thread posted"));
    }

    #[test]
    fn a_thread_that_stops_halfway_goes_on_from_the_post_that_failed() {
        let (mut app, _) = signed_in();
        app.compose = Some(with_posts(&["one", "", "two", "three"]));
        sent();
        app.send_compose();
        let (id, _, _) = sent().pop().expect("the first post");
        answer(&mut app, id, 200, "{}");
        let first = app.compose.as_ref().unwrap().posted.clone().unwrap();
        let (id, _, _) = sent().pop().expect("the second post");
        answer(&mut app, id, 400, r#"{"errCode":"bad_request","message":"nope"}"#);
        let c = app.compose.as_ref().unwrap();
        assert!(c.error.is_some() && !c.sending);
        assert_eq!(c.posts.iter().map(|p| p.text.as_str()).collect::<Vec<_>>(), vec!["two", "three"], "only what didn't go out is left");
        app.send_compose();
        let (_, _, msg) = sent().pop().expect("tried again");
        let two = fc::cast_body("two", &[], &[], &[], &fc::Parent::Cast(first));
        assert!(msg.windows(two.len()).any(|w| w == two), "still a reply to the one that went out");
    }

    #[test]
    fn emoji_go_where_the_caret_was() {
        let (mut app, _) = signed_in();
        app.open_compose(None, None);
        // the caret comes in UTF-16 units: after "😀 a" is 4
        app.type_post(0, "4|😀 ab");
        app.open_emoji();
        app.insert_emoji("👍");
        let c = app.compose.as_ref().unwrap();
        assert_eq!(c.posts[0].text, "😀 a👍b");
        assert!(c.panel.is_none());
        assert_eq!(crate::compose::utf16_at(&c.posts[0].text, c.posts[0].caret), 6, "the caret goes after it");
    }

    #[test]
    fn stickers_come_from_the_accounts_packs_and_go_out_as_pictures() {
        let (mut app, _) = signed_in();
        app.open_compose(None, None);
        sent();
        app.open_stickers();
        let (id, what, _) = sent().pop().expect("the packs");
        assert!(what.starts_with("GET /api/stickers/77"), "{what}");
        let h = "0123456789abcdef01234567";
        answer(&mut app, id, 200, &format!(r#"[{{"id":"Pack_1-x","fid":77,"title":"Mine","stickers":[{{"h":"{h}","e":"🙂"}},{{"h":"../x","e":""}}]}},{{"id":"emptyyyy","fid":77,"title":"Empty","stickers":[]}}]"#));
        let packs = match &app.stickers {
            Some(Load::Ready(l)) => l.clone(),
            _ => panic!("packs"),
        };
        assert_eq!(packs.len(), 1, "an empty pack gets no tab");
        assert_eq!(packs[0].stickers.len(), 1, "only stickers an address can hold");
        app.pick_sticker("Pack_1-x", h);
        let c = app.compose.as_ref().unwrap();
        let url = format!("https://quilcast.com/st/Pack_1-x/{h}.webp");
        assert_eq!(c.posts[0].media[0].url.as_deref(), Some(url.as_str()));
        assert_eq!(crate::compose::sticker_pack(&url), Some("Pack_1-x"));
        assert_eq!(crate::compose::sticker_pack("https://quilcast.com/st/Pack_1-x/zz.webp"), None);
        assert_eq!(crate::compose::sticker_pack("https://evil.com/st/Pack_1-x/0123456789abcdef01234567.webp"), None);
    }

    #[test]
    fn spam_is_labelled_or_hidden_from_the_threshold() {
        let mut app = App::new();
        sent();
        let spammy = Cast { hash: format!("0x{}", "aa".repeat(20)), author: User { fid: 5, ..Default::default() }, ..Default::default() };
        let fine = Cast { hash: format!("0x{}", "bb".repeat(20)), author: User { fid: 6, ..Default::default() }, ..Default::default() };
        // shown (the default): nothing is held back while the scores are asked for
        assert!(!app.hidden(&spammy, None));
        // drawing its label asks for its score and its author's
        assert_eq!(app.spam_of(&spammy), None);
        let wants: Vec<Want> = app.wants.borrow_mut().drain(..).collect();
        assert!(wants.iter().any(|w| matches!(w, Want::Spam(h) if *h == "aa".repeat(20))));
        assert!(wants.iter().any(|w| matches!(w, Want::SpamAccount(5))));
        app.ask_spam(vec!["aa".repeat(20), "bb".repeat(20), "aa".repeat(20)], vec![5, 6]);
        let reqs = sent();
        let urls: Vec<&str> = reqs.iter().map(|(_, w, _)| w.as_str()).collect();
        assert!(urls.iter().any(|u| u.starts_with(&format!("GET https://spam.quilcast.com/scores?h=0x{},0x{}", "aa".repeat(20), "bb".repeat(20)))), "{urls:?}");
        assert!(urls.iter().any(|u| u.starts_with("GET https://spam.quilcast.com/users?fid=5,6")), "{urls:?}");
        // asked once: drawing again doesn't ask again
        app.ask_spam(vec!["aa".repeat(20)], vec![5]);
        assert!(sent().is_empty());
        for (id, w, _) in reqs {
            let body = if w.contains("scores") { format!(r#"{{"0x{}":0.97,"0x{}":0.2}}"#, "aa".repeat(20), "bb".repeat(20)) } else { r#"{"5":0.1,"6":0.75}"#.to_string() };
            answer(&mut app, id, 200, &body);
        }
        assert_eq!(app.spam_of(&spammy), Some(97));
        assert_eq!(app.spam_of(&fine), None);
        assert_eq!(app.spam_account_of(6), Some(75));
        assert!(!app.hidden(&spammy, None), "labelled, not hidden");
        app.settings.spam = "hide".into();
        assert!(app.hidden(&spammy, None) && !app.hidden(&fine, None));
        app.settings.spam_accounts = "hide".into();
        assert!(app.hidden(&fine, None), "a spam account's casts go too");
        assert!(!app.hidden(&fine, Some(6)), "but not on its own profile");
        app.settings.spam_at = 99;
        assert!(!app.hidden(&spammy, None) && !app.hidden(&fine, None), "under the threshold");
        // with Hide on, a cast whose score hasn't come is held back for a moment, not shown then taken away
        let new = Cast { hash: format!("0x{}", "cc".repeat(20)), author: User { fid: 5, ..Default::default() }, ..Default::default() };
        assert!(app.hidden(&new, None));
        app.ask_spam(vec!["cc".repeat(20)], vec![]);
        let (id, _, _) = sent().pop().expect("asked");
        assert!(app.hidden(&new, None), "while its score is on its way");
        // the service answers null for one it hasn't scored: shown at once, not after the wait
        answer(&mut app, id, 200, &format!(r#"{{"0x{}":null}}"#, "cc".repeat(20)));
        assert!(!app.hidden(&new, None));
    }

    #[test]
    fn a_draft_with_four_pictures_and_a_quote_keeps_the_quote() {
        use crate::compose::{Draft, Part};
        let (mut app, _) = signed_in();
        app.open_compose(None, None);
        let media: Vec<String> = (0..4).map(|i| format!("https://quilcast.com/m/{i}.jpg")).collect();
        let d = Draft { id: "d3".into(), parts: vec![Part { text: "q".into(), media }], quote: Some(format!("0x{}", "ef".repeat(20))), ..Default::default() };
        app.open_draft(&d, None);
        let c = app.compose.as_ref().unwrap();
        assert_eq!(c.posts[0].media.len(), 3, "the quote takes one of the four");
        assert_eq!(c.room(0), 0);
        assert!(c.quote_wait.is_some());
    }

    #[test]
    fn an_upload_poll_that_doesnt_get_through_is_asked_again() {
        let (mut app, _) = signed_in();
        app.open_compose(None, None);
        app.attach(r#"[{"id":31,"type":"image/gif","size":10}]"#);
        let (id, _, _) = sent().pop().expect("the upload starts");
        answer(&mut app, id, 200, r#"{"id":"0b6c2c7e-7b1a-4c39-9a51-1e7c8f1b2c3d","chunk":1048576}"#);
        let read = app.next_id;
        app.done(read, 1, vec![0; 10]);
        let (id, _, _) = sent().pop().expect("the piece");
        answer(&mut app, id, 200, r#"{"received":10}"#);
        let (id, what, _) = sent().pop().expect("done");
        assert!(what.starts_with("POST /api/upload/0b6c2c7e-7b1a-4c39-9a51-1e7c8f1b2c3d/done"), "{what}");
        answer(&mut app, id, 502, "bad gateway");
        assert!(matches!(app.compose.as_ref().unwrap().posts[0].media[0].step, crate::compose::Step::Processing), "not failed");
        let timer = app.next_id;
        app.done(timer, 1, vec![]);
        let (id, what, _) = sent().pop().expect("asked again");
        assert!(what.starts_with("GET /api/upload/0b6c2c7e"), "{what}");
        answer(&mut app, id, 200, r#"{"state":"ready","url":"https://quilcast.com/m/0123456789abcdef01234567.gif"}"#);
        assert_eq!(app.compose.as_ref().unwrap().posts[0].media[0].step, crate::compose::Step::Ready);
    }

    #[test]
    fn signing_out_waits_for_a_cast_on_its_way() {
        let (mut app, _) = signed_in();
        app.compose = Some(with_posts(&["one", "two"]));
        app.send_compose();
        sent();
        app.sign_out();
        assert!(sent().is_empty() && app.account.is_some());
        assert_eq!(app.toast.as_deref(), Some("Wait for the cast to finish sending."));
    }

    #[test]
    fn a_photo_shows_the_picture_that_goes_out() {
        let (mut app, _) = signed_in();
        app.open_compose(None, None);
        app.attach(r#"[{"id":3,"type":"image/jpeg","size":5000,"name":"p.jpg"}]"#);
        assert_eq!(app.compose.as_ref().unwrap().posts[0].media[0].preview.as_deref(), Some("blob:test/3"));
        let shrink = app.next_id;
        app.done(shrink, 1, br#"{"id":4,"type":"image/jpeg","size":4000}"#.to_vec());
        let a = &app.compose.as_ref().unwrap().posts[0].media[0];
        assert_eq!((a.preview.as_deref(), a.file), (Some("blob:test/4"), Some(4)));
        assert!(host::DROPPED.with(|d| d.borrow().contains(&3)), "the original is let go");
        // one the browser can't read keeps its tile and thumbnail until it's taken off
        app.attach(r#"[{"id":11,"type":"image/png","size":5000,"name":"bad.png"}]"#);
        let shrink = app.next_id;
        app.done(shrink, 0, vec![]);
        let a = &app.compose.as_ref().unwrap().posts[0].media[1];
        assert!(matches!(a.step, crate::compose::Step::Failed(_)));
        assert_eq!(a.preview.as_deref(), Some("blob:test/11"));
        assert!(!host::DROPPED.with(|d| d.borrow().contains(&11)));
        let n = a.n;
        app.unattach(n);
        assert!(host::DROPPED.with(|d| d.borrow().contains(&11)));
        assert_eq!(app.compose.as_ref().unwrap().posts[0].media.len(), 1);
    }

    #[test]
    fn pins_are_signed_and_shown_at_once() {
        let (mut app, _) = signed_in();
        let h = "ab".repeat(20);
        app.set_pin(Some(h.clone()));
        let (id, what, body) = sent().pop().expect("the pin");
        assert!(what.starts_with("PUT /api/pin/77\napplication/json\nx-key: "), "{what}");
        assert_eq!(String::from_utf8(body).unwrap(), format!(r#"{{"hash":"0x{h}"}}"#));
        answer(&mut app, id, 200, "{}");
        assert_eq!(app.pinned(77), Some(h.as_str()));
        app.set_pin(None);
        let (id, _, body) = sent().pop().unwrap();
        assert_eq!(body, b"null");
        answer(&mut app, id, 200, "null");
        assert_eq!(app.pinned(77), None);
    }

    #[test]
    fn mentions_are_suggested_and_picked() {
        let (mut app, _) = signed_in();
        app.open_compose(None, None);
        sent();
        app.type_post(0, "6|hi @al");
        let timer = app.next_id;
        app.done(timer, 1, vec![]);
        let (id, what, _) = sent().pop().expect("a search");
        assert!(what.contains("/v2/farcaster/user/search?") && what.contains("q=al"), "{what}");
        answer(&mut app, id, 200, r#"{"result":{"users":[{"fid":5,"username":"alice"}]}}"#);
        assert_eq!(app.compose.as_ref().unwrap().suggest.len(), 1);
        app.pick_mention("alice");
        assert_eq!(app.compose.as_ref().unwrap().posts[0].text, "hi @alice ");
        assert_eq!(app.compose.as_ref().unwrap().posts[0].caret, "hi @alice ".len(), "the caret goes after the name");
        assert!(app.compose.as_ref().unwrap().suggest.is_empty());
    }

    #[test]
    fn a_channel_the_server_couldnt_look_up_isnt_guessed() {
        sent();
        let mut app = App::new();
        app.load_channel("memes".into());
        let (id, _, _) = sent().pop().unwrap();
        app.done(id, 502, b"{}".to_vec());
        assert!(matches!(app.channels.get("memes"), Some(Load::Failed(_))));
        app.load_channel("nope".into());
        let (id, _, _) = sent().pop().unwrap();
        app.done(id, 404, b"null".to_vec());
        assert!(matches!(app.channels.get("nope"), Some(Load::Ready(None))));
        // an old-style channel's URL comes from the legacy map when the directory didn't say
        app.legacy.insert("chain://eip155:1/erc721:0xfd84".into(), "memes".into());
        assert_eq!(app.channel_url("memes"), "chain://eip155:1/erc721:0xfd84");
    }

    #[test]
    fn the_device_feed_reads_a_few_at_a_time_and_keeps_replies_to_people_followed() {
        sent();
        let mut app = App::new();
        app.local = (1..=10).map(|fid| Local { fid, username: None }).collect();
        app.load_feed("local".into(), false);
        let first = sent();
        assert_eq!(first.len(), LOCAL_AT_ONCE, "no more than {LOCAL_AT_ONCE} at once");
        let page = |fid: u64| {
            let mut casts = vec![serde_json::json!({"hash": format!("{fid:040x}"), "timestamp": format!("2026-01-{:02}T00:00:00Z", fid), "author": {"fid": fid}})];
            // a reply to someone followed here, and one to a stranger
            casts.push(serde_json::json!({"hash": format!("{:040x}", fid + 100), "timestamp": "2025-01-01T00:00:00Z", "author": {"fid": fid}, "parent_hash": "ab", "parent_author": {"fid": 2}}));
            casts.push(serde_json::json!({"hash": format!("{:040x}", fid + 200), "timestamp": "2025-01-01T00:00:00Z", "author": {"fid": fid}, "parent_hash": "ab", "parent_author": {"fid": 999}}));
            serde_json::json!({"casts": casts, "next": {"cursor": null}}).to_string().into_bytes()
        };
        let fid_of = |what: &str| what.split("fid=").nth(1).unwrap().split('&').next().unwrap().parse::<u64>().unwrap();
        let mut queue: Vec<(u32, String)> = first.into_iter().map(|(id, w, _)| (id, w)).collect();
        while let Some((id, w)) = queue.pop() {
            app.done(id, 200, page(fid_of(&w)));
            queue.extend(sent().into_iter().map(|(id, w, _)| (id, w)));
        }
        let f = &app.feeds["local"];
        assert!(f.done);
        assert_eq!(f.items.len(), 20, "each account's cast and its reply to someone followed, not the one to a stranger");
        assert_eq!(f.items[0].author.fid, 10, "newest first");
        assert!(f.items.iter().all(|c| c.parent_author.fid != Some(999)));
    }

    #[test]
    fn browse_paths() {
        assert_eq!(App::browse_path(&User { fid: 3, username: Some("DWR.eth".into()), ..Default::default() }), "/?as=dwr.eth");
        assert_eq!(App::browse_path(&User { fid: 3, username: Some("123".into()), ..Default::default() }), "/?as=3");
        assert_eq!(App::browse_path(&User { fid: 3, ..Default::default() }), "/?as=3");
    }

    #[test]
    fn iso_now_reads_back() {
        let s = iso_now();
        assert_eq!(text::parse_time(&s), Some((host::ms() / 1000.0).floor() * 1000.0), "{s}");
    }

    fn cast(likes: u64, liked: Option<bool>) -> Cast {
        Cast { hash: "ab".into(), reactions: Reactions { likes_count: likes, recasts_count: 0 }, viewer_context: liked.map(|l| CastViewer { liked: Some(l), recasted: None }), ..Default::default() }
    }

    #[test]
    fn taps_win_until_the_count_catches_up() {
        let mut app = App::new();
        let c = cast(5, Some(false));
        assert_eq!(app.tapped(1, &c), (false, 5));
        app.taps.insert("1ab".into(), (true, 5));
        assert_eq!(app.tapped(1, &c), (true, 6), "the tap shows before the node counts it");
        assert_eq!(app.tapped(1, &cast(6, Some(true))), (true, 6), "a count that moved has the tap in it");
    }

    #[test]
    fn signed_out_writes_go_nowhere() {
        let mut app = App::new();
        let hit = Rc::new(RefCell::new(None));
        let h = hit.clone();
        app.send(fc::mt::CAST_ADD, vec![], move |_, r| *h.borrow_mut() = Some(r));
        assert!(matches!(hit.borrow().as_ref(), Some(Err(_))));
    }

    #[test]
    fn feed_urls_ask_as_the_viewer() {
        let mut app = App::new();
        assert!(app.feed_url("trending", "").starts_with("https://haatz.quilibrium.com/v2/farcaster/feed/trending?limit=50"));
        app.account = Some(Account { fid: 7, key: "00".into(), ..Default::default() });
        let u = app.feed_url("following:7", "abc");
        assert_eq!(u, "https://haatz.quilibrium.com/v2/farcaster/feed/following?viewer_fid=7&fid=7&limit=50&cursor=abc&with_recasts=true");
    }
}
