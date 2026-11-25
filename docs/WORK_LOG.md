# Work log

## Markdown preview

Reused the existing Zed → Node proxy → Tinymist → browser pipeline. Added a
separate Markdown language server, cmarker 0.1.8, and native Typst math callbacks.
Unsaved Markdown buffers become virtual sibling Typst documents without rewriting
source files. Formatting, generated diagnostics, and source navigation are isolated
from the Markdown editor. Obsidian-specific features remain deferred.

## Appearance and document selection

Disabled automatic color inversion so previews retain light document colors.
Added explicit Tinymist focus commands when documents open, change, or produce
highlight/code-action requests. The same preview session selects the new document.
An unchanged tab can still need a cursor move because there is no dedicated focus
notification. Existing code actions reopen the browser using its dynamic port.

## Approximate edit-follow

Added a 200 ms typing debounce and versioned, hidden layout metadata. The latest
edit's relative source position is mapped to rendered document height. Metadata
queries stay in memory. Version checks, bounded retries, and active-document checks
prevent older results from moving the preview after a newer edit or document switch.
This deliberately provides approximate scrolling rather than exact source mapping.

## Validation

- Automated protocol tests cover buffer updates, Unicode, capability isolation,
  document switching, edit-follow behavior, and stale result suppression.
- The release WebAssembly build completed successfully.
- Tinymist 0.14.10 / Typst 0.14.2 compiled cmarker documents with inline/display math,
  tables, and code blocks. Virtual-buffer edits changed rendered SVG output.
- The local preview endpoint responded; in-memory metadata queries and the scroll
  command were verified directly against Tinymist.
- The user confirmed basic live rendering. Subsequent appearance, switching, and
  scroll behavior remain available for manual UI testing.

## Per-document styling

Added an optional leading triple-quoted (`"""`) configuration header. Its hidden Typst preamble can
use `#let`, `#set`, and `#show` for fonts, text size, line/paragraph spacing, and
heading styling. All backtick code fences remain examples. Tests cover complete,
incomplete, empty, BOM, and CRLF headers. The styled Markdown example compiled
with the bundled Tinymist; UI validation is left to the user.

## Embedded Typst suggestions

Added completion capability to the Markdown server. Separate virtual Typst
projections preserve source positions while exposing only the active header or
math region to Tinymist. This works with unfinished delimiters. Prose/code are
excluded, stale responses are rejected, and edits are restricted to that region.
Font-name insertions inside partial strings are normalized for Tinymist 0.14.

Automated tests cover region detection, projection offsets, snippet/edit handling,
font replacement, stale replies, and virtual-document cleanup. Terminal checks
against Tinymist 0.14.10 returned actual `frac`, `sqrt`, `vec`, `text`, header-variable,
and font-name suggestions through the proxy. No browser UI was opened. Rendering
and completion documents remain separate, with the preview manually focused.

## Delimiter pairing

Added reusable Markdown-scoped keybindings for `$`, `"`, `(`, `[`, and `{`.
Each inserts a complete pair with the cursor at an interior tab stop and a final
Tab stop after the closing sign. This avoids LSP cursor-placement limitations and
native Markdown pairing restrictions before `$`. Existing shortcuts are preserved
when installing locally. Pairing configuration is separate from the extension's
language server and must be merged into the keymap by other users. JSON and snippet
positions were checked; UI testing remains manual.

## Repository preparation

Replaced machine-specific handoff notes with portable architecture documentation.
Removed placeholder author/repository identity from the extension manifest. Added
source-sharing exclusions and preserved the MIT notice for the Typst grammar queries.
Local compiled artifacts and reference checkouts are not included in the source archive.


## Native Rust proxy planning

- Froze the working extension at `0a366d8` on `main`; created `rust-proxy` for the migration.
- Added the [handoff package](rust-proxy/README.md): architecture, Rust interfaces, wire contracts, scoped task packets, tests, benchmark gates, and adversarial audit. No native proxy implementation or default launcher change was made.
- Two fake-server probes confirmed baseline request-ID collision and close/reopen stale-completion risks; the native contract requires fixes and regressions.
- Baseline checks passed: nine Node tests, Node syntax, diff whitespace, and release WASI build. No changes were pushed.


