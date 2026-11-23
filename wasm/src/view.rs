//! Every page, drawn from the app's state as a tree of nodes (dom.rs). Nothing here changes state directly: handlers
//! get the app when the event happens.

use crate::api::*;
use crate::app::*;
use crate::dom::*;
use crate::{host, text};

const P_HOME: &str = "M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z";
const P_SEARCH: &str = "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3";
const P_USER: &str = "M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z";
const P_REPLY: &str = "M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.8-.9L3 20l1.1-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4z";
const P_RECAST: &str = "M17 2l4 4-4 4M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4M21 13v2a3 3 0 0 1-3 3H3";
const P_QUOTE: &str = "M7 7h4v4c0 3-1.5 4.5-4 5M15 7h4v4c0 3-1.5 4.5-4 5";
const P_LIKE: &str = "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z";
const P_SHARE: &str = "M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 6l-4-4-4 4M12 2v14";
const P_BACK: &str = "M19 12H5M12 19l-7-7 7-7";
const P_GEAR: &str = "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z";
const P_PEN: &str = "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z";
const P_TRASH: &str = "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6";
const P_BELL: &str = "M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0";
const P_X: &str = "M18 6 6 18M6 6l12 12";
const P_MORE: &str = "M5 12h.01M12 12h.01M19 12h.01";
const P_HASH: &str = "M4 9h16M4 15h16M10 3 8 21M16 3l-2 18";
const P_IMAGE: &str = "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 21";
const P_CLOCK: &str = "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2";
const P_PIN: &str = "M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3z";
const P_SMILE: &str = "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01";
const P_STICKER: &str = "M21 12V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h7zM21 12h-5a4 4 0 0 0-4 4v5M8 13.5s1.2 1.5 3 1.5M9 9h.01M15 9h.01";
const P_PLUS: &str = "M12 5v14M5 12h14";

fn icon(d: &'static str) -> V {
    el("svg").attr("viewBox", "0 0 24 24").attr("aria-hidden", "true").class("ic").kid(el("path").attr("d", d)).into()
}
fn link(href: impl Into<String>) -> El {
    el("a").attr("href", href)
}
fn external(href: impl Into<String>) -> El {
    el("a").attr("href", href).attr("target", "_blank").attr("rel", "noopener noreferrer nofollow")
}
fn button(label: &str) -> El {
    el("button").attr("type", "button").txt(label)
}
fn avatar(u: &User, size: &str) -> V {
    let mut a = el("span").class(format!("av {size}"));
    if let Some(p) = u.pfp_url.as_deref().and_then(text::safe_url) {
        a = a.kid(el("img").attr("src", text::proxied(&text::sized(&p, "anim=false,w=144"))).attr("alt", "").attr("loading", "lazy").attr("decoding", "async"));
    }
    a.into()
}
/// A channel's picture, drawn like a face.
fn chan_av(image: Option<&str>, size: &str) -> V {
    let mut a = el("span").class(format!("av chan {size}"));
    if let Some(p) = image.and_then(text::safe_url) {
        a = a.kid(el("img").attr("src", text::proxied(&text::sized(&p, "anim=false,w=144"))).attr("alt", "").attr("loading", "lazy").attr("decoding", "async"));
    }
    a.into()
}
fn tab(label: impl Into<String>, href: String, on: bool) -> El {
    link(href).class(if on { "tab on" } else { "tab" }).attr_if(on, "aria-current", "page").txt(label)
}
fn more_btn(label: &str, f: impl Fn(&mut App) + 'static) -> El {
    button("").class("icon-btn more").attr("aria-label", label).attr("aria-haspopup", "dialog").kid(icon(P_MORE)).click(f)
}
fn spinner() -> V {
    el("div").class("spin").attr("role", "status").attr("aria-label", "Loading").into()
}
fn problem(e: &str, retry: impl Fn(&mut App) + 'static) -> V {
    el("div").class("problem").kid(el("p").txt(e.to_string())).kid(button("Try again").class("btn").click(retry)).into()
}

pub fn title(app: &App) -> String {
    let t = match &app.route {
        Route::Home(_) => "Home".to_string(),
        Route::Browse(id) => format!("Browsing as @{id}"),
        Route::Cast(_) => "Cast".into(),
        Route::Who(_, k) => who_title(k).into(),
        Route::Follows(id, k) => format!("@{id} · {}", if *k == "followers" { "Followers" } else { "Following" }),
        Route::Channels => "Channels".into(),
        Route::Channel(id) => format!("/{id}"),
        Route::User(id, _) => match app.profiles.get(&id.to_lowercase()) {
            Some(Load::Ready(u)) => format!("{} (@{})", u.name(), u.handle()),
            _ => format!("@{id}"),
        },
        Route::Notifications => "Notifications".into(),
        Route::Search(q, _) if !q.is_empty() => format!("{q} · Search"),
        Route::Search(..) => "Search".into(),
        Route::Join if app.account.is_some() => "Add account".into(),
        Route::Join => "Sign in".into(),
        Route::Settings => "Settings".into(),
        Route::NotFound => "Not found".into(),
    };
    format!("{t} · Quilcast WASM")
}

pub fn page(app: &App) -> V {
    let theme = match app.settings.theme.as_str() {
        "light" | "dark" => app.settings.theme.clone(),
        _ => "system".into(),
    };
    el("div")
        .class(format!("app theme-{theme}"))
        .kid(nav(app))
        .kid(el("main").class("col").attr("id", "main").kid(route(app)))
        .kid(tabbar(app))
        .maybe(app.compose.as_ref().map(|c| composer(app, c)))
        .maybe(app.sheet.as_ref().map(|s| sheet(app, s)))
        .maybe(app.toast.as_ref().map(|t| el("div").class("toast").attr("role", "status").txt(t.clone()).into()))
        .into()
}

fn nav_items(app: &App) -> Vec<(&'static str, String, &'static str, bool)> {
    let r = &app.route;
    let mut items = vec![
        ("Home", "/".to_string(), P_HOME, matches!(r, Route::Home(_) | Route::Browse(_))),
        ("Search", "/search".into(), P_SEARCH, matches!(r, Route::Search(..))),
        ("Channels", "/channels".into(), P_HASH, matches!(r, Route::Channels | Route::Channel(_))),
    ];
    match &app.account {
        Some(a) => {
            items.push(("Notifications", "/notifications".into(), P_BELL, *r == Route::Notifications));
            let me = a.username.clone().unwrap_or_else(|| a.fid.to_string());
            let here = matches!(r, Route::User(id, _) if id.eq_ignore_ascii_case(&me) || *id == a.fid.to_string());
            items.push(("Profile", format!("/u/{me}"), P_USER, here));
        }
        None => items.push(("Sign in", "/join".into(), P_USER, *r == Route::Join)),
    }
    items.push(("Settings", "/settings".into(), P_GEAR, *r == Route::Settings));
    items
}

fn nav(app: &App) -> V {
    let mut n = el("nav").class("side").attr("aria-label", "Main").kid(link("/").class("brand").attr("aria-label", "Quilcast home").kid(el("span").class("logo").txt("Q")).kid(el("span").class("word").txt("Quilcast")).kid(el("span").class("tag").txt("wasm")));
    for (label, href, d, on) in nav_items(app) {
        n = n.kid(link(href).class(if on { "item on" } else { "item" }).attr_if(on, "aria-current", "page").kid(icon(d)).kid(el("span").txt(label)));
    }
    if app.account.is_some() {
        n = n.kid(button("").class("btn cast-btn").kid(icon(P_PEN)).kid(el("span").txt("Cast")).click(|a| a.open_compose(None, None)));
    }
    n.into()
}

fn tabbar(app: &App) -> V {
    let mut t = el("nav").class("tabs-bottom").attr("aria-label", "Main");
    // the bottom bar keeps to five: Channels is in Search's tabs there
    for (label, href, d, on) in nav_items(app).into_iter().filter(|i| i.0 != "Channels") {
        t = t.kid(link(href).class(if on { "on" } else { "" }).attr("aria-label", label).attr_if(on, "aria-current", "page").kid(icon(d)));
    }
    let t = if app.account.is_some() { t.kid(button("").class("fab").attr("aria-label", "Cast").kid(icon(P_PEN)).click(|a| a.open_compose(None, None))) } else { t };
    t.into()
}

fn header(title: &str, back: bool) -> El {
    let h = el("header").class("top");
    let h = if back { h.kid(button("").class("icon-btn").attr("aria-label", "Back").kid(icon(P_BACK)).click(|a| a.back())) } else { h };
    h.kid(el("h1").txt(title.to_string()))
}

fn route(app: &App) -> V {
    match app.route.clone() {
        Route::Home(t) => home(app, t),
        Route::Browse(id) => browse(app, &id),
        Route::Cast(h) => thread(app, &h),
        Route::Who(h, k) => who(app, &h, k),
        Route::User(id, r) => profile(app, &id, r),
        Route::Follows(id, k) => follows(app, &id, k),
        Route::Channels => channels(app),
        Route::Channel(id) => channel(app, &id),
        Route::Notifications => notifications(app),
        Route::Search(q, c) => search(app, &q, c),
        Route::Join => join(app),
        Route::Settings => settings(app),
        Route::NotFound => el("section").kid(header("Not found", true)).kid(el("p").class("empty").txt("There's nothing here.")).into(),
    }
}

// --- feeds ---

fn home(app: &App, trending: bool) -> V {
    let key = app.home_key(trending);
    let signed = app.account.is_some();
    let following = signed || !app.local.is_empty();
    let tabs = if following {
        el("div").class("tabbar").kid(tab("Following", "/".into(), !trending)).kid(tab("Trending", "/?feed=trending".into(), trending))
    } else {
        el("div").class("tabbar").kid(tab("Trending", "/".into(), true))
    };
    let intro = (!signed).then(|| {
        el("div").class("intro")
            .kid(el("p").txt("Quilcast, rebuilt in Rust and running as WebAssembly. Read Farcaster here, or sign in with your recovery phrase to cast."))
            .kid(link("/join").class("btn primary").txt("Sign in"))
            .kid(el("p").class("muted small").txt(if app.local.is_empty() {
                "No account? Follow people anyway: they're kept on this device, and their casts show under Following here. Nothing is published."
            } else {
                "Following shows the people you follow on this device. Nothing is published."
            }))
            .into()
    });
    let empty = if key == "local" { "No casts from the people you follow on this device yet." } else { "Nothing here yet." };
    el("section").kid(header("Home", false).kid(tabs)).maybe(intro).maybe((!signed).then(|| recents(app, None)).flatten()).kid(feed(app, &key, empty, None)).into()
}

/// The last accounts browsed as, offered again.
fn recents(app: &App, skip: Option<u64>) -> Option<V> {
    let list: Vec<&Recent> = app.recents.iter().filter(|r| Some(r.fid) != skip).collect();
    if list.is_empty() {
        return None;
    }
    let mut row = el("div").class("recents").kid(el("span").class("muted small").txt("Browse as"));
    for r in list {
        let u = r.user();
        row = row.kid(link(App::browse_path(&u)).class("chip").key(u.fid.to_string()).kid(avatar(&u, "xs")).kid(el("bdi").txt(format!("@{}", u.handle()))));
    }
    Some(row.into())
}

/// Home as someone else: their Following feed, from public data. Nothing is signed as them.
fn browse(app: &App, id: &str) -> V {
    let s = el("section").kid(header("Home", false));
    let id2 = id.to_string();
    match app.profiles.get(&id.to_lowercase()) {
        None | Some(Load::Loading) => s.kid(spinner()).into(),
        Some(Load::Failed(e)) => s.kid(problem(e, move |a| a.fetch_profile(id2.clone()))).into(),
        Some(Load::Ready(u)) => {
            let banner = el("div").class("banner").attr("role", "status")
                .kid(avatar(u, "xs"))
                .kid(el("span").kid(text("You're browsing as ")).kid(link(u.path()).txt(format!("@{}", u.handle()))).kid(text(": their Following feed, read from public data. Likes, recasts and replies stay yours.")))
                .kid(link("/").class("btn").txt("Exit"));
            s.kid(banner).maybe(recents(app, Some(u.fid))).kid(feed(app, &format!("following:{}", u.fid), "Nothing here yet.", None)).into()
        }
    }
}

