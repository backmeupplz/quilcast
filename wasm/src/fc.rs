//! Farcaster protocol bits, ported from src/fc.ts: protobuf messages, the custody key a recovery phrase derives,
//! EIP-712 for KEY_ADD, and mentions. The bytes match src/fc.ts exactly (tests below use vectors it produced).
//! Ed25519 signing of messages happens in the browser's WebCrypto (the shell), so a message is built in two steps:
//! `prepare` gives the bytes to sign, `seal` wraps them with the signature.

use hmac::{Hmac, Mac};
use k256::elliptic_curve::sec1::ToEncodedPoint;
use sha2::Sha512;
use sha3::{Digest, Keccak256};

pub fn hex(b: &[u8]) -> String {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push(H[(x >> 4) as usize] as char);
        s.push(H[(x & 15) as usize] as char);
    }
    s
}
pub fn unhex(s: &str) -> Vec<u8> {
    let s = s.strip_prefix("0x").unwrap_or(s).as_bytes();
    let v = |c: u8| match c {
        b'0'..=b'9' => c - b'0',
        b'a'..=b'f' => c - b'a' + 10,
        b'A'..=b'F' => c - b'A' + 10,
        _ => 0,
    };
    s.chunks(2).filter(|p| p.len() == 2).map(|p| v(p[0]) << 4 | v(p[1])).collect()
}
pub fn is_hash(s: &str) -> bool {
    let s = s.strip_prefix("0x").unwrap_or(s);
    s.len() == 40 && s.bytes().all(|c| c.is_ascii_hexdigit())
}

// --- protobuf writer: varints and length-delimited fields are all Farcaster's messages need ---

fn varint(out: &mut Vec<u8>, mut n: u64) {
    while n >= 0x80 {
        out.push((n as u8 & 0x7f) | 0x80);
        n >>= 7;
    }
    out.push(n as u8);
}

