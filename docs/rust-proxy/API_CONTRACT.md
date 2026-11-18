# Rust proxy API and wire contract

These are **proposed interfaces to implement**, not APIs already present in the repository. Keep signatures stable across agent tasks; coordinate changes with the architect. Private helpers may differ. Baseline: `0a366d8`.

## A. Executables and endpoints

### Native CLI

```text
typst-preview-proxy --tinymist <executable> [--markdown] [-- <tinymist arguments>...]
typst-preview-proxy --help
typst-preview-proxy --version
```

- Call `parse_args(std::env::args_os().skip(1))`; its iterator excludes argv[0]. Reject duplicate singleton flags, missing values, and unknown proxy flags with exit 2. Parse with `args_os`; do not split paths or argument strings on spaces. `--tinymist` is required for normal operation. Its value is one executable path/name, not a shell command.
- Mode defaults to standalone Typst. `--markdown` before `--` selects Markdown mode. Everything after `--` belongs to Tinymist, including a literal `--markdown` if supplied there.
- Prepend `lsp` to the child argument vector if no complete argument equals `lsp`, preserving baseline launch semantics. Never shell-concatenate arguments.
- Parse help/version only in proxy-option position, never inside the child argument tail after `--`. Help/version work without Tinymist, spawn nothing, and may print to stdout. In normal mode stdout contains **only framed JSON-RPC**; logs use stderr.
- Exit 0 on successful LSP shutdown/client EOF; preserve an ordinary child nonzero exit code; use 1 for proxy runtime failure and 2 for CLI validation errors. Signal termination may map to 1 portably.

### Network

Only Tinymist serves `http://127.0.0.1:<assigned-port>/` and its existing WebSocket frontend. Do not add a native-proxy HTTP API, fixed port, telemetry endpoint, or custom WebSocket protocol. All controls below use `workspace/executeCommand` over the existing child stdio stream.

## B. Shared types (`proxy/src/protocol.rs`)

```rust
use serde_json::Value;
use std::{io, time::Duration};

pub type Message = Value;
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Endpoint { Client, Tinymist }
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mode { Typst, Markdown }
#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub enum RpcId { Int(i64), UInt(u64), Str(String) }

pub fn rpc_id(value: &Value) -> Result<RpcId, ProtocolError>;
pub fn id_value(id: &RpcId) -> Value;
pub fn encode_frame(message: &Message) -> Result<Vec<u8>, ProtocolError>;

pub struct FrameDecoder { /* private persistent byte state */ }
impl FrameDecoder {
    pub fn new() -> Self;
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Message>, ProtocolError>;
    pub fn finish(&self) -> Result<(), ProtocolError>;
}

pub enum SystemEffect {
    OpenBrowser { url: url::Url },
    JumpSource { path: std::path::PathBuf, line: u32, column: u32 },
}
pub enum Action {
    Write { to: Endpoint, message: Message },
    System(SystemEffect),
    Stop { exit_code: i32 },
}
```

`ProtocolError` must distinguish malformed framing, invalid JSON/envelope/position, I/O, and capacity errors and implement `Display`/`Error`. An `Io(io::Error)` variant is sufficient for I/O. Do not use panics for client/child data. Private constructors are permitted.

RPC ID rules: preserve integer/string identity and ID 0. Parse signed integers first, then unsigned; never stringify all IDs into one key, cast through f64, or treat a missing ID as 0. Null IDs occur in error responses, not tracked requests. Check for a `method` **before** classifying an incoming object as a response. A server request can use the same numeric ID as a client request.

Frame rules:

- `Content-Length` is UTF-8 **bytes**, not characters. Decode only after the full body arrives. Accept header-name case variations and unrelated valid headers, including Content-Type.
- Header terminator is CRLF/CRLF. Reject duplicate, negative, nondecimal, overflowed, or absent Content-Length; reject zero-length/invalid JSON bodies and JSON arrays. Support split headers, split Unicode bytes, and multiple frames in one chunk.
- Limit header bytes to 8 KiB and body bytes to 64 MiB. Check before allocation growth; `read_line` without a length bound is not acceptable. Reject partial frames at EOF. Once framing is corrupt, log and stop rather than scanning user bytes for a guessed resynchronization point.
- For a complete client frame containing invalid UTF-8/JSON, enqueue `-32700` with null ID and terminate; for a non-object/invalid envelope (including a JSON array), enqueue `-32600` with null ID and terminate. Malformed framing has no trustworthy reply boundary: terminate with stderr diagnostics. A decoder error must retain enough classification for runtime to choose this behavior; no resynchronization is required. Malformed child output is terminal; never forward it as editor text.
- Preserve unknown message fields semantically. Byte-for-byte JSON formatting/object-key order is not a parity requirement.

