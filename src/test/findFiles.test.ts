import * as assert from 'assert'
import * as vscode from 'vscode'
import 'mocha'
import {
  disposeAntoraFileWatchers,
  findAntoraConfigFiles,
  findAntoraContentFiles,
} from '../util/findFiles'
import {
  createDirectory,
  createDirectories,
  createFile,
  removeFiles,
} from './workspaceHelper'

function waitForWatcher(ms = 400): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// findAntoraConfigFiles
// ---------------------------------------------------------------------------

suite('findAntoraConfigFiles caching', () => {
  const createdFiles: vscode.Uri[] = []

  suiteSetup(async () => {
    disposeAntoraFileWatchers()
    createdFiles.push(await createDirectory('cache-cfg-test'))
    createdFiles.push(
      await createFile(
        "name: cache-cfg-component\nversion: '1.0'\n",
        'cache-cfg-test',
        'antora.yml',
      ),
    )
  })

  setup(() => {
    // Ensure a clean, unwatched cache before every test.
    disposeAntoraFileWatchers()
  })

  suiteTeardown(async () => {
    await removeFiles(createdFiles)
    disposeAntoraFileWatchers()
  })

  test('Should return antora.yml files including the test component', async () => {
    const result = await findAntoraConfigFiles()
    assert.ok(Array.isArray(result), 'Result must be an array')
    assert.ok(
      result.some((uri) => uri.path.includes('cache-cfg-test/antora.yml')),
      'Expected to find cache-cfg-test/antora.yml in results',
    )
  })

  test('Should return the same array reference on a second call (cache hit)', async () => {
    const first = await findAntoraConfigFiles()
    const second = await findAntoraConfigFiles()
    assert.strictEqual(first, second, 'Second call should return the cached array')
  })

  test('Should invalidate cache when a new antora.yml is created', async () => {
    const localCreated: vscode.Uri[] = []
    try {
      localCreated.push(await createDirectory('cache-cfg-new'))
      const first = await findAntoraConfigFiles() // populate cache + start watcher
      const firstLength = first.length

      localCreated.push(
        await createFile(
          "name: new-component\nversion: '1.0'\n",
          'cache-cfg-new',
          'antora.yml',
        ),
      )
      await waitForWatcher()

      const second = await findAntoraConfigFiles()
      assert.ok(
        second.length > firstLength,
        `Cache should be invalidated after creation: got ${second.length}, expected more than ${firstLength}`,
      )
    } finally {
      await removeFiles(localCreated)
    }
  })

  test('Should invalidate cache when an antora.yml is deleted', async () => {
    const localCreated: vscode.Uri[] = []
    try {
      localCreated.push(await createDirectory('cache-cfg-del'))
      const delFileUri = await createFile(
        "name: del-component\nversion: '1.0'\n",
        'cache-cfg-del',
        'antora.yml',
      )

      // Reset so the new file is included in the baseline count.
      disposeAntoraFileWatchers()
      const first = await findAntoraConfigFiles() // populate cache + start watcher
      const firstLength = first.length

      await vscode.workspace.fs.delete(delFileUri)
      await waitForWatcher()

      const second = await findAntoraConfigFiles()
      assert.ok(
        second.length < firstLength,
        `Cache should be invalidated after deletion: got ${second.length}, expected less than ${firstLength}`,
      )
    } finally {
      await removeFiles(localCreated)
    }
  })
})

// ---------------------------------------------------------------------------
// findAntoraContentFiles
// ---------------------------------------------------------------------------

suite('findAntoraContentFiles caching', () => {
  const createdFiles: vscode.Uri[] = []
  const testPrefix = 'cache-content-test'

  suiteSetup(async () => {
    disposeAntoraFileWatchers()
    createdFiles.push(await createDirectory(testPrefix))
    await createDirectories(testPrefix, 'modules', 'ROOT', 'pages')
    createdFiles.push(
      await createFile('= Index', testPrefix, 'modules', 'ROOT', 'pages', 'index.adoc'),
    )
  })

  setup(() => {
    disposeAntoraFileWatchers()
  })

  suiteTeardown(async () => {
    await removeFiles(createdFiles)
    disposeAntoraFileWatchers()
  })

  test('Should return content files for the given workspace-relative prefix', async () => {
    const result = await findAntoraContentFiles(testPrefix)
    assert.ok(Array.isArray(result), 'Result must be an array')
    assert.ok(
      result.some((uri) =>
        uri.path.includes(`${testPrefix}/modules/ROOT/pages/index.adoc`),
      ),
      'Expected to find index.adoc in content files',
    )
  })

  test('Should return the same array reference on a second call (cache hit)', async () => {
    const first = await findAntoraContentFiles(testPrefix)
    const second = await findAntoraContentFiles(testPrefix)
    assert.strictEqual(first, second, 'Second call should return the cached array')
  })

  test('Should invalidate cache when a content file is created', async () => {
    const localCreated: vscode.Uri[] = []
    try {
      const first = await findAntoraContentFiles(testPrefix) // populate cache + start watcher
      const firstLength = first.length

      localCreated.push(
        await createFile('= New Page', testPrefix, 'modules', 'ROOT', 'pages', 'new-page.adoc'),
      )
      await waitForWatcher()

      const second = await findAntoraContentFiles(testPrefix)
      assert.ok(
        second.length > firstLength,
        `Cache should be invalidated after creation: got ${second.length}, expected more than ${firstLength}`,
      )
    } finally {
      await removeFiles(localCreated)
    }
  })

  test('Should invalidate cache when a content file is deleted', async () => {
    try {
      const delFileUri = await createFile(
        '= Del Page',
        testPrefix,
        'modules',
        'ROOT',
        'pages',
        'del-page.adoc',
      )

      // Reset so the new file is included in the baseline count.
      disposeAntoraFileWatchers()
      const first = await findAntoraContentFiles(testPrefix) // populate cache + start watcher
      const firstLength = first.length

      await vscode.workspace.fs.delete(delFileUri)
      await waitForWatcher()

      const second = await findAntoraContentFiles(testPrefix)
      assert.ok(
        second.length < firstLength,
        `Cache should be invalidated after deletion: got ${second.length}, expected less than ${firstLength}`,
      )
    } finally {
      // del-page.adoc was already deleted above; parent dir is cleaned by suiteTeardown.
    }
  })
})