/// A feed of casts; `owner`'s profile still shows their casts when they're muted.
fn feed(app: &App, key: &str, empty: &str, owner: Option<u64>) -> V {
    feed_skip(app, key, empty, owner, None)
}
/// A feed less one cast (`skip`, a bare hash): a profile's pinned cast, drawn above it.
fn feed_skip(app: &App, key: &str, empty: &str, owner: Option<u64>, skip: Option<&str>) -> V {
    let Some(f) = app.feeds.get(key) else { return spinner() };
    let mut list = el("div").class("feed");
    for c in f.items.iter().filter(|c| !app.hidden(c, owner) && skip.is_none_or(|h| c.bare_hash() != h || c.recaster.is_some())) {
        let k = format!("{}:{}", c.hash, c.recaster.as_ref().map_or(0, |u| u.fid));
        list = list.kid(cast_card(app, c, false).key(k));
    }
    if let Some(e) = &f.error {
        let k = key.to_string();
        let more = !f.items.is_empty();
        list = list.kid(problem(e, move |a| a.load_feed(k.clone(), more)));
    } else if f.loading {
        list = list.kid(spinner());
    } else if f.items.is_empty() && (f.done || f.cursor.is_none()) {
        list = list.kid(el("p").class("empty").txt(empty.to_string()));
    } else if !f.done {
        let k = key.to_string();
        let k2 = k.clone();
        // a new node per page, so it's seen anew when the next page still leaves it on screen
        list = list.kid(el("div").class("more").key(format!("more:{}", f.cursor.clone().unwrap_or_default())).on(Ev::Visible, move |a, _| a.load_feed(k.clone(), true)).kid(button("Load more").class("btn").click(move |a| a.load_feed(k2.clone(), true))));
    }
    list.into()
}

// --- casts ---

fn rich(s: &str) -> V {
    let mut p = el("div").class("text");
    for t in text::tokens(s) {
        p = p.kid(match t {
            text::Tok::Text(s) => text(s),
            text::Tok::Link(href, shown) => external(href).txt(shown).into(),
            text::Tok::Mention(n) => link(format!("/u/{}", n.to_lowercase())).class("mention").txt(format!("@{n}")).into(),
            text::Tok::Channel(n) => link(format!("/channel/{}", n.to_lowercase())).class("mention").txt(format!("/{n}")).into(),
        });
    }
    p.into()
}

pub fn shown_text(c: &Cast) -> String {
    let names: Vec<(u64, Option<String>)> = c.mentioned_profiles_ranges.iter().enumerate().map(|(i, r)| (r.start, (r.start == r.end).then(|| c.mentioned_profiles.get(i).and_then(|u| u.username.clone())).flatten())).collect();
    text::cast_text(&c.text, &names)
}

/// What muted words look at in a cast (src/shared.ts mutedText): its text, the sites its link embeds point at (not a
/// picture's or video's, whose address is a CDN's), and the same of the quoted casts given.
pub fn muted_text(c: &Cast, quoted: &[&Cast]) -> String {
    let mut out = Vec::new();
    for x in std::iter::once(c).chain(quoted.iter().copied()) {
        out.push(shown_text(x));
        out.extend(x.embeds.iter().filter_map(|e| e.url.as_deref()).filter(|u| !text::is_img(u) && !text::is_vid(u)).map(text::host));
    }
    out.join("\n")
}

fn cast_card(app: &App, c: &Cast, big: bool) -> El {
    let hash = c.bare_hash();
    let now = host::ms();
    let mut card = el("article").class(if big { "cast big" } else { "cast" });
    if !big {
        let h = hash.clone();
        card = card.attr("tabindex", "-1").click(move |a| a.navigate(&format!("/c/{h}"), false));
    }
    if let Some(r) = &c.recaster {
        card = card.kid(el("div").class("context").kid(icon(P_RECAST)).kid(link(r.path()).txt(format!("{} recast", r.name()))));
    }
    let chan = if c.parent_hash.is_none() { app.channel_of(c.parent_url.as_deref()) } else { None };
    let head = el("div").class("head")
        .kid(link(c.author.path()).class("who").kid(el("bdi").class("name").txt(c.author.name())).kid(el("span").class("handle").txt(format!("@{}", c.author.handle()))))
        .maybe(chan.map(|id| link(format!("/channel/{id}")).class("chan-tag").txt(format!("/{id}")).into()))
        .maybe(spam_tag(app, c))
        .kid(link(format!("/c/{hash}")).class("time").attr("title", c.timestamp.clone()).txt(text::ago(&c.timestamp, now)));
    let mut body = el("div").class("body").kid(head);
    if let (Some(p), false) = (&c.parent_hash, big) {
        let who = c.parent_author.fid.and_then(|f| app.profiles.values().find_map(|l| match l {
            Load::Ready(u) if u.fid == f => Some(u.handle()),
            _ => None,
        }));
        body = body.kid(el("div").class("context").kid(link(format!("/c/{}", p.trim_start_matches("0x"))).txt(match who {
            Some(w) => format!("Replying to @{w}"),
            None => "Replying to a cast".into(),
        })));
    }
    let t = shown_text(c);
    if !t.trim().is_empty() {
        body = body.kid(rich(&t));
    }
    body = body.maybe(embeds(app, c));
    if big {
        body = body.kid(el("div").class("stamp").txt(c.timestamp.replace('T', " ").chars().take(16).collect::<String>() + " UTC"));
        let (_, likes) = app.tapped(1, c);
        let (_, recasts) = app.tapped(2, c);
        let stat = |n: u64, one: &str, many: &str, kind: &str| link(format!("/c/{hash}/{kind}")).kid(el("strong").txt(text::count(n))).txt(format!(" {}", if n == 1 { one } else { many }));
        body = body.kid(el("div").class("stats")
            .kid(stat(likes, "like", "likes", "likes"))
            .kid(stat(recasts, "recast", "recasts", "recasts"))
            .kid(link(format!("/c/{hash}/quotes")).txt("Quotes")));
    }
    body = body.kid(actions(app, c));
    card.kid(link(c.author.path()).class("side-av").attr("aria-label", c.author.name()).kid(avatar(&c.author, if big { "md" } else { "sm" }))).kid(body)
}

/// "Spam 97%" on a cast spam.quilcast.com scores at or over the threshold, else "Spam account 92%" when its author
/// does (src/ui.tsx).
fn spam_tag(app: &App, c: &Cast) -> Option<V> {
    let (label, title) = match (app.spam_of(c), app.spam_account_of(c.author.fid)) {
        (Some(n), _) => (format!("Spam {n}%"), "How likely spam.quilcast.com thinks this cast is spam"),
        (None, Some(n)) => (format!("Spam account {n}%"), "How likely spam.quilcast.com thinks this is a spam account"),
        _ => return None,
    };
    Some(el("span").class("spam-tag").attr("title", title).txt(label).into())
}

fn embeds(app: &App, c: &Cast) -> Option<V> {
    let urls = c.urls();
    let quote = c.quoted();
    if urls.is_empty() && quote.is_none() {
        return None;
    }
    let mut box_ = el("div").class("embeds");
    // a sticker is drawn as it is, with no frame, and opens its pack on quilcast.com (src/ui.tsx Sticker)
    let (stickers, urls): (Vec<&String>, Vec<&String>) = urls.iter().partition(|u| crate::compose::sticker_pack(u).is_some());
    for u in stickers {
        let pack = crate::compose::sticker_pack(u).unwrap_or_default();
        box_ = box_.kid(external(format!("https://quilcast.com/stickers/{pack}")).class("sticker").attr("aria-label", "Sticker").kid(el("img").attr("src", u.clone()).attr("alt", "").attr("loading", "lazy")));
    }
    let imgs: Vec<&String> = urls.iter().copied().filter(|u| text::is_img(u)).collect();
    if !imgs.is_empty() {
        let mut row = el("div").class(if imgs.len() > 1 { "imgs strip" } else { "imgs" });
        for u in imgs {
            row = row.kid(external(u.clone()).class("img").attr("aria-label", "Open picture").kid(el("img").attr("src", text::proxied(&text::sized(u, "w=1200"))).attr("alt", "").attr("loading", "lazy").attr("decoding", "async")));
        }
        box_ = box_.kid(row);
    }
    for u in urls.iter().copied().filter(|u| text::is_vid(u)) {
        let mut v = el("video").attr("src", u.clone()).attr("controls", "").attr("preload", "none").attr("playsinline", "");
        if let Some(p) = text::poster(u) {
            v = v.attr("poster", p);
        }
        box_ = box_.kid(v);
    }
    for u in urls.iter().copied().filter(|u| !text::is_img(u) && !text::is_vid(u)) {
        box_ = box_.kid(link_card(app, u));
    }
    if let Some((_, h)) = quote {
        box_ = box_.kid(quote_card(app, &h));
    }
    Some(box_.into())
}

fn link_card(app: &App, u: &str) -> V {
    let mut card = external(u.to_string()).class("card");
    match app.unfurls.get(u) {
        None => app.wants.borrow_mut().push(Want::Unfurl(u.to_string())),
        Some(Load::Ready(Some(m))) => {
            if let Some(img) = m.image.as_deref().and_then(text::safe_url) {
                card = card.kid(el("img").attr("src", text::proxied(&img)).attr("alt", "").attr("loading", "lazy"));
            }
            let mut words = el("span").class("words");
            if let Some(t) = m.title.as_deref().filter(|t| !t.is_empty()) {
                words = words.kid(el("strong").txt(t.to_string()));
            }
            if let Some(d) = m.description.as_deref().filter(|t| !t.is_empty()) {
                words = words.kid(el("span").class("desc").txt(d.to_string()));
            }
            return card.kid(words.kid(el("span").class("host").txt(text::shown_url(u)))).into();
        }
        _ => {}
    }
    card.kid(el("span").class("words").kid(el("span").class("host").txt(text::shown_url(u)))).into()
}

fn quote_card(app: &App, h: &str) -> V {
    let inner = match app.quotes.get(h) {
        None => {
            app.wants.borrow_mut().push(Want::Quote(h.to_string()));
            el("span").class("muted").txt("Loading the quoted cast…")
        }
        Some(Load::Loading) => el("span").class("muted").txt("Loading the quoted cast…"),
        Some(Load::Failed(e)) => el("span").class("muted").txt(e.clone()),
        Some(Load::Ready(q)) => {
            let t = shown_text(q);
            el("span")
                .kid(el("span").class("qhead").kid(avatar(&q.author, "xs")).kid(el("bdi").class("name").txt(q.author.name())).kid(el("span").class("handle").txt(format!("@{}", q.author.handle()))))
                .kid(el("span").class("qtext").txt(t.chars().take(400).collect::<String>()))
        }
    };
    link(format!("/c/{h}")).class("quote").kid(inner).into()
}

fn actions(app: &App, c: &Cast) -> V {
    let (liked, likes) = app.tapped(1, c);
    let (recast, recasts) = app.tapped(2, c);
    let n = |x: u64| if x > 0 { text::count(x) } else { String::new() };
    let (c1, c2, c3, c4, c5, c6) = (c.clone(), c.clone(), c.clone(), c.clone(), c.clone(), c.clone());
    let mine = app.me() == Some(c.author.fid);
    let hash = c.bare_hash();
    let mut row = el("div").class("actions")
        .kid(button("").class("act").attr("aria-label", format!("Reply ({})", c.replies.count)).kid(icon(P_REPLY)).kid(el("span").txt(n(c.replies.count))).click(move |a| a.open_compose(Some(c1.clone()), None)))
        .kid(button("").class(if recast { "act recast on" } else { "act recast" }).attr("aria-label", format!("Recast ({recasts})")).attr("aria-pressed", recast.to_string()).kid(icon(P_RECAST)).kid(el("span").txt(n(recasts))).click(move |a| a.react(2, &c2)))
        .kid(button("").class(if liked { "act like on" } else { "act like" }).attr("aria-label", format!("Like ({likes})")).attr("aria-pressed", liked.to_string()).kid(icon(P_LIKE)).kid(el("span").txt(n(likes))).click(move |a| a.react(1, &c3)))
        .kid(button("").class("act").attr("aria-label", "Quote").kid(icon(P_QUOTE)).click(move |a| a.open_compose(None, Some(c4.clone()))))
        .kid(button("").class("act").attr("aria-label", "Copy link").kid(icon(P_SHARE)).click(move |a| {
            host::clip(&format!("{}/c/{hash}", host::site()));
            a.say("Link copied");
        }));
    if mine {
        row = row.kid(button("").class("act").attr("aria-label", "Delete").kid(icon(P_TRASH)).click(move |a| a.delete_cast(&c5)));
    }
    row = row.kid(button("").class("act more").attr("aria-label", "More").attr("aria-haspopup", "dialog").kid(icon(P_MORE)).click(move |a| a.sheet = Some(Sheet::Cast(c6.clone()))));
    row.into()
}

