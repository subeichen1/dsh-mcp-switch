/**
 * State document for the tool-granularity layer.
 *
 * The document is deliberately independent of `cordis.patch.yml`:
 *
 *   {
 *     "version": 1,
 *     "panelEntry": "settings",
 *     "servers": {
 *       "blender": {
 *         "pending": { "disabled": true, "requestedAt": "2026-11-13T..." },
 *         "tools": { "some_tool": false },
 *         "knownTools": [
 *           { "name": "some_tool", "description": "...", "schemaBytes": 123, "estTokens": 31, "lastSeenAt": "..." }
 *         ],
 *         "syncedAt": "..."
 *       }
 *     },
 *     "updatedAt": "..."
 *   }
 *
 * Only explicit `false` entries are stored in `tools`; an enabled tool is simply
 * absent. That makes "default enabled" the only possible interpretation of a new
 * tool or a hand-edited file. `knownTools` is a UI/cache list, never the source of
 * truth for registration.
 *
 * The functions here are pure except `readStateDocument` / `writeStateDocument`,
 * which are kept next to the schema so their failure semantics are tested with it.
 */

import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'

export const STATE_VERSION = 1

/**
 * Bytes, not code units.
 *
 * A CJK description costs three UTF-8 bytes per character, so `String#length`
 * under-reported the schema size (and therefore the token estimate) by ~3x for
 * exactly the servers whose descriptions are not English. The number the panel
 * prints has to be the number the model is billed for.
 */
export function utf8Bytes(value) {
  return typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0
}
export const DEFAULT_PANEL_ENTRY = 'settings'
export const PANEL_ENTRY_VALUES = ['sidebar', 'settings']

const MAX_SERVER_NAME = 128
export const MAX_TOOL_NAME = 256
const MAX_KNOWN_TOOLS = 1000
const MAX_DESCRIPTION = 16_384

export function isPanelEntry(value) {
  return typeof value === 'string' && PANEL_ENTRY_VALUES.includes(value)
}

export function sanitizePanelEntry(value, fallback = DEFAULT_PANEL_ENTRY) {
  return isPanelEntry(value) ? value : fallback
}

/** Only explicit false survives; true is deleted, everything else is ignored. */
export function sanitizeToolMap(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [name, enabled] of Object.entries(raw)) {
    if (typeof name !== 'string' || name.length === 0 || name.length > MAX_TOOL_NAME) continue
    if (enabled === false) out[name] = false
  }
  return out
}

export function sanitizeKnownTools(raw) {
  if (!Array.isArray(raw)) return []
  const seen = new Set()
  const out = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue
    if (typeof item.name !== 'string' || item.name.length === 0 || item.name.length > MAX_TOOL_NAME) continue
    if (seen.has(item.name)) continue
    seen.add(item.name)
    const schemaBytes = Number.isFinite(item.schemaBytes) && item.schemaBytes > 0 ? Math.round(item.schemaBytes) : 0
    const estTokens = Number.isFinite(item.estTokens) && item.estTokens > 0 ? Math.round(item.estTokens) : Math.round(schemaBytes / 4)
    out.push({
      name: item.name,
      description: typeof item.description === 'string' ? item.description.slice(0, MAX_DESCRIPTION) : '',
      schemaBytes,
      estTokens,
      lastSeenAt: typeof item.lastSeenAt === 'string' ? item.lastSeenAt : null,
    })
    if (out.length >= MAX_KNOWN_TOOLS) break
  }
  return out
}

export function sanitizePending(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (typeof raw.disabled !== 'boolean') return null
  return {
    disabled: raw.disabled,
    requestedAt: typeof raw.requestedAt === 'string' ? raw.requestedAt : null,
  }
}

/**
 * Validate the known fields and **carry unknown ones through**.
 *
 * DESIGN.md:33 makes "写回保留未知字段" a promise: a newer version of this plugin, or
 * a hand-added note, must not be deleted just because this build does not know the
 * key. Validating is therefore a merge, not a projection.
 */
export function sanitizeServerState(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    ...source,
    pending: sanitizePending(source.pending),
    tools: sanitizeToolMap(source.tools),
    knownTools: sanitizeKnownTools(source.knownTools),
    syncedAt: typeof source.syncedAt === 'string' ? source.syncedAt : null,
  }
}

export function sanitizeServers(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const [serverName, value] of Object.entries(raw)) {
    if (typeof serverName !== 'string' || serverName.length === 0 || serverName.length > MAX_SERVER_NAME) continue
    out[serverName] = sanitizeServerState(value)
  }
  return out
}

export function createDefaultState(panelEntry = DEFAULT_PANEL_ENTRY) {
  return {
    version: STATE_VERSION,
    panelEntry: sanitizePanelEntry(panelEntry),
    servers: {},
    updatedAt: null,
  }
}