/// A protobuf field. As in src/fc.ts `pb`: empty bytes, strings and packed lists are left out; numbers always go in
/// (callers leave out the zeros protobuf would skip).
pub enum F<'a> {
    U(u32, u64),
    B(u32, &'a [u8]),
    S(u32, &'a str),
    P(u32, &'a [u64]),
}
pub fn pb(fields: &[F]) -> Vec<u8> {
    let mut out = Vec::new();
    for f in fields {
        match f {
            F::U(n, v) => {
                varint(&mut out, (*n as u64) << 3);
                varint(&mut out, *v);
            }
            F::B(n, b) => len_field(&mut out, *n, b),
            F::S(n, s) => len_field(&mut out, *n, s.as_bytes()),
            F::P(n, vs) => {
                let mut b = Vec::new();
                for v in *vs {
                    varint(&mut b, *v);
                }
                len_field(&mut out, *n, &b);
            }
        }
    }
    out
}
fn len_field(out: &mut Vec<u8>, n: u32, b: &[u8]) {
    if b.is_empty() {
        return;
    }
    varint(out, ((n as u64) << 3) | 2);
    varint(out, b.len() as u64);
    out.extend_from_slice(b);
}

pub mod mt {
    pub const CAST_ADD: u64 = 1;
    pub const CAST_REMOVE: u64 = 2;
    pub const REACTION_ADD: u64 = 3;
    pub const REACTION_REMOVE: u64 = 4;
    pub const LINK_ADD: u64 = 5;
    pub const LINK_REMOVE: u64 = 6;
    pub const USER_DATA_ADD: u64 = 11;
    pub const KEY_ADD: u64 = 16;
    pub const KEY_REMOVE: u64 = 17;
}
/// What this browser's signer may sign: casts, reactions, follows and profile edits, as src/fc.ts SCOPES.
pub const SCOPES: [u64; 7] = [1, 2, 3, 4, 5, 6, 11];
fn body_field(t: u64) -> u32 {
    match t {
        1 => 5,
        2 => 6,
        3 | 4 => 7,
        5 | 6 => 14,
        11 => 12,
        16 => 19,
        17 => 20,
        _ => 0,
    }
}
/// Seconds since the Farcaster epoch (2021-01-01), from Unix milliseconds.
pub fn fc_time(unix_ms: f64) -> u64 {
    ((unix_ms / 1000.0).floor() as u64).saturating_sub(1_609_459_200)
}

#[derive(Clone, Debug, PartialEq)]
pub struct CastRef {
    pub fid: u64,
    pub hash: String,
}
fn cast_id(r: &CastRef) -> Vec<u8> {
    pb(&[F::U(1, r.fid), F::B(2, &unhex(&r.hash))])
}

pub enum Parent {
    None,
    Cast(CastRef),
    Url(String),
}
pub enum Embed {
    Url(String),
    Cast(CastRef),
}

pub fn cast_body(text: &str, mentions: &[u64], positions: &[u64], embeds: &[Embed], parent: &Parent) -> Vec<u8> {
    let parent_cast = match parent {
        Parent::Cast(r) => cast_id(r),
        _ => Vec::new(),
    };
    let parent_url = match parent {
        Parent::Url(u) => u.as_str(),
        _ => "",
    };
    let embeds: Vec<Vec<u8>> = embeds
        .iter()
        .map(|e| match e {
            Embed::Url(u) => pb(&[F::S(1, u)]),
            Embed::Cast(r) => pb(&[F::B(2, &cast_id(r))]),
        })
        .collect();
    let mut fields = vec![F::P(2, mentions), F::B(3, &parent_cast), F::S(7, parent_url), F::S(4, text), F::P(5, positions)];
    for e in &embeds {
        fields.push(F::B(6, e));
    }
    // over 320 bytes must be marked LONG_CAST (allowed up to 1024)
    if text.len() > 320 {
        fields.push(F::U(8, 1));
    }
    pb(&fields)
}
pub fn reaction_body(kind: u64, target: &CastRef) -> Vec<u8> {
    pb(&[F::U(1, kind), F::B(2, &cast_id(target))])
}
pub fn follow_body(fid: u64) -> Vec<u8> {
    pb(&[F::S(1, "follow"), F::U(3, fid)])
}
pub fn cast_remove_body(hash: &str) -> Vec<u8> {
    pb(&[F::B(1, &unhex(hash))])
}
pub fn user_data_body(kind: u64, value: &str) -> Vec<u8> {
    pb(&[F::U(1, kind), F::S(2, value)])
}

/// MessageData and its hash, waiting for the signer's signature.
pub struct Unsigned {
    pub data: Vec<u8>,
    pub hash: Vec<u8>,
}
pub fn prepare(kind: u64, fid: u64, at: u64, body: &[u8]) -> Unsigned {
    let data = pb(&[F::U(1, kind), F::U(2, fid), F::U(3, at), F::U(4, 1), F::B(body_field(kind), body)]);
    let hash = blake3::hash(&data).as_bytes()[..20].to_vec();
    Unsigned { data, hash }
}
/// The Message envelope; hypersnap merges read `data` while hashing uses `data_bytes`, so both are sent.
pub fn seal(u: &Unsigned, sig: &[u8], signer: &[u8]) -> Vec<u8> {
    pb(&[F::B(1, &u.data), F::B(2, &u.hash), F::U(3, 1), F::B(4, sig), F::U(5, 1), F::B(6, signer), F::B(7, &u.data)])
}

/// When a message is stamped (src/fc.ts envelope): now, newer than `after`, and for reactions and follows newer than
/// the one before (a like and its undo in one second would tie, and a tie goes to the remove). Nodes take up to
/// 10 minutes ahead.
pub fn stamp(kind: u64, now: u64, after: u64, last_toggle: &mut u64) -> u64 {
    let mut at = (now.max(after + 1)).min(now + 590);
    if (mt::REACTION_ADD..=mt::LINK_REMOVE).contains(&kind) {
        at = (at.max(*last_toggle + 1)).min(now + 590);
        *last_toggle = at;
    }
    at
}

// --- the custody key and Ethereum signatures ---

fn keccak(b: &[u8]) -> [u8; 32] {
    Keccak256::digest(b).into()
}

/// The recovery phrase as BIP-39 reads it: lowercase words, single spaces. Only ASCII letters are words in the
/// English list, so NFKD changes nothing for a phrase that can be valid.
pub fn normal_phrase(p: &str) -> String {
    p.split_whitespace().map(|w| w.to_lowercase()).collect::<Vec<_>>().join(" ")
}

/// The custody key a phrase derives, the way Warpcast and Quorum do (BIP-39 seed, m/44'/60'/0'/0/0), so phrases move
/// between apps.
pub fn custody_key(phrase: &str) -> Option<[u8; 32]> {
    let p = normal_phrase(phrase);
    let mut seed = [0u8; 64];
    pbkdf2::pbkdf2_hmac::<Sha512>(p.as_bytes(), b"mnemonic", 2048, &mut seed);
    let mut mac = Hmac::<Sha512>::new_from_slice(b"Bitcoin seed").ok()?;
    mac.update(&seed);
    let i = mac.finalize().into_bytes();
    let (mut k, mut c): ([u8; 32], [u8; 32]) = (i[..32].try_into().ok()?, i[32..].try_into().ok()?);
    for idx in [0x8000_002c_u32, 0x8000_003c, 0x8000_0000, 0, 0] {
        let mut mac = Hmac::<Sha512>::new_from_slice(&c).ok()?;
        if idx >= 0x8000_0000 {
            mac.update(&[0]);
            mac.update(&k);
        } else {
            let sk = k256::SecretKey::from_slice(&k).ok()?;
            mac.update(sk.public_key().to_encoded_point(true).as_bytes());
        }
        mac.update(&idx.to_be_bytes());
        let i = mac.finalize().into_bytes();
        let il = k256::NonZeroScalar::try_from(&i[..32]).ok()?;
        let parent = k256::NonZeroScalar::try_from(&k[..]).ok()?;
        let child: k256::Scalar = *il + *parent;
        if bool::from(child.is_zero()) {
            return None;
        }
        k = child.to_bytes().into();
        c = i[32..].try_into().ok()?;
    }
    Some(k)
}

pub fn address(priv_key: &[u8; 32]) -> String {
    let sk = k256::SecretKey::from_slice(priv_key).expect("a valid key");
    let p = sk.public_key().to_encoded_point(false);
    format!("0x{}", hex(&keccak(&p.as_bytes()[1..])[12..]))
}

/// A 65-byte signature (r, s, v = 27/28) of a 32-byte digest.
pub fn sign65(digest: &[u8; 32], priv_key: &[u8; 32]) -> Vec<u8> {
    let sk = k256::ecdsa::SigningKey::from_slice(priv_key).expect("a valid key");
    let (sig, rec) = sk.sign_prehash_recoverable(digest).expect("signing");
    let mut out = sig.to_bytes().to_vec();
    out.push(27 + rec.to_byte());
    out
}

/// An EIP-191 personal_sign by the custody key: what src/fc.ts keyCustody's `message` makes.
pub fn personal_sign(msg: &[u8], priv_key: &[u8; 32]) -> Vec<u8> {
    let mut b = format!("\x19Ethereum Signed Message:\n{}", msg.len()).into_bytes();
    b.extend_from_slice(msg);
    sign65(&keccak(&b), priv_key)
}

/// The AES key drafts are sealed with (src/write.ts draftKey): SHA-256 of r and s of the custody's signature over a
/// fixed message. RFC 6979 makes the signature, so the key, the same every time, here and on quilcast.com.
pub fn drafts_secret(fid: u64, custody: &[u8; 32]) -> [u8; 32] {
    use sha2::Digest;
    let msg = format!("Quilcast drafts key for FID {fid}\n\nSigning this lets Quilcast encrypt your drafts so only you can read them. It sends nothing and costs nothing.");
    let sig = personal_sign(msg.as_bytes(), custody);
    sha2::Sha256::digest(&sig[..64]).into()
}

// --- EIP-712 for the flat structs Farcaster signs ---

pub enum Val {
    U(u64),
    Addr(String),
    Bytes(Vec<u8>),
    Str(String),
    U32s(Vec<u64>),
}
fn word(v: u64) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&v.to_be_bytes());
    w
}
fn addr_word(a: &str) -> [u8; 32] {
    let b = unhex(a);
    let mut w = [0u8; 32];
    w[32 - b.len().min(32)..].copy_from_slice(&b[..b.len().min(32)]);
    w
}
fn enc(v: &Val) -> [u8; 32] {
    match v {
        Val::U(n) => word(*n),
        Val::Addr(a) => addr_word(a),
        Val::Bytes(b) => keccak(b),
        Val::Str(s) => keccak(s.as_bytes()),
        Val::U32s(xs) => keccak(&xs.iter().flat_map(|x| word(*x)).collect::<Vec<_>>()),
    }
}
fn type_name(v: &Val, hint: &str) -> String {
    if !hint.is_empty() {
        return hint.into();
    }
    match v {
        Val::U(_) => "uint256",
        Val::Addr(_) => "address",
        Val::Bytes(_) => "bytes",
        Val::Str(_) => "string",
        Val::U32s(_) => "uint32[]",
    }
    .into()
}
/// A struct's hash; each member is (name, solidity type or "" for the default of its value, value).
fn struct_hash(name: &str, members: &[(&str, &str, Val)]) -> [u8; 32] {
    let sig = format!("{name}({})", members.iter().map(|(n, t, v)| format!("{} {n}", type_name(v, t))).collect::<Vec<_>>().join(","));
    let mut b = keccak(sig.as_bytes()).to_vec();
    for (_, _, v) in members {
        b.extend_from_slice(&enc(v));
    }
    keccak(&b)
}
pub struct Domain<'a> {
    pub name: &'a str,
    pub version: &'a str,
    pub chain_id: u64,
    pub verifying_contract: Option<&'a str>,
}
pub fn hash_typed(d: &Domain, primary: &str, members: &[(&str, &str, Val)]) -> [u8; 32] {
    let mut dm = vec![("name", "", Val::Str(d.name.into())), ("version", "", Val::Str(d.version.into())), ("chainId", "", Val::U(d.chain_id))];
    if let Some(c) = d.verifying_contract {
        dm.push(("verifyingContract", "", Val::Addr(c.into())));
    }
    let mut b = vec![0x19, 1];
    b.extend_from_slice(&struct_hash("EIP712Domain", &dm));
    b.extend_from_slice(&struct_hash(primary, members));
    keccak(&b)
}

