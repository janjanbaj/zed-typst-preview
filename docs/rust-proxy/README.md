# Rust proxy handoff

**Status:** the native driver, Markdown/Typst routing, document transforms, and Zed launcher are implemented. Use the [native setup and test checklist](../../README.md#test-the-native-rust-proxy). Local selection is opt-in through `previewProxy.nativePath`.

Terminal acceptance on macOS ARM64 used Tinymist 0.14.10. The native executable passed 14 Rust tests and all 32 Node-run regression and process tests, including live diagnostics and completions. The Node fallback passed its 28 applicable tests. Zed UI and other platforms remain unverified. The planning documents below describe the original architecture and release gates. [macOS memory and latency trial](results/macos-arm64.md)

- Current behavior baseline: `ecd7898` (`main`), merged into `rust-proxy` in `8710f70`.
- Original plan and audit baseline: `0a366d8`. See the [baseline update](#baseline-update) before using the older line references.
- Implementation branch: `rust-proxy`, created from that baseline.
- Architect/reviewer: the coordinating agent. Implementation agents own only their assigned files.
- Goal: replace the external Node proxy with a native Rust executable while preserving the existing extension's behavior and measuring memory savings.

Read in this order:

1. [Implementation plan](IMPLEMENTATION_PLAN.md): architecture, scope, milestones, release gates.
2. [API and protocol contract](API_CONTRACT.md): exact proposed interfaces, messages, state, limits, and launcher configuration.
3. [Test plan](TEST_PLAN.md): required evidence and adversarial cases.
4. [Agent task packets](AGENT_TASKS.md): copy the shared instructions plus one task to an implementation agent.
5. [Adversarial audit](ADVERSARIAL_AUDIT.md): findings already incorporated into the contract, remaining risks, and audit method.

The source of truth is the contract plus the baseline implementation. Source line references refer to the frozen baseline, not future edited files. Use `git show 0a366d8:proxy.mjs` if line numbers move. Do not scan `target/`, `grammars/`, or `typst-preview.nvim/`.

Existing behavior is summarized in [HANDOFF.md](../../HANDOFF.md); user-facing setup is in [README.md](../../README.md). The JavaScript proxy remains the reference implementation and rollback path until the native release gates pass. Do not delete it or change the user's installed extension/keymap during implementation.

## Definition of complete

A native executable passes the shared behavior tests and the explicit hardening tests; the existing WASM extension can launch it through an opt-in path; real Tinymist checks preserve preview/completion behavior; shutdown leaves no child behind; measured proxy memory improves without material latency regression. Publishing binaries or changing the default launcher is a separate reviewed cutover, not implied by a passing local build.

## Baseline update

`673136c` added nested Typst bracket pairing through language configuration and the optional Typst keymap. Pairing belongs to Zed and needs no native proxy changes.

`ecd7898` added three behaviors required for native parity. These requirements supersede older descriptions of completion and diagnostic routing in the packet references.

| Layer | Required behavior and source |
|---|---|
| Document / Markdown scanner (B/C) | Normalize whitespace inside closed, nonempty inline dollar math in the render copy. Preserve original source, position offsets, code, header, and display math. See `proxy.mjs:22–75,106–179` at `ecd7898`. Have the renderer accept an optional check-file basename for the include. Share the Markdown region scanner with projections and history. |
| Completion and history (C/D) | Port the document-local term index and ranking in `math-history.mjs:55–235`. Track current text in both modes, refresh the index after 180 ms, discard it on close, and preserve the current bounds. Generate UTF-16 source edits, deduplicate against Tinymist labels, and handle the history item's resolve marker locally. Preserve upstream defaults and snippets. See `proxy.mjs:181–202,535–561,650–694,773–788`. |
| Markdown diagnostic mapping (C/D) | Generate the position-preserving check module from the original source. Open a fresh `.zed-math-<sequence>.typ` before sending the preview update that includes it. Close the previous check after that preview update. Clear original Markdown diagnostics on edits/close. Accept diagnostics only from the current module and clamp them to original math ranges. Drop unmapped reports and strip virtual-file related information/data. See `proxy.mjs:213–253,565–614,747–771`. |

Use the current Node suite as the oracle, including `tests/math-history.test.mjs`, `tests/math-history-protocol.test.mjs`, `tests/markdown-diagnostics.test.mjs`, and the expanded Markdown preview tests. Port their observable cases to shared native coverage. The original audit's stale-completion and completion-ID examples describe `0a366d8`; current Node guards completion responses by message kind and document identity. The native two-direction request ledger remains a separate requirement.
