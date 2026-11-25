# Copy-ready implementation task packets

## Shared instructions — prepend to every task

You implement a bounded part of a native Rust replacement for the Node proxy. Work on `rust-proxy`. Read the [baseline update](README.md#baseline-update) for the new parity requirements from `main`. The original packet line references use `0a366d8`. Read `docs/rust-proxy/API_CONTRACT.md` and the specific source sections below. Do not scan the whole repository or generated/reference directories. The coordinating agent is the architect/reviewer; ask it to approve contract changes.

You are not alone in the codebase. Do not revert other work, delete the JS oracle, modify files outside your ownership, weaken tests, update dependencies opportunistically, alter global Zed settings, replace the installed WASM, publish artifacts, or push branches. If shared scaffolding changes are needed, coordinate them. Prefer sequential task handoffs; the listed packets are not permission to concurrently edit shared files.

Return: files changed, concrete behavior, commands/results, known failures, unresolved questions, and a compact review checklist. Do not claim UI/platform/memory validation you did not perform. Use literal argv arrays and stderr diagnostics. Preserve source privacy and third-party notices. Do not commit unless the coordinator explicitly requests a commit for your task.

Before coding, read only your referenced baseline sections and the public contract. Keep new files small and purposeful. Stop at the assigned milestone; do not implement a later agent's portion.

## A — Workspace, protocol, and CLI foundations

**Own:** root Cargo.toml/Cargo.lock, `proxy/Cargo.toml`, initial `proxy/src/lib.rs`, `proxy/src/main.rs`, `proxy/src/protocol.rs`, and only the CLI/type portion of `proxy/src/runtime.rs`.

**Read:** API sections A/B/F; baseline `proxy.mjs:8–14,240–255,325–368,546–555`; existing root Cargo.toml.

**Build:** host-only workspace member, frame codec, typed IDs, errors/actions, Options/Cli parsing. Implement `--help`/`--version`; until runtime task E is complete, normal startup returns a clear not-implemented error and must not be selected by Zed. Export only modules that exist. No TODO panic in protocol/parser paths.

**Acceptance:** F01–F04 and CLI argument tests including `--` boundaries, spaced paths, duplicate/unknown options, UTF-8 fragmentation, ID 0 versus "0", and oversized length before allocation. Root WASI build still passes. Tests live next to protocol/CLI code. No Node runtime removal yet.

**Reviewer checks:** bounded decoder, explicit EOF behavior, no stdout logging, no platform-specific dependencies leaking into WASI.

## B — Source representation and Markdown wrapper

**Depends on:** A. **Own:** `proxy/src/document.rs`, document unit tests, and the single `pub mod document` declaration in lib.rs.

**Read:** API C; baseline `proxy.mjs:16–82`; existing tests `:13–61`; examples/math.md and examples/styled.md.

**Build:** all section-C functions and Document/LineIndex types. Separate UTF-8 byte offsets from UTF-16 columns. Port exact wrapper and header behavior; generate URI siblings with proper encoding. Changes apply atomically and in order. Use Arc snapshots; do not retain whole alternate UTF-16 copies.

**Acceptance:** D01–D05 plus byte/position roundtrips and impossible-position rejection. Fixtures must include astral characters before/inside the target, CRLF, BOM, controls, full changes, and multi-change incremental batches. Compare wrapper bytes with JS on valid inputs.

**Reviewer checks:** Rust `.len()` never substitutes for LSP columns; incomplete header is not executed by rendering; no virtual source writes.

## C — Completion semantics

**Depends on:** B. **Own:** `proxy/src/completion.rs`, completion unit tests, and its lib.rs module declaration.

**Read:** API D; baseline `proxy.mjs:84–237`; tests `:63–135`.

**Build:** scanner, UTF-16-preserving projection, edit validation, itemDefaults/snippet handling, and quoted-font normalization. This is pure logic; no processes or requests. Preserve all baseline exclusions and numeric/currency limitation.

**Acceptance:** C02–C06 plus incomplete-dollar/header cases; a projected original cursor maps back to the same LSP position. Discard whole candidates requiring out-of-region edits. Preserve snippets and plain-text font literals.

**Reviewer checks:** only selected math/header region survives projection; header macros do not leak into math scope; no lazy resolve/commands or synthetic-closer edits.

## H — Independent shared contract tests (start after A)

**Own:** `tests/proxy-contract.test.mjs`, `tests/fixtures/rust-proxy/`, `proxy/examples/fake_tinymist.rs`. Do not change implementation files or the existing JS test suite.

**Read:** TEST_PLAN.md and API contract. Inspect only the baseline helper/test sections needed to build fixtures and the Node launch signature. Write expectations from the contract, not by copying the new Rust output.

**Build:** portable Node/native adapter and independent scripted fake server. Native helper framing must not call the production FrameDecoder. Add delayed/colliding IDs, lifecycle, EOF, and fault scripts. Support `.exe` without Unix shebang assumptions.

**Acceptance:** baseline-compatible scenarios pass against Node. Native-hardening cases are present and explicitly distinguished; it is acceptable for them to fail until D/E land. Never weaken a native requirement to make the baseline pass. Supply exact environment/run commands.

**Reviewer checks:** tests actually launch PROXY_BIN; ordering/ranges are asserted; no private paths or browser actions; helper process cleanup occurs on assertion failure.

## D — Stateful protocol engine

**Depends on:** A/B/C; use H scenarios. **Own:** `proxy/src/engine.rs`, engine unit tests, and its lib.rs declaration.

**Read:** API E; baseline `proxy.mjs:258–298,370–543,558–766`. Do not read provisioning files for this task.

**Build:** on_client/on_tinymist/on_tick, two-way typed ID remapping, initialized-response-only capability rewriting, config bridge, Markdown state/version/generation, completions, focus, scrolling, Typst forwarding/controls, timers and cancellation. No OS side effects or real sleeps.

Implement in two reviewable passes within this packet: (1) configuration/RPC/Typst/Markdown sync; (2) completion/scroll lifecycles. Review the first before broadening the same file.

**Acceptance:** R01–R06, D06, C07–C08, P01–P03, S01–S04, I01, T01–T02 using a fake monotonic clock. Explicitly test close/reopen version reuse and server-request/client-request ID collisions. Bound/retire every pending table. Verify at most one response per client request.

**Reviewer checks:** classify request vs response before ID lookup; doc generation and target token are checked; downstream IDs never escape; no broad string-prefix drop; capability mutation is scoped to initialize.

## E — Native process/stdio runtime

**Depends on:** A/D; H helper. **Own:** full `proxy/src/runtime.rs`, runtime integration tests, and startup wiring in main.rs. Do not change pure semantics to work around transport failures.

**Read:** API F, runtime architecture in IMPLEMENTATION_PLAN.md, baseline `proxy.mjs:244–255,300–323,325–368,546–555`.

**Build:** owned child lifecycle, reader/writer threads, byte-budgeted queues, ordered action dispatch, monotonic deadlines, loopback port probing, safe browser/source command builders, helper reaping, and bounded teardown. Do not block the engine thread on pipe writes or an output-capacity wait.

**Acceptance:** F01–F04 and O01–O04 with actual spawned helper PIDs. Confirm nonreading peers do not deadlock and client EOF does not leave Tinymist alive. Confirm stderr cannot corrupt frames. Then run all shared native behavior scenarios.

**Reviewer checks:** queue accounting releases on error/drop; limits are not eagerly allocated; stdin thread is not joined indefinitely; only one owner waits/kills the child; helper process count does not grow with clicks.

## F — Opt-in Zed launcher

**Depends on:** native binary passing D/E. **Own:** `src/proxy.rs`, the command-construction part of src/lib.rs, launcher tests, and the new opt-in configuration section of README.md. Coordinate root build files with A; do not change src/tinymist.rs unless the reviewer identifies a necessary bug.

**Read:** API G; baseline src/lib.rs, src/tinymist.rs, extension.toml. No scan of grammar/query files.

**Build:** previewProxy.nativePath routing exactly as contracted. Keep `.binary.path` for Tinymist. Absent override keeps Node; present valid override bypasses node_binary_path. Keep shell environment and both server IDs.

**Acceptance:** L01–L03. Build host executable and root WASI separately. Review the concrete launch command, but do not modify the user's settings or installed extension. Provide the minimal opt-in JSON for the user to test.

**Reviewer checks:** no invented release URL, no silent fallback after explicit native failure, no arbitrary-host-path std::fs assumption in WASM, no UI activation attempted.

## G — Evidence, packaging proposal, and cutover recommendation

**Depends on:** A–F/H. **Own:** benchmark/test scripts as agreed with reviewer, results under `docs/rust-proxy/results/`, and proposed release-workflow files only after artifact ownership is known.

**Read:** TEST_PLAN.md sections 3–5, implementation plan release gate, and adversarial audit. Do not refactor implementation while benchmarking; report bugs back to the responsible task.

**Build/run:** real pinned Tinymist checks, five paired release-build benchmarks, and supported-platform build matrix. Capture public fixtures and reproducible measurements. Keep the JS rollback. Check source/binary artifacts for private build paths or credentials.

**Acceptance:** honest pass/fail/skip report for every gate, including per-process memory, latency, retention, and platform status. If a dependency/platform/UI/release credential is unavailable, report that exact gap. Do not label the migration complete or change the default without reviewer/user acceptance. No publish/push action is authorized by this packet.
