//! Push notifications for each account's own activity (Settings → Notifications; src/alerts.ts, server/alerts.mjs):
//! replies, mentions, quotes, likes, recasts and follows reach this device with Quilcast closed. Each account is signed
//! up with its own key (`PUT /api/alerts/<fid>`, signed like mutes), so nobody can sign up for someone else's, and
//! picks its own kinds. What's on is kept here with the subscription it was signed up with and the settings last sent,
//! so a subscription the browser replaced, a changed spam setting or a sign-up the server lost is sent again on the
//! next start. Signing out turns it off. The service worker (public/sw.js, the same file quilcast.com uses) shows them
//! and opens the page a tap points to, as the account it was for.

use crate::api::error_text;
use crate::app::{Account, App};
use crate::host;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// The kinds, by the names the server takes, and how Settings writes them.
pub const KINDS: [(&str, &str); 6] = [("replies", "Replies"), ("mentions", "Mentions"), ("quotes", "Quotes"), ("likes", "Likes"), ("recasts", "Recasts"), ("follows", "Follows")];
const KEY: &str = "quilcast-wasm:alerts";

/// An account signed up here: the subscription's endpoint it was signed up with, its kinds and what the server was
/// last told (src/api.ts AlertsKept).
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct On {
    pub endpoint: String,
    pub kinds: Vec<String>,
    pub sent: String,
}

/// The accounts signed up here, and the sign-outs the server hasn't taken yet.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Kept {
    pub on: BTreeMap<u64, On>,
    pub off: Vec<(u64, String)>,
}

pub fn kept() -> Kept {
    let mut k: Kept = host::get(KEY).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    k.on.retain(|f, v| *f > 0 && !v.endpoint.is_empty());
    k.off.retain(|(f, e)| *f > 0 && !e.is_empty());
    k
}
fn save(k: &Kept) {
    host::set(KEY, &serde_json::to_string(k).unwrap_or_default());
}

/// The known kinds among `xs`, in their order; none known means all of them.
pub fn kinds_of(xs: &[String]) -> Vec<String> {
    let k: Vec<String> = KINDS.iter().filter(|(k, _)| xs.iter().any(|x| x == k)).map(|(k, _)| k.to_string()).collect();
    if k.is_empty() { KINDS.iter().map(|(k, _)| k.to_string()).collect() } else { k }
}

/// What this browser can do, as the shell last said: whether it has push at all (None until asked), the permission,
/// and the subscription it has (`PushSubscription.toJSON()`).
#[derive(Clone, Debug, Default)]
pub struct Push {
    pub can: Option<bool>,
    pub perm: String,
    pub sub: Option<Value>,
}
impl Push {
    pub fn endpoint(&self) -> Option<&str> {
        self.sub.as_ref()?.get("endpoint")?.as_str().filter(|e| !e.is_empty())
    }
}

/// The base64url VAPID key `/api/notify/vapid` answers, as bytes.
pub fn vapid_bytes(key: &str) -> Option<Vec<u8>> {
    let std: String = key.trim().chars().map(|c| match c {
        '-' => '+',
        '_' => '/',
        c => c,
    }).collect();
    crate::compose::unb64(&std).filter(|b| !b.is_empty())
}

pub const BLOCKED: &str = "Notifications are blocked for Quilcast in this browser. Allow them in the site settings (the icon left of the address).";

impl App {
    fn busy_key(fid: u64) -> String {
        format!("alerts:{fid}")
    }
    pub fn alerts_busy(&self, fid: u64) -> bool {
        self.busy.contains(&App::busy_key(fid))
    }

    /// The accounts that get them here, with their kinds: signed up with the subscription this browser still has.
    pub fn alerts_on(&self) -> BTreeMap<u64, Vec<String>> {
        let Some(e) = self.push.endpoint() else { return BTreeMap::new() };
        kept().on.into_iter().filter(|(_, v)| v.endpoint == e).map(|(f, v)| (f, kinds_of(&v.kinds))).collect()
    }

    /// What the server is told besides the subscription: the kinds, the language and the spam this browser hides.
    pub fn alert_settings(&self, kinds: &[String]) -> Value {
        json!({"kinds": kinds, "lang": "en", "spam": {"casts": self.settings.spam == "hide", "accounts": self.settings.spam_accounts == "hide", "at": self.spam_at()}})
    }