## C. Source and rendering (`proxy/src/document.rs`)

```rust
use std::{ops::Range, sync::Arc};
use url::Url;
use crate::protocol::ProtocolError;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Position { pub line: u32, pub character: u32 } // LSP UTF-16
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TextRange { pub start: Position, pub end: Position }
pub struct LineIndex { /* UTF-8 line-start byte offsets, no full UTF-16 copy */ }
impl LineIndex {
    pub fn new(text: &str) -> Self;
    pub fn byte_offset(&self, text: &str, at: Position) -> Result<usize, ProtocolError>;
    pub fn position(&self, text: &str, byte: usize) -> Result<Position, ProtocolError>;
}
pub struct Header {
    pub content: Range<usize>,       // UTF-8 byte offsets in original source
    pub body_start: Option<usize>,   // None means the opening header is incomplete
}
pub fn header_bounds(text: &str) -> Option<Header>;
pub fn typst_string(text: &str) -> String;
pub fn render_markdown(text: &str, version: i64) -> String;
pub fn shadow_uri(original: &Url, suffix: &str) -> Result<Url, ProtocolError>;
pub fn apply_changes(text: &str, changes: &serde_json::Value)
    -> Result<String, ProtocolError>;
pub fn edit_fraction(before: &str, after: &str) -> Option<f64>;

pub struct Document {
    pub generation: u64,
    pub version: i64,
    pub text: Arc<str>,
    pub index: LineIndex,
    pub preview_uri: Url,
    pub completion_uri: Url,
    pub completion_revision: u64,
    pub completion_text: Option<Arc<str>>,
}
```

`generation` increases on **every didOpen**, including close/reopen of the same URI and version. Keep the generation counter outside the document map. Within a lifetime, accept increasing versions; ignore/log stale notifications without changing text. Reject an invalid change batch atomically—do not apply its first half and leave the document corrupted. Full sync replaces text; incremental changes use each preceding change's resulting text, in received order. Preserve CRLF and trailing newlines.

Position conversion rejects nonexistent lines, characters past the line end, positions between UTF-16 surrogate halves, and byte offsets inside a UTF-8 scalar. CR is not an extra selectable line-ending column in CRLF. Rust `String::len` is bytes; `chars().count()` is Unicode scalars; neither is an LSP UTF-16 column. Use the original line index to validate completion ranges.

Header syntax exactly follows the baseline: optional BOM/blank lines, `"""` on its own opening line, then the first `"""` closing line. For rendering only a **complete** header is extracted. For completions an incomplete header extends to EOF. Ordinary/later code fences never become preambles.

`typst_string` emits a quoted Typst string: escape backslash/double quote and use `\u{hex}` for control characters. It is not simply `serde_json::to_string`. `render_markdown` preserves the baseline wrapper, math callback, cmarker version, relative image resolver, auto-height default, and versioned `<zed-preview-bottom>` metadata. Treat the JS wrapper and fixtures as the exact template reference.

`shadow_uri` appends `.zed-preview.typ` or `.zed-completion.typ` to the **URI path**, preserving percent-encoding and other URI components. Use `Url::to_file_path` for native OS paths; do not pass a `file://` URI where a Tinymist command expects a filesystem path. Preview supports file URIs; unsupported schemes receive no virtual Markdown document.

`edit_fraction` uses the last differing position inferred from the common suffix and UTF-16 lengths, preserving JS semantics. Unchanged text returns None; deletion to empty returns 0. Keep its known approximate behavior; do not implement a new diff algorithm in this port.

## D. Completions (`proxy/src/completion.rs`)

```rust
use std::ops::Range;
use serde_json::Value;
use crate::{document::{Document, Position}, protocol::ProtocolError};

pub enum RegionKind { Header, Math { delimiter: u8, closed: bool } }
pub struct Region { pub kind: RegionKind, pub content: Range<usize> }
pub fn region_at(doc: &Document, at: Position) -> Result<Option<Region>, ProtocolError>;
pub fn project_completion(text: &str, region: &Region) -> String;
pub fn sanitize_completion_list(
    result: &Value, doc: &Document, region: &Region, cursor: Position,
) -> Value;
```

