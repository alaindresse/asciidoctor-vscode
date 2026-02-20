import * as assert from 'assert'
import os from 'os'
import * as vscode from 'vscode'
import 'mocha'
import {
  clearAntoraContextCache,
  findAntoraConfigFile,
  getAntoraConfig,
  getAntoraDocumentContext,
} from '../features/antora/antoraDocument'
import { resolveIncludeFile } from '../features/antora/resolveIncludeFile'
import { getDefaultWorkspaceFolderUri } from '../util/workspace'
import { extensionContext } from './helper'
import {
  createDirectories,
  createDirectory,
  createFile,
  createLink,
  enableAntoraSupport,
  removeFiles,
  resetAntoraSupport,
} from './workspaceHelper'

async function testGetAntoraConfig({
  asciidocPathUri,
  antoraConfigExpectedUri,
}) {
  const antoraConfigUri = await findAntoraConfigFile(asciidocPathUri)
  if (antoraConfigExpectedUri === undefined) {
    assert.strictEqual(antoraConfigUri, undefined)
  } else {
    // Windows is case-insensitive
    // https://github.com/microsoft/vscode/issues/194692
    if (os.platform() === 'win32') {
      assert.strictEqual(
        antoraConfigUri?.path?.toLowerCase(),
        antoraConfigExpectedUri?.path?.toLowerCase(),
      )
    } else {
      assert.strictEqual(antoraConfigUri?.path, antoraConfigExpectedUri?.path)
    }
  }
}

