// Tool-granularity state: the document schema, its disk round trip, and the
// fail-safe path for a hand-edited or half-written file.
//
// The state file is the only source of truth for "which tools are hidden", so the
// tests pin three things separately: parsing never invents a hidden tool, a bad
// file never takes the panel down, and the atomic writer never leaves a partial
// primary behind.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { readState, resolveStatePath, updateState } from '../index.js'
import {
  DEFAULT_PANEL_ENTRY,
  STATE_VERSION,
  createDefaultState,
  deniedToolNames,
  describeToolSchemas,
  readStateDocument,
  sanitizeState,
  setServerPending,
  setToolEnabled,
  writeStateDocument,
} from '../lib/tool-state.js'

test('the default document carries the versioned empty schema', () => {
  const state = createDefaultState()
  assert.equal(state.version, STATE_VERSION)
  assert.equal(state.panelEntry, DEFAULT_PANEL_ENTRY)
  assert.deepEqual(state.servers, {})
  assert.equal(state.updatedAt, null)
})

test('a full document survives sanitization with only explicit false tools', () => {
  const raw = {
    version: 99,
    panelEntry: 'sidebar',
    servers: {
      blender: {
        pending: { disabled: true, requestedAt: '2026-11-13T00:00:00.000Z' },
        tools: { keep_hidden: false, switched_back_on: true, garbage: 'no', number: 0 },
        knownTools: [
          { name: 'keep_hidden', description: 'd', schemaBytes: 80, estTokens: 20, lastSeenAt: '2026-11-13T00:00:00.000Z' },
          { name: 'keep_hidden', description: 'duplicate is dropped' },
          { name: 42 },
        ],
        syncedAt: '2026-11-13T00:00:00.000Z',
      },
    },
    updatedAt: '2026-11-13T00:00:00.000Z',
  }
  const state = sanitizeState(raw)
  assert.equal(state.version, STATE_VERSION, 'version is normalised to the current schema')
  assert.equal(state.panelEntry, 'sidebar')
  assert.deepEqual(state.servers.blender.tools, { keep_hidden: false })
  assert.equal(state.servers.blender.pending.disabled, true)
  assert.equal(state.servers.blender.knownTools.length, 1)
  assert.equal(state.servers.blender.knownTools[0].estTokens, 20)
})

test('a foreign panel value falls back without inventing a server', () => {
  const state = sanitizeState({ panelEntry: 'floating', servers: null, version: 'x' })
  assert.equal(state.panelEntry, DEFAULT_PANEL_ENTRY)
  assert.deepEqual(state.servers, {})
  assert.equal(state.version, STATE_VERSION)
})

test('tool switches rewrite only the explicit false entry', () => {
  const state = createDefaultState()
  setToolEnabled(state, 'blender', 'render', false)
  setToolEnabled(state, 'blender', 'inspect', true)
  assert.deepEqual(state.servers.blender.tools, { render: false })
  setToolEnabled(state, 'blender', 'render', true)
  assert.deepEqual(state.servers.blender.tools, {})
})

test('pending server switches are parsed and written as a pair', () => {
  const state = createDefaultState()
  setServerPending(state, 'blender', true, '2026-11-13T01:02:03.000Z')
  assert.deepEqual(state.servers.blender.pending, { disabled: true, requestedAt: '2026-11-13T01:02:03.000Z' })
  const bad = sanitizeState({ servers: { blender: { pending: { disabled: 'yes' } } } })
  assert.equal(bad.servers.blender.pending, null)
})

test('deniedToolNames only emits names the live schema knows', () => {
  const state = createDefaultState()
  setToolEnabled(state, 'blender', 'render', false)
  setToolEnabled(state, 'blender', 'old_tool', false)
  const deny = deniedToolNames(state, ['mcp__blender__render', 'mcp__other__x'])
  assert.deepEqual(deny, ['mcp__blender__render'])
})

test('describeToolSchemas keeps the same byte accounting as summarizeSchemas', () => {
  const state = createDefaultState()
  setToolEnabled(state, 'blender', 'render', false)
  const rows = describeToolSchemas(
    [
      {
        name: 'mcp__blender__render',
        description: 'draw',
        parameters: { type: 'object' },
      },
    ],
    state,
  ).get('blender')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].toolName, 'render')
  assert.equal(rows[0].enabled, false)
  assert.equal(rows[0].schemaBytes, 'mcp__blender__render'.length + 4 + JSON.stringify({ type: 'object' }).length)
})

