use crate::{
    completion::ignored_end,
    document::{Kind, Position, Region},
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

#[derive(Default)]
struct Usage {
    count: usize,
    last: usize,
}
#[derive(Default)]
pub struct History {
    terms: HashMap<String, Usage>,
}

fn name_end(text: &str, start: usize, number: bool) -> Option<usize> {
    let mut chars = text.get(start..)?.char_indices();
    let (_, first) = chars.next()?;
    if !(unicode_ident::is_xid_start(first) || number && first.is_ascii_digit()) {
        return None;
    }
    Some(
        chars
            .find(|&(_, c)| c != '-' && (c == '_' || !unicode_ident::is_xid_continue(c)))
            .map_or(text.len(), |(i, _)| start + i),
    )
}

fn closer(ch: u8) -> Option<u8> {
    match ch {
        b'(' => Some(b')'),
        b'[' => Some(b']'),
        b'{' => Some(b'}'),
        _ => None,
    }
}

fn balanced(text: &str, start: usize) -> Option<usize> {
    let b = text.as_bytes();
    let mut stack = vec![closer(*b.get(start)?)?];
    let mut i = start + 1;
    while let Some(&ch) = b.get(i) {
        if ch == b'\\' {
            i += 2;
            continue;
        }
        if let Some(end) = ignored_end(text, i) {
            i = end;
            continue;
        }
        if let Some(end) = closer(ch) {
            stack.push(end);
        } else if b")]}".contains(&ch) {
            if stack.pop() != Some(ch) {
                return None;
            }
            if stack.is_empty() {
                return Some(i + 1);
            }
        }
        i += 1;
    }
    None
}

fn suffix(text: &str, start: usize) -> Option<usize> {
    if text
        .as_bytes()
        .get(start)
        .copied()
        .and_then(closer)
        .is_some()
    {
        balanced(text, start)
    } else {
        name_end(text, start, true)
    }
}

pub fn typst_regions(text: &str) -> Vec<Region> {
    let mut i = 0;
    let mut start = None;
    let mut regions = Vec::new();
    while let Some(&ch) = text.as_bytes().get(i) {
        if ch == b'\\' {
            i += 2;
            continue;
        }
        if let Some(end) = ignored_end(text, i) {
            i = end;
            continue;
        }
        if ch == b'$' {
            if let Some(n) = start.take() {
                regions.push(Region {
                    kind: Kind::Math(1),
                    content: n..i,
                    closed: true,
                });
            } else {
                start = Some(i + 1);
            }
        }
        i += 1;
    }
    if let Some(n) = start {
        regions.push(Region {
            kind: Kind::Math(1),
            content: n..text.len(),
            closed: false,
        });
    }
    regions
}

impl History {
    pub fn build(text: &str, regions: &[Region]) -> Self {
        let mut index = Self::default();
        for region in regions.iter().filter(|r| matches!(r.kind, Kind::Math(_))) {
            index.scan(&text[region.content.clone()], region.content.start, 0);
        }
        index
    }

    fn add(&mut self, term: &str, last: usize) {
        const STOP: &str = "and because else exists false for forall if iff implies in let not or set show then true where with";
        if !(2..=96).contains(&term.len())
            || STOP
                .split_whitespace()
                .any(|stop| term.eq_ignore_ascii_case(stop))
        {
            return;
        }
        if let Some(usage) = self.terms.get_mut(term) {
            usage.count += 1;
            usage.last = usage.last.max(last);
        } else if self.terms.len() < 2000 {
            self.terms.insert(term.into(), Usage { count: 1, last });
        }
    }

    fn scan(&mut self, text: &str, base: usize, depth: usize) {
        if depth > 32 {
            return;
        }
        let b = text.as_bytes();
        let mut i = 0;
        while let Some(&ch) = b.get(i) {
            if let Some(end) = ignored_end(text, i) {
                i = end;
                continue;
            }
            if ch == b'\\' {
                i += 1;
                if let Some(ch) = text.get(i..).and_then(|s| s.chars().next()) {
                    i += ch.len_utf8();
                }
                continue;
            }
            let Some(mut head) = name_end(text, i, false) else {
                i += 1;
                continue;
            };
            while let Some(end) = match b.get(head) {
                Some(b'.') => name_end(text, head + 1, false),
                Some(b'_' | b'^') => suffix(text, head + 1),
                _ => None,
            } {
                head = end;
            }
            let mut end = head;
            let mut simple = false;
            while b.get(end).copied().and_then(closer).is_some() {
                let Some(next) = balanced(text, end) else {
                    break;
                };
                self.scan(&text[end + 1..next - 1], base + end + 1, depth + 1);
                let group = &text[end..next];
                if group.len() > 50
                    || group
                        .chars()
                        .any(|c| c.is_whitespace() || "=+*/|<>:".contains(c))
                {
                    break;
                }
                if simple {
                    self.add(&text[i..end], base + i);
                }
                simple = true;
                end = next;
                while matches!(b.get(end), Some(b'_' | b'^')) {
                    let Some(next) = suffix(text, end + 1) else {
                        break;
                    };
                    end = next;
                }
            }
            self.add(&text[i..end], base + i);
            if simple && text[i..head].contains(['.', '_', '^']) {
                self.add(&text[i..head], base + i);
            }
            i = end;
        }
    }

    pub fn suggestions(
        &self,
        text: &str,
        regions: &[Region],
        cursor: usize,
        position: Position,
    ) -> Vec<Value> {
        let Some(region) = regions.iter().find(|r| {
            matches!(r.kind, Kind::Math(_)) && cursor >= r.content.start && cursor <= r.content.end
        }) else {
            return Vec::new();
        };
        let source = &text[..region.content.end];
        let mut i = region.content.start;
        while i < cursor {
            if let Some(end) = ignored_end(source, i) {
                if end > cursor
                    || (end == cursor && (end == source.len() || source[i..].starts_with("//")))
                {
                    return Vec::new();
                }
                i = end;
            } else {
                i += if source.as_bytes()[i] == b'\\' { 2 } else { 1 };
            }
        }
        let prefix = text[region.content.start..cursor]
            .rsplit(|c: char| !(unicode_ident::is_xid_continue(c) || "_.^-".contains(c)))
            .next()
            .unwrap_or("");
        if prefix.len() < 2 {
            return Vec::new();
        }
        let Some(start) = position
            .character
            .checked_sub(prefix.encode_utf16().count())
        else {
            return Vec::new();
        };
        let folded = prefix.to_lowercase();
        let mut matches: Vec<_> = self
            .terms
            .iter()
            .filter_map(|(term, usage)| {
                (term != prefix)
                    .then(|| rank(term, prefix, &folded))
                    .flatten()
                    .map(|rank| (rank, usage, term))
            })
            .collect();
        matches.sort_unstable_by(|(a, x, t), (b, y, u)| {
            a.cmp(b)
                .then(y.count.cmp(&x.count))
                .then(y.last.cmp(&x.last))
                .then(t.len().cmp(&u.len()))
                .then(t.encode_utf16().cmp(u.encode_utf16()))
        });
        matches.into_iter().take(40).enumerate().map(|(i,(_,usage,term))| {
            let detail = if usage.count == 1 { "Math history".into() } else { format!("Math history · {} uses",usage.count) };
            json!({"label":term,"kind":6,"filterText":prefix,"sortText":format!("{i:04}"),"detail":detail,
                "insertTextFormat":1,"textEdit":{"range":{"start":{"line":position.line,"character":start},"end":position.json()},"newText":term},
                "data":{"typstPreviewMathHistory":true}})
        }).collect()
    }
}

fn rank(term: &str, query: &str, folded_query: &str) -> Option<u8> {
    if term.starts_with(query) {
        return Some(0);
    }
    let term = term.to_lowercase();
    if term.starts_with(folded_query) {
        return Some(1);
    }
    if term.char_indices().any(|(i, c)| {
        "._()[]{}^-".contains(c) && term[i + c.len_utf8()..].starts_with(folded_query)
    }) {
        return Some(2);
    }
    if folded_query.len() >= 2 && term.contains(folded_query) {
        return Some(3);
    }
    if folded_query.len() < 3 {
        return None;
    }
    let mut cursor = 0;
    for ch in folded_query.chars() {
        cursor += term[cursor..].find(ch)? + ch.len_utf8();
    }
    Some(4)
}

pub fn merge(result: Value, mut items: Vec<Value>) -> Value {
    if items.is_empty() {
        return result;
    }
    let mut list = match result {
        Value::Array(items) => json!({"items":items}),
        Value::Object(_) => result,
        _ => json!({}),
    };
    let seen: HashSet<_> = items
        .iter()
        .filter_map(|i| i["label"].as_str())
        .map(str::to_owned)
        .collect();
    if let Some(upstream) = list["items"].as_array_mut() {
        items.extend(
            std::mem::take(upstream)
                .into_iter()
                .filter(|i| !i["label"].as_str().is_some_and(|s| seen.contains(s))),
        );
    }
    list["items"] = json!(items);
    list["isIncomplete"] = json!(true);
    list
}