// --- a cast and its replies ---

fn thread(app: &App, h: &str) -> V {
    let s = el("section").kid(header("Cast", true));
    let h2 = h.to_string();
    match app.threads.get(h) {
        None | Some(Load::Loading) => s.kid(spinner()).into(),
        Some(Load::Failed(e)) => s.kid(problem(e, move |a| a.load_thread(h2.clone()))).into(),
        Some(Load::Ready(root)) => {
            let mut s = s;
            if let Some(p) = &root.parent_hash {
                s = s.kid(link(format!("/c/{}", p.trim_start_matches("0x"))).class("earlier").txt("Show the cast it replies to"));
            }
            s = s.kid(cast_card(app, root, true));
            let mut replies = el("div").class("feed replies");
            for r in root.direct_replies.iter().filter(|r| !app.hidden(r, None)) {
                let mut group = el("div").class("reply-group").key(r.bare_hash()).kid(cast_card(app, r, false));
                for rr in r.direct_replies.iter().filter(|r| !app.hidden(r, None)) {
                    group = group.kid(cast_card(app, rr, false).class("cast nested").key(rr.bare_hash()));
                }
                if r.replies.count > r.direct_replies.len() as u64 {
                    group = group.kid(link(format!("/c/{}", r.bare_hash())).class("earlier nested").txt("More replies"));
                }
                replies = replies.kid(group);
            }
            if root.direct_replies.is_empty() {
                replies = replies.kid(el("p").class("empty").txt("No replies yet."));
            }
            s.kid(replies).into()
        }
    }
}

// --- profiles ---

fn profile(app: &App, id: &str, replies: bool) -> V {
    let s = el("section");
    let id2 = id.to_string();
    match app.profiles.get(&id.to_lowercase()) {
        None | Some(Load::Loading) => s.kid(header(&format!("@{id}"), true)).kid(spinner()).into(),
        Some(Load::Failed(e)) => s.kid(header(&format!("@{id}"), true)).kid(problem(e, move |a| a.fetch_profile(id2.clone()))).into(),
        Some(Load::Ready(u)) => {
            let me = app.me() == Some(u.fid);
            let now = host::ms() as u64;
            let blocked = app.mutes.blocked(u.fid, now);
            let base = u.path();
            let mut top = el("div").class("profile").kid(avatar(u, "lg")).kid(el("h2").kid(el("bdi").txt(u.name()))).kid(el("div").class("handle").txt(format!("@{}", u.handle())));
            if let Some(b) = u.profile.bio.text.as_deref().filter(|b| !b.trim().is_empty()) {
                top = top.kid(rich(b));
            }
            top = top.kid(el("div").class("counts")
                .kid(link(format!("{base}/following")).kid(el("strong").txt(text::count(u.following_count))).txt(" following"))
                .kid(link(format!("{base}/followers")).kid(el("strong").txt(text::count(u.follower_count))).txt(" followers")));
            let mut pills = el("div").class("pills");
            if u.viewer_context.as_ref().and_then(|v| v.followed_by) == Some(true) && !me {
                pills = pills.kid(el("span").class("pill").txt("Follows you"));
            }
            if let Some(n) = app.spam_account_of(u.fid) {
                pills = pills.kid(el("span").class("spam-tag").attr("title", "How likely spam.quilcast.com thinks this is a spam account").txt(format!("Spam account {n}%")));
            }
            if blocked {
                pills = pills.kid(el("span").class("pill warn").txt("Blocked"));
            } else if app.mutes.muted(u.fid, now) {
                pills = pills.kid(el("span").class("pill warn").txt("Muted"));
            }
            top = top.kid(pills);
            if blocked {
                let u2 = u.clone();
                top = top.kid(button("Unblock").class("btn").click(move |a| a.mute(true, &u2, false, None)));
            } else if !me {
                let (on, title) = match app.account {
                    Some(_) => (app.follows.get(&u.fid).copied().unwrap_or(false), None),
                    None => (app.is_local(u.fid), Some("On this device only")),
                };
                let u2 = u.clone();
                top = top.kid(button(if on { "Following" } else { "Follow" }).class(if on { "btn" } else { "btn primary" }).attr("aria-pressed", on.to_string()).attr_if(title.is_some(), "title", title.unwrap_or_default()).click(move |a| a.follow_user(&u2)));
            }
            let tabs = el("div").class("tabbar").kid(tab("Casts", base.clone(), !replies)).kid(tab("Replies", format!("{base}/replies"), replies));
            let key = format!("{}:{}", if replies { "replies" } else { "casts" }, u.fid);
            let u2 = u.clone();
            let head = header(&u.name(), true).kid(more_btn("Profile menu", move |a| a.sheet = Some(Sheet::User(u2.clone()))));
            // the pinned cast goes on top of Casts, and out of the list once it's drawn there (src/castpin.ts listSkip)
            let mut pinned: Option<V> = None;
            if !replies && !blocked {
                if !app.pins.contains_key(&u.fid) {
                    app.wants.borrow_mut().push(Want::Pin(u.fid));
                }
                if let Some(h) = app.pinned(u.fid) {
                    match app.quotes.get(h) {
                        None => app.wants.borrow_mut().push(Want::Quote(h.to_string())),
                        Some(Load::Ready(c)) if !app.hidden(c, Some(u.fid)) && c.author.fid == u.fid => {
                            pinned = Some(el("div").class("pinned").kid(el("div").class("context").kid(icon(P_PIN)).kid(el("span").txt("Pinned"))).kid(cast_card(app, c, false).key(format!("pin:{h}"))).into());
                        }
                        _ => {}
                    }
                }
            }
            let skip = pinned.as_ref().and(app.pinned(u.fid));
            let list = if blocked { el("p").class("empty").txt(format!("You blocked @{}, so their casts are hidden.", u.handle())).into() } else { feed_skip(app, &key, "No casts yet.", Some(u.fid), skip) };
            s.kid(head).kid(top).kid(tabs).maybe(pinned).kid(list).into()
        }
    }
}

/// Someone in a list of people.
fn person(u: &User) -> El {
    let mut row = link(u.path()).class("person").key(u.fid.to_string()).kid(avatar(u, "sm")).kid(el("span").class("words").kid(el("bdi").class("name").txt(u.name())).kid(el("span").class("handle").txt(format!("@{} · {} followers", u.handle(), text::count(u.follower_count)))));
    if let Some(b) = u.profile.bio.text.as_deref().filter(|b| !b.is_empty()) {
        row = row.kid(el("span").class("bio").txt(b.chars().take(140).collect::<String>()));
    }
    row
}

/// A list of people read a page at a time (app.lists).
fn people(app: &App, key: &str, empty: &str) -> V {
    let Some(f) = app.lists.get(key) else { return spinner() };
    let now = host::ms() as u64;
    let mut list = el("div").class("feed");
    for u in f.items.iter().filter(|u| !app.mutes.blocked(u.fid, now)) {
        list = list.kid(person(u));
    }
    if let Some(e) = &f.error {
        let k = key.to_string();
        let more = !f.items.is_empty();
        list = list.kid(problem(e, move |a| a.load_list(k.clone(), more)));
    } else if f.loading {
        list = list.kid(spinner());
    } else if f.items.is_empty() {
        list = list.kid(el("p").class("empty").txt(empty.to_string()));
    } else if !f.done {
        let (k, k2) = (key.to_string(), key.to_string());
        list = list.kid(el("div").class("more").key(format!("more:{}", f.cursor.clone().unwrap_or_default())).on(Ev::Visible, move |a, _| a.load_list(k.clone(), true)).kid(button("Load more").class("btn").click(move |a| a.load_list(k2.clone(), true))));
    }
    list.into()
}

fn follows(app: &App, id: &str, kind: &'static str) -> V {
    let title = if kind == "followers" { "Followers" } else { "Following" };
    let s = el("section").kid(header(title, true));
    let id2 = id.to_string();
    match app.profiles.get(&id.to_lowercase()) {
        None | Some(Load::Loading) => s.kid(spinner()).into(),
        Some(Load::Failed(e)) => s.kid(problem(e, move |a| a.fetch_profile(id2.clone()))).into(),
        Some(Load::Ready(u)) => {
            let base = u.path();
            let tabs = el("div").class("tabbar").kid(tab("Following", format!("{base}/following"), kind == "following")).kid(tab("Followers", format!("{base}/followers"), kind == "followers"));
            s.kid(el("p").class("sub").kid(link(base.clone()).txt(format!("@{}", u.handle())))).kid(tabs).kid(people(app, &format!("{kind}:{}", u.fid), "Nobody yet.")).into()
        }
    }
}

fn who_title(kind: &str) -> &'static str {
    match kind {
        "likes" => "Liked by",
        "recasts" => "Recast by",
        _ => "Quotes",
    }
}

/// Who liked or recast a cast, or the casts quoting it.
fn who(app: &App, h: &str, kind: &'static str) -> V {
    let s = el("section").kid(header(who_title(kind), true));
    let tabs = el("div").class("tabbar").kid(tab("Likes", format!("/c/{h}/likes"), kind == "likes")).kid(tab("Recasts", format!("/c/{h}/recasts"), kind == "recasts")).kid(tab("Quotes", format!("/c/{h}/quotes"), kind == "quotes"));
    let list = if kind == "quotes" { feed(app, &format!("quotes:{h}"), "No quotes yet.", None) } else { people(app, &format!("{kind}:{h}"), "Nobody yet.") };
    s.kid(tabs).kid(list).into()
}

// --- channels ---

fn channel_row(c: &Channel) -> V {
    let mut row = link(format!("/channel/{}", c.id)).class("person").key(c.id.clone()).kid(chan_av(c.image.as_deref(), "sm")).kid(el("span").class("words").kid(el("bdi").class("name").txt(if c.name.is_empty() { c.id.clone() } else { c.name.clone() })).kid(el("span").class("handle").txt(format!("/{} · {} followers", c.id, text::count(c.followers)))));
    if let Some(d) = c.desc.as_deref().filter(|d| !d.is_empty()) {
        row = row.kid(el("span").class("bio").txt(d.chars().take(140).collect::<String>()));
    }
    row.into()
}

fn channel_list(app: &App, q: &str) -> V {
    let q2 = q.to_string();
    match app.channel_lists.get(q) {
        None | Some(Load::Loading) => spinner(),
        Some(Load::Failed(e)) => problem(e, move |a| {
            a.channel_lists.remove(&q2);
            a.load_channels(q2.clone())
        }),
        Some(Load::Ready(list)) if list.is_empty() => el("p").class("empty").txt(if q.is_empty() { "The channel list couldn't be loaded. Try again in a bit.".to_string() } else { format!("No channels match \u{201c}{q}\u{201d}.") }).into(),
        Some(Load::Ready(list)) => el("div").class("feed").kids(list.iter().map(channel_row)).into(),
    }
}

/// The channel directory: the top channels by followers, or the ones matching the search.
fn channels(app: &App) -> V {
    let search = el("div").class("search").kid(el("input").attr("type", "search").attr("placeholder", "Search channels").attr("aria-label", "Search channels").attr("autocomplete", "off").attr("value", app.channel_text.clone()).on(Ev::Input, |a, v| a.type_channel(v, false)));
    el("section").kid(header("Channels", false).kid(search)).kid(channel_list(app, &app.channel_term)).into()
}

