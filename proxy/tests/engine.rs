use serde_json::{json, Value};
use std::time::Duration;
use typst_preview_proxy::{
    document::{
        apply_changes, edit_fraction, markdown_regions, projection, render_markdown, shadow_uri,
    },
    engine::{Engine, EngineOptions},
    protocol::{Action, Endpoint, Mode},
};

const NOW: Duration = Duration::ZERO;
const URI: &str = "file:///tmp/a%20%23%25.md";

fn writes(actions: Vec<Action>, to: Endpoint) -> Vec<Value> {
    actions
        .into_iter()
        .filter_map(|a| match a {
            Action::Write {
                to: endpoint,
                message,
            } if endpoint == to => Some(message),
            _ => None,
        })
        .collect()
}

fn send(engine: &mut Engine, mut msg: Value, to: Endpoint) -> Vec<Value> {
    msg["jsonrpc"] = json!("2.0");
    writes(engine.on_client(msg, NOW).unwrap(), to)
}

fn receive(engine: &mut Engine, mut msg: Value, to: Endpoint) -> Vec<Value> {
    msg["jsonrpc"] = json!("2.0");
    writes(engine.on_tinymist(msg, NOW).unwrap(), to)
}

fn open() -> Value {
    json!({"method":"textDocument/didOpen","params":{"textDocument":{
        "uri":URI,"languageId":"markdown","version":1,"text":"😀 $fr$"
    }}})
}

fn completion() -> Value {
    json!({"id":7,"method":"textDocument/completion","params":{"textDocument":{"uri":URI},"position":{"line":0,"character":6}}})
}

#[test]
fn opposite_direction_ids_and_cancellation_do_not_swallow_requests() {
    let mut engine = Engine::new(EngineOptions {
        mode: Mode::Markdown,
        preview_port: 9000,
    });
    send(&mut engine, open(), Endpoint::Tinymist);
    let mut commands = send(&mut engine, completion(), Endpoint::Tinymist);
    let wire = commands.pop().unwrap()["id"].clone();
    assert_ne!(wire, json!(7));
    let requests = receive(
        &mut engine,
        json!({"id":wire,"method":"workspace/configuration","params":{"items":[{}]}}),
        Endpoint::Client,
    );
    assert_eq!(requests[0]["method"], "workspace/configuration");
    assert_ne!(requests[0]["id"], wire);
    let replies = send(
        &mut engine,
        json!({"id":requests[0]["id"],"result":[{}]}),
        Endpoint::Tinymist,
    );
    assert_eq!(replies[0]["id"], wire);
    assert_eq!(replies[0]["result"][0]["exportPdf"], "never");

    let cancelled = send(
        &mut engine,
        json!({"method":"$/cancelRequest","params":{"id":7}}),
        Endpoint::Client,
    );
    assert_eq!(cancelled, [json!({"jsonrpc":"2.0","id":7,"result":null})]);
    assert!(receive(
        &mut engine,
        json!({"id":wire,"result":[{"label":"frac"}]}),
        Endpoint::Client
    )
    .is_empty());
}

#[test]
fn delayed_completion_does_not_survive_close_and_reopen_with_same_version() {
    let mut engine = Engine::new(EngineOptions {
        mode: Mode::Markdown,
        preview_port: 9000,
    });
    send(&mut engine, open(), Endpoint::Tinymist);
    let mut old = send(&mut engine, completion(), Endpoint::Tinymist);
    let old_id = old.pop().unwrap()["id"].clone();
    let closed = send(
        &mut engine,
        json!({"method":"textDocument/didClose","params":{"textDocument":{"uri":URI}}}),
        Endpoint::Client,
    );
    assert_eq!(
        closed.iter().find(|m| m["id"] == 7).unwrap()["result"],
        Value::Null
    );
    send(&mut engine, open(), Endpoint::Tinymist);
    let mut new = send(&mut engine, completion(), Endpoint::Tinymist);
    let new_id = new.pop().unwrap()["id"].clone();
    assert_ne!(old_id, new_id);
    assert!(receive(
        &mut engine,
        json!({"id":old_id,"result":[{"label":"old"}]}),
        Endpoint::Client
    )
    .is_empty());
    let reply = receive(
        &mut engine,
        json!({"id":new_id,"result":[{"label":"frac"}]}),
        Endpoint::Client,
    );
    assert_eq!(reply[0]["id"], 7);
    assert_eq!(reply[0]["result"]["items"][0]["label"], "frac");
}