    /// Asks the shell what this browser has (push at all, the permission, the subscription), then `f`.
    pub fn push_check(&mut self, f: impl FnOnce(&mut App) + 'static) {
        let id = self.wait(move |app, code, body| {
            app.push = match (code, serde_json::from_slice::<Value>(&body)) {
                (1, Ok(v)) => Push { can: Some(true), perm: v["perm"].as_str().unwrap_or("default").to_string(), sub: Some(v["sub"].clone()).filter(|s| s.is_object()) },
                _ => Push { can: Some(false), ..Default::default() },
            };
            f(app)
        });
        host::push_state(id);
    }

    /// Sends the sign-outs still waiting (unsigned: the endpoint is this browser's secret). Each one stays on the
    /// list until the server took it, so one lost on the way goes again on the next start.
    pub fn flush_alerts_off(&mut self) {
        for (fid, endpoint) in kept().off {
            self.send_off(fid, endpoint, |_| {});
        }
    }
    fn send_off(&mut self, fid: u64, endpoint: String, then: impl FnOnce(&mut App) + 'static) {
        let body = json!({"endpoint": endpoint}).to_string();
        self.http("POST", &format!("/api/alerts/{fid}/off"), body.as_bytes(), "application/json", move |app, status, _| {
            if (200..300).contains(&status) {
                let mut k = kept();
                k.off.retain(|(f, e)| !(*f == fid && *e == endpoint));
                save(&k);
            }
            then(app)
        });
    }

    /// The account's notifications stop reaching this browser: it signed out here, or turned them off.
    pub fn forget_alerts(&mut self, fid: u64) {
        let mut k = kept();
        let Some(had) = k.on.remove(&fid) else { return };
        k.off.retain(|(f, e)| !(*f == fid && *e == had.endpoint));
        k.off.push((fid, had.endpoint.clone()));
        save(&k);
        // only this one: the others still waiting may be on their way already
        self.send_off(fid, had.endpoint, |_| {});
    }

    /// Signs `a` up for pushes to `sub` with `kinds`, as `a` (whichever account is in use), and keeps what was sent.
    /// `renew` (a sign-up the browser sends by itself): one turned off while it was on its way stays off.
    fn sign_up(&mut self, a: Account, sub: Value, kinds: Vec<String>, renew: bool, f: impl FnOnce(&mut App, Result<(), String>) + 'static) {
        let s = self.alert_settings(&kinds);
        let Some(endpoint) = sub.get("endpoint").and_then(|e| e.as_str()).map(String::from) else { return f(self, Err("This browser's push service didn't answer. Try again in a minute.".into())) };
        let mut body = s.clone();
        body["subscription"] = sub;
        let fid = a.fid;
        self.key_fetch_as(a, "PUT", format!("/api/alerts/{fid}"), "quilcast-alerts", body.to_string(), "", move |app, status, answer| {
            if !(200..300).contains(&status) {
                return f(app, Err(error_text(status, &answer)));
            }
            let mut k = kept();
            if renew && !k.on.contains_key(&fid) {
                // turned off (or signed out) meanwhile: the server, which just took it, is told to drop it again
                k.off.retain(|(f, e)| !(*f == fid && *e == endpoint));
                k.off.push((fid, endpoint.clone()));
                save(&k);
                app.send_off(fid, endpoint, |_| {});
                return f(app, Ok(()));
            }
            k.on.insert(fid, On { endpoint, kinds, sent: s.to_string() });
            save(&k);
            f(app, Ok(()))
        });
    }

    /// Settings' Turn on / Turn off for account `fid`. It runs straight from the click, so the browser's permission
    /// prompt (the shell's push_ask) is allowed to show.
    pub fn toggle_alerts(&mut self, fid: u64) {
        if self.alerts_busy(fid) || self.push.can != Some(true) {
            return;
        }
        if self.alerts_on().contains_key(&fid) {
            self.forget_alerts(fid);
            return self.say("Notifications off");
        }
        if !self.accounts.iter().any(|a| a.fid == fid) {
            return;
        }
        self.busy.insert(App::busy_key(fid));
        if self.push.perm == "granted" {
            return self.subscribe_alerts(fid);
        }
        let id = self.wait(move |app, code, _| {
            if code == 1 {
                app.push.perm = "granted".into();
                app.subscribe_alerts(fid)
            } else {
                app.busy.remove(&App::busy_key(fid));
                app.say(BLOCKED)
            }
        });
        host::push_prompt(id);
    }