const KEY_ADD_DOMAIN: Domain = Domain { name: "Farcaster KeyAdd", version: "1", chain_id: 1, verifying_contract: None };

/// The KEY_ADD body that registers `signer` for `fid` without an on-chain transaction (Hypersnap gasless signers),
/// signed by the custody key; `now` is Farcaster time. The message itself is then signed by `signer`.
pub fn key_add_body(fid: u64, custody: &[u8; 32], signer: &[u8], nonce: u64, now: u64) -> Vec<u8> {
    let deadline = now + 3600;
    let ttl = 90 * 86400;
    let custody_addr = address(custody);
    let skr = sign65(
        &hash_typed(&KEY_ADD_DOMAIN, "SignedKeyRequest", &[("requestFid", "", Val::U(fid)), ("key", "", Val::Bytes(signer.to_vec())), ("deadline", "", Val::U(deadline))]),
        custody,
    );
    // abi.encode((uint256 requestFid, address requestSigner, bytes signature, uint256 deadline))
    let mut metadata = Vec::new();
    for w in [word(32), word(fid), addr_word(&custody_addr), word(128), word(deadline), word(65)] {
        metadata.extend_from_slice(&w);
    }
    metadata.extend_from_slice(&skr);
    metadata.extend_from_slice(&[0u8; 31]);
    let custody_sig = sign65(
        &hash_typed(
            &KEY_ADD_DOMAIN,
            "KeyAdd",
            &[
                ("fid", "", Val::U(fid)),
                ("key", "", Val::Bytes(signer.to_vec())),
                ("keyType", "uint32", Val::U(1)),
                ("scopes", "", Val::U32s(SCOPES.to_vec())),
                ("ttl", "uint32", Val::U(ttl)),
                ("nonce", "uint32", Val::U(nonce)),
                ("deadline", "", Val::U(deadline)),
            ],
        ),
        custody,
    );
    pb(&[F::B(1, signer), F::U(2, 1), F::B(3, &custody_sig), F::U(4, deadline), F::U(5, nonce), F::B(6, &metadata), F::U(7, 1), F::P(9, &SCOPES), F::U(10, ttl)])
}

