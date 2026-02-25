import * as contentClassifier from '@antora/content-classifier'
import fs from 'fs'
import yaml from 'js-yaml'
import { posix as posixpath } from 'path'
import vscode, { CancellationTokenSource, FileType, Memento, Uri } from 'vscode'
import { dir, exists } from '../../util/file'
import {
  findAntoraConfigFiles,
  findAntoraContentFiles,
} from '../../util/findFiles'
import { getWorkspaceFolder } from '../../util/workspace'
import {
  AntoraConfig,
  AntoraContext,
  AntoraDocumentContext,
  AntoraSupportManager,
} from './antoraContext'

const classifyContent = contentClassifier.default || contentClassifier

const MAX_DEPTH_SEARCH_ANTORA_CONFIG = 100

// ---------------------------------------------------------------------------
// Content-aggregate cache
// ---------------------------------------------------------------------------

/** Glob pattern for the aggregate content-file watcher (all Antora families). */
const ANTORA_CONTENT_WATCHER_GLOB =
  '**/modules/*/{attachments,examples,images,pages,partials,assets}/**'

/** Shape of a single file entry inside a content-aggregate component bucket. */
type AggregateFile = {
  base: string
  path: string
  contents: Buffer | null
  extname: string
  stem: string
  src: {
    abspath: string
    basename: string
    editUrl: string
    extname: string
    path: string
    stem: string
  }
}

type ContentAggregateCache = {
  /**
   * Per-component descriptor objects WITHOUT the `files` property.
   * Stored separately because `classifyContent` mutates `componentVersionData.files = undefined`
   * to free memory, which would corrupt the cache if we stored the full entry objects.
   */
  descriptors: any[]
  /**
   * Per-component file lists, parallel to `descriptors`.
   * `filesByComponent[i]` is the files array for `descriptors[i]`.
   * Kept separate so watchers can update files without touching the descriptors.
   */
  filesByComponent: AggregateFile[][]
  /**
   * Parallel to `descriptors`: `rootPaths[i]` is the contentSourceRootPath
   * (POSIX) for `descriptors[i]`.  Used to route watcher events to the right
   * component bucket.
   */
  rootPaths: string[]
  /** Maps uri.path (POSIX abs path) → uri.fsPath (platform path) for lazy loaders. */
  fsPathByAbsPath: Map<string, string>
}

let _aggregateCache: ContentAggregateCache | undefined
let _aggregateWatchersCreated = false
const _aggregateDisposables: vscode.Disposable[] = []

/** Construct the file-object shape that classifyContent expects. */
function buildAggregateFile(fileUri: Uri, contentSourceRootPath: string): AggregateFile {
  const absPath = fileUri.path
  const extname = posixpath.extname(absPath)
  const stem = posixpath.basename(absPath, extname)
  return {
    base: contentSourceRootPath,
    path: posixpath.relative(contentSourceRootPath, absPath),
    contents: null,
    extname,
    stem,
    src: {
      abspath: absPath,
      basename: posixpath.basename(absPath),
      editUrl: '',
      extname,
      path: absPath,
      stem,
    },
  }
}

function ensureAggregateWatchers(): void {
  if (_aggregateWatchersCreated) {
    return
  }
  _aggregateWatchersCreated = true

  // --- content-file watcher: surgical cache updates ---
  const contentWatcher = vscode.workspace.createFileSystemWatcher(ANTORA_CONTENT_WATCHER_GLOB)
  _aggregateDisposables.push(
    contentWatcher,
    contentWatcher.onDidCreate((uri) => {
      if (_aggregateCache === undefined) {
        return
      }
      const { filesByComponent, rootPaths, fsPathByAbsPath } = _aggregateCache
      const absPath = uri.path
      const idx = rootPaths.findIndex((r) => absPath.startsWith(r + '/'))
      if (idx !== -1) {
        filesByComponent[idx].push(buildAggregateFile(uri, rootPaths[idx]))
        fsPathByAbsPath.set(absPath, uri.fsPath)
      }
    }),
    contentWatcher.onDidChange((uri) => {
      if (_aggregateCache === undefined) {
        return
      }
      const absPath = uri.path
      for (const files of _aggregateCache.filesByComponent) {
        const file = files.find((f: AggregateFile) => f.src.abspath === absPath)
        if (file !== undefined) {
          // Reset to unloaded so the next classification picks up fresh contents.
          file.contents = null
          break
        }
      }
    }),
    contentWatcher.onDidDelete((uri) => {
      if (_aggregateCache === undefined) {
        return
      }
      const { filesByComponent, rootPaths, fsPathByAbsPath } = _aggregateCache
      const absPath = uri.path
      const idx = rootPaths.findIndex((r) => absPath.startsWith(r + '/'))
      if (idx !== -1) {
        filesByComponent[idx] = filesByComponent[idx].filter(
          (f: AggregateFile) => f.src.abspath !== absPath,
        )
        fsPathByAbsPath.delete(absPath)
      }
    }),
  )

  // --- antora.yml watcher: invalidate whole cache when component configs change ---
  const configWatcher = vscode.workspace.createFileSystemWatcher('**/antora.yml')
  _aggregateDisposables.push(
    configWatcher,
    configWatcher.onDidCreate(() => { _aggregateCache = undefined }),
    configWatcher.onDidDelete(() => { _aggregateCache = undefined }),
    configWatcher.onDidChange(() => { _aggregateCache = undefined }),
  )
}

