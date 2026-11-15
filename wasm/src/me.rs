//! The accounts this browser is signed in to (src/app.tsx AccountList, src/api.ts switchAccount) and editing the
//! signed-in account's profile: its photo, name, bio and website (src/app.tsx Settings), as USER_DATA_ADD messages
//! this browser's key signs.

use crate::app::*;
use crate::compose::{Attach, Picked, Step};
use crate::{fc, host};

/// USER_DATA_TYPE_PFP, _DISPLAY, _BIO and _URL (src/api.ts USER_DATA).
pub const PFP: u64 = 1;
pub const DISPLAY: u64 = 2;
pub const BIO: u64 = 3;
pub const URL: u64 = 5;
/// What quilcast.com lets each field hold (its inputs' maxLength).
pub const FIELD_MAX: usize = 256;

/// The profile fields Settings edits.
#[derive(Clone, Default, PartialEq, Debug)]
pub struct Prof {
    pub pfp: String,
    pub display: String,
    pub bio: String,
    pub url: String,
}
impl Prof {
    pub fn get(&self, k: u64) -> &str {
        match k {
            PFP => &self.pfp,
            DISPLAY => &self.display,
            BIO => &self.bio,
            _ => &self.url,
        }
    }
    pub fn set(&mut self, k: u64, v: String) {
        match k {
            PFP => self.pfp = v,
            DISPLAY => self.display = v,
            BIO => self.bio = v,
            _ => self.url = v,
        }
    }
    /// The fields `now` changes, in the order they're sent.
    pub fn changes(&self, now: &Prof) -> Vec<(u64, String)> {
        [PFP, DISPLAY, BIO, URL].into_iter().filter(|k| self.get(*k) != now.get(*k)).map(|k| (k, now.get(k).to_string())).collect()
    }
}

/// Settings → Profile while it's open: what the node has (`orig`, None until it's read), what the fields say now,
/// and a new photo on its way up.
#[derive(Default, Debug)]
pub struct Edit {
    pub fid: u64,
    pub orig: Option<Prof>,
    pub error: Option<String>,
    pub now: Prof,
    pub photo: Option<Attach>,
    pub saving: bool,
}
impl Edit {
    /// The fields as they would go out: the new photo once it's uploaded.
    pub fn wanted(&self) -> Prof {
        let mut p = self.now.clone();
        if let Some(u) = self.photo.as_ref().filter(|a| a.step == Step::Ready).and_then(|a| a.url.clone()) {
            p.pfp = u;
        }
        p
    }
    pub fn changes(&self) -> Vec<(u64, String)> {
        self.orig.as_ref().map_or(Vec::new(), |o| o.changes(&self.wanted()))
    }
    pub fn photo_busy(&self) -> bool {
        self.photo.as_ref().is_some_and(|a| !matches!(a.step, Step::Ready | Step::Failed(_)))
    }
}

/// The accounts list as it's stored now, or None when this browser has none yet.
pub(crate) fn stored_accounts() -> Option<Vec<Account>> {
    let mut v: Vec<Account> = serde_json::from_str(&host::get(ACCOUNTS_KEY)?).ok()?;
    v.retain(|a| a.fid > 0 && !a.key.is_empty());
    Some(v)
}

/// A profile's fields from `/v1/userDataByFid`: each message's type comes as its name or its number.
pub fn read_prof(v: &serde_json::Value) -> Prof {
    let mut p = Prof::default();
    for m in v.get("messages").and_then(|m| m.as_array()).into_iter().flatten() {
        let Some(b) = m.get("data").and_then(|d| d.get("userDataBody")) else { continue };
        let k = match b.get("type") {
            Some(serde_json::Value::String(s)) => match s.trim_start_matches("USER_DATA_TYPE_") {
                "PFP" => PFP,
                "DISPLAY" => DISPLAY,
                "BIO" => BIO,
                "URL" => URL,
                _ => continue,
            },
            Some(n) => match n.as_u64() {
                Some(k @ (PFP | DISPLAY | BIO | URL)) => k,
                _ => continue,
            },
            None => continue,
        };
        p.set(k, b.get("value").and_then(|v| v.as_str()).unwrap_or("").to_string());
    }
    p
}

impl App {
    // --- several accounts ---

    pub(crate) fn save_accounts(&self) {
        host::set(ACCOUNTS_KEY, &serde_json::to_string(&self.accounts).unwrap_or_default());
    }