/// KEY_REMOVE the signer signs itself (Hypersnap self-revocation), for signing out.
pub fn key_remove_self_body(signer: &[u8], nonce: u64, now: u64) -> Vec<u8> {
    pb(&[F::B(1, signer), F::U(3, 2), F::U(4, now + 3600), F::U(5, nonce)])
}

/// IdRegistry.idOf(address) calldata, for an account the node doesn't know by its custody address.
pub fn id_of_call(addr: &str) -> String {
    let mut b = keccak(b"idOf(address)")[..4].to_vec();
    b.extend_from_slice(&addr_word(addr));
    format!("0x{}", hex(&b))
}
pub const ID_REGISTRY: &str = "0x00000000fc6c5f01fc30151999387bb99a9f489b";

// --- mentions ---

pub fn name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '.' || c == '-'
}

/// The names "@name" can mean, longest first (src/shared.ts mentionTries): trailing "." and "-" come off one at a
/// time, at most two of a longer run kept.
pub fn mention_tries(name: &str) -> Vec<String> {
    let b = name.as_bytes();
    let mut whole = b.len();
    while whole > 0 && b[whole - 1] == b'.' {
        whole -= 1;
    }
    let mut end = whole;
    while end > 0 && (b[end - 1] == b'.' || b[end - 1] == b'-') {
        end -= 1;
    }
    let mut out = Vec::new();
    if whole > end + 2 {
        out.push(name[..whole].to_string());
    }
    let mut n = &name[..whole.min(end + 2)];
    loop {
        if !n.ends_with('.') {
            out.push(n.to_string());
        }
        if n.len() <= end {
            return out;
        }
        n = &n[..n.len() - 1];
    }
}

