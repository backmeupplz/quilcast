//! Quilcast as a WebAssembly module. The shell (web/shell.js) loads it, calls `q_start`, and from then on hands it
//! the page's events (`q_event`), finished requests, key operations and timers (`q_done`) and navigation (`q_nav`).
//! After each, the module draws the page again.

pub mod api;
pub mod app;
pub mod compose;
pub mod dom;
pub mod emoji;
pub mod fc;
pub mod host;
pub mod mutes;
pub mod spam;
pub mod text;
pub mod view;

use app::App;
use std::cell::RefCell;

thread_local! {
    static APP: RefCell<Option<App>> = const { RefCell::new(None) };
}

/// Memory the shell fills (a response, a stored value) before handing it over.
#[no_mangle]
pub extern "C" fn q_alloc(len: usize) -> *mut u8 {
    let layout = std::alloc::Layout::from_size_align(len.max(1), 1).expect("size");
    unsafe { std::alloc::alloc(layout) }
}

/// Takes back memory from `q_alloc` that the shell filled with `len` bytes.
///
/// # Safety
/// `ptr` must come from `q_alloc(len)` and not have been adopted before.
pub unsafe fn adopt(ptr: *mut u8, len: usize) -> Vec<u8> {
    Vec::from_raw_parts(ptr, len, len.max(1))
}

fn with(f: impl FnOnce(&mut App)) {
    APP.with(|a| {
        if let Some(app) = a.borrow_mut().as_mut() {
            f(app);
            app.render();
        }
    })
}

#[no_mangle]
pub extern "C" fn q_start() {
    std::panic::set_hook(Box::new(|p| host::print(&format!("quilcast: {p}"))));
    APP.with(|a| *a.borrow_mut() = Some(App::new()));
    with(|app| app.start());
}

#[no_mangle]
pub extern "C" fn q_event(node: u32, kind: u32, ptr: *mut u8, len: usize) {
    let value = String::from_utf8(unsafe { adopt(ptr, len) }).unwrap_or_default();
    let ev = match kind {
        1 => dom::Ev::Click,
        2 => dom::Ev::Input,
        3 => dom::Ev::Submit,
        4 => dom::Ev::Key,
        5 => dom::Ev::Change,
        6 => dom::Ev::Visible,
        _ => return,
    };
    with(|app| {
        if let Some(h) = app.dom.handlers.get(&(node, ev)).cloned() {
            h(app, &value);
        }
    });
}

#[no_mangle]
pub extern "C" fn q_done(id: u32, code: i32, ptr: *mut u8, len: usize) {
    let bytes = unsafe { adopt(ptr, len) };
    with(|app| app.done(id, code, bytes));
}

/// A same-origin link was followed (`pop` 0) or the person went back or forward (1).
#[no_mangle]
pub extern "C" fn q_nav(ptr: *mut u8, len: usize, pop: u32) {
    let path = String::from_utf8(unsafe { adopt(ptr, len) }).unwrap_or_else(|_| "/".into());
    with(|app| app.navigate(&path, pop != 0));
}
