/**
 * dsh-mcp-switch — host half.
 *
 * What it does:
 *   1. Prices every MCP server in context tokens, measured from the *model-facing*
 *      projection (ctx.tools.schemas()), so you can see that a 200-tool server costs
 *      ~180k tokens per request before you decide to turn it off.
 *   2. Reports which patch layer each row lives in (home / profile / bundle), because
 *      the home layer outranks the profile layer and that determines where a
 *      `disabled:` override must be written to actually win.
 *   3. Bulk actions (disable-all / enable-all), since the usual intent is
 *      "turn all of these off, I will re-enable one".
 *
 * Invariants (see AGENTS.md of dsh-mcp-switch):
 *   - packaged plugin, client talks to this host half over its HTTP route;
 *   - list only rows whose options.name is the official client package;
 *   - live toggle must be entry-level Entry#update, never EntryTree#update
 *     (the tree wrapper calls tree.write() and flattens patches into config);
 *   - persistence is an UPSERT of one top-level `- id: <rawId>` + `disabled:` row into
 *     the HOME patch layer, which outranks the profile layer; the file is edited
 *     line-wise and never rewritten wholesale;
 *   - raw config id (entry.options.id) is what patch rows carry, not the prefixed
 *     loader id (`include:<rawId>`) that the client round-trips;
 *   - every failure returns JSON, never a non-JSON 500.
 */

import { appendFile, mkdir, readFile, writeFile, readdir, rename, rm } from 'node:fs/promises'
import { watch } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'

import {
  appendServerBlock,
  listServerRows,
  normalizePatchLines,
  removeServerRows,
  suggestServerName,
  validateServerSpec,
} from './lib/patch.js'
import {
  CALL_MEMORY_LIMIT,
  CALL_PRUNE_EVERY,
  findPending,
  parseCallLines,
  pruneRows,
  settleRow,
  startRow,
  summarizeCalls,
  toCallLine,
} from './lib/calls.js'
import { scanAll } from './lib/scan.js'
import { cacheFresh, collapseVersions, fetchCatalog, specFromEntry } from './lib/catalog.js'
import {
  MAX_TOOL_NAME,
  createDefaultState,
  deniedToolNames,
  describeToolSchemas,
  readStateDocument,
  sanitizeState,
  serverStateOf,
  setServerPending,
  setToolEnabled,
  subscribeStateWrites,
  utf8Bytes,
  writeStateDocument,
  writeTextAtomic,
} from './lib/tool-state.js'

export const name = 'dsh-mcp-switch'
export const inject = ['webServer']

const ROUTE = '/mcp-switch/api'
const MCP_CLIENT_PLUGIN = '@deepseek-ai/dsh-mcp-client'
const MAX_BODY_BYTES = 1_000_000

/** Loader fiber states (cordis-plugin-loader). 4 is a terminal/unused slot. */
const FIBER_PHASE = { 0: 'pending', 1: 'loading', 2: 'active', 3: 'failed', 4: null, 5: 'unloading' }

/** Entry ids/names this plugin refuses to touch (the patch root and itself). */
const LOCKED = new Set(['include', 'cordis:include', 'dsh-mcp-switch'])
const LOCKED_NAMES = new Set(['cordis:include', 'dsh-mcp-switch'])

/**
 * Bytes per token used for the cost estimate. This is a deliberate, stated
 * approximation: the real ratio depends on the tokenizer and on how much of the
 * schema is structural punctuation, and the harness bills a tokenizer we cannot
 * call from here. 4 B/token is the conventional English/JSON figure and matches
 * the order of magnitude measured on this host for the REA tool block.
 */
const BYTES_PER_TOKEN = 4

/**
 * How many pre-edit snapshots of the patch file to keep beside it
 * (`cordis.patch.yml.backup-<iso>`). Enough to undo a mistaken click, few enough
 * that a long session cannot leave hundreds of copies in `$DSH_HOME`.
 */
const BACKUP_KEEP = 10

/**
 * The seats this plugin's panel is allowed to occupy.
 *
 * Exported and shared by the host validator and the client's option list, because two
 * copies of this list would eventually disagree — and the disagreement would surface as
 * a value the UI happily renders but the host rejects.
 */
export const PANEL_ENTRY_VALUES = ['sidebar', 'settings']

/**
 * Where the panel goes when nothing has been chosen yet.
 *
 * Deliberately `'settings'`, rather than the more common `'sidebar'` default. The rule
 * is not "match other panels", it is "never move a panel the user did not ask to move":
 * every install that predates this option renders in the settings page, so a
 * `'sidebar'` default would silently relocate a page on upgrade. A new option has to be
 * inert until someone chooses it.
 */
export const DEFAULT_PANEL_ENTRY = 'settings'

/* -------------------------------------------------------------------------- */
/* pure helpers — no I/O, so they are unit-testable without a DSH process      */
/* -------------------------------------------------------------------------- */

/** Is this exactly one of the two seats? The single source of truth for validation. */
export function isPanelEntry(value) {
  return typeof value === 'string' && PANEL_ENTRY_VALUES.includes(value)
}

/**
 * Normalise a stored panel seat.
 *
 * Only an exact member of {@link PANEL_ENTRY_VALUES} survives; everything else — a
 * missing key, a hand-edited file, a half-written file, a number — falls back to
 * {@link DEFAULT_PANEL_ENTRY}.
 *
 * Note the direction. An unreadable preference resolves to the *default*, never to
 * "the last value we saw": a fallback that guessed would make a read failure
 * indistinguishable from a user decision, which is the one bug this option must not
 * have. {@link writePanelEntry} is the opposite case — it rejects rather than coerces,
 * because there the value is an instruction, not a memory.
 */
export function sanitizePanelEntry(raw) {
  return isPanelEntry(raw) ? raw : DEFAULT_PANEL_ENTRY
}

export function fiberPhaseLabel(phase) {
  if (phase === null || phase === undefined) return null
  return FIBER_PHASE[phase] ?? null
}

export function isLocked(id, entryName) {
  if (typeof id !== 'string' || id.length === 0) return true
  if (LOCKED.has(id)) return true
  return typeof entryName === 'string' && LOCKED_NAMES.has(entryName)
}

/** Display label for a row: the MCP serverName, else the package name, else the id. */
export function serverNameOf(entry) {
  const configured = entry?.options?.config?.serverName
  if (typeof configured === 'string' && configured.length > 0) return configured
  const packageName = entry?.options?.name
  if (typeof packageName === 'string' && packageName.length > 0) return packageName
  return String(entry?.id ?? 'unknown')
}

export function estimateTokens(bytes, bytesPerToken = BYTES_PER_TOKEN) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0
  const divisor = Number.isFinite(bytesPerToken) && bytesPerToken > 0 ? bytesPerToken : BYTES_PER_TOKEN
  return Math.round(bytes / divisor)
}

/** The model-facing tool name an official MCP row contributes: mcp__<serverName>__<tool>. */
export function toolPrefixFor(serverName) {
  return `mcp__${serverName}__`
}

/**
 * Group the model-facing tool schemas by owning MCP server and price each group.
 *
 * Only tools carrying the `mcp__<server>__` prefix are attributed, so this never
 * inflates an MCP server's bill with built-in tools.
 *
 * What is measured: exactly the fields the harness sends to the model for each tool
 * (name + description + parameters). An advertised outputSchema is NOT part of the
 * model-facing projection, so it is correctly absent from this number — which is why
 * this figure is smaller than a raw tools/list payload and larger than nothing.
 */
