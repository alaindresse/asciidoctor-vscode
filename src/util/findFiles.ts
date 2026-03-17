import vscode, { Uri } from 'vscode'

interface CacheEntry {
  uris: Uri[]
  watcher: vscode.FileSystemWatcher
}

const cache = new Map<string, CacheEntry>()

/**
 * Find files across all workspace folders in the workspace using a glob expression.
 * Results are cached and invalidated automatically via a FileSystemWatcher.
 * @param glob A glob pattern that defines the files to search for.
 */
export async function findFiles (glob: string): Promise<Uri[]> {
  const existing = cache.get(glob)
  if (existing) {
    return existing.uris
  }

  const uris = await vscode.workspace.findFiles(glob, '**/node_modules/**')
  const watcher = vscode.workspace.createFileSystemWatcher(glob)

  watcher.onDidCreate((uri) => {
    const entry = cache.get(glob)
    if (entry) {
      entry.uris.push(uri)
    }
  })
  watcher.onDidDelete((uri) => {
    const entry = cache.get(glob)
    if (entry) {
      entry.uris = entry.uris.filter((u) => u.toString() !== uri.toString())
    }
  })

  cache.set(glob, { uris, watcher })
  return uris
}

/**
 * Dispose all cached watchers. Call on extension deactivation.
 */
export function disposeFindFilesCache (): void {
  for (const entry of cache.values()) {
    entry.watcher.dispose()
  }
  cache.clear()
}
