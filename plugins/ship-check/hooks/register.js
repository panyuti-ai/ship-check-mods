// ship-check: a development verification board for Claude Code.
// It watches the test, build and type-check commands that actually ran, records what the tools
// reported, and marks a result Stale when the project changes after it. See the README.

import { atom, read, update } from 'claude-code'
import { parseCustomChecks } from './lib/commands.js'
import { analyzeCommand } from './lib/analyze.js'
import { normalizePath, isUnder, relativeTo, resolveDir } from './lib/paths.js'
import {
  emptyLedger,
  beginRecord,
  restoreRecord,
  finishRecord,
  applyEdit,
  applyUnnamedChange,
  applyScan,
  settleRunning,
  activeRoots,
  classifyOutcome,
  tailOutput,
  isTrackedPath,
  categorizePath,
  staleReasonFor,
  recordKey,
  preparePrompt,
  displayStatus,
  hasAnyRecord,
  STATUS,
} from './lib/model.js'
import { buildStrip, buildPane } from './lib/view.js'

const PANE_ID = 'ship-check'
const MAX_SCAN_FILES = 600
const MAX_WALK_ENTRIES = 1500
const WALK_DEPTH = 5
const SCAN_THROTTLE_MS = 1500
const GIT_TIMEOUT_MS = 8000

// State that survives a hot reload lives in `$.state`; the ledger is plain JSON.
const ledgerAtom = atom({ plugin: 'ship-check', key: 'ledger' }, emptyLedger())
const viewAtom = atom({ plugin: 'ship-check', key: 'view' }, { expanded: null })

// Caches that can be rebuilt: lost on reload, which only costs an exact "what changed" list.
const gitTops = new Map()
const lastScans = new Map() // root -> { at, sig, map, head }

// --- Fingerprints ---------------------------------------------------------------------------------

function hashLines(lines) {
  let a = 0x811c9dc5
  let b = 0x01000193
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i)
      a = Math.imul(a ^ c, 0x01000193) >>> 0
      b = Math.imul(b + c, 0x85ebca6b) >>> 0
    }
    a = Math.imul(a ^ 10, 0x01000193) >>> 0
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
}

async function gitTop($, dir) {
  if (gitTops.has(dir)) return gitTops.get(dir)
  let top = null
  try {
    const r = await $.process.run(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { timeoutMs: GIT_TIMEOUT_MS })
    if (r.exitCode === 0 && r.stdout.trim()) top = normalizePath(r.stdout.trim())
  } catch {
    top = null
  }
  gitTops.set(dir, top)
  return top
}

async function statSig($, path) {
  try {
    const s = await $.fs.stat(path)
    return s.mtimeMs + ':' + s.size
  } catch {
    return 'gone'
  }
}

async function statMany($, root, rels) {
  const map = {}
  for (let i = 0; i < rels.length; i += 40) {
    const batch = rels.slice(i, i + 40)
    const sigs = await Promise.all(batch.map((rel) => statSig($, root + '/' + rel)))
    batch.forEach((rel, j) => {
      map[rel] = sigs[j]
    })
  }
  return map
}

// Git route: HEAD plus the files that differ from it. Cheap, and ignores ignored files.
async function scanGit($, root, extra) {
  let head = ''
  try {
    const h = await $.process.run(['git', '-C', root, 'rev-parse', 'HEAD'], { timeoutMs: GIT_TIMEOUT_MS })
    if (h.exitCode === 0) head = h.stdout.trim()
  } catch {
    head = ''
  }
  const st = await $.process.run(['git', '-C', root, 'status', '--porcelain=v1', '-z', '-uall', '--no-renames'], { timeoutMs: GIT_TIMEOUT_MS })
  if (st.exitCode !== 0) return null
  const rels = []
  for (const entry of st.stdout.split('\0')) {
    if (entry.length < 4) continue
    const rel = entry.slice(3).replace(/\\/g, '/')
    if (isTrackedPath(rel, extra)) rels.push(rel)
  }
  const partial = rels.length > MAX_SCAN_FILES || st.isStdoutTruncated
  const map = await statMany($, root, rels.slice(0, MAX_SCAN_FILES))
  const lines = [head, ...Object.keys(map).sort().map((k) => k + '\t' + map[k])]
  return { sig: { hash: hashLines(lines), count: Object.keys(map).length, partial }, map, head }
}