export function sanitizeState(raw, fallbackPanelEntry = DEFAULT_PANEL_ENTRY) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  return {
    ...source,
    version: STATE_VERSION,
    panelEntry: sanitizePanelEntry(source.panelEntry, fallbackPanelEntry),
    servers: sanitizeServers(source.servers),
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
  }
}

/** The preference record for one server, created on demand. */
export function serverStateOf(state, serverName) {
  if (!state.servers[serverName]) {
    state.servers[serverName] = sanitizeServerState({})
  }
  return state.servers[serverName]
}

/** `true` unless the state explicitly says `false`. */
export function isToolEnabled(state, serverName, toolName) {
  return state.servers?.[serverName]?.tools?.[toolName] !== false
}

/**
 * Apply one tool switch to a draft state. Returns the same state object for easy
 * chaining; callers own the clone.
 */
export function setToolEnabled(state, serverName, toolName, enabled) {
  const server = serverStateOf(state, serverName)
  if (enabled) delete server.tools[toolName]
  else server.tools[toolName] = false
  return state
}

export function setServerPending(state, serverName, disabled, requestedAt = new Date().toISOString()) {
  const server = serverStateOf(state, serverName)
  server.pending = { disabled, requestedAt }
  return state
}

/**
 * Turn the persisted false entries into actual model-facing names.
 *
 * `liveNames` limits the deny list to tools the ToolRuntime currently knows.
 * `restrict()` rejects unknown names; a preference for a server that is still
 * connecting is therefore kept on disk and applied by a later refresh.
 */
export function deniedToolNames(state, liveNames) {
  const live = new Set(liveNames ?? [])
  const deny = []
  for (const [serverName, server] of Object.entries(state.servers ?? {})) {
    for (const [toolName, enabled] of Object.entries(server.tools ?? {})) {
      if (enabled !== false) continue
      const fullName = toolName.startsWith('mcp__') ? toolName : `mcp__${serverName}__${toolName}`
      if (live.has(fullName)) deny.push(fullName)
    }
  }
  deny.sort()
  return deny
}

/**
 * Group model-facing schemas by MCP server and attach each one's switch state.
 * Mirrors `summarizeSchemas`'s byte accounting so the UI reports the same number
 * for a tool as the server total bills.
 */
export function describeToolSchemas(schemas, state) {
  const byServer = new Map()
  for (const schema of schemas ?? []) {
    const fullName = schema?.name
    if (typeof fullName !== 'string' || !fullName.startsWith('mcp__')) continue
    const rest = fullName.slice('mcp__'.length)
    const sep = rest.indexOf('__')
    if (sep <= 0) continue
    const serverName = rest.slice(0, sep)
    const toolName = rest.slice(sep + 2)
    if (!toolName) continue

    const nameBytes = utf8Bytes(fullName)
    const descriptionBytes = utf8Bytes(schema.description)
    let parameterBytes = 0
    try {
      parameterBytes = utf8Bytes(JSON.stringify(schema.parameters ?? {}))
    } catch {
      parameterBytes = 0
    }
    const schemaBytes = nameBytes + descriptionBytes + parameterBytes
    const rows = byServer.get(serverName) ?? []
    rows.push({
      name: fullName,
      toolName,
      description: typeof schema.description === 'string' ? schema.description : '',
      nameBytes,
      descriptionBytes,
      parameterBytes,
      schemaBytes,
      estTokens: Math.round(schemaBytes / 4),
      enabled: isToolEnabled(state, serverName, toolName),
    })
    byServer.set(serverName, rows)
  }
  for (const rows of byServer.values()) rows.sort((a, b) => a.toolName.localeCompare(b.toolName))
  return byServer
}

/* -------------------------------------------------------------------------- */
/* disk I/O                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Announce every successful primary write with the exact bytes written.
 *
 * The state watcher needs this: without it, the plugin's own write looks exactly like a
 * human editing the file in an editor, and every toggle triggered a full known-tool
 * refresh plus a restriction pass — work that could never discover anything new, because
 * the plugin was the author of the change it was reacting to.
 */
const stateWriteListeners = new Set()

export function subscribeStateWrites(listener) {
  stateWriteListeners.add(listener)
  return () => stateWriteListeners.delete(listener)
}

function notifyStateWrite(text) {
  for (const listener of stateWriteListeners) {
    try {
      listener(text)
    } catch {
      // A broken observer must not turn a successful write into a failed one.
    }
  }
}