    /// The subscription (made on first use with Quilcast's VAPID key), then the sign-up.
    fn subscribe_alerts(&mut self, fid: u64) {
        let fail = move |app: &mut App, e: String| {
            app.busy.remove(&App::busy_key(fid));
            app.say(e)
        };
        let up = move |app: &mut App, sub: Value| {
            let Some(a) = app.accounts.iter().find(|a| a.fid == fid).cloned() else { return fail(app, "Sign in again to turn notifications on.".into()) };
            let kinds = kinds_of(&kept().on.get(&fid).map(|v| v.kinds.clone()).unwrap_or_default());
            app.sign_up(a, sub, kinds, false, move |app, r| {
                app.busy.remove(&App::busy_key(fid));
                match r {
                    Ok(()) => app.say("Notifications on"),
                    Err(e) => app.say(e),
                }
            })
        };
        if let Some(sub) = self.push.sub.clone() {
            return up(self, sub);
        }
        self.get::<Value>("/api/notify/vapid".into(), move |app, r| {
            let Some(key) = r.ok().and_then(|v| v["key"].as_str().and_then(vapid_bytes)) else { return fail(app, "Couldn't reach Quilcast's server. Try again.".into()) };
            let id = app.wait(move |app, code, body| match (code, serde_json::from_slice::<Value>(&body)) {
                (1, Ok(sub)) if sub.get("endpoint").is_some_and(|e| e.is_string()) => {
                    app.push.sub = Some(sub.clone());
                    up(app, sub)
                }
                _ => fail(app, Some(String::from_utf8_lossy(&body).into_owned()).filter(|s| !s.is_empty() && s.len() < 300).unwrap_or_else(|| "This browser's push service didn't answer. Try again in a minute.".into())),
            });
            host::push_subscribe(id, &key);
        });
    }

    /// A kind ticked or unticked for `fid` (at least one stays: turning them all off is the button).
    pub fn toggle_alert_kind(&mut self, fid: u64, kind: &str) {
        let Some(kinds) = self.alerts_on().get(&fid).cloned() else { return };
        if self.alerts_busy(fid) {
            return;
        }
        let has = kinds.iter().any(|k| k == kind);
        if has && kinds.len() == 1 {
            return;
        }
        let next: Vec<String> = KINDS.iter().map(|(k, _)| k.to_string()).filter(|k| if k == kind { !has } else { kinds.contains(k) }).collect();
        let (Some(sub), Some(a)) = (self.push.sub.clone(), self.accounts.iter().find(|a| a.fid == fid).cloned()) else { return };
        self.busy.insert(App::busy_key(fid));
        self.sign_up(a, sub, next, false, move |app, r| {
            app.busy.remove(&App::busy_key(fid));
            if let Err(e) = r {
                app.say(e)
            }
        });
    }

    /// The spam settings changed: every account on here is told once the slider stops (1.5 s).
    pub fn spam_changed(&mut self) {
        self.alerts_gen += 1;
        let g = self.alerts_gen;
        self.later(1500.0, move |app| {
            if app.alerts_gen == g {
                app.refresh_alerts()
            }
        });
    }

