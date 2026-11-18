# Rust proxy acceptance and adversarial test plan

## 1. Test harness contract

Keep `tests/markdown-preview.test.mjs` unchanged as the JS regression/oracle suite. Its first eight tests call JS helpers directly; its integration test spawns Node. It is not proof of native functionality.

Add `tests/proxy-contract.test.mjs` with these environment variables:

- `PROXY_IMPLEMENTATION=node|native` (default `node`).
- `PROXY_BIN`: required for native, absolute path to the built proxy executable.
- `FAKE_TINYMIST_BIN`: required for shared integration scenarios, absolute path to the separately built fake child executable; honor `.exe` on Windows.
- `REAL_TINYMIST_BIN`: optional explicit path for real-engine checks; otherwise skip those checks with a clear reason, not a passing result.
- `TYPST_PACKAGE_CACHE_PATH`: optional test package cache; never overwrite the user's cache/settings.

Node adapter spawns `node proxy.mjs FAKE_TINYMIST_BIN [--markdown]`; native adapter spawns `PROXY_BIN --tinymist FAKE_TINYMIST_BIN [--markdown]`. The fake child accepts an optional `lsp` argument. It uses independently implemented framing, scripted responses, a test-owned JSONL event log, configurable delays, and scenarios for malformed output/backpressure/exit. It never launches a browser and is not a release artifact.

Use unique temporary directories, URI-encode paths, and remove only test-owned artifacts. The fake process must be stopped/reaped in teardown even if an assertion fails. Pass `previewProxy.openBrowser = false`; test browser/jump effects directly against Engine and argument builders. Do not operate the user's running Zed, browser, extension files, or global keymap.

Normalize only nondeterministic ports, private remapped request IDs, and elapsed timestamps when comparing JS/native traces. Do not normalize source positions, command names/arguments, edits, versions, order, errors, capability fields, or document lifetime behavior. Preserve one reply per request and destination ordering.

A small fixture set under `tests/fixtures/rust-proxy/` is shared by Rust and Node where practical. Golden outputs originate from the frozen JS helpers plus manually reviewed expectations, not from whichever new implementation is under test. Rust property/roundtrip tests supplement goldens rather than merely repeating the implementation.

## 2. Required scenario matrix

**P** means behavior parity with baseline; **H** means explicit native hardening that may intentionally differ from baseline.

