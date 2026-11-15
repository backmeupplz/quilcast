//! The page is drawn here: views build a tree of `V` nodes, and `Dom::render` compares it with the tree on the page
//! and writes the difference as a list of operations the shell applies (web/shell.js `apply`). The shell never
//! parses markup: elements, attributes and text are set one by one, so nothing a cast says can become HTML.

use crate::app::App;
use std::collections::HashMap;
use std::rc::Rc;

pub type Handler = Rc<dyn Fn(&mut App, &str)>;

/// Events a node can listen to. `Visible` fires once the node scrolls into view (infinite scroll).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Ev {
    Click = 1,
    Input = 2,
    Submit = 3,
    Key = 4,
    Change = 5,
    Visible = 6,
}

pub enum V {
    E(Box<El>),
    T(String),
}

pub struct El {
    pub tag: &'static str,
    pub key: Option<String>,
    pub attrs: Vec<(&'static str, String)>,
    pub on: Vec<(Ev, Handler)>,
    pub kids: Vec<V>,
}

pub fn el(tag: &'static str) -> El {
    El { tag, key: None, attrs: Vec::new(), on: Vec::new(), kids: Vec::new() }
}
pub fn text(s: impl Into<String>) -> V {
    V::T(s.into())
}

impl El {
    pub fn key(mut self, k: impl Into<String>) -> Self {
        self.key = Some(k.into());
        self
    }
    pub fn attr(mut self, name: &'static str, v: impl Into<String>) -> Self {
        self.attrs.push((name, v.into()));
        self
    }
    pub fn attr_if(self, on: bool, name: &'static str, v: impl Into<String>) -> Self {
        if on { self.attr(name, v) } else { self }
    }
    pub fn class(self, c: impl Into<String>) -> Self {
        self.attr("class", c)
    }
    pub fn on(mut self, ev: Ev, f: impl Fn(&mut App, &str) + 'static) -> Self {
        self.on.push((ev, Rc::new(f)));
        self
    }
    pub fn click(self, f: impl Fn(&mut App) + 'static) -> Self {
        self.on(Ev::Click, move |a, _| f(a))
    }
    pub fn kid(mut self, v: impl Into<V>) -> Self {
        self.kids.push(v.into());
        self
    }
    pub fn kids(mut self, vs: impl IntoIterator<Item = V>) -> Self {
        self.kids.extend(vs);
        self
    }
    pub fn txt(self, s: impl Into<String>) -> Self {
        self.kid(text(s))
    }
    pub fn maybe(self, v: Option<V>) -> Self {
        match v {
            Some(v) => self.kid(v),
            None => self,
        }
    }
}

impl From<El> for V {
    fn from(e: El) -> V {
        V::E(Box::new(e))
    }
}

/// What's on the page: each node with the id the shell knows it by.
pub enum Mounted {
    E { id: u32, tag: &'static str, key: Option<String>, attrs: Vec<(&'static str, String)>, evs: Vec<Ev>, kids: Vec<Mounted> },
    T { id: u32, text: String },
}

impl Mounted {
    fn id(&self) -> u32 {
        match self {
            Mounted::E { id, .. } | Mounted::T { id, .. } => *id,
        }
    }
}

// operation codes, read by web/shell.js
const CREATE: u8 = 1;
const TEXT: u8 = 2;
const SET: u8 = 3;
const UNSET: u8 = 4;
const SET_TEXT: u8 = 5;
const KIDS: u8 = 6;
const FREE: u8 = 7;
const LISTEN: u8 = 8;
const PROP: u8 = 9;

/// Attributes that are the element's live state rather than its markup: set as properties, and only when the page's
/// value differs (so typing, the caret and an IME composition are never disturbed).
fn is_prop(name: &str) -> bool {
    matches!(name, "value" | "checked")
}

#[derive(Default)]
pub struct Dom {
    root: Option<Mounted>,
    next: u32,
    pub ops: Vec<u8>,
    pub handlers: HashMap<(u32, Ev), Handler>,
}

impl Dom {
    fn op(&mut self, code: u8, id: u32) {
        self.ops.push(code);
        self.ops.extend_from_slice(&id.to_le_bytes());
    }
    fn s(&mut self, s: &str) {
        self.ops.extend_from_slice(&(s.len() as u32).to_le_bytes());
        self.ops.extend_from_slice(s.as_bytes());
    }
    fn new_id(&mut self) -> u32 {
        self.next += 1;
        self.next
    }

