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


## Typst nested bracket pairing

Added native `autoclose_before` characters for math and bracket closers. Local
investigation showed that the separate Typst extension owns the language metadata,
so changing only this extension's language config does not affect that setup.
Added reusable `.typ`/`.typst` bracket insertion snippets and merged them into the
local keymap, preserving other bindings. Pairing is independent of the LSP;
no language server was disabled. JSON and tab stops were checked; user verifies
actual typing in Zed.
