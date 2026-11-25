use crate::document::{Kind, LineIndex, Position, Region};
use serde_json::{json, Value};

pub fn ignored_end(text: &str, i: usize) -> Option<usize> {
    let b = text.as_bytes();
    match b.get(i)? {
        b'"' => {
            let mut j = i + 1;
            while j < b.len() {
                match b[j] {
                    b'\\' => j += 2,
                    b'"' => return Some(j + 1),
                    _ => j += 1,
                }
            }
            Some(b.len())
        }
        b'/' if b.get(i + 1) == Some(&b'/') => {
            Some(text[i..].find('\n').map_or(b.len(), |n| i + n))
        }
        b'/' if b.get(i + 1) == Some(&b'*') => {
            let mut depth = 1;
            let mut j = i + 2;
            while j < b.len() && depth != 0 {
                match b.get(j..j + 2) {
                    Some(b"/*") => {
                        depth += 1;
                        j += 2;
                    }
                    Some(b"*/") => {
                        depth -= 1;
                        j += 2;
                    }
                    _ => j += 1,
                }
            }
            Some(j)
        }
        b'`' => {
            let n = b[i..].iter().take_while(|&&c| c == b'`').count();
            Some(
                text[i + n..]
                    .find(&text[i..i + n])
                    .map_or(b.len(), |j| i + 2 * n + j),
            )
        }
        _ => None,
    }
}

fn string_range(text: &str, region: &Region, cursor: usize, index: &LineIndex) -> Option<Value> {
    if region.kind != Kind::Header {
        return None;
    }
    let source = &text[..region.content.end];
    let mut i = region.content.start;
    while i < cursor {
        if let Some(end) = ignored_end(source, i) {
            if source.as_bytes()[i] == b'"'
                && (end > cursor
                    || (end == cursor && source.as_bytes().get(end - 1) != Some(&b'"')))
            {
                let line_end = source[cursor..]
                    .find(['\r', '\n'])
                    .map_or(source.len(), |n| cursor + n);
                let stop = if end <= line_end && source.as_bytes().get(end - 1) == Some(&b'"') {
                    end
                } else {
                    cursor
                };
                return Some(
                    json!({"start":index.position(text,i).json(),"end":index.position(text,stop).json()}),
                );
            }
            i = end;
        } else {
            i += 1;
        }
    }
    None
}

pub fn sanitize(result: &Value, text: &str, region: &Region, cursor: Position) -> Value {
    let index = LineIndex::new(text);
    let quoted = index
        .offset(text, cursor)
        .and_then(|at| string_range(text, region, at, &index));
    let within = |range: &Value| {
        index
            .range(text, range)
            .is_some_and(|r| r.start >= region.content.start && r.end <= region.content.end)
    };
    let defaults = &result["itemDefaults"];
    let items: Vec<_> = result
        .as_array()
        .or_else(|| result["items"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let mut item = item.as_object()?.clone();
            if let (Some(range), Some(label)) = (&quoted, item.get("label").and_then(Value::as_str))
            {
                if label.starts_with('"')
                    && ignored_end(label, 0) == Some(label.len())
                    && label.ends_with('"')
                    && label.len() > 1
                {
                    item.insert("textEdit".into(), json!({"range":range,"newText":label}));
                    item.insert("insertTextFormat".into(), json!(1));
                }
            }
            if !item.contains_key("textEdit") {
                if let Some(range) = defaults.get("editRange") {
                    let new = item
                        .get("textEditText")
                        .or_else(|| item.get("insertText"))
                        .or_else(|| item.get("label"))?;
                    let edit = if range.get("insert").is_some() {
                        json!({"insert":range["insert"],"replace":range["replace"],"newText":new})
                    } else {
                        json!({"range":range,"newText":new})
                    };
                    item.insert("textEdit".into(), edit);
                }
            }
            if let Some(edit) = item.get("textEdit") {
                let valid = if let Some(range) = edit.get("range") {
                    within(range)
                } else {
                    within(&edit["insert"]) && within(&edit["replace"])
                };
                if !valid || !edit["newText"].is_string() {
                    return None;
                }
            }
            if let Some(edits) = item.get("additionalTextEdits") {
                if !edits
                    .as_array()?
                    .iter()
                    .all(|e| within(&e["range"]) && e["newText"].is_string())
                {
                    return None;
                }
            }
            for key in ["insertTextFormat", "insertTextMode", "commitCharacters"] {
                if let Some(value) = defaults.get(key) {
                    item.entry(key).or_insert_with(|| value.clone());
                }
            }
            item.remove("command");
            item.remove("data");
            Some(Value::Object(item))
        })
        .collect();
    json!({"isIncomplete":result["isIncomplete"].as_bool().unwrap_or(false),"items":items})
}

pub fn diagnostics(value: &Value, text: &str, regions: &[Region]) -> Vec<Value> {
    let index = LineIndex::new(text);
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let r = index.range(text, &item["range"])?;
            let region = regions
                .iter()
                .filter(|r| matches!(r.kind, Kind::Math(_)))
                .find(|m| r.start <= m.content.end && r.end >= m.content.start)
                .or_else(|| {
                    regions.iter().rev().find(|m| {
                        matches!(m.kind, Kind::Math(_)) && !m.closed && r.start >= m.content.end
                    })
                })?;
            let map = |n: usize| {
                index
                    .position(text, n.clamp(region.content.start, region.content.end))
                    .json()
            };
            let mut copy = item.as_object()?.clone();
            copy.remove("data");
            copy.remove("relatedInformation");
            copy.insert("source".into(), json!("Typst math"));
            copy.insert(
                "range".into(),
                json!({"start":map(r.start),"end":map(r.end)}),
            );
            Some(json!(copy))
        })
        .collect()
}
