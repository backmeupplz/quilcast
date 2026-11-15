//! The browser, as the wasm module sees it: a small fixed set of functions the JS shell (web/shell.js) provides.
//! Everything async (fetch, the key vault, timers) answers later through `q_done` in lib.rs with the id it was given.
//! Off wasm (cargo test) the functions are inert stand-ins, so the logic around them can be tested natively.

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "q")]
extern "C" {
    fn ops(ptr: *const u8, len: usize);
    fn fetch(id: u32, method: *const u8, ml: usize, url: *const u8, ul: usize, body: *const u8, bl: usize, ctype: *const u8, cl: usize);
    fn store_get(k: *const u8, kl: usize) -> u64;
    fn store_set(k: *const u8, kl: usize, v: *const u8, vl: usize);
    fn store_del(k: *const u8, kl: usize);
    fn vault_get(id: u32, k: *const u8, kl: usize);
    fn vault_set(id: u32, k: *const u8, kl: usize, v: *const u8, vl: usize);
    fn vault_del(k: *const u8, kl: usize);
    fn ed_new(id: u32);
    fn ed_sign(id: u32, pubk: *const u8, pl: usize, msg: *const u8, ml: usize);
    fn ed_drop(pubk: *const u8, pl: usize);
    fn random(ptr: *mut u8, len: usize);
    fn now() -> f64;
    fn nav(url: *const u8, ul: usize, replace: u32);
    fn back();
    fn location() -> u64;
    fn timer(id: u32, ms: f64);
    fn log(ptr: *const u8, len: usize);
    fn title(ptr: *const u8, len: usize);
    fn scroll(y: f64);
    fn scroll_top() -> f64;
    fn confirm(ptr: *const u8, len: usize) -> u32;
    fn copy(ptr: *const u8, len: usize);
    fn origin() -> u64;
}

/// A string or bytes the shell wrote into memory it allocated with `q_alloc` (lib.rs), as `ptr << 32 | len`;
/// u64::MAX means none.
#[cfg(target_arch = "wasm32")]
fn take(packed: u64) -> Option<Vec<u8>> {
    if packed == u64::MAX {
        return None;
    }
    let (ptr, len) = ((packed >> 32) as usize, (packed & 0xffff_ffff) as usize);
    Some(unsafe { crate::adopt(ptr as *mut u8, len) })
}
#[cfg(target_arch = "wasm32")]
fn take_str(packed: u64) -> Option<String> {
    take(packed).map(|b| String::from_utf8_lossy(&b).into_owned())
}

#[cfg(target_arch = "wasm32")]
mod imp {
    use super::*;
    pub fn apply(buf: &[u8]) { unsafe { ops(buf.as_ptr(), buf.len()) } }
    pub fn http(id: u32, method: &str, url: &str, body: &[u8], ctype: &str) {
        unsafe { fetch(id, method.as_ptr(), method.len(), url.as_ptr(), url.len(), body.as_ptr(), body.len(), ctype.as_ptr(), ctype.len()) }
    }
    pub fn get(k: &str) -> Option<String> { take_str(unsafe { store_get(k.as_ptr(), k.len()) }) }
    pub fn set(k: &str, v: &str) { unsafe { store_set(k.as_ptr(), k.len(), v.as_ptr(), v.len()) } }
    pub fn del(k: &str) { unsafe { store_del(k.as_ptr(), k.len()) } }
    pub fn vget(id: u32, k: &str) { unsafe { vault_get(id, k.as_ptr(), k.len()) } }
    pub fn vset(id: u32, k: &str, v: &[u8]) { unsafe { vault_set(id, k.as_ptr(), k.len(), v.as_ptr(), v.len()) } }
    pub fn vdel(k: &str) { unsafe { vault_del(k.as_ptr(), k.len()) } }
    pub fn ednew(id: u32) { unsafe { ed_new(id) } }
    pub fn edsign(id: u32, pubk: &[u8], msg: &[u8]) { unsafe { ed_sign(id, pubk.as_ptr(), pubk.len(), msg.as_ptr(), msg.len()) } }
    pub fn eddrop(pubk: &[u8]) { unsafe { ed_drop(pubk.as_ptr(), pubk.len()) } }
    pub fn fill(buf: &mut [u8]) { unsafe { random(buf.as_mut_ptr(), buf.len()) } }
    pub fn ms() -> f64 { unsafe { now() } }
    pub fn go(url: &str, replace: bool) { unsafe { nav(url.as_ptr(), url.len(), replace as u32) } }
    pub fn history_back() { unsafe { back() } }
    pub fn here() -> String { take_str(unsafe { location() }).unwrap_or_else(|| "/".into()) }
    pub fn after(id: u32, ms: f64) { unsafe { timer(id, ms) } }
    pub fn print(s: &str) { unsafe { log(s.as_ptr(), s.len()) } }
    pub fn set_title(s: &str) { unsafe { title(s.as_ptr(), s.len()) } }
    pub fn scroll_to(y: f64) { unsafe { scroll(y) } }
    pub fn scroll_y() -> f64 { unsafe { scroll_top() } }
    pub fn ask(s: &str) -> bool { unsafe { confirm(s.as_ptr(), s.len()) != 0 } }
    pub fn clip(s: &str) { unsafe { copy(s.as_ptr(), s.len()) } }
    pub fn site() -> String { take_str(unsafe { origin() }).unwrap_or_default() }
}