    /// On each start (and when settings change): sign-outs still waiting go out, accounts this browser no longer
    /// holds go, and an account whose subscription the browser replaced, whose settings changed or that the server
    /// lost is signed up again, in the background with the key each account has now.
    pub fn refresh_alerts(&mut self) {
        self.flush_alerts_off();
        self.push_check(|app| {
            if app.push.can != Some(true) || app.push.perm != "granted" {
                return;
            }
            let sub = app.push.sub.clone();
            // the accounts as stored now: another tab may have signed one in (and turned it on) since this one loaded
            let held: Vec<Account> = host::get(crate::app::ACCOUNTS_KEY).and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_else(|| app.accounts.clone());
            for (fid, v) in kept().on {
                let Some(a) = held.iter().find(|a| a.fid == fid && !a.key.is_empty()).cloned() else {
                    app.forget_alerts(fid);
                    continue;
                };
                let Some(sub) = sub.clone() else { continue };
                let kinds = kinds_of(&v.kinds);
                let want = app.alert_settings(&kinds);
                let endpoint = sub["endpoint"].as_str().unwrap_or_default().to_string();
                if v.endpoint == endpoint {
                    if serde_json::from_str::<Value>(&v.sent).ok().as_ref() == Some(&want) {
                        // the server's answer is null once it dropped the sign-up, and other settings when it lost a
                        // change; a failed request leaves it be
                        let body = json!({"endpoint": endpoint}).to_string();
                        app.http("POST", &format!("/api/alerts/{fid}/state"), body.as_bytes(), "application/json", move |app, status, answer| {
                            if !(200..300).contains(&status) {
                                return;
                            }
                            match serde_json::from_slice::<Value>(&answer) {
                                Ok(known) if known == want => {}
                                Ok(_) => app.sign_up(a, sub, kinds, true, |_, _| {}),
                                Err(_) => {}
                            }
                        });
                    } else {
                        app.sign_up(a, sub, kinds, true, |_, _| {});
                    }
                    continue;
                }
                // a replaced subscription: the server stops pushing to the old one first, since it could refuse the
                // new one while the account has as many browsers as it takes. Only with a key here that can sign the
                // new one up, else the account would be left with neither (src/alerts.ts hasKey)
                app.can_sign(&a.clone(), move |app, ok| {
                    if !ok || kept().on.get(&fid).map(|x| &x.endpoint) != Some(&v.endpoint) {
                        return;
                    }
                    let mut k = kept();
                    k.off.retain(|(f, e)| !(*f == fid && *e == v.endpoint));
                    k.off.push((fid, v.endpoint.clone()));
                    save(&k);
                    app.send_off(fid, v.endpoint, move |app| app.sign_up(a, sub, kinds, true, |_, _| {}));
                });
            }
        });
    }
}

