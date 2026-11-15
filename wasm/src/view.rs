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
fn spinner() -> V {
    el("div").class("spin").attr("role", "status").attr("aria-label", "Loading").into()
}
fn problem(e: &str, retry: impl Fn(&mut App) + 'static) -> V {
    el("div").class("problem").kid(el("p").txt(e.to_string())).kid(button("Try again").class("btn").click(retry)).into()
}

pub fn title(app: &App) -> String {
    let t = match &app.route {
        Route::Home(_) => "Home".to_string(),
        Route::Cast(_) => "Cast".into(),
        Route::User(id, _) => match app.profiles.get(&id.to_lowercase()) {
            Some(Load::Ready(u)) => format!("{} (@{})", u.name(), u.handle()),
            _ => format!("@{id}"),
        },
        Route::Notifications => "Notifications".into(),
        Route::Search(q, _) if !q.is_empty() => format!("{q} · Search"),
        Route::Search(..) => "Search".into(),
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
        .maybe(app.toast.as_ref().map(|t| el("div").class("toast").attr("role", "status").txt(t.clone()).into()))
        .into()
}

fn nav_items(app: &App) -> Vec<(&'static str, String, &'static str, bool)> {
    let r = &app.route;
    let mut items = vec![("Home", "/".to_string(), P_HOME, matches!(r, Route::Home(_))), ("Search", "/search".into(), P_SEARCH, matches!(r, Route::Search(..)))];
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
    for (label, href, d, on) in nav_items(app) {
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
        Route::Cast(h) => thread(app, &h),
        Route::User(id, r) => profile(app, &id, r),
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
    let tab = |label: &'static str, href: &'static str, on: bool| link(href).class(if on { "tab on" } else { "tab" }).attr_if(on, "aria-current", "page").txt(label);
    let tabs = if signed { el("div").class("tabbar").attr("role", "tablist").kid(tab("Following", "/", !trending)).kid(tab("Trending", "/?feed=trending", trending)) } else { el("div").class("tabbar").kid(tab("Trending", "/", true)) };
    let intro = (!signed).then(|| {
        el("div").class("intro")
            .kid(el("p").txt("Quilcast, rebuilt in Rust and running as WebAssembly. Read Farcaster here, or sign in with your recovery phrase to cast."))
            .kid(link("/join").class("btn primary").txt("Sign in"))
            .into()
    });
    el("section").kid(header("Home", false).kid(tabs)).maybe(intro).kid(feed(app, &key, "Nothing here yet.")).into()
}

fn feed(app: &App, key: &str, empty: &str) -> V {
    let Some(f) = app.feeds.get(key) else { return spinner() };
    let mut list = el("div").class("feed");
    for c in &f.items {
        let k = format!("{}:{}", c.hash, c.recaster.as_ref().map_or(0, |u| u.fid));
        list = list.kid(cast_card(app, c, false).key(k));
    }
    if let Some(e) = &f.error {
        let k = key.to_string();
        let more = !f.items.is_empty();
        list = list.kid(problem(e, move |a| a.load_feed(k.clone(), more)));
    } else if f.loading {
        list = list.kid(spinner());
    } else if f.items.is_empty() {
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
            text::Tok::Channel(n) => external(format!("https://quilcast.com/channel/{}", n.to_lowercase())).class("mention").txt(format!("/{n}")).into(),
        });
    }
    p.into()
}

fn shown_text(c: &Cast) -> String {
    let names: Vec<(u64, Option<String>)> = c.mentioned_profiles_ranges.iter().enumerate().map(|(i, r)| (r.start, (r.start == r.end).then(|| c.mentioned_profiles.get(i).and_then(|u| u.username.clone())).flatten())).collect();
    text::cast_text(&c.text, &names)
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
    let head = el("div").class("head")
        .kid(link(c.author.path()).class("who").kid(el("bdi").class("name").txt(c.author.name())).kid(el("span").class("handle").txt(format!("@{}", c.author.handle()))))
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
    }
    body = body.kid(actions(app, c));
    card.kid(link(c.author.path()).class("side-av").attr("aria-label", c.author.name()).kid(avatar(&c.author, if big { "md" } else { "sm" }))).kid(body)
}

