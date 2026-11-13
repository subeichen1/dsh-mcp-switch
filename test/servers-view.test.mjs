// The servers view has two sections that only ever appear with real data from the host:
// rows that are in the patch file but not mounted yet, and the per-server call counter.
// Both are invisible in a smoke test, so they are rendered here against a snapshot.

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const CLIENT = new URL('../client.js', import.meta.url)

/* -------------------------------------------------------------------------- */
/* a React stub that actually re-renders                                       */
/* -------------------------------------------------------------------------- */

// Components are plain functions returning plain trees. Effects run after the render that
// registered them, state changes queue another render — enough to reach a settled UI.
function makeReact() {
  const records = new Map()
  const stack = []
  let queue = []
  let dirty = false

  const current = () => stack[stack.length - 1]

  const createElement = (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
  })

  const api = {
    createElement,
    useState(initial) {
      const rec = current()
      const at = rec.cursor++
      if (!(at in rec.slots)) rec.slots[at] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        const value = typeof next === 'function' ? next(rec.slots[at]) : next
        if (value !== rec.slots[at]) {
          rec.slots[at] = value
          dirty = true
        }
      }
      return [rec.slots[at], set]
    },
    useRef(initial) {
      const rec = current()
      const at = rec.cursor++
      if (!(at in rec.slots)) rec.slots[at] = { current: initial }
      return rec.slots[at]
    },
    // Memoized on purpose: an identity that changes every render makes `useEffect([fn])`
    // fire forever, which is a stub artefact that hides what the component really does.
    useCallback(fn, deps) {
      const rec = current()
      const at = rec.cursor++
      const prev = rec.slots[at]
      const same =
        prev &&
        prev.deps &&
        deps &&
        deps.length === prev.deps.length &&
        deps.every((value, index) => value === prev.deps[index])
      if (same) return prev.fn
      rec.slots[at] = { deps: deps ? [...deps] : null, fn }
      return fn
    },
    useEffect(fn, deps) {
      const rec = current()
      const at = rec.cursor++
      const prev = rec.slots[at]
      if (!prev) {
        rec.slots[at] = { deps: deps ? [...deps] : null, fn }
        queue.push({ rec, at })
        return
      }
      const same =
        !deps || !prev.deps
          ? false
          : deps.length === prev.deps.length && deps.every((value, index) => value === prev.deps[index])
      if (same) return
      prev.deps = deps ? [...deps] : null
      prev.fn = fn
      queue.push({ rec, at })
    },
  }

  function resolve(node) {
    if (node === null || node === undefined || node === false) return null
    if (typeof node === 'string' || typeof node === 'number') return String(node)
    if (Array.isArray(node)) return node.map(resolve).filter((child) => child !== null)
    if (typeof node !== 'object') return String(node)
    if (typeof node.type === 'function') {
      let rec = records.get(node.type)
      if (!rec) {
        rec = { slots: [] }
        records.set(node.type, rec)
      }
      rec.cursor = 0
      stack.push(rec)
      let out
      try {
        out = node.type(node.props)
      } finally {
        stack.pop()
      }
      return resolve(out)
    }
    return { tag: node.type, props: node.props, children: node.children.map(resolve).filter((c) => c !== null) }
  }

  function text(node) {
    if (node === null) return ''
    if (typeof node === 'string') return node
    if (Array.isArray(node)) return node.map(text).join(' ')
    return node.children.map(text).join(' ')
  }

  function findAll(node, hit, acc = []) {
    if (node === null || typeof node === 'string') return acc
    if (Array.isArray(node)) {
      for (const child of node) findAll(child, hit, acc)
      return acc
    }
    if (hit(node)) acc.push(node)
    for (const child of node.children) findAll(child, hit, acc)
    return acc
  }

  // Render, run the effects the render registered, repeat until nothing is dirty.
  async function settle(Component, props, rounds = 10) {
    let tree = resolve(createElement(Component, props))
    for (let round = 0; round < rounds; round += 1) {
      for (let i = 0; i < 40; i += 1) await new Promise((done) => setImmediate(done))
      const pending = queue
      queue = []
      for (const item of pending) {
        const slot = item.rec.slots[item.at]
        if (slot && typeof slot.cleanup === 'function') slot.cleanup()
        const cleanup = slot && slot.fn ? slot.fn() : undefined
        if (slot) slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
      }
      if (!dirty && pending.length === 0) break
      dirty = false
      tree = resolve(createElement(Component, props))
    }
    return tree
  }

  return { api, settle, text, findAll, reset: () => records.clear() }
}

