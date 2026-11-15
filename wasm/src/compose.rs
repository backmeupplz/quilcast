//! What the composer does beyond text (src/compose.tsx, src/write.ts): pictures, videos and GIFs uploaded through
//! Quilcast's server, @mention suggestions, threads, drafts sealed in this browser, scheduled casts, and the
//! profile's pinned cast.

use crate::api::*;
use crate::app::*;
use crate::{fc, host, text};
use serde::{Deserialize, Serialize};
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

/// A cast carries at most 4 embeds: uploads and a quoted cast first, then links from its text (src/shared.ts).
pub const MAX_EMBEDS: usize = 4;
/// What server/upload.mjs takes.
pub const TYPES: [&str; 7] = ["image/jpeg", "image/png", "image/gif", "image/webp", "video/mp4", "video/webm", "video/quicktime"];
const IMAGE_MAX: u64 = 10_000_000;
const VIDEO_MAX: u64 = 100_000_000;
/// Each PUT stays well inside the proxy's 60 s; the server takes 8 MB at most.
const CHUNK: u64 = 1024 * 1024;
/// The most posts one scheduled thread holds (server/scheduled.mjs MAX_PARTS).
pub const MAX_PARTS: usize = 25;
/// server/scheduled.mjs SOONEST and LATEST.
pub const SOONEST: f64 = 60e3;
pub const LATEST: f64 = 30.0 * 86400e3;

/// A file picked in the browser (web/shell.js keepFile).
#[derive(Deserialize, Clone, Debug)]
pub struct Picked {
    pub id: u32,
    #[serde(rename = "type")]
    pub kind: String,
    pub size: u64,
    #[serde(default)]
    pub name: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    Preparing,
    Uploading(u64, u64),
    Processing,
    Ready,
    Failed(String),
}

/// A picture, video or GIF on the cast being written.
#[derive(Clone, Debug)]
pub struct Attach {
    /// this visit's number for it
    pub n: u32,
    /// the embed, once uploaded
    pub url: Option<String>,
    pub preview: Option<String>,
    pub video: bool,
    pub name: String,
    pub step: Step,
    /// the shell's file, until it's uploaded
    pub file: Option<u32>,
    /// the server's upload id, while it's on its way
    pub upload: Option<String>,
}
impl Attach {
    pub fn ready(url: String) -> Attach {
        let video = is_video(&url);
        Attach { n: 0, preview: (!video).then(|| url.clone()), url: Some(url), video, name: String::new(), step: Step::Ready, file: None, upload: None }
    }
}
pub fn is_video(u: &str) -> bool {
    let path = u.split(['?', '#']).next().unwrap_or("").to_lowercase();
    [".mp4", ".webm", ".mov", ".m3u8"].iter().any(|e| path.ends_with(e))
}

/// A Tenor GIF (server/shrek.mjs gifs): `cast` is the one a cast embeds.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Gif {
    pub url: String,
    pub preview: String,
    pub title: String,
    pub cast: Option<String>,
}

/// One post of the cast or thread being written.
#[derive(Clone, Debug, Default)]
pub struct Post {
    /// its number in this composer, so its editor keeps its place on the page as posts come and go
    pub id: u32,
    pub text: String,
    pub media: Vec<Attach>,
    /// where the caret was last, as a byte offset into `text` (an emoji goes there)
    pub caret: usize,
}
impl Post {
    pub fn empty(&self) -> bool {
        self.text.trim().is_empty() && self.media.is_empty()
    }
    fn part(&self) -> Part {
        Part { text: self.text.trim().to_string(), media: self.media.iter().filter_map(|a| a.url.clone()).collect() }
    }
}

impl Compose {
    pub fn new(gen: u32) -> Compose {
        Compose { gen, posts: vec![Post::default()], ..Default::default() }
    }
    pub fn empty(&self) -> bool {
        self.posts.iter().all(Post::empty)
    }
    /// The post being written in: `at`, or the first when that's gone.
    pub fn cur(&self) -> usize {
        if self.at < self.posts.len() {
            self.at
        } else {
            0
        }
    }
    fn new_post(&mut self) -> Post {
        Post { id: self.posts.iter().map(|p| p.id + 1).max().unwrap_or(0), ..Default::default() }
    }
    /// Room for more pictures and videos on post `i`: the first one's quoted cast takes one.
    pub fn room(&self, i: usize) -> usize {
        let fixed = if i == 0 { self.quote.is_some() as usize + self.quote_wait.is_some() as usize } else { 0 };
        MAX_EMBEDS.saturating_sub(self.posts.get(i).map_or(0, |p| p.media.len()) + fixed)
    }
    /// Whether another post can be added after the one being written: only after one with something in it.
    pub fn can_add(&self) -> bool {
        let i = self.cur();
        !self.sending && self.posts.get(i).is_some_and(|p| !p.empty() || (i == 0 && self.quote.is_some()))
    }
}

/// The caret, a byte offset into `text`, in the UTF-16 units the browser counts in.
pub fn utf16_at(text: &str, byte: usize) -> usize {
    let mut b = byte.min(text.len());
    while !text.is_char_boundary(b) {
        b -= 1;
    }
    text[..b].encode_utf16().count()
}
/// The byte offset of the caret the browser gives in UTF-16 units.
pub fn byte_at(text: &str, caret16: usize) -> usize {
    let mut n16 = 0;
    for (i, c) in text.char_indices() {
        if n16 >= caret16 {
            return i;
        }
        n16 += c.len_utf16();
    }
    text.len()
}

/// One post of a cast or thread, as drafts keep it.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Part {
    pub text: String,
    pub media: Vec<String>,
}

/// A draft (src/write.ts Draft), sealed with the drafts key before it leaves the browser.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(default)]
pub struct Draft {
    #[serde(skip_serializing_if = "String::is_empty")]
    pub id: String,
    pub at: u64,
    pub parts: Vec<Part>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pfid: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
    #[serde(rename = "as", skip_serializing_if = "Option::is_none")]
    pub as_fid: Option<u64>,
}

/// The scheduled cast the composer was opened from. One still waiting is edited in place (the same id replaces it);
/// a failed one can't be (the server refuses to replace anything that isn't waiting), so it's scheduled again as a
/// new one and taken off the list once that one is in (src/compose.tsx later).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Sched {
    pub id: String,
    pub waiting: bool,
}

impl Sched {
    /// The id to schedule under, and the one to take off the list after that's in.
    pub fn target(s: Option<&Sched>, fresh: impl FnOnce() -> String) -> (String, Option<Sched>) {
        match s {
            Some(s) if s.waiting => (s.id.clone(), None),
            Some(s) => (fresh(), Some(s.clone())),
            None => (fresh(), None),
        }
    }
}

/// A scheduled cast or thread as the server lists it (server/scheduled.mjs shown).
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Scheduled {
    pub id: String,
    pub at: u64,
    pub hash: String,
    pub hashes: Vec<String>,
    pub status: String,
    pub posted: u64,
    pub error: Option<String>,
    pub draft: Option<Draft>,
}

#[derive(Deserialize)]
struct Sealed {
    id: String,
    #[serde(rename = "box")]
    sealed: String,
}

pub enum Panel {
    Drafts,
    Scheduled,
    /// the GIF search, with what's typed
    Gifs(String),
    /// the emoji picker: what's typed, and the group shown when nothing is
    Emoji(String, usize),
    /// the sticker picker, on the account's pack at this place in the list
    Stickers(usize),
}

/// A sticker pack (server/stickers.mjs), as `/api/stickers/<fid>` lists the account's.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Pack {
    pub id: String,
    pub fid: u64,
    pub title: String,
    pub stickers: Vec<Sticker>,
}
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Sticker {
    pub h: String,
    pub e: String,
}
/// A sticker's address, the picture a cast embeds (src/shared.ts stickerUrl).
pub fn sticker_url(pack: &str, h: &str) -> String {
    format!("https://quilcast.com/st/{pack}/{h}.webp")
}
/// The pack a sticker's address names, or None for any other picture (src/shared.ts stickerPack).
pub fn sticker_pack(u: &str) -> Option<&str> {
    let rest = u.strip_prefix("https://quilcast.com/st/")?;
    let (pack, file) = rest.split_once('/')?;
    let h = file.strip_suffix(".webp")?;
    let pack_ok = pack.len() == 8 && pack.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    let h_ok = h.len() == 24 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    (pack_ok && h_ok).then_some(pack)
}

/// The "@name" being typed where the caret is: its byte range in the text and the name so far.
#[derive(Clone, Debug, PartialEq)]
pub struct Typing {
    pub start: usize,
    pub end: usize,
    pub name: String,
}

