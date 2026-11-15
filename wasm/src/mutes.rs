//! Mutes and blocks (src/mutes.ts, src/shared.ts cleanMutes and wordsRe): people and words the account doesn't want to
//! see. Farcaster has neither, so signed in they're kept on Quilcast's server (server/mutes.mjs, every read and write
//! signed by this browser's key, so the account's other devices get them) and in localStorage for the first paint;
//! signed out they stay in this browser only. The same JSON as quilcast.com, so both apps share one list.

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Timed<T> {
    pub v: T,
    /// ms; none means until lifted
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Mutes {
    pub words: Vec<Timed<String>>,
    pub users: Vec<Timed<u64>>,
    pub blocks: Vec<Timed<u64>>,
}

pub const DAY: u64 = 86_400_000;
/// How long a mute or block lasts, as the menus offer it; None is for good.
pub const SPANS: [(&str, Option<u64>); 4] = [("For a day", Some(DAY)), ("For a week", Some(7 * DAY)), ("For a month", Some(30 * DAY)), ("For good", None)];

const MAX_SAFE: u64 = (1 << 53) - 1;

fn safe(v: &Value) -> Option<u64> {
    v.as_u64().filter(|n| *n > 0 && *n <= MAX_SAFE)
}

/// The list as quilcast.com's cleanMutes keeps it: valid entries still running, each value once (a later one wins,
/// in the first one's place), at most 300 words and 3000 people of each kind (the newest).
pub fn clean(raw: &Value, now: u64) -> Mutes {
    fn list<T: PartialEq + Clone>(xs: Option<&Value>, ok: impl Fn(&Value) -> Option<T>, max: usize, now: u64) -> Vec<Timed<T>> {
        let mut out: Vec<Timed<T>> = Vec::new();
        for x in xs.and_then(|x| x.as_array()).into_iter().flatten() {
            let Some(v) = x.get("v").and_then(&ok) else { continue };
            let until = x.get("until").and_then(safe);
            if until.is_some_and(|u| u <= now) {
                continue;
            }
            match out.iter_mut().find(|t| t.v == v) {
                Some(t) => t.until = until,
                None => out.push(Timed { v, until }),
            }
        }
        let skip = out.len().saturating_sub(max);
        out.split_off(skip)
    }
    let word = |v: &Value| v.as_str().map(|s| s.trim().to_lowercase().chars().take(60).collect::<String>()).filter(|s| !s.is_empty());
    Mutes { words: list(raw.get("words"), word, 300, now), users: list(raw.get("users"), safe, 3000, now), blocks: list(raw.get("blocks"), safe, 3000, now) }
}

fn on<T: PartialEq>(xs: &[Timed<T>], v: &T, now: u64) -> bool {
    xs.iter().any(|x| x.v == *v && x.until.is_none_or(|u| u > now))
}

impl Mutes {
    pub fn muted(&self, fid: u64, now: u64) -> bool {
        on(&self.users, &fid, now)
    }
    pub fn blocked(&self, fid: u64, now: u64) -> bool {
        on(&self.blocks, &fid, now)
    }
    /// Whether a person's casts and notifications stay out of sight.
    pub fn silenced(&self, fid: u64, now: u64) -> bool {
        self.muted(fid, now) || self.blocked(fid, now)
    }
    /// The first running muted word the text has in it.
    pub fn word_in(&self, text: &str, now: u64) -> Option<&str> {
        if self.words.is_empty() {
            return None;
        }
        let t = text.to_lowercase();
        self.words.iter().filter(|w| w.until.is_none_or(|u| u > now)).map(|w| w.v.as_str()).find(|w| has_word(&t, w))
    }
    /// Put `v` on (or, `until` None for `on` false, take it off) one of the lists.
    pub fn set_fid(&mut self, block: bool, fid: u64, on: bool, until: Option<u64>) {
        let xs = if block { &mut self.blocks } else { &mut self.users };
        xs.retain(|x| x.v != fid);
        if on {
            xs.push(Timed { v: fid, until });
        }
    }
    pub fn set_word(&mut self, w: &str, on: bool, until: Option<u64>) {
        let w: String = w.trim().to_lowercase().chars().take(60).collect();
        self.words.retain(|x| x.v != w);
        if on && !w.is_empty() {
            self.words.push(Timed { v: w, until });
        }
    }
}

/// Chinese, Japanese and Korean words have no spaces around them, so they match anywhere.
fn cjk(w: &str) -> bool {
    w.chars().any(|c| matches!(c as u32, 0x1100..=0x11ff | 0x3040..=0x30ff | 0x3130..=0x318f | 0x31f0..=0x31ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xac00..=0xd7af | 0xf900..=0xfaff | 0xff66..=0xff9f | 0x20000..=0x2fa1f))
}
fn wordy(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// `w` in `t` (both lowercase) as a whole word: "$based" doesn't catch "$basedgod".
pub fn has_word(t: &str, w: &str) -> bool {
    if w.is_empty() {
        return false;
    }
    if cjk(w) {
        return t.contains(w);
    }
    let mut from = 0;
    while let Some(i) = t[from..].find(w) {
        let at = from + i;
        let end = at + w.len();
        let before = t[..at].chars().next_back();
        let after = t[end..].chars().next();
        if !before.is_some_and(wordy) && !after.is_some_and(wordy) {
            return true;
        }
        from = at + t[at..].chars().next().map_or(1, |c| c.len_utf8());
    }
    false
}

/// Casts and accounts taken down for everyone after a report (quilcast.com's src/removed.json, built in).
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Removed {
    pub fids: Vec<u64>,
    pub casts: Vec<String>,
}
pub fn removed() -> Removed {
    serde_json::from_str(include_str!("../../src/removed.json")).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cleans_like_quilcast_com() {
        let now = 1_000_000;
        let m = clean(&json!({"words": [{"v": "  GM "}, {"v": ""}, {"v": 3}, {"v": "old", "until": 5}, {"v": "gm", "until": 2_000_000}], "users": [{"v": 7}, {"v": -1}, {"v": "8"}, {"v": 7.5}], "blocks": "nope"}), now);
        assert_eq!(m.words, vec![Timed { v: "gm".into(), until: Some(2_000_000) }], "the later gm wins, in the first one's place");
        assert_eq!(m.users, vec![Timed { v: 7, until: None }]);
        assert!(m.blocks.is_empty());
        // what's sent back is the same shape server/mutes.mjs keeps
        assert_eq!(serde_json::to_value(&m).unwrap(), json!({"words": [{"v": "gm", "until": 2_000_000}], "users": [{"v": 7}], "blocks": []}));
    }

    #[test]
    fn words_are_whole_words() {
        assert!(has_word("gm $based frens", "$based"));
        assert!(!has_word("gm $basedgod", "$based"));
        assert!(!has_word("degen", "gen"));
        assert!(has_word("gen.", "gen"));
        assert!(has_word("ça gen", "gen"));
        assert!(!has_word("égen", "gen"));
        assert!(has_word("今日はビットコインの日", "ビットコイン"), "Japanese matches anywhere");
        let mut m = Mutes::default();
        m.set_word(" Crypto ", true, None);
        assert_eq!(m.word_in("Love CRYPTO!", 0), Some("crypto"));
        m.set_word("crypto", true, Some(10));
        assert_eq!(m.word_in("crypto", 20), None, "a mute that ran out lets it through");
    }

    #[test]
    fn people_on_and_off() {
        let mut m = Mutes::default();
        m.set_fid(false, 5, true, Some(100));
        m.set_fid(true, 6, true, None);
        assert!(m.muted(5, 50) && !m.muted(5, 150));
        assert!(m.blocked(6, u64::MAX) && m.silenced(6, 0));
        m.set_fid(true, 6, false, None);
        assert!(!m.blocked(6, 0));
    }

    #[test]
    fn removed_list_reads() {
        // removed() falls back to an empty list, so a broken file would quietly turn takedowns off
        let raw = include_str!("../../src/removed.json");
        assert!(!raw.trim().is_empty(), "src/removed.json is empty");
        let v: serde_json::Value = serde_json::from_str(raw).expect("src/removed.json parses");
        assert!(v.get("fids").is_some_and(|f| f.is_array()) && v.get("casts").is_some_and(|c| c.is_array()), "fids and casts lists");
        let r: Removed = serde_json::from_value(v).expect("as a Removed");
        assert_eq!(r.fids.len() + r.casts.len(), removed().fids.len() + removed().casts.len());
    }
}