suite('Antora support with multi-documentation components', () => {
  const createdFiles = []
  const testCases = []
  suiteSetup(async () => {
    createdFiles.push(await createDirectory('docs'))
    // documentation component: docs/multiComponents/api
    const apiDocumentationComponentPaths = ['docs', 'multiComponents', 'api']
    const apiAntoraPaths = [...apiDocumentationComponentPaths, 'antora.yml']
    await createFile(
      `name: "api"
version: "1.0"
`,
      ...apiAntoraPaths,
    )
    const endpointsPaths = [
      ...apiDocumentationComponentPaths,
      'modules',
      'auth',
      'pages',
      'endpoints.adoc',
    ]
    await createFile('= Endpoints', ...endpointsPaths)
    const ssoPaths = [
      ...apiDocumentationComponentPaths,
      'modules',
      'auth',
      'pages',
      '3rd-party',
      'sso.adoc',
    ]
    await createFile('= Single Sign On', ...ssoPaths)
    const tokenBasedPaths = [
      ...apiDocumentationComponentPaths,
      'modules',
      'auth',
      'pages',
      'modules',
      'token-based.adoc',
    ]
    await createFile('= Token Based', ...tokenBasedPaths)
    const patPaths = [
      ...apiDocumentationComponentPaths,
      'modules',
      'auth',
      'pages',
      'modules',
      'token',
      'pat.adoc',
    ]
    await createFile('= Personal Access Token', ...patPaths)
    //await createFile('= Client Id & Client Secret', ...[...apiDocumentationComponentPaths, 'modules', 'auth', 'pages', 'modules', 'credentials', 'secret.adoc'])
    testCases.push({
      title:
        'Should return Antora config for document inside a "modules" subdirectory',
      asciidocPathSegments: tokenBasedPaths,
      antoraConfigExpectedPathSegments: apiAntoraPaths,
    })
    testCases.push({
      title:
        'Should return Antora config for document inside "pages" directory',
      asciidocPathSegments: endpointsPaths,
      antoraConfigExpectedPathSegments: apiAntoraPaths,
    })
    testCases.push({
      title: 'Should return Antora config for document inside a subdirectory',
      asciidocPathSegments: ssoPaths,
      antoraConfigExpectedPathSegments: apiAntoraPaths,
    })
    testCases.push({
      title:
        'Should return Antora config for document inside a directory which has the same name as the workspace',
      asciidocPathSegments: patPaths,
      antoraConfigExpectedPathSegments: apiAntoraPaths,
    })

    // documentation component: docs/multiComponents/cli
    const cliDocumentationComponentPaths = ['docs', 'multiComponents', 'cli']
    const cliAntoraPaths = [...cliDocumentationComponentPaths, 'antora.yml']
    await createFile(
      `name: "cli"
version: "2.0"
`,
      ...cliAntoraPaths,
    )
    await createFile(
      '',
      ...[
        ...cliDocumentationComponentPaths,
        'modules',
        'commands',
        'images',
        'output.png',
      ],
    )
    const convertPaths = [
      ...cliDocumentationComponentPaths,
      'module',
      'commands',
      'pages',
      'convert.adoc',
    ]
    await createFile(
      `= Convert Command

image::2.0@cli:commands:output.png[]

image::commands:output.png[]

image::output.png[]
`,
      ...convertPaths,
    )
    testCases.push({
      title:
        'Should return Antora config for document inside "pages" directory which is inside another directory',
      asciidocPathSegments: convertPaths,
      antoraConfigExpectedPathSegments: cliAntoraPaths,
    })

    // documentation component: docs/multiComponents/modules/api/docs/modules
    const modulesDocumentationComponentPaths = [
      'docs',
      'multiComponents',
      'modules',
      'api',
      'docs',
      'modules',
    ]
    const modulesAntoraPaths = [
      ...modulesDocumentationComponentPaths,
      'antora.yml',
    ]
    await createFile(
      `name: asciidoc
version: ~
      `,
      ...modulesAntoraPaths,
    )
    const admonitionPagePaths = [
      ...modulesDocumentationComponentPaths,
      'blocks',
      'pages',
      'admonition.adoc',
    ]
    await createFile(
      `= Admonition Block

`,
      ...admonitionPagePaths,
    )
    testCases.push({
      title:
        'Should return Antora config for document inside a "modules" directory which is inside an Antora modules in a component named "modules"',
      asciidocPathSegments: admonitionPagePaths,
      antoraConfigExpectedPathSegments: modulesAntoraPaths,
    })

    // outside documentation modules
    const writerGuidePaths = [
      'docs',
      'multiComponents',
      'api',
      'modules',
      'writer-guide.adoc',
    ]
    await createFile('= Writer Guide', ...writerGuidePaths)
    testCases.push({
      title:
        'Should not return Antora config for document outside "modules" Antora folder',
      asciidocPathSegments: writerGuidePaths,
      antoraConfigExpectedPathSegments: undefined,
    })
    const contributingPaths = ['docs', 'contributing.adoc']
    await createFile('= Contributing', ...contributingPaths)
    testCases.push({
      title:
        'Should not return Antora config for document outside of documentation modules',
      asciidocPathSegments: contributingPaths,
      antoraConfigExpectedPathSegments: undefined,
    })
  })

  suiteTeardown(async () => {
    await removeFiles(createdFiles)
  })

  const workspaceUri = getDefaultWorkspaceFolderUri()
  for (const testCase of testCases) {
    test(testCase.title, async () =>
      testGetAntoraConfig({
        asciidocPathUri: vscode.Uri.joinPath(
          workspaceUri,
          ...testCase.asciidocPathSegments,
        ),
        antoraConfigExpectedUri:
          testCase.antoraConfigExpectedPathSegments === undefined
            ? undefined
            : vscode.Uri.joinPath(
                workspaceUri,
                ...testCase.antoraConfigExpectedPathSegments,
              ),
      }),
    )
  }

  test('Should handle symlink', async () => {
    // symlink does not work on Windows
    if (os.platform() !== 'win32') {
      const createdFiles = []
      try {
        createdFiles.push(await createDirectory('antora-test'))
        await createDirectories(
          'antora-test',
          'docs',
          'modules',
          'ROOT',
          'pages',
        )
        const asciidocFile = await createFile(
          '= Hello World',
          'antora-test',
          'docs',
          'modules',
          'ROOT',
          'pages',
          'index.adoc',
        )
        await createLink(
          ['antora-test', 'docs'],
          ['antora-test', 'docs-symlink'],
        ) // create a symlink!
        await createFile(
          `name: silver-leaf
version: '7.1'
`,
          'antora-test',
          'docs',
          'antora.yml',
        )
        // enable Antora support
        await enableAntoraSupport()
        const workspaceState = extensionContext.workspaceState
        const result = await getAntoraDocumentContext(
          asciidocFile,
          workspaceState,
        )
        const components = result.getComponents()
        assert.strictEqual(
          components !== undefined,
          true,
          'Components must not be undefined',
        )
        assert.strictEqual(
          components.length > 0,
          true,
          'Must contains at least one component',
        )
        const component = components.find(
          (c) =>
            c.versions.find(
              (v) => v.name === 'silver-leaf' && v.version === '7.1',
            ) !== undefined,
        )
        assert.strictEqual(
          component !== undefined,
          true,
          'Component silver-leaf:7.1 must exists',
        )
      } catch (err) {
        console.error('Something bad happened!', err)
        throw err
      } finally {
        await removeFiles(createdFiles)
        await resetAntoraSupport()
      }
    }
  })
})