// No Git: a bounded walk. When it hits a cap the fingerprint is marked partial and is never used
// to claim that something changed.
async function scanWalk($, root, extra) {
  const files = []
  let seen = 0
  let partial = false
  const queue = [{ rel: '', depth: 0 }]
  while (queue.length) {
    const { rel, depth } = queue.shift()
    let entries
    try {
      entries = await $.fs.list(rel ? root + '/' + rel : root)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (++seen > MAX_WALK_ENTRIES) {
        partial = true
        break
      }
      const childRel = rel ? rel + '/' + entry.name : entry.name
      if (entry.kind === 'dir') {
        if (depth + 1 > WALK_DEPTH) partial = true
        else if (isTrackedPath(childRel + '/x', extra)) queue.push({ rel: childRel, depth: depth + 1 })
      } else if (entry.kind === 'file' && isTrackedPath(childRel, extra)) {
        files.push({ rel: childRel, sig: entry.mtimeMs + ':' + entry.size })
      }
    }
    if (partial && seen > MAX_WALK_ENTRIES) break
  }
  const map = {}
  for (const f of files) map[f.rel] = f.sig
  const lines = Object.keys(map).sort().map((k) => k + '\t' + map[k])
  return { sig: { hash: hashLines(lines), count: files.length, partial }, map, head: '' }
}

async function scanRoot($, root, extra, force) {
  const now = Date.now()
  const last = lastScans.get(root)
  if (!force && last && now - last.at < SCAN_THROTTLE_MS) return { ...last, reused: true }
  const top = await gitTop($, root)
  let scanned = null
  try {
    scanned = top ? await scanGit($, root, extra) : null
  } catch {
    scanned = null
  }
  if (!scanned) scanned = await scanWalk($, root, extra)
  const next = { at: now, ...scanned }
  lastScans.set(root, next)
  return { ...next, previous: last || null }
}

function describeChange(previous, current) {
  if (!previous) return null
  const files = []
  for (const rel of Object.keys(current.map)) if (previous.map[rel] !== current.map[rel]) files.push(rel)
  for (const rel of Object.keys(previous.map)) if (!(rel in current.map)) files.push(rel)
  if (files.length) {
    return { hash: previous.sig.hash, reason: staleReasonFor(files.map(categorizePath)), files }
  }
  if (previous.head !== current.head) {
    return { hash: previous.sig.hash, reason: 'The Git commit changed after this check completed.', files: [] }
  }
  return null
}

// Rescans the roots that hold a result worth protecting and marks changed ones Stale.
async function scanActive($, extra, force) {
  const ledger = await read($, ledgerAtom)
  for (const root of activeRoots(ledger).slice(0, 5)) {
    const scan = await scanRoot($, root, extra, force)
    if (scan.reused || !scan.sig) continue
    const detail = describeChange(scan.previous, scan)
    await update($, ledgerAtom, (value) => applyScan(value, root, scan.sig, Date.now(), detail || { hash: '' }))
  }
}

// --- Tool calls ------------------------------------------------------------------------------------

// Claude Code runs commands with the Bash tool or, on Windows, the PowerShell tool. Their results
// are understood. Any other tool that takes a "command" (a future shell tool, an MCP terminal) is
// "untrusted": a check seen there is shown as Unknown with the reason, never silently ignored.
const FILE_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']
function shellKind(e) {
  if (e.tool === 'Bash' || e.tool === 'PowerShell') return 'trusted'
  if (typeof e.command === 'string' && !FILE_TOOLS.includes(e.tool)) return 'untrusted'
  return null
}

async function sessionCwd($) {
  try {
    return normalizePath(await $.session.cwd())
  } catch {
    return ''
  }
}

async function beginTool($, e, custom, extra) {
  const kind = shellKind(e)
  if (!kind || typeof e.command !== 'string') return null
  const cwd = await sessionCwd($)
  const parsed = analyzeCommand(e.command, cwd, custom, { powershell: e.tool === 'PowerShell' })
  if (kind === 'untrusted') parsed.untrustedTool = e.tool
  const ctx = { cwd, parsed, checks: [], trusted: kind === 'trusted' }
  if (!parsed.checks.length) return ctx

  const before = await read($, ledgerAtom)
  const roots = new Map()
  for (const check of parsed.checks) {
    const root = (await gitTop($, check.location)) || check.location
    if (!roots.has(root)) roots.set(root, (await scanRoot($, root, extra, true)).sig)
    ctx.checks.push({ check, root, key: recordKey(check.location, check.kind, check.scope), previous: before.records[recordKey(check.location, check.kind, check.scope)] || null, startedAt: Date.now() })
  }
  // Give simultaneous checks distinct start stamps so a newer run can be told from an older one.
  ctx.checks.forEach((c, i) => {
    c.startedAt += i
  })
  await update($, ledgerAtom, (value) => {
    let next = value
    for (const c of ctx.checks) next = beginRecord(next, c.check, roots.get(c.root), c.root, c.startedAt)
    return next
  })
  ctx.roots = roots
  return ctx
}

