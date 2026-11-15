//! The spam filter (src/spam.ts): spam.quilcast.com scores every new cast and account, and casts or accounts at or
//! over the threshold get a "Spam 97%" or "Spam account 92%" label, or are hidden when Settings says Hide.

use crate::api::Cast;
use crate::app::{App, Want};
use crate::host;
use std::collections::{HashMap, HashSet};

pub const API: &str = "https://spam.quilcast.com/";
/// How long casts wait for their scores before they're drawn without them, when spam is hidden (src/spam.ts gives
/// up after 1.5 s too).
pub const WAIT: f64 = 1500.0;
/// A cast or account the service hadn't scored yet is asked about again after this long.
const AGAIN: f64 = 60e3;
/// Keys asked about in one request.
const AT_ONCE: usize = 100;

#[derive(Default)]
pub struct Spam {
    /// scores (0 to 1) by bare cast hash and by FID
    pub casts: HashMap<String, f64>,
    pub accounts: HashMap<u64, f64>,
    /// when each one without a score was last asked about
    asked_casts: HashMap<String, f64>,
    asked_accounts: HashMap<u64, f64>,
    /// the ones the service has answered about at least once (with a score or without one), or whose first request
    /// failed: those are never held back again, even while they're asked about again
    answered_casts: HashSet<String>,
    answered_accounts: HashSet<u64>,
}

impl Spam {
    /// Whether this cast (or its author) still has to be asked about, `now`.
    fn unasked(&self, hash: &str, fid: u64, now: f64) -> (bool, bool) {
        let c = !self.casts.contains_key(hash) && self.asked_casts.get(hash).is_none_or(|t| now - t > AGAIN);
        let a = !self.accounts.contains_key(&fid) && self.asked_accounts.get(&fid).is_none_or(|t| now - t > AGAIN);
        (c, a)
    }
    /// Whether the cast's score and its author's are still on their way for the first time: not asked yet, or asked
    /// less than WAIT ago and not answered. Once answered (a score or none), it never waits again.
    pub fn waiting(&self, hash: &str, fid: u64, now: f64) -> (bool, bool) {
        let c = !self.casts.contains_key(hash) && !self.answered_casts.contains(hash) && self.asked_casts.get(hash).is_none_or(|t| now - t < WAIT);
        // a stand-in author (FID 0) is never asked about, so nothing waits for it
        let a = fid > 0 && !self.accounts.contains_key(&fid) && !self.answered_accounts.contains(&fid) && self.asked_accounts.get(&fid).is_none_or(|t| now - t < WAIT);
        (c, a)
    }
}

/// Parses the service's answer: `{"<key>": score}`, where scores are numbers from 0 to 1.
pub fn scores(body: &[u8]) -> Vec<(String, f64)> {
    let v: serde_json::Value = serde_json::from_slice(body).unwrap_or_default();
    v.as_object().map(|o| o.iter().filter_map(|(k, s)| s.as_f64().filter(|s| (0.0..=1.0).contains(s)).map(|s| (k.clone(), s))).collect()).unwrap_or_default()
}

impl App {
    pub fn spam_at(&self) -> u32 {
        self.settings.spam_at.clamp(50, 99)
    }
    /// The percent shown when a score is at or over the threshold (compared unrounded, as src/spam.ts does).
    fn over(&self, s: Option<&f64>) -> Option<u32> {
        s.filter(|s| **s * 100.0 >= self.spam_at() as f64).map(|s| (s * 100.0).round() as u32)
    }
    /// The cast's spam percent when it's at or over the threshold. A cast whose score isn't known is asked about.
    pub fn spam_of(&self, c: &Cast) -> Option<u32> {
        self.want_spam(c);
        self.over(self.spam.casts.get(&c.bare_hash()))
    }
    /// The account's spam percent when it's at or over the threshold.
    pub fn spam_account_of(&self, fid: u64) -> Option<u32> {
        if fid > 0 && !self.spam.accounts.contains_key(&fid) && self.spam.unasked("", fid, host::ms()).1 {
            self.wants.borrow_mut().push(Want::SpamAccount(fid));
        }
        self.over(self.spam.accounts.get(&fid))
    }
    fn want_spam(&self, c: &Cast) {
        let h = c.bare_hash();
        let (cast, account) = self.spam.unasked(&h, c.author.fid, host::ms());
        if cast {
            self.wants.borrow_mut().push(Want::Spam(h));
        }
        if account && c.author.fid > 0 {
            self.wants.borrow_mut().push(Want::SpamAccount(c.author.fid));
        }
    }
    /// Whether Settings hides this cast as spam (src/spam.ts hidesSpam). While its scores are on their way, for up
    /// to WAIT, it's kept out too, so a cast that turns out to be spam doesn't show and then vanish.
    pub fn hides_spam(&self, c: &Cast) -> bool {
        let (casts, accounts) = (self.settings.spam == "hide", self.settings.spam_accounts == "hide");
        if !casts && !accounts {
            return false;
        }
        let pct = self.spam_of(c);
        if (casts && pct.is_some()) || (accounts && self.spam_account_of(c.author.fid).is_some()) {
            return true;
        }
        let (cw, aw) = self.spam.waiting(&c.bare_hash(), c.author.fid, host::ms());
        (casts && cw) || (accounts && aw)
    }

