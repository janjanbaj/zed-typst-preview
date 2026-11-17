# Third-party notices

Public upstream attribution is retained; it is not the local user's identity.

## Typst grammar and editor queries

The extension references [uben0/tree-sitter-typst](https://github.com/uben0/tree-sitter-typst)
at revision `abe60cbed7986ee475d93f816c1be287f220c5d8`. Editor queries include
material derived from that project; existing source attribution is preserved.
Its MIT license notice is reproduced in
[licenses/tree-sitter-typst-MIT.txt](licenses/tree-sitter-typst-MIT.txt).

## Runtime dependencies

- [Tinymist](https://github.com/Myriad-Dreamin/tinymist): language server and browser preview.
- [Typst](https://github.com/typst/typst): typesetting engine used by Tinymist.
- [cmarker](https://github.com/SabrinaJewson/cmarker.typ): Markdown rendering, pinned to 0.1.8.
- [Zed](https://github.com/zed-industries/zed): editor and Rust extension API.

Their source and license notices are maintained by their upstream projects.
This source archive does not bundle their downloaded executables or packages.
Rust dependencies are recorded in `Cargo.lock`.

The local `typst-preview.nvim` reference checkout is not included in this package.
No project-wide license is assigned by this notice.