    /// Takes the list as it's stored now before changing it (src/api.ts setAccount): another tab may have signed an
    /// account in or out since this one read it, and writing this tab's older copy back would undo that. A browser
    /// that has no list yet (a session from before several accounts) keeps the one it made.
    pub(crate) fn reread_accounts(&mut self) {
        if let Some(v) = stored_accounts() {
            self.accounts = v;
        }
    }

    /// Another tab changed the accounts (the shell forwards its `storage` events, as src/api.ts listens to them):
    /// this tab takes the list, and starts over on Home when the account it uses was signed out there (or signed
    /// out and in again, with another key: the one this tab holds is revoked).
    pub fn accounts_changed(&mut self) {
        let fresh = match stored_accounts() {
            Some(v) => v,
            // a session from before several accounts, as long as it's still there
            None if host::get(ACCOUNT_KEY).is_some() => return,
            // everything cleared
            None => Vec::new(),
        };
        // the keys of accounts signed out elsewhere go from memory too (only those: one this tab is still signing in
        // with isn't on the list yet)
        let gone: Vec<String> = self.accounts.iter().filter(|a| !fresh.iter().any(|x| x.key == a.key)).map(|a| a.key.clone()).collect();
        self.accounts = fresh;
        self.raw_seeds.retain(|s| !gone.contains(&fc::hex(ed25519_dalek::SigningKey::from_bytes(s).verifying_key().as_bytes())));
        let Some(a) = self.account.clone() else { return };
        if let Some(x) = self.accounts.iter().find(|x| x.fid == a.fid && x.key == a.key) {
            // still here: its name and face as the other tab last saved them
            self.account = Some(x.clone());
            return;
        }
        let name = a.username.clone().map_or_else(|| format!("!{}", a.fid), |u| format!("@{u}"));
        // the account the other tab handed over to, as a reload here would pick it
        let now: Option<Account> = host::get(ACCOUNT_KEY).and_then(|s| serde_json::from_str(&s).ok());
        let next = now.and_then(|n| self.accounts.iter().find(|x| x.fid == n.fid).cloned()).or_else(|| self.accounts.first().cloned());
        match next {
            Some(next) => {
                let other = next.username.clone().map_or_else(|| format!("!{}", next.fid), |u| format!("@{u}"));
                self.use_account(next);
                self.navigate("/", false);
                self.say(format!("Signed out of {name} in another tab. Using {other}"));
            }
            None => {
                self.set_account(None);
                self.navigate("/", false);
                self.say(format!("Signed out of {name} in another tab"));
            }
        }
    }

    /// Whether the raw key with public key `key` (hex) is out of the vault.
    pub(crate) fn has_seed(&self, key: &str) -> bool {
        self.raw_seeds.iter().any(|s| fc::hex(ed25519_dalek::SigningKey::from_bytes(s).verifying_key().as_bytes()) == key)
    }
    /// Keeps a raw key out of the vault, if an account here still uses it (one signed out meanwhile stays gone).
    pub(crate) fn keep_seed(&mut self, s: [u8; 32]) {
        let key = fc::hex(ed25519_dalek::SigningKey::from_bytes(&s).verifying_key().as_bytes());
        if !self.has_seed(&key) && self.accounts.iter().any(|a| a.key == key) {
            self.raw_seeds.push(s);
        }
    }

    /// Whether something of the account in use is still going out: a cast, a profile, or signing out.
    pub(crate) fn sending(&self) -> bool {
        self.compose.as_ref().is_some_and(|c| c.sending) || self.edit.as_ref().is_some_and(|e| e.saving) || self.busy.contains("signout")
    }

    /// Whether switching or signing out has to wait: a cast or a profile still on its way would go out halfway,
    /// or as the other account.
    pub(crate) fn account_busy(&mut self) -> bool {
        if self.compose.as_ref().is_some_and(|c| c.sending) {
            self.say("Wait for the cast to finish sending.");
            return true;
        }
        if self.edit.as_ref().is_some_and(|e| e.saving) {
            self.say("Wait for your profile to finish saving.");
            return true;
        }
        self.busy.contains("signout")
    }