    /// Asks the service about the casts and accounts a page found unscored, 100 at a time. One it has no score for
    /// yet is asked about again a minute later.
    pub fn ask_spam(&mut self, hashes: Vec<String>, fids: Vec<u64>) {
        let now = host::ms();
        let hashes: Vec<String> = hashes.into_iter().filter(|h| self.spam.unasked(h, 0, now).0).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
        let fids: Vec<u64> = fids.into_iter().filter(|f| *f > 0 && self.spam.unasked("", *f, now).1).collect::<std::collections::BTreeSet<_>>().into_iter().collect();
        if hashes.is_empty() && fids.is_empty() {
            return;
        }
        for h in &hashes {
            self.spam.asked_casts.insert(h.clone(), now);
        }
        for f in &fids {
            self.spam.asked_accounts.insert(*f, now);
        }
        for chunk in hashes.chunks(AT_ONCE) {
            let q: Vec<String> = chunk.iter().map(|h| format!("0x{h}")).collect();
            let keys = chunk.to_vec();
            self.http("GET", &format!("{API}scores?h={}", q.join(",")), &[], "", move |app, status, body| {
                app.spam.answered_casts.extend(keys);
                if (200..300).contains(&status) {
                    for (k, s) in scores(&body) {
                        app.spam.casts.insert(k.trim_start_matches("0x").to_lowercase(), s);
                    }
                }
            });
        }
        for chunk in fids.chunks(AT_ONCE) {
            let q: Vec<String> = chunk.iter().map(u64::to_string).collect();
            let keys = chunk.to_vec();
            self.http("GET", &format!("{API}users?fid={}", q.join(",")), &[], "", move |app, status, body| {
                app.spam.answered_accounts.extend(keys);
                if (200..300).contains(&status) {
                    for (k, s) in scores(&body) {
                        if let Ok(f) = k.parse::<u64>() {
                            app.spam.accounts.insert(f, s);
                        }
                    }
                }
            });
        }
        // casts held back while hidden spam waits for its scores are drawn once the wait is over, answered or not
        // (an answer draws them at once)
        if self.settings.spam == "hide" || self.settings.spam_accounts == "hide" {
            self.later(WAIT + 50.0, |_| {});
        }
    }

    /// Tells Quilcast's moderators a spam label is wrong (src/ui.tsx notSpam, server/report.mjs).
    pub fn not_spam(&mut self, fid: u64, hash: Option<String>) {
        self.sheet = None;
        let mut j = serde_json::json!({"fid": fid, "reason": "not_spam", "text": ""});
        if let Some(h) = &hash {
            j["hash"] = serde_json::Value::String(format!("0x{h}"));
        }
        let body = j.to_string();
        let unsigned = body.clone();
        let done = |app: &mut App, status: i32, body: Vec<u8>| {
            if (200..300).contains(&status) {
                app.say("Thanks! We'll check that label.");
            } else {
                app.say(crate::api::error_text(status, &body));
            }
        };
        match self.me() {
            Some(me) => self.key_fetch("POST", "/api/report".into(), "quilcast-report", body, &format!("\nx-fid: {me}"), move |app, status, body| {
                if status == crate::app::SIGN_FAILED {
                    return app.http("POST", "/api/report", unsigned.as_bytes(), "application/json", done);
                }
                done(app, status, body)
            }),
            None => self.http("POST", "/api/report", body.as_bytes(), "application/json", done),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scores_are_numbers_from_0_to_1() {
        let mut s = scores(br#"{"0xab":0.97,"0xcd":"x","0xef":2,"12":0}"#);
        s.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(s, vec![("0xab".to_string(), 0.97), ("12".to_string(), 0.0)]);
        assert!(scores(b"not json").is_empty());
    }

    #[test]
    fn unscored_ones_wait_a_moment_then_are_asked_again_a_minute_later() {
        let mut s = Spam::default();
        assert_eq!(s.unasked("ab", 1, 0.0), (true, true));
        assert_eq!(s.waiting("ab", 1, 0.0), (true, true));
        s.asked_casts.insert("ab".into(), 0.0);
        s.asked_accounts.insert(1, 0.0);
        assert_eq!(s.unasked("ab", 1, 1000.0), (false, false));
        assert_eq!(s.waiting("ab", 1, 1000.0), (true, true));
        assert_eq!(s.waiting("ab", 1, WAIT + 1.0), (false, false), "drawn once the wait is over");
        assert_eq!(s.unasked("ab", 1, AGAIN + 1.0), (true, true));
        // answered without a score: shown at once, and never held back again when it's asked about again
        s.answered_casts.insert("ab".into());
        s.answered_accounts.insert(1);
        assert_eq!(s.waiting("ab", 1, 1.0), (false, false));
        s.asked_casts.insert("ab".into(), AGAIN + 1.0);
        s.asked_accounts.insert(1, AGAIN + 1.0);
        assert_eq!(s.waiting("ab", 1, AGAIN + 2.0), (false, false), "a re-ask never hides it");
        s.casts.insert("ab".into(), 0.1);
        s.accounts.insert(1, 0.1);
        assert_eq!(s.waiting("ab", 1, 0.0), (false, false));
        assert_eq!(s.waiting("cd", 0, 0.0), (true, false), "no FID, nothing to wait for");
        assert_eq!(s.unasked("ab", 1, 1e9), (false, false), "a score is kept");
    }
}
