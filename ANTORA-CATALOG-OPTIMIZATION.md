# Antora Content Catalog Optimization

## Problem

Every call to `getAntoraDocumentContext()` — triggered on each preview render and document
load — was performing a full rebuild of the Antora content catalog from scratch:

1. Scan the entire workspace for all `antora.yml` files.
2. For each Antora component, glob every file under `modules/*/` (pages, partials, examples,
   images, attachments).
3. Read the **full binary content** of every matched file into memory as a `Buffer`.
4. Pass the entire aggregate to `@antora/content-classifier` to build a `ContentCatalog`.
5. Look up the current document in the resulting catalog.

On a project with many components and files, steps 2–4 are expensive and were repeated on
every keystroke that triggered a re-render.

## Solution

Two complementary optimisations were applied.

### 1. Catalog caching with `FileSystemWatcher` invalidation

The `AntoraContext` (which wraps the `ContentCatalog`) is now stored in a module-level
variable and reused across calls. `FileSystemWatcher` instances invalidate the cache
whenever a relevant file changes, so the catalog is rebuilt only when the workspace
actually changes.

**Watchers registered (once, on first build):**

| Watcher glob | Reason |
|---|---|
| `**/antora.yml` | Component descriptor added, modified, or removed |
| `**/modules/**` | Any content file (page, partial, example, image, attachment) added, modified, or removed |

The per-document lookup (`contentCatalog.getByPath`) remains outside the cache and runs
on every call, as it is cheap and document-specific.

**Files changed:** [`src/features/antora/antoraDocument.ts`](src/features/antora/antoraDocument.ts)

### 2. Lazy content loading in the include processor

The catalog was previously built with the full content of every file loaded upfront, even
though file content is only needed when an `include::` directive is actually encountered
during rendering.

The catalog is now built with **empty `Buffer`s** (`Buffer.alloc(0)`) for all files.
When the Asciidoctor include processor resolves an `include::` directive, it checks whether
the target file's content is empty and, if so, reads the file **synchronously** using
`fs.readFileSync`. The loaded content is stored back on the catalog entry so that
subsequent renders of the same document (within the same cache lifetime) do not re-read
the file.

This means only files that are actually included during a render are ever read from disk.

**Why synchronous I/O here?**
The Asciidoctor include processor callback runs synchronously inside the Asciidoctor
parsing pipeline. Async I/O cannot be awaited at that point; only synchronous reads are
possible. `fs.readFileSync` is appropriate here because it is called only for files that
are genuinely needed, not for the entire component tree.

**Cross-platform path note:**
`src.absFsPath` (the OS-native filesystem path, e.g. `C:\…` on Windows) is stored
alongside the existing `src.abspath` (the POSIX URI path, e.g. `/c:/…` on Windows).
The lazy-load uses `absFsPath` first, falling back to `abspath` for backwards
compatibility. On macOS and Linux the two values are identical.

**Files changed:**
- [`src/features/antora/antoraDocument.ts`](src/features/antora/antoraDocument.ts) — emit empty buffers, store `absFsPath`
- [`src/features/antora/resolveIncludeFile.ts`](src/features/antora/resolveIncludeFile.ts) — lazy-load on demand

## Before / After

| Scenario | Before | After |
|---|---|---|
| First preview open | Read all N files | Glob only (no reads); reads only on `include::` |
| Subsequent preview (no file changes) | Read all N files again | Reuse cached catalog; reads only new `include::` targets |
| File saved → re-render | Read all N files again | Invalidate cache, then as per "first preview" |
| Deeply nested includes | Read all N files | Read only the included chain, synchronously, one file at a time |

## Configuration

### `asciidoc.antora.excludePathsMatching`

An array of regular expression strings. Any `antora.yml` file whose URI path matches at
least one pattern is silently ignored when building the content catalog. Because content
files are only loaded for components whose `antora.yml` is accepted, matching an
`antora.yml` implicitly excludes all content files in that component tree.

**Default:** `["node_modules"]`

**Example** — also exclude a vendor directory and a CI output path:

```json
"asciidoc.antora.excludePathsMatching": [
  "node_modules",
  "/vendor/",
  "/ci-output/"
]
```

The patterns are matched against the full POSIX URI path of each `antora.yml` file
(forward slashes on all platforms). Patterns are compiled as `new RegExp(pattern)`, so
standard JavaScript regex syntax applies.

## Known limitations

- **Page attributes in front matter** (e.g. `page-` attributes set via AsciiDoc header in
  partial files) are not extracted by the content classifier at catalog-build time, because
  the file content is empty at that point. These attributes are handled correctly at
  render time via the include processor, but are unavailable to any feature that queries
  the catalog directly before a render occurs (e.g. completion providers). This is
  considered an acceptable trade-off for the performance improvement.

- The `FileSystemWatcher` instances are not explicitly disposed when the extension
  deactivates. VSCode disposes all extension resources on deactivation, so this is benign
  in practice.
