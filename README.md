# D2 Language Support

This VS Code extension provides an initial Language Server Protocol
implementation for [D2](https://d2lang.com/):

- completion for D2 keywords, shapes, style properties, and indexed objects;
- nested completion for paths such as `a.b.`; and
- go to definition for object paths, imports, and reusable classes;
- compiler-backed and local diagnostics;
- hover documentation, document/workspace symbols, references, and rename;
- document formatting and quick fixes;
- D2 snippets and an optional live SVG preview using the D2 CLI.

## Development

```sh
npm install
npm run build
npm test
```

Press `F5` in VS Code to launch an Extension Development Host, then open a
`.d2` file.

Set `d2LanguageSupport.d2Path` if the `d2` executable is not on `PATH`.
`D2: Open Preview` renders the saved active document using the configured CLI.

The implementation follows D2's documented nested object syntax, shape and
style fields, connection model, classes, and imports. The server intentionally
indexes incomplete documents so completion and navigation remain useful while
editing.
