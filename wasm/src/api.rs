//! What the Hypersnap node's HTTP API answers, as far as the app reads it (src/api.ts types). Every field is
//! optional: a node that leaves one out, or writes null, must not lose the whole page.

use serde::{Deserialize, Deserializer};

/// Numbers that may come as a number, a string (Hypersnap writes native FIDs, 2^32 and up, as strings) or null.
pub fn num<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum N {
        U(u64),
        F(f64),
        S(String),
        Null(()),
    }
    Ok(match Option::<N>::deserialize(d)? {
        Some(N::U(n)) => n,
        Some(N::F(f)) if f >= 0.0 => f as u64,
        Some(N::S(s)) => s.parse().unwrap_or(0),
        _ => 0,
    })
}
fn opt_num<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    Ok(Some(num(d)?).filter(|n| *n > 0))
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct User {
    #[serde(deserialize_with = "num")]
    pub fid: u64,
    pub username: Option<String>,
    pub display_name: Option<String>,
    pub pfp_url: Option<String>,
    pub profile: Profile,
    #[serde(deserialize_with = "num")]
    pub follower_count: u64,
    #[serde(deserialize_with = "num")]
    pub following_count: u64,
    pub custody_address: Option<String>,
    pub viewer_context: Option<UserViewer>,
}
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Profile {
    pub bio: Bio,
}
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Bio {
    pub text: Option<String>,
}
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct UserViewer {
    pub following: Option<bool>,
    pub followed_by: Option<bool>,
}

impl User {
    /// What the app calls someone: their display name, else their handle, else their FID.
    pub fn name(&self) -> String {
        self.display_name.clone().filter(|s| !s.trim().is_empty()).or_else(|| self.username.clone()).unwrap_or_else(|| format!("!{}", self.fid))
    }
    pub fn handle(&self) -> String {
        self.username.clone().unwrap_or_else(|| format!("!{}", self.fid))
    }
    /// Their profile's path: by name when they have one.
    pub fn path(&self) -> String {
        match &self.username {
            Some(u) if !u.is_empty() => format!("/u/{u}"),
            _ => format!("/u/{}", self.fid),
        }
    }
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Cast {
    pub hash: String,
    pub text: String,
    pub timestamp: String,
    pub author: User,
    pub parent_hash: Option<String>,
    pub parent_url: Option<String>,
    pub parent_author: ParentAuthor,
    pub embeds: Vec<EmbedJ>,
    pub reactions: Reactions,
    pub replies: Replies,
    pub direct_replies: Vec<Cast>,
    pub mentioned_profiles: Vec<User>,
    pub mentioned_profiles_ranges: Vec<Range>,
    pub viewer_context: Option<CastViewer>,
    pub recaster: Option<User>,
    pub thread_hash: Option<String>,
}
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct ParentAuthor {
    #[serde(deserialize_with = "opt_num")]
    pub fid: Option<u64>,
}
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct EmbedJ {
    pub url: Option<String>,
    pub cast_id: Option<CastIdJ>,
}
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct CastIdJ {
    #[serde(deserialize_with = "num")]
    pub fid: u64,
    pub hash: String,
}
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Reactions {
    #[serde(deserialize_with = "num")]
    pub likes_count: u64,
    #[serde(deserialize_with = "num")]
    pub recasts_count: u64,
}
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Replies {
    #[serde(deserialize_with = "num")]
    pub count: u64,
}
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Range {
    #[serde(deserialize_with = "num")]
    pub start: u64,
    #[serde(deserialize_with = "num")]
    pub end: u64,
}
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct CastViewer {
    pub liked: Option<bool>,
    pub recasted: Option<bool>,
}

impl Cast {
    pub fn bare_hash(&self) -> String {
        self.hash.trim_start_matches("0x").to_lowercase()
    }
    /// The first cast it quotes.
    pub fn quoted(&self) -> Option<(u64, String)> {
        self.embeds.iter().find_map(|e| e.cast_id.as_ref()).filter(|c| crate::fc::is_hash(&c.hash)).map(|c| (c.fid, c.hash.trim_start_matches("0x").to_lowercase()))
    }
    /// Its links (pictures, videos and pages), only public http(s) ones.
    pub fn urls(&self) -> Vec<String> {
        self.embeds.iter().filter_map(|e| e.url.as_deref()).filter_map(crate::text::safe_url).collect()
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Next {
    pub cursor: Option<String>,
}
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct CastPage {
    pub casts: Vec<Cast>,
    pub next: Next,
}
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct UserResp {
    pub user: Option<User>,
}
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct UsersResp {
    pub users: Vec<User>,
    pub result: Option<UsersInner>,
}
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct UsersInner {
    pub users: Vec<User>,
}
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct CastResp {
    pub cast: Option<Cast>,
}
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Conversation {
    pub conversation: CastResp,
}
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct SearchCasts {
    pub result: CastPage,
    pub casts: Vec<Cast>,
    pub next: Next,
}

#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Notification {
    #[serde(rename = "type")]
    pub kind: String,
    pub cast: Option<Cast>,
    pub user: Option<User>,
    pub timestamp: String,
}
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct NotePage {
    pub notifications: Vec<Notification>,
    pub next: Next,
}

/// A channel from farcaster.xyz's directory, as Quilcast's server keeps it (server/channels.mjs).
#[derive(Deserialize, Clone, Default, Debug)]
#[serde(default)]
pub struct Channel {
    pub id: String,
    /// the parent URL its casts go under (for the oldest channels not …/~/channel/<id>)
    pub url: String,
    pub name: String,
    pub desc: Option<String>,
    pub image: Option<String>,
    pub header: Option<String>,
    #[serde(deserialize_with = "num")]
    pub followers: u64,
    #[serde(deserialize_with = "num")]
    pub members: u64,
    pub open: bool,
}

/// A page of people: /v2/farcaster/followers and following (`users`, each the user or `{user}`) and
/// reactions/cast (`reactions`, each `{user}`), with the next page's cursor.
pub fn users_page(v: &serde_json::Value) -> (Vec<User>, Option<String>) {
    let list = v.get("users").or_else(|| v.get("reactions")).and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let users = list.into_iter().filter_map(|x| serde_json::from_value::<User>(x.get("user").cloned().unwrap_or(x)).ok()).filter(|u| u.fid > 0).collect();
    let next = v.pointer("/next/cursor").and_then(|c| c.as_str()).filter(|c| !c.is_empty()).map(String::from);
    (users, next)
}

/// /v1 reactions the account made (to fill in its likes and recasts on nodes that don't say viewer_context).
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct V1Messages {
    pub messages: Vec<V1Message>,
}
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct V1Message {
    pub data: V1Data,
}
#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct V1Data {
    pub reaction_body: Option<V1Reaction>,
}
#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct V1Reaction {
    pub target_cast_id: Option<CastIdJ>,
}