async function abortTool($, ctx) {
  if (!ctx || !ctx.checks.length) return
  await update($, ledgerAtom, (value) => {
    let next = value
    for (const c of ctx.checks) next = finishRecord(next, c.key, c.startedAt, { status: 'unknown', reason: 'The tool call failed before it reported a result.', exitCode: null, summary: '', endSig: null, now: Date.now() })
    return next
  })
}

async function endTool($, e, ctx, result, extra) {
  if (e.tool === 'Edit' || e.tool === 'Write' || e.tool === 'MultiEdit' || e.tool === 'NotebookEdit') {
    if (!result || result.deny || result.isError) return
    const raw = e.file_path || e.notebook_path
    if (typeof raw !== 'string') return
    const cwd = await sessionCwd($)
    const path = resolveDir(cwd, raw) || normalizePath(raw)
    await update($, ledgerAtom, (value) => applyEdit(value, path, Date.now(), extra))
    return
  }
  if (!shellKind(e) || !ctx) return

  const denied = !result || typeof result.deny === 'string'
  if (ctx.checks.length) {
    if (denied) {
      await update($, ledgerAtom, (value) => {
        let next = value
        for (const c of ctx.checks) next = restoreRecord(next, c.key, c.previous)
        return next
      })
      return
    }
    const r = result.result && typeof result.result === 'object' ? result.result : null
    const summary = r ? tailOutput(r.stdout, r.stderr) : tailOutput(result.text, '')
    const endSigs = new Map()
    for (const c of ctx.checks) {
      if (!endSigs.has(c.root)) endSigs.set(c.root, await scanRoot($, c.root, extra, true))
    }
    const now = Date.now()
    await update($, ledgerAtom, (value) => {
      let next = value
      for (const c of ctx.checks) {
        const verdict = classifyOutcome(ctx.parsed, c.check, result)
        const scan = endSigs.get(c.root)
        const start = value.records[c.key] && value.records[c.key].startSig
        const duringFiles = []
        if (start && scan && scan.sig && start.hash !== scan.sig.hash && scan.previous && scan.previous.map) {
          for (const rel of Object.keys(scan.map)) if (scan.previous.map[rel] !== scan.map[rel]) duringFiles.push(rel)
        }
        next = finishRecord(next, c.key, c.startedAt, {
          ...verdict,
          summary,
          endSig: scan ? scan.sig : null,
          now,
          duringFiles: duringFiles.slice(0, 5),
          duringCategories: duringFiles.map(categorizePath),
        })
      }
      return next
    })
    return
  }

  // A shell command that is not a check: it may have edited files. Only the tools we understand
  // tell us anything about that.
  if (denied || !ctx.trusted) return
  const r = result.result && typeof result.result === 'object' ? result.result : null
  const diff = r && r.bashEditDiff
  const changed = diff && Array.isArray(diff.changedFiles) ? diff.changedFiles.slice(0, 200) : []
  if (changed.length) {
    await update($, ledgerAtom, (value) => {
      let next = value
      for (const p of changed) next = applyEdit(next, p, Date.now(), extra)
      return next
    })
  } else if (diff && (diff.unavailable || diff.skipped) && result.isReadOnly !== true) {
    const ledger = await read($, ledgerAtom)
    const root = (await gitTop($, ctx.cwd)) || ctx.cwd
    if (root && activeRoots(ledger).length) {
      await update($, ledgerAtom, (value) => applyUnnamedChange(value, root, Date.now(), 'A shell command may have changed files after this check completed.'))
    }
  } else if (result.isReadOnly !== true) {
    await scanActive($, extra, false)
  }
}

// --- "Prepare checks" ---------------------------------------------------------------------------------

async function detectScripts($, cwd) {
  const out = []
  try {
    const pkg = JSON.parse(await $.fs.read(cwd + '/package.json'))
    const scripts = pkg && typeof pkg.scripts === 'object' ? pkg.scripts : {}
    let pm = 'npm'
    if (await $.fs.exists(cwd + '/pnpm-lock.yaml')) pm = 'pnpm'
    else if (await $.fs.exists(cwd + '/yarn.lock')) pm = 'yarn'
    else if ((await $.fs.exists(cwd + '/bun.lockb')) || (await $.fs.exists(cwd + '/bun.lock'))) pm = 'bun'
    const run = (name) => (pm === 'yarn' ? 'yarn ' + name : pm + ' run ' + name)
    if (scripts.test) out.push({ kind: 'test', command: pm === 'npm' || pm === 'pnpm' || pm === 'bun' ? pm + ' test' : 'yarn test' })
    const type = ['typecheck', 'type-check', 'check-types', 'tsc'].find((n) => scripts[n])
    if (type) out.push({ kind: 'typecheck', command: run(type) })
    if (scripts.build) out.push({ kind: 'build', command: run('build') })
  } catch {
    // no package.json, or not readable
  }
  return out
}