export function disposeContentAggregateCache(): void {
  for (const d of _aggregateDisposables) {
    d.dispose()
  }
  _aggregateDisposables.length = 0
  _aggregateWatchersCreated = false
  _aggregateCache = undefined
}

// ---------------------------------------------------------------------------

export async function findAntoraConfigFile(
  textDocumentUri: Uri,
): Promise<Uri | undefined> {
  const asciidocFilePath = posixpath.normalize(textDocumentUri.path)
  const cancellationToken = new CancellationTokenSource()
  cancellationToken.token.onCancellationRequested((e) => {
    console.log('Cancellation requested, cause: ' + e)
  })
  const antoraConfigUris = await findAntoraConfigFiles()
  // check for Antora configuration
  for (const antoraConfigUri of antoraConfigUris) {
    const antoraConfigParentDirPath = antoraConfigUri.path.slice(
      0,
      antoraConfigUri.path.lastIndexOf('/'),
    )
    const modulesDirPath = posixpath.normalize(
      `${antoraConfigParentDirPath}/modules`,
    )
    if (
      asciidocFilePath.startsWith(modulesDirPath) &&
      asciidocFilePath.slice(modulesDirPath.length).match(/^\/[^/]+\/pages\/.*/)
    ) {
      console.log(
        `Found an Antora configuration file at ${antoraConfigUri.path} for the AsciiDoc document ${asciidocFilePath}`,
      )
      return antoraConfigUri
    }
  }
  const antoraConfigPaths = antoraConfigUris.map((uri) => uri.path)
  console.log(
    `Unable to find an applicable Antora configuration file in [${antoraConfigPaths.join(', ')}] for the AsciiDoc document ${asciidocFilePath}`,
  )
  return undefined
}

export async function antoraConfigFileExists(
  textDocumentUri: Uri,
): Promise<boolean> {
  const workspaceFolderUri =
    vscode.workspace.getWorkspaceFolder(textDocumentUri)?.uri
  let currentDirectoryUri = dir(textDocumentUri, workspaceFolderUri)
  let depth = 0
  let antoraConfig: vscode.Uri
  while (
    currentDirectoryUri !== undefined &&
    depth < MAX_DEPTH_SEARCH_ANTORA_CONFIG
  ) {
    depth++
    const antoraConfigUri = vscode.Uri.joinPath(
      currentDirectoryUri,
      'antora.yml',
    )
    if (await exists(antoraConfigUri)) {
      // Important: some file system providers, most notably the built-in git file system provider,
      // return true when calling `exists` even if the file does not exist on the local file system.
      // The Git file system provider will also return an empty buffer when calling `readFile`!

      // antora.yml file must have a name and version key.
      // In other words, the file must not be empty to be valid!
      try {
        const content = await vscode.workspace.fs.readFile(antoraConfigUri)
        if (content.length > 0) {
          antoraConfig = antoraConfigUri
        }
      } catch (_e) {
        // ignore, assume that the file does not exist
      }
      break
    }
    currentDirectoryUri = dir(currentDirectoryUri, workspaceFolderUri)
  }
  return antoraConfig !== undefined
}

async function getAntoraConfigs(): Promise<AntoraConfig[]> {
  const cancellationToken = new CancellationTokenSource()
  cancellationToken.token.onCancellationRequested((e) => {
    console.log('Cancellation requested, cause: ' + e)
  })
  const antoraConfigUris = await findAntoraConfigFiles()
  // check for Antora configuration
  const antoraConfigs = await Promise.all(
    antoraConfigUris.map(async (antoraConfigUri) => {
      let config = {}
      const parentPath = antoraConfigUri.path.slice(
        0,
        antoraConfigUri.path.lastIndexOf('/'),
      )
      const parentDirectoryStat = await vscode.workspace.fs.stat(
        antoraConfigUri.with({ path: parentPath }),
      )
      if (
        parentDirectoryStat.type ===
          (FileType.Directory | FileType.SymbolicLink) ||
        parentDirectoryStat.type === FileType.SymbolicLink
      ) {
        // ignore!
        return undefined
      }
      try {
        config =
          yaml.load(await vscode.workspace.fs.readFile(antoraConfigUri)) || {}
      } catch (err) {
        console.log(
          `Unable to parse ${antoraConfigUri}, cause:` + err.toString(),
        )
      }
      return new AntoraConfig(antoraConfigUri, config)
    }),
  )
  return antoraConfigs.filter((c) => c) // filter undefined
}