    /// Makes `a` the account in use: its key comes out of the vault first when it's a raw one, then its mutes are
    /// read (that request is signed).
    pub(crate) fn use_account(&mut self, a: Account) {
        let raw = a.raw;
        let key = a.key.clone();
        self.set_account(Some(a));
        if raw && !self.has_seed(&key) {
            let fid = self.me();
            let id = self.wait(move |app, code, bytes| {
                if let (1, Ok(s)) = (code, <[u8; 32]>::try_from(bytes.as_slice())) {
                    app.keep_seed(s);
                }
                if app.me() == fid {
                    app.sync_mutes();
                }
            });
            host::vget(id, &format!("raw:{key}"));
        }
    }

    /// Switches to another account signed in here, staying on the page (read again for it).
    pub fn switch_account(&mut self, fid: u64) {
        if self.me() == Some(fid) || self.account_busy() {
            return;
        }
        let Some(a) = self.accounts.iter().find(|a| a.fid == fid).cloned() else { return };
        let name = a.username.clone().map_or_else(|| format!("!{}", a.fid), |u| format!("@{u}"));
        self.use_account(a);
        // a page about the previous account (its notifications, its profile tab) is read again for this one
        self.load_route();
        self.say(format!("Using {name}"));
    }

    // --- the profile ---

    /// Reads the account's profile fields for Settings (once a visit, and again for another account).
    pub fn load_edit(&mut self) {
        let Some(fid) = self.me() else { return };
        if self.edit.as_ref().is_some_and(|e| e.fid == fid && (e.orig.is_some() || e.error.is_none())) {
            return;
        }
        self.drop_edit();
        self.edit = Some(Edit { fid, ..Default::default() });
        let url = self.node("/v1/userDataByFid", &[("fid", fid.to_string()), ("pageSize", "100".into())]);
        self.get::<serde_json::Value>(url, move |app, r| {
            let Some(e) = app.edit.as_mut().filter(|e| e.fid == fid && e.orig.is_none()) else { return };
            match r {
                Ok(v) => {
                    let p = read_prof(&v);
                    e.now = p.clone();
                    e.orig = Some(p);
                }
                // a profile with nothing set yet is an empty one
                Err((404, _)) => e.orig = Some(Prof::default()),
                Err((_, err)) => e.error = Some(err),
            }
        });
    }

    /// Reads the profile again after it couldn't be read.
    pub fn retry_edit(&mut self) {
        self.drop_edit();
        self.load_edit();
    }

    /// Lets go of the profile being edited and its photo (stopping its upload).
    pub(crate) fn drop_edit(&mut self) {
        let Some(e) = self.edit.take() else { return };
        self.drop_photo(e.photo);
    }
    fn drop_photo(&mut self, a: Option<Attach>) {
        let Some(a) = a else { return };
        if let Some(f) = a.file {
            host::fdrop(f);
        }
        if let Some(id) = a.upload {
            self.http("DELETE", &format!("/api/upload/{id}"), &[], "", |_, _, _| {});
        }
    }

    pub fn edit_field(&mut self, k: u64, v: &str) {
        if let Some(e) = self.edit.as_mut().filter(|e| !e.saving) {
            e.now.set(k, v.to_string());
        }
    }

    /// A new photo picked in Settings: drawn again by the browser (so its EXIF is gone) and uploaded like a cast's.
    pub fn pick_photo(&mut self, picked: &str) {
        let mut files: Vec<Picked> = serde_json::from_str(picked).unwrap_or_default();
        let first = if files.is_empty() { None } else { Some(files.remove(0)) };
        files.iter().for_each(|f| host::fdrop(f.id));
        let Some(f) = first else { return };
        if self.edit.as_ref().is_none_or(|e| e.saving || e.orig.is_none()) {
            return host::fdrop(f.id);
        }
        if !["image/jpeg", "image/png", "image/webp", "image/gif"].contains(&f.kind.as_str()) {
            host::fdrop(f.id);
            return self.say("Use a JPEG, PNG, GIF or WebP picture.");
        }
        self.attach_seq += 1;
        let n = self.attach_seq;
        let a = Attach { n, url: None, preview: host::furl(f.id), video: false, name: f.name.clone(), step: Step::Preparing, file: Some(f.id), upload: None };
        let old = self.edit.as_mut().and_then(|e| e.photo.replace(a));
        self.drop_photo(old);
        self.start_file(n, f);
    }

    /// Takes the new photo off again, keeping the one the profile has.
    pub fn unpick_photo(&mut self) {
        let Some(e) = self.edit.as_mut().filter(|e| !e.saving) else { return };
        let old = e.photo.take();
        self.drop_photo(old);
    }