/* -------------------------------------------------------------------------- */
/* boot                                                                        */
/* -------------------------------------------------------------------------- */

const SNAPSHOT = {
  ok: true,
  servers: [
    {
      entryId: 'include:rea-mcp',
      rawId: 'rea-mcp',
      serverName: 'rea',
      enabled: false,
      fiberPhase: null,
      toolCount: 0,
      schemaBytes: 0,
      estTokens: 0,
      breakdown: null,
      layer: 'home',
      layers: [],
      calls: { calls: 42, failed: 1, avgMs: 310 },
      inFile: true,
    },
    {
      entryId: 'include:fresh-mcp',
      rawId: 'fresh-mcp',
      serverName: 'fresh',
      enabled: true,
      fiberPhase: 'active',
      toolCount: 3,
      schemaBytes: 128,
      estTokens: 32,
      breakdown: null,
      layer: 'home',
      layers: [],
      calls: null,
      inFile: true,
    },
  ],
  orphaned: [{ id: 'pending-mcp', serverName: 'pending', transport: 'stdio' }],
  totals: {
    servers: 2,
    enabled: 1,
    disabled: 1,
    mcpToolCount: 3,
    mcpSchemaBytes: 128,
    mcpEstTokens: 32,
    activeEstTokens: 32,
    visibleToolCount: 3,
    hiddenToolCount: 0,
    visibleEstTokens: 32,
    baselineToolCount: 3,
    baselineEstTokens: 32,
    savingsTokens: 0,
    bytesPerToken: 4,
    calls: 42,
    callsToday: 1,
    okRate: 97.6,
  },
  patchPath: 'C:\\home\\cordis.patch.yml',
  callsPath: 'C:\\home\\calls.jsonl',
  layersReadable: true,
  panelEntry: 'settings',
  panelEntryFile: 'C:\\home\\state.json',
}

async function boot({ snapshot = SNAPSHOT, confirm = true } = {}) {
  const source = await readFile(CLIENT, 'utf8')
  const react = makeReact()
  const posts = []
  let definition = null

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    navigator: { language: 'zh-CN' },
    URLSearchParams,
    URL,
    window: {
      __ModuleLoader__: {
        load(value) {
          definition = value
        },
      },
      setTimeout,
      confirm: () => confirm,
    },
    document: { createElement: () => ({ setAttribute() {}, parentNode: null }), head: { appendChild() {} } },
    fetch: async (url, init) => {
      const method = (init && init.method) || 'GET'
      let payload = snapshot
      if (method === 'POST') {
        posts.push({ url: String(url), body: JSON.parse(init.body) })
        payload = { ok: true }
      }
      return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'mcp-switch/client.js' })

  assert.ok(definition, 'client.js must hand its definition to window.__ModuleLoader__')

  const client = definition.factory((name) => {
    if (name === 'react') return react.api
    throw new Error(`client.js must not require "${name}"`)
  })

  const rows = []
  const slots = {
    register(registration, component) {
      const row = Object.assign({}, registration, { component })
      rows.push(row)
      return () => {
        const at = rows.indexOf(row)
        if (at >= 0) rows.splice(at, 1)
      }
    },
    inject(_name, callback) {
      const off = callback()
      return typeof off === 'function' ? off : () => {}
    },
  }
  const ctx = {
    get(name) {
      if (name === 'slots') return slots
      if (name === 'locale') return { getLocale: () => ({ active: 'zh' }), subscribe: () => () => {} }
      return undefined
    },
    effect: (fn) => fn(),
    inject: (_deps, callback) =>
      callback({ layout: { selectPanel() {}, panelInfo: { getSnapshot: () => ({ activePanelId: null }) } } }),
  }

  client.apply(ctx)
  for (let i = 0; i < 5; i += 1) await new Promise((done) => setImmediate(done))

  const section = rows.find((row) => row.name === 'settings.section')
  assert.ok(section, 'the settings seat must be registered with the default panel entry')
  return { react, section, posts }
}

// Children live on the node, not in props, in this stub — read them from the node.
const buttonText = (node) => node.children.map((child) => (typeof child === 'string' ? child : '')).join('')

/* -------------------------------------------------------------------------- */
/* tests                                                                       */
/* -------------------------------------------------------------------------- */

