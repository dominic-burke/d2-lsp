# D2 Language Support

Language Server Protocol support for [D2](https://d2lang.com/), the
diagrams-as-code language, in Visual Studio Code.

## Features

- **Completion** for D2 keywords, shapes, style properties, and objects already
  defined in the document, including nested paths such as `a.b.`.
- **Diagnostics** from two sources: fast local checks (unknown shapes and style
  properties, unresolved imports, duplicate objects) and the D2 compiler itself
  when the `d2` CLI is available.
- **Navigation**: go to definition for object paths, imports, and reusable
  classes; find references; rename; document and workspace symbols.
- **Hover** documentation for keywords, shapes, style properties, classes, and
  objects.
- **Formatting** for the whole document, plus quick fixes for empty `shape`
  values and unknown classes.
- **Snippets** for shapes, connections, classes, and SQL tables.
- **Live SVG preview** of the saved document, rendered by the D2 CLI.

## Requirements

The extension works without the D2 CLI, but compiler diagnostics and the SVG
preview need it. Install D2 from [d2lang.com](https://d2lang.com/tour/install)
and make sure `d2` is on your `PATH`.

## Installation

This extension is not published to the VS Code Marketplace. To use it, build it
from source:

```sh
git clone https://github.com/dominic-burke/d2-lsp.git
cd d2-lsp
npm install
npm run build
```

Then press `F5` in VS Code to launch an Extension Development Host with the
extension loaded, and open a `.d2` file.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `d2LanguageSupport.d2Path` | `d2` | Path to the D2 CLI executable. |
| `d2LanguageSupport.previewOnSave` | `false` | Refresh the preview when a D2 document is saved. |

## Commands

| Command | Description |
| --- | --- |
| `D2: Open Preview` | Render the saved active document to SVG in a side panel. |

The preview renders the file on disk, so save before running it.

## Development

Requires Node.js 18 or newer.

```sh
npm install
npm run build   # compile TypeScript to dist/
npm test        # run the test suite
```

The test suite covers the parser, indexer, diagnostics, formatter, and
completion logic. It does not require the D2 CLI.

CI runs the build and tests on Node 18, 20, and 22 on Linux, plus Node 22 on
Windows and macOS, and verifies that the extension packages with `vsce`.

## How it works

The extension is split into a VS Code client (`src/client`) and a language
server (`src/server`) that communicate over stdio.

The server keeps a per-document index built by `indexDocument`. The indexer is
deliberately tolerant: it indexes incomplete and syntactically invalid documents
so that completion and navigation keep working while you type. It masks string
contents and comments before looking for structural characters, so `:` or `{`
inside a label or a `|md` block does not confuse the parser.

Local diagnostics are computed from that index. Compiler diagnostics shell out to
`d2 validate -` and are debounced, so the CLI is not invoked on every keystroke.

## Known limitations

- The preview requires the document to be saved; untitled buffers are not
  rendered.
- Remote imports (`...@https://...`) are ignored: they are neither resolved nor
  reported. D2 itself rejects them, so this only affects documents that would
  not compile anyway.
- The indexer is not a full D2 parser. It recognises the syntax needed for
  editing assistance rather than validating the grammar.

## License

[MIT](LICENSE)
