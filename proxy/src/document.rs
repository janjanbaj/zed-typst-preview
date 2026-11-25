use serde_json::{json, Value};
use std::{fmt::Write, ops::Range, path::PathBuf};
use url::Url;

#[derive(Clone, Copy)]
pub struct Position {
    pub line: usize,
    pub character: usize,
}

impl Position {
    pub fn parse(value: &Value) -> Option<Self> {
        Some(Self {
            line: value["line"].as_u64()?.try_into().ok()?,
            character: value["character"].as_u64()?.try_into().ok()?,
        })
    }

    pub fn json(self) -> Value {
        json!({"line": self.line, "character": self.character})
    }
}

pub struct LineIndex(Vec<usize>);

impl LineIndex {
    pub fn new(text: &str) -> Self {
        Self(
            std::iter::once(0)
                .chain(text.match_indices('\n').map(|(i, _)| i + 1))
                .collect(),
        )
    }

    pub fn offset(&self, text: &str, pos: Position) -> Option<usize> {
        let start = *self.0.get(pos.line)?;
        let end = self.0.get(pos.line + 1).map_or(text.len(), |end| end - 1);
        let line = &text[start..end];
        let line = line.strip_suffix('\r').unwrap_or(line);
        let mut width = 0;
        for (i, ch) in line.char_indices() {
            if width == pos.character {
                return Some(start + i);
            }
            width += ch.len_utf16();
            if width > pos.character {
                return None;
            }
        }
        (width == pos.character).then_some(start + line.len())
    }

    pub fn position(&self, text: &str, offset: usize) -> Position {
        let line = self.0.partition_point(|&start| start <= offset) - 1;
        let prefix = &text[self.0[line]..offset];
        Position {
            line,
            character: prefix
                .strip_suffix('\r')
                .unwrap_or(prefix)
                .encode_utf16()
                .count(),
        }
    }

    pub fn range(&self, text: &str, value: &Value) -> Option<Range<usize>> {
        let start = self.offset(text, Position::parse(&value["start"])?)?;
        let end = self.offset(text, Position::parse(&value["end"])?)?;
        (start <= end).then_some(start..end)
    }
}

pub fn apply_changes(text: &str, changes: &Value) -> Option<String> {
    let mut updated = text.to_owned();
    for change in changes.as_array()? {
        let replacement = change["text"].as_str()?;
        if let Some(range) = change.get("range") {
            let range = LineIndex::new(&updated).range(&updated, range)?;
            updated.replace_range(range, replacement);
        } else {
            updated.clear();
            updated.push_str(replacement);
        }
    }
    Some(updated)
}

pub fn shadow_uri(uri: &str, suffix: &str) -> Option<String> {
    let mut url = Url::parse(uri).ok()?;
    if url.scheme() != "file" {
        return None;
    }
    url.set_path(&format!("{}{suffix}", url.path()));
    Some(url.into())
}

pub fn file_path(uri: &str) -> Option<PathBuf> {
    Url::parse(uri).ok()?.to_file_path().ok()
}