/// A window a tapped push notification opened (public/sw.js) carries the account it was for as `?as-fid=`: the
/// address without it, and the FID when it's a well-formed one (src/api.ts notifiedAs). None when there's none.
pub fn notified_as(path_q: &str) -> Option<(String, Option<u64>)> {
    let (path, rest) = path_q.split_once('?')?;
    let (q, hash) = match rest.split_once('#') {
        Some((q, h)) => (q, format!("#{h}")),
        None => (rest, String::new()),
    };
    let mut fid = None;
    let mut found = false;
    let kept: Vec<&str> = q.split('&').filter(|kv| {
        let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
        if crate::text::decode(k) != "as-fid" {
            return !kv.is_empty();
        }
        if !found {
            found = true;
            let v = crate::text::decode(v);
            let ok = (1..=16).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_digit()) && !v.starts_with('0');
            fid = if ok { v.parse::<u64>().ok() } else { None };
        }
        false
    }).collect();
    if !found {
        return None;
    }
    let q = if kept.is_empty() { String::new() } else { format!("?{}", kept.join("&")) };
    Some((format!("{path}{q}{hash}"), fid))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn as_fid_leaves_the_address_and_is_read_only_when_well_formed() {
        assert_eq!(notified_as("/u/x"), None);
        assert_eq!(notified_as("/u/x?a=b"), None);
        assert_eq!(notified_as("/u/x?as-fid=7"), Some(("/u/x".into(), Some(7))));
        assert_eq!(notified_as("/c/0xabc?x=1&as-fid=8#top"), Some(("/c/0xabc?x=1#top".into(), Some(8))));
        for v in ["5x", "", "07", "7.0", "-7", "1e1", "x"] {
            assert_eq!(notified_as(&format!("/c/1?a=b&as-fid={v}")), Some(("/c/1?a=b".into(), None)), "{v}");
        }
    }

    #[test]
    fn kinds_keep_their_order_and_none_means_all() {
        assert_eq!(kinds_of(&["follows".into(), "likes".into(), "nope".into()]), vec!["likes", "follows"]);
        assert_eq!(kinds_of(&[]).len(), 6);
        assert_eq!(kinds_of(&["nope".into()]).len(), 6);
    }

    use crate::app::{Route, ACCOUNT_KEY};
    use crate::fc;
    use ed25519_dalek::{Signature, SigningKey, Verifier};

    fn sent() -> Vec<(u32, String, Vec<u8>)> {
        host::SENT.with(|s| s.borrow_mut().drain(..).collect())
    }
    fn pushed() -> Vec<String> {
        host::PUSHED.with(|s| s.borrow_mut().drain(..).collect())
    }
    /// The id of the one push call made, which must be `what`.
    fn push_id(what: &str) -> u32 {
        let p = pushed();
        assert_eq!(p.len(), 1, "{p:?}");
        p[0].strip_prefix(&format!("{what} ")).unwrap_or_else(|| panic!("{p:?}")).parse().unwrap()
    }
    fn acct(fid: u64, name: &str, seed: [u8; 32]) -> Account {
        Account { fid, username: Some(name.into()), key: fc::hex(SigningKey::from_bytes(&seed).verifying_key().as_bytes()), raw: true, ..Default::default() }
    }
    /// Signed in to @one (77) and then @two (88), both with raw keys, so signing happens at once.
    fn two_accounts() -> App {
        let mut app = App::new();
        app.raw_seeds = vec![[1; 32], [2; 32]];
        app.set_account(Some(acct(77, "one", [1; 32])));
        app.set_account(Some(acct(88, "two", [2; 32])));
        sent();
        pushed();
        app
    }
    fn sub(endpoint: &str) -> Value {
        json!({"endpoint": endpoint, "expirationTime": null, "keys": {"p256dh": "BP", "auth": "au"}})
    }
    fn header<'a>(what: &'a str, name: &str) -> &'a str {
        what.lines().find_map(|l| l.strip_prefix(&format!("{name}: "))).unwrap_or_else(|| panic!("{name} in {what}"))
    }
    /// Checks a sign-up was signed by `seed` over `quilcast-alerts:<fid>:<ts>:<body>` and gives its body.
    fn signed_up(what: &str, body: &[u8], fid: u64, seed: [u8; 32]) -> Value {
        assert!(what.starts_with(&format!("PUT /api/alerts/{fid}\napplication/json\n")), "{what}");
        let k = SigningKey::from_bytes(&seed).verifying_key();
        assert_eq!(header(what, "x-key"), format!("0x{}", fc::hex(k.as_bytes())));
        let msg = format!("quilcast-alerts:{fid}:{}:{}", header(what, "x-ts"), String::from_utf8(body.to_vec()).unwrap());
        let sig = Signature::from_slice(&fc::unhex(header(what, "x-sig"))).unwrap();
        assert!(k.verify(msg.as_bytes(), &sig).is_ok());
        serde_json::from_slice(body).unwrap()
    }

    #[test]
    fn turning_on_asks_subscribes_and_signs_up_as_that_account() {
        let mut app = two_accounts();
        app.push = Push { can: Some(true), perm: "default".into(), sub: None };
        // @one, while @two is in use: the prompt comes straight from the click
        app.toggle_alerts(77);
        assert!(app.alerts_busy(77));
        let ask = push_id("ask");
        assert!(sent().is_empty());
        app.done(ask, 1, vec![]);
        let (id, what, _) = sent().pop().expect("the VAPID key");
        assert_eq!(what, "GET /api/notify/vapid");
        app.done(id, 200, br#"{"key":"AQID"}"#.to_vec());
        let s = push_id("sub");
        app.done(s, 1, sub("https://push.example/1").to_string().into_bytes());
        let (id, what, body) = sent().pop().expect("the sign-up");
        let b = signed_up(&what, &body, 77, [1; 32]);
        assert_eq!(b["subscription"], sub("https://push.example/1"));
        assert_eq!(b["kinds"], json!(["replies", "mentions", "quotes", "likes", "recasts", "follows"]));
        assert_eq!(b["lang"], "en");
        assert_eq!(b["spam"], json!({"casts": false, "accounts": false, "at": 70}));
        assert!(app.alerts_on().is_empty(), "on once the server took it");
        app.done(id, 200, b"{}".to_vec());
        assert_eq!(app.alerts_on().get(&77).map(|k| k.len()), Some(6));
        assert!(!app.alerts_busy(77));
        assert_eq!(app.toast.as_deref(), Some("Notifications on"));
        assert_eq!(app.me(), Some(88), "the account in use stays");

        // a kind unticked goes out signed the same way; the last one can't be
        app.toggle_alert_kind(77, "likes");
        let (id, what, body) = sent().pop().unwrap();
        assert_eq!(signed_up(&what, &body, 77, [1; 32])["kinds"], json!(["replies", "mentions", "quotes", "recasts", "follows"]));
        app.done(id, 200, b"{}".to_vec());
        assert!(!app.alerts_on()[&77].contains(&"likes".to_string()));
        let mut k = kept();
        k.on.get_mut(&77).unwrap().kinds = vec!["follows".into()];
        save(&k);
        app.toggle_alert_kind(77, "follows");
        assert!(sent().is_empty());

        // a refusal leaves it off and says why
        app.toggle_alerts(88);
        let (id, _, _) = sent().pop().expect("@two's sign-up, with the subscription it has now");
        app.done(id, 429, br#"{"error":"This browser gets notifications for too many accounts."}"#.to_vec());
        assert!(!app.alerts_on().contains_key(&88));
        assert_eq!(app.toast.as_deref(), Some("This browser gets notifications for too many accounts."));

        // turning off is unsigned (the endpoint is the secret) and is sent again until the server took it
        app.toggle_alerts(77);
        assert!(app.alerts_on().is_empty());
        let (id, what, body) = sent().pop().unwrap();
        assert_eq!(what, "POST /api/alerts/77/off\napplication/json");
        assert_eq!(serde_json::from_slice::<Value>(&body).unwrap(), json!({"endpoint": "https://push.example/1"}));
        app.done(id, 0, vec![]);
        assert_eq!(kept().off, vec![(77, "https://push.example/1".to_string())]);
        app.flush_alerts_off();
        let (id, _, _) = sent().pop().unwrap();
        app.done(id, 200, b"{}".to_vec());
        assert!(kept().off.is_empty());
    }

    #[test]
    fn a_blocked_prompt_or_a_browser_without_push_turns_nothing_on() {
        let mut app = two_accounts();
        app.toggle_alerts(77);
        assert!(pushed().is_empty(), "nothing before the browser said it has push");
        app.push = Push { can: Some(true), perm: "default".into(), sub: None };
        app.toggle_alerts(77);
        let ask = push_id("ask");
        app.done(ask, 0, vec![]);
        assert_eq!(app.toast.as_deref(), Some(BLOCKED));
        assert!(!app.alerts_busy(77) && sent().is_empty());
        // a push service that doesn't answer
        app.push.perm = "granted".into();
        app.toggle_alerts(77);
        let (id, _, _) = sent().pop().unwrap();
        app.done(id, 200, br#"{"key":"AQID"}"#.to_vec());
        let s = push_id("sub");
        app.done(s, 0, b"This browser's push service didn't answer. Try again in a minute.".to_vec());
        assert_eq!(app.toast.as_deref(), Some("This browser's push service didn't answer. Try again in a minute."));
        assert!(!app.alerts_busy(77) && app.alerts_on().is_empty());
    }

    #[test]
    fn each_start_signs_up_again_what_changed_and_drops_what_left() {
        let mut app = two_accounts();
        let all = kinds_of(&[]);
        let same = app.alert_settings(&all).to_string();
        save(&Kept {
            on: BTreeMap::from([
                // the browser replaced @one's subscription
                (77, On { endpoint: "https://push.example/old".into(), kinds: all.clone(), sent: same.clone() }),
                // @two is as it was sent
                (88, On { endpoint: "https://push.example/2".into(), kinds: all.clone(), sent: same.clone() }),
                // signed out in another tab
                (99, On { endpoint: "https://push.example/2".into(), kinds: all.clone(), sent: same.clone() }),
            ]),
            off: vec![],
        });
        app.refresh_alerts();
        let get = push_id("get");
        app.done(get, 1, json!({"perm": "granted", "sub": sub("https://push.example/2")}).to_string().into_bytes());
        let reqs = sent();
        let what: Vec<&str> = reqs.iter().map(|(_, w, _)| w.split('\n').next().unwrap()).collect();
        assert_eq!(what, vec!["POST /api/alerts/77/off", "POST /api/alerts/88/state", "POST /api/alerts/99/off"]);
        assert!(!kept().on.contains_key(&99));
        // the old subscription goes before the new one is signed up
        app.done(reqs[0].0, 200, b"{}".to_vec());
        let (id, w, body) = sent().pop().expect("@one again");
        assert_eq!(signed_up(&w, &body, 77, [1; 32])["subscription"]["endpoint"], "https://push.example/2");
        app.done(id, 200, b"{}".to_vec());
        assert_eq!(kept().on[&77].endpoint, "https://push.example/2");
        assert_eq!(kept().off, vec![(99, "https://push.example/2".to_string())], "until the server takes it");
        // the server lost @two: it's signed up again
        app.done(reqs[1].0, 200, b"null".to_vec());
        let (_, w, body) = sent().pop().expect("@two again");
        signed_up(&w, &body, 88, [2; 32]);
        // one the server still has as sent is left be
        app.refresh_alerts();
        let get = push_id("get");
        app.done(get, 1, json!({"perm": "granted", "sub": sub("https://push.example/2")}).to_string().into_bytes());
        let (id, w, _) = sent().into_iter().find(|(_, w, _)| w.starts_with("POST /api/alerts/88/state")).unwrap();
        assert!(w.contains("88"));
        app.done(id, 200, same.into_bytes());
        assert!(sent().is_empty());
        // a spam setting changed: the server hears it once the slider stops
        app.spam_changed();
        let first = app.next_id;
        app.spam_changed();
        let second = app.next_id;
        app.done(first, 1, vec![]);
        assert!(pushed().is_empty());
        app.done(second, 1, vec![]);
        let get = push_id("get");
        app.settings.spam = "hide".into();
        app.done(get, 1, json!({"perm": "granted", "sub": sub("https://push.example/2")}).to_string().into_bytes());
        let ups: Vec<_> = sent().into_iter().filter(|(_, w, _)| w.starts_with("PUT ")).collect();
        assert_eq!(ups.len(), 2, "both accounts");
        assert_eq!(serde_json::from_slice::<Value>(&ups[0].2).unwrap()["spam"]["casts"], true);
        // without the permission, nothing is signed up
        app.refresh_alerts();
        let get = push_id("get");
        app.done(get, 1, json!({"perm": "denied", "sub": null}).to_string().into_bytes());
        assert!(sent().iter().all(|(_, w, _)| w.contains("/off")));
    }

    #[test]
    fn an_account_not_in_use_has_its_raw_key_taken_out_of_the_vault_first() {
        let mut app = two_accounts();
        // only @two's key is out of the vault, as after a fresh start
        app.raw_seeds = vec![[2; 32]];
        app.push = Push { can: Some(true), perm: "granted".into(), sub: Some(sub("https://push.example/1")) };
        app.toggle_alerts(77);
        assert!(sent().is_empty(), "nothing goes out before the key is here");
        let vget = app.next_id;
        app.done(vget, 1, vec![1; 32]);
        let (id, what, body) = sent().pop().expect("the sign-up");
        signed_up(&what, &body, 77, [1; 32]);
        app.done(id, 200, b"{}".to_vec());
        assert!(app.alerts_on().contains_key(&77));
    }

    #[test]
    fn a_replaced_subscription_is_left_be_without_a_key_to_sign_the_new_one() {
        let mut app = two_accounts();
        app.raw_seeds = vec![[2; 32]];
        let sent_was = app.alert_settings(&kinds_of(&[])).to_string();
        let before = Kept { on: BTreeMap::from([(77, On { endpoint: "https://push.example/old".into(), kinds: kinds_of(&[]), sent: sent_was })]), off: vec![] };
        save(&before);
        app.refresh_alerts();
        let get = push_id("get");
        app.done(get, 1, json!({"perm": "granted", "sub": sub("https://push.example/2")}).to_string().into_bytes());
        assert!(sent().is_empty());
        let vget = app.next_id;
        app.done(vget, 0, vec![]);
        assert!(sent().is_empty(), "the old one isn't dropped either");
        assert_eq!(kept(), before);
    }

    #[test]
    fn an_account_another_tab_signed_in_keeps_its_notifications() {
        let mut app = two_accounts();
        let mut held = app.accounts.clone();
        held.push(acct(99, "three", [9; 32]));
        host::set(crate::app::ACCOUNTS_KEY, &serde_json::to_string(&held).unwrap());
        let same = app.alert_settings(&kinds_of(&[])).to_string();
        save(&Kept { on: BTreeMap::from([(99, On { endpoint: "https://push.example/2".into(), kinds: kinds_of(&[]), sent: same })]), off: vec![] });
        app.refresh_alerts();
        let get = push_id("get");
        app.done(get, 1, json!({"perm": "granted", "sub": sub("https://push.example/2")}).to_string().into_bytes());
        let what: Vec<String> = sent().into_iter().map(|(_, w, _)| w.lines().next().unwrap().to_string()).collect();
        assert_eq!(what, vec!["POST /api/alerts/99/state"]);
        assert!(kept().on.contains_key(&99));
    }

    #[test]
    fn one_turned_off_while_it_was_signed_up_again_stays_off() {
        let mut app = two_accounts();
        app.push = Push { can: Some(true), perm: "granted".into(), sub: Some(sub("https://push.example/2")) };
        save(&Kept { on: BTreeMap::from([(88, On { endpoint: "https://push.example/2".into(), kinds: kinds_of(&[]), sent: "{}".into() })]), off: vec![] });
        app.refresh_alerts();
        let get = push_id("get");
        app.done(get, 1, json!({"perm": "granted", "sub": sub("https://push.example/2")}).to_string().into_bytes());
        let (id, w, _) = sent().pop().expect("signed up again: its settings changed");
        assert!(w.starts_with("PUT /api/alerts/88"));
        app.toggle_alerts(88);
        let (off, _, _) = sent().pop().expect("turned off");
        app.done(off, 200, b"{}".to_vec());
        app.done(id, 200, b"{}".to_vec());
        assert!(kept().on.is_empty());
        let (_, w, body) = sent().pop().expect("dropped again on the server");
        assert!(w.starts_with("POST /api/alerts/88/off"));
        assert_eq!(body, br#"{"endpoint":"https://push.example/2"}"#);
    }

    #[test]
    fn signing_out_stops_that_accounts_notifications() {
        let mut app = two_accounts();
        save(&Kept { on: BTreeMap::from([(88, On { endpoint: "https://push.example/2".into(), kinds: kinds_of(&[]), sent: String::new() })]), off: vec![] });
        app.sign_out();
        let (id, _, _) = sent().into_iter().find(|(_, w, _)| w.contains("/v1/submitMessage")).unwrap();
        app.done(id, 200, b"{}".to_vec());
        assert!(sent().iter().any(|(_, w, b)| w.starts_with("POST /api/alerts/88/off") && b == br#"{"endpoint":"https://push.example/2"}"#));
        assert!(kept().on.is_empty());
    }

    #[test]
    fn a_tapped_notification_opens_its_page_as_its_account() {
        let mut app = two_accounts();
        app.open_notified("/notifications", 77);
        assert_eq!(app.me(), Some(77));
        assert_eq!(app.route, Route::Notifications);
        assert_eq!(serde_json::from_str::<Account>(&host::get(ACCOUNT_KEY).unwrap()).unwrap().fid, 77);
        // an account not signed in here changes nothing but the page; another site's address nothing at all
        app.open_notified("/u/someone", 5);
        assert_eq!(app.me(), Some(77));
        assert_eq!(app.route, Route::User("someone".into(), false));
        app.open_notified("//evil.example/x", 88);
        assert_eq!(app.me(), Some(77));
        // a cast still going out keeps the account and the page
        app.compose = Some(crate::app::Compose::new(1));
        app.compose.as_mut().unwrap().sending = true;
        app.open_notified("/notifications", 88);
        assert_eq!((app.me(), &app.route), (Some(77), &Route::User("someone".into(), false)));
        app.compose = None;
        // a failed scheduled cast opens the composer's Scheduled list
        app.open_notified("/?scheduled", 0);
        assert_eq!(app.path, "/");
        assert!(matches!(app.compose.as_ref().and_then(|c| c.panel.as_ref()), Some(crate::compose::Panel::Scheduled)));
    }

    #[test]
    fn vapid_keys_are_base64url() {
        assert_eq!(vapid_bytes("-_8"), Some(vec![0xfb, 0xff]));
        assert_eq!(vapid_bytes("AQID"), Some(vec![1, 2, 3]));
        assert_eq!(vapid_bytes("!!"), None);
    }
}