/// A channel's page: farcaster.xyz's details for it and the casts under its URL, newest first.
fn channel(app: &App, id: &str) -> V {
    let c = match app.channels.get(id) {
        Some(Load::Ready(c)) => c,
        Some(Load::Failed(e)) => {
            let id2 = id.to_string();
            return el("section").kid(header(&format!("/{id}"), true)).kid(problem(e, move |a| {
                a.channels.remove(&id2);
                a.load_channel(id2.clone())
            })).into();
        }
        _ => return el("section").kid(header(&format!("/{id}"), true)).kid(spinner()).into(),
    };
    let c = c.clone().unwrap_or_else(|| Channel { id: id.to_string(), name: id.to_string(), url: default_channel_url(id), open: true, ..Default::default() });
    let name = if c.name.is_empty() { c.id.clone() } else { c.name.clone() };
    let mut top = el("div").class("profile channel");
    if let Some(h) = c.header.as_deref().and_then(text::safe_url) {
        top = top.kid(el("img").class("channel-header").attr("src", text::proxied(&text::sized(&h, "w=1200"))).attr("alt", "").attr("loading", "lazy"));
    }
    top = top.kid(chan_av(c.image.as_deref(), "lg")).kid(el("h2").kid(el("bdi").txt(name.clone())));
    let mut handle = el("div").class("handle").txt(format!("/{}", c.id));
    if !c.open {
        handle = handle.txt(" ").kid(el("span").class("pill").txt("Members only"));
    }
    top = top.kid(handle);
    if let Some(d) = c.desc.as_deref().filter(|d| !d.trim().is_empty()) {
        top = top.kid(rich(d));
    }
    if c.followers > 0 {
        top = top.kid(el("div").class("counts").kid(el("span").kid(el("strong").txt(text::count(c.followers))).txt(" followers")).kid(el("span").kid(el("strong").txt(text::count(c.members))).txt(" members")));
    }
    if app.account.is_some() {
        let cid = c.id.clone();
        top = top.kid(button("Cast here").class("btn primary").click(move |a| a.compose_in(&cid)));
    }
    let key = format!("channel:{}", app.channel_url(id));
    el("section").kid(header(&name, true)).kid(top).kid(feed(app, &key, "No casts in this channel yet.", None)).into()
}

// --- notifications ---

fn notifications(app: &App) -> V {
    let s = el("section").kid(header("Notifications", false));
    if app.account.is_none() {
        return s.kid(el("p").class("empty").txt("Sign in to see who liked, recast, replied to and followed you.")).into();
    }
    let f = &app.notes;
    let mut list = el("div").class("feed");
    let now = host::ms() as u64;
    for (i, n) in f.items.iter().enumerate() {
        if n.user.as_ref().is_some_and(|u| app.mutes.silenced(u.fid, now)) || n.cast.as_ref().is_some_and(|c| n.kind != "follows" && app.hidden(c, None)) {
            continue;
        }
        list = list.kid(note(app, n).key(format!("{i}:{}:{}", n.kind, n.timestamp)));
    }
    if let Some(e) = &f.error {
        list = list.kid(problem(e, |a| a.load_notes(false, true)));
    } else if f.loading {
        list = list.kid(spinner());
    } else if f.items.is_empty() {
        list = list.kid(el("p").class("empty").txt("Nothing yet."));
    } else if !f.done {
        list = list.kid(el("div").class("more").key(format!("more:{}", f.cursor.clone().unwrap_or_default())).on(Ev::Visible, |a, _| a.load_notes(true, false)).kid(button("Load more").class("btn").click(|a| a.load_notes(true, false))));
    }
    s.kid(list).into()
}

fn note(app: &App, n: &Notification) -> El {
    let (d, what) = match n.kind.as_str() {
        "likes" => (P_LIKE, "liked your cast"),
        "recasts" => (P_RECAST, "recast your cast"),
        "follows" => (P_USER, "followed you"),
        "reply" => (P_REPLY, "replied"),
        "mention" => (P_REPLY, "mentioned you"),
        "quote" => (P_QUOTE, "quoted your cast"),
        _ => (P_BELL, "did something"),
    };
    let who = n.user.clone().unwrap_or_default();
    let mut row = el("div").class(format!("note {}", n.kind)).kid(el("span").class("note-ic").kid(icon(d)));
    let mut body = el("div").class("body").kid(el("div").class("head").kid(link(who.path()).class("note-who").kid(avatar(&who, "xs")).kid(el("bdi").class("name").txt(who.name()))).kid(el("span").class("muted").txt(format!(" {what}"))).kid(el("span").class("time").txt(text::ago(&n.timestamp, host::ms()))));
    if let Some(c) = &n.cast {
        if n.kind != "follows" {
            let t = shown_text(c);
            let h = c.bare_hash();
            body = body.kid(link(format!("/c/{h}")).class("snippet").txt(t.chars().take(280).collect::<String>()));
            if matches!(n.kind.as_str(), "reply" | "mention" | "quote") {
                body = body.kid(actions(app, c));
            }
        }
    }
    row = row.kid(body);
    row
}

// --- search ---

fn search(app: &App, q: &str, t: Tab) -> V {
    let form = el("form").class("search").attr("role", "search").on(Ev::Submit, |a, _| {
        let q = a.search_text.trim().to_string();
        let tab = match a.route {
            Route::Search(_, Tab::Casts) => "&tab=casts",
            Route::Search(_, Tab::Channels) => "&tab=channels",
            _ => "",
        };
        a.navigate(&format!("/search?q={}{tab}", text::encode(&q)), false);
    })
    .kid(el("input").attr("type", "search").attr("name", "q").attr("placeholder", "Search people, casts and channels").attr("aria-label", "Search").attr("enterkeyhint", "search").attr("autocomplete", "off").attr("value", app.search_text.clone()).attr_if(q.is_empty(), "autofocus", "").on(Ev::Input, |a, v| a.search_text = v.to_string()))
    .kid(el("button").attr("type", "submit").class("btn").txt("Search"));
    let mut s = el("section").kid(header("Search", false).kid(form));
    if q.trim().is_empty() {
        return s.kid(el("p").class("empty").txt("Find people by name, casts by what they say, or channels.")).kid(el("p").class("center").kid(link("/channels").class("btn").txt("Browse channels"))).into();
    }
    let enc = text::encode(q.trim());
    s = s.kid(el("div").class("tabbar").kid(tab("People", format!("/search?q={enc}"), t == Tab::People)).kid(tab("Casts", format!("/search?q={enc}&tab=casts"), t == Tab::Casts)).kid(tab("Channels", format!("/search?q={enc}&tab=channels"), t == Tab::Channels)));
    match t {
        Tab::Casts => return s.kid(feed(app, &format!("search:{}", q.trim()), "No casts found.", None)).into(),
        Tab::Channels => return s.kid(channel_list(app, q.trim())).into(),
        Tab::People => {}
    }
    let q2 = q.trim().to_string();
    let now = host::ms() as u64;
    match app.people.get(q.trim()) {
        None | Some(Load::Loading) => s.kid(spinner()).into(),
        Some(Load::Failed(e)) => s.kid(problem(e, move |a| {
            a.people.remove(&q2);
            a.load_people(q2.clone())
        })).into(),
        Some(Load::Ready(users)) if users.is_empty() => s.kid(el("p").class("empty").txt("No one by that name.")).into(),
        Some(Load::Ready(users)) => s.kid(el("div").class("feed").kids(users.iter().filter(|u| !app.mutes.blocked(u.fid, now)).map(|u| person(u).into()))).into(),
    }
}

// --- signing in ---

fn join(app: &App) -> V {
    let adding = app.account.is_some();
    let s = el("section").kid(header(if adding { "Add account" } else { "Sign in" }, true));
    let j = &app.join;
    let working = j.step != JoinStep::Idle;
    let status = match j.step {
        JoinStep::Idle => None,
        JoinStep::Finding => Some("Finding your account…"),
        JoinStep::AddingKey => Some("Adding a key for this browser…"),
        JoinStep::Waiting => Some("Waiting for the network to take the key…"),
    };
    let form = el("form").class("join").on(Ev::Submit, |a, _| a.sign_in())
        .kid(el("label").attr("for", "phrase").txt("Recovery phrase"))
        .kid(el("textarea").attr("id", "phrase").attr("rows", "3").attr("autocomplete", "off").attr("autocapitalize", "none").attr("spellcheck", "false").attr("placeholder", "twelve or twenty-four words").attr("value", j.phrase.clone()).attr_if(working, "disabled", "").on(Ev::Input, |a, v| a.join.phrase = v.to_string()))
        .maybe(j.error.as_ref().map(|e| el("p").class("error").attr("role", "alert").txt(e.clone()).into()))
        .maybe(status.map(|t| el("p").class("muted").attr("role", "status").kid(spinner()).txt(t).into()))
        .kid(el("button").attr("type", "submit").class("btn primary").attr_if(working, "disabled", "").txt(if adding { "Add account" } else { "Sign in" }));
    s.kid(el("div").class("pane")
        .kid(el("p").txt(if adding {
            "Add another Farcaster account to this browser with its recovery phrase. Switch between your accounts in Settings."
        } else {
            "Sign in with the recovery phrase of your Farcaster account (the same one Warpcast, Quorum and Quilcast use)."
        }))
        .kid(form)
        .kid(el("p").class("muted small").txt("Your phrase never leaves this browser. It signs one message that adds a key for this browser to your account, and then it's forgotten: Quilcast WASM doesn't keep it. The key it adds is held by your browser, which can sign with it but won't hand it out."))
        .kid(el("p").class("muted small").kid(text("No account yet? ")).kid(external("https://quilcast.com/join").txt("Create one at quilcast.com")).kid(text("."))))
        .into()
}

// --- settings ---

fn settings(app: &App) -> V {
    let theme = |label: &'static str, v: &'static str| {
        el("label").class("choice").kid(el("input").attr("type", "radio").attr("name", "theme").attr("value", v).attr("checked", if app.settings.theme == v || (v == "system" && !matches!(app.settings.theme.as_str(), "light" | "dark")) { "true" } else { "" }).on(Ev::Change, move |a, _| {
            a.settings.theme = v.into();
            a.save_settings();
        })).kid(el("span").txt(label))
    };
    let mut s = el("section").kid(header("Settings", false));
    if app.account.is_some() {
        s = s.kid(accounts_pane(app)).kid(profile_pane(app)).kid(alerts_pane(app));
    }
    s = s.kid(el("div").class("pane").kid(el("h2").txt("Appearance")).kid(el("div").class("choices").attr("role", "radiogroup").attr("aria-label", "Theme").kid(theme("Match the system", "system")).kid(theme("Light", "light")).kid(theme("Dark", "dark"))));
    s = s.kid(el("form").class("pane").on(Ev::Submit, |a, _| a.set_node())
        .kid(el("h2").txt("Hypersnap node"))
        .kid(el("label").attr("for", "node").class("muted small").txt("Reads and writes go straight to this node."))
        .kid(el("div").class("row").kid(el("input").attr("id", "node").attr("type", "url").attr("value", app.node_text.clone()).attr("spellcheck", "false").on(Ev::Input, |a, v| a.node_text = v.to_string())).kid(el("button").attr("type", "submit").class("btn").txt("Save"))));
    s = s.kid(spam_pane(app)).kid(muted_pane(app)).kid(words_pane(app));
    if app.account.is_none() || !app.local.is_empty() {
        s = s.kid(local_pane(app));
    }
    s.kid(el("div").class("pane about")
        .kid(el("h2").txt("About"))
        .kid(el("p").txt(format!("Quilcast WASM {VERSION}: the Quilcast client written in Rust and compiled to WebAssembly. The module draws every page itself; a small script only hands it the browser.")))
        .kid(el("p").kid(external("https://git.borodutch.com/backmeupplz/quilcast/src/branch/main/wasm").txt("Source")).kid(text(" · ")).kid(external("https://quilcast.com").txt("The full Quilcast at quilcast.com"))))
        .into()
}

/// An account signed in here, as Settings lists it.
fn account_user(a: &crate::app::Account) -> User {
    User { fid: a.fid, username: a.username.clone(), display_name: a.display.clone(), pfp_url: a.pfp.clone(), ..Default::default() }
}

