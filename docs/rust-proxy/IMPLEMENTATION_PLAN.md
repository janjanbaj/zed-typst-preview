# Native Rust proxy implementation plan

## 1. Outcome and boundaries

Replace the Node process in:

```text
Zed --stdio LSP--> Node proxy --stdio LSP--> Tinymist --HTTP/WebSocket--> browser
```

with `typst-preview-proxy`, a native Rust executable. The existing Rust extension remains a small WebAssembly launcher inside Zed. Tinymist remains a separate native process and continues to own compilation, browser HTTP/WebSocket serving, fonts, and packages.

This is a compatibility port with bounded protocol/lifecycle hardening. It is not a Zed rebuild, a Tinymist fork, a new renderer, a new Markdown grammar, an Obsidian implementation, or a redesign of pairing. Do not combine the proxy with Tinymist or compile the native proxy to WASM.

Keep cmarker at 0.1.8, downloaded Tinymist at 0.14.10, and `zed_extension_api` at 0.7.0. Do not opportunistically update dependencies or language configuration. Keep the existing `.typ` and Markdown server IDs. Keep all author/repository metadata private or omitted as at baseline.

## 2. Target layout and dependencies

Add a host-only workspace member while retaining the root extension crate:

```text
Cargo.toml                         # add [workspace], resolver = "2"
Cargo.lock                         # one committed lockfile
proxy/Cargo.toml                   # package/bin: typst-preview-proxy
proxy/src/lib.rs                    # exports modules; no process startup
proxy/src/main.rs                   # parse CLI, runtime::run, stderr on failure
proxy/src/protocol.rs               # frame codec, typed RPC IDs, endpoint/actions/errors
proxy/src/document.rs               # source/index/version/header/wrapper/URI helpers
proxy/src/completion.rs             # region scanner, projection, validated completion edits
proxy/src/engine.rs                 # ordered state machine, routing, deadlines, request ledger
proxy/src/runtime.rs                # child/pipes/port/process lifecycle and command effects
proxy/examples/fake_tinymist.rs     # test helper, never a release asset
proxy/tests/                       # Rust unit/integration coverage as assigned
src/proxy.rs                       # opt-in native launch selection in the WASM extension
src/lib.rs                         # delegates command creation to src/proxy.rs
proxy.mjs                          # preserved baseline/reference and default fallback
tests/proxy-contract.test.mjs       # shared black-box driver
tests/fixtures/rust-proxy/          # portable scenarios and expected results
```

Use `members = [".", "proxy"]`, `default-members = ["."]`. Root `cargo build --target wasm32-wasip1` must continue to build only the extension; native commands always specify `-p typst-preview-proxy`. Never build the whole workspace for WASI.

Native dependencies: `serde` 1 with derive, `serde_json` 1, `url` 2, and `base64` 0.22. Use stable standard-library threads, channels, clocks, and process APIs. Do not introduce an async runtime, LSP framework, HTTP server, JavaScript engine, or plugin framework in this port. Ask the architect before adding dependencies. Commit concrete compatible versions through Cargo.lock.

## 3. Runtime architecture

Use a single owner of mutable protocol/document state. Two reader threads consume Zed stdin and Tinymist stdout; two writer threads own Zed stdout and Tinymist stdin. Main owns `Child`, polls `try_wait`, receives ordered events, drives deadlines, and dispatches engine actions. Tinymist stderr inherits the proxy's stderr.

Readers use bounded framing and byte-budgeted event queues; preserve FIFO within each input stream. Writes to a destination are serialized through one writer. Main must never block on pipe I/O or wait for an outbound queue to drain. Outbound enqueue is nonblocking with the byte budget in the API contract: saturation is an explicit terminal transport error with cleanup, not silent message loss. Do not create a blocking cross-pipe deadlock or an unbounded channel hidden behind a count-only limit.

Main computes `recv_timeout` from the next engine deadline, capped at 50 ms to poll child exit. No timer thread per edit and no detached thread per request. Allocation credits must be released on write completion, parse failure, queue drop, and shutdown. Blocked stdin reader threads are not joined during exit; they cannot keep the process alive. Main closes queues/pipes, kills/reaps Tinymist when necessary, and returns.

