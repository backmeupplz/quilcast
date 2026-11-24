//! Text helpers ported from src/shared.ts: mentions put back into a cast's text, the text split into words, links,
//! mentions and channels, safe links, pictures through our proxy, counts and times.

/// Only public http(s) addresses, without credentials, get rendered (src/shared.ts safeUrl).
pub fn safe_url(u: &str) -> Option<String> {
    let u = u.trim();
    let lower = u.to_ascii_lowercase();
    let rest = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://"))?;
    let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..host_end];
    if authority.is_empty() || authority.contains('@') || u.chars().any(|c| c.is_control() || c == ' ' || c == '"' || c == '<' || c == '>') {
        return None;
    }
    let host = authority.rsplit_once(':').map_or(authority, |(h, port)| if port.bytes().all(|b| b.is_ascii_digit()) { h } else { authority });
    let local = host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") || host.ends_with(".internal") || host.starts_with('[') || host.split('.').all(|p| p.bytes().all(|b| b.is_ascii_digit()));
    if local || !host.contains('.') {
        return None;
    }
    Some(u.to_string())
}

pub fn encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
pub fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let hexv = |c: u8| (c as char).to_digit(16);
        if b[i] == b'%' && i + 2 < b.len() {
            if let (Some(h), Some(l)) = (hexv(b[i + 1]), hexv(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
/// A query string's parameter.
pub fn param(query: &str, name: &str) -> Option<String> {
    query.trim_start_matches('?').split('&').find_map(|kv| {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        (decode(k) == name).then(|| decode(v))
    })
}

pub fn is_img(u: &str) -> bool {
    let path = u.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"].iter().any(|e| path.ends_with(e)) || u.contains("imagedelivery.net") || u.contains("i.imgur.com")
}
pub fn is_vid(u: &str) -> bool {
    let path = u.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    [".m3u8", ".mp4", ".webm", ".mov"].iter().any(|e| path.ends_with(e))
}

/// A link's site: "https://me@www.spam.site:8080/x" is "www.spam.site" (muted words look at it, view::muted_text).
pub fn host(u: &str) -> String {
    let auth = u.split_once("://").map_or("", |(_, r)| r).split(['/', '?', '#']).next().unwrap_or("");
    auth.rsplit_once('@').map_or(auth, |(_, h)| h).split(':').next().unwrap_or("").to_ascii_lowercase()
}

/// Farcaster's image CDN resizes on request, so nothing needs the full original.
pub fn sized(u: &str, variant: &str) -> String {
    if u.starts_with("https://imagedelivery.net/") && u.ends_with("/original") && u.matches('/').count() == 5 {
        format!("{}/{variant}", &u[..u.len() - "/original".len()])
    } else {
        u.to_string()
    }
}
/// Another site's picture loads through our /api/img, so its host never sees who is looking. Farcaster's image CDN,
/// Tenor and quilcast.com load as they are.
pub fn proxied(u: &str) -> String {
    let bare: String = u.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let direct = ["https://imagedelivery.net/", "https://quilcast.com/", "https://media.tenor.com/", "https://media1.tenor.com/"].iter().any(|p| bare.to_ascii_lowercase().starts_with(p));
    if u.is_empty() || direct {
        u.to_string()
    } else {
        format!("/api/img?u={}", encode(u))
    }
}
/// A video's first frame, from our server, for Farcaster's streams.
pub fn poster(u: &str) -> Option<String> {
    u.starts_with("https://stream.farcaster.xyz/").then(|| format!("/api/poster?url={}", encode(u)))
}

/// Hypersnap leaves mentions out of `text` and gives their UTF-8 byte offsets; put "@name" back in (src/shared.ts
/// castText). Each mention is closed with U+2060 when a name character follows, so display links only the name.
pub fn cast_text(text: &str, names: &[(u64, Option<String>)]) -> String {
    let mut at: Vec<(usize, &str)> = names.iter().filter_map(|(start, n)| n.as_deref().map(|n| (*start as usize, n))).filter(|(s, _)| *s <= text.len() && text.is_char_boundary(*s)).collect();
    if at.is_empty() {
        return text.to_string();
    }
    at.sort_by_key(|(s, _)| *s);
    let mut out = String::from(&text[..at[0].0]);
    for (i, (s, name)) in at.iter().enumerate() {
        let end = at.get(i + 1).map_or(text.len(), |n| n.0);
        let rest = &text[*s..end];
        out.push('@');
        out.push_str(name);
        if rest.chars().next().is_some_and(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') {
            out.push('\u{2060}');
        }
        out.push_str(rest);
    }
    out
}

#[derive(Debug, PartialEq)]
pub enum Tok {
    Text(String),
    Link(String, String),
    Mention(String),
    Channel(String),
}

fn link_end(s: &str) -> usize {
    let end = s.find(|c: char| c.is_whitespace() || c == '<' || c == '>' || c == '"').unwrap_or(s.len());
    // a sentence's punctuation after a link isn't part of it
    let t = s[..end].trim_end_matches(['.', ',', ';', ':', '!', '?', ')', ']', '\'', '"']);
    t.len()
}
const TLDS: [&str; 24] = ["com", "xyz", "org", "net", "io", "co", "app", "dev", "ai", "eth", "me", "so", "gg", "fm", "tv", "info", "art", "link", "fun", "club", "id", "to", "us", "uk"];

/// A bare "example.com/path" at the start of `s`, as long as its last label is a known TLD.
fn bare_link(s: &str) -> Option<usize> {
    let end = link_end(s);
    let cand = &s[..end];
    let host = cand.split('/').next()?;
    let labels: Vec<&str> = host.split('.').collect();
    if labels.len() < 2 || labels.iter().any(|l| l.is_empty() || !l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')) {
        return None;
    }
    TLDS.contains(&labels.last()?.to_ascii_lowercase().as_str()).then_some(end)
}

/// A cast's words with its links, @mentions and /channels picked out.
pub fn tokens(s: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut plain = String::new();
    let mut i = 0;
    let mut prev: Option<char> = None;
    let flush = |plain: &mut String, out: &mut Vec<Tok>| {
        if !plain.is_empty() {
            out.push(Tok::Text(std::mem::take(plain)));
        }
    };
    while i < s.len() {
        let rest = &s[i..];
        let at_word = prev.map_or(true, |p| p.is_whitespace() || p == '(');
        let lower = rest.get(..8).unwrap_or(rest).to_ascii_lowercase();
        if at_word && (lower.starts_with("https://") || lower.starts_with("http://")) {
            let end = link_end(rest);
            if let Some(u) = safe_url(&rest[..end]) {
                flush(&mut plain, &mut out);
                out.push(Tok::Link(u.clone(), shown_url(&u)));
                i += end;
                prev = Some('/');
                continue;
            }
        }
        let c = rest.chars().next().unwrap();
        if at_word && c.is_ascii_alphanumeric() {
            if let Some(end) = bare_link(rest) {
                flush(&mut plain, &mut out);
                out.push(Tok::Link(format!("https://{}", &rest[..end]), rest[..end].to_string()));
                i += end;
                prev = Some('/');
                continue;
            }
        }
        if at_word && (c == '@' || c == '/') {
            let name: String = rest[1..].chars().take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '.' || *ch == '-' || (c == '/' && *ch == '_')).collect();
            let name = name.trim_end_matches('.').to_string();
            if !name.is_empty() && name.chars().next().unwrap().is_ascii_alphanumeric() {
                flush(&mut plain, &mut out);
                i += 1 + name.len();
                out.push(if c == '@' { Tok::Mention(name) } else { Tok::Channel(name) });
                // the mark that ends a mention is only there to end it
                if s[i..].starts_with('\u{2060}') {
                    i += '\u{2060}'.len_utf8();
                }
                prev = Some('a');
                continue;
            }
        }
        plain.push(c);
        prev = Some(c);
        i += c.len_utf8();
    }
    flush(&mut plain, &mut out);
    out
}

/// An inline custom emoji's label (src/shared.ts EMOJI_LABEL): [a-z0-9_][a-z0-9_-]{0,31}.
pub fn is_emoji_label(l: &str) -> bool {
    let b = l.as_bytes();
    !b.is_empty() && b.len() <= 32 && b[0] != b'-' && b.iter().all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'_' || c == b'-')
}

/// Whether a labelled embed could be an emoji's picture (src/shared.ts emojiPic): not a video, a site's front page, an
/// .html/.php page or a Farcaster or Quilcast page, which keep their card; a picture host without an extension counts.
pub fn emoji_pic(u: &str) -> bool {
    if is_img(u) {
        return true;
    }
    let rest = u.split_once("://").map_or(u, |(_, r)| r);
    let path = rest.split(['?', '#']).next().unwrap_or("").to_ascii_lowercase();
    let path = path.find('/').map_or("", |i| &path[i..]);
    let h = host(u);
    let fc = ["farcaster.xyz", "warpcast.com", "quilcast.com"].iter().any(|d| h == *d || h.ends_with(&format!(".{d}")));
    !is_vid(u) && path.len() > 1 && !path.ends_with(".html") && !path.ends_with(".htm") && !path.ends_with(".php") && !fc
}

#[derive(Debug, PartialEq)]
pub enum Piece<'a> {
    Text(&'a str),
    /// label and picture
    Emoji(&'a str, &'a str),
}
/// Text with each :label: of `emojis` (Cast::emojis) picked out, leftmost first (src/shared.ts words).
pub fn emoji_pieces<'a>(s: &'a str, emojis: &'a [(String, String)]) -> Vec<Piece<'a>> {
    let mut out = Vec::new();
    let (mut last, mut i) = (0, 0);
    while let Some(off) = s[i..].find(':') {
        let at = i + off;
        let rest = &s[at + 1..];
        match emojis.iter().find(|(l, _)| rest.starts_with(l.as_str()) && rest[l.len()..].starts_with(':')) {
            Some((l, u)) => {
                if at > last {
                    out.push(Piece::Text(&s[last..at]));
                }
                out.push(Piece::Emoji(l, u));
                i = at + l.len() + 2;
                last = i;
            }
            None => i = at + 1,
        }
    }
    if last < s.len() {
        out.push(Piece::Text(&s[last..]));
    }
    out
}

/// A link as shown: without the scheme, "www." and a lone trailing "/", and shortened past 40 characters.
pub fn shown_url(u: &str) -> String {
    let s = u.split_once("://").map_or(u, |(_, r)| r);
    let s = s.strip_prefix("www.").unwrap_or(s);
    let s = s.strip_suffix('/').unwrap_or(s);
    if s.chars().count() > 40 {
        format!("{}…", s.chars().take(38).collect::<String>())
    } else {
        s.to_string()
    }
}
/// The links typed in a text, which a new cast embeds (src/shared.ts textLinks).
pub fn text_links(s: &str) -> Vec<String> {
    tokens(s).into_iter().filter_map(|t| if let Tok::Link(u, _) = t { Some(u) } else { None }).collect()
}

/// 1.2K, 34K, 5.6M (src/shared.ts n).
pub fn count(x: u64) -> String {
    if x >= 1_000_000 {
        format!("{:.1}M", x as f64 / 1e6)
    } else if x >= 10_000 {
        format!("{}K", (x as f64 / 1e3).round())
    } else if x >= 1_000 {
        format!("{:.1}K", x as f64 / 1e3)
    } else {
        x.to_string()
    }
}

/// Unix milliseconds of an ISO 8601 UTC time like 2026-11-14T18:07:28.000Z.
pub fn parse_time(s: &str) -> Option<f64> {
    let d = |a: usize, b: usize| s.get(a..b)?.parse::<i64>().ok();
    let (y, m, day, h, mi, sec) = (d(0, 4)?, d(5, 7)?, d(8, 10)?, d(11, 13)?, d(14, 16)?, d(17, 19)?);
    // days from civil (Howard Hinnant)
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = if y2 >= 0 { y2 } else { y2 - 399 } / 400;
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    Some(((days * 86400 + h * 3600 + mi * 60 + sec) * 1000) as f64)
}
const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/// How long ago: 5s, 3m, 2h, 4d, then the date.
pub fn ago(ts: &str, now_ms: f64) -> String {
    let Some(t) = parse_time(ts) else { return String::new() };
    let s = ((now_ms - t) / 1000.0).max(0.0) as u64;
    match s {
        0..=59 => format!("{s}s"),
        60..=3599 => format!("{}m", s / 60),
        3600..=86399 => format!("{}h", s / 3600),
        86400..=604799 => format!("{}d", s / 86400),
        _ => {
            let (y, m, d) = civil((t / 86_400_000.0).floor() as i64);
            let (ny, _, _) = civil((now_ms / 86_400_000.0).floor() as i64);
            if y == ny { format!("{} {d}", MONTHS[m - 1]) } else { format!("{} {d}, {y}", MONTHS[m - 1]) }
        }
    }
}
/// Unix milliseconds as ISO 8601 UTC, whole seconds.
pub fn iso(ms: f64) -> String {
    let secs = (ms / 1000.0).floor() as i64;
    let (y, m, d) = civil(secs.div_euclid(86400));
    let t = secs.rem_euclid(86400);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z", t / 3600, t / 60 % 60, t % 60)
}
fn civil(z: i64) -> (i64, usize, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + (m <= 2) as i64, m as usize, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mentions_go_back_in() {
        // "gm  and @x" with dwr at byte 3: "gm @dwr and"
        assert_eq!(cast_text("gm  and", &[(3, Some("dwr".into()))]), "gm @dwr and");
        assert_eq!(cast_text("hi -x", &[(3, Some("adam".into()))]), "hi @adam\u{2060}-x");
        assert_eq!(cast_text("hé", &[(2, Some("a".into()))]), "hé", "not on a character boundary");
    }

    #[test]
    fn emoji_labels_are_picked_out_of_text() {
        assert!(is_emoji_label("_") && is_emoji_label("a-b_9") && is_emoji_label(&"x".repeat(32)));
        assert!(!is_emoji_label("") && !is_emoji_label("-a") && !is_emoji_label("A") && !is_emoji_label(&"x".repeat(33)) && !is_emoji_label("a:b"));
        let e = vec![("a".to_string(), "https://x.y/a.gif".to_string()), ("ab".to_string(), "https://x.y/b.gif".to_string())];
        use Piece::*;
        assert_eq!(emoji_pieces("hi :a::ab: x:y:ab:é", &e), vec![Text("hi "), Emoji("a", "https://x.y/a.gif"), Emoji("ab", "https://x.y/b.gif"), Text(" x:y"), Emoji("ab", "https://x.y/b.gif"), Text("é")]);
        assert_eq!(emoji_pieces(":b: :a", &e), vec![Text(":b: :a")]);
        assert_eq!(emoji_pieces("日本:a:語", &e), vec![Text("日本"), Emoji("a", "https://x.y/a.gif"), Text("語")]);
    }

    #[test]
    fn tokens_pick_out_links_mentions_and_channels() {
        let t = tokens("gm @dwr\u{2060}-x see https://quilcast.com/a. and quilcast.com on /wasm");
        assert_eq!(
            t,
            vec![
                Tok::Text("gm ".into()),
                Tok::Mention("dwr".into()),
                Tok::Text("-x see ".into()),
                Tok::Link("https://quilcast.com/a".into(), "quilcast.com/a".into()),
                Tok::Text(". and ".into()),
                Tok::Link("https://quilcast.com".into(), "quilcast.com".into()),
                Tok::Text(" on ".into()),
                Tok::Channel("wasm".into()),
            ]
        );
        assert_eq!(tokens("a@b.com and 1/2"), vec![Tok::Text("a@b.com and 1/2".into())]);
        assert_eq!(tokens("javascript:alert(1)"), vec![Tok::Text("javascript:alert(1)".into())]);
    }

    #[test]
    fn only_public_web_links() {
        assert!(safe_url("https://quilcast.com/x?y").is_some());
        for bad in ["javascript:alert(1)", "http://localhost:3000", "https://user:pw@a.com", "http://127.0.0.1/", "https://intranet/", "https://[::1]/", "data:text/html,x"] {
            assert_eq!(safe_url(bad), None, "{bad}");
        }
    }

    #[test]
    fn pictures_go_through_our_proxy() {
        assert_eq!(proxied("https://imagedelivery.net/a/b/original"), "https://imagedelivery.net/a/b/original");
        assert_eq!(proxied("https://i.imgur.com/x.png"), "/api/img?u=https%3A%2F%2Fi.imgur.com%2Fx.png");
        assert_eq!(sized("https://imagedelivery.net/a/b/original", "w=96"), "https://imagedelivery.net/a/b/w=96");
        assert_eq!(sized("https://imagedelivery.net/a/b/rectcrop3", "w=96"), "https://imagedelivery.net/a/b/rectcrop3");
    }

    #[test]
    fn times_and_counts() {
        let t = parse_time("2026-11-14T18:07:28.000Z").unwrap();
        assert_eq!(t, 1794679648000.0);
        assert_eq!(ago("2026-11-14T18:07:28.000Z", t + 90_000.0), "1m");
        assert_eq!(ago("2026-11-14T18:07:28.000Z", t + 30.0 * 86_400_000.0), "Nov 14");
        assert_eq!(ago("2024-01-02T00:00:00.000Z", t), "Jan 2, 2024");
        assert_eq!(count(1234), "1.2K");
        assert_eq!(count(631306), "631K");
        assert_eq!(count(2_500_000), "2.5M");
        assert_eq!(param("?q=a%20b&x=1", "q").as_deref(), Some("a b"));
        assert_eq!(encode("a b/é"), "a%20b%2F%C3%A9");
    }
}