/// Settings → Accounts (src/app.tsx AccountList): every account signed in here, switching between them, adding one,
/// and signing out of the one in use.
fn accounts_pane(app: &App) -> V {
    let me = app.me();
    let out = app.busy.contains("signout");
    let mut list = el("div").class("rows accounts");
    for a in &app.accounts {
        let u = account_user(a);
        let on = me == Some(a.fid);
        let fid = a.fid;
        let who = el("span").class("who").kid(avatar(&u, "sm")).kid(el("span").class("names").kid(el("bdi").class("name").txt(u.name())).kid(el("span").class("muted small").txt(format!("@{}", u.handle()))));
        let row = el("div").class(if on { "row-item acct on" } else { "row-item acct" }).key(a.fid.to_string()).kid(who);
        list = list.kid(if on {
            row.kid(el("span").class("muted small").attr("aria-current", "true").txt("In use"))
        } else {
            row.kid(button("Switch").class("btn small").attr("aria-label", format!("Switch to @{}", u.handle())).attr_if(out, "disabled", "").click(move |a| a.switch_account(fid)))
        });
    }
    let name = app.account.as_ref().map(|a| account_user(a).handle()).unwrap_or_default();
    el("div").class("pane")
        .kid(el("h2").txt("Accounts"))
        .kid(list)
        .kid(el("div").class("row")
            .kid(link("/join").class("btn").txt("Add account"))
            .kid(button(&if out { "Signing out…".to_string() } else { format!("Sign out of @{name}") }).class("btn danger").attr_if(out, "disabled", "").click(|a| a.sign_out())))
        .into()
}

/// Settings → Profile (src/app.tsx Settings): the photo, name, bio and website, saved as the account's user data.
fn profile_pane(app: &App) -> V {
    use crate::compose::Step;
    use crate::me::{BIO, DISPLAY, FIELD_MAX, URL};
    let p = el("div").class("pane profile-edit").kid(el("h2").txt("Profile"));
    let Some(e) = app.edit.as_ref().filter(|e| Some(e.fid) == app.me()) else {
        return p.kid(spinner()).into();
    };
    if e.orig.is_none() {
        return match &e.error {
            Some(err) => p.kid(problem(err, |a| a.retry_edit())).into(),
            None => p.kid(spinner()).into(),
        };
    }
    let busy = e.saving;
    // the new photo while it's on its way, else the one the profile has
    let face: V = match e.photo.as_ref().and_then(|a| a.preview.clone()) {
        Some(src) if src.starts_with("blob:") => el("span").class("av lg").kid(el("img").attr("src", src).attr("alt", "")).into(),
        Some(src) => avatar(&User { pfp_url: Some(src), ..Default::default() }, "lg"),
        None => avatar(&User { pfp_url: Some(e.now.pfp.clone()).filter(|s| !s.is_empty()), ..Default::default() }, "lg"),
    };
    let state = e.photo.as_ref().and_then(|a| match &a.step {
        Step::Preparing => Some(("status", "Preparing…".to_string())),
        Step::Uploading(got, size) => Some(("status", format!("Uploading {}%", if *size > 0 { got * 100 / size } else { 0 }))),
        Step::Processing => Some(("status", "Processing…".into())),
        Step::Ready => None,
        Step::Failed(err) => Some(("alert", err.clone())),
    });
    let mut photo = el("div").class("photo-row").kid(face)
        .kid(el("label").class(if busy { "btn small off" } else { "btn small" })
            .kid(el("input").attr("type", "file").class("file").attr("accept", "image/jpeg,image/png,image/webp,image/gif").attr("aria-label", "Change photo").attr_if(busy, "disabled", "").on(Ev::Change, |a, v| a.pick_photo(v)))
            .kid(el("span").txt("Change photo")));
    if e.photo.is_some() {
        photo = photo.kid(button("Keep the old one").class("btn small").attr_if(busy, "disabled", "").click(|a| a.unpick_photo()));
    }
    if let Some((role, t)) = state {
        photo = photo.kid(el("span").class("muted small").attr("role", role).txt(t));
    }
    let field = |k: u64, id: &'static str, label: &'static str, ph: &'static str, area: bool| -> V {
        let input = if area { el("textarea").attr("rows", "3") } else { el("input").attr("type", if k == URL { "url" } else { "text" }) };
        let input = input.attr("id", id).attr("placeholder", ph).attr("maxlength", FIELD_MAX.to_string()).attr("value", e.now.get(k).to_string()).attr_if(busy, "disabled", "").on(Ev::Input, move |a, v| a.edit_field(k, v));
        el("div").class("field").kid(el("label").attr("for", id).class("muted small").txt(label)).kid(input).into()
    };
    let changed = !e.changes().is_empty();
    let mut p = p.kid(photo)
        .kid(field(DISPLAY, "edit-name", "Name", "Your name", false))
        .kid(field(BIO, "edit-bio", "Bio", "A line or two about you", true))
        .kid(field(URL, "edit-url", "Website", "https://…", false));
    if changed || busy {
        p = p.kid(button(if busy { "Saving…" } else { "Save changes" }).class("btn primary").attr_if(busy || e.photo_busy(), "disabled", "").click(|a| a.save_profile()));
    }
    p.into()
}

/// Settings → Notifications (src/app.tsx AlertSettings): push notifications for each account's activity on this
/// device, and the kinds each one gets (src/alerts.rs).
fn alerts_pane(app: &App) -> V {
    let p = el("div").class("pane alerts").kid(el("h2").txt("Notifications"));
    let p = match app.push.can {
        None => return p.kid(spinner()).into(),
        Some(false) => return p.kid(el("p").class("muted small").txt("This browser can't show notifications. On iPhone and iPad, add this site to your Home Screen (Share, then Add to Home Screen) and open it from there to get them.")).into(),
        Some(true) => p,
    };
    let on = app.alerts_on();
    let mut p = p;
    for a in &app.accounts {
        let fid = a.fid;
        let kinds = on.get(&fid);
        let busy = app.alerts_busy(fid);
        let handle = account_user(a).handle();
        let mut row = el("div").class("alert-acct").key(fid.to_string())
            .kid(el("div").class("setting")
                .kid(el("span").txt(format!("Push notifications for @{handle}")))
                .kid(button(if busy { "Working…" } else if kinds.is_some() { "Turn off" } else { "Turn on" }).class("btn small").attr("aria-label", format!("{} push notifications for @{handle}", if kinds.is_some() { "Turn off" } else { "Turn on" })).attr_if(busy, "disabled", "").click(move |a| a.toggle_alerts(fid))));
        if let Some(kinds) = kinds {
            let mut g = el("div").class("alert-kinds").attr("role", "group").attr("aria-label", format!("Kinds for @{handle}"));
            for (k, label) in crate::alerts::KINDS {
                let has = kinds.iter().any(|x| x == k);
                // at least one kind stays on: turning the account off is the button above
                let last = has && kinds.len() == 1;
                // keyed by its state too, so a change the server refused is drawn back as it was
                g = g.kid(el("label").class("check").key(format!("{k}:{has}:{busy}"))
                    .kid(el("input").attr("type", "checkbox").attr("checked", if has { "true" } else { "" }).attr_if(busy || last, "disabled", "").on(Ev::Change, move |a, _| a.toggle_alert_kind(fid, k)))
                    .kid(el("span").txt(label)));
            }
            row = row.kid(g);
        }
        p = p.kid(row);
    }
    if app.push.perm == "denied" {
        p = p.kid(el("p").class("muted small").attr("role", "alert").txt(crate::alerts::BLOCKED));
    }
    p.kid(el("p").class("muted small").txt("Replies, mentions, quotes, likes, recasts and follows reach this device even with Quilcast closed. Quilcast's server looks for them once a minute. It keeps your Farcaster ID with this browser's push subscription and these settings, and for a few minutes which notifications it already sent; signing out removes them. People you mute or block, muted words and spam you hide stay out.")).into()
}

/// Settings → Spam (src/app.tsx): show spam with its label or hide it, for casts and for spam accounts' casts, and
/// the score from which they count.
fn spam_pane(app: &App) -> V {
    let seg = |label: &'static str, accounts: bool| {
        let now = if accounts { &app.settings.spam_accounts } else { &app.settings.spam };
        let mut g = el("div").class("seg").attr("role", "group").attr("aria-label", label);
        for (v, shown) in [("show", "Show"), ("hide", "Hide")] {
            g = g.kid(button(shown).class(if now.as_str() == v || (v == "show" && now != "hide") { "on" } else { "" }).attr("aria-pressed", (now.as_str() == v || (v == "show" && now != "hide")).to_string()).click(move |a| {
                if accounts {
                    a.settings.spam_accounts = v.into();
                } else {
                    a.settings.spam = v.into();
                }
                a.save_settings();
                a.spam_changed();
            }));
        }
        el("div").class("setting").kid(el("span").txt(label)).kid(g)
    };
    let at = app.spam_at();
    el("div").class("pane")
        .kid(el("h2").txt("Spam"))
        .kid(seg("Spam casts", false))
        .kid(seg("Spam accounts", true))
        .kid(el("label").class("setting").kid(el("span").txt("Spam threshold")).kid(el("span").class("range").kid(el("input").attr("type", "range").attr("min", "50").attr("max", "99").attr("value", at.to_string()).attr("aria-label", "Spam threshold").on(Ev::Input, |a, v| {
            if let Ok(n) = v.parse::<u32>() {
                a.settings.spam_at = n.clamp(50, 99);
                a.save_settings();
                a.spam_changed();
            }
        })).kid(el("output").txt(format!("{at}%")))))
        .kid(el("p").class("muted small").txt("Casts at least this likely to be spam get a label with the odds, or are hidden. Our own Laya model reads every new cast. Accounts are judged from their profile and recent casts; hiding a spam account takes its casts and replies out everywhere."))
        .into()
}

fn until(t: Option<u64>) -> String {
    match t {
        Some(ms) => format!("until {}", text::iso(ms as f64).chars().take(10).collect::<String>()),
        None => "for good".into(),
    }
}

/// Settings → Muted and blocked: who, until when, and lifting it.
fn muted_pane(app: &App) -> V {
    let mut p = el("div").class("pane").kid(el("h2").txt("Muted and blocked")).kid(el("p").class("muted small").txt(if app.account.is_some() {
        "Their casts and notifications stay out of sight. The list is kept with your account on Quilcast's server, signed with your key, so quilcast.com and your other devices use it too."
    } else {
        "Their casts stay out of sight. Signed out, the list is kept in this browser."
    }));
    let rows: Vec<(bool, u64, Option<u64>)> = app.mutes.blocks.iter().map(|x| (true, x.v, x.until)).chain(app.mutes.users.iter().map(|x| (false, x.v, x.until))).collect();
    if rows.is_empty() {
        return p.kid(el("p").class("muted").txt("No one yet. Mute or block someone from the ⋯ menu on their cast or profile.")).into();
    }
    let mut list = el("div").class("rows");
    let more = rows.len().saturating_sub(MUTED_SHOWN);
    for (block, fid, t) in rows.into_iter().take(MUTED_SHOWN) {
        let u = match app.profiles.get(&fid.to_string()) {
            Some(Load::Ready(u)) => u.clone(),
            None => {
                app.wants.borrow_mut().push(Want::User(fid));
                User { fid, ..Default::default() }
            }
            _ => User { fid, ..Default::default() },
        };
        let u2 = u.clone();
        list = list.kid(el("div").class("row-item").key(format!("{block}:{fid}"))
            .kid(link(u.path()).class("who").kid(avatar(&u, "xs")).kid(el("bdi").class("name").txt(u.name())))
            .kid(el("span").class("muted small").txt(format!("{} {}", if block { "Blocked" } else { "Muted" }, until(t))))
            .kid(button(if block { "Unblock" } else { "Unmute" }).class("btn small").click(move |a| a.mute(block, &u2, false, None))));
    }
    p = p.kid(list);
    if more > 0 {
        p = p.kid(el("p").class("muted small").txt(format!("And {more} more.")));
    }
    p.into()
}
/// How many muted and blocked people Settings lists (each needs their name read).
const MUTED_SHOWN: usize = 200;