test('a row that is in the patch file but not mounted is shown, with a way back out', async () => {
  const { react, section } = await boot()
  const tree = await react.settle(section.component, { ctx: undefined })
  const body = react.text(tree)

  assert.match(body, /已写入补丁，尚未挂载/, 'the pending section must be titled')
  assert.match(body, /pending/, 'the pending row must name the server')
  assert.match(body, /pending-mcp/, 'the pending row must show the id that Remove needs')

  const remove = react
    .findAll(tree, (node) => node.tag === 'button' && /删除/.test(react.text(node)))
    .find((node) => true)
  assert.ok(remove, 'a pending row must offer Remove, since it has no switch to flip')
})

test('the Remove button on a pending row posts remove-server with that row id', async () => {
  const { react, section, posts } = await boot()
  const tree = await react.settle(section.component, { ctx: undefined })

  const remove = react.findAll(tree, (node) => node.tag === 'button' && /删除/.test(buttonText(node)))[0]
  assert.ok(remove, 'Remove must be rendered')
  remove.props.onClick()
  for (let i = 0; i < 20; i += 1) await new Promise((done) => setImmediate(done))

  assert.equal(posts.length, 1, 'one click must send exactly one request')
  assert.deepEqual(posts[0].body, { action: 'remove-server', rawId: 'pending-mcp' })
})

test('a cancelled confirm sends nothing', async () => {
  const { react, section, posts } = await boot({ confirm: false })
  const tree = await react.settle(section.component, { ctx: undefined })

  const remove = react.findAll(tree, (node) => node.tag === 'button' && /删除/.test(buttonText(node)))[0]
  assert.ok(remove, 'Remove must be rendered')
  remove.props.onClick()
  for (let i = 0; i < 20; i += 1) await new Promise((done) => setImmediate(done))

  assert.deepEqual(posts, [], 'declining the confirm must not touch the patch file')
})

test('per-server call counts are shown, and a server with none says so', async () => {
  const { react, section } = await boot()
  const tree = await react.settle(section.component, { ctx: undefined })
  const body = react.text(tree)

  assert.match(body, /调用: 42/, 'a server with recorded calls must show the count')
  assert.match(body, /310 ms/, 'the per-server average must be formatted')
  // The second server has `calls: null`; saying nothing would look like a bug in the counter.
  assert.match(body, /暂无调用记录/, 'a server with no calls must say so rather than stay silent')
})

test('a server that is switched off entirely still reports what it saves', async () => {
  // The regression this pins: the saving was measured against the live schema total, and a
  // disabled server registers no tools at all — so the biggest saving available showed as
  // zero and the "saved per request" card disappeared exactly when it mattered.
  const off = {
    ...SNAPSHOT,
    servers: [
      {
        entryId: 'include:mock-mcp',
        rawId: 'mock-mcp',
        serverName: 'mock',
        enabled: false,
        fiberPhase: null,
        toolCount: 0,
        schemaBytes: 0,
        estTokens: 0,
        knownToolCount: 6,
        knownSchemaBytes: 707,
        knownEstTokens: 177,
        breakdown: null,
        layer: 'home',
        layers: [],
        calls: null,
        inFile: true,
      },
    ],
    orphaned: [],
    totals: {
      ...SNAPSHOT.totals,
      servers: 1,
      enabled: 0,
      disabled: 1,
      mcpToolCount: 0,
      mcpSchemaBytes: 0,
      mcpEstTokens: 0,
      activeEstTokens: 0,
      visibleToolCount: 0,
      hiddenToolCount: 0,
      visibleEstTokens: 0,
      baselineToolCount: 6,
      baselineEstTokens: 177,
      savingsTokens: 177,
    },
  }
  const { react, section } = await boot({ snapshot: off })
  const tree = await react.settle(section.component, { ctx: undefined })
  const body = react.text(tree)

  assert.match(body, /177/, 'the saved card must show the cached cost of the disabled server')
  assert.match(body, /每轮当前节省约/, 'the card must explain what the number means')
  // The tools card must use the same denominator as the row, or it reads 0 / 0 beside 0/6.
  assert.match(body, /0 \/ 6/, 'the totals must count the disabled server tools as the denominator')
})

test('no pending section is rendered when nothing is pending', async () => {
  const { react, section } = await boot({ snapshot: { ...SNAPSHOT, orphaned: [] } })
  const tree = await react.settle(section.component, { ctx: undefined })

  assert.doesNotMatch(react.text(tree), /已写入补丁，尚未挂载/)
})