export function summarizeSchemas(schemas) {
  const byPrefix = new Map()
  let totalToolCount = 0
  let totalBytes = 0

  for (const schema of schemas ?? []) {
    const toolName = schema?.name
    if (typeof toolName !== 'string' || !toolName.startsWith('mcp__')) continue
    const rest = toolName.slice('mcp__'.length)
    const sep = rest.indexOf('__')
    if (sep <= 0) continue
    const serverName = rest.slice(0, sep)

    const nameBytes = utf8Bytes(toolName)
    const descriptionBytes = utf8Bytes(schema.description)
    let parameterBytes = 0
    try {
      parameterBytes = utf8Bytes(JSON.stringify(schema.parameters ?? {}))
    } catch {
      parameterBytes = 0
    }
    const bytes = nameBytes + descriptionBytes + parameterBytes

    const entry = byPrefix.get(serverName) ?? {
      serverName,
      toolCount: 0,
      schemaBytes: 0,
      nameBytes: 0,
      descriptionBytes: 0,
      parameterBytes: 0,
    }
    entry.toolCount += 1
    entry.schemaBytes += bytes
    entry.nameBytes += nameBytes
    entry.descriptionBytes += descriptionBytes
    entry.parameterBytes += parameterBytes
    byPrefix.set(serverName, entry)

    totalToolCount += 1
    totalBytes += bytes
  }

  for (const entry of byPrefix.values()) entry.estTokens = estimateTokens(entry.schemaBytes)

  return { byServer: byPrefix, totalToolCount, totalBytes, totalEstTokens: estimateTokens(totalBytes) }
}

/**
 * The token cost of the same server list with nothing switched off — the baseline a saving
 * is measured against. A live server answers with its own schema total. A disabled server
 * registers no tools at all, so its live cost is zero and only the cache from its last
 * connection remembers what it used to cost; without that fallback, switching a whole
 * server off would report the largest saving of all as no saving at all.
 */
export function baselineOf(servers) {
  let toolCount = 0
  let estTokens = 0
  for (const server of servers ?? []) {
    const liveTools = Number(server?.toolCount) || 0
    const liveTokens = Number(server?.estTokens) || 0
    if (server?.enabled === false) {
      toolCount += Math.max(liveTools, Number(server?.knownToolCount) || 0)
      estTokens += Math.max(liveTokens, Number(server?.knownEstTokens) || 0)
    } else {
      toolCount += liveTools
      estTokens += liveTokens
    }
  }
  return { toolCount, estTokens }
}

/** Unquote a YAML scalar well enough to compare ids written by hand or by a tool. */
export function unquoteYaml(text) {
  const value = String(text ?? '').trim()
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1)
    }
  }
  return value
}

/** Quote an id for YAML only when a bare scalar would be ambiguous. */
export function yamlScalar(value) {
  return /^[A-Za-z0-9_.@/-]+$/.test(value) ? value : JSON.stringify(value)
}

/** Split file text into lines while remembering whether CRLF endings were used. */
export function splitLines(text) {
  const crlf = text.includes('\r\n')
  const lines = text.split('\n')
  if (crlf) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].endsWith('\r')) lines[i] = lines[i].slice(0, -1)
    }
  }
  return { lines, crlf }
}

export function joinLines(lines, crlf) {
  const eol = crlf ? '\r\n' : '\n'
  return lines.join(eol)
}

/**
 * Find every place a raw id appears in a patch file, whichever form it takes:
 * a top-level `- id: x` row, or a row nested inside an `insert:` list.
 * Returns { topLevel: index|-1, nested: index|-1 }.
 */
export function findIdRow(lines, rawId) {
  let result = { topLevel: -1, nested: -1 }
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)- id: (.+)$/.exec(lines[i])
    if (!match) continue
    if (unquoteYaml(match[2]) !== rawId) continue
    if (match[1].length === 0) result.topLevel = i
    else result.nested = i
  }
  return result
}

export function hasIdRow(lines, rawId) {
  const found = findIdRow(lines, rawId)
  return found.topLevel !== -1 || found.nested !== -1
}

/**
 * Upsert a top-level `- id: <rawId>` row carrying `disabled: <bool>`.
 *
 * Behaviour is line-wise and additive, never a rewrite:
 *   - an existing top-level row for the id gets its `disabled:` line replaced
 *     in place (last one wins, so exactly one such line remains);
 *   - a top-level row without any `disabled:` line gains one, indented to match
 *     the row's own children;
 *   - otherwise a fresh two-line row is appended.
 *
 * A row nested inside an `insert:` list is deliberately NOT edited in place: the
 * appended top-level override is the documented "override/disable a composed entry"
 * form, it also wins over the profile layer, and it keeps the original insert list
 * byte-identical.
 */
export function upsertDisabled(lines, rawId, disabled) {
  const target = yamlScalar(rawId)
  const next = normalizePatchLines(lines)
  let currentId = null
  let currentIndent = -1
  let rowIndex = -1
  let disabledIndex = -1

  for (let i = 0; i < next.length; i++) {
    const idMatch = /^(\s*)- id: (.+)$/.exec(next[i])
    if (idMatch) {
      currentIndent = idMatch[1].length
      currentId = currentIndent === 0 ? unquoteYaml(idMatch[2]) : null
      if (currentId === rawId) rowIndex = i
      continue
    }
    // 只认**直接子级**的 disabled：`config:` 下面同名的键属于服务器配置，
    // 不是行级开关，改错它等于改了别人的配置项而开关本身没动。
    if (currentId !== rawId || rowIndex === -1) continue
    const lineIndent = /^(\s*)/.exec(next[i])[1].length
    if (lineIndent === currentIndent + 2 && /^\s+disabled:/.test(next[i])) disabledIndex = i
  }

  if (disabledIndex !== -1) {
    const indent = /^(\s*)/.exec(next[disabledIndex])[1]
    const updated = `${indent}disabled: ${disabled ? 'true' : 'false'}`
    // A toggle to the state it already holds must not touch the file: rewriting it
    // would churn mtime, drop a pointless backup, and wake the patch HMR watcher.
    if (next[disabledIndex] === updated) {
      return { lines, changed: false, mode: 'unchanged' }
    }
    next[disabledIndex] = updated
    return { lines: next, changed: true, mode: 'replaced' }
  }

  if (rowIndex !== -1) {
    const indent = `${/^(\s*)/.exec(next[rowIndex])[1]}  `
    next.splice(rowIndex + 1, 0, `${indent}disabled: ${disabled ? 'true' : 'false'}`)
    return { lines: next, changed: true, mode: 'inserted' }
  }

  const endsWithBlank = next.length > 0 && next[next.length - 1].trim() === ''
  const appended = []
  if (!endsWithBlank && next.length > 0) appended.push('')
  appended.push(`- id: ${target}`, `  disabled: ${disabled ? 'true' : 'false'}`, '')
  return { lines: next.concat(appended), changed: true, mode: 'appended' }
}

/** Resolve the home patch layer: $DSH_HOME/cordis.patch.yml (default ~/.dsh). */
export function resolveHomePatchPath(env = process.env, home = os.homedir()) {
  const dshHome = env.DSH_HOME && String(env.DSH_HOME).trim() ? String(env.DSH_HOME).trim() : path.join(home, '.dsh')
  return path.join(dshHome, 'cordis.patch.yml')
}

export function resolveDshHome(env = process.env, home = os.homedir()) {
  return env.DSH_HOME && String(env.DSH_HOME).trim() ? String(env.DSH_HOME).trim() : path.join(home, '.dsh')
}

/**
 * Resolve this plugin's own state file: $DSH_HOME/dsh-mcp-switch/state.json.
 *
 * Deliberately NOT the patch layer. The patch file expresses composition — which
 * plugins exist and with what config — and this plugin's standing contract is to touch
 * it only by appending one line-wise `disabled:` override. A UI preference kept there
 * would wake the patch watcher and re-apply a composition on every click, for a value
 * no composition ever reads.
 */
export function resolveStatePath(env = process.env, home = os.homedir()) {
  return path.join(resolveDshHome(env, home), 'dsh-mcp-switch', 'state.json')
}

/* -------------------------------------------------------------------------- */
/* patch layer inspection                                                     */
/* -------------------------------------------------------------------------- */

async function readPatchLines(file) {
  try {
    const text = await readFile(file, 'utf8')
    return { ok: true, ...splitLines(text) }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, lines: [], crlf: false, missing: true }
    return { ok: false, lines: [], crlf: false, error: String(error?.message ?? error) }
  }
}

/**
 * Every layer a raw id could live in. Read-only: this never writes.
 * Layers are reported so the UI can explain WHERE a row comes from, and so a
 * "disabled: true" that is silently shadowed by a higher layer is visible.
 */
