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
    const antoraConfigs = await getAntoraConfigs()
    // Map from a file's absolute path string to its local fsPath, used to
    // install lazy content loaders after the catalog is classified.
    const fsPathByAbsPath = new Map<string, string>()
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
            const contentSourceRootPath = antoraConfig.contentSourceRootPath
            const contentFilesUris = await findAntoraContentFiles(
              workspaceRelative || undefined,
            )
            for (const uri of contentFilesUris) {
              fsPathByAbsPath.set(uri.path, uri.fsPath)
            }
            const files = contentFilesUris.map((fileUri) => ({
              base: contentSourceRootPath,
              path: posixpath.relative(contentSourceRootPath, fileUri.path),
              // contents is intentionally null here; lazy loaders are
              // installed on the classified Vinyl files after classifyContent.
              contents: null as Buffer | null,
              extname: posixpath.extname(fileUri.path),
              stem: posixpath.basename(
                fileUri.path,
                posixpath.extname(fileUri.path),
              ),
              src: {
                abspath: fileUri.path,
                basename: posixpath.basename(fileUri.path),
                editUrl: '',
                extname: posixpath.extname(fileUri.path),
                path: fileUri.path,
                stem: posixpath.basename(
                  fileUri.path,
                  posixpath.extname(fileUri.path),
                ),
              },
            }))
            return {
              name: antoraConfig.config.name,
              version: antoraConfig.config.version,
              ...antoraConfig.config,
              files,
            }
          }),
      )
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
