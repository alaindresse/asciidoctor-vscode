import { posix as posixpath } from 'path'
import vscode, { Uri } from 'vscode'

/**
 * Find files across all workspace folders in the workspace using a glob expression.
 * @param glob A glob pattern that defines the files to search for.
 */
export async function findFiles(glob: string): Promise<Uri[]> {
  return vscode.workspace.findFiles(glob)
}

// ---------------------------------------------------------------------------
// Antora-specific cached variants
// ---------------------------------------------------------------------------

const ANTORA_CONTENT_GLOB =
  'modules/*/{attachments,examples,images,pages,partials,assets}/**'

/** Cached list of antora.yml URIs (undefined = not yet fetched). */
let antoraConfigFilesCache: Uri[] | undefined

/** Cached content-file results keyed by the full glob string. */
const antoraContentFilesCache = new Map<string, Uri[]>()

/** Module-level disposables (watchers + their event subscriptions). */
const _disposables: vscode.Disposable[] = []

/** True once the config-file watcher has been created. */
let _configWatcherCreated = false

/** True once the content-file watcher has been created. */
let _contentWatcherCreated = false

/**
 * Returns the content-files glob cache key that corresponds to a given
 * antora.yml URI — i.e. the same key that {@link findAntoraContentFiles}
 * would use when called for that component root.  Returns `undefined` when
 * the URI does not belong to any known workspace folder.
 */
function contentGlobForConfigUri(configUri: Uri): string | undefined {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(configUri)
  if (workspaceFolder === undefined) {
    return undefined
  }
  // The component root is the directory that contains antora.yml.
  const contentSourceRootPath = configUri.path.slice(0, configUri.path.lastIndexOf('/'))
  const workspaceRelative = posixpath.relative(workspaceFolder.uri.path, contentSourceRootPath)
  return workspaceRelative
    ? `${workspaceRelative}/${ANTORA_CONTENT_GLOB}`
    : ANTORA_CONTENT_GLOB
}

function ensureAntoraConfigWatcher(): void {
  if (_configWatcherCreated) {
    return
  }
  _configWatcherCreated = true

  const watcher = vscode.workspace.createFileSystemWatcher('**/antora.yml')
  _disposables.push(
    watcher,
    watcher.onDidCreate(async (uri) => {
      // Surgically add the new config URI without discarding the whole cache.
      if (antoraConfigFilesCache !== undefined) {
        antoraConfigFilesCache = [...antoraConfigFilesCache, uri]
      }
      // Pre-populate (or refresh) the content-files entry for this component.
      const glob = contentGlobForConfigUri(uri)
      if (glob !== undefined) {
        antoraContentFilesCache.set(glob, await vscode.workspace.findFiles(glob))
      }
    }),
    watcher.onDidDelete((uri) => {
      // Surgically remove the deleted config URI without discarding the whole cache.
      if (antoraConfigFilesCache !== undefined) {
        antoraConfigFilesCache = antoraConfigFilesCache.filter(
          (cached) => cached.toString() !== uri.toString(),
        )
      }
      // Drop the content-files entry that belonged to this component.
      const glob = contentGlobForConfigUri(uri)
      if (glob !== undefined) {
        antoraContentFilesCache.delete(glob)
      }
    }),
  )
}

function ensureAntoraContentWatcher(): void {
  if (_contentWatcherCreated) {
    return
  }
  _contentWatcherCreated = true

  const pattern = `**/${ANTORA_CONTENT_GLOB}`
  const watcher = vscode.workspace.createFileSystemWatcher(pattern)
  const invalidate = () => {
    antoraContentFilesCache.clear()
  }
  _disposables.push(
    watcher,
    watcher.onDidCreate(invalidate),
    watcher.onDidDelete(invalidate),
    watcher.onDidChange(invalidate),
  )
}

/**
 * Find all `antora.yml` config files in the workspace.
 *
 * Results are cached and automatically invalidated when antora.yml files are
 * created or deleted in the workspace.
 */
export async function findAntoraConfigFiles(): Promise<Uri[]> {
  if (antoraConfigFilesCache !== undefined) {
    return antoraConfigFilesCache
  }

  ensureAntoraConfigWatcher()
  antoraConfigFilesCache = await vscode.workspace.findFiles('**/antora.yml')
  return antoraConfigFilesCache
}

/**
 * Find all Antora content files (pages, images, partials, examples,
 * attachments, assets) for a given workspace-relative component root prefix.
 *
 * Results are cached per glob pattern and automatically invalidated when any
 * Antora content file is created, deleted, or modified.
 *
 * @param workspaceRelativePrefix Optional prefix relative to the workspace
 *   root (e.g. `"docs/api"`). When omitted the search covers the whole
 *   workspace.
 */
export async function findAntoraContentFiles(
  workspaceRelativePrefix?: string,
): Promise<Uri[]> {
  const glob = workspaceRelativePrefix
    ? `${workspaceRelativePrefix}/${ANTORA_CONTENT_GLOB}`
    : ANTORA_CONTENT_GLOB

  const cached = antoraContentFilesCache.get(glob)
  if (cached !== undefined) {
    return cached
  }

  ensureAntoraContentWatcher()
  const files = await vscode.workspace.findFiles(glob)
  antoraContentFilesCache.set(glob, files)
  return files
}

/**
 * Dispose all file-system watchers created by the caching helpers and clear
 * all cached results. Should be called when the extension deactivates.
 */
export function disposeAntoraFileWatchers(): void {
  for (const d of _disposables) {
    d.dispose()
  }
  _disposables.length = 0
  _configWatcherCreated = false
  _contentWatcherCreated = false
  antoraConfigFilesCache = undefined
  antoraContentFilesCache.clear()
}
