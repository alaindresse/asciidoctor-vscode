import * as contentClassifier from '@antora/content-classifier'
import fs from 'fs'
import yaml from 'js-yaml'
import { posix as posixpath } from 'path'
import vscode, { CancellationTokenSource, FileType, Memento, Uri } from 'vscode'
import { dir, exists } from '../../util/file'
import { findFiles } from '../../util/findFiles'
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
// Catalog cache
//
// Building the content catalog is expensive: it scans every antora.yml in the
// workspace and globs all files under modules/*/. We cache the resulting
// AntoraContext and update it surgically when individual files change, so the
// catalog is rebuilt only when the workspace structure changes (antora.yml
// added/removed/changed, or a content file created/deleted).
//
// File *contents* are intentionally NOT loaded upfront; the include processor
// lazy-loads them synchronously on demand (see resolveIncludeFile.ts). When a
// content file is saved, the watcher clears its cached contents so the next
// render re-reads the file from disk without rebuilding the whole catalog.
//
// Two additional Maps memoize the Antora config lookup that fires on every
// render, avoiding repeated glob scans and YAML reads:
//   antoraConfigFileCache  documentUri  → antora.yml Uri (or undefined)
//   antoraConfigCache      antora.yml Uri → AntoraConfig
// ---------------------------------------------------------------------------
let cachedAntoraContext: AntoraContext | undefined
let watchersInitialized = false
// document URI string → antora.yml Uri (undefined = not in any Antora component).
// Cleared when antora.yml files are created or deleted (mapping may change).
const antoraConfigFileCache = new Map<string, Uri | undefined>()
// antora.yml URI string → parsed AntoraConfig.
// Entry removed when that specific antora.yml changes.
const antoraConfigCache = new Map<string, AntoraConfig>()

/**
 * Returns compiled RegExp objects from the `asciidoc.antora.excludePathsMatching`
 * configuration setting. Any antora.yml URI whose path matches one of these patterns
 * is ignored when building the content catalog.
 */
function getAntoraExcludePatterns(): RegExp[] {
  const patterns = vscode.workspace
    .getConfiguration('asciidoc.antora')
    .get<string[]>('excludePathsMatching', ['node_modules'])
  return patterns.map((p) => new RegExp(p))
}

/**
 * Filters a list of URIs, removing any whose path matches one of the configured
 * exclude patterns (see `asciidoc.antora.excludePathsMatching`).
 */
function filterAntoraConfigUris(uris: Uri[]): Uri[] {
  const excludePatterns = getAntoraExcludePatterns()
  if (excludePatterns.length === 0) return uris
  return uris.filter((uri) => !excludePatterns.some((rx) => rx.test(uri.path)))
}

/**
 * Resets the module-level catalog cache.
 * Intended for use in tests only to ensure isolation between test cases.
 */
export function clearAntoraContextCache(): void {
  cachedAntoraContext = undefined
  antoraConfigFileCache.clear()
  antoraConfigCache.clear()
}

function setupCacheInvalidationWatchers(): void {
  if (watchersInitialized) return
  watchersInitialized = true

  const invalidateAll = () => {
    cachedAntoraContext = undefined
  }

  const configWatcher = vscode.workspace.createFileSystemWatcher('**/antora.yml')
  // A new antora.yml may claim documents that were previously unmapped.
  // Clear everything so the next render starts fresh.
  configWatcher.onDidCreate(() => {
    antoraConfigFileCache.clear()
    antoraConfigCache.clear()
    invalidateAll()
  })
  // Content changed: the cached AntoraConfig for this file is stale.
  // The document→antora.yml path mapping is unaffected (directory structure unchanged).
  configWatcher.onDidChange((uri) => {
    antoraConfigCache.delete(uri.toString())
    invalidateAll()
  })
  // Deleted antora.yml: documents that were mapped to it are now unmapped.
  configWatcher.onDidDelete((uri) => {
    antoraConfigFileCache.clear()
    antoraConfigCache.delete(uri.toString())
    invalidateAll()
  })

  const contentWatcher = vscode.workspace.createFileSystemWatcher('**/modules/**')

  // A modified file only changes its content, not the catalog structure.
  // Clear its cached contents so the include processor re-reads it on the next
  // render without triggering a full catalog rebuild.
  contentWatcher.onDidChange((uri) => {
    const context = cachedAntoraContext
    if (context === undefined) return
    const file = context.contentCatalog
      .getFiles()
      .find((f: any) => f.src.absFsPath === uri.fsPath)
    if (file) {
      file.contents = Buffer.alloc(0)
    }
  })

  // A created or deleted file changes the catalog structure — rebuild.
  contentWatcher.onDidCreate(invalidateAll)
  contentWatcher.onDidDelete(invalidateAll)
}