Keep the scanner's tested exclusions: escaped dollars, inline backticks, backtick/tilde fences (including the currently supported list/blockquote prefixes), and indented code. Single-dollar regions stop at a newline. Double dollars permit multiple lines. Respect quoted strings while finding a math closer. Keep the existing conservative currency rule; do not silently expand Markdown/Obsidian parsing.

Projection copies only the selected region. Other source characters become spaces **equal to their UTF-16 width**, while CR/LF survive. Normalize display `$$` to Typst `$ ` / ` $` without changing columns. Append a synthetic closing delimiter after the original text for incomplete math. Source byte offsets and projected byte offsets differ before non-ASCII text; do not use an original byte range to slice the projected string.

Header projection preserves declarations in that header. Math projection omits header declarations, matching the renderer's separate `eval` scope. Do not suggest header-defined math macros that the actual preview cannot evaluate.

Accept array/CompletionList responses. Expand itemDefaults.editRange, retain snippet format/mode/commit characters, handle both TextEdit and InsertReplaceEdit, and reject a candidate if any necessary edit is outside the active region or has invalid coordinates. Strip command/data, advertise resolveProvider false, and correct quoted font insertions by replacing the active header string with the quoted selected label using plain-text insertion format 1. Do not send completionItem/resolve to generated documents in Markdown mode.

Keep one completion projection/revision per open Markdown document. Reuse it if unchanged. Before first projection opening, the preview must already have received its open/focus messages; Tinymist's manual focus must not be stolen by projection activity.

## E. Engine (`proxy/src/engine.rs`)

```rust
use std::time::Duration;
use crate::protocol::{Action, Message, Mode, ProtocolError};

pub struct EngineOptions { pub mode: Mode, pub preview_port: u16 }
pub struct Engine { /* single owner of all mutable protocol state */ }
impl Engine {
    pub fn new(options: EngineOptions) -> Self;
    pub fn on_client(&mut self, message: Message, now: Duration)
        -> Result<Vec<Action>, ProtocolError>;
    pub fn on_tinymist(&mut self, message: Message, now: Duration)
        -> Result<Vec<Action>, ProtocolError>;
    pub fn on_tick(&mut self, now: Duration)
        -> Result<Vec<Action>, ProtocolError>;
    pub fn next_deadline(&self) -> Option<Duration>;
}
```

`now` is monotonic elapsed time; tests advance it directly. There are no sleeps or OS calls inside Engine. Return actions in required destination order; never start an unordered asynchronous handler per message.

### Request ledger and limits

Remap every forwarded client request to a unique proxy-generated child ID. Store the original typed client ID plus request kind. Also remap forwarded Tinymist requests into unique client-facing IDs, storing the original server ID. Maintain separate tables for each direction. Generated scroll/focus/query requests have explicit pending entries rather than relying on a string prefix.

Responses match only the appropriate ledger and message direction; restore original IDs. Synthetic responses are consumed locally. Unknown/late responses are discarded with bounded diagnostic logging. Map cancellation IDs in both directions. A duplicate in-flight original ID in the same direction is a terminal protocol violation (`-32600`, null ID, for client input); never overwrite its ledger entry. The same ID across opposite directions is valid. A newer completion for the same document retires the older one: send child cancellation, answer its client with result null once, and release its snapshot immediately. A later result must not produce a second reply.

Completion and scroll targets carry `(URI, generation, source_version, token)`; completion targets also carry the projection revision. A completion result is valid only for the same document lifetime/version and outstanding token. A stale projection revision is discarded. Close removes both virtual documents and cancels/retire pending work. Reopening version 1 does not revive results from the previous version-1 document.

Client/server requests have a 30-second timeout; quiet no-result completion retirement returns null, other timed-out client requests receive proxy error `-32001`. A timed-out forwarded server request receives `-32001` back to the child under its original ID; retire the client-facing mapping and cancel it when supported. Local unsupported Markdown requests return null (highlights return `[]`). Invalid supported request parameters use `-32602`. Bound pending requests to 128 per direction; reject excess requests with `-32001` and a concise stderr message. Do not silently evict requests that still require replies. Bound synthetic entries to 128 separately: retire focus/scroll acknowledgements and expire them after 30 seconds. Coalesce/drop obsolete synthetic work before dispatch rather than evicting live forwarded requests; if no synthetic slot is available, skip that control attempt and report a bounded diagnostic. No source text in logs.

### Configuration