fn embeds(app: &App, c: &Cast) -> Option<V> {
    let urls = c.urls();
    let quote = c.quoted();
    if urls.is_empty() && quote.is_none() {
        return None;
    }
    let mut box_ = el("div").class("embeds");
    let imgs: Vec<&String> = urls.iter().filter(|u| text::is_img(u)).collect();
    if !imgs.is_empty() {
        let mut row = el("div").class(if imgs.len() > 1 { "imgs strip" } else { "imgs" });
        for u in imgs {
            row = row.kid(external(u.clone()).class("img").attr("aria-label", "Open picture").kid(el("img").attr("src", text::proxied(&text::sized(u, "w=1200"))).attr("alt", "").attr("loading", "lazy").attr("decoding", "async")));
        }
        box_ = box_.kid(row);
    }
    for u in urls.iter().filter(|u| text::is_vid(u)) {
        let mut v = el("video").attr("src", u.clone()).attr("controls", "").attr("preload", "none").attr("playsinline", "");
        if let Some(p) = text::poster(u) {
            v = v.attr("poster", p);
        }
        box_ = box_.kid(v);
    }
    for u in urls.iter().filter(|u| !text::is_img(u) && !text::is_vid(u)) {
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
    let (c1, c2, c3, c4, c5) = (c.clone(), c.clone(), c.clone(), c.clone(), c.clone());
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
            for r in &root.direct_replies {
                let mut group = el("div").class("reply-group").key(r.bare_hash()).kid(cast_card(app, r, false));
                for rr in &r.direct_replies {
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
        Some(Load::Failed(e)) => s.kid(header(&format!("@{id}"), true)).kid(problem(e, move |a| {
            a.profiles.remove(&id2.to_lowercase());
            a.load_profile(id2.clone(), false)
        })).into(),
        Some(Load::Ready(u)) => {
            let me = app.me() == Some(u.fid);
            let fid = u.fid;
            let mut top = el("div").class("profile").kid(avatar(u, "lg")).kid(el("h2").kid(el("bdi").txt(u.name()))).kid(el("div").class("handle").txt(format!("@{}", u.handle())));
            if let Some(b) = u.profile.bio.text.as_deref().filter(|b| !b.trim().is_empty()) {
                top = top.kid(rich(b));
            }
            top = top.kid(el("div").class("counts").kid(el("span").kid(el("strong").txt(text::count(u.following_count))).txt(" following")).kid(el("span").kid(el("strong").txt(text::count(u.follower_count))).txt(" followers")));
            if u.viewer_context.as_ref().and_then(|v| v.followed_by) == Some(true) && !me {
                top = top.kid(el("span").class("pill").txt("Follows you"));
            }
            if !me {
                let on = app.follows.get(&fid).copied().unwrap_or(false);
                top = top.kid(button(if on { "Following" } else { "Follow" }).class(if on { "btn" } else { "btn primary" }).attr("aria-pressed", on.to_string()).click(move |a| a.follow(fid)));
            }
            let base = u.path();
            let tab = |label: &'static str, href: String, on: bool| link(href).class(if on { "tab on" } else { "tab" }).attr_if(on, "aria-current", "page").txt(label);
            let tabs = el("div").class("tabbar").kid(tab("Casts", base.clone(), !replies)).kid(tab("Replies", format!("{base}/replies"), replies));
            let key = format!("{}:{fid}", if replies { "replies" } else { "casts" });
            s.kid(header(&u.name(), true)).kid(top).kid(tabs).kid(feed(app, &key, "No casts yet.")).into()
        }
    }
}

// --- notifications ---

fn notifications(app: &App) -> V {
    let s = el("section").kid(header("Notifications", false));
    if app.account.is_none() {
        return s.kid(el("p").class("empty").txt("Sign in to see who liked, recast, replied to and followed you.")).into();
    }
    let f = &app.notes;
    let mut list = el("div").class("feed");
    for (i, n) in f.items.iter().enumerate() {
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

fn search(app: &App, q: &str, casts: bool) -> V {
    let form = el("form").class("search").attr("role", "search").on(Ev::Submit, |a, _| {
        let q = a.search_text.trim().to_string();
        let tab = if let Route::Search(_, true) = a.route { "&tab=casts" } else { "" };
        a.navigate(&format!("/search?q={}{tab}", text::encode(&q)), false);
    })
    .kid(el("input").attr("type", "search").attr("name", "q").attr("placeholder", "Search people and casts").attr("aria-label", "Search").attr("enterkeyhint", "search").attr("autocomplete", "off").attr("value", app.search_text.clone()).attr_if(q.is_empty(), "autofocus", "").on(Ev::Input, |a, v| a.search_text = v.to_string()))
    .kid(el("button").attr("type", "submit").class("btn").txt("Search"));
    let mut s = el("section").kid(header("Search", false).kid(form));
    if q.trim().is_empty() {
        return s.kid(el("p").class("empty").txt("Find people by name, or casts by what they say.")).into();
    }
    let enc = text::encode(q.trim());
    let tab = |label: &'static str, href: String, on: bool| link(href).class(if on { "tab on" } else { "tab" }).attr_if(on, "aria-current", "page").txt(label);
    s = s.kid(el("div").class("tabbar").kid(tab("People", format!("/search?q={enc}"), !casts)).kid(tab("Casts", format!("/search?q={enc}&tab=casts"), casts)));
    if casts {
        return s.kid(feed(app, &format!("search:{}", q.trim()), "No casts found.")).into();
    }
    let q2 = q.trim().to_string();
    match app.people.get(q.trim()) {
        None | Some(Load::Loading) => s.kid(spinner()).into(),
        Some(Load::Failed(e)) => s.kid(problem(e, move |a| {
            a.people.remove(&q2);
            a.load_people(q2.clone())
        })).into(),
        Some(Load::Ready(users)) if users.is_empty() => s.kid(el("p").class("empty").txt("No one by that name.")).into(),
        Some(Load::Ready(users)) => {
            let mut list = el("div").class("feed");
            for u in users {
                let mut row = link(u.path()).class("person").key(u.fid.to_string()).kid(avatar(u, "sm")).kid(el("span").class("words").kid(el("bdi").class("name").txt(u.name())).kid(el("span").class("handle").txt(format!("@{} · {} followers", u.handle(), text::count(u.follower_count)))));
                if let Some(b) = u.profile.bio.text.as_deref().filter(|b| !b.is_empty()) {
                    row = row.kid(el("span").class("bio").txt(b.chars().take(140).collect::<String>()));
                }
                list = list.kid(row);
            }
            s.kid(list).into()
        }
    }
}

// --- signing in ---

fn join(app: &App) -> V {
    let s = el("section").kid(header("Sign in", true));
    if let Some(a) = &app.account {
        return s.kid(el("p").class("empty").txt(format!("You're signed in as @{}.", a.username.clone().unwrap_or_else(|| a.fid.to_string())))).into();
    }
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
        .kid(el("button").attr("type", "submit").class("btn primary").attr_if(working, "disabled", "").txt("Sign in"));
    s.kid(el("div").class("pane")
        .kid(el("p").txt("Sign in with the recovery phrase of your Farcaster account (the same one Warpcast, Quorum and Quilcast use)."))
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
    if let Some(a) = &app.account {
        let out = app.busy.contains("signout");
        s = s.kid(el("div").class("pane").kid(el("h2").txt("Account")).kid(el("p").txt(format!("Signed in as @{} (FID {})", a.username.clone().unwrap_or_default(), a.fid))).kid(button(if out { "Signing out…" } else { "Sign out" }).class("btn danger").attr_if(out, "disabled", "").click(|a| a.sign_out())));
    }
    s = s.kid(el("div").class("pane").kid(el("h2").txt("Appearance")).kid(el("div").class("choices").attr("role", "radiogroup").attr("aria-label", "Theme").kid(theme("Match the system", "system")).kid(theme("Light", "light")).kid(theme("Dark", "dark"))));
    s = s.kid(el("form").class("pane").on(Ev::Submit, |a, _| a.set_node())
        .kid(el("h2").txt("Hypersnap node"))
        .kid(el("label").attr("for", "node").class("muted small").txt("Reads and writes go straight to this node."))
        .kid(el("div").class("row").kid(el("input").attr("id", "node").attr("type", "url").attr("value", app.node_text.clone()).attr("spellcheck", "false").on(Ev::Input, |a, v| a.node_text = v.to_string())).kid(el("button").attr("type", "submit").class("btn").txt("Save"))));
    s.kid(el("div").class("pane about")
        .kid(el("h2").txt("About"))
        .kid(el("p").txt(format!("Quilcast WASM {VERSION}: the Quilcast client written in Rust and compiled to WebAssembly. The module draws every page itself; a small script only hands it the browser.")))
        .kid(el("p").kid(external("https://git.borodutch.com/backmeupplz/quilcast/src/branch/main/wasm").txt("Source")).kid(text(" · ")).kid(external("https://quilcast.com").txt("The full Quilcast at quilcast.com"))))
        .into()
}

// --- the composer ---

fn composer(app: &App, c: &Compose) -> V {
    let bytes = c.text.trim().len();
    let over = c.text.len() > MAX_CAST;
    let title = if c.parent.is_some() { "Reply" } else if c.quote.is_some() { "Quote" } else { "New cast" };
    let mut d = el("div").class("dialog").attr("role", "dialog").attr("aria-modal", "true").attr("aria-label", title)
        .kid(el("div").class("dialog-head").kid(button("").class("icon-btn").attr("aria-label", "Close").kid(icon(P_X)).click(|a| a.close_compose())).kid(el("strong").txt(title)));
    if let Some(p) = &c.parent {
        d = d.kid(el("div").class("replying").kid(avatar(&p.author, "xs")).kid(el("span").txt(format!("Replying to @{}: {}", p.author.handle(), shown_text(p).chars().take(140).collect::<String>()))));
    }
    let me = app.account.as_ref().map(|a| User { fid: a.fid, pfp_url: a.pfp.clone(), ..Default::default() }).unwrap_or_default();
    d = d.kid(el("div").class("compose-row").kid(avatar(&me, "sm")).kid(el("textarea").attr("aria-label", title).attr("placeholder", if c.parent.is_some() { "Write your reply" } else { "What's happening?" }).attr("rows", "5").attr("value", c.text.clone()).attr("autofocus", "").attr_if(c.sending, "disabled", "")
        .on(Ev::Input, |a, v| {
            if let Some(c) = a.compose.as_mut() {
                c.text = v.to_string();
            }
        })
        .on(Ev::Key, |a, k| match k {
            "Escape" => a.close_compose(),
            "Enter+mod" => a.send_compose(),
            _ => {}
        })));
    if let Some(q) = &c.quote {
        d = d.kid(el("div").class("quote").kid(el("span").class("qhead").kid(avatar(&q.author, "xs")).kid(el("bdi").class("name").txt(q.author.name()))).kid(el("span").class("qtext").txt(shown_text(q).chars().take(200).collect::<String>())));
    }
    if let Some(e) = &c.error {
        d = d.kid(el("p").class("error").attr("role", "alert").txt(e.clone()));
    }
    let can = !c.sending && !over && (bytes > 0 || c.quote.is_some());
    d = d.kid(el("div").class("dialog-foot").kid(el("span").class(if over { "count over" } else { "count" }).attr("aria-live", "polite").txt(format!("{}/{MAX_CAST}", c.text.len()))).kid(button(if c.sending { "Casting…" } else { "Cast" }).class("btn primary").attr_if(!can, "disabled", "").click(|a| a.send_compose())));
    el("div").class("scrim").kid(d).into()
}