    /// Sends what changed, one USER_DATA_ADD a field, as quilcast.com does.
    pub fn save_profile(&mut self) {
        let Some(e) = self.edit.as_ref() else { return };
        if e.saving || e.orig.is_none() {
            return;
        }
        if e.photo_busy() {
            return self.say("Wait for the photo to finish uploading.");
        }
        let todo = e.changes();
        if todo.is_empty() {
            return;
        }
        // counted as the fields' maxlength counts (UTF-16 units)
        if todo.iter().any(|(_, v)| v.encode_utf16().count() > FIELD_MAX) {
            return self.say(format!("Each field holds {FIELD_MAX} characters at most."));
        }
        let fid = e.fid;
        if self.me() != Some(fid) {
            return;
        }
        if let Some(e) = self.edit.as_mut() {
            e.saving = true;
        }
        self.save_next(fid, todo);
    }

    fn save_next(&mut self, fid: u64, mut todo: Vec<(u64, String)>) {
        if self.me() != Some(fid) || self.edit.as_ref().is_none_or(|e| e.fid != fid) {
            return;
        }
        if todo.is_empty() {
            return self.profile_saved(fid);
        }
        let (k, v) = todo.remove(0);
        self.send(fc::mt::USER_DATA_ADD, fc::user_data_body(k, &v), move |app, r| {
            let Some(e) = app.edit.as_mut().filter(|e| e.fid == fid) else { return };
            match r {
                Ok(_) => {
                    // what went out counts as the profile's now, so a later failure leaves only the rest to save
                    if let Some(o) = e.orig.as_mut() {
                        o.set(k, v.clone());
                    }
                    let old = if k == PFP {
                        e.now.pfp = v;
                        e.photo.take()
                    } else {
                        None
                    };
                    app.drop_photo(old);
                    app.save_next(fid, todo);
                }
                Err(err) => {
                    e.saving = false;
                    app.say(format!("Couldn't save your profile: {err}"));
                }
            }
        });
    }