/// An error a node or our server sent back, in words.
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct NodeError {
    pub details: Option<String>,
    pub message: Option<String>,
    pub error_detail: Option<String>,
    pub error: Option<String>,
}
pub fn error_text(status: i32, body: &[u8]) -> String {
    let t = String::from_utf8_lossy(body);
    let e: NodeError = serde_json::from_slice(body).unwrap_or_default();
    e.details.or(e.message).or(e.error_detail).or(e.error).filter(|s| !s.is_empty()).unwrap_or_else(|| {
        if status == 0 {
            "Couldn't reach the network. Check your connection.".into()
        } else if t.trim().is_empty() || t.len() > 300 {
            format!("HTTP {status}")
        } else {
            t.trim().to_string()
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_trending_page() {
        let j = br#"{"casts":[{"hash":"6ba6","author":{"fid":"4294967297","username":"x","follower_count":null},"text":"hi","parent_author":{"fid":null},"embeds":[{"url":"https://a.b/c.png"},{"cast_id":{"fid":3,"hash":"0x6ba6089bb1d3304b82fa17dbb34aa7c691713b0f"}}],"reactions":{"likes_count":2}}],"next":{"cursor":"2"}}"#;
        let p: CastPage = serde_json::from_slice(j).unwrap();
        let c = &p.casts[0];
        assert_eq!(c.author.fid, 4294967297);
        assert_eq!(c.author.follower_count, 0);
        assert_eq!(c.parent_author.fid, None);
        assert_eq!(c.reactions.likes_count, 2);
        assert_eq!(c.quoted(), Some((3, "6ba6089bb1d3304b82fa17dbb34aa7c691713b0f".into())));
        assert_eq!(c.urls(), vec!["https://a.b/c.png"]);
        assert_eq!(p.next.cursor.as_deref(), Some("2"));
    }

    #[test]
    fn reads_pages_of_people() {
        let (u, next) = users_page(&serde_json::json!({"reactions": [{"user": {"fid": 3, "username": "a"}}, {"user": null}], "next": {"cursor": "x"}}));
        assert_eq!((u.len(), u[0].fid, next.as_deref()), (1, 3, Some("x")));
        let (u, next) = users_page(&serde_json::json!({"users": [{"fid": "4"}, {"object": "follow", "user": {"fid": 5}}], "next": {"cursor": null}}));
        assert_eq!((u.iter().map(|u| u.fid).collect::<Vec<_>>(), next), (vec![4, 5], None));
    }

    #[test]
    fn errors_read_as_words() {
        assert_eq!(error_text(400, br#"{"details":"invalid signer"}"#), "invalid signer");
        assert_eq!(error_text(502, b""), "HTTP 502");
        assert!(error_text(0, b"").contains("connection"));
    }
}