/// Each "@name" in a text: its byte offset (at the "@") and the name as typed.
pub fn mention_spots(text: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    let mut prev: Option<char> = None;
    for (i, c) in text.char_indices() {
        if c == '@' && prev.map_or(true, |p| p.is_whitespace()) {
            let rest = &text[i + 1..];
            if rest.chars().next().is_some_and(|f| f.is_ascii_alphanumeric()) {
                let len = rest.find(|ch: char| !name_char(ch)).unwrap_or(rest.len());
                out.push((i, rest[..len].to_string()));
            }
        }
        prev = Some(c);
    }
    out
}

/// The text without its mentions, the mentioned FIDs and their byte positions (src/fc.ts mentions). `lookup` says a
/// name's FID: Some(None) for no such user, None for a name it couldn't ask about, which then stays text. At most
/// `max` mentions (a node takes 10 a cast).
pub fn apply_mentions(text: &str, lookup: impl Fn(&str) -> Option<Option<u64>>, max: usize) -> (String, Vec<u64>, Vec<u64>) {
    let (mut out, mut fids, mut pos) = (String::new(), Vec::new(), Vec::new());
    let mut last = 0;
    'spots: for (at, typed) in mention_spots(text) {
        if fids.len() >= max {
            break;
        }
        for name in mention_tries(&typed) {
            match lookup(&name.to_lowercase()) {
                None => continue 'spots,
                Some(None) => continue,
                Some(Some(fid)) => {
                    out.push_str(&text[last..at]);
                    fids.push(fid);
                    pos.push(out.len() as u64);
                    last = at + name.len() + 1;
                    continue 'spots;
                }
            }
        }
    }
    out.push_str(&text[last..]);
    (out, fids, pos)
}

#[cfg(test)]
mod tests {
    use super::*;

    // vectors from src/fc.ts (wasm/vectors.mjs prints them)
    const PHRASE: &str = "test test test test test test test test test test test junk";