#[cfg(not(target_arch = "wasm32"))]
mod imp {
    use std::cell::RefCell;
    use std::collections::HashMap;
    thread_local! {
        static STORE: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
        /// what the tests can look at: every request made, as "METHOD url"
        pub static SENT: RefCell<Vec<(u32, String, Vec<u8>)>> = RefCell::new(Vec::new());
        static SEED: RefCell<u64> = RefCell::new(0x2545_f491_4f6c_dd1d);
    }
    pub fn apply(_: &[u8]) {}
    pub fn http(id: u32, method: &str, url: &str, body: &[u8], _: &str) { SENT.with(|s| s.borrow_mut().push((id, format!("{method} {url}"), body.to_vec()))) }
    pub fn get(k: &str) -> Option<String> { STORE.with(|s| s.borrow().get(k).cloned()) }
    pub fn set(k: &str, v: &str) { STORE.with(|s| s.borrow_mut().insert(k.into(), v.into())); }
    pub fn del(k: &str) { STORE.with(|s| s.borrow_mut().remove(k)); }
    pub fn vget(_: u32, _: &str) {}
    pub fn vset(_: u32, _: &str, _: &[u8]) {}
    pub fn vdel(_: &str) {}
    pub fn ednew(_: u32) {}
    pub fn edsign(_: u32, _: &[u8], _: &[u8]) {}
    pub fn eddrop(_: &[u8]) {}
    /// xorshift: tests only need bytes that differ
    pub fn fill(buf: &mut [u8]) {
        SEED.with(|s| {
            for b in buf {
                let mut x = *s.borrow();
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                *s.borrow_mut() = x;
                *b = x as u8;
            }
        })
    }
    pub fn ms() -> f64 { 1_763_200_000_000.0 }
    pub fn go(_: &str, _: bool) {}
    pub fn history_back() {}
    pub fn here() -> String { "/".into() }
    pub fn after(_: u32, _: f64) {}
    pub fn print(s: &str) { eprintln!("{s}") }
    pub fn set_title(_: &str) {}
    pub fn scroll_to(_: f64) {}
    pub fn scroll_y() -> f64 { 0.0 }
    pub fn ask(_: &str) -> bool { true }
    pub fn clip(_: &str) {}
    pub fn site() -> String { "https://wasm.quilcast.com".into() }
}

pub use imp::*;

/// getrandom (used by the crypto crates) draws from the browser's crypto.getRandomValues through the shell.
#[cfg(target_arch = "wasm32")]
fn getrandom_shell(buf: &mut [u8]) -> Result<(), getrandom::Error> {
    fill(buf);
    Ok(())
}
#[cfg(target_arch = "wasm32")]
getrandom::register_custom_getrandom!(getrandom_shell);