| ID | Type | Input/attack | Required observation |
|---|---|---|---|
| F01 | P | Header/body split at every byte; Unicode bytes fragmented | Exactly one reconstructed message; byte-counted output parses independently |
| F02 | P | Multiple frames per chunk, mixed header-name case, Content-Type | All frames delivered once in order |
| F03 | H | Missing/duplicate/negative/overflow length, header >8 KiB, body >64 MiB | Bounded failure before uncontrolled allocation; stderr only; child reaped |
| F04 | H | Partial header/body EOF, invalid UTF-8/JSON, JSON array | Defined terminal behavior; no guessed resynchronization or source disclosure |
| R01 | H | IDs 0, 1, "1", large u64; client IDs resembling internal prefixes | Exact typed IDs restored; no collision or prefix-based swallowing |
| R02 | H | Child workspace/configuration request uses an outstanding completion's client ID | Routed as a server request, not mistaken for a completion response |
| R03 | H | Cancel a remapped request; late result follows | Correct downstream ID cancellation, at most one client reply, no retained snapshot |
| R04 | H | Never-answering child; 30 s fake-clock advance; 129 outstanding requests | Timeout/capacity response and ledger cleanup; synthetic IDs also expire |
| R06 | H | Duplicate in-flight original ID in one direction; same ID across opposite directions | Same-direction violation cannot overwrite pending state; opposite-direction collision remains valid |
| R05 | H | A non-initialize result contains an unrelated capabilities field | It is not rewritten as initialize |
| D01 | P | Full and sequential incremental changes, CRLF, emoji before cursor | Same resulting text/wrapper; source positions preserved |
| D02 | H | Change references invalid line, surrogate half, reversed range, stale version | No partial mutation; version/text remain coherent; no panic |
| D03 | P | BOM/blank header prefix, complete/empty/incomplete triple quotes | Only complete leading header executes for preview; incomplete header completes |
| D04 | P | Ordinary/later code fences, quotes, backslashes, NUL/control characters | Correct extraction/escaping; ordinary source stays source |
| D05 | P | URI with spaces, Unicode, percent signs, #, ?, Windows drive/UNC where supported | Suffix added to URI path; command receives decoded native path as one argument |
| D06 | H | Close/reopen same URI with version 1, then old completion arrives | Old document generation cannot produce a new result/edit |
| C01 | P | `$fr`, `$sq$`, `$$` multiline, header `#set te`, earlier header variable | Correct region/projection; actual Tinymist returns expected candidate |
| C02 | P | Inline/fenced/tilde/list/blockquote/indented code, escaped dollars, prices | Tested exclusions match baseline; no prose completion request sent to child |
| C03 | P | Emoji/non-BMP text before math and CRLF; UTF-8/scalar/UTF-16 differ | Projected cursor has original LSP line/character; inserts replace intended text |
| C04 | P | TextEdit, InsertReplaceEdit, itemDefaults.editRange, snippet placeholders | Correct fields preserved; valid insertions work; no defaults silently lost |
| C05 | H | Candidate edits outside region, into synthetic closer, into surrogate half, or through command/additional edit | Entire unsafe candidate rejected; no generated-file action forwarded |
| C06 | P | Font completion in complete/unfinished quoted string | Replace string cleanly with quoted selected label, insertTextFormat 1 |
| C07 | H | Two completions for one unchanged source version but different regions/projection revisions | Newer request supersedes older safely; old result cannot insert in wrong region |
| C08 | H | Fast edits while child responses lag | Old snapshots released on cancellation/retirement, not only after eventual replies |
| P01 | P | Flat/nested initialize/config notification/configuration response | Stable same-port preview injection; unrelated settings survive |
| P02 | P | openBrowser false, later manual Open action, repeated opens | No automatic OS launch when disabled; one auto-open schedule; manual action targets dynamic port |
| P03 | P | A → B → A activity, same line number, completion virtual-file opening | Same preview server follows correct preview file; completion file never takes over |
| S01 | P | Rapid full/incremental edits | One 200 ms debounced latest target, no immediate scroll storm |
| S02 | P | Query returns base64 result.data with matching version | panelScrollByPosition uses page_no/x/y and expected proportional position |
| S03 | P | Malformed base64/JSON, missing metadata, stale version, compile error | At most four query attempts; no bogus y or written export file |
| S04 | H | A → B → A before old query returns; close/reopen same version | Token and generation reject stale scroll, including stale retry timers |
| I01 | P | Markdown diagnostics/compile status/server edits/showDocument/registration | Suppressed or explicit blocked results as contracted; no editor mutation |
| T01 | P | Standalone Typst initialize and arbitrary unknown methods/results | Unknown fields and protocol behavior preserved; existing command additions remain |
| T02 | P | Typst cursor follows, click source jump, suppression window, manual toggles | Same events/coordinates/one-based CLI args; fake clock verifies 350 ms suppression |
| O01 | H | Executable/source paths with spaces, Unicode, apostrophes, `;`, `$()`, `%` | Literal argv values, no shell execution or stdout pollution |
| O02 | H | Client EOF while stdin reader is blocked; child crashes during a request | Process terminates within cleanup bound and child PID is gone |
| O03 | H | Child never reads stdin / client never reads stdout | Memory remains bounded; explicit backpressure failure/cleanup; no deadlock |
| O04 | H | Browser helper fails / source CLI absent | Error on stderr; preview protocol remains alive; helper processes reaped |
| L01 | P | nativePath absent vs explicit valid path | Existing Node path unchanged; native path does not provision Node |
| L02 | H | Empty/relative/nonstring nativePath or conflicting settings | Clear configuration error; no accidental Tinymist binary override or silent fallback |
| L03 | P | Host vs WASI build selection | Native crate not compiled into WASM extension; root build remains valid |