test('a damaged state file is announced, with where the old bytes went', async () => {
  // The switches in this panel come from the state file. When that file is unusable the host
  // silently falls back to the defaults, so the panel must say so — otherwise "everything is
  // enabled" reads as the user's own choice rather than as lost preferences.
  const damaged = {
    ...SNAPSHOT,
    stateFile: 'C:\\home\\dsh-mcp-switch\\state.json',
    stateError: "Expected property name or '}' in JSON at position 1",
    stateBrokenPath: 'C:\\home\\dsh-mcp-switch\\state.json.broken-2026-11-13T06-55-07-218Z',
    stateMoveError: null,
  }
  const { react, section } = await boot({ snapshot: damaged })
  const tree = await react.settle(section.component, { ctx: undefined })
  const body = react.text(tree)

  assert.match(body, /状态文件有问题/, 'the notice must be titled')
  assert.match(body, /broken-2026-11-13T06-55-07-218Z/, 'the notice must name the backup file')
  assert.match(body, /默认值/, 'the notice must say the switches below are defaults')
})

test('a state file that could not be moved aside is not reported as backed up', async () => {
  // Reporting a broken path that names nothing is worse than reporting the failure: the user
  // would go looking for a backup file that does not exist.
  const stuck = {
    ...SNAPSHOT,
    stateError: 'EISDIR: illegal operation on a directory, read',
    stateBrokenPath: null,
    stateMoveError: 'EPERM: operation not permitted, rename',
  }
  const { react, section } = await boot({ snapshot: stuck })
  const body = react.text(await react.settle(section.component, { ctx: undefined }))

  assert.match(body, /没能移走/, 'the notice must say the file could not be moved')
  assert.doesNotMatch(body, /已备份为/, 'a failed move must not be described as a backup')
})

test('a healthy state file shows no notice at all', async () => {
  const { react, section } = await boot()
  const body = react.text(await react.settle(section.component, { ctx: undefined }))

  assert.doesNotMatch(body, /状态文件有问题/)
})

test('damage consumed by the file watcher is still reported after the fact', async () => {
  // The panel is almost never the read that finds the broken file: the 250 ms watcher gets
  // there first, moves the bytes aside and rewrites a good primary. By the time the user opens
  // the panel every read succeeds and the only trace left is that the primary went missing and
  // the data came back from .bak. That aftermath has to be enough to raise the notice, or the
  // one session that lost its preferences is the one session that never hears about it.
  const aftermath = {
    ...SNAPSHOT,
    stateError: null,
    stateMissing: true,
    stateBackupUsed: 'C:\\home\\dsh-mcp-switch\\state.json.bak',
    stateDamage: {
      error: "Expected property name or '}' in JSON at position 1",
      brokenPath: 'C:\\home\\dsh-mcp-switch\\state.json.broken-2026-11-13T07-02-04-819Z',
      moveError: null,
      at: '2026-11-13T07:02:04.822Z',
    },
  }
  const { react, section } = await boot({ snapshot: aftermath })
  const body = react.text(await react.settle(section.component, { ctx: undefined }))

  assert.match(body, /状态文件有问题/, 'the aftermath must still raise the notice')
  assert.match(body, /state\.json\.bak/, 'the notice must say where the data came from')
  assert.match(body, /broken-2026-11-13T07-02-04-819Z/, 'the notice must name the moved-aside bytes')
  assert.match(body, /备份里的偏好/, 'the notice must not claim the switches are plain defaults')
})

test('a state file that fell back to defaults says so, not that it came from a backup', async () => {
  // Same damage, different recovery: no usable .bak means the host really did start from the
  // defaults. Telling the user their preferences "came from the backup" there would be a lie.
  const lost = {
    ...SNAPSHOT,
    stateError: null,
    stateMissing: true,
    stateBackupUsed: null,
    stateDamage: {
      error: "Expected property name or '}' in JSON at position 1",
      brokenPath: 'C:\\home\\dsh-mcp-switch\\state.json.broken-2026-11-13T07-02-04-819Z',
      moveError: null,
      at: '2026-11-13T07:02:04.822Z',
    },
  }
  const { react, section } = await boot({ snapshot: lost })
  const body = react.text(await react.settle(section.component, { ctx: undefined }))

  assert.match(body, /状态文件有问题/)
  assert.match(body, /默认值/, 'with no backup the switches really are the defaults')
  assert.doesNotMatch(body, /备份里的偏好/, 'the notice must not promise a recovery that did not happen')
})