/// Settings → Muted words.
fn words_pane(app: &App) -> V {
    // radio chips rather than a <select>: WebKit draws a select with an inline stylesheet the page's CSP refuses
    let mut span = el("div").class("choices").attr("role", "radiogroup").attr("aria-label", "For how long");
    for (i, (label, _)) in crate::mutes::SPANS.iter().enumerate() {
        span = span.kid(el("label").class("choice small").kid(el("input").attr("type", "radio").attr("name", "word-span").attr("value", i.to_string()).attr("checked", if i == app.word_span { "true" } else { "" }).on(Ev::Change, move |a, _| a.word_span = i)).kid(el("span").txt(*label)));
    }
    let form = el("form").class("row").on(Ev::Submit, |a, _| {
        let w = a.word_text.clone();
        let span = crate::mutes::SPANS.get(a.word_span).and_then(|s| s.1).map(|d| host::ms() as u64 + d);
        a.mute_word(&w, true, span);
        a.word_text.clear();
    })
    .kid(el("input").attr("type", "search").attr("aria-label", "A word to mute").attr("placeholder", "A word, phrase or site.com").attr("maxlength", "60").attr("value", app.word_text.clone()).on(Ev::Input, |a, v| a.word_text = v.to_string()))
    .kid(el("button").attr("type", "submit").class("btn").txt("Mute"));
    let mut p = el("div").class("pane").kid(el("h2").txt("Muted words")).kid(el("p").class("muted small").txt("Casts with these words in them are hidden, whole words only and in any case.")).kid(form).kid(span);
    let mut list = el("div").class("chips");
    for w in &app.mutes.words {
        let v = w.v.clone();
        list = list.kid(el("span").class("chip").key(w.v.clone()).kid(el("bdi").txt(w.v.clone())).kid(el("span").class("muted small").txt(until(w.until))).kid(button("").class("icon-btn tiny").attr("aria-label", format!("Unmute {}", w.v)).kid(icon(P_X)).click(move |a| a.mute_word(&v, false, None))));
    }
    if !app.mutes.words.is_empty() {
        p = p.kid(list);
    }
    p.into()
}

/// Settings → Following on this device (anonymous mode).
fn local_pane(app: &App) -> V {
    let mut p = el("div").class("pane").kid(el("h2").txt("Following on this device")).kid(el("p").class("muted small").txt(format!(
        "Without an account, Follow keeps people in this list (up to {LOCAL_MAX}), and Home's Following tab shows their casts. Nothing is published, and clearing this site's data loses the list, so copy it somewhere to keep it."
    )));
    if app.local.is_empty() {
        p = p.kid(el("p").class("muted").txt("No one yet."));
    } else {
        let mut list = el("div").class("rows");
        for l in &app.local {
            let u = User { fid: l.fid, username: l.username.clone(), ..Default::default() };
            let u2 = u.clone();
            list = list.kid(el("div").class("row-item").key(l.fid.to_string()).kid(link(u.path()).class("who").txt(format!("@{}", u.handle()))).kid(button("Unfollow").class("btn small").click(move |a| a.set_local(&u2, false))));
        }
        p = p.kid(list).kid(el("div").class("row").kid(button("Copy the list").class("btn").click(|a| {
            host::clip(&a.export_local());
            a.say("Copied. Paste it under Import on another device.");
        })).maybe(app.account.is_some().then(|| {
            let busy = app.busy.contains("follow-all");
            button(if busy { "Following…" } else { "Follow them on Farcaster" }).class("btn primary").attr_if(busy, "disabled", "").click(|a| a.follow_local_all()).into()
        })));
    }
    p.kid(el("form").class("join").on(Ev::Submit, |a, _| a.import_local())
        .kid(el("label").attr("for", "import").txt("Import"))
        .kid(el("textarea").attr("id", "import").attr("rows", "3").attr("placeholder", "A copied list, or FIDs and @names (also profile links)").attr("spellcheck", "false").attr("value", app.import_text.clone()).on(Ev::Input, |a, v| a.import_text = v.to_string()))
        .kid(el("button").attr("type", "submit").class("btn").txt("Import")))
        .into()
}

// --- menus over the page ---

fn sheet(app: &App, s: &Sheet) -> V {
    let close = |title: &str| el("div").class("dialog-head").kid(button("").class("icon-btn").attr("aria-label", "Close").kid(icon(P_X)).click(|a| a.sheet = None)).kid(el("strong").txt(title.to_string()));
    let item = |label: String| button("").class("menu-item").txt(label);
    let now = host::ms() as u64;
    let me = app.me();
    // mute, block and report for someone other than the account
    let about = |u: &User, hash: Option<String>| -> Vec<V> {
        if Some(u.fid) == me {
            return Vec::new();
        }
        let (u1, u2, u3) = (u.clone(), u.clone(), u.clone());
        let muted = app.mutes.muted(u.fid, now);
        let blocked = app.mutes.blocked(u.fid, now);
        // on a cast or an account spam.quilcast.com labelled: one tap tells Quilcast the label is wrong
        let cast_spam = hash.as_ref().is_some_and(|h| app.spam.casts.get(h).is_some_and(|s| s * 100.0 >= app.spam_at() as f64));
        let labelled = cast_spam || app.spam_account_of(u.fid).is_some();
        let (fid, h2) = (u.fid, hash.clone());
        let not_spam: Option<V> = labelled.then(|| item("Not spam".into()).click(move |a| a.not_spam(fid, h2.clone())).into());
        not_spam.into_iter().chain([
            item(format!("{} @{}", if muted { "Unmute" } else { "Mute" }, u.handle())).click(move |a| if muted { a.mute(false, &u1, false, None) } else { a.sheet = Some(Sheet::Mute(false, u1.clone())) }).into(),
            item(format!("{} @{}", if blocked { "Unblock" } else { "Block" }, u.handle())).class("menu-item danger").click(move |a| if blocked { a.mute(true, &u2, false, None) } else { a.sheet = Some(Sheet::Mute(true, u2.clone())) }).into(),
            item(if hash.is_some() { "Report this cast".into() } else { format!("Report @{}", u.handle()) }).class("menu-item danger").click(move |a| a.open_report(&u3, hash.clone())).into(),
        ]).collect()
    };
    let d = match s {
        Sheet::Cast(c) => {
            let h = c.bare_hash();
            let (c1, c2) = (c.clone(), c.clone());
            let mut d = el("div").class("dialog menu").attr("role", "dialog").attr("aria-modal", "true").attr("aria-label", "Cast menu").kid(close("Cast"))
                .kid(item("Copy link".into()).click(move |a| {
                    host::clip(&format!("{}/c/{h}", host::site()));
                    a.sheet = None;
                    a.say("Link copied");
                }))
                .kid(item("Quote".into()).click(move |a| a.open_compose(None, Some(c1.clone()))));
            if let Some(m) = me.filter(|m| c.author.fid == *m) {
                if !app.pins.contains_key(&m) {
                    app.wants.borrow_mut().push(Want::Pin(m));
                }
                let h2 = c.bare_hash();
                // a reply can't be pinned here, but one pinned elsewhere can be unpinned (src/ui.tsx isPin)
                if app.pinned(m) == Some(h2.as_str()) {
                    d = d.kid(item("Unpin from profile".into()).click(|a| a.set_pin(None)));
                } else if c.parent_hash.is_none() {
                    d = d.kid(item("Pin to profile".into()).attr_if(matches!(app.pins.get(&m), Some(Load::Loading)), "disabled", "").click(move |a| a.set_pin(Some(h2.clone()))));
                }
            }
            if Some(c.author.fid) == me {
                d = d.kid(item("Delete".into()).class("menu-item danger").click(move |a| {
                    a.sheet = None;
                    a.delete_cast(&c2)
                }));
            }
            d.kids(about(&c.author, Some(c.bare_hash())))
        }
        Sheet::User(u) => {
            let path = u.path();
            el("div").class("dialog menu").attr("role", "dialog").attr("aria-modal", "true").attr("aria-label", "Profile menu").kid(close(&format!("@{}", u.handle())))
                .kid(link(App::browse_path(u)).class("menu-item").txt(format!("Browse as @{}", u.handle())))
                .kid(item("Copy profile link".into()).click(move |a| {
                    host::clip(&format!("{}{path}", host::site()));
                    a.sheet = None;
                    a.say("Link copied");
                }))
                .kids(about(u, None))
        }
        Sheet::Mute(block, u) => {
            let title = format!("{} @{}", if *block { "Block" } else { "Mute" }, u.handle());
            let what = if *block {
                "Their casts are hidden everywhere, even on their profile, and you stop following them. They aren't told."
            } else {
                "Their casts and notifications are hidden, except on their profile. They aren't told."
            };
            let mut d = el("div").class("dialog menu").attr("role", "dialog").attr("aria-modal", "true").attr("aria-label", title.clone()).kid(close(&title)).kid(el("p").class("muted small").txt(what));
            for (label, span) in crate::mutes::SPANS {
                let (u2, block) = (u.clone(), *block);
                d = d.kid(item(label.to_string()).click(move |a| {
                    a.sheet = None;
                    a.mute(block, &u2, true, span.map(|s| host::ms() as u64 + s))
                }));
            }
            d
        }
        Sheet::Report(r) => {
            let title = if r.hash.is_some() { "Report this cast".to_string() } else { format!("Report @{}", r.who) };
            let mut reasons = el("div").class("choices col").attr("role", "radiogroup").attr("aria-label", "Why");
            for (v, label) in REASONS {
                reasons = reasons.kid(el("label").class("choice").kid(el("input").attr("type", "radio").attr("name", "reason").attr("value", v).attr("checked", if r.reason == v { "true" } else { "" }).on(Ev::Change, move |a, _| {
                    if let Some(Sheet::Report(r)) = a.sheet.as_mut() {
                        r.reason = v;
                    }
                })).kid(el("span").txt(label)));
            }
            el("form").class("dialog menu").attr("role", "dialog").attr("aria-modal", "true").attr("aria-label", title.clone()).on(Ev::Submit, |a, _| a.send_report()).kid(close(&title))
                .kid(el("p").class("muted small").txt("Reports go to Quilcast's moderators, who look at each one within a day."))
                .kid(reasons)
                .kid(el("textarea").attr("rows", "3").attr("maxlength", "1000").attr("aria-label", "Anything else (optional)").attr("placeholder", "Anything else (optional)").attr("value", r.text.clone()).on(Ev::Input, |a, v| {
                    if let Some(Sheet::Report(r)) = a.sheet.as_mut() {
                        r.text = v.to_string();
                    }
                }))
                .maybe(r.error.as_ref().map(|e| el("p").class("error").attr("role", "alert").txt(e.clone()).into()))
                .kid(el("div").class("dialog-foot").kid(el("button").attr("type", "submit").class("btn primary").attr_if(r.sending, "disabled", "").txt(if r.sending { "Sending…" } else { "Send report" })))
        }
    };
    el("div").class("scrim").kid(d).into()
}

// --- the composer ---