Consume previewProxy.openBrowser (bool, default true), followCursor (bool, default true for Typst/false for Markdown), mode (`document`/`slide`, default `document`), and the launcher-only nativePath. Markdown always forces followCursor false. Absent fields retain their current values on configuration updates. Strip previewProxy before forwarding configuration. Invalid proxy settings in initialize receive `-32602`; invalid notification updates are ignored/logged atomically. Unknown non-proxy Tinymist settings pass through.

Inject `customizedShowDocument = true` and:

```json
{"preview":{"background":{"enabled":true,"args":[
  "--data-plane-host=127.0.0.1:<port>",
  "--invert-colors=never",
  "--preview-mode=document"
]}}}
```

Use the configured mode. Replace background args as baseline does, retain unrelated settings, and force `exportPdf: "never"`/followCursor false only in Markdown mode. Inject on initialize, workspace/didChangeConfiguration (flat and nested tinymist), and tracked workspace/configuration responses (flat/nested items). Only the tracked initialize response receives capability rewriting—not arbitrary results containing a capabilities field.

Markdown forces UTF-16 in both the child initialization negotiation and the capability sent to Zed. Advertise full sync/openClose, code actions, document highlights, and Tinymist completion triggers plus `$`; disable completion resolve. Do not advertise formatting, signatures, rename, hover, diagnostics, or navigation. Typst mode retains child capabilities with `typst-preview.open`, `typst-preview.toggleFollow`, and `typst-preview.syncCursor` appended once. Markdown advertises only `typst-preview.open`. Match the baseline code-action titles/quickfix objects at `proxy.mjs:527–532,742–761`.

### Client routing

| Input | Markdown mode | Typst mode |
|---|---|---|
| didOpen/change/close | Maintain original snapshot, forward sibling preview document; focus after open/change; close completion sibling too | Forward |
| completion | Detect region; synchronize completion sibling before request; sanitize result | Forward |
| documentHighlight | Select document; return `[]`, no cursor navigation | Forward and potentially emit cursor-follow controls |
| codeAction | Local Open in Browser item | Forward, append existing three actions on its matching response |
| executeCommand: typst-preview.open | Local OpenBrowser effect, null result | Same |
| toggleFollow/syncCursor | No-op null result | Toggle or issue scroll controls, null result |
| Other executeCommand | No-op null result as baseline | Forward |
| Unsupported textDocument request | Null result, not forwarded | Forward |
| Other messages | Preserve and forward unless explicitly handled here | Preserve and forward |

A completion request is not a new browser-open trigger. The first document open schedules browser opening once after 800 ms (even when openBrowser is false, matching baseline browserOpened state). A later document selects the existing endpoint rather than opening a new tab.

### Server routing

Markdown suppresses textDocument/publishDiagnostics, tinymist/compileStatus, and tinymist/preview/scrollSource. For server requests window/showDocument return `{ "success": false }`; workspace/applyEdit return `{ "applied": false }`; client/registerCapability return null. Notifications of those names are ignored without generating a response. This must happen by message kind/direction, not by an overlapping client request ID.

Typst preview source jumps and file window/showDocument use a JumpSource effect with one-based CLI line/column. Preserve the original server request's result handling and start a 350 ms follow suppression window. Non-file showDocument requests pass through.

### Timers and Tinymist command endpoints

All commands are child `workspace/executeCommand` requests with internally tracked IDs:

| Command | Exact arguments / purpose |
|---|---|
| `tinymist.focusMain` | `[absolute_preview_path]`; changes the compiled preview entry, no new browser |
| `tinymist.exportQuery` | `[absolute_preview_path,{"selector":"<zed-preview-bottom>","field":"value","format":"json"},{"write":false}]` |
| `tinymist.scrollPreview` | `["default_preview",{"event":"panelScrollByPosition","position":{"page_no":1,"x":0,"y":123}}]`; Markdown edit-follow |
| `tinymist.scrollPreview` | `["default_preview",{"event":"panelScrollTo","filepath":"<absolute>","line":0,"character":0}]`; Typst cursor-follow |
| `tinymist.scrollPreview` | Same with `event: "changeCursorPosition"`; Typst cursor indication |

Scroll queries read base64 JSON from **result.data**, not result.items. The decoded array's first value contains version/page/x/y. Check finite positive page and finite y plus matching target lifetime/version/token. After a 200 ms debounce, map `y = 24 + fraction * max(0, bottom_y - 24)`. Invalid/stale query output retries at 200 ms, at most four total attempts. A new edit cancels old retries; an old response cannot schedule a retry for a newer target. Do not write JSON/SVG/PDF files to obtain scrolling data.

