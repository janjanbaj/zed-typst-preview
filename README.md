# Typst Preview for Zed

Live browser previews for **Typst files and Markdown with Typst math**. Write
`$frac(1, 2)$` in Markdown and see the typeset result while you type, without
saving the file or rebuilding Zed.

The extension connects Zed to [Tinymist](https://github.com/Myriad-Dreamin/tinymist).
Markdown is rendered through [cmarker](https://typst.app/universe/package/cmarker/)
inside an in-memory Typst document. The browser shows the whole document using
Typst's layout; this does not modify Zed's built-in Markdown preview.

## Features

- Live updates from unsaved `.typ` and Markdown buffers.
- Native Typst math in Markdown `$...$` and `$$...$$` delimiters.
- Markdown headings, lists, tables, links, code blocks, and local images through cmarker.
- Light document colors, independent of the system's dark appearance.
- One preview page per language-server session that follows document activity.
- Approximate scrolling toward the latest Markdown edit, debounced by 200 ms.
- Tinymist completions inside Markdown math and triple-quoted headers.
- Browser reopening through editor code actions.
- Cursor following and preview-to-source navigation for standalone Typst files.

Markdown preview-to-source navigation is disabled because cmarker does not
provide an exact source map. Opening, editing, or moving the cursor in another
Markdown document selects it in the existing preview. Returning to an unchanged
tab may require a cursor move because Zed does not send a dedicated tab-focus
notification to this extension.

## Installation

This repository is intended for installation as a **development extension**;
it is not currently published to the Zed extension registry.

1. Install [Zed](https://zed.dev/) and Rust through [rustup](https://rustup.rs/).
2. Clone or extract the repository into a permanent directory.
3. In Zed, open **Extensions**, choose **Install Dev Extension**, and select that directory.
4. Add the following language-server settings if needed:

```json
{
  "languages": {
    "Typst": {
      "language_servers": ["tinymist-preview", "!tinymist", "..."]
    },
    "Markdown": {
      "language_servers": ["markdown-typst-preview", "..."]
    }
  }
}
```

Keep any other Markdown language servers you use. This extension's Markdown
server supplies preview controls and Typst completions in embedded regions;
it does not format Markdown or suggest Typst names in ordinary prose.

Zed provisions the Node.js runtime used by the proxy. Tinymist is downloaded
when no configured or installed binary is found. The first Markdown compilation
also downloads cmarker. Internet access is needed for these initial downloads.
The verified combination is Tinymist **0.14.10**, its Typst **0.14.2** engine,
and cmarker **0.1.8**. Binary selection includes macOS, Linux, and Windows;
validation so far has been on macOS.

See [Zed's development-extension instructions](https://zed.dev/docs/extensions/developing-extensions)
for Rust and grammar-build prerequisites. After updating this extension, run
**`zed: reload extensions`**, then reopen the document or restart its language server.

## Usage

Open a Markdown or Typst file. The browser preview opens automatically.
Try [examples/math.md](examples/math.md) for a small sample.
For Markdown, use Typst syntax inside the math delimiters:

```markdown
# Math notes

An inline fraction: $frac(1, 2)$.

$$
sum_(k=1)^n k = n(n+1)/2
$$
```

Markdown delimiters determine inline versus display math. LaTeX commands such as
`\frac` are not automatically converted into Typst syntax.

To reopen a closed preview, keep the document active and use:

- **Cmd+.** on macOS to open code actions, then select **Open in Browser**.
- Or **Cmd+Shift+P → `editor: toggle code actions` → Open in Browser**.

The action title is prefixed with **Markdown Typst Preview** or **Typst Preview**.
There is no separately registered top-level command-palette action. Preview ports
are allocated dynamically, so a hardcoded browser task will not reliably work.

## Per-document styling

Put one complete triple-quoted (`"""`) header at the beginning of the Markdown file
(before its heading; blank lines are allowed). It is removed from the rendered
Markdown and evaluated as a Typst preamble:

````markdown
"""
#let body-font = "New Computer Modern"
#let body-size = 14pt
#let line-gap = 0.8em
#let paragraph-gap = 1.2em

#set text(font: body-font, size: body-size)
#set par(leading: line-gap, spacing: paragraph-gap)
#show heading: set text(fill: navy)
"""

# My notes

An inline fraction: $frac(1, 2)$.
````

`leading` sets the gap between lines; `spacing` sets the gap between paragraphs.
`#let` defines values, and `#set` or `#show` applies them. These are ordinary Typst
rules, so text size also affects equations. To select a math font separately, use
`#show math.equation: set text(font: "New Computer Modern Math")`.
Fonts must be available to Tinymist; missing fonts can fall back to another font.

The header is executable Typst code, with the same file/package access as a
Typst document. Only a leading triple-quoted header is extracted. Backtick code fences remain
ordinary Markdown code blocks, including the former `typst-config` fence.
Triple-quoted text later in the file is not executed.
An unclosed header stays ordinary Markdown until closed; invalid Typst can leave
the last successful preview visible. See [examples/styled.md](examples/styled.md).

## Pairing math delimiters

Pairing and cursor placement are editor features, so this uses Zed keybindings
rather than the language server. Open **`zed: open keymap file`** and merge the
objects from [config/markdown-math-keymap.json](config/markdown-math-keymap.json)
into the existing outer array. Preserve your other keybindings.

Typing `$`, `"`, `(`, `[`, or `{` inserts both signs and places the cursor **inside**
the pair. Press **Tab** to move after the closing sign. Typing `$` twice creates
`$$...$$` with the cursor between the inner dollar signs. Bracket shortcuts also
work immediately before a closing `$`, where native Markdown pairing may skip.

The bindings apply to Markdown file extensions throughout the file, including
prose and code blocks. They are insertion snippets, not context-aware pair tracking
or selection-surround commands: typing another dollar or quote creates another
pair; use Tab to exit the current one. They preserve Vim normal-mode bindings.
Primes, inequalities, and Markdown table pipes are not assigned pairing shortcuts.
Standalone Typst files keep their existing native pairing.

## Suggestions in Markdown

The Markdown preview server also provides Tinymist completions when the cursor
is inside the leading triple-quoted header or `$...$` / `$$...$$` math. After
reloading extensions, try typing `fr` inside math for `frac`, or `#set te` in the
header for `text`. Font-name suggestions are available in `#set text(font: "...")`.
Variables declared earlier in the header can be completed later in that header.

Suggestions work before the closing math delimiter or header quotes are typed.
Ordinary prose, inline code, backtick/tilde code fences, and indented code do not
activate this provider. Existing Markdown servers keep their own completions.

Only edits within the active embedded region are accepted. Completion commands,
lazy resolution, and suggestions requiring edits elsewhere are omitted. This adds
completions, not signature-help popups, hover, formatting, or Markdown diagnostics.
Header variables are not automatically available inside equations: the rendering
callback evaluates math in a separate scope, and math suggestions follow that scope.
Single-dollar completions are limited to the current line; use `$$` for multiline
math. Currency detection is conservative, so an unfinished expression beginning
with a number may need its closing `$` before suggestions activate.

## Configuration

Configure the servers independently under `lsp.markdown-typst-preview` and
`lsp.tinymist-preview`. To stop automatic browser opening for Markdown:

```json
{
  "lsp": {
    "markdown-typst-preview": {
      "settings": {
        "previewProxy": { "openBrowser": false }
      }
    }
  }
}
```

`previewProxy.followCursor` controls cursor following for standalone Typst;
it is ignored for Markdown. `previewProxy.mode` accepts `document` or `slide`.
Use the same values in `settings` and `initialization_options` if supplying both.
A custom Tinymist executable can be selected through the server's `binary.path`.

## Limitations

- Edit-follow scrolling estimates position from source length and rendered
  height. Large images, tables, and uneven layouts reduce its accuracy.
- Invalid math can leave the last successful preview visible. Generated Typst
  diagnostics are suppressed for Markdown because their positions do not map back.
- Obsidian-specific syntax is not implemented. Remote images are not downloaded
  automatically, and cmarker raw-Typst comment injection is disabled.
- Different worktrees or language-server sessions can create separate previews.
- The extension starts local preview servers. Markdown source is passed to local
  Tinymist; the extension has no document-upload feature. Tinymist can download
  packages and use local fonts and files as part of compilation.

## Development

The existing manual build uses the `wasm32-wasip1` target:

```sh
rustup target add wasm32-wasip1
cargo build --release --target wasm32-wasip1 --locked
cp target/wasm32-wasip1/release/zed_typst_preview.wasm extension.wasm
node --test tests/markdown-preview.test.mjs
```

Zed's own development-extension builder may use a different WASI target depending
on its version. The `extension.wasm` file embeds `proxy.mjs`; rebuild it after
changing the proxy. Tests require Node.js with its built-in test runner and
permission to bind a loopback port. They use a fake Tinymist and do not open a browser.

[Architecture and maintenance notes](HANDOFF.md) explain the implementation.
[Work log](docs/WORK_LOG.md) records changes and validation.

## Sharing and attribution

Commit the source files and `Cargo.lock`. `.gitignore` excludes build outputs,
downloaded grammars, reference checkouts, local state, and environment files.
Compiled artifacts can contain local build paths; do not upload them unchecked.

The extension manifest intentionally omits author identity and repository URL.
Add public metadata and choose a project license before submitting to Zed's
extension registry. No project-wide license has been selected here.
Third-party notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
