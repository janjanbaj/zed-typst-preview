# Rust proxy handoff

**Status:** planning only. No Rust proxy implementation has been started.

- Frozen working baseline: `0a366d87a95971cf7ee81091bbc62bfbf419a595` (`main`).
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

No changes were pushed as part of preparing this handoff. The plan commit follows the baseline on `rust-proxy`.
