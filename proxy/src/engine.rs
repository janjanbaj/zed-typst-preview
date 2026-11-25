use std::{collections::HashMap, path::PathBuf, time::Duration};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use url::Url;

use crate::{
    completion, document,
    document::{Kind, LineIndex, Position, Region},
    history,
    protocol::{
        id_value, rpc_id, Action, Endpoint, Message, Mode, ProtocolError, RpcId, SystemEffect,
    },
};

const OPEN: &str = "typst-preview.open";
const TOGGLE: &str = "typst-preview.toggleFollow";
const SYNC: &str = "typst-preview.syncCursor";
const TICK: Duration = Duration::from_millis(200);
const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_PENDING: usize = 128;

pub struct EngineOptions {
    pub mode: Mode,
    pub preview_port: u16,
}

struct Document {
    text: String,
    version: i64,
    generation: u64,
    regions: Vec<Region>,
    history: Option<history::History>,
    refresh: Option<Duration>,
    check: Option<String>,
    projection: Option<(i64, String)>,
}

struct Completion {
    uri: String,
    version: i64,
    generation: u64,
    region: Option<Region>,
    position: Position,
    history: Vec<Value>,
}

enum KindOfRequest {
    Initialize,
    CodeAction,
    Completion(Completion),
    Scroll(u64),
    Control,
    Other,
}

struct Request {
    original: Option<RpcId>,
    kind: KindOfRequest,
    deadline: Duration,
}

struct ServerRequest {
    original: RpcId,
    configuration: bool,
    deadline: Duration,
}

struct Scroll {
    uri: String,
    version: i64,
    token: u64,
    fraction: f64,
    attempts: u8,
    due: Option<Duration>,
}

pub struct Engine {
    markdown: bool,
    port: u16,
    seq: u64,
    encoding_utf16: bool,
    client: HashMap<RpcId, Request>,
    server: HashMap<RpcId, ServerRequest>,
    docs: HashMap<String, Document>,
    check_owners: HashMap<String, String>,
    active: Option<String>,
    scroll: Option<Scroll>,
    open_browser: bool,
    scheduled: Option<Duration>,
    browser_ready: bool,
    follow: bool,
    preview_mode: &'static str,
    suppress: Duration,
    last_cursor: Option<(PathBuf, Position)>,
    last_follow: Option<(PathBuf, usize)>,
}

fn write(to: Endpoint, message: Value) -> Action {
    Action::Write { to, message }
}
fn notice(to: Endpoint, method: &str, params: Value) -> Action {
    write(to, json!({"jsonrpc":"2.0","method":method,"params":params}))
}
fn result(to: Endpoint, id: &RpcId, value: Value) -> Action {
    write(
        to,
        json!({"jsonrpc":"2.0","id":id_value(id),"result":value}),
    )
}
fn error(to: Endpoint, id: Value, code: i32, reason: &'static str) -> Action {
    write(
        to,
        json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":reason}}),
    )
}
fn cancel(to: Endpoint, id: &RpcId) -> Action {
    notice(to, "$/cancelRequest", json!({"id":id_value(id)}))
}
fn action(title: &str, label: &str, command: &str) -> Value {
    json!({"title":title,"kind":"quickfix","command":{"title":label,"command":command}})
}
fn open_doc(uri: &str, version: i64, text: String) -> Action {
    notice(
        Endpoint::Tinymist,
        "textDocument/didOpen",
        json!({"textDocument":{"uri":uri,"languageId":"typst","version":version,"text":text}}),
    )
}
fn change_doc(uri: &str, version: i64, text: String) -> Action {
    notice(
        Endpoint::Tinymist,
        "textDocument/didChange",
        json!({"textDocument":{"uri":uri,"version":version},"contentChanges":[{"text":text}]}),
    )
}
fn close_doc(uri: &str) -> Action {
    notice(
        Endpoint::Tinymist,
        "textDocument/didClose",
        json!({"textDocument":{"uri":uri}}),
    )
}
fn publish(uri: &str, version: i64, diagnostics: Vec<Value>) -> Action {
    notice(
        Endpoint::Client,
        "textDocument/publishDiagnostics",
        json!({"uri":uri,"version":version,"diagnostics":diagnostics}),
    )
}