    fn profile_saved(&mut self, fid: u64) {
        let Some(e) = self.edit.as_mut() else { return };
        e.saving = false;
        let p = e.orig.clone().unwrap_or_default();
        // the name and face Quilcast shows for the account, and its profile page, read again
        if let Some(a) = self.account.as_mut().filter(|a| a.fid == fid) {
            a.display = Some(p.display.clone()).filter(|s| !s.is_empty());
            a.pfp = Some(p.pfp.clone()).filter(|s| !s.is_empty());
            let a = a.clone();
            host::set(ACCOUNT_KEY, &serde_json::to_string(&a).unwrap_or_default());
            self.reread_accounts();
            if let Some(x) = self.accounts.iter_mut().find(|x| x.fid == fid) {
                *x = a;
            }
            self.save_accounts();
        }
        self.profiles.retain(|_, u| !matches!(u, Load::Ready(u) if u.fid == fid));
        self.say("Profile saved");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::SigningKey;

    fn sent() -> Vec<(u32, String, Vec<u8>)> {
        host::SENT.with(|s| s.borrow_mut().drain(..).collect())
    }
    fn acct(fid: u64, name: &str, seed: [u8; 32]) -> Account {
        Account { fid, username: Some(name.into()), key: fc::hex(SigningKey::from_bytes(&seed).verifying_key().as_bytes()), raw: true, ..Default::default() }
    }
    /// Signed in to @one (77) and then @two (88), both with raw keys, so signing happens at once.
    fn two_accounts() -> App {
        sent();
        let mut app = App::new();
        app.raw_seeds = vec![[1; 32], [2; 32]];
        app.set_account(Some(acct(77, "one", [1; 32])));
        app.set_account(Some(acct(88, "two", [2; 32])));
        sent();
        app
    }
    /// Whether a submitted message names the key of `seed` as its signer (fc::seal field 6: tag 0x32, length 32).
    fn signed_by(msg: &[u8], seed: [u8; 32]) -> bool {
        let mut f = vec![0x32, 32];
        f.extend_from_slice(SigningKey::from_bytes(&seed).verifying_key().as_bytes());
        msg.windows(34).any(|w| w == f.as_slice())
    }

    #[test]
    fn accounts_are_kept_switched_and_signing_out_hands_over_to_the_next() {
        let mut app = two_accounts();
        assert_eq!(app.me(), Some(88));
        // kept for the next visit, the one in use too
        let again = App::new();
        assert_eq!(again.accounts.iter().map(|a| a.fid).collect::<Vec<_>>(), vec![77, 88]);
        assert_eq!(again.me(), Some(88));

        app.feeds.insert("following:88".into(), Default::default());
        app.switch_account(77);
        assert_eq!(app.me(), Some(77));
        assert!(!app.feeds.contains_key("following:88"), "what was read for @two goes");
        assert_eq!(app.toast.as_deref(), Some("Using @one"));
        assert_eq!(serde_json::from_str::<Account>(&host::get(ACCOUNT_KEY).unwrap()).unwrap().fid, 77);

        // signing out of @one revokes its key with its own signature, and @two takes over
        sent();
        app.sign_out();
        let (id, what, msg) = sent().into_iter().find(|(_, w, _)| w.contains("/v1/submitMessage")).expect("a KEY_REMOVE");
        assert!(what.starts_with("POST "));
        assert!(signed_by(&msg, [1; 32]));
        app.done(id, 200, b"{}".to_vec());
        assert_eq!(app.me(), Some(88));
        assert_eq!(app.accounts.len(), 1);
        assert_eq!(app.raw_seeds, vec![[2u8; 32]], "@one's key is gone from memory too");
        assert_eq!(app.toast.as_deref(), Some("Signed out of @one. Using @two"));
        assert_eq!(App::new().accounts.len(), 1);

        // the last one leaves the browser signed out
        sent();
        app.sign_out();
        let (id, _, _) = sent().into_iter().find(|(_, w, _)| w.contains("/v1/submitMessage")).unwrap();
        app.done(id, 200, b"{}".to_vec());
        assert!(app.account.is_none() && app.accounts.is_empty());
        assert_eq!(app.toast.as_deref(), Some("Signed out"));
        assert!(App::new().account.is_none());
    }

    fn stored() -> Vec<u64> {
        stored_accounts().unwrap().iter().map(|a| a.fid).collect()
    }
    fn sign_out_now(app: &mut App) {
        sent();
        app.sign_out();
        let (id, _, _) = sent().into_iter().find(|(_, w, _)| w.contains("/v1/submitMessage")).expect("a KEY_REMOVE");
        app.done(id, 200, b"{}".to_vec());
    }

    #[test]
    fn an_account_another_tab_signed_in_survives_this_tabs_saves() {
        sent();
        // this tab opened with @one alone; another tab, opened as well, then signs in to @two
        let mut tab = App::new();
        tab.raw_seeds = vec![[1; 32]];
        tab.set_account(Some(acct(77, "one", [1; 32])));
        let mut other = App::new();
        other.raw_seeds = vec![[1; 32], [2; 32]];
        other.set_account(Some(acct(88, "two", [2; 32])));
        assert_eq!(stored(), vec![77, 88]);
        assert_eq!(tab.accounts.len(), 1, "no storage event yet");

        // a new account here, its profile saved, and signing out of it: @two stays stored throughout
        tab.set_account(Some(acct(99, "three", [3; 32])));
        tab.raw_seeds.push([3; 32]);
        assert_eq!(stored(), vec![77, 88, 99]);
        tab.edit = Some(Edit { fid: 99, orig: Some(Prof::default()), ..Default::default() });
        tab.profile_saved(99);
        assert_eq!(stored(), vec![77, 88, 99]);
        sign_out_now(&mut tab);
        assert_eq!(stored(), vec![77, 88]);
        assert_eq!(tab.me(), Some(77));
        assert_eq!(tab.accounts.iter().map(|a| a.fid).collect::<Vec<_>>(), vec![77, 88], "and this tab lists it now");

        // the storage event alone brings it over as well, without changing the account in use
        other.set_account(Some(acct(55, "four", [4; 32])));
        sent();
        tab.accounts_changed();
        assert_eq!(tab.accounts.iter().map(|a| a.fid).collect::<Vec<_>>(), vec![77, 88, 55]);
        assert_eq!(tab.me(), Some(77));
        assert!(sent().is_empty(), "nothing read again");
        // and switching to it works from here
        tab.switch_account(55);
        assert_eq!(tab.me(), Some(55));
    }

    #[test]
    fn an_account_signed_out_in_another_tab_starts_this_one_over() {
        let mut tab = two_accounts();
        tab.route = Route::Settings;
        let mut other = App::new();
        other.raw_seeds = vec![[1; 32], [2; 32]];
        assert_eq!(other.me(), Some(88));

        // the other tab signs out of @one, not the account in use here: this tab only drops it from its list
        other.switch_account(77);
        sign_out_now(&mut other);
        assert_eq!(other.me(), Some(88));
        tab.accounts_changed();
        assert_eq!(tab.me(), Some(88));
        assert_eq!(tab.route, Route::Settings);
        assert_eq!(tab.accounts.len(), 1);
        assert_eq!(tab.raw_seeds, vec![[2u8; 32]], "@one's key is gone from memory here too");

        // then it signs out of @two and in again, with another key: the one this tab holds is revoked, so it starts
        // over, with the account as the other tab has it now
        other.set_account(Some(acct(88, "two", [6; 32])));
        other.raw_seeds = vec![[6; 32]];
        tab.feeds.insert("trending:old".into(), Default::default());
        tab.accounts_changed();
        assert_eq!(tab.account.as_ref().map(|a| a.key.clone()), Some(acct(88, "two", [6; 32]).key));
        assert_eq!(tab.route, Route::Home(false));
        assert!(!tab.feeds.contains_key("trending:old"), "what was read with the old key goes");
        assert_eq!(tab.toast.as_deref(), Some("Signed out of @two in another tab. Using @two"));
        assert!(tab.raw_seeds.is_empty(), "the revoked key is let go");

        // @one signed in there and then @two signed out: this tab goes on as the account the other tab handed over to
        other.set_account(Some(acct(77, "one", [5; 32])));
        other.raw_seeds.push([5; 32]);
        other.switch_account(88);
        sign_out_now(&mut other);
        assert_eq!(other.me(), Some(77));
        tab.route = Route::Settings;
        tab.accounts_changed();
        assert_eq!(tab.me(), Some(77));
        assert_eq!(tab.route, Route::Home(false));
        assert_eq!(tab.toast.as_deref(), Some("Signed out of @two in another tab. Using @one"));
        assert_eq!(stored(), vec![77]);

        // the last one signed out there leaves this tab signed out
        sign_out_now(&mut other);
        assert!(other.account.is_none());
        tab.accounts_changed();
        assert!(tab.account.is_none() && tab.accounts.is_empty());
        assert_eq!(tab.toast.as_deref(), Some("Signed out of @one in another tab"));
        assert!(App::new().account.is_none());
    }

    #[test]
    fn a_storage_event_keeps_the_key_of_an_account_still_signing_in_here() {
        let mut tab = two_accounts();
        // add_key has the new raw key in hand; the account reaches the list only once the node lists the key
        tab.raw_seeds.push([3; 32]);
        let mut other = App::new();
        other.switch_account(77);
        tab.accounts_changed();
        assert!(tab.has_seed(&acct(99, "three", [3; 32]).key));
        tab.join_done(acct(99, "three", [3; 32]));
        assert_eq!(tab.me(), Some(99));
        assert!(tab.has_seed(&acct(99, "three", [3; 32]).key), "it can sign");
        assert_eq!(stored(), vec![77, 88, 99]);
    }

    #[test]
    fn a_session_from_before_several_accounts_keeps_its_account_on_a_storage_event() {
        sent();
        host::set(ACCOUNT_KEY, &serde_json::to_string(&acct(77, "one", [1; 32])).unwrap());
        let mut tab = App::new();
        assert_eq!(tab.accounts.len(), 1);
        tab.accounts_changed();
        assert_eq!(tab.me(), Some(77));
        assert_eq!(tab.accounts.len(), 1);
        // everything cleared in another tab signs this one out
        host::del(ACCOUNT_KEY);
        tab.accounts_changed();
        assert!(tab.account.is_none() && tab.accounts.is_empty());
    }

    #[test]
    fn signing_out_right_after_switching_waits_for_the_raw_key_and_revokes_it() {
        let mut app = two_accounts();
        app.switch_account(77);
        // the switch happened before @one's key came out of the vault
        app.raw_seeds = vec![[2; 32]];
        sent();
        app.sign_out();
        assert!(sent().is_empty(), "nothing goes out without the key");
        let vget = app.next_id;
        app.done(vget, 1, vec![1; 32]);
        let (id, _, msg) = sent().into_iter().find(|(_, w, _)| w.contains("/v1/submitMessage")).expect("the KEY_REMOVE");
        assert!(signed_by(&msg, [1; 32]));
        app.done(id, 200, b"{}".to_vec());
        assert_eq!(app.me(), Some(88));
        assert_eq!(app.raw_seeds, vec![[2u8; 32]]);
        // and a key read for an account signed out meanwhile isn't kept
        app.keep_seed([1; 32]);
        assert_eq!(app.raw_seeds, vec![[2u8; 32]]);
    }

    #[test]
    fn an_account_added_while_a_profile_saves_waits_for_it() {
        let mut app = two_accounts();
        app.edit = Some(Edit { fid: 88, orig: Some(Prof::default()), saving: true, ..Default::default() });
        app.join_done(acct(99, "three", [3; 32]));
        assert_eq!(app.me(), Some(88), "the save isn't cut off");
        app.edit.as_mut().unwrap().saving = false;
        let timer = app.next_id;
        app.done(timer, 1, vec![]);
        assert_eq!(app.me(), Some(99));
        assert_eq!(app.accounts.len(), 3);
    }

    #[test]
    fn switching_waits_for_a_cast_or_a_profile_on_its_way() {
        let mut app = two_accounts();
        app.edit = Some(Edit { fid: 88, orig: Some(Prof::default()), saving: true, ..Default::default() });
        app.switch_account(77);
        assert_eq!(app.me(), Some(88));
        assert_eq!(app.toast.as_deref(), Some("Wait for your profile to finish saving."));
    }

    #[test]
    fn answers_for_the_previous_account_dont_land_in_the_next() {
        let mut app = two_accounts();
        app.route = Route::Notifications;
        app.load_notes(false, true);
        let (id, _, _) = sent().pop().expect("notifications asked");
        app.switch_account(77);
        sent();
        app.done(id, 200, br#"{"notifications":[{"type":"follows"}],"next":{"cursor":null}}"#.to_vec());
        assert!(app.notes.items.is_empty(), "@two's notifications aren't @one's");
        // nor does a feed read for @two, though the new one starts afresh
        app.load_feed("trending".into(), false);
        let (old, _, _) = sent().pop().unwrap();
        app.switch_account(88);
        app.load_feed("trending".into(), false);
        sent();
        app.done(old, 200, br#"{"casts":[{"hash":"0xaa"}],"next":{"cursor":null}}"#.to_vec());
        assert!(app.feeds.get("trending").is_some_and(|f| f.items.is_empty() && f.loading));
    }

    #[test]
    fn signing_in_to_an_account_already_here_switches_to_it_without_a_new_key() {
        let mut app = two_accounts();
        let phrase = "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima";
        let addr = fc::address(&fc::custody_key(phrase).unwrap());
        app.join.phrase = phrase.into();
        app.sign_in();
        let (id, what, _) = sent().pop().expect("the account looked up");
        assert!(what.contains("custody-address"), "{what}");
        app.done(id, 200, format!(r#"{{"user":{{"fid":77,"custody_address":"{addr}"}}}}"#).into_bytes());
        assert_eq!(app.me(), Some(77));
        assert_eq!(app.accounts.len(), 2);
        assert_eq!(app.toast.as_deref(), Some("That account is already signed in here."));
        assert!(!sent().iter().any(|(_, w, _)| w.contains("submitMessage")), "no KEY_ADD");
        assert_eq!(app.join.step, JoinStep::Idle);
    }

    #[test]
    fn profiles_are_read_by_type_name_or_number() {
        let v = serde_json::json!({"messages": [
            {"data": {"userDataBody": {"type": "USER_DATA_TYPE_DISPLAY", "value": "Quil"}}},
            {"data": {"userDataBody": {"type": 3, "value": "a bio"}}},
            {"data": {"userDataBody": {"type": "USER_DATA_TYPE_USERNAME", "value": "quil"}}},
            {"data": {"userDataBody": {"type": "USER_DATA_TYPE_URL", "value": "https://q.example"}}},
        ]});
        assert_eq!(read_prof(&v), Prof { pfp: String::new(), display: "Quil".into(), bio: "a bio".into(), url: "https://q.example".into() });
        let was = read_prof(&v);
        let mut now = was.clone();
        now.bio = "new".into();
        assert_eq!(was.changes(&now), vec![(BIO, "new".to_string())]);
    }

    #[test]
    fn a_profile_is_saved_field_by_field_with_a_new_photo() {
        let mut app = two_accounts();
        app.route = Route::Settings;
        app.load_route();
        let (id, what, _) = sent().pop().expect("the profile read");
        assert!(what.contains("/v1/userDataByFid?fid=88"), "{what}");
        app.done(id, 200, br#"{"messages":[{"data":{"userDataBody":{"type":"USER_DATA_TYPE_DISPLAY","value":"Old"}}}]}"#.to_vec());
        assert_eq!(app.edit.as_ref().unwrap().now.display, "Old");

        // a new photo, drawn again and uploaded like a cast's
        app.pick_photo(r#"[{"id":5,"type":"image/png","size":900,"name":"me.png"}]"#);
        let shrink = app.next_id;
        app.done(shrink, 1, br#"{"id":6,"type":"image/jpeg","size":800}"#.to_vec());
        let (id, what, _) = sent().pop().expect("the upload starts");
        assert!(what.starts_with("POST /api/upload\n"), "{what}");
        assert!(what.contains("x-fid: 88"), "{what}");
        app.done(id, 200, br#"{"id":"0b6c2c7e-7b1a-4c39-9a51-1e7c8f1b2c3d","chunk":1048576}"#.to_vec());
        let read = app.next_id;
        app.done(read, 1, vec![0; 800]);
        let (id, _, _) = sent().pop().expect("the piece");
        app.done(id, 200, br#"{"received":800}"#.to_vec());
        let (id, _, _) = sent().pop().expect("done");
        app.done(id, 200, br#"{"state":"ready","url":"https://quilcast.com/m/0123456789abcdef01234567.jpg"}"#.to_vec());
        app.edit_field(DISPLAY, "New");
        assert_eq!(app.edit.as_ref().unwrap().changes(), vec![(PFP, "https://quilcast.com/m/0123456789abcdef01234567.jpg".to_string()), (DISPLAY, "New".to_string())]);

        // one USER_DATA_ADD a field, signed by this browser's key; the second failing leaves only it to save
        app.save_profile();
        let (id, _, msg) = sent().pop().expect("the photo");
        let photo = fc::user_data_body(PFP, "https://quilcast.com/m/0123456789abcdef01234567.jpg");
        assert!(msg.windows(photo.len()).any(|w| w == photo.as_slice()));
        assert!(signed_by(&msg, [2; 32]));
        app.done(id, 200, b"{}".to_vec());
        assert!(host::DROPPED.with(|d| d.borrow().contains(&6)), "the uploaded file is let go");
        let (id, _, msg) = sent().pop().expect("the name");
        let name = fc::user_data_body(DISPLAY, "New");
        assert!(msg.windows(name.len()).any(|w| w == name.as_slice()));
        app.done(id, 400, br#"{"errCode":"bad_request","message":"no"}"#.to_vec());
        let e = app.edit.as_ref().unwrap();
        assert!(!e.saving);
        assert_eq!(e.changes(), vec![(DISPLAY, "New".to_string())]);

        app.save_profile();
        let (id, _, _) = sent().pop().expect("the name again");
        app.done(id, 200, b"{}".to_vec());
        assert!(app.edit.as_ref().unwrap().changes().is_empty());
        assert_eq!(app.toast.as_deref(), Some("Profile saved"));
        let a = app.account.as_ref().unwrap();
        assert_eq!((a.display.as_deref(), a.pfp.as_deref()), (Some("New"), Some("https://quilcast.com/m/0123456789abcdef01234567.jpg")));
        assert_eq!(App::new().accounts.iter().find(|a| a.fid == 88).unwrap().display.as_deref(), Some("New"));
    }

    #[test]
    fn a_new_photo_is_a_picture() {
        let mut app = two_accounts();
        app.edit = Some(Edit { fid: 88, orig: Some(Prof::default()), ..Default::default() });
        app.pick_photo(r#"[{"id":7,"type":"video/mp4","size":900}]"#);
        assert!(app.edit.as_ref().unwrap().photo.is_none());
        assert!(host::DROPPED.with(|d| d.borrow().contains(&7)));
        assert_eq!(app.toast.as_deref(), Some("Use a JPEG, PNG, GIF or WebP picture."));
    }
}