test('describeToolSchemas prices a CJK description in UTF-8 bytes', () => {
  const rows = describeToolSchemas(
    [{ name: 'mcp__blender__render', description: '渲染当前帧', parameters: {} }],
    createDefaultState(),
  ).get('blender')
  assert.equal(rows[0].descriptionBytes, Buffer.byteLength('渲染当前帧', 'utf8'))
  assert.equal(rows[0].schemaBytes, 'mcp__blender__render'.length + rows[0].descriptionBytes + 2)
})

test('the state file round-trips through the atomic writer without a temp file', async () => {
  await withHome(async (home) => {
    const file = resolveStatePath()
    const state = createDefaultState('sidebar')
    setToolEnabled(state, 'blender', 'render', false)
    const written = await writeStateDocument(file, state)
    assert.equal(written.ok, true)
    assert.equal(written.backupPath, null)

    const read = await readState()
    assert.equal(read.ok, true)
    assert.equal(read.panelEntry, 'sidebar')
    assert.deepEqual(read.servers.blender.tools, { render: false })

    const names = await readdir(path.join(home, 'dsh-mcp-switch'))
    assert.deepEqual(names, ['state.json'])
  })
})

test('a second write keeps the previous valid bytes in state.json.bak', async () => {
  await withHome(async () => {
    const file = resolveStatePath()
    await writeStateDocument(file, createDefaultState('settings'))
    const second = createDefaultState('sidebar')
    const written = await writeStateDocument(file, second)
    assert.equal(written.ok, true)
    assert.equal(written.backupPath, `${file}.bak`)
    assert.equal(JSON.parse(await readFile(`${file}.bak`, 'utf8')).panelEntry, 'settings')
    assert.equal(JSON.parse(await readFile(file, 'utf8')).panelEntry, 'sidebar')
  })
})

test('a corrupt primary is moved aside and defaults are returned', async () => {
  await withHome(async () => {
    const file = resolveStatePath()
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, '{ not json', 'utf8')

    const read = await readState()
    assert.equal(read.ok, false)
    assert.ok(read.error && read.error.length > 0)
    assert.equal(read.panelEntry, DEFAULT_PANEL_ENTRY)
    assert.deepEqual(read.servers, {})
    assert.equal(existsSync(file), false, 'the corrupt primary is renamed, not kept in place')
    const broken = (await readdir(path.dirname(file))).filter((name) => name.startsWith('state.json.broken-'))
    assert.equal(broken.length, 1)
  })
})

test('a corrupt primary falls back to a valid .bak snapshot', async () => {
  await withHome(async () => {
    const file = resolveStatePath()
    const backup = createDefaultState('sidebar')
    setToolEnabled(backup, 'blender', 'render', false)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(`${file}.bak`, `${JSON.stringify(backup, null, 2)}\n`, 'utf8')
    await writeFile(file, '{ broken', 'utf8')

    const read = await readState()
    assert.equal(read.ok, false)
    assert.equal(read.backupUsed, `${file}.bak`)
    assert.equal(read.panelEntry, 'sidebar')
    assert.deepEqual(read.servers.blender.tools, { render: false })
  })
})

test('after falling back to .bak, the next write keeps the recovered preferences', async () => {
  await withHome(async () => {
    const file = resolveStatePath()
    const backup = createDefaultState('sidebar')
    setToolEnabled(backup, 'blender', 'render', false)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(`${file}.bak`, `${JSON.stringify(backup, null, 2)}\n`, 'utf8')
    await writeFile(file, '{ broken', 'utf8')

    // The corrupt file is renamed away, so the primary is *missing* on the next write.
    // Treating "missing" as "first run" would silently drop the recovered preference and
    // hand the user a panel that had quietly re-enabled a tool they had switched off.
    const updated = await updateState((draft) => {
      draft.panelEntry = 'settings'
      return draft
    })
    assert.equal(updated.ok, true)
    const read = await readState()
    assert.equal(read.panelEntry, 'settings')
    assert.deepEqual(read.servers.blender.tools, { render: false })
  })
})

