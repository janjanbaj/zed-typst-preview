# Adversarial audit of the Rust proxy plan

**Scope:** architecture/contracts/tasks at frozen baseline `0a366d8`. This is an adversarial self-review by the coordinating architect, supplemented by two executable probes against the existing Node proxy. It is not an independent reviewer approval, a security certification, or a native implementation test result: no Rust proxy exists yet.

**Disposition:** ready for implementation in bounded packets. Default cutover remains blocked on the test, lifecycle, platform, and benchmark evidence specified below. Both experimentally confirmed baseline defects are explicitly superseded by the native contract; the baseline was not modified during planning.

## 1. Executed baseline probes

An ephemeral Node driver started the real baseline `proxy.mjs` against a test-owned fake Tinymist executable. It sent byte-framed JSON-RPC over stdio, disabled automatic browser launch, captured replies, and cleaned up processes/files. Both probes completed successfully. The driver was deliberately outside the repository; the portable reproductions must become R02/D06 tests in packet H, not depend on a developer's temporary files.

### A. Opposite-direction request ID collision — confirmed

Sequence:

1. Initialize Markdown mode; open a file containing `$fr$`, version 1.
2. Send client completion request with numeric ID 7.
3. Fake Tinymist emits a **request** `{id:7, method:"workspace/configuration", ...}` before its delayed completion response with ID 7.
4. Inspect both editor-facing messages.

Observed: the server request was consumed as a completion response, and the eventual actual response produced a second editor-facing reply with ID 7. The configuration request was not forwarded. This follows `proxy.mjs:655–672`, which checks completion IDs before checking message kind.

Required correction: classify method-bearing requests first; remap and track IDs independently in each direction. Tests R01/R02/R06 must distinguish `0`, `1`, `"1"`, reserved-looking strings, duplicate same-direction IDs, and valid opposite-direction overlap. Prefix conventions alone do not establish ownership.

### B. Close/reopen completion resurrection — confirmed

Sequence:

1. Open a URI with `$fr$`, version 1; request a completion with ID 7.
2. Delay the child result. Close the document, then reopen the **same URI and version 1** containing `$sq$`.
3. Deliver the old `frac` completion result.

Observed: the old `frac` result was accepted for the reopened file. The existing check compares only source version (`proxy.mjs:659`); close removes the version map but does not establish a new document lifetime for pending requests.

Required correction: monotonic generation outside the document map; validate URI/generation/version/request token/projection revision; retire requests and release snapshots on close/supersession. D06/C07/C08/S04 cover equivalent completion and scroll races.

## 2. Attack review and contract changes

Severity refers to the consequence if an implementation omits the stated control. “Addressed in plan” does not mean implemented or tested in Rust.

| Severity | Attack / failure | Contract decision and required evidence |
|---|---|---|
| High | Emoji before cursor makes byte offsets appear valid but edits the wrong characters | Separate UTF-8 indices and UTF-16 positions; reject surrogate halves; mask by UTF-16 width. D01/D02/C03 and roundtrips. |
| High | In-flight projection changes while a result is delayed at the same source version | One active request per document; revision/token checks; retire once with null. C07/C08. |
| High | Dead child or blocked stdout/child stdin wedges the entire proxy | Dedicated writers, nonblocking enqueue, byte credits, explicit overload failure, child polling, bounded shutdown; no indefinite joins. O02/O03. |
| High | A length prefix or message burst allocates unlimited memory | Header/body limits before growth; fixed read chunks; byte-budgeted queues and bounded ledgers. F03/F04/O03. Encoded-byte caps do not claim exact heap bounds. |
| High | An unsafe completion uses additional edits, defaults, resolve data, or a synthetic closer to escape the math/header | Validate all required edits against original region/index; reject whole candidate; strip command/data and disable resolve. C04/C05. |
| High | Path/URL characters are interpreted by a shell | Literal Command argv; generated loopback URL only; source location is one argument; no shell string. O01/O04; Windows behavior still needs testing. |
| High | False “Rust saves RAM” result compares proxy RSS with Tinymist or another metric | Five paired runs, separate processes, equal fixtures/warmup/metrics, raw results and retention/latency gates. No default change on inconclusive data. |
| Medium | A capability-shaped ordinary result gets rewritten as initialization | Tag the actual initialize ledger entry; scope mutation to it. R05. |
| Medium | Stale A → B → A query scrolls the wrong document or restarts retries | URI alone insufficient; generation/version/token validation and latest-target timers. S04. |
| Medium | Newline/CRLF or partial incremental failure corrupts source state | Atomic batch application, sequential changes, original line index, no CRLF normalization. D01/D02. |
| Medium | Parsing help/markdown flags consumes a Tinymist argument | Explicit `--` boundary, OsString argv, no shell splitting, CLI tests. |
| Medium | Old request tables retain entire source snapshots indefinitely | 30 s deadline, per-direction quota, separate synthetic quota, immediate snapshot release when obsolete. R03/R04/C08 plus retention benchmark. |
| Medium | Server requests silently stop working after universal ID remapping | Restore original IDs both ways, remap cancellation, timeout responses in their originating direction. R01–R06/T01. |
| Medium | Malformed JSON is forwarded as user text or a protocol error disappears on exit | Explicit -32700/-32600 classification; stderr-only corruption diagnostics; bounded output drain before termination. F04/O03. |
| Medium | Native override still downloads Node or replaces Tinymist binary.path | Separate nativePath, select before node_binary_path, preserve Tinymist resolver, no silent fallback. L01/L02. |
| Medium | Native dependencies accidentally get built for WASI | Workspace default-members root only; separate package-specific commands; preserve pinned extension API. L03. |
| Medium | Completion virtual document becomes the compiled preview entry | Open/focus preview before projection activity; verify real Tinymist manual-focus behavior. P03 plus real-engine test. |
| Medium | Test suite passes only JS helpers while release binary is broken | Shared black-box adapter must launch PROXY_BIN; independent fake framing and contract expectations. Packet H. |
| Medium | A local build claims six-platform support or ships private paths | Platform results remain explicit pass/fail/skip; inspect release artifacts; no downloader URL or publication invented. Packet G. |

