/**
 * The UI-only known-tool cache.
 *
 * The panel can only describe a server's tools while the server is *connected*: once it
 * is switched off, `ctx.tools.schemas()` no longer lists its tools and the row would
 * collapse to "0 tools, 0 tokens". The cache is what keeps the last good description
 * (DESIGN.md:50), so it must be written from a complete snapshot and must never be
 * overwritten by a partial one.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { refreshKnownToolCache, readState, resolveStatePath } from '../index.js'

const MCP_CLIENT_PLUGIN = '@deepseek-ai/dsh-mcp-client'

function toolSchema(server, tool, description = '') {
  return {
    name: `mcp__${server}__${tool}`,
    description,
    parameters: { type: 'object', properties: {} },
  }
}

/** A ctx just wide enough for the cache refresh: services, no effects. */
function makeCtx({ schemas, phase = 2 }) {
  let current = schemas
  const entry = {
    id: 'include:mock',
    options: { id: 'mock', name: MCP_CLIENT_PLUGIN, config: { serverName: 'mock' } },
    fiber: { state: phase },
  }
  return {
    setSchemas(next) {
      current = next
    },
    get(name) {
      if (name === 'tools') return { schemas: () => current }
      if (name === 'loader') return { entries: () => [entry] }
      return undefined
    },
  }
}

async function withState(fn) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-switch-known-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    await mkdir(path.dirname(resolveStatePath()), { recursive: true })
    await writeFile(resolveStatePath(), JSON.stringify({ version: 1, panelEntry: 'settings', servers: {}, updatedAt: null }), 'utf8')
    return await fn({ dir })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(dir, { recursive: true, force: true })
  }
}

test('a loading fiber may write the cache, an unloading one may not', async () => {
  // A fiber registers its tools one at a time while it loads, so a snapshot taken during
  // loading is a growing prefix and the last one is complete. Teardown is the opposite:
  // it unregisters one at a time, so every snapshot on the way out is partial. Caching a
  // teardown snapshot is what once turned six known tools into two.
  await withState(async () => {
    const loading = makeCtx({ schemas: [toolSchema('mock', 'alpha')], phase: 1 })
    await refreshKnownToolCache(loading)
    let state = await readState()
    assert.deepEqual(state.servers.mock.knownTools.map((row) => row.name), ['alpha'])

    loading.setSchemas([toolSchema('mock', 'alpha'), toolSchema('mock', 'beta')])
    await refreshKnownToolCache(loading)
    state = await readState()
    assert.deepEqual(state.servers.mock.knownTools.map((row) => row.name), ['alpha', 'beta'])

    const unloading = makeCtx({ schemas: [toolSchema('mock', 'alpha')], phase: 5 })
    await refreshKnownToolCache(unloading)
    state = await readState()
    assert.deepEqual(
      state.servers.mock.knownTools.map((row) => row.name),
      ['alpha', 'beta'],
      'a teardown snapshot must not replace the last complete cache',
    )
  })
})

test('an empty live set never erases the cache', async () => {
  // A disconnected server looks exactly like a server with no tools. Treating the empty
  // set as truth is how the panel lost the estimate for a server the user had merely
  // switched off.
  await withState(async () => {
    const ctx = makeCtx({ schemas: [toolSchema('mock', 'alpha')], phase: 2 })
    await refreshKnownToolCache(ctx)
    ctx.setSchemas([])
    await refreshKnownToolCache(ctx)
    const state = await readState()
    assert.deepEqual(state.servers.mock.knownTools.map((row) => row.name), ['alpha'])
  })
})

test('overlapping refreshes settle on the newest snapshot', async () => {
  // `tools/change` fires once per registered tool, so refreshes overlap. The whole
  // read-compute-write is chained, which is what stops an older snapshot from being
  // written after a newer one.
  await withState(async () => {
    const ctx = makeCtx({ schemas: [toolSchema('mock', 'alpha')], phase: 2 })
    const first = refreshKnownToolCache(ctx)
    ctx.setSchemas([toolSchema('mock', 'alpha'), toolSchema('mock', 'beta'), toolSchema('mock', 'gamma')])
    const second = refreshKnownToolCache(ctx)
    await Promise.all([first, second])
    const state = await readState()
    assert.deepEqual(state.servers.mock.knownTools.map((row) => row.name), ['alpha', 'beta', 'gamma'])
  })
})

test('a schema change that keeps the names still updates the stored description', async () => {
  // The cache is what the panel prices a disabled server with, so a changed description
  // or parameter block has to be re-stored even when the tool list is identical.
  await withState(async () => {
    const ctx = makeCtx({ schemas: [toolSchema('mock', 'alpha', 'short')], phase: 2 })
    await refreshKnownToolCache(ctx)
    const before = (await readState()).servers.mock.knownTools[0]

    ctx.setSchemas([toolSchema('mock', 'alpha', 'a much longer description than before')])
    await refreshKnownToolCache(ctx)
    const after = (await readState()).servers.mock.knownTools[0]
    assert.equal(after.name, 'alpha')
    assert.ok(after.schemaBytes > before.schemaBytes)
    assert.ok(after.estTokens >= before.estTokens)
  })
})