async function inspectLayers(rawId, ctx) {
  const homePath = resolveHomePatchPath()
  const layers = []

  const home = await readPatchLines(homePath)
  if (home.ok) {
    layers.push({ layer: 'home', file: homePath, present: hasIdRow(home.lines, rawId), readable: true })
  } else {
    layers.push({ layer: 'home', file: homePath, present: false, readable: false, error: home.error })
  }

  const profilesDir = path.join(resolveDshHome(), 'profiles')
  let profileNames = []
  try {
    const entries = await readdir(profilesDir, { withFileTypes: true })
    profileNames = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    profileNames = []
  }

  for (const profileName of profileNames) {
    const file = path.join(profilesDir, profileName, 'cordis.patch.yml')
    const parsed = await readPatchLines(file)
    if (!parsed.ok) {
      layers.push({ layer: `profile:${profileName}`, file, present: false, readable: false, error: parsed.error })
      continue
    }
    if (parsed.missing) continue
    layers.push({ layer: `profile:${profileName}`, file, present: hasIdRow(parsed.lines, rawId), readable: true })
  }

  const present = layers.filter((entry) => entry.present)
  const label = present.length === 0 ? 'bundle' : present.map((entry) => entry.layer).join('+')
  return { layers, label }
}

/* -------------------------------------------------------------------------- */
/* host plugin                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Patch-row id for a loader entry: the config id without the loader's `include:`
 * prefix (AGENTS.md rule 4). Mixing the two produces a patch row that matches
 * nothing, so every caller goes through here.
 */
export function rawIdOf(entry) {
  const id = typeof entry?.options?.id === 'string' && entry.options.id !== '' ? entry.options.id : entry?.id
  return String(id ?? '').replace(/^include:/, '')
}

function listMcpEntries(loader) {
  const rows = []
  for (const entry of loader.entries()) {
    if (entry?.options?.group) continue
    if (entry?.options?.name !== MCP_CLIENT_PLUGIN) continue
    const rawId = rawIdOf(entry)
    if (isLocked(rawId, entry.options.name)) continue
    rows.push({
      entryId: entry.id,
      rawId,
      serverName: serverNameOf(entry),
      enabled: !entry.disabled,
      fiberPhase: entry.fiber === undefined ? null : fiberPhaseLabel(entry.fiber.state),
    })
  }
  rows.sort((a, b) => a.serverName.localeCompare(b.serverName))
  return rows
}

async function buildSnapshot(ctx) {
  const loader = ctx.get('loader')
  if (!loader) return { ok: false, status: 503, error: 'loader service unavailable' }

  const rows = listMcpEntries(loader)

  let costs = { byServer: new Map(), totalToolCount: 0, totalBytes: 0, totalEstTokens: 0 }
  let schemas = []
  const tools = ctx.get('tools')
  if (tools && typeof tools.schemas === 'function') {
    try {
      schemas = tools.schemas() ?? []
      costs = summarizeSchemas(schemas)
    } catch (error) {
      ctx.logger?.warn?.(`mcp-switch: could not read tool schemas: ${String(error?.message ?? error)}`)
    }
  }

  // What the patch file says, so the UI can tell "a row exists but its fiber is gone" from
  // "there is no row at all" — the first is a broken server, the second is an empty slot.
  const patch = await readPatchLines(resolveHomePatchPath())
  const inFile = patch.ok ? listServerRows(patch.lines) : []
  const fileIds = new Map(inFile.map((row) => [row.id, row]))

  // Per-server call counts, so the list can answer "is anything using this?" without a
  // second request. Read here rather than cached: the log is small and this route is
  // user-initiated.
  const callLog = await readCalls()
  const callStats = summarizeCalls(pruneRows(callLog.rows))
  const callsByServer = new Map(callStats.servers.map((row) => [row.server, row]))

  const state = await readState()
  const toolRowsByServer = describeToolSchemas(schemas, state)

  const servers = []
  for (const row of rows) {
    const cost = costs.byServer.get(row.serverName)
    const { layers, label } = await inspectLayers(row.rawId, ctx)
    const calls = callsByServer.get(row.serverName)
    const toolRows = toolRowsByServer.get(row.serverName) ?? []
    const visible = toolRows.filter((tool) => tool.enabled)
    const knownTools = state.servers?.[row.serverName]?.knownTools ?? []
    servers.push({
      ...row,
      toolCount: cost?.toolCount ?? 0,
      schemaBytes: cost?.schemaBytes ?? 0,
      estTokens: cost?.estTokens ?? 0,
      breakdown: cost
        ? { nameBytes: cost.nameBytes, descriptionBytes: cost.descriptionBytes, parameterBytes: cost.parameterBytes }
        : null,
      tools: toolRows,
      knownTools,
      knownToolCount: knownTools.length,
      knownSchemaBytes: knownTools.reduce((sum, tool) => sum + (Number(tool.schemaBytes) || 0), 0),
      knownEstTokens: knownTools.reduce((sum, tool) => sum + (Number(tool.estTokens) || 0), 0),
      visibleToolCount: visible.length,
      hiddenToolCount: toolRows.length - visible.length,
      visibleBytes: visible.reduce((sum, tool) => sum + tool.schemaBytes, 0),
      visibleEstTokens: visible.reduce((sum, tool) => sum + tool.estTokens, 0),
      pending: state.servers?.[row.serverName]?.pending ?? null,
      layer: label,
      layers,
      calls: calls ? { calls: calls.calls, failed: calls.failed, avgMs: calls.avgMs } : null,
      inFile: fileIds.has(row.rawId),
    })
  }

  // Rows the file declares but the loader does not run: usually a config error, and worth
  // showing rather than hiding behind "no server named that".
  const orphaned = inFile.filter((row) => !rows.some((live) => live.rawId === row.id))

  const enabled = servers.filter((server) => server.enabled)
  const visibleToolCount = servers.reduce((sum, server) => sum + server.visibleToolCount, 0)
  const hiddenToolCount = servers.reduce((sum, server) => sum + server.hiddenToolCount, 0)
  const visibleEstTokens = enabled.reduce((sum, server) => sum + server.visibleEstTokens, 0)
  const baseline = baselineOf(servers)
  return {
    ok: true,
    servers,
    orphaned,
    totals: {
      servers: servers.length,
      enabled: enabled.length,
      disabled: servers.length - enabled.length,
      mcpToolCount: costs.totalToolCount,
      mcpSchemaBytes: costs.totalBytes,
      mcpEstTokens: costs.totalEstTokens,
      activeEstTokens: enabled.reduce((sum, server) => sum + server.estTokens, 0),
      visibleToolCount,
      hiddenToolCount,
      visibleEstTokens,
      // What the same list would cost with nothing switched off — the denominator the UI
      // needs so a fully disabled server reads "0 / 6", not "0 / 0".
      baselineToolCount: baseline.toolCount,
      baselineEstTokens: baseline.estTokens,
      // Measured against what the model would carry with nothing switched off, which is not
      // the live schema total: a disabled server registers no tools at all, so its live
      // cost is zero and the largest saving of all would read as nothing saved.
      savingsTokens: Math.max(0, baseline.estTokens - visibleEstTokens),
      bytesPerToken: BYTES_PER_TOKEN,
      calls: callStats.total,
      callsToday: callStats.today,
      okRate: callStats.okRate,
    },
    callStats,
    patchPath: resolveHomePatchPath(),
    callsPath: resolveCallsPath(),
    layersReadable: servers.every((server) => server.layers.every((layer) => layer.readable)),
    // The client needs the panel seat before it can decide which slot to register, so it
    // rides along on the snapshot it already fetches rather than on a second endpoint.
    panelEntry: state.panelEntry,
    panelEntryFile: state.file,
    panelEntryError: state.error ?? state.stateError,
    stateFile: state.file,
    stateError: state.error ?? state.stateError ?? null,
    // The damage is consumed by whichever read notices it first — and that is usually the
    // file watcher, not the panel. What survives is the aftermath: the primary is gone and
    // every later read is served from the backup. Without this the UI would only ever be
    // able to report damage it happened to witness, which is almost never.
    stateMissing: state.missing === true,
    stateBackupUsed: state.backupUsed ?? null,
    stateDamage: stateDamage(),
    stateBrokenPath: state.brokenPath ?? null,
    // A corrupt primary that could not be moved aside is reported instead of pointing at a
    // path that does not exist; the bytes stay where they are until the next successful read.
    stateMoveError: state.moveError ?? null,
  }
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    req.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0
        finish({ ok: false, error: 'payload too large' })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        finish({ ok: true, value: text.trim() ? JSON.parse(text) : {} })
      } catch {
        finish({ ok: false, error: 'unreadable request body' })
      }
    })
    req.on('error', () => finish({ ok: false, error: 'unreadable request body' }))
    req.on('aborted', () => finish({ ok: false, error: 'unreadable request body' }))
  })
}

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Keep a rolling copy of the patch file before we touch it.
 *
 * Rewriting `$DSH_HOME/cordis.patch.yml` in place with no backup and no approval gate
 * is a trap: a bad edit there can break host startup for every profile. The write path
 * is small and test-covered, but "small and tested" is not "recoverable", so every
 * mutation first drops a timestamped copy.
 *
 * Never throws: a failed backup must not block a legitimate toggle, but it IS
 * reported in the result so the caller can see the write went unguarded.
 */
