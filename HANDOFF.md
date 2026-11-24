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

`markdownHeader` extracts a complete leading triple-quoted (`"""`)
header, allowing a BOM, blank lines, and CRLF. Its body is inserted as executable
Typst after the default page rule and before cmarker. The rest stays Markdown.
Incomplete headers, all backtick code fences, and headers later in the document are
not executed. This allows `#let`, `#set`, and `#show` without interpreting ordinary
Markdown as Typst. These declarations are used by the preamble; the math callback's
`eval` does not automatically capture user-defined lexical variables.

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

## Embedded Typst completions

`typstCompletionRegion` recognizes the leading triple-quoted preamble (including
an unfinished one) and dollar math outside prose/code. `completionProjection`
copies only the active region into a separate `.zed-completion.typ` memory file,
masking other UTF-16 code units with spaces and preserving CRLF. Double dollars
become Typst's `$ … $` without shifting positions; unfinished math gets a synthetic
closing delimiter after the source. Math projections omit the header's lexical
scope, matching the renderer's isolated `eval`.

The proxy forwards `textDocument/completion` at the unchanged source position.
Tinymist's manual preview focus prevents opening this virtual document from taking
over the browser. Completion documents are reused with monotonic internal versions
and closed with the Markdown buffer. Original buffer-version checks reject stale
responses. Outside supported regions, this provider returns no suggestions.

Completion results preserve snippets, normalize list edit defaults, and validate
ordinary/insert-replace ranges and additional edits against the active region.
Out-of-region edits are discarded along with the candidate that requires them.
Commands and lazy-resolve data are removed. A Tinymist 0.14 font-completion quirk
is corrected by replacing the active quoted header string with the selected
literal. Completion capability is advertised only for the Markdown branch; the
existing Typst server behavior is unchanged.

The region scanner deliberately supports common Markdown constructs, not a full
Obsidian parser. Single-dollar regions stop at a newline; incomplete numeric
expressions are treated conservatively as possible currency.

## Isolation and navigation

Markdown formatting and unsupported text-document requests are answered locally.
Completion requests alone are projected and forwarded to Tinymist.
Generated diagnostics and compile-status messages are suppressed; server-initiated
edits, document opening, and dynamic registration are blocked. Preview clicks do
not move the Markdown cursor. Edit-follow scrolling does not enable cursor-follow.

Standalone Typst mode retains its existing behavior: highlight activity can
scroll the preview, and preview clicks can invoke the Zed CLI at a source position.
A short suppression interval prevents immediate cursor-follow bounceback.

The proxy adds an Open in Browser code action in both modes. Typst also exposes
Toggle Cursor Follow and Sync Cursor to Preview. Synthetic request IDs use the
`tpp-` prefix; their responses must never be forwarded to Zed as client responses.

## Editor pairing setup

`config/markdown-math-keymap.json` provides file-scoped `editor::InsertSnippet`
bindings for dollars, double quotes, parentheses, square brackets, and braces.
Tab stop 1 is between the signs; final tab stop 0 is after the closing sign.
Dollar signs are escaped in snippet syntax. The standard bracket shortcuts avoid
Markdown's `autoclose_before` restriction when the next character is `$`.

The LSP does not implement pairing: formatting edits cannot reliably control the
caret, and the extension API cannot register editor keybindings. Users merge this
optional configuration into their keymap. The context is limited to Markdown file
extensions and excludes Vim normal mode. These are unconditional insertion snippets
within those files; there is no syntax-aware closer skipping or selected-text wrap.
Native Typst pairing allows insertion before math and bracket closers through
`autoclose_before` in `languages/typst/config.toml`, including nested calls.
However, a separate installed Typst extension can own the language definition;
choosing `tinymist-preview` does not change that ownership. The portable
`config/typst-math-keymap.json` supplies provider-independent bracket snippets
for `.typ`/`.typst` files (all syntax regions, insert/replace modes). It leaves
native dollar/quote handling intact. Merge it into the user keymap; an extension
cannot install these bindings automatically. Config JSON and tab-stop placement
were checked; actual keypress behavior is a manual UI check.

## Verification and release preparation

Run the protocol tests and manual build commands in the README. Tests cover
Unicode and escaping, full/incremental changes, capability isolation, document
switching, edit-follow debounce, and rejecting stale scroll/completion results. Tests also cover incomplete headers
and math, code exclusions, Unicode positions, edit boundaries, and font insertion. Direct
Tinymist checks verified mixed Markdown/math compilation, unsaved virtual-buffer
updates, preview HTTP responses, metadata queries, and accepted scroll commands.
UI behavior remains a manual check; the user confirmed basic live rendering.

For release, review the source-only package, choose a project license, add public
manifest metadata if publishing to the registry, and validate on each supported
platform. Local binaries, build caches, downloaded grammars, and reference
checkouts are excluded from version control. Preserve third-party license notices.
