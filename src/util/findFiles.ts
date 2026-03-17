import * as fs from 'fs'
import * as path from 'path'
import vscode, { Uri } from 'vscode'

interface CacheEntry {
  uris: Uri[]
  watcher?: vscode.FileSystemWatcher
}

interface CacheFileFormat {
  version: number
  entries: Record<string, string[]>
}

const CACHE_FILENAME = 'findfiles-cache.json'
const SAVE_DEBOUNCE_MS = 30_000

const cache = new Map<string, CacheEntry>()
let storageDir: string | undefined
let saveTimer: ReturnType<typeof setTimeout> | undefined

/**
 * Initialize the findFiles cache from disk.
 * Call early in extension activation, before other registrations.
 */
export function initFindFilesCache (storageDirPath: string): void {
  storageDir = storageDirPath
  const cacheFilePath = path.join(storageDir, CACHE_FILENAME)

  try {
    const raw = fs.readFileSync(cacheFilePath, 'utf-8')
    const data: CacheFileFormat = JSON.parse(raw)
    if (data.version === 1 && data.entries) {
      for (const [glob, paths] of Object.entries(data.entries)) {
        cache.set(glob, {
          uris: paths.map((p) => Uri.file(p)),
        })
      }
    }
  } catch {
    // No cache file or invalid — start fresh
  }

  refreshCacheInBackground()
}

/**
 * Re-scan all disk-loaded patterns in the background, then persist.
 */
function refreshCacheInBackground (): void {
  const patterns = [...cache.keys()].filter((glob) => {
    const entry = cache.get(glob)
    return entry && !entry.watcher
  })

  if (patterns.length === 0) return

  // Fire off refreshes without blocking
  Promise.all(
    patterns.map(async (glob) => {
      const uris = await vscode.workspace.findFiles(glob, '**/node_modules/**')
      const watcher = createWatcher(glob)
      cache.set(glob, { uris, watcher })
    })
  ).then(() => {
    saveCacheToDisk()
  }).catch(() => {
    // Best-effort refresh
  })
}

function createWatcher (glob: string): vscode.FileSystemWatcher {
  const watcher = vscode.workspace.createFileSystemWatcher(glob)

  watcher.onDidCreate((uri) => {
    const entry = cache.get(glob)
    if (entry) {
      entry.uris.push(uri)
      scheduleDebouncedSave()
    }
  })
  watcher.onDidDelete((uri) => {
    const entry = cache.get(glob)
    if (entry) {
      entry.uris = entry.uris.filter((u) => u.toString() !== uri.toString())
      scheduleDebouncedSave()
    }
  })

  return watcher
}

function scheduleDebouncedSave (): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
  }
  saveTimer = setTimeout(() => {
    saveCacheToDisk()
    saveTimer = undefined
  }, SAVE_DEBOUNCE_MS)
}

function saveCacheToDisk (): void {
  if (!storageDir) return

  const entries: Record<string, string[]> = {}
  for (const [glob, entry] of cache.entries()) {
    entries[glob] = entry.uris.map((u) => u.fsPath)
  }

  const data: CacheFileFormat = { version: 1, entries }
  try {
    fs.writeFileSync(
      path.join(storageDir, CACHE_FILENAME),
      JSON.stringify(data),
      'utf-8'
    )
  } catch {
    // Best-effort persistence
  }
}

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
  const watcher = createWatcher(glob)

  cache.set(glob, { uris, watcher })
  scheduleDebouncedSave()
  return uris
}

/**
 * Dispose all cached watchers. Call on extension deactivation.
 */
export function disposeFindFilesCache (): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = undefined
  }
  saveCacheToDisk()
  for (const entry of cache.values()) {
    if (entry.watcher) {
      entry.watcher.dispose()
    }
  }
  cache.clear()
}