async function backupPatchFile(file, previousText) {
  if (previousText == null) return { ok: true, skipped: 'no previous file' }
  try {
    const dir = path.dirname(file)
    const base = `${path.basename(file)}.backup-`
    const taken = new Set(await readdir(dir).catch(() => []))
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = path.join(dir, backupNameFor(base, stamp, taken))
    await writeFile(target, previousText, 'utf8')
    await pruneBackups(file)
    return { ok: true, path: target }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/**
 * Pick a free backup filename: `<base><stamp>-<nn>`.
 *
 * The sequence suffix is not decoration. Names used to be `<base><stamp>` alone, and
 * `stamp` has only millisecond resolution — so two writes inside the same millisecond
 * produced the SAME name and the second silently OVERWROTE the first. On a fast
 * filesystem that is routine rather than exotic: CI on Linux + Node 24 ran the prune
 * test, which writes 12 toggles, and found 8 backup files instead of 10 — only 8
 * distinct milliseconds had elapsed and four copies were already destroyed. A backup
 * that quietly loses the copy you need is worse than no backup, so uniqueness is
 * enforced here instead of assumed from the clock.
 *
 * The suffix is zero-padded to a fixed width so a plain lexicographic sort of the names
 * is still chronological; `pruneBackups` keeps the newest by exactly that sort.
 */
export function backupNameFor(base, stamp, taken) {
  for (let seq = 0; seq < 100; seq++) {
    const name = `${base}${stamp}-${String(seq).padStart(2, '0')}`
    if (!taken.has(name)) return name
  }
  // Unreachable in practice: it would take 100 writes to one file inside a single
  // millisecond, and each write is a full async read/write cycle. Kept so that a
  // pathological clock cannot make the name collide again.
  return `${base}${stamp}-99-${Math.random().toString(36).slice(2, 8)}`
}

/** Keep only the most recent BACKUP_KEEP copies, so a chatty UI cannot fill the disk. */
export async function pruneBackups(file) {
  try {
    const dir = path.dirname(file)
    const base = `${path.basename(file)}.backup-`
    const stale = (await readdir(dir))
      .filter((entry) => entry.startsWith(base))
      .sort()
      .slice(0, -BACKUP_KEEP)
    for (const entry of stale) {
      await rm(path.join(dir, entry), { force: true })
    }
  } catch {
    // Pruning is best-effort housekeeping; never surface its failure.
  }
}

/** Persist the desired state of one raw id into the HOME patch layer. */
export async function persistDisabled(rawId, disabled) {
  const file = resolveHomePatchPath()
  const existing = await readPatchLines(file)
  if (!existing.ok) return { ok: false, error: existing.error }

  const result = upsertDisabled(existing.lines, rawId, disabled)
  if (!result.changed) return { ok: true, file, mode: 'unchanged' }

  let text = joinLines(result.lines, existing.crlf)
  if (!text.endsWith('\n')) text += existing.crlf ? '\r\n' : '\n'

  // Snapshot the pre-edit bytes ("" for a file that did not exist yet).
  const backup = await backupPatchFile(file, existing.missing ? '' : joinLines(existing.lines, existing.crlf))

  try {
    // The patch is the host's authoritative config: a truncate-then-write that dies
    // half way leaves an unparsable file and DSH cannot boot. Same atomic path as state.
    await writeTextAtomic(file, text)
    return { ok: true, file, mode: result.mode, backup: backup.ok ? backup.path : null, backupError: backup.ok ? undefined : backup.error }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

/* -------------------------------------------------------------------------- */
/* panel entry preference                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Read the panel-seat preference from this plugin's own state file.
 *
 * Never throws. A missing file is the ordinary first-run state (`ok: true`, documented
 * default). A damaged primary is preserved under `state.json.broken-<timestamp>` and a
 * valid `state.json.bak` is used instead when one exists; either way the caller receives
 * a usable document and the damage is reported through `stateError`/`brokenPath`.
 */
// Damage is consumed by whoever reads first, and that is usually the file watcher (250 ms
// after the edit), not the panel. The bytes are moved aside by that read, so every later read
// sees a clean ENOENT and could report "all good" about a session that lost its preferences.
// Remembering the last damage for the life of the process is what lets the panel still say it.
let lastStateDamage = null

export function stateDamage() {
  return lastStateDamage
}

export async function readState(env = process.env, home = os.homedir()) {
  const file = resolveStatePath(env, home)
  const read = await readStateDocument(file)
  if (read.stateError) {
    lastStateDamage = {
      error: read.stateError,
      brokenPath: read.brokenPath ?? null,
      moveError: read.moveError ?? null,
      at: new Date().toISOString(),
    }
  }
  const state = sanitizeState(read.state, DEFAULT_PANEL_ENTRY)
  return {
    ...state,
    state,
    ok: read.ok,
    file,
    missing: read.missing === true,
    error: read.error,
    stateError: read.stateError,
    brokenPath: read.brokenPath,
    moveError: read.moveError,
    backupUsed: read.backupUsed,
  }
}

/**
 * All state writes are serialised. Two UI clicks in the same millisecond must not
 * read the same old document and then overwrite each other's server record.
 */
let stateWriteQueue = Promise.resolve()

function enqueueStateWrite(operation) {
  const run = stateWriteQueue.then(operation, operation)
  stateWriteQueue = run.catch(() => {})
  return run
}

/**
 * Atomically mutate the state document. The mutator receives a deep clone of the
 * current sanitized state; the returned document (or the clone itself) is written
 * with `writeStateDocument`, which keeps `state.json.bak`.
 */
export async function updateState(mutate, env = process.env, home = os.homedir()) {
  const file = resolveStatePath(env, home)
  return enqueueStateWrite(async () => {
    const current = await readState(env, home)
    const draft = JSON.parse(JSON.stringify(current.state ?? createDefaultState(DEFAULT_PANEL_ENTRY)))
    const next = mutate(draft) ?? draft
    next.updatedAt = new Date().toISOString()
    const written = await writeStateDocument(file, next)
    if (!written.ok) return { ...written, state: current.state }
    return { ...written, state: written.state }
  })
}

/**
 * Persist the panel seat.
 *
 * Rejects a value outside {@link PANEL_ENTRY_VALUES} rather than coercing it: here the
 * value is an instruction, and turning a bad instruction into a valid one would move a
 * panel nobody asked to move — with no way for the user to notice it happened.
 *
 * Written as `<file>.tmp` then renamed, so a crash mid-write cannot leave a half file
 * that the next read has to guess about.
 */
export async function writePanelEntry(entry, env = process.env, home = os.homedir()) {
  if (!isPanelEntry(entry)) {
    return { ok: false, invalid: true, error: `entry must be one of: ${PANEL_ENTRY_VALUES.join(', ')}` }
  }

  const written = await updateState((draft) => {
    draft.panelEntry = entry
    return draft
  }, env, home)
  if (!written.ok) return { ok: false, error: written.error }
  return { ok: true, file: written.file, panelEntry: entry, backupPath: written.backupPath ?? null }
}

function isMcpEntry(entry) {
  return entry?.options?.name === MCP_CLIENT_PLUGIN
}

/* -------------------------------------------------------------------------- */
/* call log                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Where the call log lives: `$DSH_HOME/dsh-mcp-switch/calls.jsonl`.
 *
 * Beside the panel preference, not in it: the state file is a handful of bytes a user may
 * hand-edit, and mixing an append-only feed into it would make every edit a rewrite of the
 * whole log.
 */
export function resolveCallsPath(env = process.env, home = os.homedir()) {
  return path.join(resolveDshHome(env, home), 'dsh-mcp-switch', 'calls.jsonl')
}

/** Patch-row id from a foreign server name. Mirrors `suggestIdFromName` in lib/catalog.js. */
function suggestId(name) {
  const cleaned = String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return cleaned === '' ? 'mcp-server' : cleaned
}

/** Read the log. A missing file is the ordinary first-run state, not an error. */
export async function readCalls(env = process.env, home = os.homedir()) {
  try {
    const text = await readFile(resolveCallsPath(env, home), 'utf8')
    return { ok: true, rows: parseCallLines(text) }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { ok: true, rows: [] }
    return { ok: false, rows: [], error: String(error?.message ?? error) }
  }
}

/**
 * Append one settled row.
 *
 * `appendFile` rather than read-modify-write: two sessions finishing at the same moment
 * must not be able to lose each other's row, and the file is the record of what happened.
 */
export async function appendCall(row, env = process.env, home = os.homedir()) {
  const file = resolveCallsPath(env, home)
  return enqueueCallWrite(async () => {
    try {
      await mkdir(path.dirname(file), { recursive: true })
      await appendFile(file, `${toCallLine(row)}\n`, 'utf8')
      return { ok: true, file }
    } catch (error) {
      return { ok: false, file, error: String(error?.message ?? error) }
    }
  })
}

/**
 * Rewrite the log down to its retention window.
 *
 * Called every {@link CALL_PRUNE_EVERY} appends, never per call: the log is a feed, and
 * a rewrite on every append would turn an O(1) write into an O(n) one for no benefit.
 */
export async function rewriteCalls(rows, env = process.env, home = os.homedir()) {
  const file = resolveCallsPath(env, home)
  try {
    const text = rows.map((row) => toCallLine(row)).join('\n')
    // Unique temp name: a clear-calls request and a background prune could otherwise
    // write the same `calls.jsonl.tmp` and one would rename the other's half file into
    // place. Serialisation happens in `enqueueCallWrite`, this only removes the collision.
    await writeTextAtomic(file, text === '' ? '' : `${text}\n`)
    return { ok: true, file, rows: rows.length }
  } catch (error) {
    return { ok: false, file, error: String(error?.message ?? error) }
  }
}

/**
 * One writer at a time for the call log.
 *
 * Appends are cheap and order-independent, but a prune is a read-modify-write: a row
 * appended between the read and the rewrite was silently lost. Serialising append and
 * prune through this queue makes the whole cycle atomic from the log's point of view.
 */
let callWriteQueue = Promise.resolve()

function enqueueCallWrite(operation) {
  const run = callWriteQueue.then(operation, operation)
  callWriteQueue = run.catch(() => {})
  return run
}


/**
 * Keep one scoped `tools.restrict({ deny })` layer on every live agent.
 *
 * `tools.restrict()` refuses a context-global call on purpose, so the only correct
 * installation point is each agent's own `agent.ctx`. Restrictions intersect, which
 * is what makes this safe to combine with presets and sub-agent tool filters.
 *
 * State preference is keyed by the model-facing suffix (`mcp__<server>__<tool>` minus
 * the server prefix), not by the MCP server's raw tool name: that suffix is exactly
 * what `tools.schemas()` exposes and what `restrict({ deny })` accepts.
 */
export function installToolRestrictions(ctx) {
  /** @type {Map<object, { key: string, dispose?: () => unknown }>} */
  const installed = new Map()
  let running = null
  let queued = false
  let closed = false

  const drop = (agent) => {
    const current = installed.get(agent)
    if (!current) return
    installed.delete(agent)
    try {
      void current.dispose?.()
    } catch (error) {
      ctx.logger?.warn?.(`mcp-switch: could not lift tool restriction: ${String(error?.message ?? error)}`)
    }
  }

  /**
   * Install one deny mask, retrying once without names the registry does not know.
   *
   * The old mask is disposed only *after* the new one is accepted: dropping first and
   * then failing left the agent with no restriction at all, i.e. every tool the user
   * hid became visible again (DESIGN.md:76 forbids exactly that fail-open).
   */
  const applyOne = (agent, deny) => {
    const key = deny.join('\u0000')
    const current = installed.get(agent)
    if (current && current.key === key) return
    if (deny.length === 0) {
      if (current) drop(agent)
      return
    }

    const install = (names) => {
      const dispose = agent.ctx.tools.restrict({ deny: names })
      if (current) drop(agent)
      installed.set(agent, { key, dispose })
    }

    try {
      install(deny)
      return
    } catch (error) {
      const message = String(error?.message ?? error)
      if (!message.includes('names unknown global tool')) {
        ctx.logger?.warn?.(`mcp-switch: could not restrict tools for an agent: ${message}`)
        return
      }
      // A tool vanished between `tools.schemas()` and `restrict()`. Retry with only the
      // names this agent can actually see; the skipped ones stay persisted and are
      // applied by a later refresh when (if) they come back.
      const known = new Set(agent.ctx.tools.schemas?.().map((schema) => schema?.name) ?? [])
      const narrowed = known.size === 0 ? [] : deny.filter((name) => known.has(name))
      const skipped = deny.filter((name) => !known.has(name))
      ctx.logger?.warn?.(`mcp-switch: restriction-skipped ${skipped.join(', ')}`)
      if (narrowed.length === 0) {
        if (current) drop(agent)
        return
      }
      try {
        install(narrowed)
      } catch (retryError) {
        ctx.logger?.warn?.(`mcp-switch: could not restrict tools for an agent: ${String(retryError?.message ?? retryError)}`)
      }
    }
  }

  const refreshOnce = async () => {
    const state = await readState()
    const tools = ctx.get('tools')
    if (!tools || typeof tools.schemas !== 'function') return
    let schemas
    try {
      schemas = tools.schemas() ?? []
    } catch (error) {
      ctx.logger?.warn?.(`mcp-switch: could not read schemas for restrictions: ${String(error?.message ?? error)}`)
      return
    }
    const liveNames = schemas.map((schema) => schema?.name).filter((name) => typeof name === 'string')
    const deny = deniedToolNames(state, liveNames)

    const agents = ctx.get('agents')?.list?.() ?? []
    const live = new Set(agents)
    for (const agent of agents) applyOne(agent, deny)
    for (const agent of [...installed.keys()]) if (!live.has(agent)) drop(agent)
  }

  /** @type {{ ok: boolean, error?: string }} */
  let lastResult = { ok: true }

  const runOnce = async () => {
    do {
      queued = false
      try {
        await refreshOnce()
        lastResult = { ok: true }
      } catch (error) {
        lastResult = { ok: false, error: String(error?.message ?? error) }
        ctx.logger?.warn?.(`mcp-switch: tool restriction refresh failed: ${String(error?.message ?? error)}`)
      }
    } while (queued && !closed)
    return lastResult
  }

  const refresh = () => {
    if (closed) return Promise.resolve(lastResult)
    if (running) {
      queued = true
      return running
    }
    running = runOnce()
      .catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
      .finally(() => {
        running = null
        // A caller that arrived while the loop was finishing set `queued` after the
        // loop's last check; without this re-run that refresh was simply lost and the
        // newly created agent kept an empty mask until the next unrelated change.
        if (queued && !closed) void refresh()
      })
    return running
  }

  ctx.effect(() => {
    void refresh()
    const offCreated = ctx.on('agent/created', () => refresh(), { global: true })
    const offDisposed = ctx.on('agent/disposed', ({ agent }) => drop(agent), { global: true })
    const offTools = ctx.on('tools/change', () => {
      // The live schema changed: refresh both the deny masks and the UI-only cache.
      void refreshKnownToolCache(ctx)
      void refresh()
    }, { global: true })
    return () => {
      closed = true
      offCreated?.()
      offDisposed?.()
      offTools?.()
      for (const agent of [...installed.keys()]) drop(agent)
    }
  }, 'mcp-switch.tool-restrictions')

  return { refresh }
}

/**
 * Serialize cache refreshes.
 *
 * `tools/change` fires once per registered tool, so several refreshes overlap. Each one
 * used to read the live schemas up front and then write through the state queue, which
 * meant a *stale* snapshot could be queued behind a fresher one and win: enabling a
 * server with six tools left the cache claiming three. Chaining the whole read-compute-
 * write makes the last run observe the last registration.
 */
let knownCacheChain = Promise.resolve()

export function refreshKnownToolCache(ctx) {
  const next = knownCacheChain.then(() => runKnownToolCacheRefresh(ctx)).catch(() => {})
  knownCacheChain = next
  return next
}

/** Refresh the UI-only known-tool cache from the live schemas. */
async function runKnownToolCacheRefresh(ctx) {
  const tools = ctx.get('tools')
  if (!tools || typeof tools.schemas !== 'function') return
  let schemas
  try {
    schemas = tools.schemas() ?? []
  } catch {
    return
  }
  // A fiber that is mid-teardown unregisters its tools one by one, so `schemas()` during
  // an unloading entry is a *partial* list. Caching that snapshot replaced six known
  // tools with the two that had not been disposed yet, and the UI then reported a wrong
  // estimate for a server the user had merely switched off. A *loading* fiber is the
  // mirror image: it registers one tool at a time, so each snapshot is a growing prefix
  // and the last one is complete — that is why loading is allowed and only teardown
  // (unloading/disposed) is excluded.
  const settled = new Set()
  const loader = ctx.get('loader')
  if (loader && typeof loader.entries === 'function') {
    for (const entry of loader.entries()) {
      if (entry?.options?.name !== MCP_CLIENT_PLUGIN) continue
      if (entry.fiber === undefined) continue
      const phase = fiberPhaseLabel(entry.fiber.state)
      if (phase === 'unloading' || phase === null) continue
      settled.add(serverNameOf(entry))
    }
  }

  const state = await readState()
  const rowsByServer = describeToolSchemas(schemas, state)
  const now = new Date().toISOString()
  let changed = false

  for (const [serverName, rows] of rowsByServer) {
    // An empty live set is not evidence that the server has no tools: it is what a
    // disconnected server looks like. Keep the last good cache (DESIGN.md:50).
    if (rows.length === 0) continue
    if (loader && typeof loader.entries === 'function' && !settled.has(serverName)) continue
    const known = rows.map((row) => ({
      name: row.toolName,
      description: row.description,
      schemaBytes: row.schemaBytes,
      estTokens: row.estTokens,
      lastSeenAt: now,
    }))
    const previous = state.servers?.[serverName]?.knownTools ?? []
    const previousShape = previous.map((row) => ({
      name: row.name,
      description: row.description,
      schemaBytes: row.schemaBytes,
      estTokens: row.estTokens,
    }))
    const knownShape = known.map((row) => ({
      name: row.name,
      description: row.description,
      schemaBytes: row.schemaBytes,
      estTokens: row.estTokens,
    }))
    if (JSON.stringify(previousShape) !== JSON.stringify(knownShape)) changed = true
  }
  if (!changed) return

  await updateState((draft) => {
    for (const [serverName, rows] of rowsByServer) {
      if (rows.length === 0) continue
      if (loader && typeof loader.entries === 'function' && !settled.has(serverName)) continue
      const server = serverStateOf(draft, serverName)
      server.knownTools = rows.map((row) => ({
        name: row.toolName,
        description: row.description,
        schemaBytes: row.schemaBytes,
        estTokens: row.estTokens,
        lastSeenAt: now,
      }))
      server.syncedAt = now
    }
    return draft
  })
}

/**
 * Apply deferred server switches to the HOME patch at startup.
 *
 * Runtime toggles only call `entry.update` and write `pending` here. Writing the
 * patch at click time would rebuild the profile include while agents still hold
 * their old preset scopes (discussion #8635); startup is the safe point. If agents
 * already exist (hot reload inside a live app), the pending value is kept for the
 * next boot.
 */
async function reconcilePendingPatches(ctx) {
  const loader = ctx.get('loader')
  if (!loader) return
  const state = await readState()
  const rows = listMcpEntries(loader)
  const agentsActive = (ctx.get('agents')?.list?.() ?? []).length > 0

  for (const [serverName, record] of Object.entries(state.servers ?? {})) {
    const pending = record?.pending
    if (!pending) continue
    const row = rows.find((candidate) => candidate.serverName === serverName)
    if (!row) continue
    try {
      // Order matters: with a live agent, `entry.update` disposes the fiber and with it
      // the tools that agent is holding (DESIGN.md:68). Keep the pending value for the
      // next boot instead of touching the live tree, and leave the patch untouched.
      if (agentsActive) continue
      if (row.enabled !== !pending.disabled) {
        const entry = loader.resolve(row.entryId)
        await entry.update({ disabled: pending.disabled })
      }
      const persisted = await persistDisabled(row.rawId, pending.disabled)
      if (!persisted.ok) {
        ctx.logger?.warn?.(`mcp-switch: could not reconcile ${serverName}: ${persisted.error}`)
        continue
      }
      const cleared = await updateState((draft) => {
        if (draft.servers?.[serverName]) draft.servers[serverName].pending = null
        return draft
      })
      // A pending value that cannot be cleared is replayed on every boot. The override is
      // already written so the replay is harmless, but a silent failure hides a broken
      // state file behind a panel that keeps asking for a restart.
      if (!cleared.ok) {
        ctx.logger?.warn?.(`mcp-switch: could not clear pending for ${serverName}: ${cleared.error}`)
      }
    } catch (error) {
      ctx.logger?.warn?.(`mcp-switch: pending reconcile failed for ${serverName}: ${String(error?.message ?? error)}`)
    }
  }
}

/** Re-read state after an external editor saves it, debounced and self-write tolerant. */
function installStateWatcher(ctx, onChange) {
  const file = resolveStatePath()
  let timer = null
  let watcher = null
  let closed = false
  let lastHash = null

  // Record the hash of every write this plugin makes. Otherwise our own toggle fires the
  // watcher 250ms later, which re-runs the known-tool refresh and the restriction pass
  // for a change we just made ourselves — measurable work on every click, and a second
  // source of truth for "did the file really change".
  const unsubscribe = subscribeStateWrites((text) => {
    lastHash = createHash('sha256').update(text).digest('hex')
  })

  const arm = async () => {
    await mkdir(path.dirname(file), { recursive: true })
    if (closed) return
    try {
      watcher = watch(path.dirname(file), { persistent: false }, (_event, filename) => {
        if (filename && String(filename) !== path.basename(file)) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          void readFile(file, 'utf8')
            .then((text) => {
              const hash = createHash('sha256').update(text).digest('hex')
              if (hash === lastHash) return
              lastHash = hash
              return onChange()
            })
            .catch(() => {})
        }, 250)
      })
    } catch (error) {
      ctx.logger?.warn?.(`mcp-switch: state watcher unavailable: ${String(error?.message ?? error)}`)
    }
  }
  void arm()

  return () => {
    closed = true
    unsubscribe()
    if (timer) clearTimeout(timer)
    watcher?.close()
  }
}

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (!webServer) {
    ctx.logger?.warn?.('mcp-switch: webServer service unavailable; panel route not mounted')
    return
  }

  const toolRestrictions = installToolRestrictions(ctx)
  void refreshKnownToolCache(ctx).catch((error) => {
    ctx.logger?.warn?.(`mcp-switch: known-tool refresh failed: ${String(error?.message ?? error)}`)
  })
  void reconcilePendingPatches(ctx).catch((error) => {
    ctx.logger?.warn?.(`mcp-switch: startup reconcile failed: ${String(error?.message ?? error)}`)
  })

  const handler = async (req, res) => {
    try {
      const method = (req.method ?? 'GET').toUpperCase()

      if (method === 'GET') {
        // One route, several views. A second registered path would be a second chance to
        // collide with a shipped route, and this plugin's whole route surface is one
        // string in `files`-filtered code — keeping it single is the cheap insurance.
        const url = new URL(req.url ?? '/', 'http://localhost')
        const view = url.searchParams.get('view') ?? 'servers'

        if (view === 'calls') {
          const loaded = await readCalls()
          const rows = pruneRows(loaded.rows)
          return send(res, 200, {
            ok: loaded.ok,
            view: 'calls',
            error: loaded.error,
            file: resolveCallsPath(),
            rows: rows.slice(-200).reverse(),
            stats: summarizeCalls(rows),
            kept: rows.length,
          })
        }

        if (view === 'scan') {
          const scanned = await scanAll()
          // Every scanned server carries the id DSH would need, because the foreign
          // configs have no such concept — deriving it once here keeps the browser from
          // inventing its own collision-prone naming rules.
          const found = scanned.found.map((row) => ({
            ...row,
            servers: row.servers.map((server) => ({
              ...server,
              suggested: server.importable
                ? {
                    ...server.spec,
                    id: suggestId(server.id),
                    serverName: suggestServerName(server.id),
                  }
                : null,
            })),
          }))
          return send(res, 200, { ok: true, view: 'scan', ...scanned, found })
        }

        if (view === 'catalog') {
          const query = url.searchParams.get('q') ?? ''
          const cursor = url.searchParams.get('cursor')
          const result = await fetchCatalog(query, { cursor })
          // Attach the spec the install button would send, so the browser never has to
          // re-implement "how a catalog entry becomes a patch row" — one implementation,
          // in the module that is unit-tested for it.
          // Also collapse the per-version rows the registry returns for one server:
          // three copies of the same card is what "browse" looks like without this.
          const entries = Array.isArray(result.entries)
            ? collapseVersions(result.entries).map((entry) => ({ ...entry, suggested: specFromEntry(entry) }))
            : result.entries
          return send(res, result.ok ? 200 : 502, { view: 'catalog', query, ...result, entries })
        }

        const snapshot = await buildSnapshot(ctx)
        return send(res, snapshot.ok ? 200 : snapshot.status, snapshot)
      }

      if (method !== 'POST') {
        return send(res, 405, { ok: false, error: 'method not allowed' })
      }

      const body = await readJsonBody(req)
      if (!body.ok) return send(res, 400, { ok: false, error: body.error })

      const payload = body.value ?? {}

      // Panel seat. Validated against the shared list, then written to this plugin's own
      // state file — never the patch layer. A value that is not one of the two seats is
      // rejected rather than coerced: assuming a typo meant one of them would relocate a
      // page the user never asked to move.
      if (payload.action === 'set-panel-entry') {
        const written = await writePanelEntry(payload.entry)
        if (written.invalid) return send(res, 400, { ok: false, error: written.error })
        if (!written.ok) return send(res, 500, { ok: false, error: written.error })
        return send(res, 200, {
          ok: true,
          action: 'set-panel-entry',
          panelEntry: written.panelEntry,
          panelEntryFile: written.file,
        })
      }

      // Single-tool switch. A disabled server is deliberately read-only here: it has
      // no live tools, and accepting a preference would look like it took effect
      // while the server is off. The state file remains hand-editable for setup.
      if (payload.action === 'set-tool') {
        const serverName = typeof payload.serverName === 'string' ? payload.serverName.trim() : ''
        let toolName = typeof payload.toolName === 'string' ? payload.toolName.trim() : ''
        if (!serverName || !toolName) return send(res, 400, { ok: false, error: 'serverName and toolName are required' })
        if (typeof payload.enabled !== 'boolean') {
          return send(res, 400, { ok: false, error: 'enabled must be a boolean' })
        }

        const loader = ctx.get('loader')
        if (!loader) return send(res, 503, { ok: false, error: 'loader service unavailable' })
        const row = listMcpEntries(loader).find((candidate) => candidate.serverName === serverName)
        if (!row) return send(res, 404, { ok: false, error: `unknown MCP server: ${serverName}` })
        if (!row.enabled) {
          return send(res, 409, { ok: false, error: `server is disabled: ${serverName}` })
        }

        const tools = ctx.get('tools')
        if (!tools || typeof tools.schemas !== 'function') {
          return send(res, 503, { ok: false, error: 'tools service unavailable' })
        }
        const prefix = `mcp__${serverName}__`
        if (toolName.startsWith(prefix)) toolName = toolName.slice(prefix.length)
        const fullName = `${prefix}${toolName}`
        const schemas = tools.schemas() ?? []
        if (!schemas.some((schema) => schema?.name === fullName)) {
          return send(res, 404, { ok: false, error: `unknown tool: ${fullName}` })
        }

        if (toolName.length > MAX_TOOL_NAME) {
          return send(res, 400, { ok: false, error: `toolName must be at most ${MAX_TOOL_NAME} characters` })
        }

        const written = await updateState((draft) => setToolEnabled(draft, serverName, toolName, payload.enabled))
        // Persistence failure is reported, not escalated: the in-memory preference is
        // already in effect for this process (DESIGN.md:74), so a 500 here would tell the
        // UI the switch failed when the model really can no longer see the tool.
        const restriction = await toolRestrictions.refresh()
        return send(res, 200, {
          ok: true,
          action: 'set-tool',
          serverName,
          toolName,
          enabled: payload.enabled,
          persisted: written.ok,
          persistError: written.ok ? undefined : written.error,
          statePersisted: written.ok,
          stateError: written.ok ? undefined : written.error,
          stateFile: written.file,
          backupPath: written.backupPath ?? undefined,
          backupError: written.backupError,
          restrictionError: restriction.ok ? undefined : restriction.error,
        })
      }

      // Bulk: the usual intent is "everything off, then enable the one I need".
      if (payload.action === 'disable-all' || payload.action === 'enable-all') {
        const loader = ctx.get('loader')
        if (!loader) return send(res, 503, { ok: false, error: 'loader service unavailable' })
        const disabled = payload.action === 'disable-all'
        const results = []
        for (const row of listMcpEntries(loader)) {
          if (row.enabled === !disabled) {
            results.push({ entryId: row.entryId, serverName: row.serverName, changed: false })
            continue
          }
          // Two separate failure domains: the live switch, and the deferred record of it.
          // Reporting `changed:false` after a successful `entry.update` would invite the
          // caller to retry a switch that already happened.
          try {
            const entry = loader.resolve(row.entryId)
            await entry.update({ disabled })
          } catch (error) {
            results.push({
              entryId: row.entryId,
              serverName: row.serverName,
              changed: false,
              error: String(error?.message ?? error),
            })
            continue
          }
          const written = await updateState((draft) => setServerPending(draft, row.serverName, disabled))
          results.push({
            entryId: row.entryId,
            serverName: row.serverName,
            changed: true,
            pending: written.ok,
            persisted: written.ok,
            persistError: written.ok ? undefined : written.error,
            statePersisted: written.ok,
            stateError: written.ok ? undefined : written.error,
          })
        }
        const snapshot = await buildSnapshot(ctx)
        return send(res, 200, {
          ok: true,
          action: payload.action,
          results,
          patchPath: resolveHomePatchPath(),
          servers: snapshot.ok ? snapshot.servers : [],
          totals: snapshot.ok ? snapshot.totals : null,
        })
      }

      // Install: append one `- insert:` block to the HOME patch layer.
      //
      // No loader call follows. `dsh-hmr` watches this file and reconciles the profile
      // when it changes, so the row is composed into the running tree by the host itself —
      // the same mechanism the toggles already rely on. Doing it by hand through
      // `loader.create()` would create two authorities for "which rows exist", and the
      // second one is invisible in `git diff`.
      if (payload.action === 'install-server') {
        const spec = payload.spec ?? {}
        const checked = validateServerSpec(spec)
        if (!checked.ok) return send(res, 400, { ok: false, error: checked.error })
        if (isLocked(spec.id, MCP_CLIENT_PLUGIN)) {
          return send(res, 403, { ok: false, error: `entry is locked: ${spec.id}` })
        }

        const file = resolveHomePatchPath()
        const existing = await readPatchLines(file)
        if (!existing.ok) return send(res, 500, { ok: false, error: existing.error })

        // `serverName` is a namespace, not a label: two rows sharing one make the whole
        // composition throw `serverName "x" is already in use` at apply time, which takes
        // down every MCP row in that patch, not just the duplicate.
        const loaderForNames = ctx.get('loader')
        const liveNames = loaderForNames ? listMcpEntries(loaderForNames).map((row) => row.serverName) : []
        const fileNames = listServerRows(existing.lines).map((row) => row.serverName).filter(Boolean)
        if ([...liveNames, ...fileNames].includes(spec.serverName)) {
          return send(res, 409, { ok: false, error: `serverName already in use: ${spec.serverName}` })
        }

        const result = appendServerBlock(existing.lines, spec)
        if (result.mode === 'duplicate') return send(res, 409, { ok: false, error: result.error })
        if (!result.changed) return send(res, 400, { ok: false, error: result.error ?? 'nothing to write' })

        let text = joinLines(result.lines, existing.crlf)
        if (!text.endsWith('\n')) text += existing.crlf ? '\r\n' : '\n'

        const backup = await backupPatchFile(file, existing.missing ? '' : joinLines(existing.lines, existing.crlf))
        try {
          await writeTextAtomic(file, text)
        } catch (error) {
          return send(res, 500, { ok: false, error: String(error?.message ?? error) })
        }

        return send(res, 200, {
          ok: true,
          action: 'install-server',
          id: spec.id,
          serverName: spec.serverName,
          patchPath: file,
          backupPath: backup.ok ? backup.path : undefined,
          backupError: backup.ok ? undefined : backup.error,
        })
      }

      // Remove: delete every row this plugin wrote for that id
      // (`@deepseek-ai/dsh-mcp-client` only), then drop the insert block it left empty.
      if (payload.action === 'remove-server') {
        const rawId = typeof payload.rawId === 'string' ? payload.rawId.trim() : ''
        if (!rawId) return send(res, 400, { ok: false, error: 'rawId is required' })
        if (isLocked(rawId, MCP_CLIENT_PLUGIN)) return send(res, 403, { ok: false, error: `entry is locked: ${rawId}` })

        const file = resolveHomePatchPath()
        const existing = await readPatchLines(file)
        if (!existing.ok) return send(res, 500, { ok: false, error: existing.error })

        const result = removeServerRows(existing.lines, rawId)
        if (!result.changed) return send(res, 404, { ok: false, error: `no row for ${rawId} in the patch file` })

        // An empty document is still a document: DESIGN.md:75 spells it `[]`. Writing a
        // zero-byte file leaves the host with an unparsable patch instead of an empty one.
        let text = result.lines.length === 0 ? '[]' : joinLines(result.lines, existing.crlf)
        if (!text.endsWith('\n')) text += existing.crlf ? '\r\n' : '\n'

        const backup = await backupPatchFile(file, joinLines(existing.lines, existing.crlf))
        try {
          await writeTextAtomic(file, text)
        } catch (error) {
          return send(res, 500, { ok: false, error: String(error?.message ?? error) })
        }

        // A row can also still be live in the loader for this session: the HMR reconcile
        // removes it, but a resolve failure here is not an error worth surfacing — the
        // file is the truth and the next reconcile reads it.
        return send(res, 200, {
          ok: true,
          action: 'remove-server',
          rawId,
          removed: result.removed,
          patchPath: file,
          backupPath: backup.ok ? backup.path : undefined,
          backupError: backup.ok ? undefined : backup.error,
        })
      }

      // Forget the call log. The file is a feed, not a record of truth; clearing it is a
      // legitimate user request and must not need a manual `rm`.
      if (payload.action === 'clear-calls') {
        const cleared = await rewriteCalls([])
        if (!cleared.ok) return send(res, 500, { ok: false, error: cleared.error })
        return send(res, 200, { ok: true, action: 'clear-calls', file: cleared.file })
      }

      const entryId = typeof payload.entryId === 'string' ? payload.entryId.trim() : ''
      if (!entryId) return send(res, 403, { ok: false, error: 'entry is not toggleable: ' })
      if (typeof payload.disabled !== 'boolean') {
        return send(res, 400, { ok: false, error: 'disabled must be a boolean' })
      }

      const loader = ctx.get('loader')
      if (!loader) return send(res, 503, { ok: false, error: 'loader service unavailable' })

      let entry
      try {
        entry = loader.resolve(entryId)
      } catch {
        return send(res, 404, { ok: false, error: `unknown entry: ${entryId}` })
      }
      if (!entry || !isMcpEntry(entry)) {
        return send(res, 400, { ok: false, error: 'entry is not an MCP client row' })
      }

      const rawId = rawIdOf(entry)
      if (isLocked(rawId, entry.options.name)) {
        return send(res, 403, { ok: false, error: `entry is not toggleable: ${entryId}` })
      }

      // Live toggle first: entry-level update disposes/starts the mcp-client fiber,
      // which unregisters/registers its mcp__* tools immediately.
      try {
        await entry.update({ disabled: payload.disabled })
      } catch (error) {
        return send(res, 500, {
          ok: false,
          error: `failed to ${payload.disabled ? 'disable' : 'enable'}: ${String(error?.message ?? error)}`,
        })
      }

      const serverName = serverNameOf(entry)
      // The patch file is written at startup reconcile, not here: updating the
      // profile include while agents hold old preset scopes strands those scopes
      // (discussion #8635). The live loader entry is already changed above.
      const pending = await updateState((draft) => setServerPending(draft, serverName, payload.disabled))
      if (!pending.ok) {
        ctx.logger?.warn?.(`mcp-switch: pending write failed: ${pending.error}`)
      }

      return send(res, 200, {
        ok: true,
        entryId,
        rawId,
        serverName,
        disabled: payload.disabled,
        fiberPhase: entry.fiber === undefined ? null : fiberPhaseLabel(entry.fiber.state),
        // `pending` describes what will be written at the next startup, so it is only
        // true when the record of it actually landed (AGENTS.md rule 2).
        pending: pending.ok,
        persisted: pending.ok,
        persistError: pending.ok ? undefined : pending.error,
        statePersisted: pending.ok,
        stateFile: pending.file,
        stateError: pending.ok ? undefined : pending.error,
        patchDeferred: true,
      })
    } catch (error) {
      // Never throw across the API: the client always gets JSON it can render.
      ctx.logger?.warn?.(`mcp-switch: request failed: ${String(error?.message ?? error)}`)
      try {
        send(res, 500, { ok: false, error: String(error?.message ?? error) })
      } catch {
        /* response already gone */
      }
    }
  }

  // Call log: watch the session event feed, remember the in-flight MCP/skill calls, and
  // write one line per call when it settles.
  //
  // Only settled calls are written. Writing the "started" row too would let a process that
  // dies mid-call leave a row that says `running` forever — and a caller that has to
  // reconcile those is a caller that eventually shows a call spinning for a week.
  ctx.effect(() => {
    const pending = []
    let appended = 0
    let pruning = false

    const onEvent = (session, event) => {
      const type = event?.type
      if (type === 'tool/call') {
        const row = startRow(session?.id, event)
        if (row) {
          pending.push(row)
          // Bounded: a session that stalls with hundreds of unresolved calls must not grow
          // this list without limit. The oldest are dropped — a late result for one of them
          // simply finds no pending row and is ignored, which is what its absence means.
          while (pending.length > CALL_MEMORY_LIMIT) pending.shift()
        }
        return
      }

      if (type !== 'tool/result') return

      const callId = event?.data?.message?.callId
      const row = findPending(pending, session?.id, callId)
      if (!row) return
      pending.splice(pending.indexOf(row), 1)

      const { settled } = settleRow(row, event?.data)
      if (!settled) return

      appended += 1
      void appendCall(row).then((written) => {
        if (!written.ok) {
          ctx.logger?.warn?.(`mcp-switch: could not append call row: ${written.error}`)
          return
        }
        if (appended % CALL_PRUNE_EVERY !== 0 || pruning) return
        pruning = true
        void readCalls()
          .then((loaded) => {
            const kept = pruneRows(loaded.rows)
            return kept.length === loaded.rows.length ? null : rewriteCalls(kept)
          })
          .catch(() => {})
          .finally(() => {
            pruning = false
          })
      })
    }

    return ctx.on('session/event', onEvent)
  }, 'mcp-switch.calls')

  ctx.effect(
    () =>
      installStateWatcher(ctx, async () => {
        await refreshKnownToolCache(ctx)
        await toolRestrictions.refresh()
      }),
    'mcp-switch.state-watch',
  )

  ctx.effect(() => webServer.register({ kind: 'exact', path: ROUTE, handler }), 'mcp-switch.route')
}