Reserve a loopback port before accepting `initialize`. As in baseline, bind `127.0.0.1:0`, record the assigned port, then release the listener so Tinymist can bind it. This leaves a known bind race; do not describe the probe as exclusive reservation. The proxy itself does not serve a new network endpoint.

## 4. Behavioral compatibility

Preserve:

- Triple-quoted leading headers, hidden preamble, cmarker wrapper, native Typst math, auto-height page, light colors, sibling virtual preview/completion URIs, and source-file-relative images.
- Full buffer sync advertised to Markdown clients, with valid incremental incoming changes also supported.
- Completion in complete/unfinished headers and math, UTF-16 positions, snippets, insert/replace edits, font-string normalization, scope restrictions, and no Typst suggestions in ordinary prose/code.
- One browser auto-open after 800 ms per proxy session; manual browser reopening; document activity selecting the same preview via `tinymist.focusMain`.
- 200 ms edit-follow debounce, bottom-metadata query, version checks, at most four query attempts, proportional scrolling, and cancellation when the target becomes obsolete.
- Standalone Typst forwarding, cursor-follow commands, browser-to-source CLI jumps, and the 350 ms bounceback suppression interval.
- Preview configuration injected consistently at initialization, configuration notifications, and configuration responses. No automatic Markdown PDF export.
- Markdown isolation: suppress generated diagnostics/compile status, block server edits/document-open requests/dynamic registrations, and keep unsupported editor features disabled.

The API contract explicitly supersedes baseline implementation weaknesses in framing limits, RPC ID routing, stale lifecycle handling, child cleanup, and shell-based browser opening. These changes need their own tests; do not silently broaden behavior beyond them.

## 5. Minimum reading map

All references below are at `0a366d8`:

| Work | Read only these source sections initially |
|---|---|
| Wrapper/header/URI/UTF-16 | `proxy.mjs:16–82`; tests at `tests/markdown-preview.test.mjs:13–61` |
| Region scanner/projection/edit sanitation | `proxy.mjs:84–237`; tests at `tests/markdown-preview.test.mjs:63–135` |
| Settings and preview startup | `proxy.mjs:240–323`, `558–600` |
| Framing/stdio | `proxy.mjs:325–368`, `546–555` |
| Focus/edit-follow | `proxy.mjs:370–443`, `643–651` |
| Completion request lifecycle | `proxy.mjs:445–470`, `655–672` |
| Markdown routing | `proxy.mjs:474–543`, `690–698`, `714–731` |
| Typst controls/forwarding | `proxy.mjs:603–641`, `678–712`, `733–765` |
| Launcher/provisioning | `src/lib.rs:18–74`, `src/tinymist.rs:12–104`, `extension.toml` |
| Existing integration coverage | `tests/markdown-preview.test.mjs:137–296` |
| Pairing boundary | `config/markdown-math-keymap.json`; do not alter it |

The top of the existing Node test file extracts pure JS helpers with `vm`. Those tests alone do not exercise a Rust binary. Add the separate shared black-box harness; do not claim Rust parity because the JS-only suite passes.

## 6. Milestones and review gates

1. **Contracts/tests:** freeze portable fixtures, public Rust types, and a shared Node/native black-box adapter. Pass the baseline-compatible scenarios against Node. Hardening scenarios are native requirements, with baseline failures documented.
2. **Pure functions:** port documents, wrapper, scanner, projection, and completion sanitation. Pass fixture parity before integrating process I/O.
3. **Transport/runtime:** implement frame limits, two-way pipes, safe argument handling, and shutdown. Prove byte framing, bounded buffers, and no orphan child with a fake executable.
4. **State engine:** integrate settings, routing, request remapping, completions, focus, scroll, and deadlines. Pass both-mode behavior and adversarial scenarios.
5. **Opt-in launcher:** add nativePath selection, without changing existing Tinymist binary resolution or removing Node fallback. Build the extension for WASI and native proxy for the host separately.
6. **Real Tinymist/memory:** run terminal-only integration and paired benchmarks. User performs browser/editor UI verification. Review before enabling a default native launcher.
7. **Distribution/cutover:** only after gates pass and the project owner supplies a real artifact location and license decision. Keep a documented rollback. Publishing or pushing releases requires explicit authorization.

Each milestone is a bounded change reviewed before the next dependent task. Follow [AGENT_TASKS.md](AGENT_TASKS.md) for file ownership and evidence requirements.

