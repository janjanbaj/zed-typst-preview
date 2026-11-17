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

## Repository preparation

Replaced machine-specific handoff notes with portable architecture documentation.
Removed placeholder author/repository identity from the extension manifest. Added
source-sharing exclusions and preserved the MIT notice for the Typst grammar queries.
Local compiled artifacts and reference checkouts are not included in the source archive.