test('unknown fields survive a sanitize round trip', () => {
  // DESIGN.md:33: 写回保留未知字段。手写的备注、更新版本写入的键，都不能因为
  // 这一版不认识就被删掉。
  const raw = {
    version: 1,
    panelEntry: 'sidebar',
    note: 'hand written',
    servers: { blender: { tools: { render: false }, futureKey: { keep: true } } },
  }
  const state = sanitizeState(raw)
  assert.equal(state.note, 'hand written')
  assert.deepEqual(state.servers.blender.futureKey, { keep: true })
  assert.deepEqual(state.servers.blender.tools, { render: false })
})

test('a backup that cannot be written is reported, not silently claimed', async () => {
  await withHome(async () => {
    const file = resolveStatePath()
    await mkdir(path.dirname(file), { recursive: true })
    await writeStateDocument(file, createDefaultState('settings'))
    // Make the backup target unwritable by turning it into a directory.
    await mkdir(`${file}.bak`, { recursive: true })

    const written = await writeStateDocument(file, createDefaultState('sidebar'))
    assert.equal(written.ok, true, 'the primary write still succeeds')
    assert.equal(written.backupPath, null, 'no backup path is claimed')
    assert.ok(written.backupError, 'the failure is reported')
    assert.equal(JSON.parse(await readFile(file, 'utf8')).panelEntry, 'sidebar')
  })
})

test('updateState preserves unrelated servers while the panel changes', async () => {
  await withHome(async () => {
    const file = resolveStatePath()
    const state = createDefaultState('settings')
    setToolEnabled(state, 'blender', 'render', false)
    await writeStateDocument(file, state)

    const updated = await updateState((draft) => {
      draft.panelEntry = 'sidebar'
      return draft
    })
    assert.equal(updated.ok, true)
    const read = await readState()
    assert.equal(read.panelEntry, 'sidebar')
    assert.deepEqual(read.servers.blender.tools, { render: false })
    assert.ok(read.updatedAt)
  })
})

test('readStateDocument on a missing file is an ordinary first run', async () => {
  await withHome(async () => {
    const result = await readStateDocument(resolveStatePath())
    assert.equal(result.ok, true)
    assert.equal(result.missing, true)
    assert.equal(result.state.panelEntry, DEFAULT_PANEL_ENTRY)
  })
})

test('a write lands even when the target is briefly held open by a reader', async () => {
  // Windows fails a rename onto a path that anybody holds open (EPERM) where POSIX
  // allows it; the startup reconcile lost its "clear pending" write that way and
  // replayed the same pending row on every boot. Holding a handle here reproduces the
  // exact condition, and the retry is what makes the write land.
  await withHome(async () => {
    await updateState((draft) => draft)
    const file = resolveStatePath()
    const handle = await open(file, 'r')
    const pending = updateState((draft) => {
      draft.panelEntry = 'sidebar'
      return draft
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    await handle.close()
    const written = await pending
    assert.equal(written.ok, true, written.error)
    assert.equal((await readState()).panelEntry, 'sidebar')
    const leftovers = (await readdir(path.dirname(file))).filter((entry) => entry.includes('.tmp'))
    assert.deepEqual(leftovers, [])
  })
})

test('a target held open past the retry budget fails loudly and leaves no temp file', async () => {
  await withHome(async () => {
    await updateState((draft) => draft)
    const file = resolveStatePath()
    const before = await readFile(file, 'utf8')
    const handle = await open(file, 'r')
    try {
      const written = await updateState((draft) => {
        draft.panelEntry = 'sidebar'
        return draft
      })
      // POSIX renames over an open file, so the write may legitimately succeed there.
      if (process.platform === 'win32') {
        assert.equal(written.ok, false)
        assert.match(String(written.error), /EPERM|EACCES|EBUSY/)
        assert.equal(await readFile(file, 'utf8'), before)
      }
    } finally {
      await handle.close()
    }
    const leftovers = (await readdir(path.dirname(file))).filter((entry) => entry.includes('.tmp'))
    assert.deepEqual(leftovers, [])
  })
})

async function withHome(fn) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mcp-switch-tool-state-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  }
}