async function prepareChecks($) {
  const cwd = await sessionCwd($)
  const ledger = await read($, ledgerAtom)
  const items = []
  const seen = new Set()
  const covered = new Set()
  for (const rec of Object.values(ledger.records)) {
    if (cwd && !(isUnder(rec.location, cwd) || isUnder(cwd, rec.location))) continue
    const shown = displayStatus(rec)
    if (shown.status === STATUS.PASSED) {
      covered.add(rec.kind)
      continue
    }
    const k = rec.location + '|' + rec.command
    if (seen.has(k)) continue
    seen.add(k)
    items.push({ command: rec.command, location: relativeTo(rec.location, cwd) || '.' })
  }
  for (const s of await detectScripts($, cwd)) {
    if (covered.has(s.kind) || items.some((i) => i.command === s.command)) continue
    const has = Object.values(ledger.records).some((r) => r.kind === s.kind && (!cwd || isUnder(r.location, cwd) || isUnder(cwd, r.location)))
    if (!has) items.push({ command: s.command, location: '.' })
  }
  const filled = await $.prompt.fill({ text: preparePrompt(items), mode: 'replace' })
  if (filled && filled.isFilled) await $.ui.close({ id: PANE_ID })
  else $.ui.toast('Could not fill the prompt box. Press Esc and try again.')
}

// Set SHIP_CHECK_DEBUG to a file path to write what the band was asked to draw (props, size, records).
async function debugRender($, e, ledger) {
  try {
    const path = await $.env.get('SHIP_CHECK_DEBUG')
    if (!path) return
    const info = { at: new Date().toISOString(), surface: e.surface, props: e.props, viewport: e.viewport, records: Object.keys(ledger.records) }
    await $.fs.write(path, JSON.stringify(info, null, 2))
  } catch {
    // debugging aid only
  }
}

// --- Registration ----------------------------------------------------------------------------------

export function register(on, options) {
  const custom = parseCustomChecks(options && options.extra_checks)
  const customKinds = custom.map((c) => c.kind)
  const extra = options && Array.isArray(options.extra_ignored_paths) ? options.extra_ignored_paths : []

  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({ name: 'ship-check', description: 'Open the Ship Check panel', immediate: true })
      await update($, ledgerAtom, (value) => settleRunning(value))
    } catch {
      // the board still works without the command
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    let ctx = null
    try {
      ctx = await beginTool($, e, custom, extra)
    } catch {
      ctx = null
    }
    let result
    try {
      result = await next(e)
    } catch (err) {
      try {
        await abortTool($, ctx)
      } catch {
        // ignore
      }
      throw err
    }
    try {
      await endTool($, e, ctx, result, extra)
    } catch {
      // a bookkeeping failure must never change the tool's result
    }
    return result
  })

  // A person may have edited files between turns.
  on('prompt.submit', async ($, e, next) => {
    try {
      await scanActive($, extra, true)
    } catch {
      // ignore
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const out = await next(e)
    try {
      await scanActive($, extra, false)
    } catch {
      // ignore
    }
    return out
  })

  on('command.run', { command: 'ship-check' }, async ($) => {
    await $.ui.open({ id: PANE_ID, title: 'Ship Check', focus: true, closeOnEscape: true })
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const ledger = await read($, ledgerAtom)
    await debugRender($, e, ledger)
    if (!hasAnyRecord(ledger)) return next(e)
    const els = $.ui.resolve(e)
    const cwd = await sessionCwd($)
    const openPanel = () => $.ui.open({ id: PANE_ID, title: 'Ship Check', focus: true, closeOnEscape: true })
    const strip = buildStrip(els, ledger, cwd, customKinds, openPanel)
    // Other mods may draw here too. The band is one row tall, so sit side by side instead of stacking.
    const theirs = await next(e)
    if (!theirs) return strip
    return els.Box({ flexDirection: 'row', columnGap: 3, children: [strip, theirs] })
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    const ledger = await read($, ledgerAtom)
    const view = await read($, viewAtom)
    const els = $.ui.resolve(e)
    const cwd = await sessionCwd($)
    return buildPane(els, {
      ledger,
      cwd,
      expanded: view.expanded,
      customKinds,
      onToggle: (key) => update($, viewAtom, (v) => ({ expanded: v.expanded === key ? null : key })),
      onPrepare: () => prepareChecks($),
    })
  })
}