    /// Bring the page to `v` (under the shell's root, id 0). Returns the operations to apply; the handlers for the
    /// new tree replace the old ones.
    pub fn render(&mut self, v: V) -> Vec<u8> {
        self.handlers.clear();
        let old = self.root.take();
        let m = match old {
            Some(o) => self.patch(o, v),
            None => self.create(v),
        };
        let id = m.id();
        self.op(KIDS, 0);
        self.ops.extend_from_slice(&1u32.to_le_bytes());
        self.ops.extend_from_slice(&id.to_le_bytes());
        self.root = Some(m);
        std::mem::take(&mut self.ops)
    }

    fn create(&mut self, v: V) -> Mounted {
        match v {
            V::T(t) => {
                let id = self.new_id();
                self.op(TEXT, id);
                self.s(&t);
                Mounted::T { id, text: t }
            }
            V::E(e) => {
                let e = *e;
                let id = self.new_id();
                self.op(CREATE, id);
                self.s(e.tag);
                for (n, v) in &e.attrs {
                    self.op(if is_prop(n) { PROP } else { SET }, id);
                    self.s(n);
                    self.s(v);
                }
                let mut evs = Vec::new();
                for (ev, h) in e.on {
                    if !evs.contains(&ev) {
                        self.op(LISTEN, id);
                        self.ops.push(ev as u8);
                        evs.push(ev);
                    }
                    self.handlers.insert((id, ev), h);
                }
                let kids: Vec<Mounted> = e.kids.into_iter().map(|k| self.create(k)).collect();
                if !kids.is_empty() {
                    self.kids_op(id, &kids);
                }
                Mounted::E { id, tag: e.tag, key: e.key, attrs: e.attrs, evs, kids }
            }
        }
    }

    fn kids_op(&mut self, id: u32, kids: &[Mounted]) {
        self.op(KIDS, id);
        self.ops.extend_from_slice(&(kids.len() as u32).to_le_bytes());
        for k in kids {
            self.ops.extend_from_slice(&k.id().to_le_bytes());
        }
    }

    fn free(&mut self, m: Mounted) {
        match m {
            Mounted::T { id, .. } => self.op(FREE, id),
            Mounted::E { id, kids, .. } => {
                for k in kids {
                    self.free(k);
                }
                self.op(FREE, id);
            }
        }
    }

    fn patch(&mut self, old: Mounted, v: V) -> Mounted {
        match (old, v) {
            (Mounted::T { id, text: was }, V::T(t)) => {
                if was != t {
                    self.op(SET_TEXT, id);
                    self.s(&t);
                }
                Mounted::T { id, text: t }
            }
            (Mounted::E { id, tag, key, attrs: was, evs: mut had, kids }, V::E(e)) if tag == e.tag && key == e.key => {
                let e = *e;
                for (n, v) in &e.attrs {
                    let before = was.iter().find(|(m, _)| m == n).map(|(_, v)| v);
                    // a property is set again even when unchanged here, as the person may have changed it on the page;
                    // the shell skips it when the page already has that value
                    if before != Some(v) || is_prop(n) {
                        self.op(if is_prop(n) { PROP } else { SET }, id);
                        self.s(n);
                        self.s(v);
                    }
                }
                for (n, _) in &was {
                    if !e.attrs.iter().any(|(m, _)| m == n) {
                        if is_prop(n) {
                            self.op(PROP, id);
                            self.s(n);
                            self.s("");
                        } else {
                            self.op(UNSET, id);
                            self.s(n);
                        }
                    }
                }
                for (ev, h) in e.on {
                    if !had.contains(&ev) {
                        self.op(LISTEN, id);
                        self.ops.push(ev as u8);
                        had.push(ev);
                    }
                    self.handlers.insert((id, ev), h);
                }
                let kids = self.patch_kids(id, kids, e.kids);
                Mounted::E { id, tag, key, attrs: e.attrs, evs: had, kids }
            }
            (old, v) => {
                let m = self.create(v);
                self.free(old);
                m
            }
        }
    }