pub fn edit_fraction(before: &str, after: &str) -> Option<f64> {
    if before == after {
        return None;
    }
    let width = after.encode_utf16().count();
    let mut suffix = 0;
    for (a, b) in before.chars().rev().zip(after.chars().rev()) {
        if a == b {
            suffix += b.len_utf16();
        } else {
            // Two different astral scalars can share the same low surrogate.
            if a.len_utf16() == 2 && b.len_utf16() == 2 && (a as u32 & 1023) == (b as u32 & 1023) {
                suffix += 1;
            }
            break;
        }
    }
    Some(if width == 0 {
        0.0
    } else {
        (width - suffix) as f64 / width as f64
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Kind {
    Header,
    Math(usize),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Region {
    pub kind: Kind,
    pub content: Range<usize>,
    pub closed: bool,
}

fn header(text: &str) -> Option<(Region, usize)> {
    let mut offset = usize::from(text.starts_with('\u{feff}')) * '\u{feff}'.len_utf8();
    for line in text[offset..].split_inclusive('\n') {
        offset += line.len();
        let trimmed = line.trim_end_matches(['\n', '\r', ' ', '\t']);
        if trimmed.is_empty() && line.ends_with('\n') {
            continue;
        }
        if trimmed != "\"\"\"" || !line.ends_with('\n') {
            return None;
        }
        let body = offset;
        for line in text[body..].split_inclusive('\n') {
            let start = offset;
            offset += line.len();
            if line.trim_end_matches(['\n', '\r', ' ', '\t']) == "\"\"\"" {
                return Some((
                    Region {
                        kind: Kind::Header,
                        content: body..start,
                        closed: true,
                    },
                    offset,
                ));
            }
        }
        return Some((
            Region {
                kind: Kind::Header,
                content: body..text.len(),
                closed: false,
            },
            text.len(),
        ));
    }
    None
}

fn fence(line: &str) -> Option<(u8, usize, &str)> {
    let mut b = line.as_bytes();
    for _ in 0..3 {
        if !matches!(b.first(), Some(b' ' | b'\t')) {
            break;
        }
        b = &b[1..];
    }
    while b.first() == Some(&b'>') {
        b = &b[1..];
        b = &b[b.iter().take_while(|&&c| c == b' ' || c == b'\t').count()..];
    }
    let digits = b.iter().take_while(|c| c.is_ascii_digit()).count();
    let marker = if matches!(b.first(), Some(b'-' | b'+' | b'*')) {
        1
    } else if digits > 0 && matches!(b.get(digits), Some(b'.' | b')')) {
        digits + 1
    } else {
        0
    };
    if marker > 0 && matches!(b.get(marker), Some(b' ' | b'\t')) {
        b = &b[marker..];
        b = &b[b.iter().take_while(|&&c| c == b' ' || c == b'\t').count()..];
    }
    let ch = *b.first()?;
    let length = b.iter().take_while(|&&c| c == ch).count();
    (matches!(ch, b'`' | b'~') && length >= 3)
        .then(|| (ch, length, &line[line.len() - b.len() + length..]))
}

pub fn markdown_regions(text: &str) -> Vec<Region> {
    let mut regions = Vec::new();
    let mut i = 0;
    if let Some((region, body)) = header(text) {
        regions.push(region);
        i = body;
    }
    let bytes = text.as_bytes();
    let mut active_fence = None;
    let mut ticks = 0;
    let mut math: Option<(usize, usize)> = None;
    let mut quoted = false;
    while i < bytes.len() {
        if math.is_none() && ticks == 0 && (i == 0 || bytes[i - 1] == b'\n') {
            let end = text[i..].find('\n').map_or(text.len(), |n| i + n);
            let line = &text[i..end];
            let marker = fence(line);
            if let Some((ch, length)) = active_fence {
                if marker
                    .is_some_and(|(c, n, rest)| c == ch && n >= length && rest.trim().is_empty())
                {
                    active_fence = None;
                }
                i = (end + 1).min(bytes.len());
                continue;
            }
            if let Some((ch, length, _)) = marker {
                active_fence = Some((ch, length));
            }
            if marker.is_some() || line.starts_with("    ") || line.starts_with('\t') {
                i = (end + 1).min(bytes.len());
                continue;
            }
        }
        let ch = bytes[i];
        if ch == b'\\' && ticks == 0 {
            i += 1;
            if i < bytes.len() {
                i += text[i..].chars().next().unwrap().len_utf8();
            }
            continue;
        }
        if let Some((start, width)) = math {
            let closed = !quoted
                && ch == b'$'
                && if width == 2 {
                    bytes.get(i + 1) == Some(&b'$')
                } else {
                    !bytes.get(i + 1).is_some_and(u8::is_ascii_digit)
                };
            if closed || (width == 1 && ch == b'\n') {
                regions.push(Region {
                    kind: Kind::Math(width),
                    content: start..i,
                    closed,
                });
                math = None;
                i += if closed { width } else { 1 };
                continue;
            }
            if ch == b'"' {
                quoted = !quoted;
            }
        } else if ch == b'`' {
            let len = bytes[i..].iter().take_while(|&&c| c == b'`').count();
            if ticks == 0 {
                ticks = len;
            } else if ticks == len {
                ticks = 0;
            }
            i += len;
            continue;
        } else if ticks == 0 && ch == b'$' {
            let width = if bytes.get(i + 1) == Some(&b'$') {
                2
            } else {
                1
            };
            if width == 1 && bytes.get(i + 1).is_some_and(u8::is_ascii_digit) {
                let rest = text[i + 1..].split('\n').next().unwrap_or("").as_bytes();
                let math_operator = rest.iter().any(|c| b"-+*/^_=()[]{}".contains(c));
                let closer = rest.iter().enumerate().any(|(j, &c)| {
                    c == b'$'
                        && (j == 0 || rest[j - 1] != b'\\')
                        && !rest.get(j + 1).is_some_and(u8::is_ascii_digit)
                });
                if !math_operator && !closer {
                    i += 1;
                    continue;
                }
            }
            math = Some((i + width, width));
            quoted = false;
            i += width;
            continue;
        }
        i += 1;
    }
    if let Some((start, width)) = math {
        regions.push(Region {
            kind: Kind::Math(width),
            content: start..text.len(),
            closed: false,
        });
    }
    regions
}

fn mask(output: &mut String, text: &str) {
    for ch in text.chars() {
        if ch == '\r' || ch == '\n' {
            output.push(ch);
        } else {
            output.push(' ');
            if ch.len_utf16() == 2 {
                output.push(' ');
            }
        }
    }
}

pub fn projection<'a>(
    text: &str,
    regions: impl IntoIterator<Item = &'a Region>,
    close: bool,
) -> String {
    let mut pos = 0;
    let mut out = String::with_capacity(text.len());
    let mut incomplete = false;
    for region in regions {
        let start = region.content.start;
        let end = region.content.end;
        match region.kind {
            Kind::Header => {
                mask(&mut out, &text[pos..start]);
                out.push_str(&text[start..end]);
                pos = end;
            }
            Kind::Math(width) => {
                mask(&mut out, &text[pos..start - width]);
                out.push('$');
                if width == 2 {
                    out.push(' ');
                }
                out.push_str(&text[start..end]);
                pos = end;
                if region.closed {
                    if width == 2 {
                        out.push(' ');
                    }
                    out.push('$');
                    pos += width;
                } else {
                    incomplete = true;
                }
            }
        }
    }
    mask(&mut out, &text[pos..]);
    if close && incomplete {
        out.push_str("\n$");
    }
    out
}

pub fn typst_string(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len() + 2);
    escaped.push('"');
    for ch in text.chars() {
        match ch {
            '"' | '\\' => {
                escaped.push('\\');
                escaped.push(ch);
            }
            '\0'..='\u{1f}' => {
                let _ = write!(escaped, "\\u{{{:x}}}", ch as u32);
            }
            _ => escaped.push(ch),
        }
    }
    escaped.push('"');
    escaped
}

pub fn render_markdown(
    text: &str,
    version: i64,
    check_file: Option<&str>,
    regions: &[Region],
) -> String {
    let (preamble, body) = match header(text) {
        Some((r, body)) if r.closed => (&text[r.content], body),
        _ => ("", 0),
    };
    let mut pos = body;
    let mut markdown = String::new();
    for r in regions
        .iter()
        .filter(|r| r.closed && r.kind == Kind::Math(1))
    {
        let source = &text[r.content.clone()];
        let trimmed = source.trim();
        if !trimmed.is_empty() && trimmed != source {
            markdown.push_str(&text[pos..r.content.start]);
            markdown.push_str(trimmed);
            pos = r.content.end;
        }
    }
    markdown.push_str(&text[pos..]);
    let include = check_file
        .map(|name| format!("#let _zed_math_check = include {}", typst_string(name)))
        .unwrap_or_default();
    format!(
        r#"#import "@preview/cmarker:0.1.8"
#set page(margin: 24pt, height: auto)
{include}
{preamble}
#cmarker.render(
  {},
  raw-typst: false,
  math: (source, block: false) => math.equation(block: block, eval(source, mode: "math")),
  scope: (image: (source, ..args) => image(source, ..args)),
)
#context {{
  let pos = here().position()
  [#metadata((version: {version}, page: pos.page, x: 0, y: pos.y.pt())) <zed-preview-bottom>]
}}
"#,
        typst_string(&markdown)
    )
}