fn composer(app: &App, c: &Compose) -> V {
    use crate::compose::Panel;
    let title = if c.parent.is_some() { "Reply" } else if c.quote.is_some() || c.quote_wait.is_some() { "Quote" } else { "New cast" };
    let signed_in = app.account.is_some();
    let empty = c.empty();
    let fresh = c.draft.is_none() && c.sched.is_none();
    let mut head = el("div").class("dialog-head").kid(button("").class("icon-btn").attr("aria-label", "Close").kid(icon(P_X)).click(|a| a.close_compose())).kid(el("strong").txt(title));
    if signed_in && fresh && !c.sending && (empty || matches!(c.panel, Some(Panel::Drafts | Panel::Scheduled))) {
        let on_d = matches!(c.panel, Some(Panel::Drafts));
        let on_s = matches!(c.panel, Some(Panel::Scheduled));
        head = head.kid(el("span").class("head-links")
            .kid(button("Drafts").class(if on_d { "link-btn on" } else { "link-btn" }).attr("aria-pressed", on_d.to_string()).click(move |a| if on_d { a.close_compose() } else { a.open_drafts() }))
            .kid(button("Scheduled").class(if on_s { "link-btn on" } else { "link-btn" }).attr("aria-pressed", on_s.to_string()).click(move |a| if on_s { a.close_compose() } else { a.open_scheduled() })));
    }
    let mut d = el("div").class("dialog compose").attr("role", "dialog").attr("aria-modal", "true").attr("aria-label", title).kid(head);
    if c.asking {
        d = d.kid(el("div").class("draft-ask").attr("role", "alertdialog").attr("aria-label", "Save this as a draft?")
            .kid(el("span").txt("Save this as a draft?"))
            .kid(button("Discard").class("btn").attr_if(c.sending, "disabled", "").click(|a| a.discard_compose()))
            .kid(button(if c.sending { "Saving…" } else { "Save draft" }).class("btn primary").attr_if(c.sending, "disabled", "").attr("autofocus", "").click(|a| a.save_draft())))
            .maybe(c.error.as_ref().map(|e| el("p").class("error").attr("role", "alert").txt(e.clone()).into()));
        return el("div").class("scrim").kid(d).into();
    }
    match &c.panel {
        Some(Panel::Drafts) => return el("div").class("scrim").kid(d.kid(drafts_pane(app))).into(),
        Some(Panel::Scheduled) => return el("div").class("scrim").kid(d.kid(scheduled_pane(app))).into(),
        Some(Panel::Gifs(q)) => return el("div").class("scrim").kid(d.kid(gifs_pane(app, q))).into(),
        Some(Panel::Emoji(q, g)) => return el("div").class("scrim").kid(d.kid(emoji_pane(q, *g))).into(),
        Some(Panel::Stickers(t)) => return el("div").class("scrim").kid(d.kid(stickers_pane(app, *t))).into(),
        None => {}
    }
    if let Some(p) = &c.parent {
        let what = if c.parent_lost { "Replying to a cast that can't be loaded right now. Save it as a draft and try again later.".to_string() } else { format!("Replying to @{}: {}", p.author.handle(), shown_text(p).chars().take(140).collect::<String>()) };
        d = d.kid(el("div").class("replying").kid(avatar(&p.author, "xs")).kid(el("span").txt(what)));
    }
    let me = app.account.as_ref().map(|a| User { fid: a.fid, pfp_url: a.pfp.clone(), ..Default::default() }).unwrap_or_default();
    // each post of the thread: its text, the people an @name could be, and its pictures, videos and GIFs
    let cur = c.cur();
    let count = c.posts.len();
    let mut parts = el("div").class("parts");
    for (i, p) in c.posts.iter().enumerate() {
        let placeholder = if i > 0 { "Add another post" } else if c.parent.is_some() { "Write your reply" } else if c.quote.is_some() || c.quote_wait.is_some() { "Add a comment" } else { "What's happening?" };
        let label = if count > 1 { format!("Post {} of {count}", i + 1) } else { title.to_string() };
        let mut ta = el("textarea").attr("aria-label", label).attr("placeholder", placeholder).attr("rows", if count == 1 { "5" } else { "3" }).attr("value", p.text.clone()).attr("data-caret", "").attr_if(c.sending, "disabled", "")
            .attr("aria-autocomplete", "list")
            .on(Ev::Input, move |a, v| a.type_post(i, v))
            .on(Ev::Key, move |a, k| match k {
                "Escape" => a.close_compose(),
                "Enter+mod" => a.send_compose(),
                // Backspace in an empty post takes it out of the thread (src/compose.tsx keys)
                "Backspace" if i > 0 && a.compose.as_ref().and_then(|c| c.posts.get(i)).is_some_and(|p| p.text.is_empty() && p.media.is_empty()) => a.remove_post(i),
                _ => {}
            });
        if i == cur {
            ta = ta.attr("autofocus", c.focus.to_string()).attr("data-sel", crate::compose::utf16_at(&p.text, p.caret).to_string()).attr_if(!c.suggest.is_empty(), "aria-controls", "mention-list");
        }
        let mut row = el("div").class("compose-row").kid(avatar(&me, "sm")).kid(ta);
        if i > 0 {
            row = row.kid(button("").class("icon-btn tiny part-x").attr("aria-label", format!("Remove post {}", i + 1)).attr_if(c.sending, "disabled", "").kid(icon(P_X)).click(move |a| a.remove_post(i)));
        }
        let mut part = el("div").class(if i + 1 < count { "part threaded" } else { "part" }).key(format!("post{}", p.id)).kid(row);
        if i == cur && c.typing.is_some() && !c.suggest.is_empty() {
            let mut list = el("div").class("suggest").attr("id", "mention-list").attr("role", "listbox").attr("aria-label", "People");
            for u in &c.suggest {
                let name = u.username.clone().unwrap_or_default();
                list = list.kid(button("").class("menu-item person-opt").attr("role", "option").key(u.fid.to_string()).kid(avatar(u, "xs")).kid(el("bdi").txt(u.name())).kid(el("span").class("muted small").txt(format!("@{name}"))).click(move |a| a.pick_mention(&name)));
            }
            part = part.kid(list);
        }
        if !p.media.is_empty() {
            part = part.kid(attachments(&p.media, c.sending));
        }
        if p.text.len() > MAX_CAST {
            part = part.kid(el("p").class("error small").attr("role", "alert").txt(format!("This post is {} characters too long.", p.text.len() - MAX_CAST)));
        }
        parts = parts.kid(part);
    }
    d = d.kid(parts);
    if c.parent.is_none() {
        d = d.kid(channel_picker(app, c));
    }
    if let Some(q) = &c.quote {
        d = d.kid(el("div").class("quote").kid(el("span").class("qhead").kid(avatar(&q.author, "xs")).kid(el("bdi").class("name").txt(q.author.name()))).kid(el("span").class("qtext").txt(shown_text(q).chars().take(200).collect::<String>())));
    } else if c.quote_wait.is_some() {
        d = d.kid(el("div").class("quote").kid(el("span").class("muted").txt("Loading the quoted cast…")));
    }
    if c.timing {
        let min = host::time_str(host::ms() + crate::compose::SOONEST, true);
        let max = host::time_str(host::ms() + crate::compose::LATEST, true);
        d = d.kid(el("div").class("timing")
            .kid(el("label").kid(el("span").txt("Post at")).kid(el("input").attr("type", "datetime-local").attr("min", min).attr("max", max).attr("value", c.when.clone()).attr_if(c.sending, "disabled", "").on(Ev::Change, |a, v| {
                if let Some(c) = a.compose.as_mut() {
                    c.when = v.to_string();
                    c.error = None;
                }
            })))
            .kid(button("Post now instead").class("btn small").attr_if(c.sending, "disabled", "").click(|a| {
                if let Some(c) = a.compose.as_mut() {
                    c.when.clear();
                    c.timing = false;
                }
            })));
    }
    if let Some(e) = &c.error {
        d = d.kid(el("p").class("error").attr("role", "alert").txt(e.clone()));
    }
    let used = c.posts.get(cur).map_or(0, |p| p.text.len());
    let over = used > MAX_CAST;
    let full = app.room() == 0;
    let off = full || c.sending;
    let tools = el("span").class("tools")
        .kid(el("label").class(if off { "icon-btn off" } else { "icon-btn" }).attr("title", "Add photos or videos")
            .kid(el("input").attr("type", "file").class("file").attr("accept", "image/*,video/mp4,video/webm,video/quicktime").attr("multiple", "").attr("aria-label", "Add photos or videos").attr_if(off, "disabled", "").on(Ev::Change, |a, v| a.attach(v)))
            .kid(icon(P_IMAGE)))
        .kid(button("GIF").class("icon-btn gif").attr("aria-label", "Add a GIF").attr_if(off, "disabled", "").click(|a| a.open_gifs()))
        .kid(button("").class("icon-btn").attr("aria-label", "Add a sticker").attr("title", "Add a sticker").attr_if(off, "disabled", "").kid(icon(P_STICKER)).click(|a| a.open_stickers()))
        .kid(button("").class("icon-btn").attr("aria-label", "Add an emoji").attr("title", "Add an emoji").attr_if(c.sending, "disabled", "").kid(icon(P_SMILE)).click(|a| a.open_emoji()))
        .kid(button("").class(if c.timing { "icon-btn on" } else { "icon-btn" }).attr("aria-label", "Schedule").attr("aria-pressed", c.timing.to_string()).attr_if(c.sending || c.posted.is_some(), "disabled", "").kid(icon(P_CLOCK)).click(|a| {
            if let Some(c) = a.compose.as_mut() {
                c.timing = !c.timing;
                if !c.timing {
                    c.when.clear();
                }
            }
        }))
        .kid(button("").class("icon-btn add-part").attr("aria-label", "Add another post to the thread").attr("title", "Add another post to the thread").attr_if(!c.can_add(), "disabled", "").kid(icon(P_PLUS)).click(|a| a.add_post()));
    let thread = App::parts(c).len() > 1;
    let label = match (c.sending, !c.when.is_empty(), thread) {
        (true, true, _) => "Scheduling…",
        (true, false, _) => "Casting…",
        (false, true, _) => "Schedule",
        (false, false, true) => "Post all",
        (false, false, false) if c.parent.is_some() => "Reply",
        (false, false, false) => "Cast",
    };
    d = d.kid(el("div").class("dialog-foot").kid(tools).kid(el("span").class(if over { "count over" } else { "count" }).attr("aria-live", "polite").txt(format!("{used}/{MAX_CAST}"))).kid(button(label).class("btn primary").attr_if(!App::can_send(c), "disabled", "").click(|a| a.send_compose())));
    el("div").class("scrim").kid(d).into()
}

/// A post's pictures, videos and GIFs in the composer, each with how its upload is going.
fn attachments(media: &[crate::compose::Attach], sending: bool) -> V {
    use crate::compose::Step;
    let mut row = el("div").class("attachments");
    for m in media {
        let n = m.n;
        let state = match &m.step {
            Step::Preparing => Some("Preparing…".to_string()),
            Step::Uploading(got, size) => Some(format!("Uploading {}%", if *size > 0 { got * 100 / size } else { 0 })),
            Step::Processing => Some("Processing…".into()),
            Step::Ready => None,
            Step::Failed(e) => Some(e.clone()),
        };
        let sticker = m.url.as_deref().and_then(crate::compose::sticker_pack).is_some();
        let thumb: V = match (&m.preview, m.video) {
            (Some(p), false) => el("img").attr("src", if p.starts_with("blob:") || sticker { p.clone() } else { text::proxied(p) }).attr("alt", "").into(),
            _ => el("span").class("vid").txt(if m.name.is_empty() { "Video".to_string() } else { m.name.clone() }).into(),
        };
        let failed = matches!(m.step, Step::Failed(_));
        row = row.kid(el("div").class(if failed { "attach failed" } else if sticker { "attach sticker" } else { "attach" }).key(n.to_string()).kid(thumb)
            .maybe(state.map(|s| el("span").class("attach-state").attr("role", if failed { "alert" } else { "status" }).txt(s).into()))
            .kid(button("").class("icon-btn tiny attach-x").attr("aria-label", "Remove").attr_if(sending, "disabled", "").kid(icon(P_X)).click(move |a| a.unattach(n))));
    }
    row.into()
}

fn drafts_pane(app: &App) -> V {
    let mut p = el("div").class("drafts");
    if app.drafts_key.is_none() {
        return p.kid(spinner()).into();
    }
    if app.drafts_key != Some(true) {
        return p.kid(el("p").class("muted").txt("Drafts are sealed with a key your recovery phrase makes, so only you can read them. Sign out and sign in again with your recovery phrase to keep drafts in this browser.")).into();
    }
    let now = host::ms();
    match &app.drafts {
        Some(Load::Ready(l)) if l.is_empty() => p = p.kid(el("p").class("muted").txt("No drafts yet.")),
        Some(Load::Ready(l)) => {
            for d in l {
                let (d1, id) = (d.clone(), d.id.clone());
                let first = d.parts.first().map(|p| p.text.trim().to_string()).unwrap_or_default();
                let mut what = vec![text::ago(&text::iso(d.at as f64), now)];
                if d.parts.len() > 1 {
                    what.push("Thread".into());
                }
                if d.parent.is_some() {
                    what.push("Reply".into());
                } else if d.quote.is_some() {
                    what.push("Quote".into());
                }
                what.extend(d.channel.as_ref().map(|c| format!("/{c}")));
                p = p.kid(el("div").class("draft").key(d.id.clone())
                    .kid(button("").class("draft-open").kid(el("span").class("clamp").txt(if first.is_empty() { "…".to_string() } else { first })).kid(el("small").class("muted").txt(what.join(" · "))).click(move |a| a.open_draft(&d1, None)))
                    .kid(button("").class("icon-btn").attr("aria-label", "Delete draft").kid(icon(P_X)).click(move |a| a.drop_draft(&id, false))));
            }
        }
        Some(Load::Failed(e)) => p = p.kid(problem(e, |a| a.load_drafts())),
        Some(Load::Loading) => p = p.kid(spinner()),
        None => {
            app.wants.borrow_mut().push(Want::Drafts);
            p = p.kid(spinner());
        }
    }
    p.into()
}