impl Engine {
    pub fn new(o: EngineOptions) -> Self {
        let markdown = o.mode == Mode::Markdown;
        Self {
            markdown,
            port: o.preview_port,
            seq: 0,
            encoding_utf16: true,
            client: HashMap::new(),
            server: HashMap::new(),
            docs: HashMap::new(),
            check_owners: HashMap::new(),
            active: None,
            scroll: None,
            open_browser: true,
            scheduled: None,
            browser_ready: false,
            follow: !markdown,
            preview_mode: "document",
            suppress: Duration::ZERO,
            last_cursor: None,
            last_follow: None,
        }
    }

    fn sequence(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }
    fn new_id(&mut self) -> RpcId {
        RpcId::Str(format!("tpp-{}", self.sequence()))
    }

    fn configured(&mut self, settings: &mut Value) -> bool {
        if !settings.is_object() && !settings.is_null() {
            return false;
        }
        let mut open = self.open_browser;
        let mut follow = self.follow;
        let mut mode = self.preview_mode;
        for setting in [
            &settings["tinymist"]["previewProxy"],
            &settings["previewProxy"],
        ] {
            let Some(object) = setting.as_object() else {
                if setting.is_null() {
                    continue;
                }
                return false;
            };
            if let Some(v) = object.get("openBrowser") {
                let Some(v) = v.as_bool() else {
                    return false;
                };
                open = v;
            }
            if let Some(v) = object.get("followCursor") {
                let Some(v) = v.as_bool() else {
                    return false;
                };
                follow = v;
            }
            if let Some(v) = object.get("mode") {
                mode = match v.as_str() {
                    Some("slide") => "slide",
                    Some("document") => "document",
                    _ => return false,
                };
            }
        }
        self.open_browser = open;
        self.follow = follow && !self.markdown;
        self.preview_mode = mode;
        let inject = |setting: &mut Value| {
            if !setting.is_object() {
                *setting = json!({});
            }
            setting.as_object_mut().unwrap().remove("previewProxy");
            if self.markdown {
                setting["exportPdf"] = json!("never");
            }
            setting["customizedShowDocument"] = json!(true);
            if !setting["preview"].is_object() {
                setting["preview"] = json!({});
            }
            setting["preview"]["background"] = json!({"enabled":true,"args":[
                format!("--data-plane-host=127.0.0.1:{}",self.port),"--invert-colors=never",
                format!("--preview-mode={}",self.preview_mode)]});
        };
        if let Some(nested) = settings.get_mut("tinymist").filter(|v| v.is_object()) {
            inject(nested);
        }
        inject(settings);
        true
    }

    fn command(
        &mut self,
        out: &mut Vec<Action>,
        name: &str,
        args: Value,
        kind: KindOfRequest,
        now: Duration,
    ) -> bool {
        if self
            .client
            .values()
            .filter(|r| r.original.is_none())
            .count()
            >= MAX_PENDING
        {
            return false;
        }
        let id = self.new_id();
        out.push(write(Endpoint::Tinymist,json!({"jsonrpc":"2.0","id":id_value(&id),"method":"workspace/executeCommand","params":{"command":name,"arguments":args}})));
        self.client.insert(
            id,
            Request {
                original: None,
                kind,
                deadline: now + TIMEOUT,
            },
        );
        true
    }

    fn focus(&mut self, out: &mut Vec<Action>, uri: &str, now: Duration) {
        if self.active.as_deref() == Some(uri) {
            return;
        }
        let Some(path) =
            document::shadow_uri(uri, ".zed-preview.typ").and_then(|u| document::file_path(&u))
        else {
            return;
        };
        if self.command(
            out,
            "tinymist.focusMain",
            json!([path]),
            KindOfRequest::Control,
            now,
        ) {
            self.active = Some(uri.into());
            if self.scroll.as_ref().is_some_and(|s| s.uri != uri) {
                self.scroll = None;
            }
        }
    }

    fn browser(&self) -> Action {
        Action::System(SystemEffect::OpenBrowser {
            url: Url::parse(&format!("http://127.0.0.1:{}", self.port)).unwrap(),
        })
    }

