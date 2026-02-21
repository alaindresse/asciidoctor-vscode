# Claude Code Project Context — asciidoctor-vscode

## What This Is
A VS Code extension that provides AsciiDoc language support: live preview, syntax highlighting, snippets, PDF/DocBook export, Antora integration, and diagram rendering (Kroki, Mermaid).

## Key Commands
```bash
npm run build          # Full build (assets + extension + preview)
npm run build-ext      # TypeScript only (fast iteration)
npm run build-preview  # Webpack for webview preview
npm test               # Run test suite
npm run package        # Package .vsix for marketplace
```

## Architecture

### Entry Points
- [src/extension.ts](src/extension.ts) — activates the extension, registers all providers/commands
- [src/asciidocEngine.ts](src/asciidocEngine.ts) — core Asciidoctor rendering engine
- [preview-src/](preview-src/) — webview UI (compiled separately via webpack)

### Source Layout
```
src/
├── commands/        # VSCode command handlers (exportAsPDF, showPreview, pasteImage, etc.)
├── features/        # Feature implementations
│   ├── antora/      # Antora multi-component doc support (context, completion, include resolution)
│   ├── preview*.ts  # Live preview management and content provider
│   ├── asciidoctor*.ts  # Config, extensions, diagnostics
│   └── document*.ts     # Symbol/link providers
├── providers/       # Completion/reference providers (xref, bibtex, asciidoc)
├── util/            # Shared utilities (path, file, document, workspace, links)
└── test/            # Mocha test suites
```

### Antora Integration (`src/features/antora/`)
The most complex subsystem. Handles multi-component documentation projects.
- [antoraContext.ts](src/features/antora/antoraContext.ts) — finds antora.yml configs, resolves component/version/module context for a document. Caches lookups.
- [antoraDocument.ts](src/features/antora/antoraDocument.ts) — wraps a document with its Antora context
- [antoraCompletionProvider.ts](src/features/antora/antoraCompletionProvider.ts) — xref/include completions using the content catalog
- [includeProcessor.ts](src/features/antora/includeProcessor.ts) — Asciidoctor include processor that resolves Antora resource IDs
- [resolveIncludeFile.ts](src/features/antora/resolveIncludeFile.ts) — resource ID → file path resolution

**Performance pattern**: catalog is lazy-loaded and cached per workspace; config lookups are cached with document-to-config maps. See [ANTORA-CATALOG-OPTIMIZATION.md](ANTORA-CATALOG-OPTIMIZATION.md) for details.

## Tech Stack
- **Language**: TypeScript, targeting ES2022 CommonJS (Node16 module resolution)
- **VS Code API**: `^1.88.0`
- **Asciidoctor**: `@asciidoctor/core` 2.2.7 via asciidoctor.js
- **Build**: `tsc` for extension, `webpack` for preview webview
- **Tests**: Mocha via `@vscode/test-electron`

## Important Conventions
- Extension code runs in Node.js context; preview code runs in a sandboxed webview (different build)
- Media assets (fonts, MathJax, Mermaid, HighlightJS) are vendored into `media/` — do not edit them directly
- Localization strings live in `l10n/`; use `vscode.l10n.t()` for user-facing strings
- Use `volta` for Node version management (pinned in package.json)

## Current Focus (active branch: feat/antora-catalog-lazy-load-and-cache)
Performance improvements to Antora catalog: lazy loading file content and caching config/catalog lookups to speed up large documentation projects.