suite('Antora support with single documentation component', () => {
  test('Should build content catalog', async () => {
    const createdFiles = []
    try {
      createdFiles.push(await createDirectory('modules'))
      await createDirectories('modules', 'ROOT', 'pages')
      const asciidocFile = await createFile(
        'image:mountain.jpeg[]',
        'modules',
        'ROOT',
        'pages',
        'landscape.adoc',
      )
      createdFiles.push(asciidocFile)
      createdFiles.push(
        await createFile('', 'modules', 'ROOT', 'images', 'mountain.jpeg'),
      )
      createdFiles.push(
        await createFile(
          `name: ROOT
version: ~
`,
          'antora.yml',
        ),
      )
      await enableAntoraSupport()
      const workspaceState = extensionContext.workspaceState
      const result = await getAntoraDocumentContext(
        asciidocFile,
        workspaceState,
      )
      const images = result.getImages()
      assert.strictEqual(
        images !== undefined,
        true,
        'Images must not be undefined',
      )
      assert.strictEqual(images.length > 0, true, 'Must contains one image')
      assert.strictEqual(images[0].src.basename, 'mountain.jpeg')
      assert.strictEqual(images[0].src.component, 'ROOT')
      assert.strictEqual(images[0].src.family, 'image')
      assert.strictEqual(images[0].src.version, null)
    } catch (err) {
      console.error('Something bad happened!', err)
      throw err
    } finally {
      await removeFiles(createdFiles)
      await resetAntoraSupport()
    }
  })
})

suite('Antora support - path exclusion', () => {
  test('findAntoraConfigFile should exclude antora.yml paths matching the configured patterns', async () => {
    const createdFiles = []
    try {
      clearAntoraContextCache()
      // Create an Antora component under a custom-excluded path
      createdFiles.push(await createDirectory('excluded-component'))
      await createDirectories('excluded-component', 'modules', 'ROOT', 'pages')
      const asciidocFile = await createFile(
        '= Excluded Page',
        'excluded-component',
        'modules',
        'ROOT',
        'pages',
        'index.adoc',
      )
      await createFile(
        `name: excluded\nversion: '1.0'\n`,
        'excluded-component',
        'antora.yml',
      )
      // Override the exclusion setting to use our custom pattern
      await vscode.workspace
        .getConfiguration('asciidoc.antora')
        .update('excludePathsMatching', ['excluded-component'], vscode.ConfigurationTarget.Workspace)

      const result = await findAntoraConfigFile(asciidocFile)
      assert.strictEqual(result, undefined, 'antora.yml inside an excluded path should not be found')
    } catch (err) {
      console.error('Something bad happened!', err)
      throw err
    } finally {
      await removeFiles(createdFiles)
      await vscode.workspace
        .getConfiguration('asciidoc.antora')
        .update('excludePathsMatching', undefined, vscode.ConfigurationTarget.Workspace)
    }
  })

  test('getAntoraDocumentContext should exclude components under node_modules by default', async () => {
    const createdFiles = []
    try {
      clearAntoraContextCache()
      // Create a valid Antora component
      createdFiles.push(await createDirectory('valid-docs'))
      await createDirectories('valid-docs', 'modules', 'ROOT', 'pages')
      const asciidocFile = await createFile(
        '= Valid Page',
        'valid-docs',
        'modules',
        'ROOT',
        'pages',
        'index.adoc',
      )
      await createFile(
        `name: valid-component\nversion: '1.0'\n`,
        'valid-docs',
        'antora.yml',
      )
      // Create a component that should be excluded (inside node_modules)
      createdFiles.push(await createDirectory('node_modules'))
      await createDirectories('node_modules', 'some-pkg', 'modules', 'ROOT', 'pages')
      await createFile(
        '= Excluded Page',
        'node_modules',
        'some-pkg',
        'modules',
        'ROOT',
        'pages',
        'index.adoc',
      )
      await createFile(
        `name: excluded-pkg\nversion: '1.0'\n`,
        'node_modules',
        'some-pkg',
        'antora.yml',
      )
      // Use the default exclusion pattern (node_modules)
      await vscode.workspace
        .getConfiguration('asciidoc.antora')
        .update('excludePathsMatching', ['node_modules'], vscode.ConfigurationTarget.Workspace)

      await enableAntoraSupport()
      const workspaceState = extensionContext.workspaceState
      const result = await getAntoraDocumentContext(asciidocFile, workspaceState)

      assert.notStrictEqual(result, undefined, 'Should return a context for the valid component')
      const componentNames = result
        .getComponents()
        .flatMap((c) => c.versions.map((v) => v.name))
      assert.ok(
        !componentNames.includes('excluded-pkg'),
        'Component inside node_modules must be excluded from the catalog',
      )
      assert.ok(
        componentNames.includes('valid-component'),
        'Valid component must be present in the catalog',
      )
    } catch (err) {
      console.error('Something bad happened!', err)
      throw err
    } finally {
      await removeFiles(createdFiles)
      await resetAntoraSupport()
      await vscode.workspace
        .getConfiguration('asciidoc.antora')
        .update('excludePathsMatching', undefined, vscode.ConfigurationTarget.Workspace)
    }
  })
})