export async function getAntoraConfig(
  textDocumentUri: Uri,
): Promise<AntoraConfig | undefined> {
  const antoraConfigUri = await findAntoraConfigFile(textDocumentUri)
  if (antoraConfigUri === undefined) {
    return undefined
  }
  let config = {}
  try {
    config = yaml.load(fs.readFileSync(antoraConfigUri.fsPath, 'utf8')) || {}
  } catch (err) {
    console.log(
      `Unable to parse ${antoraConfigUri.fsPath}, cause:` + err.toString(),
    )
  }
  return new AntoraConfig(antoraConfigUri, config)
}

export async function getAttributes(
  textDocumentUri: Uri,
): Promise<{ [key: string]: string }> {
  const antoraConfig = await getAntoraConfig(textDocumentUri)
  if (antoraConfig === undefined) {
    return {}
  }
  return antoraConfig.config.asciidoc?.attributes || {}
}

export async function getAntoraDocumentContext(
  textDocumentUri: Uri,
  workspaceState: Memento,
): Promise<AntoraDocumentContext | undefined> {
  const antoraSupportManager = AntoraSupportManager.getInstance(workspaceState)
  if (!antoraSupportManager.isEnabled()) {
    return undefined
  }
  try {
    ensureAggregateWatchers()

    let contentAggregate: any[]
    let fsPathByAbsPath: Map<string, string>

    if (_aggregateCache !== undefined) {
      // Reconstruct fresh entry objects each time so that classifyContent's
      // mutation (`componentVersionData.files = undefined`) does not corrupt
      // the cached file lists.
      contentAggregate = _aggregateCache.descriptors.map((desc, i) => ({
        ...desc,
        files: _aggregateCache!.filesByComponent[i],
      }))
      fsPathByAbsPath = _aggregateCache.fsPathByAbsPath
    } else {
      const antoraConfigs = await getAntoraConfigs()
      fsPathByAbsPath = new Map<string, string>()

      const rawEntries = await Promise.all(
        antoraConfigs
          .filter(
            (antoraConfig) =>
              antoraConfig.config !== undefined &&
              'name' in antoraConfig.config &&
              'version' in antoraConfig.config,
          )
          .map(async (antoraConfig) => {
            const workspaceFolder = getWorkspaceFolder(antoraConfig.uri)
            const workspaceRelative = posixpath.relative(
              workspaceFolder.uri.path,
              antoraConfig.contentSourceRootPath,
            )
            const contentSourceRootPath = antoraConfig.contentSourceRootPath
            const contentFilesUris = await findAntoraContentFiles(
              workspaceRelative || undefined,
            )
            for (const uri of contentFilesUris) {
              fsPathByAbsPath.set(uri.path, uri.fsPath)
            }
            const files = contentFilesUris.map((fileUri) =>
              buildAggregateFile(fileUri, contentSourceRootPath),
            )
            // Separate descriptor (without files) from files so that
            // classifyContent's mutation of `files` does not corrupt the cache.
            const descriptor = {
              name: antoraConfig.config.name,
              version: antoraConfig.config.version,
              ...antoraConfig.config,
            }
            return { descriptor, files, contentSourceRootPath }
          }),
      )

      const descriptors: any[] = []
      const filesByComponent: AggregateFile[][] = []
      const rootPaths: string[] = []
      for (const { descriptor, files, contentSourceRootPath } of rawEntries) {
        descriptors.push(descriptor)
        filesByComponent.push(files)
        rootPaths.push(contentSourceRootPath)
      }

      contentAggregate = descriptors.map((desc, i) => ({ ...desc, files: filesByComponent[i] }))
      _aggregateCache = { descriptors, filesByComponent, rootPaths, fsPathByAbsPath }
    }

    const contentCatalog = classifyContent(
      {
        site: {},
      },
      contentAggregate,
    )
    // Install a lazy `contents` accessor on every classified Vinyl file so
    // that the file is only read from disk when its contents are actually
    // needed (e.g. by the include processor), not during catalog construction.
    for (const file of contentCatalog.findBy({})) {
      const localFsPath = fsPathByAbsPath.get(file.src.abspath)
      if (!localFsPath) {
        continue
      }
      let lazyContents: Buffer | null = null
      let loaded = false
      Object.defineProperty(file, 'contents', {
        get(): Buffer | null {
          if (!loaded) {
            lazyContents = fs.readFileSync(localFsPath)
            loaded = true
          }
          return lazyContents
        },
        set(v: Buffer | null): void {
          lazyContents = v
          loaded = true
        },
        configurable: true,
        enumerable: true,
      })
    }
    const antoraContext = new AntoraContext(contentCatalog)
    const antoraResourceContext =
      await antoraContext.getResource(textDocumentUri)
    if (antoraResourceContext === undefined) {
      return undefined
    }
    return new AntoraDocumentContext(antoraContext, antoraResourceContext)
  } catch (err) {
    console.error(`Unable to get Antora context for ${textDocumentUri}`, err)
    return undefined
  }
}
