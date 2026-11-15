//! The composer's emoji list: the groups and names of unicode-emoji-json, which quilcast.com's picker uses
//! (src/emoji.tsx), written into emoji.txt by wasm/emoji.mjs and built into the module.

use std::sync::OnceLock;

const DATA: &str = include_str!("emoji.txt");

pub struct Group {
    pub name: &'static str,
    /// each emoji and its name
    pub emoji: Vec<(&'static str, &'static str)>,
}

pub fn groups() -> &'static [Group] {
    static G: OnceLock<Vec<Group>> = OnceLock::new();
    G.get_or_init(|| {
        let mut out: Vec<Group> = Vec::new();
        for line in DATA.lines() {
            // a line without a tab names the group the emoji after it are in
            match (line.split_once('\t'), out.last_mut()) {
                (Some((e, n)), Some(g)) => g.emoji.push((e, n)),
                (Some(_), None) => {}
                (None, _) => out.push(Group { name: line, emoji: Vec::new() }),
            }
        }
        out
    })
}

/// The emoji whose name holds what's typed (in English, as the names are; another language finds nothing rather
/// than something wrong), at most 180.
pub fn search(q: &str) -> Vec<(&'static str, &'static str)> {
    let needle = q.trim().to_lowercase();
    if needle.is_empty() {
        return Vec::new();
    }
    groups().iter().flat_map(|g| g.emoji.iter().copied()).filter(|(_, n)| n.contains(&needle) || n.replace(' ', "_").contains(&needle)).take(180).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_has_every_group_quilcast_com_has() {
        let g = groups();
        assert_eq!(g.len(), 9);
        assert_eq!(g[0].name, "Smileys & Emotion");
        assert_eq!(g[0].emoji[0], ("😀", "grinning face"));
        assert!(g.iter().all(|g| !g.emoji.is_empty()));
        assert!(g.iter().map(|g| g.emoji.len()).sum::<usize>() > 1800);
    }

    #[test]
    fn search_finds_by_name() {
        let hits = search("  Thumbs ");
        assert!(hits.iter().any(|(e, _)| *e == "👍"));
        assert!(search("").is_empty());
        assert!(search("zzzzqq").is_empty());
        assert!(search("face").len() <= 180);
    }
}