export async function findAntoraConfigFile(
  textDocumentUri: Uri,
): Promise<Uri | undefined> {
  const cacheKey = textDocumentUri.toString()
  if (antoraConfigFileCache.has(cacheKey)) {
    return antoraConfigFileCache.get(cacheKey)
  }
  const asciidocFilePath = posixpath.normalize(textDocumentUri.path)
  const cancellationToken = new CancellationTokenSource()
  cancellationToken.token.onCancellationRequested((e) => {
    console.log('Cancellation requested, cause: ' + e)
  })
  const antoraConfigUris = filterAntoraConfigUris(await findFiles('**/antora.yml'))
  let result: Uri | undefined
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
      result = antoraConfigUri
      break
    }
  }
  if (result === undefined) {
    const antoraConfigPaths = antoraConfigUris.map((uri) => uri.path)
    console.log(
      `Unable to find an applicable Antora configuration file in [${antoraConfigPaths.join(', ')}] for the AsciiDoc document ${asciidocFilePath}`,
    )
  }
  antoraConfigFileCache.set(cacheKey, result)
  return result
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
  const antoraConfigUris = filterAntoraConfigUris(await findFiles('**/antora.yml'))
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
  const cacheKey = antoraConfigUri.toString()
  if (antoraConfigCache.has(cacheKey)) {
    return antoraConfigCache.get(cacheKey)
  }
  let config = {}
  try {
    config = yaml.load(fs.readFileSync(antoraConfigUri.fsPath, 'utf8')) || {}
  } catch (err) {
    console.log(
      `Unable to parse ${antoraConfigUri.fsPath}, cause:` + err.toString(),
    )
  }
  const antoraConfig = new AntoraConfig(antoraConfigUri, config)
  antoraConfigCache.set(cacheKey, antoraConfig)
  return antoraConfig
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
    // Capture into a local variable so a FileSystemWatcher invalidation that
    // fires mid-await cannot set cachedAntoraContext to undefined between the
    // null-check and the subsequent use of the object.
    let antoraContext = cachedAntoraContext
    if (antoraContext === undefined) {
      const antoraConfigs = await getAntoraConfigs()
      const contentAggregate: { name: string; version: string; files: any[] }[] =
        await Promise.all(
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
              const globPattern =
                'modules/*/{attachments,examples,images,pages,partials,assets}/**'
              // No async map needed: file contents are NOT read here.
              // The include processor lazy-loads them synchronously on demand.
              const files = (
                await findFiles(
                  `${workspaceRelative ? `${workspaceRelative}/` : ''}${globPattern}`,
                )
              ).map((file) => {
                const contentSourceRootPath = antoraConfig.contentSourceRootPath
                return {
                  base: contentSourceRootPath,
                  path: posixpath.relative(contentSourceRootPath, file.path),
                  contents: Buffer.alloc(0),
                  extname: posixpath.extname(file.path),
                  stem: posixpath.basename(
                    file.path,
                    posixpath.extname(file.path),
                  ),
                  src: {
                    abspath: file.path,
                    absFsPath: file.fsPath,
                    basename: posixpath.basename(file.path),
                    editUrl: '',
                    extname: posixpath.extname(file.path),
                    path: file.path,
                    stem: posixpath.basename(
                      file.path,
                      posixpath.extname(file.path),
                    ),
                  },
                }
              })
              return {
                name: antoraConfig.config.name,
                version: antoraConfig.config.version,
                ...antoraConfig.config,
                files,
              }
            }),
        )
      const contentCatalog = await classifyContent(
        {
          site: {},
        },
        contentAggregate,
      )
      antoraContext = new AntoraContext(contentCatalog)
      cachedAntoraContext = antoraContext
      setupCacheInvalidationWatchers()
    }
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