## 3. Residual risks and explicit limits

- **Port selection race:** the temporary loopback bind must be released before Tinymist binds. Another process can take the port. Do not advertise exclusive reservation; report child startup failure and preserve the opt-in rollback. Solving atomic handoff requires a different Tinymist interface and is outside this port.
- **Memory ceilings:** serde JSON expansion, active documents, generated strings, and allocator overhead exceed encoded payload size. Queue limits prevent unbounded transport accumulation, not a fixed whole-process RAM cap. Measure representative fixtures and post-close retention. Do not lower frame limits just to manufacture benchmark savings.
- **Trusted local documents:** leading header Typst and cmarker compilation retain existing local file/package/font access. This migration creates no new sandbox. Preserve the current raw-comment restriction and document behavior; do not claim untrusted-document isolation.
- **Approximate navigation:** edit-follow remains proportional to rendered height, not a source map. Switching relies on the document activity Zed actually sends; there is no new active-tab callback. Do not claim exact cursor synchronization in Markdown.
- **Completion scope:** header declarations do not enter the separate math eval scope. A port must not invent suggestions whose accepted source fails in the preview. Obsidian-specific semantics remain deferred.
- **Platform helpers:** executable launch and source-jump quoting must be checked on real Windows/Linux/macOS targets. An argument-array design removes shell concatenation but does not prove platform helper behavior.
- **Forward compatibility:** pinned Tinymist/cmarker behavior is the target. A PATH-provided different Tinymist version may behave differently. Record the tested version; engine upgrades need separate review.
- **Performance tradeoff:** standard threads avoid an async dependency tree, but memory/latency improvement is a hypothesis until measured. Retain Node as default unless the agreed gates pass.
- **Distribution:** local nativePath is the initial integration. Artifact hosting, checksum policy, licensing, and registry metadata require real project decisions before a default downloader or release.

## 4. Reviewer stop gates

Reject an implementation handoff if any of these holds:

1. No actual native-binary tests, or baseline defects relabeled “parity.”
2. Raw byte/scalar offsets used as LSP columns; missing close/reopen and ID-collision cases.
3. Main writes directly to a pipe, waits on queue capacity, joins blocked readers/writers, or cannot demonstrate child cleanup.
4. Unbounded requests/snapshots/channels; capacity errors silently drop live replies; message-size limits are allocated eagerly.
5. Generic executeCommand forwarding enabled in Markdown, generated edits escape their region, or completion/header semantics expanded without review.
6. Node removed, launcher switched by default, user settings modified, or release URLs invented before evidence exists.
7. Memory savings reported without raw paired samples, per-process attribution, latency, and retention results.

The coordinating reviewer should inspect the connected modules and test observations at each packet boundary. A future final review should repeat these attacks independently of the author before recommending cutover.