## 7. Build, benchmark, and release gates

Required commands after the corresponding files exist:

```sh
cargo fmt --all -- --check
cargo test -p typst-preview-proxy --locked
cargo clippy -p typst-preview-proxy --all-targets --locked -- -D warnings
cargo build -p typst-preview-proxy --release --locked
cargo build -p typst-preview-proxy --example fake_tinymist --locked
node --test tests/markdown-preview.test.mjs
# Harness variables and platform executable suffix are defined in TEST_PLAN.md.
node --test tests/proxy-contract.test.mjs
cargo build -p zed-typst-preview --release --target wasm32-wasip1 --locked
```

Use a populated cache for `--offline`; do not assume a new native dependency is already downloaded. Never replace the user's installed extension.wasm or global settings to run tests.

The previous local snapshot was about 20 MB physical footprint for Node and 79 MB for Tinymist. This was not a controlled baseline. Fresh paired measurements are required; do not promise to recover all 20 MB or attribute Tinymist/browser memory to the proxy.

Benchmark five paired Node/native runs on the same host and Tinymist binary after equal warmup. Record idle, sustained edits, completions, document switching, and post-close retention. Separate proxy and Tinymist figures; use the same memory metric throughout. On macOS use physical footprint for both, not Node RSS versus Rust footprint. No forced GC or runtime memory caps on only one candidate.

Cutover requires at least 10% lower median proxy footprint in the agreed idle/active fixtures, no material end-to-end preview regression, completion median latency no more than 10% worse and p95 no more than 20% worse, and no retained-growth trend across repeated close/open cycles. These are design acceptance thresholds, not measured results. If noise prevents a conclusion, keep the default unchanged and report uncertainty.

For future assets, use these exact names/targets:

| Zed OS/architecture | Rust target | Native proxy asset |
|---|---|---|
| macOS ARM64 | `aarch64-apple-darwin` | `typst-preview-proxy-darwin-arm64` |
| macOS x86-64 | `x86_64-apple-darwin` | `typst-preview-proxy-darwin-x64` |
| Linux ARM64 | `aarch64-unknown-linux-musl` | `typst-preview-proxy-linux-arm64` |
| Linux x86-64 | `x86_64-unknown-linux-musl` | `typst-preview-proxy-linux-x64` |
| Windows ARM64 | `aarch64-pc-windows-msvc` | `typst-preview-proxy-win32-arm64.exe` |
| Windows x86-64 | `x86_64-pc-windows-msvc` | `typst-preview-proxy-win32-x64.exe` |

Do not label untested targets supported. A future downloader must use an actual reviewed release URL, versioned cache names, atomic installation, executable permissions, and published checksums; no fake GitHub owner or unversioned cached binary. This plan's first usable milestone needs only the explicit local nativePath override.

## 8. Primary references

- [Zed extension API 0.7.0: Extension](https://docs.rs/zed_extension_api/0.7.0/zed_extension_api/trait.Extension.html): launcher signature. Existing `src/lib.rs` is the tested integration example.
- [Zed language servers](https://zed.dev/docs/extensions/languages#language-servers): extension-provided servers; no custom preview pane is needed.
- [LSP 3.17 specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/): protocol framing, positions, synchronization, completion, cancellation.
- [Rust std::process::Command](https://doc.rust-lang.org/std/process/struct.Command.html): literal argument arrays, pipes, child lifecycle.
- [Tinymist v0.14.10 command handlers](https://github.com/Myriad-Dreamin/tinymist/blob/v0.14.10/crates/tinymist/src/cmd.rs): focus, query, and scroll commands.
- [Tinymist query export](https://github.com/Myriad-Dreamin/tinymist/blob/v0.14.10/crates/tinymist/src/cmd/export.rs): query options and `write: false`.
- [Tinymist preview messages](https://github.com/Myriad-Dreamin/tinymist/blob/v0.14.10/crates/typst-preview/src/actor/editor.rs): control-plane event names.
- [Tinymist focus rules](https://github.com/Myriad-Dreamin/tinymist/blob/v0.14.10/crates/tinymist/src/input.rs): manual focus prevents completion documents from becoming the preview entry.
- [cmarker 0.1.8](https://github.com/typst/packages/blob/main/packages/preview/cmarker/0.1.8/lib.typ): existing wrapper semantics; do not replace the converter during this port.