## F. OS runtime (`proxy/src/runtime.rs`)

```rust
use std::{ffi::OsString, path::PathBuf};
use crate::protocol::{Mode, ProtocolError, SystemEffect};

pub struct Options {
    pub tinymist: PathBuf,
    pub tinymist_args: Vec<OsString>,
    pub mode: Mode,
}
pub enum Cli { Run(Options), Help, Version }
pub fn parse_args(args: impl IntoIterator<Item = OsString>)
    -> Result<Cli, ProtocolError>;
pub fn run(options: Options) -> Result<i32, ProtocolError>;
pub fn execute_effect(effect: SystemEffect) -> Result<(), ProtocolError>;
```

Use literal `Command::new`/`.arg` values. Tinymist stdin/stdout are piped; stderr inherited. Browser launch uses `open <url>` on macOS, `xdg-open <url>` on Linux, and an argument-based Windows launcher (e.g. `rundll32.exe`, `url.dll,FileProtocolHandler`, URL), never a constructed `cmd /C` or shell expression. Check/report spawn errors without terminating an otherwise working preview. Only the proxy's generated loopback HTTP URL is passed to browser launch.

Source jumps use ZED_CLI_PATH if configured, then the baseline platform candidates/PATH lookup, with `path:line:column` as one argument. Spawn helpers with null stdin/stdout, avoiding LSP stdout contamination. Child helper processes must be reaped, using one small dedicated reaper if necessary—not an accumulating thread per jump. No source/credentials in diagnostics.

Resource limits: at most 64 MiB of queued input bodies, at most 128 MiB of serialized outbound frames across both destinations, and at most 128 outbound queued frames. Use byte credits (released on all paths), not just message counts. Each decoder may additionally hold one bounded in-progress frame. Main must not wait for writer capacity: an exhausted output budget returns a terminal, documented backpressure error and tears down the child. Test this failure mode; normal editing fixtures must not hit it. These are encoded-payload safety ceilings, not exact total-heap bounds, target RAM usage, or permission to preallocate them. JSON values, document snapshots, and allocator overhead consume additional memory. Read fixed-size chunks (at most 64 KiB), acquire body credits before queueing decoded messages, and never accumulate an unbudgeted Vec of messages from successive reads.

On client EOF, exit notification, writer failure, malformed child frame, or child exit, close handles and cancel timers; allow up to 2 seconds for graceful child exit, then kill and reap. Do not leave a Tinymist server behind when Zed closes stdin. Do not wait forever joining a reader blocked on live stdin. Poll the owned child with try_wait; no competing wait/kill owners.

Teardown must allow pending terminal client errors to drain within the same 2-second total shutdown budget, then exit even if a peer never reads. Never join blocked writer threads indefinitely. Forward the successful LSP shutdown response before the exit notification tears down the transport.

## G. WASM launcher integration (`src/proxy.rs`)

```rust
use zed_extension_api::{self as zed, LanguageServerId, Worktree};
pub fn command(
    server_id: &LanguageServerId,
    worktree: &Worktree,
    javascript_proxy_path: &str,
    tinymist_path: &str,
) -> zed::Result<zed::Command>;
```

`src/lib.rs::language_server_command` still obtains the existing tool paths from `TinymistBinary::ensure`, then delegates to this function. Do not change Tinymist resolution order or pinned version.

New opt-in configuration:

```json
{"lsp":{"markdown-typst-preview":{"settings":{"previewProxy":{
  "nativePath":"/absolute/path/to/typst-preview-proxy",
  "openBrowser":false
}}}}}
```

Use the corresponding server entry for standalone Typst. This path is the native proxy, **not** the existing `lsp.<server>.binary.path`, which continues to mean Tinymist. Read settings first, then initialization_options as fallback for nativePath; conflicting explicit paths are an error. Preserve the current initialization/configuration methods and shell environment forwarding.

When nativePath is absent, retain the existing Node launch. When present, return `command = nativePath`, args `--tinymist`, resolved Tinymist path, and `--markdown` only for the Markdown server; do not call node_binary_path on this path. A nonstring/empty/relative configured path is an error. Do not silently fall back when an explicitly configured native executable fails. Do not require WASM std::fs access to an arbitrary host binary path; the Zed host performs the actual launch.

No downloader URL is invented in this phase. A future default native downloader/cutover requires the separate release gate and real artifact metadata.