## Typst nested bracket pairing

Added native `autoclose_before` characters for math and bracket closers. Local
investigation showed that the separate Typst extension owns the language metadata,
so changing only this extension's language config does not affect that setup.
Added reusable `.typ`/`.typst` bracket insertion snippets and merged them into the
local keymap, preserving other bindings. Pairing is independent of the LSP;
no language server was disabled. JSON and tab stops were checked; user verifies
actual typing in Zed.


## Math history completions in Zed

Adapted the local Neovim math-history behavior into a dependency-free embedded JS
module. Both Typst and Markdown servers now add document-local contiguous math
terms, calls, scripts, and dotted variables to Tinymist's completion results.
Ranking uses match quality, occurrence count, and source recency. Source edits use
UTF-16 positions and plain-text insertion; local history items resolve locally.
Indexes refresh after 180 ms, are bounded, and are discarded on document close.
There is no persisted or cross-file history. Neovim files were read, not changed.

The Markdown scanner now exposes a shared region iterator; existing rendering and
completion rules retain regression coverage. New source identity/version checks
reject delayed completions after a document closes/reopens. Rust provisioning
writes both embedded JS modules on startup. README and HANDOFF describe setup,
limits, packaging, and tests.

Validation: 20 automated tests passed, including real proxy stdio in both modes;
syntax and whitespace checks passed; release WASI build passed. Terminal-only
checks against Tinymist v0.14.10 / Typst 0.14.2 returned history plus built-in
suggestions with correct source edits for both modes. No browser/editor UI was
operated. Rebuilt the local extension.wasm for the development extension; reload
it and restart language servers to activate. No changes were pushed.


## Padded Markdown math and editor diagnostics

Confirmed with cmarker 0.1.8 / Tinymist 0.14.10 that `$ H(t) $`, `$ H(t)$`, and
`$H(t) $` never reached the math callback, while `$H(t)$` and `$$ H(t) $$` did.
The underlying pulldown-cmark inline-math parser rejects boundary whitespace.
Closed single-dollar regions now have padding normalized in the render copy only;
source positions, header/code content, and double-dollar display mode are intact.

Added a hidden, source-position-preserving math-checking module included by the
preview compilation. Its current-revision diagnostics map back to Markdown math
as `Typst math` errors; reports clear on edits/close and obsolete unversioned
notifications are rejected using revision-specific virtual URIs. It uses the same
Tinymist process and writes no generated source files. Header and other rendering
errors remain unmapped; invalid math can keep the last successful preview visible.

Validation includes pure projection/normalization checks, fake-server stale-report
coverage, real cmarker callback-count/layout assertions, and a real Tinymist
unknown-variable diagnostic at the correct padded Markdown UTF-16 range. Existing
completion/history and preview regressions remain covered. No browser UI operated.

Final validation: all 27 tests passed with `TINYMIST_TEST_BINARY` pointing to
Tinymist 0.14.10, including real padding and source-diagnostic checks. The locked,
offline release WASI build and source whitespace/syntax checks passed. The local
`extension.wasm` was rebuilt; generated artifacts remain ignored by Git.

## Git checkpoint

Committed the Typst pairing changes separately from the document-local history,
padded-math rendering, and mapped math diagnostics. README, HANDOFF, and this log
record usage, architecture, validation, and current diagnostic limits. Work stays
on `main`; the `rust-proxy` planning branch is unchanged. No push was performed.

## Native proxy foundation

Merged `main` through `ecd7898` into `rust-proxy` and updated the parity requirements for math history, padded formulas, and mapped diagnostics. Added the host-only native crate, argument parser, bounded LSP frame decoder, and typed request IDs. Running an LSP session still requires the process and routing layers.

Validation passed for all 27 Node tests with Tinymist 0.14.10, eight native foundation tests, native Clippy and formatting, and the locked WASI release build.