    fn retire_completion(&mut self, uri: &str, out: &mut Vec<Action>) {
        let ids: Vec<_> = self
            .client
            .iter()
            .filter(|(_, r)| matches!(&r.kind,KindOfRequest::Completion(c) if c.uri == uri))
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if let Some(req) = self.client.remove(&id) {
                out.push(cancel(Endpoint::Tinymist, &id));
                if let Some(id) = req.original {
                    out.push(result(Endpoint::Client, &id, Value::Null));
                }
            }
        }
    }

    fn observe(&mut self, msg: &Value, method: &str, now: Duration, out: &mut Vec<Action>) {
        let doc = &msg["params"]["textDocument"];
        let Some(uri) = doc["uri"]
            .as_str()
            .filter(|u| document::file_path(u).is_some())
        else {
            return;
        };
        if method == "textDocument/didClose" {
            self.retire_completion(uri, out);
            if let Some(doc) = self.docs.remove(uri) {
                if let Some(check) = doc.check {
                    self.check_owners.remove(&check);
                    out.push(close_doc(&check));
                }
                if self.markdown {
                    out.push(publish(uri, doc.version, vec![]));
                    if doc.projection.is_some() {
                        if let Some(u) = document::shadow_uri(uri, ".zed-completion.typ") {
                            out.push(close_doc(&u));
                        }
                    }
                    if let Some(u) = document::shadow_uri(uri, ".zed-preview.typ") {
                        out.push(close_doc(&u));
                    }
                }
            }
            if self.active.as_deref() == Some(uri) {
                self.active = None;
                self.scroll = None;
            }
            return;
        }
        let Some(version) = doc["version"].as_i64() else {
            return;
        };
        let opening = method == "textDocument/didOpen";
        let (text, fraction) = if opening {
            let Some(text) = doc["text"].as_str() else {
                return;
            };
            if !self.markdown
                && doc["languageId"] != "typst"
                && !uri.ends_with(".typ")
                && !uri.ends_with(".typst")
            {
                return;
            }
            (text.to_owned(), None)
        } else {
            let Some(previous) = self.docs.get(uri).filter(|d| version > d.version) else {
                return;
            };
            if !self.encoding_utf16 && !self.markdown {
                return;
            }
            let Some(text) =
                document::apply_changes(&previous.text, &msg["params"]["contentChanges"])
            else {
                return;
            };
            let fraction = self
                .markdown
                .then(|| document::edit_fraction(&previous.text, &text))
                .flatten();
            (text, fraction)
        };
        self.retire_completion(uri, out);
        if opening && self.docs.contains_key(uri) {
            self.observe(
                &json!({"params":{"textDocument":{"uri":uri}}}),
                "textDocument/didClose",
                now,
                out,
            );
        }
        let regions = if self.markdown {
            document::markdown_regions(&text)
        } else {
            history::typst_regions(&text)
        };
        let revision = self.sequence();
        let doc = self.docs.entry(uri.into()).or_insert_with(|| Document {
            text: String::new(),
            version,
            generation: revision,
            regions: Vec::new(),
            history: None,
            refresh: None,
            check: None,
            projection: None,
        });
        doc.text = text;
        doc.version = version;
        doc.regions = regions;
        if !opening {
            doc.refresh = Some(now + Duration::from_millis(180));
        }
        if self.markdown {
            let Some(check) = document::shadow_uri(uri, &format!(".zed-math-{revision}.typ"))
            else {
                return;
            };
            let Some(preview) = document::shadow_uri(uri, ".zed-preview.typ") else {
                return;
            };
            let Some(name) = document::file_path(&check)
                .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            else {
                return;
            };
            let math = doc
                .regions
                .iter()
                .filter(|r| matches!(r.kind, Kind::Math(_)));
            out.push(publish(uri, version, vec![]));
            out.push(open_doc(
                &check,
                1,
                document::projection(&doc.text, math, false),
            ));
            let rendered = document::render_markdown(&doc.text, version, Some(&name), &doc.regions);
            let old = doc.check.replace(check.clone());
            self.check_owners.insert(check, uri.into());
            out.push(if opening {
                open_doc(&preview, version, rendered)
            } else {
                change_doc(&preview, version, rendered)
            });
            self.focus(out, uri, now);
            if let Some(old) = old {
                self.check_owners.remove(&old);
                out.push(close_doc(&old));
            }
            if self.active.as_deref() == Some(uri) {
                self.scroll = fraction.map(|fraction| Scroll {
                    uri: uri.into(),
                    version,
                    token: revision,
                    fraction,
                    attempts: 0,
                    due: Some(now + TICK),
                });
            }
        }
        if opening && !self.browser_ready && self.scheduled.is_none() {
            self.scheduled = Some(now + Duration::from_millis(800));
        }
    }

    fn completion(
        &mut self,
        msg: &mut Value,
        now: Duration,
        out: &mut Vec<Action>,
    ) -> Option<Completion> {
        let uri = msg["params"]["textDocument"]["uri"].as_str()?.to_owned();
        let position = Position::parse(&msg["params"]["position"])?;
        if !self.encoding_utf16 && !self.markdown {
            return None;
        }
        let doc = self.docs.get(&uri)?;
        let offset = LineIndex::new(&doc.text).offset(&doc.text, position)?;
        let region = doc
            .regions
            .iter()
            .find(|r| {
                offset >= r.content.start
                    && offset <= r.content.end
                    && !(r.kind == Kind::Header && r.closed && offset == r.content.end)
            })
            .cloned();
        region.as_ref()?;
        self.retire_completion(&uri, out);
        if self.markdown {
            self.focus(out, &uri, now);
        }
        let doc = self.docs.get_mut(&uri)?;
        let index = doc
            .history
            .get_or_insert_with(|| history::History::build(&doc.text, &doc.regions));
        let history = index.suggestions(&doc.text, &doc.regions, offset, position);
        let region = if self.markdown {
            let shadow = document::shadow_uri(&uri, ".zed-completion.typ")?;
            let r = region?;
            let text = document::projection(&doc.text, [&r], true);
            match doc.projection.as_mut() {
                Some((version, previous)) if *previous != text => {
                    *version += 1;
                    out.push(change_doc(&shadow, *version, text.clone()));
                    *previous = text;
                }
                None => {
                    out.push(open_doc(&shadow, 1, text.clone()));
                    doc.projection = Some((1, text));
                }
                _ => {}
            }
            msg["params"]["textDocument"]["uri"] = json!(shadow);
            Some(r)
        } else {
            None
        };
        Some(Completion {
            uri,
            version: doc.version,
            generation: doc.generation,
            region,
            position,
            history,
        })
    }

    fn sync(&mut self, out: &mut Vec<Action>, path: &PathBuf, pos: Position, now: Duration) {
        for event in ["panelScrollTo", "changeCursorPosition"] {
            self.command(out,"tinymist.scrollPreview",json!(["default_preview",{"event":event,"filepath":path,"line":pos.line,"character":pos.character}]),KindOfRequest::Control,now);
        }
    }

    pub fn on_client(
        &mut self,
        mut msg: Message,
        now: Duration,
    ) -> Result<Vec<Action>, ProtocolError> {
        let mut out = Vec::new();
        let id = msg.get("id").and_then(|v| rpc_id(v).ok());
        let Some(method) = msg["method"].as_str().map(str::to_owned) else {
            if let Some(req) = id.as_ref().and_then(|id| self.server.remove(id)) {
                if req.configuration && msg.get("result").is_some() {
                    if !msg["result"].is_array() {
                        msg["result"] = json!([msg["result"].take()]);
                    }
                    if let Some(items) = msg["result"].as_array_mut() {
                        for item in items {
                            if !item.is_object() {
                                *item = json!({});
                            }
                            if !self.configured(item) {
                                *item = json!({});
                                self.configured(item);
                            }
                        }
                    }
                }
                msg["id"] = id_value(&req.original);
                out.push(write(Endpoint::Tinymist, msg));
            }
            return Ok(out);
        };
        if id.as_ref().is_some_and(|id| {
            self.client
                .values()
                .any(|r| r.original.as_ref() == Some(id))
        }) {
            out.push(error(
                Endpoint::Client,
                Value::Null,
                -32600,
                "duplicate in-flight request ID",
            ));
            out.push(Action::Stop { exit_code: 1 });
            return Ok(out);
        }
        if method == "$/cancelRequest" {
            if let Ok(target) = rpc_id(&msg["params"]["id"]) {
                if let Some((wire, _)) = self
                    .client
                    .iter()
                    .find(|(_, r)| r.original.as_ref() == Some(&target))
                {
                    let wire = wire.clone();
                    out.push(cancel(Endpoint::Tinymist, &wire));
                    if matches!(self.client[&wire].kind, KindOfRequest::Completion(_)) {
                        self.client.remove(&wire);
                        out.push(result(Endpoint::Client, &target, Value::Null));
                    }
                }
            }
            return Ok(out);
        }

        let mut kind = KindOfRequest::Other;
        match method.as_str() {
            "initialize" => {
                if !msg["params"].is_object() {
                    msg["params"] = json!({});
                }
                if !self.configured(&mut msg["params"]["initializationOptions"]) {
                    if let Some(id) = &id {
                        out.push(error(
                            Endpoint::Client,
                            id_value(id),
                            -32602,
                            "invalid preview settings",
                        ));
                    }
                    return Ok(out);
                }
                if self.markdown {
                    if !msg["params"]["capabilities"].is_object() {
                        msg["params"]["capabilities"] = json!({});
                    }
                    if !msg["params"]["capabilities"]["general"].is_object() {
                        msg["params"]["capabilities"]["general"] = json!({});
                    }
                    msg["params"]["capabilities"]["general"]["positionEncodings"] =
                        json!(["utf-16"]);
                }
                kind = KindOfRequest::Initialize;
            }
            "workspace/didChangeConfiguration" => {
                if !msg["params"].is_object() {
                    msg["params"] = json!({});
                }
                if !self.configured(&mut msg["params"]["settings"]) {
                    return Ok(out);
                }
            }
            "textDocument/didOpen" | "textDocument/didChange" | "textDocument/didClose" => {
                if id.is_none() {
                    self.observe(&msg, &method, now, &mut out);
                }
                if self.markdown {
                    return Ok(out);
                }
            }
            "textDocument/completion" if id.is_some() => {
                if let Some(context) = self.completion(&mut msg, now, &mut out) {
                    kind = KindOfRequest::Completion(context);
                } else if self.markdown {
                    out.push(result(Endpoint::Client, id.as_ref().unwrap(), Value::Null));
                    return Ok(out);
                }
            }
            "completionItem/resolve" => {
                if msg["params"]["data"]["typstPreviewMathHistory"] == true || self.markdown {
                    if let Some(id) = &id {
                        out.push(result(Endpoint::Client, id, msg["params"].take()));
                    }
                    return Ok(out);
                }
            }
            "textDocument/documentHighlight" | "textDocument/codeAction" => {
                if self.markdown {
                    if let Some(uri) = msg["params"]["textDocument"]["uri"]
                        .as_str()
                        .filter(|u| self.docs.contains_key(*u))
                    {
                        self.focus(&mut out, uri, now);
                    }
                    if let Some(id) = &id {
                        let response = if method.ends_with("codeAction") {
                            json!([action(
                                "Markdown Typst Preview: Open in Browser",
                                "Open in Browser",
                                OPEN
                            )])
                        } else {
                            json!([])
                        };
                        out.push(result(Endpoint::Client, id, response));
                    }
                    return Ok(out);
                }
                if method.ends_with("codeAction") {
                    kind = KindOfRequest::CodeAction;
                } else if let (Some(path), Some(pos)) = (
                    msg["params"]["textDocument"]["uri"]
                        .as_str()
                        .and_then(document::file_path),
                    Position::parse(&msg["params"]["position"]),
                ) {
                    self.last_cursor = Some((path.clone(), pos));
                    if self.browser_ready
                        && self.follow
                        && now >= self.suppress
                        && self.last_follow.as_ref() != Some(&(path.clone(), pos.line))
                    {
                        self.sync(&mut out, &path, pos, now);
                        self.last_follow = Some((path, pos.line));
                    }
                }
            }
            "workspace/executeCommand" => {
                match msg["params"]["command"].as_str() {
                    Some(OPEN) => out.push(self.browser()),
                    Some(TOGGLE) if !self.markdown => self.follow = !self.follow,
                    Some(SYNC) if !self.markdown => {
                        if let Some((path, pos)) = self.last_cursor.clone() {
                            self.sync(&mut out, &path, pos, now);
                        }
                    }
                    _ if !self.markdown => return Ok(self.forward_client(msg, id, kind, now, out)),
                    _ => {}
                }
                if let Some(id) = &id {
                    out.push(result(Endpoint::Client, id, Value::Null));
                }
                return Ok(out);
            }
            _ if self.markdown && method.starts_with("textDocument/") => {
                if let Some(id) = &id {
                    out.push(result(Endpoint::Client, id, Value::Null));
                }
                return Ok(out);
            }
            _ => {}
        }
        let exiting = method == "exit" && id.is_none();
        let mut out = self.forward_client(msg, id, kind, now, out);
        if exiting {
            out.push(Action::Stop { exit_code: 0 });
        }
        Ok(out)
    }

    fn forward_client(
        &mut self,
        mut msg: Value,
        id: Option<RpcId>,
        kind: KindOfRequest,
        now: Duration,
        mut out: Vec<Action>,
    ) -> Vec<Action> {
        if let Some(id) = id {
            if self
                .client
                .values()
                .filter(|r| r.original.is_some())
                .count()
                >= MAX_PENDING
            {
                out.push(error(
                    Endpoint::Client,
                    id_value(&id),
                    -32001,
                    "too many outstanding requests",
                ));
                return out;
            }
            let wire = self.new_id();
            msg["id"] = id_value(&wire);
            self.client.insert(
                wire,
                Request {
                    original: Some(id),
                    kind,
                    deadline: now + TIMEOUT,
                },
            );
        }
        out.push(write(Endpoint::Tinymist, msg));
        out
    }

    pub fn on_tinymist(
        &mut self,
        mut msg: Message,
        now: Duration,
    ) -> Result<Vec<Action>, ProtocolError> {
        let mut out = Vec::new();
        let id = msg.get("id").and_then(|v| rpc_id(v).ok());
        let Some(method) = msg["method"].as_str() else {
            let Some(req) = id.as_ref().and_then(|id| self.client.remove(id)) else {
                return Ok(out);
            };
            if let KindOfRequest::Scroll(token) = req.kind {
                self.scroll_reply(&mut out, token, &msg["result"], now);
                return Ok(out);
            }
            let Some(original) = req.original else {
                return Ok(out);
            };
            match req.kind {
                KindOfRequest::Initialize if msg["result"].is_object() => {
                    let caps = &mut msg["result"]["capabilities"];
                    if !caps.is_object() {
                        *caps = json!({});
                    }
                    self.encoding_utf16 = caps["positionEncoding"]
                        .as_str()
                        .is_none_or(|s| s == "utf-16");
                    if self.markdown {
                        let mut provider = caps
                            .get("completionProvider")
                            .filter(|v| v.is_object())
                            .cloned()
                            .unwrap_or_else(
                                || json!({"triggerCharacters":["#",".","(",",",":","\"","/"]}),
                            );
                        append(&mut provider["triggerCharacters"], "$");
                        provider["resolveProvider"] = json!(false);
                        *caps = json!({"positionEncoding":"utf-16","textDocumentSync":{"openClose":true,"change":1},
                            "codeActionProvider":true,"documentHighlightProvider":true,"completionProvider":provider,
                            "executeCommandProvider":{"commands":[OPEN]}});
                    } else {
                        if !caps["executeCommandProvider"].is_object() {
                            caps["executeCommandProvider"] = json!({});
                        }
                        for command in [OPEN, TOGGLE, SYNC] {
                            append(&mut caps["executeCommandProvider"]["commands"], command);
                        }
                    }
                }
                KindOfRequest::CodeAction if msg.get("error").is_none() => {
                    if !msg["result"].is_array() {
                        msg["result"] = json!([]);
                    }
                    let label = if self.follow { "Enabled" } else { "Disabled" };
                    msg["result"].as_array_mut().unwrap().extend([
                        action("Typst Preview: Open in Browser", "Open in Browser", OPEN),
                        action(
                            &format!("Typst Preview: Toggle Cursor Follow ({label})"),
                            "Toggle Follow",
                            TOGGLE,
                        ),
                        action("Typst Preview: Sync Cursor to Preview", "Sync Cursor", SYNC),
                    ]);
                }
                KindOfRequest::Completion(c) => {
                    let current = self
                        .docs
                        .get(&c.uri)
                        .filter(|d| d.generation == c.generation && d.version == c.version);
                    let response = if let Some(doc) = current {
                        if let Some(region) = c.region {
                            if msg.get("error").is_some() && c.history.is_empty() {
                                Value::Null
                            } else {
                                let items = completion::sanitize(
                                    &msg["result"],
                                    &doc.text,
                                    &region,
                                    c.position,
                                );
                                history::merge(items, c.history)
                            }
                        } else if c.history.is_empty() {
                            msg["id"] = id_value(&original);
                            return Ok(vec![write(Endpoint::Client, msg)]);
                        } else {
                            history::merge(msg["result"].take(), c.history)
                        }
                    } else {
                        Value::Null
                    };
                    return Ok(vec![result(Endpoint::Client, &original, response)]);
                }
                _ => {}
            }
            msg["id"] = id_value(&original);
            return Ok(vec![write(Endpoint::Client, msg)]);
        };
        let method = method.to_owned();
        if method == "$/cancelRequest" {
            if let Ok(target) = rpc_id(&msg["params"]["id"]) {
                if let Some((wire, _)) = self.server.iter().find(|(_, r)| r.original == target) {
                    out.push(cancel(Endpoint::Client, wire));
                }
            }
            return Ok(out);
        }
        if self.markdown {
            let response = match method.as_str() {
                "textDocument/publishDiagnostics" => {
                    if let Some(uri) = msg["params"]["uri"]
                        .as_str()
                        .and_then(|check| self.check_owners.get(check))
                    {
                        if let Some(doc) = self.docs.get(uri) {
                            out.push(publish(
                                uri,
                                doc.version,
                                completion::diagnostics(
                                    &msg["params"]["diagnostics"],
                                    &doc.text,
                                    &doc.regions,
                                ),
                            ));
                        }
                    }
                    return Ok(out);
                }
                "tinymist/compileStatus" | "tinymist/preview/scrollSource" => return Ok(out),
                "window/showDocument" => Some(json!({"success":false})),
                "workspace/applyEdit" => Some(json!({"applied":false})),
                "client/registerCapability" | "client/unregisterCapability" => Some(Value::Null),
                _ => None,
            };
            if let Some(response) = response {
                if let Some(id) = id {
                    out.push(result(Endpoint::Tinymist, &id, response));
                }
                return Ok(out);
            }
        } else {
            if method == "tinymist/preview/scrollSource" {
                if let Some(path) = msg["params"]["filepath"].as_str().filter(|s| !s.is_empty()) {
                    self.jump(
                        &mut out,
                        PathBuf::from(path),
                        &msg["params"]["start"][0],
                        &msg["params"]["start"][1],
                        now,
                    );
                }
                return Ok(out);
            }
            if method == "window/showDocument" {
                if let Some(path) = msg["params"]["uri"].as_str().and_then(document::file_path) {
                    let pos = &msg["params"]["selection"]["start"];
                    self.jump(&mut out, path, &pos["line"], &pos["character"], now);
                    if let Some(id) = id {
                        out.push(result(Endpoint::Tinymist, &id, json!({"success":true})));
                    }
                    return Ok(out);
                }
            }
        }
        if let Some(id) = id {
            if self.server.values().any(|r| r.original == id) {
                return Ok(vec![Action::Stop { exit_code: 1 }]);
            }
            if self.server.len() >= MAX_PENDING {
                return Ok(vec![error(
                    Endpoint::Tinymist,
                    id_value(&id),
                    -32001,
                    "too many outstanding requests",
                )]);
            }
            let wire = self.new_id();
            msg["id"] = id_value(&wire);
            self.server.insert(
                wire,
                ServerRequest {
                    original: id,
                    configuration: method == "workspace/configuration",
                    deadline: now + TIMEOUT,
                },
            );
        }
        out.push(write(Endpoint::Client, msg));
        Ok(out)
    }

    fn jump(
        &mut self,
        out: &mut Vec<Action>,
        path: PathBuf,
        line: &Value,
        column: &Value,
        now: Duration,
    ) {
        let one_based = |v: &Value| {
            v.as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .unwrap_or(0)
                .saturating_add(1)
        };
        self.suppress = now + Duration::from_millis(350);
        out.push(Action::System(SystemEffect::JumpSource {
            path,
            line: one_based(line),
            column: one_based(column),
        }));
    }

    fn scroll_reply(&mut self, out: &mut Vec<Action>, token: u64, value: &Value, now: Duration) {
        let Some(target) = self.scroll.as_mut().filter(|s| s.token == token) else {
            return;
        };
        let position = value["data"]
            .as_str()
            .and_then(|s| STANDARD.decode(s).ok())
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
        let position = position.as_ref().and_then(|p| p.get(0));
        let valid = position.and_then(|p| {
            (p["version"].as_i64() == Some(target.version)).then_some(())?;
            Some((
                p["page"].as_u64().filter(|p| *p > 0)?,
                p["y"].as_f64().filter(|p| p.is_finite())?,
            ))
        });
        if let Some((page, y)) = valid {
            let y = 24.0 + target.fraction * (y - 24.0).max(0.0);
            self.scroll = None;
            self.command(out,"tinymist.scrollPreview",json!(["default_preview",{"event":"panelScrollByPosition","position":{"page_no":page,"x":0,"y":y}}]),KindOfRequest::Control,now);
        } else if target.attempts < 4 {
            target.due = Some(now + TICK);
        } else {
            self.scroll = None;
        }
    }

    pub fn on_tick(&mut self, now: Duration) -> Result<Vec<Action>, ProtocolError> {
        let mut out = Vec::new();
        if self.scheduled.is_some_and(|due| due <= now) {
            self.scheduled = None;
            self.browser_ready = true;
            if self.open_browser {
                out.push(self.browser());
            }
        }
        for doc in self.docs.values_mut() {
            if doc.refresh.is_some_and(|due| due <= now) {
                if doc.history.is_some() {
                    doc.history = Some(history::History::build(&doc.text, &doc.regions));
                }
                doc.refresh = None;
            }
        }
        let active_scroll = self.scroll.as_ref().map(|s| s.token);
        let mut timed_out_scroll = None;
        self.client.retain(|wire, req| {
            if req.deadline > now {
                return true;
            }
            if let Some(id) = &req.original {
                out.push(cancel(Endpoint::Tinymist, wire));
                if matches!(req.kind, KindOfRequest::Completion(_)) {
                    out.push(result(Endpoint::Client, id, Value::Null));
                } else {
                    out.push(error(
                        Endpoint::Client,
                        id_value(id),
                        -32001,
                        "Tinymist request timed out",
                    ));
                }
            } else if let KindOfRequest::Scroll(token) = req.kind {
                if Some(token) == active_scroll {
                    timed_out_scroll = Some(token);
                }
            }
            false
        });
        if let Some(token) = timed_out_scroll {
            self.scroll_reply(&mut out, token, &Value::Null, now);
        }
        self.server.retain(|wire, req| {
            if req.deadline > now {
                return true;
            }
            out.push(cancel(Endpoint::Client, wire));
            out.push(error(
                Endpoint::Tinymist,
                id_value(&req.original),
                -32001,
                "editor request timed out",
            ));
            false
        });
        if let Some(target) = self
            .scroll
            .as_mut()
            .filter(|t| t.due.is_some_and(|due| due <= now))
        {
            let token = target.token;
            let path = document::shadow_uri(&target.uri, ".zed-preview.typ")
                .and_then(|u| document::file_path(&u));
            target.attempts += 1;
            target.due = None;
            if let Some(path) = path {
                if !self.command(&mut out,"tinymist.exportQuery",json!([path,{"selector":"<zed-preview-bottom>","field":"value","format":"json"},{"write":false}]),KindOfRequest::Scroll(token),now) {
                    self.scroll_reply(&mut out,token,&Value::Null,now);
                }
            } else {
                self.scroll = None;
            }
        }
        Ok(out)
    }

    pub fn next_deadline(&self) -> Option<Duration> {
        self.scheduled
            .into_iter()
            .chain(self.scroll.as_ref().and_then(|s| s.due))
            .chain(self.client.values().map(|r| r.deadline))
            .chain(self.server.values().map(|r| r.deadline))
            .chain(self.docs.values().filter_map(|d| d.refresh))
            .min()
    }
}

fn append(array: &mut Value, text: &str) {
    if !array.is_array() {
        *array = json!([]);
    }
    let array = array.as_array_mut().unwrap();
    if !array.iter().any(|v| v == text) {
        array.push(json!(text));
    }
}