Pure Engine tests use explicit `Duration` values, not real sleeps. Process tests use bounded deadlines and assert actual child cleanup. RPC parser/error hardening is native-only; annotate the known JS limitations rather than weakening native expectations.

## 3. Real Tinymist terminal check

Use an explicitly supplied v0.14.10 executable and a test-owned populated cmarker cache. Start a fresh proxy in Markdown mode with automatic browser opening disabled. Through real LSP:

1. Open a virtual Markdown file containing prose, inline/display math, a table, and a code block.
2. Request `frac`, `sqrt`, and `vec` completions in math; `text`, a header-defined variable, and a font inside complete/incomplete headers. Apply the returned edit/snippet to the original fixture and assert it modifies the intended region. Do not only check labels.
3. Confirm the preview entry remains the `.zed-preview.typ` file after opening/changing `.zed-completion.typ`.
4. Edit without saving. Validate changed rendered output or metadata through a directly driven Tinymist fixture; check that the preview endpoint still responds. Do not enable arbitrary export commands in production Markdown routing just for tests.
5. Verify base64 metadata output and an accepted scroll command. No source, PDF, SVG, or JSON is written by production routing; any explicit test export stays inside its temporary directory.
6. Close the Markdown document and end the session; assert cleanup.

The existing temporary live-check scripts are not repository fixtures and must not be assumed available to another agent. Build a portable test from the public protocol contract. Record binary version, fixture size, and output; skip/report unavailable dependencies honestly.

## 4. Benchmark recipe and report

Use five alternating paired runs, same release builds, host, architecture, Tinymist executable, fonts, package cache, configuration, and fixtures. Both proxies get equal warmup; do not compare a long-idle compressed Node process with a newly started Rust process.

Fixtures: a ~100 KiB mixed Markdown document (headings, math, table, Unicode), a ~1 MiB stress document, and at least two file URIs for switching. Generate from public sample content; never use private notes.

For each pair record:

| Phase | Workload / measurement |
|---|---|
| Startup | Initialize + open + warm compilation; elapsed time until queryable metadata |
| Idle | 30 seconds after warmup, proxy and Tinymist physical footprint/RSS reported separately |
| Editing | 500 valid versioned full changes, plus a separate sequential incremental scenario |
| Completion | 100 alternating math/header requests; median/p95 round-trip time and stale-result count |
| Switching | 100 A/B focus selections, one preview URL, no automatic browser reopen |
| Retention | Repeat open/complete/close cycle 100 times; settle and compare retained proxy memory |

At equal checkpoints collect the same metric from both implementations. On macOS, `vmmap -summary <pid>` physical footprint can account for idle compressed pages; plain RSS is not interchangeable. On Linux/Windows document the available comparable measure. Do not sum shared mapped libraries or virtual address reservations as private RAM.

Report raw samples, medians, p95, proxy/Tinymist separation, load generator version, and outstanding-request/document counts. Debug counters can be test-only library inspection; do not add a production telemetry server. A single process snapshot is not a successful benchmark.

Apply the thresholds in IMPLEMENTATION_PLAN.md. If savings/latency are inconclusive, the native option may remain opt-in; do not switch the default by assumption.

## 5. User-run UI acceptance

The user prefers to test the UI. Provide a short checklist, without taking over their browser:

- Open Markdown, edit prose/math/header style, reopen browser through code actions.
- Switch between documents, including back to unchanged tabs; document the known cursor-move fallback.
- Accept inline/display/header/font completions; ensure inserted characters and snippets are correct.
- Confirm approximate edit-follow and light appearance.
- Open standalone Typst and check follow toggle and preview clicks.
- Close Zed/project and check that proxy/Tinymist terminate.

Pairing is a Zed keymap feature and must remain unchanged by the proxy migration.