suite('Antora support - catalog caching', () => {
  test('Should reuse the same catalog object across successive calls', async () => {
    const createdFiles = []
    try {
      clearAntoraContextCache()
      createdFiles.push(await createDirectory('cache-test'))
      await createDirectories('cache-test', 'modules', 'ROOT', 'pages')
      const asciidocFile = await createFile(
        '= Cache Test',
        'cache-test',
        'modules',
        'ROOT',
        'pages',
        'index.adoc',
      )
      createdFiles.push(
        await createFile(
          `name: cache-test\nversion: '1.0'\n`,
          'cache-test',
          'antora.yml',
        ),
      )
      await enableAntoraSupport()
      const workspaceState = extensionContext.workspaceState

      const result1 = await getAntoraDocumentContext(asciidocFile, workspaceState)
      const result2 = await getAntoraDocumentContext(asciidocFile, workspaceState)

      assert.notStrictEqual(result1, undefined, 'First call must return a context')
      assert.notStrictEqual(result2, undefined, 'Second call must return a context')
      assert.strictEqual(
        result1.getContentCatalog(),
        result2.getContentCatalog(),
        'Both calls must share the same cached ContentCatalog instance',
      )
    } catch (err) {
      console.error('Something bad happened!', err)
      throw err
    } finally {
      await removeFiles(createdFiles)
      await resetAntoraSupport()
    }
  })
})

suite('Antora support - lazy content loading', () => {
  test('Should lazy-load partial content when an include directive is resolved', async () => {
    const createdFiles = []
    try {
      clearAntoraContextCache()
      createdFiles.push(await createDirectory('lazy-test'))
      await createDirectories('lazy-test', 'modules', 'ROOT', 'pages')
      await createDirectories('lazy-test', 'modules', 'ROOT', 'partials')

      const partialContent = 'This is lazy-loaded partial content.'
      await createFile(
        partialContent,
        'lazy-test',
        'modules',
        'ROOT',
        'partials',
        'snippet.adoc',
      )
      const asciidocFile = await createFile(
        'include::partial$snippet.adoc[]',
        'lazy-test',
        'modules',
        'ROOT',
        'pages',
        'index.adoc',
      )
      createdFiles.push(
        await createFile(
          `name: lazy-test\nversion: '1.0'\n`,
          'lazy-test',
          'antora.yml',
        ),
      )
      await enableAntoraSupport()
      const workspaceState = extensionContext.workspaceState

      const antoraDocumentContext = await getAntoraDocumentContext(asciidocFile, workspaceState)
      assert.notStrictEqual(antoraDocumentContext, undefined, 'Context must not be undefined')

      const antoraConfig = await getAntoraConfig(asciidocFile)
      const catalog = antoraDocumentContext.getContentCatalog()

      // Verify the partial exists in the catalog (metadata-only, content not yet read)
      const partials = catalog.findBy({ family: 'partial' })
      const snippet = partials.find((p) => p.src.basename === 'snippet.adoc')
      assert.notStrictEqual(snippet, undefined, 'snippet.adoc must be present in the catalog')

      // Resolve the include — this triggers lazy loading of the file content
      const cursor = { file: null, dir: { toString: () => '' } }
      const resolved = resolveIncludeFile(
        'partial$snippet.adoc',
        { src: antoraDocumentContext.resourceContext },
        cursor,
        catalog,
        antoraConfig,
      )

      assert.notStrictEqual(resolved, undefined, 'Include must be resolved')
      assert.strictEqual(
        resolved.contents,
        partialContent,
        'Lazy-loaded content must match the file on disk',
      )

      // A second resolution uses the content already cached in the catalog entry
      const resolved2 = resolveIncludeFile(
        'partial$snippet.adoc',
        { src: antoraDocumentContext.resourceContext },
        cursor,
        catalog,
        antoraConfig,
      )
      assert.notStrictEqual(resolved2, undefined, 'Second resolution must also succeed')
      assert.strictEqual(
        resolved2.contents,
        partialContent,
        'Cached content must match on repeated resolution',
      )
    } catch (err) {
      console.error('Something bad happened!', err)
      throw err
    } finally {
      await removeFiles(createdFiles)
      await resetAntoraSupport()
    }
  })
})