function tempName(file) {
  return `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Rename with a bounded retry.
 *
 * On Windows a rename onto a path that *anybody* currently holds open fails with
 * `EPERM` / `EACCES` / `EBUSY` — the POSIX "unlink an open file" freedom does not
 * exist there. Both handles here are transient (this plugin's own read-modify-write,
 * the debounced state watcher, an editor or a virus scanner), so the correct answer is
 * to retry briefly rather than to report the write as failed:
 *
 *   EPERM: operation not permitted, rename
 *     '...\state.json.tmp-10404-mwel26cd-3rd30a' -> '...\state.json'
 *
 * That exact error was measured on this host during startup reconcile: the patch
 * override had already been written, only the bookkeeping write that clears `pending`
 * failed, so every boot replayed the same pending row. Retrying is what makes the
 * atomic-write promise ("either the old file or the new one") hold on Windows.
 */
const TRANSIENT_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_ATTEMPTS = 10

async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await rename(from, to)
    } catch (error) {
      if (attempt >= RENAME_ATTEMPTS || !TRANSIENT_RENAME_CODES.has(String(error?.code ?? ''))) throw error
      await new Promise((resolve) => setTimeout(resolve, 10 * attempt))
    }
  }
}

export async function writeTextAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = tempName(file)
  let handle
  try {
    handle = await open(tmp, 'w')
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await renameWithRetry(tmp, file)
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Read the state document, repairing only the evidence path:
 * a corrupt primary is renamed to `state.json.broken-<ISO>` and, if a valid
 * `state.json.bak` exists, that snapshot supplies the data. The corrupt bytes are
 * never silently overwritten by the read path.
 */
async function readBackup(file) {
  try {
    return sanitizeState(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return null
  }
}

export async function readStateDocument(file) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      // A missing primary is *also* what the corrupt-file path leaves behind after it
      // moves the evidence aside. Reading `.bak` here is what stops the next write from
      // starting at the defaults and silently dropping every saved preference.
      const recovered = await readBackup(file + '.bak')
      if (recovered) return { ok: true, file, missing: true, backupUsed: file + '.bak', state: recovered }
      return { ok: true, file, missing: true, state: createDefaultState() }
    }
    return { ok: false, file, error: String(error?.message ?? error), state: createDefaultState() }
  }

  try {
    return { ok: true, file, state: sanitizeState(JSON.parse(text)) }
  } catch (error) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const brokenPath = `${file}.broken-${stamp}`
    // Same Windows refusal as the write path: the file we are trying to move aside may be
    // held open. Report the path only if the bytes really moved there — a `brokenPath` that
    // names nothing is worse than no evidence at all.
    let moved = true
    let moveError
    try {
      await renameWithRetry(file, brokenPath)
    } catch (error) {
      moved = false
      moveError = String(error?.message ?? error)
    }

    try {
      const backupText = await readFile(`${file}.bak`, 'utf8')
      return {
        ok: false,
        file,
        error: String(error?.message ?? error),
        stateError: String(error?.message ?? error),
        brokenPath: moved ? brokenPath : null,
        ...(moved ? {} : { moveError }),
        backupUsed: `${file}.bak`,
        state: sanitizeState(JSON.parse(backupText)),
      }
    } catch {
      return {
        ok: false,
        file,
        error: String(error?.message ?? error),
        stateError: String(error?.message ?? error),
        brokenPath: moved ? brokenPath : null,
        ...(moved ? {} : { moveError }),
        state: createDefaultState(),
      }
    }
  }
}

/**
 * Write one state document atomically, keeping the previous valid bytes at
 * `state.json.bak`. The temp file lives beside the target so rename is atomic on
 * the same filesystem; `fsync` before rename means a crash cannot leave a
 * truncated primary.
 */
export async function writeStateDocument(file, state) {
  let backupPath = null
  let backupError
  try {
    const previous = await readFile(file, 'utf8')
    let valid = false
    try {
      JSON.parse(previous)
      valid = true
    } catch {
      // A corrupt primary is not copied over a good .bak; readStateDocument has
      // already moved the evidence aside.
    }
    if (valid) {
      // The backup write is a *separate* failure mode from the primary write: a full
      // disk or a read-only directory must not be reported as a successful backup.
      const target = `${file}.bak`
      try {
        await writeTextAtomic(target, previous)
        backupPath = target
      } catch (error) {
        backupError = String(error?.message ?? error)
      }
    }
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      return { ok: false, file, error: String(error?.message ?? error) }
    }
  }

  try {
    const clean = sanitizeState(state)
    const text = `${JSON.stringify(clean, null, 2)}\n`
    await writeTextAtomic(file, text)
    notifyStateWrite(text)
    return { ok: true, file, backupPath, backupError, state: clean }
  } catch (error) {
    return { ok: false, file, error: String(error?.message ?? error) }
  }
}
