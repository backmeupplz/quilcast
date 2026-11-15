//! The app's state and everything that changes it: routes, loading from the node, signing in, and writes.
//! Views (view.rs) only read it. Every change comes from an event, a finished request or a timer (lib.rs), after
//! which the page is drawn again.

use crate::api::*;
use crate::dom::Dom;
use crate::{fc, host, text};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
const ACCOUNT_KEY: &str = "quilcast-wasm:account";
const SETTINGS_KEY: &str = "quilcast-wasm:settings";
pub const DEFAULT_NODE: &str = "https://haatz.quilibrium.com";
pub const OPTIMISM_RPC: &str = "https://mainnet.optimism.io";
/// Bytes a cast may hold (over 320 it's sent as a long cast).
pub const MAX_CAST: usize = 1024;

#[derive(Clone, PartialEq, Debug)]
pub enum Route {
    /// Home: the Following feed, or Trending (`true`)
    Home(bool),
    Cast(String),
    /// A profile by name or FID, its replies tab when `true`
    User(String, bool),
    Notifications,
    /// Search: the query, and the Casts tab when `true`
    Search(String, bool),
    Join,
    Settings,
    NotFound,
}

pub fn parse_route(path_q: &str) -> Route {
    let (path, q) = path_q.split_once('?').unwrap_or((path_q, ""));
    let path = path.split('#').next().unwrap_or("");
    let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    match parts.as_slice() {
        [] => Route::Home(text::param(q, "feed").as_deref() == Some("trending")),
        ["c", h] if fc::is_hash(h) => Route::Cast(h.trim_start_matches("0x").to_lowercase()),
        ["u", id] => Route::User(text::decode(id), false),
        ["u", id, "replies"] => Route::User(text::decode(id), true),
        ["notifications"] => Route::Notifications,
        ["search"] => Route::Search(text::param(q, "q").unwrap_or_default(), text::param(q, "tab").as_deref() == Some("casts")),
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
}
impl Default for Settings {
    fn default() -> Self {
        Settings { node: DEFAULT_NODE.into(), theme: "system".into() }
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
    pub text: String,
    pub parent: Option<Cast>,
    pub quote: Option<Cast>,
    pub sending: bool,
    pub error: Option<String>,
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
}

type Done = Box<dyn FnOnce(&mut App, i32, Vec<u8>)>;

pub struct App {
    pub dom: Dom,
    pub path: String,
    pub route: Route,
    pub settings: Settings,
    pub account: Option<Account>,
    raw_seed: Option<[u8; 32]>,
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
    pub join: Join,
    pub search_text: String,
    pub node_text: String,
    pub toast: Option<String>,
    toast_gen: u32,
    pub wants: RefCell<Vec<Want>>,
    pub busy: HashSet<String>,
    pending: HashMap<u32, Done>,
    next_id: u32,
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
        let path = host::here();
        App {
            dom: Dom::default(),
            route: parse_route(&path),
            path,
            node_text: settings.node.clone(),
            settings,
            account,
            raw_seed: None,
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
            join: Join::default(),
            search_text: String::new(),
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
        if let Some(a) = self.account.clone() {
            if a.raw {
                // the raw key comes out of the vault; without it the account can read but not write
                let key = format!("raw:{}", a.key);
                let id = self.wait(move |app, code, bytes| {
                    if code == 1 && bytes.len() == 32 {
                        app.raw_seed = bytes.try_into().ok();
                    }
                });
                host::vget(id, &key);
            }
            self.load_mine();
        }
        if let Route::Search(q, _) = &self.route {
            self.search_text = q.clone();
        }
        self.load_route();
    }

    pub fn me(&self) -> Option<u64> {
        self.account.as_ref().map(|a| a.fid)
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
        for w in wants {
            match w {
                Want::Unfurl(u) => self.load_unfurl(u),
                Want::Quote(h) => self.load_quote(h),
            }
        }
        host::set_title(&crate::view::title(self));
    }

    // --- async plumbing: every request, key operation and timer answers through `done` ---

    fn wait(&mut self, f: impl FnOnce(&mut App, i32, Vec<u8>) + 'static) -> u32 {
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

    pub fn home_key(&self, trending: bool) -> String {
        match (trending, self.me()) {
            (false, Some(fid)) => format!("following:{fid}"),
            _ => "trending".into(),
        }
    }

    pub fn load_route(&mut self) {
        match self.route.clone() {
            Route::Home(t) => {
                let k = self.home_key(t);
                if !self.feeds.contains_key(&k) {
                    self.load_feed(k, false);
                }
            }
            Route::Cast(h) => {
                if !matches!(self.threads.get(&h), Some(Load::Ready(_)) | Some(Load::Loading)) {
                    self.load_thread(h);
                }
            }
            Route::User(id, replies) => self.load_profile(id, replies),
            Route::Notifications => {
                if self.me().is_some() {
                    self.load_notes(false, true);
                }
            }
            Route::Search(q, casts) => {
                if !q.trim().is_empty() {
                    if casts {
                        let k = format!("search:{}", q.trim());
                        if !self.feeds.contains_key(&k) {
                            self.load_feed(k, false);
                        }
                    } else {
                        self.load_people(q.trim().to_string());
                    }
                }
            }
            _ => {}
        }
    }

    /// Read the current page again from the start.
    pub fn refresh(&mut self) {
        match self.route.clone() {
            Route::Home(t) => {
                let k = self.home_key(t);
                self.load_feed(k, false);
            }
            Route::Cast(h) => self.load_thread(h),
            Route::User(id, replies) => {
                self.profiles.remove(&id.to_lowercase());
                self.load_profile(id, replies);
            }
            Route::Notifications => self.load_notes(false, true),
            Route::Search(q, true) => self.load_feed(format!("search:{}", q.trim()), false),
            Route::Search(q, false) => {
                self.people.remove(q.trim());
                self.load_people(q.trim().to_string());
            }
            _ => {}
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
            _ => self.node("/v2/farcaster/feed/trending", &[("limit", "50".into()), ("cursor", c)]),
        }
    }

    /// The first page of a feed (`more` false: read again from the top), or its next page.
    pub fn load_feed(&mut self, key: String, more: bool) {
        let f = self.feeds.entry(key.clone()).or_default();
        if more && (f.loading || f.done || f.cursor.is_none()) {
            return;
        }
        if !more {
            f.gen += 1;
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

    pub fn load_profile(&mut self, id: String, replies: bool) {
        let k = id.to_lowercase();
        match self.profiles.get(&k) {
            Some(Load::Ready(u)) => {
                let fid = u.fid;
                let key = format!("{}:{fid}", if replies { "replies" } else { "casts" });
                if !self.feeds.contains_key(&key) {
                    self.load_feed(key, false);
                }
                return;
            }
            Some(Load::Loading) => return,
            _ => {}
        }
        self.profiles.insert(k.clone(), Load::Loading);
        let numeric = !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit());
        let url = if numeric { self.node("/v2/farcaster/user", &[("fid", id.clone())]) } else { self.node("/v2/farcaster/user/by-username", &[("username", k.clone())]) };
        self.get::<UserResp>(url, move |app, r| {
            match r {
                Ok(UserResp { user: Some(u) }) => {
                    if let Some(f) = u.viewer_context.as_ref().and_then(|v| v.following) {
                        app.follows.insert(u.fid, f);
                    } else if app.me().is_some_and(|m| m != u.fid) {
                        app.load_follow(u.fid);
                    }
                    app.profiles.insert(k, Load::Ready(u));
                    if let Route::User(rid, rep) = app.route.clone() {
                        if rid.to_lowercase() == id.to_lowercase() {
                            app.load_profile(rid, rep);
                        }
                    }
                }
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
            if status != 0 && !(500..600).contains(&status) {
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
        let f = &mut self.notes;
        if more && (f.loading || f.done || f.cursor.is_none()) {
            return;
        }
        if !more {
            if f.loading && !fresh {
                return;
            }
            f.gen += 1;
        }
        f.loading = true;
        f.error = None;
        let gen = f.gen;
        let cursor = if more { f.cursor.clone().unwrap_or_default() } else { String::new() };
        let url = self.node("/v2/farcaster/notifications", &[("fid", me.to_string()), ("limit", "50".into()), ("cursor", cursor), ("include_quotes_and_deep_replies", "true".into())]);
        self.get::<NotePage>(url, move |app, r| {
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
                let set = if kind == "Like" { &mut app.mine_likes } else { &mut app.mine_recasts };
                for msg in m.messages {
                    if let Some(t) = msg.data.reaction_body.and_then(|b| b.target_cast_id) {
                        set.insert(t.hash.trim_start_matches("0x").to_lowercase());
                    }
                }
            });
        }
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
        self.compose = Some(Compose { parent, quote, ..Default::default() });
    }

    pub fn close_compose(&mut self) {
        if let Some(c) = &self.compose {
            if c.sending || (!c.text.trim().is_empty() && !host::ask("Discard this cast?")) {
                return;
            }
        }
        self.compose = None;
    }

    pub fn send_compose(&mut self) {
        let Some(c) = self.compose.as_mut() else { return };
        let len = c.text.trim().len();
        if c.sending || (len == 0 && c.quote.is_none()) || c.text.len() > MAX_CAST {
            return;
        }
        c.sending = true;
        c.error = None;
        let typed = c.text.trim().to_string();
        // every name a mention could mean is asked about once, all at the same time
        let mut names: Vec<String> = fc::mention_spots(&typed).into_iter().flat_map(|(_, n)| fc::mention_tries(&n)).map(|n| n.to_lowercase()).collect();
        names.sort();
        names.dedup();
        let found: Rc<RefCell<HashMap<String, Option<Option<u64>>>>> = Rc::new(RefCell::new(HashMap::new()));
        if names.is_empty() {
            return self.post(typed, HashMap::new());
        }
        let left = Rc::new(RefCell::new(names.len()));
        for n in names {
            let (found, left, typed) = (found.clone(), left.clone(), typed.clone());
            self.fid_by_name(n.clone(), move |app, fid| {
                found.borrow_mut().insert(n, fid);
                *left.borrow_mut() -= 1;
                if *left.borrow() == 0 {
                    let m = found.borrow().clone();
                    app.post(typed, m);
                }
            });
        }
    }

    /// A name's FID: Some(None) when there's no such user, None when the node couldn't say. ENS names, which the
    /// node's by-username doesn't know, come from search (exact match only).
    fn fid_by_name(&mut self, name: String, f: impl FnOnce(&mut App, Option<Option<u64>>) + 'static) {
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

    fn post(&mut self, typed: String, found: HashMap<String, Option<Option<u64>>>) {
        let Some(c) = self.compose.as_ref() else { return };
        // each name's answer: Some(Some(fid)), Some(None) for no such user, None when the node couldn't say
        let (text, mentions, positions) = fc::apply_mentions(&typed, |n| found.get(n).cloned().flatten(), 10);
        let quote = c.quote.as_ref().map(|q| fc::CastRef { fid: q.author.fid, hash: q.bare_hash() });
        // a cast carries 2 embeds: a quoted cast first, then links from its text (src/shared.ts castEmbeds)
        let mut embeds: Vec<fc::Embed> = quote.clone().map(fc::Embed::Cast).into_iter().collect();
        for u in text::text_links(&text) {
            if embeds.len() < 2 {
                embeds.push(fc::Embed::Url(u));
            }
        }
        let parent = match &c.parent {
            Some(p) => fc::Parent::Cast(fc::CastRef { fid: p.author.fid, hash: p.bare_hash() }),
            None => fc::Parent::None,
        };
        let parent_cast = c.parent.clone();
        let body = fc::cast_body(&text, &mentions, &positions, &embeds, &parent);
        let shown = typed.clone();
        self.send(fc::mt::CAST_ADD, body, move |app, r| match r {
            Ok(hash) => {
                app.compose = None;
                app.show_posted(hash, shown, parent_cast, quote);
                app.say("Posted");
            }
            Err(e) => {
                if let Some(c) = app.compose.as_mut() {
                    c.sending = false;
                    c.error = Some(e);
                }
            }
        });
    }

    /// A cast just sent shows where it belongs before the node has indexed it.
    fn show_posted(&mut self, hash: String, text: String, parent: Option<Cast>, quote: Option<fc::CastRef>) {
        let Some(a) = self.account.clone() else { return };
        let author = User { fid: a.fid, username: a.username.clone(), display_name: a.display.clone(), pfp_url: a.pfp.clone(), ..Default::default() };
        let c = Cast {
            hash: hash.clone(),
            text,
            timestamp: iso_now(),
            author,
            parent_hash: parent.as_ref().map(|p| p.bare_hash()),
            parent_author: ParentAuthor { fid: parent.as_ref().map(|p| p.author.fid) },
            embeds: quote.map(|q| EmbedJ { url: None, cast_id: Some(CastIdJ { fid: q.fid, hash: q.hash }) }).into_iter().collect(),
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
                for k in [format!("following:{}", a.fid), format!("casts:{}", a.fid)] {
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

    fn sign(&mut self, key: &[u8], msg: &[u8], f: impl FnOnce(&mut App, Result<Vec<u8>, String>) + 'static) {
        if let Some(seed) = self.raw_seed {
            use ed25519_dalek::Signer;
            let k = ed25519_dalek::SigningKey::from_bytes(&seed);
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
            Ok(Some(fid)) => app.add_key(fid, addr, custody),
            Ok(None) => app.join_failed("No Farcaster account uses this recovery phrase. You can create one at quilcast.com.".into()),
            Err(e) => app.join_failed(e),
        });
    }

    fn join_failed(&mut self, e: String) {
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
                app.raw_seed = None;
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
                    app.raw_seed = Some(seed);
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
            app.join = Join::default();
            app.set_account(Some(a));
            app.navigate("/", false);
            app.say("Signed in");
        });
    }

    fn set_account(&mut self, a: Option<Account>) {
        match &a {
            Some(a) => host::set(ACCOUNT_KEY, &serde_json::to_string(a).unwrap_or_default()),
            None => host::del(ACCOUNT_KEY),
        }
        self.account = a;
        // what was read for the previous viewer goes
        self.feeds.clear();
        self.notes = Feed::default();
        self.threads.clear();
        self.profiles.clear();
        self.follows.clear();
        self.mine_likes.clear();
        self.mine_recasts.clear();
        self.taps.clear();
        self.load_mine();
    }

    /// Sign out: this browser's key revokes itself (so a copy of it stops working too), then it's deleted.
    pub fn sign_out(&mut self) {
        let Some(a) = self.account.clone() else { return };
        if !host::ask("Sign out? This browser's key is revoked, and signing in again needs your recovery phrase.") {
            return;
        }
        self.busy.insert("signout".into());
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
            app.raw_seed = None;
            app.set_account(None);
            app.navigate("/", false);
            app.say("Signed out");
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
        self.threads.clear();
        self.profiles.clear();
        self.notes = Feed::default();
        self.say("Node saved");
    }
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
        assert_eq!(parse_route("/search?q=gm%20there&tab=casts"), Route::Search("gm there".into(), true));
        assert_eq!(parse_route("/notifications"), Route::Notifications);
        assert_eq!(parse_route("/nope"), Route::NotFound);
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