    /// Children are matched by key where they have one, else in order with the next unmatched child of the same tag.
    fn patch_kids(&mut self, id: u32, old: Vec<Mounted>, new: Vec<V>) -> Vec<Mounted> {
        let before: Vec<u32> = old.iter().map(|m| m.id()).collect();
        let mut keyed: HashMap<String, Mounted> = HashMap::new();
        let mut plain: Vec<Option<Mounted>> = Vec::new();
        for m in old {
            match &m {
                Mounted::E { key: Some(k), .. } if !keyed.contains_key(k) => {
                    keyed.insert(k.clone(), m);
                }
                _ => plain.push(Some(m)),
            }
        }
        let mut cursor = 0;
        let mut out = Vec::with_capacity(new.len());
        for v in new {
            let found = match &v {
                V::E(e) if e.key.is_some() => keyed.remove(e.key.as_ref().unwrap()),
                _ => {
                    let want = match &v {
                        V::E(e) => Some(e.tag),
                        V::T(_) => None,
                    };
                    let mut hit = None;
                    // look a little ahead, so one child added or removed doesn't rebuild everything after it
                    for i in cursor..plain.len().min(cursor + 4) {
                        let fits = match (&plain[i], want) {
                            (Some(Mounted::E { tag, .. }), Some(w)) => *tag == w,
                            (Some(Mounted::T { .. }), None) => true,
                            _ => false,
                        };
                        if fits {
                            hit = plain[i].take();
                            cursor = i + 1;
                            break;
                        }
                    }
                    hit
                }
            };
            out.push(match found {
                Some(m) => self.patch(m, v),
                None => self.create(v),
            });
        }
        for m in keyed.into_values() {
            self.free(m);
        }
        for m in plain.into_iter().flatten() {
            self.free(m);
        }
        if out.iter().map(|m| m.id()).ne(before.iter().copied()) {
            self.kids_op(id, &out);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn count(ops: &[u8], code: u8) -> usize {
        // walk the buffer the way the shell does
        let mut i = 0;
        let mut n = 0;
        let rd = |i: &mut usize| {
            let v = u32::from_le_bytes(ops[*i..*i + 4].try_into().unwrap());
            *i += 4;
            v
        };
        while i < ops.len() {
            let c = ops[i];
            i += 1;
            let _id = rd(&mut i);
            if c == code {
                n += 1;
            }
            match c {
                CREATE | TEXT | UNSET | SET_TEXT => {
                    let l = rd(&mut i) as usize;
                    i += l;
                }
                SET | PROP => {
                    for _ in 0..2 {
                        let l = rd(&mut i) as usize;
                        i += l;
                    }
                }
                KIDS => {
                    let l = rd(&mut i) as usize;
                    i += l * 4;
                }
                LISTEN => i += 1,
                FREE => {}
                _ => panic!("bad op {c}"),
            }
        }
        n
    }

    fn list(items: &[&str]) -> V {
        el("ul").kids(items.iter().map(|s| el("li").key(*s).txt(*s).into())).into()
    }

    #[test]
    fn same_tree_writes_nothing_but_the_root() {
        let mut d = Dom::default();
        d.render(list(&["a", "b"]));
        let ops = d.render(list(&["a", "b"]));
        assert_eq!(count(&ops, CREATE), 0);
        assert_eq!(count(&ops, KIDS), 1, "only the root's");
    }

    #[test]
    fn keyed_children_move_instead_of_being_rebuilt() {
        let mut d = Dom::default();
        d.render(list(&["a", "b", "c"]));
        let ops = d.render(list(&["c", "a", "b", "d"]));
        assert_eq!(count(&ops, CREATE), 1, "only d is new");
        assert_eq!(count(&ops, FREE), 0);
        let ops = d.render(list(&["d"]));
        assert_eq!(count(&ops, FREE), 6, "three items and their texts");
    }

    #[test]
    fn text_and_attributes_change_in_place() {
        let mut d = Dom::default();
        d.render(el("p").class("x").attr("title", "t").txt("one").into());
        let ops = d.render(el("p").class("y").txt("two").into());
        assert_eq!(count(&ops, SET), 1);
        assert_eq!(count(&ops, UNSET), 1);
        assert_eq!(count(&ops, SET_TEXT), 1);
        assert_eq!(count(&ops, CREATE), 0);
    }

    #[test]
    fn handlers_follow_the_latest_tree() {
        let mut d = Dom::default();
        d.render(el("button").click(|_| {}).into());
        assert_eq!(d.handlers.len(), 1);
        let ops = d.render(el("button").click(|_| {}).into());
        assert_eq!(count(&ops, LISTEN), 0, "the shell's listener stays");
        assert_eq!(d.handlers.len(), 1);
    }
}