    #[test]
    fn phrase_derives_the_same_custody_as_the_ts_app() {
        let k = custody_key(PHRASE).unwrap();
        // the well-known first Hardhat account for this phrase
        assert_eq!(address(&k), "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
        assert_eq!(custody_key("  TEST test test test test test test test test test test   junk ").unwrap(), k);
    }

    #[test]
    fn varints_and_fields() {
        assert_eq!(pb(&[F::U(1, 300)]), vec![8, 0xac, 2]);
        assert_eq!(pb(&[F::S(4, ""), F::P(2, &[])]), Vec::<u8>::new());
        assert_eq!(pb(&[F::S(2, "hi")]), vec![0x12, 2, b'h', b'i']);
    }

    #[test]
    fn stamps_never_tie() {
        let mut last = 0;
        let a = stamp(mt::REACTION_ADD, 100, 0, &mut last);
        let b = stamp(mt::REACTION_REMOVE, 100, 0, &mut last);
        assert_eq!((a, b), (100, 101));
        assert_eq!(stamp(mt::CAST_ADD, 100, 0, &mut last), 100);
        assert_eq!(stamp(mt::CAST_ADD, 100, 5000, &mut last), 690);
    }

    #[test]
    fn mention_tries_match_shared_ts() {
        assert_eq!(mention_tries("alice."), vec!["alice"]);
        assert_eq!(mention_tries("adam-"), vec!["adam-", "adam"]);
        assert_eq!(mention_tries("adam-----"), vec!["adam-----", "adam--", "adam-", "adam"]);
        assert_eq!(mention_tries("bob.eth"), vec!["bob.eth"]);
    }

    #[test]
    fn mentions_come_out_with_byte_positions() {
        let look = |n: &str| match n {
            "dwr" => Some(Some(3)),
            "v" => Some(Some(2)),
            "down" => None,
            _ => Some(None),
        };
        let (t, f, p) = apply_mentions("héllo @dwr and @v. @nobody @down x@dwr", look, 10);
        assert_eq!(t, "héllo  and . @nobody @down x@dwr");
        assert_eq!(f, vec![3, 2]);
        assert_eq!(p, vec![7, 12]);
        let (_, f, _) = apply_mentions("@dwr @v", look, 1);
        assert_eq!(f, vec![3]);
    }

    // src/fc.ts at Date.now() = 1763200000000, signer seed 1..=32 (wasm/vectors.mjs)
    const V_CAST: &str = "1201031a18080312146ba6089bb1d3304b82fa17dbb34aa7c691713b0f220e676d2020616e642068c3a96c6c6f2a010332160a1468747470733a2f2f7175696c636173742e636f6d321a1218080312146ba6089bb1d3304b82fa17dbb34aa7c691713b0f";
    const V_ENVELOPE: &str = "0a1a080110b9601880cca74920012a0c220a68656c6c6f207761736d1214068b736f52dbcf434d9a2d2e81e9b680564d4d1a1801224002ea6457665a2328d93a8d6906ba2ac201846d90a39f0a7936784924a0e1497baa489bbc4ab83089214f8530f5906427958b0eba29a12a03b93f74706a5b0b012801322079b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad0496643a1a080110b9601880cca74920012a0c220a68656c6c6f207761736d";
    const V_KEY_ADD: &str = "0ab503081010b9601880cca74920019a01a5030a2079b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad04966410011a41667fce4a05df4c9f182f70094206de94f3ce119c3028a78029528523b3e0ad9b4e14e03910b087a32d617bdef47da4ccf43ce95c8b18e705c5154589f9cf40b61b2090e8a749288098e1c80632a00200000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000003039000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb922660000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000929f4100000000000000000000000000000000000000000000000000000000000000041e60496b6ec24175d1beb2fc808ec70d2e9355476397083a8aa705a07de515e2a7093ef4a12d3ad1fe829f7b306b23329dc0189d3a2f5ad9e76d05b234d89f5161c0000000000000000000000000000000000000000000000000000000000000038014a070102030405060b5080ceda03121417702e04a676573b7242d162d620827f2fda8824180122408ab55a544e7df50e233975d8bde3fb38ac3bcd80bf29262015fde8a621a7af132cc6cd28266206c5d37f5635f46ee82938ceb7a0c160135fc2fff0be6efa7d072801322079b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad0496643ab503081010b9601880cca74920019a01a5030a2079b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad04966410011a41667fce4a05df4c9f182f70094206de94f3ce119c3028a78029528523b3e0ad9b4e14e03910b087a32d617bdef47da4ccf43ce95c8b18e705c5154589f9cf40b61b2090e8a749288098e1c80632a00200000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000003039000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb922660000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000929f4100000000000000000000000000000000000000000000000000000000000000041e60496b6ec24175d1beb2fc808ec70d2e9355476397083a8aa705a07de515e2a7093ef4a12d3ad1fe829f7b306b23329dc0189d3a2f5ad9e76d05b234d89f5161c0000000000000000000000000000000000000000000000000000000000000038014a070102030405060b5080ceda03";
    const V_KEY_REMOVE: &str = "0a3e081110b9601880cca7492001a2012f0a2079b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad04966418022090e8a749288198e1c8061214419f19e731168202e44ee778691c501d42cece5918012240b78779718b7136f539aad466af97360084aed040bdd14b1e7df7cc23e5f67b52a5f03cd3a1520f4cc7d380981e5d67e6618ff266ef2d1285a0e230b9609f15032801322079b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad0496643a3e081110b9601880cca7492001a2012f0a2079b5562e8fe654f94078b112e8a98ba7901f853ae695bed7e0e3910bad04966418022090e8a749288198e1c806";
    const NOW: u64 = 1763200000 - 1609459200;

    fn signed(kind: u64, fid: u64, body: &[u8]) -> String {
        use ed25519_dalek::Signer;
        let seed: [u8; 32] = core::array::from_fn(|i| i as u8 + 1);
        let k = ed25519_dalek::SigningKey::from_bytes(&seed);
        let u = prepare(kind, fid, NOW, body);
        hex(&seal(&u, &k.sign(&u.hash).to_bytes(), k.verifying_key().as_bytes()))
    }

    #[test]
    fn bodies_match_fc_ts_byte_for_byte() {
        let parent = CastRef { fid: 3, hash: "6ba6089bb1d3304b82fa17dbb34aa7c691713b0f".into() };
        let body = cast_body("gm  and héllo", &[3], &[3], &[Embed::Url("https://quilcast.com".into()), Embed::Cast(parent.clone())], &Parent::Cast(parent.clone()));
        assert_eq!(hex(&body), V_CAST);
        let long = cast_body(&"x".repeat(321), &[], &[], &[], &Parent::Url("https://farcaster.xyz/~/channel/wasm".into()));
        assert!(hex(&long).starts_with("3a2468747470733a2f2f6661726361737465722e78797a2f7e2f6368616e6e656c2f7761736d22c102") && hex(&long).ends_with("784001"));
        assert_eq!(hex(&reaction_body(1, &parent)), "08011218080312146ba6089bb1d3304b82fa17dbb34aa7c691713b0f");
        assert_eq!(hex(&follow_body(3)), "0a06666f6c6c6f771803");
        assert_eq!(hex(&cast_remove_body(&parent.hash)), "0a146ba6089bb1d3304b82fa17dbb34aa7c691713b0f");
        assert_eq!(hex(&user_data_body(2, "Quil")), "080212045175696c");
    }

    #[test]
    fn signed_messages_match_fc_ts_byte_for_byte() {
        assert_eq!(signed(mt::CAST_ADD, 12345, &cast_body("hello wasm", &[], &[], &[], &Parent::None)), V_ENVELOPE);
        let seed: [u8; 32] = core::array::from_fn(|i| i as u8 + 1);
        let signer = ed25519_dalek::SigningKey::from_bytes(&seed).verifying_key().to_bytes();
        let custody = custody_key(PHRASE).unwrap();
        assert_eq!(signed(mt::KEY_ADD, 12345, &key_add_body(12345, &custody, &signer, 1763200000, NOW)), V_KEY_ADD);
        assert_eq!(signed(mt::KEY_REMOVE, 12345, &key_remove_self_body(&signer, 1763200001, NOW)), V_KEY_REMOVE);
    }

    #[test]
    fn drafts_key_matches_quilcast_com() {
        let custody = custody_key(PHRASE).unwrap();
        let msg = "Quilcast drafts key for FID 12345\n\nSigning this lets Quilcast encrypt your drafts so only you can read them. It sends nothing and costs nothing.";
        assert_eq!(hex(&personal_sign(msg.as_bytes(), &custody)), "03c11c3e6164e9c7c57d94cfb0ccd20d5784dbfbf6b0d3ae08f64e2b3639f5d56772a2ea708431c496c66b72fd2111a349a77a487050a79ae9b95e2e2085d0d21b");
        assert_eq!(hex(&drafts_secret(12345, &custody)), "c0502581b5f602f8b7ea9e6b47c98ce852002e4f5eb4220793272aabed27e8b8");
    }

    #[test]
    fn id_of_calldata() {
        assert_eq!(id_of_call("0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"), "0xd94fe832000000000000000000000000f39fd6e51aad88f6f4ce6ab8827279cfffb92266");
    }
}
