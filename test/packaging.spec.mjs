/**
 * Packaging guard: every bare specifier the published artifact imports must be
 * declared in `dependencies` or `peerDependencies`.
 *
 * This exists because of a defect class that bit this package family three
 * times (`search-budget` 0.1.0, `credential-rotate` 0.1.1, and
 * `session-trigger` 0.1.0): the source imports a bare package, the repo's own
 * `node_modules` resolves it (workspace root, or a transitive of something else),
 * and `npm test` inside the repo passes — while a clean project that installs
 * the published tarball gets
 *
 *     Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/schemastery'
 *     imported from .../node_modules/@argszero/cordis-plugin-session-trigger/lib/index.js
 *
 * The repo's own test run cannot see it, by construction: locally the specifier
 * resolves. The only witness is a scan of the *built* files against the
 * *published* manifest, which is what this test does.
 *
 * Both directions are checked: an undeclared import (the crash), and a declared
 * dependency nothing imports (a stale declaration that misleads installers).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Recursively collect files under `dir` whose name matches `keep`. */
async function collect(dir, keep) {
  const found = []
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return found }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...await collect(full, keep))
    else if (keep(entry.name)) found.push(full)
  }
  return found
}

/**
 * Extract every bare specifier from TypeScript/JavaScript source text.
 *
 * Matches the three import forms that create a runtime dependency —
 * `from '<spec>'`, `import '<spec>'`, and dynamic `import('<spec>')` — and keeps
 * only those that are neither relative nor absolute. `import type` and
 * `export type` are excluded, because a type-only import is erased and needs no
 * declaration at runtime.
 */
function bareSpecifiers(text) {
  const found = new Set()
  // Strip type-only import/export statements before scanning: they emit nothing.
  const runtime = text.replace(/^\s*(?:import|export)\s+type\b[^\n]*\n/gm, '')
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
  ]
  for (const pattern of patterns) {
    for (const match of runtime.matchAll(pattern)) {
      const spec = match[1]
      if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) continue
      found.add(spec)
    }
  }
  return found
}

/** Reduce a specifier to the package it belongs to (`@scope/pkg/sub` -> `@scope/pkg`). */
function packageOf(spec) {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const declared = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
  ...Object.keys(manifest.optionalDependencies ?? {}),
])

test('the built artifact imports nothing the manifest fails to declare', async () => {
  const files = await collect(join(root, 'lib'), name => name.endsWith('.js'))
  assert.ok(files.length > 0, 'lib/ must contain built output — run `tsc` before this test')

  const imports = new Map()
  for (const file of files) {
    for (const spec of bareSpecifiers(await readFile(file, 'utf8'))) {
      const pkg = packageOf(spec)
      if (!imports.has(pkg)) imports.set(pkg, new Set())
      imports.get(pkg).add(file.slice(root.length + 1))
    }
  }

  const undeclared = [...imports.keys()].filter(pkg => !declared.has(pkg))
  assert.deepEqual(
    undeclared, [],
    `lib/ imports ${undeclared.join(', ')} but package.json declares only ${[...declared].join(', ')} — `
    + 'a clean install of the published tarball will fail with ERR_MODULE_NOT_FOUND',
  )
})

test('the source imports nothing the manifest fails to declare', async () => {
  const files = await collect(join(root, 'src'), name => name.endsWith('.ts'))
  assert.ok(files.length > 0, 'src/ must contain sources')

  const undeclared = new Set()
  for (const file of files) {
    // `src` imports may also use `.ts` extension specifiers; both are handled by
    // the same bare-specifier filter.
    for (const spec of bareSpecifiers(await readFile(file, 'utf8'))) {
      const pkg = packageOf(spec)
      if (!declared.has(pkg)) undeclared.add(pkg)
    }
  }
  assert.deepEqual([...undeclared], [], 'src/ imports undeclared packages')
})

test('every declared dependency is actually imported', async () => {
  const files = [
    ...await collect(join(root, 'lib'), name => name.endsWith('.js')),
    ...await collect(join(root, 'src'), name => name.endsWith('.ts')),
  ]
  const imported = new Set()
  for (const file of files) {
    for (const spec of bareSpecifiers(await readFile(file, 'utf8'))) imported.add(packageOf(spec))
  }

  const stale = Object.keys(manifest.dependencies ?? {})
    .filter(pkg => !imported.has(pkg) && pkg !== manifest.name)
  assert.deepEqual(
    stale, [],
    `package.json declares dependencies nothing imports: ${stale.join(', ')} — `
    + 'a stale declaration is installed by every consumer for nothing',
  )
})