/// The @mention the caret is in or right after (the caret in UTF-16 units, as the browser counts).
pub fn mention_at(text: &str, caret16: usize) -> Option<Typing> {
    let caret = byte_at(text, caret16);
    let before = &text[..caret];
    let start = before.rfind('@')?;
    let name = &before[start + 1..];
    if name.is_empty() || name.len() > 32 || !name.chars().all(fc::name_char) {
        return None;
    }
    if before[..start].chars().next_back().is_some_and(|c| !c.is_whitespace() && c != '(') {
        return None;
    }
    // the rest of the name, past the caret, goes too when one is picked
    let end = caret + text[caret..].find(|c: char| !fc::name_char(c)).unwrap_or(text.len() - caret);
    Some(Typing { start, end, name: name.to_lowercase() })
}

// --- base64 and ids ---

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
pub fn b64(b: &[u8]) -> String {
    let mut out = String::with_capacity(b.len().div_ceil(3) * 4);
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            out.push(if i <= c.len() { B64[(n >> (18 - 6 * i)) as usize & 63] as char } else { '=' });
        }
    }
    out
}
pub fn unb64(s: &str) -> Option<Vec<u8>> {
    let s = s.trim_end_matches('=');
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let (mut acc, mut bits) = (0u32, 0);
    for c in s.bytes() {
        let v = B64.iter().position(|x| *x == c)? as u32;
        acc = acc << 6 | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Some(out)
}
/// A random v4 UUID, as crypto.randomUUID makes.
pub fn uuid() -> String {
    let mut b = [0u8; 16];
    host::fill(&mut b);
    b[6] = b[6] & 0x0f | 0x40;
    b[8] = b[8] & 0x3f | 0x80;
    let h = fc::hex(&b);
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

/// A sealed draft as server/drafts.mjs keeps it: base64 IV "." base64 ciphertext; `sealed` is the IV then the ciphertext.
pub fn draft_box(sealed: &[u8]) -> String {
    format!("{}.{}", b64(&sealed[..12]), b64(&sealed[12..]))
}
pub fn unbox(s: &str) -> Option<Vec<u8>> {
    let (iv, ct) = s.split_once('.')?;
    let mut out = unb64(iv)?;
    if out.len() != 12 {
        return None;
    }
    out.extend(unb64(ct)?);
    Some(out)
}

// --- videos keep no metadata: their udta and meta boxes become zeroed free boxes (src/write.ts stripVideoMeta) ---

/// Bytes to write over the file as it's uploaded: (where, what); sizes never change.
pub type Patches = Vec<(u64, Vec<u8>)>;

/// An MP4 box at `o`: its size, header length and type.
pub fn mp4_box(b: &[u8], o: usize, end: u64) -> Option<(u64, usize, [u8; 4])> {
    let h = b.get(o..o + 8)?;
    let mut size = u32::from_be_bytes(h[..4].try_into().ok()?) as u64;
    let mut hdr = 8;
    if size == 1 {
        size = u64::from_be_bytes(b.get(o + 8..o + 16)?.try_into().ok()?);
        hdr = 16;
    } else if size == 0 {
        size = end;
    }
    Some((size, hdr, h[4..8].try_into().ok()?))
}
/// Inside moov and its tracks, udta (place, device) and meta (iPhone keys) become zeroed free boxes.
pub fn scrub_boxes(b: &mut [u8], start: usize, end: usize) {
    let mut o = start;
    while o + 8 <= end {
        let Some((size, hdr, kind)) = mp4_box(b, o, (end - o) as u64) else { return };
        let size = size as usize;
        if size < hdr || o + size > end {
            return;
        }
        match &kind {
            b"udta" | b"meta" => {
                b[o + 4..o + 8].copy_from_slice(b"free");
                b[o + hdr..o + size].fill(0);
            }
            b"trak" | b"mdia" | b"minf" => scrub_boxes(b, o + hdr, o + size),
            _ => {}
        }
        o += size;
    }
}
/// The patches laid over `buf`, which holds the file from `off`.
pub fn patch(buf: &mut [u8], off: u64, patches: &Patches) {
    let end = off + buf.len() as u64;
    for (at, data) in patches {
        let (s, e) = (*at, *at + data.len() as u64);
        if e <= off || s >= end {
            continue;
        }
        let (from, to) = (s.max(off), e.min(end));
        buf[(from - off) as usize..(to - off) as usize].copy_from_slice(&data[(from - s) as usize..(to - s) as usize]);
    }
}

/// The embeds of one post: its uploads, then a quoted cast, then links from its text, 2 at most.
pub fn embeds_for(text: &str, media: &[String], quote: Option<&fc::CastRef>) -> Vec<fc::Embed> {
    let mut out: Vec<fc::Embed> = media.iter().map(|u| fc::Embed::Url(u.clone())).collect();
    out.extend(quote.cloned().map(fc::Embed::Cast));
    for u in text::text_links(text) {
        if out.len() < MAX_EMBEDS && !media.contains(&u) {
            out.push(fc::Embed::Url(u));
        }
    }
    out.truncate(MAX_EMBEDS);
    out
}

fn status_error(status: i32, body: &[u8], what: &str) -> String {
    if status == 0 {
        format!("{what} Check your connection and try again.")
    } else {
        error_text(status, body)
    }
}

impl App {
    fn attach_mut(&mut self, n: u32) -> Option<&mut Attach> {
        self.compose.as_mut()?.posts.iter_mut().flat_map(|p| p.media.iter_mut()).find(|a| a.n == n)
    }
    fn attach_failed(&mut self, n: u32, e: String) {
        let upload = self.attach_mut(n).and_then(|a| {
            a.step = Step::Failed(e);
            a.upload.take()
        });
        if let Some(id) = upload {
            self.http("DELETE", &format!("/api/upload/{id}"), &[], "", |_, _, _| {});
        }
    }

    /// Room for more pictures and videos on the post being written.
    pub fn room(&self) -> usize {
        self.compose.as_ref().map_or(0, |c| c.room(c.cur()))
    }

    /// Files picked for the post being written (the shell's list): each is cleaned and uploaded.
    pub fn attach(&mut self, picked: &str) {
        let files: Vec<Picked> = serde_json::from_str(picked).unwrap_or_default();
        let Some(at) = self.compose.as_ref().map(|c| c.cur()) else {
            return files.iter().for_each(|f| host::fdrop(f.id));
        };
        for f in files {
            if self.room() == 0 {
                host::fdrop(f.id);
                self.say(format!("A cast holds {MAX_EMBEDS} pictures or videos at most."));
                continue;
            }
            if !TYPES.contains(&f.kind.as_str()) {
                host::fdrop(f.id);
                self.say("Use a JPEG, PNG, GIF, WebP, MP4, WebM or MOV file.");
                continue;
            }
            self.attach_seq += 1;
            let n = self.attach_seq;
            let video = f.kind.starts_with("video/");
            let preview = if video { None } else { host::furl(f.id) };
            let a = Attach { n, url: None, preview, video, name: f.name.clone(), step: Step::Preparing, file: Some(f.id), upload: None };
            if let Some(p) = self.compose.as_mut().and_then(|c| c.posts.get_mut(at)) {
                p.media.push(a);
            }
            match f.kind.as_str() {
                "image/jpeg" | "image/png" | "image/webp" => {
                    let id = self.wait(move |app, code, body| {
                        let shrunk = (code == 1).then(|| serde_json::from_slice::<Picked>(&body).ok()).flatten();
                        // a picture that couldn't be read keeps its tile (and thumbnail) until it's taken off
                        let Some(s) = shrunk else {
                            if app.attach_mut(n).is_none() {
                                host::fdrop(f.id);
                            }
                            return app.attach_failed(n, "This picture couldn't be read.".into());
                        };
                        host::fdrop(f.id);
                        // the thumbnail moves to the picture as it will go out: the original's address is let go
                        match app.attach_mut(n) {
                            Some(a) => {
                                a.file = Some(s.id);
                                a.preview = host::furl(s.id);
                            }
                            None => return host::fdrop(s.id),
                        }
                        app.upload(n, s.id, s.kind, s.size, Rc::new(Vec::new()));
                    });
                    host::fshrink(id, f.id);
                }
                "video/mp4" | "video/quicktime" => self.video_walk(n, f.id, f.kind, f.size, 0, Vec::new(), 0),
                _ => self.upload(n, f.id, f.kind, f.size, Rc::new(Vec::new())),
            }
        }
    }

    fn read_file(&mut self, file: u32, off: u64, len: u64, f: impl FnOnce(&mut App, Option<Vec<u8>>) + 'static) {
        let id = self.wait(move |app, code, b| f(app, (code == 1).then_some(b)));
        host::fread(id, file, off, len as u32);
    }

    /// Walks a video's top-level boxes, reading only their headers (and moov), and notes what to overwrite.
    #[allow(clippy::too_many_arguments)]
    fn video_walk(&mut self, n: u32, file: u32, kind: String, size: u64, off: u64, mut patches: Patches, boxes: u32) {
        if off + 8 > size || boxes > 10_000 {
            return self.upload(n, file, kind, size, Rc::new(patches));
        }
        self.read_file(file, off, 16.min(size - off), move |app, head| {
            if app.attach_mut(n).is_none() {
                return;
            }
            let Some(head) = head else { return app.attach_failed(n, "This video couldn't be read.".into()) };
            let Some((bsize, hdr, t)) = mp4_box(&head, 0, size - off) else { return app.upload(n, file, kind, size, Rc::new(patches)) };
            if bsize < hdr as u64 || off + bsize > size {
                return app.upload(n, file, kind, size, Rc::new(patches));
            }
            if &t == b"moov" && bsize < 64_000_000 {
                return app.read_file(file, off, bsize, move |app, moov| {
                    let Some(mut moov) = moov else { return app.attach_failed(n, "This video couldn't be read.".into()) };
                    let len = moov.len();
                    scrub_boxes(&mut moov, hdr, len);
                    patches.push((off, moov));
                    app.video_walk(n, file, kind, size, off + bsize, patches, boxes + 1);
                });
            }
            if (&t == b"udta" || &t == b"meta") && bsize < 64_000_000 {
                patches.push((off + 4, b"free".to_vec()));
                patches.push((off + 8, vec![0; bsize as usize - 8]));
            }
            app.video_walk(n, file, kind, size, off + bsize, patches, boxes + 1);
        });
    }

    /// Uploads a file in pieces through our server (server/upload.mjs), signed by this browser's key, as quilcast.com
    /// does for an account whose recovery phrase it doesn't keep: the file is kept on Quilcast's server.
    fn upload(&mut self, n: u32, file: u32, kind: String, size: u64, patches: Rc<Patches>) {
        // the type goes into a header: only the ones the server takes
        // a refused file stays with its tile (and thumbnail) until it's taken off; with no tile it goes now
        let refused = if !TYPES.contains(&kind.as_str()) {
            Some("Use a JPEG, PNG, GIF, WebP, MP4, WebM or MOV file.".to_string())
        } else {
            let max = if kind.starts_with("image/") { IMAGE_MAX } else { VIDEO_MAX };
            (size > max).then(|| format!("Files are limited to {} MB.", max / 1_000_000))
        };
        if let Some(e) = refused {
            if self.attach_mut(n).is_none() {
                host::fdrop(file);
            }
            return self.attach_failed(n, e);
        }
        let Some(fid) = self.me() else { return };
        let extra = format!("\ncontent-type: {kind}\nx-fid: {fid}\nx-size: {size}");
        self.key_fetch("POST", "/api/upload".into(), "quilcast-upload", String::new(), &extra, move |app, status, body| {
            if !(200..300).contains(&status) {
                return app.attach_failed(n, status_error(status, &body, "The upload couldn't start."));
            }
            let j: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
            let id = j.get("id").and_then(|v| v.as_str()).filter(|s| s.len() == 36 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')).map(String::from);
            let (Some(id), max) = (id, j.get("chunk").and_then(|v| v.as_u64()).unwrap_or(CHUNK)) else {
                return app.attach_failed(n, "The upload couldn't start.".into());
            };
            match app.attach_mut(n) {
                Some(a) => {
                    a.upload = Some(id.clone());
                    a.step = Step::Uploading(0, size);
                }
                None => {
                    host::fdrop(file);
                    return app.http("DELETE", &format!("/api/upload/{id}"), &[], "", |_, _, _| {});
                }
            }
            app.put_chunk(n, id, file, size, 0, CHUNK.min(max).max(1), patches, 0);
        });
    }

    #[allow(clippy::too_many_arguments)]
    fn put_chunk(&mut self, n: u32, id: String, file: u32, size: u64, off: u64, chunk: u64, patches: Rc<Patches>, tries: u32) {
        if self.attach_mut(n).is_none() {
            host::fdrop(file);
            return self.http("DELETE", &format!("/api/upload/{id}"), &[], "", |_, _, _| {});
        }
        if off >= size {
            // the file stays until the composer closes, so its thumbnail keeps drawing
            if let Some(a) = self.attach_mut(n) {
                a.step = Step::Processing;
            }
            let url = format!("/api/upload/{id}/done");
            return self.http("POST", &url, &[], "", move |app, status, body| app.upload_state(n, id, status, body, 0));
        }
        self.read_file(file, off, chunk.min(size - off), move |app, bytes| {
            let Some(mut bytes) = bytes else { return app.attach_failed(n, "This file couldn't be read.".into()) };
            patch(&mut bytes, off, &patches);
            let url = format!("/api/upload/{id}?offset={off}");
            app.http("PUT", &url, &bytes, "application/octet-stream", move |app, status, body| {
                let got = serde_json::from_slice::<serde_json::Value>(&body).ok().and_then(|j| j.get("received").and_then(|v| v.as_u64()));
                match got {
                    Some(r) if (200..300).contains(&status) => {
                        if let Some(a) = app.attach_mut(n) {
                            a.step = Step::Uploading(r, size);
                        }
                        app.put_chunk(n, id, file, size, r, chunk, patches, 0);
                    }
                    _ if tries < 4 && status != 404 && status != 413 => {
                        app.later(1000.0 * (tries + 1) as f64, move |app| app.put_chunk(n, id, file, size, off, chunk, patches, tries + 1));
                    }
                    _ => {
                        if app.attach_mut(n).is_none() {
                            host::fdrop(file);
                        }
                        app.attach_failed(n, status_error(status, &body, "The upload stopped."));
                    }
                }
            });
        });
    }

    /// What the server says of an upload it has whole; asked again while it's still processing. A request that
    /// didn't get through (no connection, a busy server) is asked again a few times rather than failing the upload.
    fn upload_state(&mut self, n: u32, id: String, status: i32, body: Vec<u8>, misses: u32) {
        if self.attach_mut(n).is_none() {
            return;
        }
        if (status == 0 || status >= 500) && misses < 3 {
            return self.later(1500.0 * (misses + 1) as f64, move |app| {
                let url = format!("/api/upload/{id}");
                app.http("GET", &url, &[], "", move |app, status, body| app.upload_state(n, id, status, body, misses + 1));
            });
        }
        let j: serde_json::Value = serde_json::from_slice(&body).unwrap_or_default();
        let state = j.get("state").and_then(|v| v.as_str()).unwrap_or("");
        if !(200..300).contains(&status) || state == "failed" {
            let e = j.get("error").and_then(|v| v.as_str()).map(String::from).unwrap_or_else(|| status_error(status, &body, "The upload failed."));
            return self.attach_failed(n, e);
        }
        if state == "ready" {
            let url = j.get("url").and_then(|v| v.as_str()).and_then(text::safe_url);
            return match url {
                Some(u) => {
                    if let Some(a) = self.attach_mut(n) {
                        a.url = Some(u);
                        a.upload = None;
                        a.step = Step::Ready;
                    }
                }
                None => self.attach_failed(n, "The upload failed.".into()),
            };
        }
        if state != "sending" && state != "processing" {
            return self.attach_failed(n, "The upload failed.".into());
        }
        self.later(1500.0, move |app| {
            let url = format!("/api/upload/{id}");
            app.http("GET", &url, &[], "", move |app, status, body| app.upload_state(n, id, status, body, 0));
        });
    }

    /// Takes a picture or video off the cast (stopping its upload).
    pub fn unattach(&mut self, n: u32) {
        let Some(c) = self.compose.as_mut().filter(|c| !c.sending) else { return };
        let Some(p) = c.posts.iter_mut().find(|p| p.media.iter().any(|a| a.n == n)) else { return };
        let Some(i) = p.media.iter().position(|a| a.n == n) else { return };
        let a = p.media.remove(i);
        if let Some(f) = a.file {
            host::fdrop(f);
        }
        if let Some(id) = a.upload {
            self.http("DELETE", &format!("/api/upload/{id}"), &[], "", |_, _, _| {});
        }
    }

    /// Lets go of every file a closing composer still holds.
    pub fn drop_files(c: &Compose) {
        for a in c.posts.iter().flat_map(|p| &p.media) {
            if let Some(f) = a.file {
                host::fdrop(f);
            }
        }
    }

    // --- GIFs ---

    pub fn open_gifs(&mut self) {
        if let Some(c) = self.compose.as_mut() {
            c.panel = Some(Panel::Gifs(String::new()));
        }
        self.load_gifs(String::new());
    }
    pub fn type_gifs(&mut self, v: &str) {
        let Some(c) = self.compose.as_mut() else { return };
        c.panel = Some(Panel::Gifs(v.to_string()));
        self.gif_gen += 1;
        let (g, q) = (self.gif_gen, v.trim().to_lowercase());
        self.later(350.0, move |app| {
            if app.gif_gen == g {
                app.load_gifs(q);
            }
        });
    }
    fn load_gifs(&mut self, q: String) {
        // an empty answer (also what a busy server says) is asked again next time
        if matches!(self.gifs.get(&q), Some(Load::Loading)) || matches!(self.gifs.get(&q), Some(Load::Ready(l)) if !l.is_empty()) {
            return;
        }
        self.gifs.insert(q.clone(), Load::Loading);
        let url = format!("/api/gifs?q={}", text::encode(if q.is_empty() { "trending" } else { &q }));
        self.get::<Vec<Gif>>(url, move |app, r| {
            let v = match r {
                Ok(l) => Load::Ready(l.into_iter().filter(|g| g.cast.as_deref().is_some_and(|u| u.starts_with("https://") && text::safe_url(u).is_some())).collect()),
                Err((_, e)) => Load::Failed(e),
            };
            app.gifs.insert(q, v);
        });
    }
    pub fn pick_gif(&mut self, g: &Gif) {
        let Some(url) = g.cast.clone() else { return };
        if self.room() == 0 {
            return self.say(format!("A cast holds {MAX_EMBEDS} pictures or videos at most."));
        }
        self.add_ready(url, text::safe_url(&g.preview));
    }
    /// A sticker from the picker goes on the post being written, as a GIF does.
    pub fn pick_sticker(&mut self, pack: &str, h: &str) {
        if self.room() == 0 {
            return self.say(format!("A cast holds {MAX_EMBEDS} pictures or videos at most."));
        }
        self.add_ready(sticker_url(pack, h), None);
    }
    fn add_ready(&mut self, url: String, preview: Option<String>) {
        self.attach_seq += 1;
        let n = self.attach_seq;
        if let Some(c) = self.compose.as_mut() {
            let i = c.cur();
            let mut a = Attach::ready(url);
            a.n = n;
            a.preview = preview.or(a.preview);
            c.posts[i].media.push(a);
            c.panel = None;
            c.focus += 1;
        }
    }

    // --- @mentions ---

    /// Post `i`'s text changed, or its caret moved or it got the focus: `v` is "caret|text" (web/shell.js). It
    /// becomes the post being written, and an @name being typed is looked up.
    pub fn type_post(&mut self, i: usize, v: &str) {
        let (caret, t) = v.split_once('|').and_then(|(c, t)| Some((c.parse::<usize>().ok()?, t))).unwrap_or((usize::MAX, v));
        // what was sent is what the composer held when Send was pressed: nothing changes it meanwhile
        let Some(c) = self.compose.as_mut().filter(|c| !c.sending) else { return };
        let Some(p) = c.posts.get_mut(i) else { return };
        p.text = t.to_string();
        p.caret = byte_at(&p.text, caret);
        let typing = mention_at(&p.text, caret);
        let same = c.at == i && typing.as_ref().map(|t| &t.name) == c.typing.as_ref().map(|t| &t.name);
        c.at = i;
        c.typing = typing.clone();
        if same {
            return;
        }
        c.suggest.clear();
        let Some(t) = typing else { return };
        self.mention_gen += 1;
        let g = self.mention_gen;
        self.later(250.0, move |app| {
            if app.mention_gen != g {
                return;
            }
            let url = app.node("/v2/farcaster/user/search", &[("q", t.name.clone()), ("limit", "5".into())]);
            app.get::<UsersResp>(url, move |app, r| {
                let Ok(r) = r else { return };
                let users = if r.users.is_empty() { r.result.map(|x| x.users).unwrap_or_default() } else { r.users };
                if let Some(c) = app.compose.as_mut() {
                    if c.typing.as_ref().map(|x| &x.name) == Some(&t.name) {
                        c.suggest = users.into_iter().filter(|u| u.username.is_some()).take(5).collect();
                    }
                }
            });
        });
    }
    pub fn pick_mention(&mut self, name: &str) {
        let Some(c) = self.compose.as_mut().filter(|c| !c.sending) else { return };
        let Some(t) = c.typing.take() else { return };
        let i = c.cur();
        let p = &mut c.posts[i];
        if t.end > p.text.len() || !p.text.is_char_boundary(t.start) || !p.text.is_char_boundary(t.end) {
            return;
        }
        let rest = p.text[t.end..].to_string();
        let gap = if rest.starts_with(' ') { "" } else { " " };
        let head = format!("{}@{name}{gap}", &p.text[..t.start]);
        p.caret = head.len() + (gap.is_empty() as usize);
        p.text = head + &rest;
        c.suggest.clear();
        c.focus += 1;
    }

    // --- threads ---

    /// Adds a post at the end of the thread, and moves there (src/compose.tsx add).
    pub fn add_post(&mut self) {
        let Some(c) = self.compose.as_mut().filter(|c| c.can_add()) else { return };
        let p = c.new_post();
        c.posts.push(p);
        c.at = c.posts.len() - 1;
        c.typing = None;
        c.suggest.clear();
        c.focus += 1;
    }
    /// Takes post `i` (not the first) out of the thread, with its attachments, and moves to the one before.
    pub fn remove_post(&mut self, i: usize) {
        let Some(c) = self.compose.as_mut().filter(|c| !c.sending && i > 0 && i < c.posts.len()) else { return };
        let p = c.posts.remove(i);
        c.at = i - 1;
        c.typing = None;
        c.suggest.clear();
        c.focus += 1;
        for a in p.media {
            if let Some(f) = a.file {
                host::fdrop(f);
            }
            if let Some(id) = a.upload {
                self.http("DELETE", &format!("/api/upload/{id}"), &[], "", |_, _, _| {});
            }
        }
    }

    // --- emoji and stickers ---

    pub fn open_emoji(&mut self) {
        if let Some(c) = self.compose.as_mut() {
            c.panel = Some(Panel::Emoji(String::new(), 0));
        }
    }
    /// An emoji goes where the caret was in the post being written, and the caret after it.
    pub fn insert_emoji(&mut self, e: &str) {
        let Some(c) = self.compose.as_mut() else { return };
        let i = c.cur();
        let p = &mut c.posts[i];
        let mut at = p.caret.min(p.text.len());
        while !p.text.is_char_boundary(at) {
            at -= 1;
        }
        p.text.insert_str(at, e);
        p.caret = at + e.len();
        c.panel = None;
        c.typing = None;
        c.suggest.clear();
        c.focus += 1;
    }
    pub fn open_stickers(&mut self) {
        if let Some(c) = self.compose.as_mut() {
            c.panel = Some(Panel::Stickers(0));
        }
        if !matches!(self.stickers, Some(Load::Ready(_) | Load::Loading)) {
            self.load_stickers();
        }
    }
    /// The account's sticker packs (src/stickers.tsx myPacks).
    pub fn load_stickers(&mut self) {
        let Some(fid) = self.me() else { return };
        self.stickers = Some(Load::Loading);
        self.get::<Vec<Pack>>(format!("/api/stickers/{fid}"), move |app, r| {
            if app.me() != Some(fid) {
                return;
            }
            app.stickers = Some(match r {
                // only what a sticker's address can hold, and only packs with something in them get a tab
                Ok(l) => Load::Ready(
                    l.into_iter()
                        .map(|mut p| {
                            p.stickers.retain(|s| sticker_pack(&sticker_url(&p.id, &s.h)).is_some());
                            p
                        })
                        .filter(|p| !p.stickers.is_empty())
                        .collect(),
                ),
                Err((_, e)) => Load::Failed(e),
            });
        });
    }

    // --- sending: now, as a thread, or later ---

    /// The posts the composer sends: the first, then each later one with something in it (an empty one left at the
    /// end of a thread is left out, as quilcast.com leaves it out).
    pub fn parts(c: &Compose) -> Vec<Part> {
        c.posts.iter().enumerate().filter(|(i, p)| *i == 0 || !p.empty()).map(|(_, p)| p.part()).collect()
    }

    /// Whether the cast can go: something in its first post, nothing still uploading or too long.
    pub fn can_send(c: &Compose) -> bool {
        let ready = c.posts.iter().flat_map(|p| &p.media).all(|a| a.step == Step::Ready);
        let something = c.posts.first().is_some_and(|p| !p.empty()) || c.quote.is_some();
        let fits = c.posts.iter().all(|p| p.text.len() <= MAX_CAST);
        !c.sending && ready && something && fits && c.quote_wait.is_none() && !c.parent_lost
    }

    pub fn send_compose(&mut self) {
        let Some(c) = self.compose.as_ref() else { return };
        if !App::can_send(c) {
            return;
        }
        let at = if c.when.is_empty() { None } else { host::parse_time(&c.when) };
        if !c.when.is_empty() {
            let now = host::ms();
            let e = match at {
                None => Some("Pick a date and time."),
                Some(t) if t < now + SOONEST => Some("Pick a time at least a minute from now."),
                Some(t) if t > now + LATEST => Some("Pick a time within the next 30 days."),
                _ => None,
            };
            if let Some(e) = e {
                if let Some(c) = self.compose.as_mut() {
                    c.error = Some(e.into());
                }
                return;
            }
        }
        let parts = App::parts(c);
        let gen = c.gen;
        if at.is_some() && parts.len() > MAX_PARTS {
            if let Some(c) = self.compose.as_mut() {
                c.error = Some(format!("A scheduled thread can have up to {MAX_PARTS} posts."));
            }
            return;
        }
        if let Some(c) = self.compose.as_mut() {
            c.sending = true;
            c.error = None;
        }
        // every name a mention could mean is asked about once, all at the same time
        let mut names: Vec<String> = parts.iter().flat_map(|p| fc::mention_spots(&p.text)).flat_map(|(_, n)| fc::mention_tries(&n)).map(|n| n.to_lowercase()).collect();
        names.sort();
        names.dedup();
        let go = move |app: &mut App, found: HashMap<String, Option<Option<u64>>>| match at {
            Some(at) => app.schedule(gen, parts, found, at),
            None => app.post_parts(gen, parts, found),
        };
        if names.is_empty() {
            return go(self, HashMap::new());
        }
        let found: Rc<RefCell<HashMap<String, Option<Option<u64>>>>> = Rc::new(RefCell::new(HashMap::new()));
        let left = Rc::new(RefCell::new(names.len()));
        let go = Rc::new(RefCell::new(Some(go)));
        for n in names {
            let (found, left, go) = (found.clone(), left.clone(), go.clone());
            self.fid_by_name(n.clone(), move |app, fid| {
                found.borrow_mut().insert(n, fid);
                *left.borrow_mut() -= 1;
                if *left.borrow() == 0 {
                    let m = found.borrow().clone();
                    if let Some(go) = go.borrow_mut().take() {
                        go(app, m);
                    }
                }
            });
        }
    }

    /// The cast body of post `i` of a thread whose post before it is `prev`.
    fn part_body(&self, p: &Part, prev: Option<&fc::CastRef>, found: &HashMap<String, Option<Option<u64>>>) -> Result<(Vec<u8>, String), String> {
        let c = self.compose.as_ref().ok_or_else(String::new)?;
        let (text, mentions, positions) = fc::apply_mentions(&p.text, |n| found.get(n).cloned().flatten(), 10);
        // after a thread's first posts went out, the rest replies to the last one that did
        let prev = prev.or(c.posted.as_ref());
        let quote = if prev.is_none() { c.quote.as_ref().map(|q| fc::CastRef { fid: q.author.fid, hash: q.bare_hash() }) } else { None };
        let embeds = embeds_for(&text, &p.media, quote.as_ref());
        let parent = match (prev, &c.parent, &c.channel) {
            (Some(r), _, _) => fc::Parent::Cast(r.clone()),
            (None, Some(p), _) => fc::Parent::Cast(fc::CastRef { fid: p.author.fid, hash: p.bare_hash() }),
            (None, None, Some(id)) => match self.channels.get(id) {
                Some(Load::Ready(_)) => fc::Parent::Url(self.channel_url(id)),
                // a channel the directory hasn't answered about isn't cast into under a guessed URL
                _ => return Err(format!("Still looking up /{id}. Try again in a moment.")),
            },
            (None, None, None) => fc::Parent::None,
        };
        Ok((fc::cast_body(&text, &mentions, &positions, &embeds, &parent), text))
    }

    /// Whether the composer `gen` is still the one open: an answer for an earlier one changes nothing.
    pub fn live(&self, gen: u32) -> bool {
        self.compose.as_ref().is_some_and(|c| c.gen == gen)
    }

    fn compose_failed(&mut self, gen: u32, e: String) {
        if !self.live(gen) {
            return;
        }
        if let Some(id) = e.strip_prefix("Still looking up /").and_then(|r| r.strip_suffix(". Try again in a moment.")).map(String::from) {
            if !matches!(self.channels.get(&id), Some(Load::Loading)) {
                self.channels.remove(&id);
                self.load_channel(id);
            }
        }
        if let Some(c) = self.compose.as_mut() {
            c.sending = false;
            c.error = Some(e);
            // the post that failed comes up to be tried again (or kept as a draft)
            // (with the emptied first post and any empty ones after it, which were left out of what's sent)
            if c.posted.is_some() && c.posts.iter().skip(1).any(|p| !p.empty()) {
                while c.posts[0].empty() {
                    c.posts.remove(0);
                }
                c.at = 0;
                c.focus += 1;
            }
        }
    }

    /// Sends the posts now, each next one a reply to the one before.
    fn post_parts(&mut self, gen: u32, parts: Vec<Part>, found: HashMap<String, Option<Option<u64>>>) {
        self.post_next(gen, Rc::new(parts), Rc::new(found), 0, None);
    }
    fn post_next(&mut self, gen: u32, parts: Rc<Vec<Part>>, found: Rc<HashMap<String, Option<Option<u64>>>>, i: usize, prev: Option<fc::CastRef>) {
        let Some(me) = self.me() else { return };
        if !self.live(gen) {
            return;
        }
        let Some(c) = self.compose.as_ref() else { return };
        if i >= parts.len() {
            if let Some(c) = self.compose.take() {
                App::drop_files(&c);
            }
            return self.say(if parts.len() > 1 { "Thread posted" } else { "Posted" });
        }
        let (body, _) = match self.part_body(&parts[i], prev.as_ref(), &found) {
            Ok(b) => b,
            Err(e) => return self.compose_failed(gen, e),
        };
        let prev = prev.or(c.posted.clone());
        let first = prev.is_none();
        let parent = if first { c.parent.clone() } else { None };
        let quote = if first { c.quote.as_ref().map(|q| fc::CastRef { fid: q.author.fid, hash: q.bare_hash() }) } else { None };
        let channel = if first && c.parent.is_none() { c.channel.as_ref().map(|id| self.channel_url(id)) } else { None };
        let shown = parts[i].text.clone();
        let media = parts[i].media.clone();
        self.send(fc::mt::CAST_ADD, body, move |app, r| match r {
            Ok(hash) => {
                // a post that went out leaves the composer, so trying again sends only the rest; once anything went
                // out, the draft or scheduled cast it was opened from would send it again, so that goes
                let mut gone = (None, None);
                if let Some(c) = app.compose.as_mut().filter(|c| c.gen == gen) {
                    // the post that went out is the composer's first one with something in it (empty ones before it
                    // were left out of what's sent, so they go too); the first post stays, emptied, for the quote
                    let sent: Vec<Attach> = if i == 0 {
                        c.posts[0].text.clear();
                        std::mem::take(&mut c.posts[0].media)
                    } else {
                        match c.posts.iter().skip(1).position(|p| !p.empty()) {
                            Some(k) => c.posts.drain(1..=k + 1).flat_map(|p| p.media).collect(),
                            None => Vec::new(),
                        }
                    };
                    // the files that went out are let go now; closing finds none left to drop
                    for a in sent {
                        if let Some(f) = a.file {
                            host::fdrop(f);
                        }
                    }
                    if i == 0 {
                        c.quote = None;
                        gone = (c.draft.take(), c.sched.take());
                    }
                    c.at = c.at.min(c.posts.len() - 1);
                    c.posted = Some(fc::CastRef { fid: me, hash: hash.clone() });
                }
                if let Some(d) = gone.0.filter(|d| !d.is_empty()) {
                    app.drop_draft(&d, true);
                }
                if let Some(s) = gone.1 {
                    app.unschedule(s);
                }
                let parent = parent.or_else(|| prev.as_ref().map(|p| Cast { hash: p.hash.clone(), author: User { fid: p.fid, ..Default::default() }, ..Default::default() }));
                app.show_posted(hash.clone(), shown, parent, quote, channel, media);
                app.post_next(gen, parts, found, i + 1, Some(fc::CastRef { fid: me, hash }));
            }
            Err(e) => app.compose_failed(gen, e),
        });
    }

    /// Signs the posts now, each with the time it should go out, and hands them to our server, which submits them
    /// then (server/scheduled.mjs). It holds no key: it can't change them or post anything else.
    fn schedule(&mut self, gen: u32, parts: Vec<Part>, found: HashMap<String, Option<Option<u64>>>, at: f64) {
        let Some(fid) = self.me() else { return };
        let url = format!("/api/scheduled/{fid}");
        // asked first, so a key the node doesn't list yet is waited for before anything is signed with it
        self.key_fetch("GET", url, "quilcast-scheduled-read", String::new(), "", move |app, status, body| {
            if !(200..300).contains(&status) {
                return app.compose_failed(gen, status_error(status, &body, "Couldn't reach Quilcast's server."));
            }
            let start = (at / 1000.0).floor() as u64 * 1000;
            app.sign_parts(gen, Rc::new(parts), Rc::new(found), start, 0, None, Vec::new());
        });
    }
    #[allow(clippy::too_many_arguments)]
    fn sign_parts(&mut self, gen: u32, parts: Rc<Vec<Part>>, found: Rc<HashMap<String, Option<Option<u64>>>>, start: u64, i: usize, prev: Option<fc::CastRef>, mut msgs: Vec<String>) {
        if !self.live(gen) {
            return;
        }
        let (Some(a), Some(c)) = (self.account.clone(), self.compose.as_ref()) else { return };
        if i >= parts.len() {
            let (id, replaced) = Sched::target(c.sched.as_ref(), uuid);
            let draft = self.draft_of(c);
            let body = serde_json::json!({ "id": id, "msgs": msgs, "draft": draft }).to_string();
            let when = host::time_str(start as f64, false);
            return self.key_fetch("PUT", format!("/api/scheduled/{}", a.fid), "quilcast-scheduled", body, "", move |app, status, body| {
                if !(200..300).contains(&status) {
                    return app.compose_failed(gen, status_error(status, &body, "The cast couldn't be scheduled."));
                }
                if let Some(c) = app.live(gen).then(|| app.compose.take()).flatten() {
                    App::drop_files(&c);
                    if let Some(d) = c.draft.filter(|d| !d.is_empty()) {
                        app.drop_draft(&d, true);
                    }
                }
                // only now that the new one is in: one that failed to schedule leaves the failed one as it was
                if let Some(s) = replaced {
                    app.unschedule(s);
                }
                if matches!(app.scheduled, Some(Load::Ready(_))) {
                    app.scheduled = None;
                }
                app.say(format!("Scheduled for {when}"));
            });
        }
        let (body, _) = match self.part_body(&parts[i], prev.as_ref(), &found) {
            Ok(b) => b,
            Err(e) => return self.compose_failed(gen, e),
        };
        let u = fc::prepare(fc::mt::CAST_ADD, a.fid, fc::fc_time((start + i as u64 * 1000) as f64), &body);
        let key = fc::unhex(&a.key);
        let hash = u.hash.clone();
        let signer = key.clone();
        self.sign(&signer, &hash, move |app, sig| match sig {
            Ok(sig) => {
                msgs.push(b64(&fc::seal(&u, &sig, &key)));
                let prev = fc::CastRef { fid: a.fid, hash: fc::hex(&u.hash) };
                app.sign_parts(gen, parts, found, start, i + 1, Some(prev), msgs);
            }
            Err(e) => app.compose_failed(gen, e),
        });
    }

    // --- drafts: on our server, sealed here with a key only the account's custody can make (server/drafts.mjs) ---

    pub fn drafts_name(fid: u64) -> String {
        format!("drafts:{fid}")
    }

    /// Whether this browser holds the account's drafts key (made when signing in with the recovery phrase).
    pub fn check_drafts_key(&mut self) {
        let Some(fid) = self.me() else { return };
        let id = self.wait(move |app, code, _| {
            if app.me() == Some(fid) {
                app.drafts_key = Some(code == 1);
            }
        });
        host::ahas(id, &App::drafts_name(fid));
    }

    /// Keeps the drafts key, made from the custody key while the phrase is still in hand at signing in.
    pub fn keep_drafts_key(&mut self, fid: u64, secret: [u8; 32]) {
        let id = self.wait(move |app, code, _| {
            if app.me() == Some(fid) || app.me().is_none() {
                app.drafts_key = Some(code == 1);
            }
        });
        host::aimport(id, &App::drafts_name(fid), &secret);
    }

    /// The draft the composer holds now.
    pub fn draft_of(&self, c: &Compose) -> Draft {
        let parts = c.posts.iter().enumerate().filter(|(i, p)| *i == 0 || !p.empty()).map(|(_, p)| Part { text: p.text.clone(), media: p.media.iter().filter_map(|a| a.url.clone()).collect() }).collect();
        let (parent, pfid, channel) = match (&c.posted, &c.parent, &c.channel) {
            (Some(p), _, _) => (Some(format!("0x{}", p.hash.trim_start_matches("0x"))), Some(p.fid), None),
            (None, Some(p), _) => (Some(format!("0x{}", p.bare_hash())), Some(p.author.fid).filter(|f| *f > 0), None),
            (None, None, ch) => (None, None, ch.clone()),
        };
        let quote = c.quote.as_ref().map(|q| format!("0x{}", q.bare_hash())).or_else(|| c.quote_wait.clone());
        Draft { id: String::new(), at: host::ms() as u64, parts, channel, parent, pfid, quote, as_fid: self.me() }
    }

    pub fn open_drafts(&mut self) {
        if let Some(c) = self.compose.as_mut() {
            c.panel = Some(Panel::Drafts);
        }
        if self.drafts_key.is_none() {
            self.check_drafts_key();
        }
        // read once the key is known to be here (view.rs drafts_pane asks for it)
        if matches!(self.drafts, Some(Load::Failed(_))) {
            self.drafts = None;
        }
    }

    pub fn load_drafts(&mut self) {
        let Some(fid) = self.me() else { return };
        self.drafts = Some(Load::Loading);
        self.key_fetch("GET", format!("/api/drafts/{fid}"), "quilcast-drafts-read", String::new(), "", move |app, status, body| {
            if app.me() != Some(fid) {
                return;
            }
            let list: Vec<Sealed> = match serde_json::from_slice(&body) {
                Ok(l) if (200..300).contains(&status) => l,
                _ => return app.drafts = Some(Load::Failed(status_error(status, &body, "Couldn't read your drafts."))),
            };
            if list.is_empty() {
                return app.drafts = Some(Load::Ready(Vec::new()));
            }
            let got = Rc::new(RefCell::new(Vec::new()));
            let left = Rc::new(RefCell::new(list.len()));
            for s in list {
                let (got, left) = (got.clone(), left.clone());
                let id = app.wait(move |app, code, plain| {
                    // one sealed under another key (a smart wallet that signs differently each time) is left out
                    if let Some(mut d) = (code == 1).then(|| serde_json::from_slice::<Draft>(&plain).ok()).flatten() {
                        d.id = s.id.clone();
                        got.borrow_mut().push(d);
                    }
                    *left.borrow_mut() -= 1;
                    if *left.borrow() == 0 && app.me() == Some(fid) {
                        let mut l = got.borrow_mut().split_off(0);
                        l.sort_by(|a, b| b.at.cmp(&a.at));
                        app.drafts = Some(Load::Ready(l));
                    }
                });
                match unbox(&s.sealed) {
                    Some(b) => host::aopen(id, &App::drafts_name(fid), &b),
                    None => app.done(id, 0, Vec::new()),
                }
            }
        });
    }

    /// Saves what the composer holds as a draft (the one it was opened from, or a new one), then closes it.
    pub fn save_draft(&mut self) {
        let (Some(fid), Some(c)) = (self.me(), self.compose.as_ref()) else { return };
        if c.posts.iter().flat_map(|p| &p.media).any(|a| a.step != Step::Ready) {
            if let Some(c) = self.compose.as_mut() {
                c.error = Some("Wait for the uploads to finish, or take them off.".into());
            }
            return;
        }
        let gen = c.gen;
        let mut d = self.draft_of(c);
        let id = c.draft.clone().filter(|d| !d.is_empty()).unwrap_or_else(uuid);
        d.id = id.clone();
        if let Some(c) = self.compose.as_mut() {
            c.sending = true;
            c.error = None;
        }
        let plain = serde_json::to_vec(&d).unwrap_or_default();
        let sid = self.wait(move |app, code, sealed| {
            if code != 1 || sealed.len() <= 12 {
                return app.compose_failed(gen, "This browser has no drafts key. Sign in again with your recovery phrase to keep drafts.".into());
            }
            let body = serde_json::json!({ "id": id, "box": draft_box(&sealed) }).to_string();
            app.key_fetch("PUT", format!("/api/drafts/{fid}"), "quilcast-drafts", body, "", move |app, status, body| {
                if !(200..300).contains(&status) {
                    return app.compose_failed(gen, status_error(status, &body, "The draft couldn't be saved."));
                }
                if let Some(c) = app.live(gen).then(|| app.compose.take()).flatten() {
                    App::drop_files(&c);
                }
                if let Some(Load::Ready(l)) = app.drafts.as_mut() {
                    l.retain(|x| x.id != d.id);
                    l.insert(0, d);
                }
                app.say("Draft saved");
            });
        });
        host::aseal(sid, &App::drafts_name(fid), &plain);
    }

    /// Deletes a draft; `quiet` when it went out (as a cast or scheduled), so it isn't sent twice.
    pub fn drop_draft(&mut self, id: &str, quiet: bool) {
        let Some(fid) = self.me() else { return };
        if let Some(Load::Ready(l)) = self.drafts.as_mut() {
            l.retain(|d| d.id != id);
        }
        let body = serde_json::json!({ "id": id, "box": null }).to_string();
        self.key_fetch("PUT", format!("/api/drafts/{fid}"), "quilcast-drafts", body, "", move |app, status, body| {
            if !quiet && !(200..300).contains(&status) {
                app.say(status_error(status, &body, "The draft couldn't be deleted."));
                app.drafts = None;
            }
        });
    }

    /// Opens a draft (or a scheduled cast, `sched`, with its time) in the composer: its cast to reply to or quote is
    /// read again. A failed one's time has passed, so it opens with none picked, as quilcast.com does.
    pub fn open_draft(&mut self, d: &Draft, sched: Option<(Sched, u64)>) {
        if self.compose.as_ref().is_none_or(|c| c.sending) {
            return;
        }
        let Some(old) = self.compose.take() else { return };
        App::drop_files(&old);
        self.compose_seq += 1;
        let mut c = Compose::new(self.compose_seq);
        c.draft = (!d.id.is_empty()).then(|| d.id.clone());
        c.channel = d.channel.clone();
        // empty posts past the first are left out, as the composer leaves them out of what it sends (src/write.ts
        // unsent); the first post's quoted cast takes one of its embeds, so the quote isn't the one pushed out
        let quoted = d.quote.as_deref().is_some_and(|h| fc::is_hash(&h.trim_start_matches("0x").to_lowercase()));
        c.posts.clear();
        for (i, p) in d.parts.iter().enumerate() {
            let room = if i == 0 { MAX_EMBEDS - quoted as usize } else { MAX_EMBEDS };
            let mut post = Post { id: i as u32, text: p.text.clone(), ..Default::default() };
            post.caret = post.text.len();
            for u in p.media.iter().filter_map(|u| text::safe_url(u)).take(room) {
                self.attach_seq += 1;
                let mut a = Attach::ready(u);
                a.n = self.attach_seq;
                post.media.push(a);
            }
            if i == 0 || !post.empty() {
                c.posts.push(post);
            }
        }
        if c.posts.is_empty() {
            c.posts.push(Post::default());
        }
        if let Some((s, at)) = sched {
            if s.waiting {
                c.when = host::time_str(at as f64, true);
            }
            c.sched = Some(s);
            c.timing = true;
        }
        if d.as_fid.is_some_and(|f| Some(f) != self.me()) {
            c.error = Some("This was saved for another account. It will go out from this one.".into());
        }
        if let Some(h) = d.parent.as_deref().map(|h| h.trim_start_matches("0x").to_lowercase()).filter(|h| fc::is_hash(h)) {
            // shown with what's known until the node answers; a reply to a cast that can't be found can only be kept
            let pfid = d.pfid.filter(|f| *f > 0);
            let author = User { fid: pfid.unwrap_or(0), ..Default::default() };
            c.parent = Some(Cast { hash: h.clone(), author, ..Default::default() });
            c.parent_lost = pfid.is_none();
            self.reread(h, true);
        }
        if let Some(h) = d.quote.as_deref().map(|h| h.trim_start_matches("0x").to_lowercase()).filter(|h| fc::is_hash(h)) {
            c.quote_wait = Some(format!("0x{h}"));
            self.reread(h, false);
        }
        if let Some(id) = c.channel.clone() {
            if !self.channels.contains_key(&id) {
                self.load_channel(id);
            }
        }
        c.base = snapshot(&c);
        self.compose = Some(c);
    }

    /// Reads the cast a reopened draft replies to (`parent`) or quotes.
    fn reread(&mut self, h: String, parent: bool) {
        let url = self.node("/v2/farcaster/cast", &[("identifier", format!("0x{h}")), ("type", "hash".into())]);
        self.get::<CastResp>(url, move |app, r| {
            let Some(c) = app.compose.as_mut() else { return };
            match (r, parent) {
                (Ok(CastResp { cast: Some(x) }), true) if c.parent.as_ref().is_some_and(|p| p.bare_hash() == h) => {
                    c.parent = Some(x);
                    c.parent_lost = false;
                }
                (Ok(CastResp { cast: Some(x) }), false) if c.quote_wait.as_deref() == Some(&format!("0x{h}")) => {
                    c.quote_wait = None;
                    c.quote = Some(x);
                }
                (_, false) if c.quote_wait.as_deref() == Some(&format!("0x{h}")) => {
                    c.quote_wait = None;
                    c.error = Some("The quoted cast can't be loaded, so it was left out.".into());
                }
                _ => {}
            }
        });
    }

    // --- scheduled casts ---

    pub fn open_scheduled(&mut self) {
        if let Some(c) = self.compose.as_mut() {
            c.panel = Some(Panel::Scheduled);
        }
        if !matches!(self.scheduled, Some(Load::Ready(_) | Load::Loading)) {
            self.load_scheduled();
        }
    }
    pub fn load_scheduled(&mut self) {
        let Some(fid) = self.me() else { return };
        self.scheduled = Some(Load::Loading);
        self.key_fetch("GET", format!("/api/scheduled/{fid}"), "quilcast-scheduled-read", String::new(), "", move |app, status, body| {
            if app.me() != Some(fid) {
                return;
            }
            app.scheduled = Some(match serde_json::from_slice::<Vec<Scheduled>>(&body) {
                Ok(l) if (200..300).contains(&status) => Load::Ready(l),
                _ => Load::Failed(status_error(status, &body, "Couldn't read your scheduled casts.")),
            });
        });
    }
    /// Once what replaces the scheduled cast it was opened from went out or was scheduled, that one is cancelled (a
    /// failed one taken off the list). One the server sent meanwhile went out twice, so that's said (src/compose.tsx
    /// unschedule), as is a cancel the server refused.
    pub fn unschedule(&mut self, s: Sched) {
        let Some(fid) = self.me() else { return };
        let body = serde_json::json!({ "id": s.id }).to_string();
        self.key_fetch("DELETE", format!("/api/scheduled/{fid}"), "quilcast-scheduled-cancel", body, "", move |app, status, body| {
            if !(200..300).contains(&status) {
                return app.say(status_error(status, &body, "Couldn't cancel it."));
            }
            if let Some(Load::Ready(l)) = app.scheduled.as_mut() {
                l.retain(|x| x.id != s.id);
            }
            let was = serde_json::from_slice::<serde_json::Value>(&body).ok().and_then(|v| v.get("was").and_then(|w| w.as_str()).map(str::to_string));
            if s.waiting && was.as_deref() == Some("posted") {
                app.say("That cast was already sent.");
            }
        });
    }

    /// Cancels one still waiting, or takes a posted or failed one off the list.
    pub fn cancel_scheduled(&mut self, id: &str, quiet: bool) {
        let Some(fid) = self.me() else { return };
        let body = serde_json::json!({ "id": id }).to_string();
        let id = id.to_string();
        self.key_fetch("DELETE", format!("/api/scheduled/{fid}"), "quilcast-scheduled-cancel", body, "", move |app, status, body| {
            if (200..300).contains(&status) {
                if let Some(Load::Ready(l)) = app.scheduled.as_mut() {
                    l.retain(|s| s.id != id);
                }
                if !quiet {
                    app.say("Cancelled");
                }
            } else if !quiet {
                app.say(status_error(status, &body, "Couldn't cancel it."));
            }
        });
    }

    // --- the profile's pinned cast (server/pins.mjs) ---

    pub fn load_pin(&mut self, fid: u64) {
        if self.pins.contains_key(&fid) {
            return;
        }
        self.pins.insert(fid, Load::Loading);
        self.get::<serde_json::Value>(format!("/api/pin/{fid}"), move |app, r| {
            match r {
                Ok(v) => {
                    let h = v.get("hash").and_then(|h| h.as_str()).map(|h| h.trim_start_matches("0x").to_lowercase()).filter(|h| fc::is_hash(h));
                    app.pins.insert(fid, Load::Ready(h));
                }
                // a read that failed leaves the profile as it is; the next visit asks again
                Err((_, e)) => {
                    app.pins.insert(fid, Load::Failed(e));
                }
            }
        });
    }
    pub fn pinned(&self, fid: u64) -> Option<&str> {
        match self.pins.get(&fid) {
            Some(Load::Ready(Some(h))) => Some(h),
            _ => None,
        }
    }
    /// Pins one of the account's own casts to its profile, or unpins it (`None`).
    pub fn set_pin(&mut self, hash: Option<String>) {
        let Some(fid) = self.me() else { return };
        self.sheet = None;
        let body = match &hash {
            Some(h) => serde_json::json!({ "hash": format!("0x{h}") }).to_string(),
            None => "null".into(),
        };
        self.key_fetch("PUT", format!("/api/pin/{fid}"), "quilcast-pin", body, "", move |app, status, body| {
            if (200..300).contains(&status) {
                app.say(if hash.is_some() { "Pinned to your profile" } else { "Unpinned" });
                app.pins.insert(fid, Load::Ready(hash));
            } else {
                app.say(status_error(status, &body, "Couldn't save the pin."));
            }
        });
    }
}

/// What the composer holds, to tell whether it changed since it opened.
pub fn snapshot(c: &Compose) -> String {
    let posts: Vec<(&str, Vec<&str>)> = c.posts.iter().filter(|p| !p.empty()).map(|p| (p.text.trim(), p.media.iter().filter_map(|a| a.url.as_deref()).collect())).collect();
    format!("{posts:?}\u{0}{:?}\u{0}{}", c.channel, c.when)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trips_like_btoa() {
        assert_eq!(b64(b""), "");
        assert_eq!(b64(b"f"), "Zg==");
        assert_eq!(b64(b"fo"), "Zm8=");
        assert_eq!(b64(b"foo"), "Zm9v");
        assert_eq!(b64(&[0xff, 0xfe, 0x00, 0x10]), "//4AEA==");
        for n in 0..40u8 {
            let b: Vec<u8> = (0..n).map(|i| i.wrapping_mul(37)).collect();
            assert_eq!(unb64(&b64(&b)).unwrap(), b);
        }
        assert_eq!(unb64("a*b"), None);
        let sealed: Vec<u8> = (0..40).collect();
        let s = draft_box(&sealed);
        assert!(s.contains('.'));
        assert_eq!(unbox(&s).unwrap(), sealed);
        assert_eq!(unbox("AAAA.AAAA"), None, "the IV is 12 bytes");
    }

    #[test]
    fn a_failed_scheduled_cast_is_scheduled_again_as_a_new_one() {
        let fresh = || "new".to_string();
        assert_eq!(Sched::target(None, fresh), ("new".into(), None));
        let waiting = Sched { id: "old".into(), waiting: true };
        assert_eq!(Sched::target(Some(&waiting), fresh), ("old".into(), None), "edited in place");
        let failed = Sched { id: "old".into(), waiting: false };
        assert_eq!(Sched::target(Some(&failed), fresh), ("new".into(), Some(failed.clone())), "replaced, then taken off");
    }

    #[test]
    fn uuids_are_v4() {
        let u = uuid();
        assert_eq!(u.len(), 36);
        assert_eq!(&u[14..15], "4");
        assert!("89ab".contains(&u[19..20]));
        assert_ne!(u, uuid());
    }

    #[test]
    fn mentions_are_found_at_the_caret() {
        let t = |s: &str, c: usize| mention_at(s, c).map(|m| (m.start, m.end, m.name));
        assert_eq!(t("hi @Ali", 7), Some((3, 7, "ali".into())));
        assert_eq!(t("hi @ali and more", 6), Some((3, 7, "al".into())), "the rest of the name goes when one is picked");
        assert_eq!(t("@vitalik.eth", 12), Some((0, 12, "vitalik.eth".into())));
        assert_eq!(t("hi @", 4), None, "a bare @");
        assert_eq!(t("mail@ali", 8), None, "inside a word");
        assert_eq!(t("hi @ali there", 13), None, "past the name");
        // the caret counts UTF-16 units: 😀 is two
        assert_eq!(t("😀 @bo", 6), Some((5, 8, "bo".into())));
        assert_eq!(t("😀 @bo", 5), Some((5, 8, "b".into())));
    }

    #[test]
    fn embeds_are_uploads_then_the_quote_then_links() {
        let q = fc::CastRef { fid: 3, hash: "ab".repeat(20) };
        let e = embeds_for("see https://a.com and https://b.com and https://c.com", &["https://quilcast.com/m/x.jpg".into()], Some(&q));
        assert_eq!(e.len(), 4, "four at most, as src/shared.ts MAX_EMBEDS");
        assert!(matches!(&e[0], fc::Embed::Url(u) if u == "https://quilcast.com/m/x.jpg"));
        assert!(matches!(&e[1], fc::Embed::Cast(c) if c.fid == 3));
        assert!(matches!(&e[3], fc::Embed::Url(u) if u == "https://b.com"));
        let e = embeds_for("see https://a.com", &[], None);
        assert!(matches!(&e[..], [fc::Embed::Url(u)] if u == "https://a.com"));
    }

    fn abox(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
        let mut b = ((body.len() + 8) as u32).to_be_bytes().to_vec();
        b.extend_from_slice(kind);
        b.extend_from_slice(body);
        b
    }

    #[test]
    fn video_metadata_becomes_zeroed_free_boxes_of_the_same_size() {
        let udta = abox(b"udta", b"GPS +12.34-056.78/");
        let trak = abox(b"trak", &[abox(b"tkhd", &[1, 2, 3]), abox(b"meta", b"iPhone")].concat());
        let moov = abox(b"moov", &[abox(b"mvhd", &[9; 4]), udta.clone(), trak].concat());
        let mut m = moov.clone();
        let len = m.len();
        scrub_boxes(&mut m, 8, len);
        assert_eq!(m.len(), moov.len());
        let s = String::from_utf8_lossy(&m);
        assert!(!s.contains("GPS") && !s.contains("iPhone") && !s.contains("udta") && !s.contains("meta"), "{s}");
        assert!(s.contains("mvhd") && s.contains("tkhd") && s.matches("free").count() == 2);
        assert_eq!(&m[8..20], &moov[8..20], "other boxes stay as they were");
    }

    #[test]
    fn patches_land_where_they_belong_in_each_chunk() {
        let patches: Patches = vec![(2, vec![9, 9, 9]), (10, vec![7; 4])];
        let mut a = vec![0u8; 4];
        patch(&mut a, 0, &patches);
        assert_eq!(a, [0, 0, 9, 9]);
        let mut b = vec![0u8; 8];
        patch(&mut b, 4, &patches);
        assert_eq!(b, [9, 0, 0, 0, 0, 0, 7, 7]);
        let mut c = vec![0u8; 4];
        patch(&mut c, 12, &patches);
        assert_eq!(c, [7, 7, 0, 0]);
    }

    #[test]
    fn drafts_read_and_write_like_quilcast_com() {
        // as src/write.ts saveDraft writes one (JSON.stringify of a Draft)
        let ts = r#"{"id":"0b6c2c7e-7b1a-4c39-9a51-1e7c8f1b2c3d","at":1763200000000,"parts":[{"text":"gm","media":["https://quilcast.com/m/abc.jpg"]},{"text":"two","media":[]}],"channel":"memes","quote":"0xabcdef","as":12345}"#;
        let d: Draft = serde_json::from_str(ts).unwrap();
        assert_eq!(d.parts.len(), 2);
        assert_eq!(d.channel.as_deref(), Some("memes"));
        assert_eq!(d.as_fid, Some(12345));
        assert_eq!(serde_json::to_string(&d).unwrap(), ts);
        let empty = Draft { at: 1, parts: vec![Part::default()], ..Default::default() };
        assert_eq!(serde_json::to_string(&empty).unwrap(), r#"{"at":1,"parts":[{"text":"","media":[]}]}"#);
    }

    #[test]
    fn video_urls() {
        assert!(is_video("https://x.com/a.MP4?x=1"));
        assert!(!is_video("https://x.com/a.gif"));
    }
}
