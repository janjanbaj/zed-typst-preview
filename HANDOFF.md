# Architecture and maintenance

## Components

| File | Responsibility |
|---|---|
| `extension.toml` | Registers Typst and Markdown preview language servers and the Typst grammar. |
| `src/lib.rs` | Launches the Node proxy and supplies Tinymist settings. Adds `--markdown` for the Markdown server. |
| `src/tinymist.rs` | Provisions Tinymist and writes the embedded proxy to the extension work directory. |
| `proxy.mjs` | Handles JSON-RPC framing, preview configuration, virtual Markdown documents, and browser controls. |
| `languages/typst/` | Typst language configuration, queries, and CLI export/watch tasks. |
| `tests/markdown-preview.test.mjs` | Protocol tests with a fake Tinymist process. |

There are no external npm dependencies. The Rust extension uses
`zed_extension_api` 0.7.0. The downloaded Tinymist version is pinned to 0.14.10;
user-configured or PATH binaries take precedence.

## Startup and settings

The proxy allocates an ephemeral loopback port before reading client messages,
then starts `tinymist lsp`. It enables Tinymist's background preview with the
same port and disables color inversion. The first opened document schedules
browser opening after 800 ms, once per proxy session.

Preview configuration is injected into initialization options, configuration
notifications, and replies to `workspace/configuration`. Keep settings consistent
across these paths: changing preview configuration can restart Tinymist's
background preview and interrupt updates. When users provide both initialization
options and settings, those values should agree.

Extension work files live in Zed's managed extension work directory. The proxy
is written there on every server startup so rebuilding the extension refreshes
its embedded script. User settings and absolute machine paths are not part of
the source repository.

## Markdown rendering

The Markdown server tracks original buffers in a map. `didOpen` creates an
in-memory sibling URI ending in `.zed-preview.typ`; `didChange` updates the
buffer and sends a full replacement for the generated Typst source. Incremental
incoming edits are supported, although the server currently requests full sync.
Sibling paths let image resolution remain relative to the original file.

The wrapper calls cmarker 0.1.8 with `raw-typst: false`. A custom math callback
uses `eval(source, mode: "math")` inside `math.equation`, taking inline/display
mode from cmarker's callback argument. Automatic PDF export is disabled for
Markdown. Generated sources are not written to disk.

Markdown capabilities expose synchronization, code actions, and a document-highlight
provider that returns no ranges. Highlight and code-action activity selects the
active virtual document via `tinymist.focusMain`. Open/change messages reach
Tinymist before the focus command. Repeated focus requests for the same document
are deduplicated. This preserves the existing preview endpoint and browser page.
Zed does not provide a dedicated tab-focus notification through this integration.

## Edit-follow scrolling

For a changed buffer, a common-suffix comparison estimates the end of the latest
changed region. Its offset divided by document length gives a relative position.
After 200 ms without another edit, the proxy calls `tinymist.exportQuery` with
`write: false` to read a hidden `<zed-preview-bottom>` metadata element.

That metadata contains the buffer version and the rendered bottom position.
Query results arrive as base64 JSON in `result.data`. Once the version matches,
`tinymist.scrollPreview` receives `panelScrollByPosition` with `page_no`, `x`,
and a proportional `y`. The wrapper uses an auto-height page.

Stale versions are retried briefly, at most four queries per pending target.
New edits replace pending targets; changing or closing the active document cancels
them. Results for superseded targets are ignored. This is approximate scrolling,
not a source map. Repeated text and nonuniform rendered layouts affect accuracy.

## Isolation and navigation

Markdown formatting and other text-document requests are answered locally.
Generated diagnostics and compile-status messages are suppressed; server-initiated
edits, document opening, and dynamic registration are blocked. Preview clicks do
not move the Markdown cursor. Edit-follow scrolling does not enable cursor-follow.

Standalone Typst mode retains its existing behavior: highlight activity can
scroll the preview, and preview clicks can invoke the Zed CLI at a source position.
A short suppression interval prevents immediate cursor-follow bounceback.

The proxy adds an Open in Browser code action in both modes. Typst also exposes
Toggle Cursor Follow and Sync Cursor to Preview. Synthetic request IDs use the
`tpp-` prefix; their responses must never be forwarded to Zed as client responses.

## Verification and release preparation

Run the protocol tests and manual build commands in the README. Tests cover
Unicode and escaping, full/incremental changes, capability isolation, document
switching, edit-follow debounce, and rejecting stale scroll results. Direct
Tinymist checks verified mixed Markdown/math compilation, unsaved virtual-buffer
updates, preview HTTP responses, metadata queries, and accepted scroll commands.
UI behavior remains a manual check; the user confirmed basic live rendering.

For release, review the source-only package, choose a project license, add public
manifest metadata if publishing to the registry, and validate on each supported
platform. Local binaries, build caches, downloaded grammars, and reference
checkouts are excluded from version control. Preserve third-party license notices.