#[test]
fn forwarded_requests_time_out_and_preserve_typed_ids() {
    let mut engine = Engine::new(EngineOptions {
        mode: Mode::Typst,
        preview_port: 9000,
    });
    for id in [json!(0), json!("0"), json!("tpp-1"), json!(u64::MAX)] {
        let out = send(
            &mut engine,
            json!({"id":id,"method":"opaque"}),
            Endpoint::Tinymist,
        );
        assert_eq!(out.len(), 1);
    }
    let timed_out = writes(
        engine.on_tick(Duration::from_secs(30)).unwrap(),
        Endpoint::Client,
    );
    assert_eq!(timed_out.len(), 4);
    for id in [json!(0), json!("0"), json!("tpp-1"), json!(u64::MAX)] {
        assert!(timed_out
            .iter()
            .any(|m| m["id"] == id && m["error"]["code"] == -32001));
    }
}

#[test]
fn masks_utf16_columns_and_normalizes_only_rendered_inline_padding() {
    let text = "\u{feff}\n\"\"\"\r\n#set text(size: 13pt)\r\n\"\"\"\r\n😀 $ fr $\n\n```\n$ untouched $\n```\n\n$$ x $$";
    let regions = markdown_regions(text);
    assert_eq!(regions.len(), 3);
    let masked = projection(text, [&regions[1]], true);
    assert_eq!(masked.lines().nth(4), Some("   $ fr $"));
    let output = render_markdown(text, 42, Some("a.zed-math-1.typ"), &regions);
    assert!(output.contains("#set text(size: 13pt)"));
    assert!(output.contains("😀 $fr$"));
    assert!(output.contains("$ untouched $"));
    assert!(output.contains("$$ x $$"));
    assert!(output.contains("version: 42"));
    assert_eq!(
        shadow_uri(URI, ".zed-preview.typ").as_deref(),
        Some("file:///tmp/a%20%23%25.md.zed-preview.typ")
    );
}

#[test]
fn rejects_half_surrogates_and_applies_sequential_edits() {
    let changes = |start, end| json!([{"range":{"start":{"line":0,"character":start},"end":{"line":0,"character":end}},"text":"x"}]);
    assert!(apply_changes("😀$f$\r\n", &changes(1, 2)).is_none());
    assert_eq!(
        apply_changes("😀$f$\r\n", &changes(3, 4)).unwrap(),
        "😀$x$\r\n"
    );
    assert_eq!(edit_fraction("X😀", "X\u{1fa00}"), Some(2.0 / 3.0));
}

#[test]
fn standalone_typst_follows_editor_and_tinymist_source_clicks() {
    use typst_preview_proxy::protocol::SystemEffect;

    let mut engine = Engine::new(EngineOptions {
        mode: Mode::Typst,
        preview_port: 9000,
    });
    send(
        &mut engine,
        json!({"id":1,"method":"initialize","params":{"initializationOptions":{"previewProxy":{"openBrowser":false}}}}),
        Endpoint::Tinymist,
    );
    send(
        &mut engine,
        json!({"method":"textDocument/didOpen","params":{"textDocument":{"uri":"file:///tmp/note.typ","languageId":"typst","version":1,"text":"= Note"}}}),
        Endpoint::Tinymist,
    );
    let now = Duration::from_secs(1);
    assert!(engine.on_tick(now).unwrap().is_empty());
    let cursor = |line| {
        json!({"jsonrpc":"2.0","id":7,"method":"textDocument/documentHighlight","params":{
            "textDocument":{"uri":"file:///tmp/note.typ"},"position":{"line":line,"character":2}
        }})
    };
    let first = writes(
        engine.on_client(cursor(3), now).unwrap(),
        Endpoint::Tinymist,
    );
    assert_eq!(first[0]["params"]["arguments"][1]["event"], "panelScrollTo");
    assert_eq!(
        first[1]["params"]["arguments"][1]["event"],
        "changeCursorPosition"
    );
    let wire = first[2]["id"].clone();
    engine
        .on_tinymist(json!({"jsonrpc":"2.0","id":wire,"result":[]}), now)
        .unwrap();

    let jump = engine
        .on_tinymist(
            json!({"jsonrpc":"2.0","method":"tinymist/preview/scrollSource",
        "params":{"filepath":"/tmp/note.typ","start":[4,2]}}),
            now,
        )
        .unwrap();
    assert!(matches!(
        jump.as_slice(),
        [Action::System(SystemEffect::JumpSource {
            line: 5,
            column: 3,
            ..
        })]
    ));
    let suppressed = writes(
        engine
            .on_client(cursor(4), now + Duration::from_millis(100))
            .unwrap(),
        Endpoint::Tinymist,
    );
    assert_eq!(suppressed.len(), 1);
    assert_eq!(suppressed[0]["method"], "textDocument/documentHighlight");
}