fn scheduled_pane(app: &App) -> V {
    let mut p = el("div").class("drafts");
    match &app.scheduled {
        Some(Load::Ready(l)) if l.is_empty() => p = p.kid(el("p").class("muted").txt("Nothing scheduled. Write a cast and pick a time with the clock.")),
        Some(Load::Ready(l)) => {
            for s in l {
                let first = s.draft.as_ref().and_then(|d| d.parts.first()).map(|p| p.text.trim().to_string()).filter(|t| !t.is_empty()).unwrap_or_else(|| "…".into());
                let part = if s.hashes.len() > 1 { format!(" · Thread of {}", s.hashes.len()) } else { String::new() };
                let state = match s.status.as_str() {
                    "posted" => "Posted".to_string(),
                    "posting" => "Sending…".to_string(),
                    "failed" => format!("Failed: {}", s.error.clone().unwrap_or_default()),
                    _ if s.posted > 0 => format!("{} of {} sent", s.posted, s.hashes.len()),
                    _ => "Waiting".to_string(),
                };
                let mut row = el("div").class(if s.status == "failed" { "draft failed" } else { "draft" }).key(s.id.clone())
                    .kid(el("div").class("draft-open").kid(el("span").class("clamp").txt(first)).kid(el("small").class("muted").txt(format!("{}{part} · {state}", host::time_str(s.at as f64, false)))));
                let id = s.id.clone();
                match s.status.as_str() {
                    "posted" => {
                        row = row.kid(link(format!("/c/{}", s.hash.trim_start_matches("0x"))).class("btn small").txt("View"));
                        row = row.kid(button("Remove").class("btn small").click(move |a| a.cancel_scheduled(&id, false)));
                    }
                    "posting" => {}
                    _ => {
                        if let Some(d) = s.draft.clone().filter(|_| s.posted == 0) {
                            let (sched, at) = (crate::compose::Sched { id: s.id.clone(), waiting: s.status == "scheduled" }, s.at);
                            row = row.kid(button("Edit").class("btn small").click(move |a| a.open_draft(&d, Some((sched.clone(), at)))));
                        }
                        row = row.kid(button(if s.status == "failed" { "Remove" } else { "Cancel" }).class("btn small").click(move |a| a.cancel_scheduled(&id, false)));
                    }
                }
                p = p.kid(row);
            }
        }
        Some(Load::Failed(e)) => p = p.kid(problem(e, |a| a.load_scheduled())),
        _ => p = p.kid(spinner()),
    }
    p.into()
}

/// The emoji picker: a search, or a group at a time picked from the tabs (src/emoji.tsx).
fn emoji_pane(q: &str, group: usize) -> V {
    use crate::compose::Panel;
    let groups = crate::emoji::groups();
    let found = crate::emoji::search(q);
    let pick = |e: &'static str, name: &'static str| button(e).class("emoji-opt").attr("aria-label", name).attr("title", name).key(name).click(move |a| a.insert_emoji(e));
    let mut grid = el("div").class("emoji-grid");
    let mut tabs = None;
    if !q.trim().is_empty() {
        if found.is_empty() {
            grid = grid.kid(el("p").class("muted").txt("No emoji found."));
        }
        for (e, n) in found {
            grid = grid.kid(pick(e, n));
        }
    } else {
        let g = group.min(groups.len().saturating_sub(1));
        let mut t = el("div").class("emoji-tabs").attr("role", "tablist").attr("aria-label", "Emoji groups");
        for (i, x) in groups.iter().enumerate() {
            t = t.kid(button(x.emoji[0].0).attr("role", "tab").attr("aria-label", x.name).attr("title", x.name).attr("aria-selected", (i == g).to_string()).class(if i == g { "on" } else { "" }).click(move |a| {
                if let Some(Panel::Emoji(_, at)) = a.compose.as_mut().and_then(|c| c.panel.as_mut()) {
                    *at = i;
                }
            }));
        }
        tabs = Some(t.into());
        for (e, n) in groups.get(g).map(|x| x.emoji.as_slice()).unwrap_or_default() {
            grid = grid.kid(pick(e, n));
        }
    }
    el("div").class("gifs emoji")
        .kid(el("div").class("row").kid(el("input").attr("type", "search").attr("aria-label", "Search emoji").attr("placeholder", "Search emoji").attr("autocomplete", "off").attr("autofocus", "").attr("value", q.to_string()).on(Ev::Input, |a, v| {
            if let Some(Panel::Emoji(q, _)) = a.compose.as_mut().and_then(|c| c.panel.as_mut()) {
                *q = v.to_string();
            }
        })).kid(button("Back").class("btn small").click(|a| a.close_compose())))
        .maybe(tabs)
        .kid(grid)
        .into()
}

/// The sticker picker: a tab per pack the account has, then the pack's stickers (src/stickers.tsx StickerPicker).
fn stickers_pane(app: &App, tab: usize) -> V {
    use crate::compose::Panel;
    let head = |tabs: Option<V>| el("div").class("row stk-head").maybe(tabs).kid(button("Back").class("btn small").click(|a| a.close_compose()));
    let p = el("div").class("gifs stickers");
    match &app.stickers {
        Some(Load::Ready(packs)) if packs.is_empty() => p.kid(head(None)).kid(el("div").class("stk-empty")
            .kid(el("b").txt("No stickers yet"))
            .kid(el("p").class("muted").txt("No sticker packs yet. Make one, import one from Telegram, or add one someone shared, on quilcast.com."))
            .kid(external("https://quilcast.com/stickers").class("btn small").txt("Get stickers"))).into(),
        Some(Load::Ready(packs)) => {
            let at = tab.min(packs.len() - 1);
            let mut tabs = el("div").class("stk-tabs").attr("role", "tablist").attr("aria-label", "Sticker packs");
            for (i, x) in packs.iter().enumerate() {
                let first = crate::compose::sticker_url(&x.id, &x.stickers[0].h);
                tabs = tabs.kid(button("").attr("role", "tab").attr("aria-label", x.title.clone()).attr("title", x.title.clone()).attr("aria-selected", (i == at).to_string()).class(if i == at { "on" } else { "" }).key(x.id.clone())
                    .kid(el("img").attr("src", first).attr("alt", ""))
                    .click(move |a| {
                        if let Some(Panel::Stickers(t)) = a.compose.as_mut().and_then(|c| c.panel.as_mut()) {
                            *t = i;
                        }
                    }));
            }
            let pack = &packs[at];
            let mut grid = el("div").class("stk-grid");
            for s in &pack.stickers {
                let (id, h) = (pack.id.clone(), s.h.clone());
                grid = grid.kid(button("").attr("aria-label", if s.e.is_empty() { "Sticker".to_string() } else { s.e.clone() }).attr("title", s.e.clone()).key(s.h.clone())
                    .kid(el("img").attr("src", crate::compose::sticker_url(&pack.id, &s.h)).attr("alt", "").attr("loading", "lazy"))
                    .click(move |a| a.pick_sticker(&id, &h)));
            }
            p.kid(head(Some(tabs.into()))).kid(grid).into()
        }
        Some(Load::Failed(e)) => p.kid(head(None)).kid(problem(e, |a| a.load_stickers())).into(),
        _ => p.kid(head(None)).kid(spinner()).into(),
    }
}

fn gifs_pane(app: &App, q: &str) -> V {
    let term = q.trim().to_lowercase();
    let mut grid = el("div").class("gif-grid");
    match app.gifs.get(&term) {
        Some(Load::Ready(l)) if l.is_empty() => grid = grid.kid(el("p").class("muted").txt("No GIFs found.")),
        Some(Load::Ready(l)) => {
            for g in l.iter().take(30) {
                let g2 = g.clone();
                grid = grid.kid(button("").class("gif-opt").attr("aria-label", if g.title.is_empty() { "GIF".to_string() } else { g.title.clone() }).key(g.cast.clone().unwrap_or_default())
                    .kid(el("img").attr("src", text::proxied(&g.preview)).attr("alt", "").attr("loading", "lazy"))
                    .click(move |a| a.pick_gif(&g2)));
            }
        }
        Some(Load::Failed(e)) => grid = grid.kid(el("p").class("error").txt(e.clone())),
        _ => grid = grid.kid(spinner()),
    }
    el("div").class("gifs")
        .kid(el("div").class("row").kid(el("input").attr("type", "search").attr("aria-label", "Search GIFs").attr("placeholder", "Search GIFs").attr("autocomplete", "off").attr("autofocus", "").attr("value", q.to_string()).on(Ev::Input, |a, v| a.type_gifs(v))).kid(button("Back").class("btn small").click(|a| a.close_compose())))
        .kid(grid)
        .kid(el("p").class("muted small").txt("GIFs from Tenor."))
        .into()
}

/// Where a new cast goes: no channel, or the one picked from the directory.
fn channel_picker(app: &App, c: &Compose) -> V {
    let mut row = el("div").class("chan-pick");
    match (&c.channel, &c.picking) {
        (_, Some(q)) => {
            let term = q.trim().to_lowercase();
            let mut list = el("div").class("chan-results");
            match app.channel_lists.get(&term) {
                Some(Load::Ready(cs)) if cs.is_empty() => list = list.kid(el("p").class("muted small").txt("No channels match.")),
                Some(Load::Ready(cs)) => {
                    for ch in cs.iter().take(20) {
                        let id = ch.id.clone();
                        list = list.kid(button("").class("menu-item chan-opt").key(ch.id.clone()).kid(chan_av(ch.image.as_deref(), "xs")).kid(el("bdi").txt(if ch.name.is_empty() { ch.id.clone() } else { ch.name.clone() })).kid(el("span").class("muted small").txt(format!("/{}", ch.id))).click(move |a| a.pick_channel(Some(id.clone()))));
                    }
                }
                Some(Load::Failed(e)) => list = list.kid(el("p").class("error").txt(e.clone())),
                _ => list = list.kid(spinner()),
            }
            row = row.kid(el("div").class("row")
                .kid(el("input").attr("type", "search").attr("aria-label", "Find a channel").attr("placeholder", "Find a channel").attr("autocomplete", "off").attr("autofocus", "").attr("value", q.clone()).on(Ev::Input, |a, v| a.type_channel(v, true)))
                .kid(button("Cancel").class("btn small").click(|a| {
                    if let Some(c) = a.compose.as_mut() {
                        c.picking = None;
                    }
                })))
                .kid(list);
        }
        (Some(id), None) => {
            row = row.kid(el("span").class("chip").kid(icon(P_HASH)).kid(el("bdi").txt(format!("/{id}"))).kid(button("").class("icon-btn tiny").attr("aria-label", "No channel").kid(icon(P_X)).click(|a| a.pick_channel(None))));
            if c.closed {
                row = row.kid(el("p").class("error small").attr("role", "alert").txt(format!("Only members can cast in /{id}, so farcaster.xyz won't show this there.")));
            }
        }
        (None, None) => {
            row = row.kid(button("").class("btn small").kid(icon(P_HASH)).kid(el("span").txt("Channel")).attr_if(c.sending, "disabled", "").click(|a| {
                if let Some(c) = a.compose.as_mut() {
                    c.picking = Some(String::new());
                }
                a.load_channels(String::new());
            }));
        }
    }
    row.into()
}
