// The ledger of checks and the rules that turn tool results into statuses.
// Pure functions over plain JSON: nothing here calls the Claude Code API.

import { isUnder, relativeTo, normalizePath } from './paths.js'
import { DEFAULT_KINDS, kindLabel } from './commands.js'

export const MAX_RUNS = 40
export const MAX_SUMMARY_CHARS = 1500
export const MAX_STALE_FILES = 5

export const STATUS = {
  NOT_RUN: 'Not run',
  RUNNING: 'Running',
  PASSED: 'Passed',
  FAILED: 'Failed',
  STALE: 'Stale',
  UNKNOWN: 'Unknown',
}

export function emptyLedger() {
  return { records: {}, runs: [] }
}

export function recordKey(location, kind, scope) {
  return location + '|' + kind + '|' + (scope || '')
}

// --- Which files count -------------------------------------------------------------------------

const EXCLUDED_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', '.next', '.nuxt', '.svelte-kit',
  '.turbo', '.cache', '.parcel-cache', '.vite', '.vitepress', '.yarn', '.pnpm-store', 'coverage',
  '.nyc_output', 'target', '__pycache__', '.venv', 'venv', '.claude', '.idea', '.vscode',
  '.gradle', 'storybook-static', 'playwright-report', 'test-results',
])
const EXCLUDED_FILE = /(\.log|\.tsbuildinfo|\.tmp|\.swp|\.swo|~)$|^\.DS_Store$|^Thumbs\.db$/
const DEPENDENCY_FILE = /^(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|\.npmrc|\.yarnrc(\.yml)?|\.nvmrc|\.node-version|\.tool-versions)$/
const CONFIG_FILE = /^(tsconfig[\w.-]*\.json|jsconfig\.json|[\w.-]*\.config\.[cm]?[jt]s|\.eslintrc[\w.]*|\.prettierrc[\w.]*|babel\.config[\w.]*|\.babelrc[\w.]*|\.env[\w.]*|vite\.config[\w.]*|Makefile|Dockerfile)$/

// `rel` uses forward slashes and is relative to the project root. `extra` is the user's ignore list.
export function isTrackedPath(rel, extra) {
  if (!rel || rel.startsWith('../')) return false
  const parts = rel.split('/')
  for (let i = 0; i < parts.length - 1; i++) if (EXCLUDED_DIRS.has(parts[i])) return false
  if (EXCLUDED_DIRS.has(parts[parts.length - 1]) && parts.length === 1) return false
  if (EXCLUDED_FILE.test(parts[parts.length - 1])) return false
  for (const raw of extra || []) {
    const pat = String(raw).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    if (!pat) continue
    if (rel === pat || rel.startsWith(pat + '/') || parts.includes(pat)) return false
  }
  return true
}

export function categorizePath(rel) {
  const name = rel.split('/').pop() || rel
  if (DEPENDENCY_FILE.test(name)) return 'dependency'
  if (CONFIG_FILE.test(name)) return 'config'
  return 'source'
}

// "Source files changed after this check completed."
export function staleReasonFor(categories, when = 'completed') {
  const order = ['source', 'config', 'dependency']
  const present = order.filter((c) => categories.includes(c))
  if (present.length === 0) present.push('source')
  const names = present.map((c) => (c === 'source' ? 'Source' : c === 'config' ? 'configuration' : 'dependency'))
  let subject
  if (names.length === 1) subject = names[0] + ' files'
  else if (names.length === 2) subject = names[0] + ' and ' + names[1] + ' files'
  else subject = names[0] + ', ' + names[1] + ', and ' + names[2] + ' files'
  const phrase = when === 'running' ? 'while this check was running' : 'after this check completed'
  return subject.charAt(0).toUpperCase() + subject.slice(1) + ' changed ' + phrase + '.'
}

// --- Turning a tool result into a status ------------------------------------------------------

export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r(?!\n)/g, '\n')
}

export function tailOutput(stdout, stderr, max = MAX_SUMMARY_CHARS) {
  const parts = []
  if (typeof stdout === 'string' && stdout) parts.push(stdout)
  if (typeof stderr === 'string' && stderr) parts.push(stderr)
  const text = stripAnsi(parts.join('\n')).trim()
  if (text.length <= max) return text
  return '…' + text.slice(text.length - max + 1)
}

export function parseExitCode(text) {
  if (typeof text !== 'string') return null
  const m = /(?:^|\n)Exit code:?\s+(-?\d+)/.exec(text)
  return m ? Number(m[1]) : null
}

// Decides the status of one check from what the Bash tool actually reported.
// `parsed` is analyzeCommand's output, `check` the check inside it, `outcome` the tool result.
// The last number on the last output line, as in "EXIT: 2".
export function parseTrailingCode(text) {
  if (typeof text !== 'string') return null
  const lines = stripAnsi(text).split('\n').map((l) => l.trim()).filter(Boolean)
  const m = lines.length ? /(-?\d+)$/.exec(lines[lines.length - 1]) : null
  return m ? Number(m[1]) : null
}

export function classifyOutcome(parsed, check, outcome) {
  const unknown = (reason) => ({ status: 'unknown', reason, exitCode: null })

  if (check.watch || parsed.hasWatch) return unknown('Watch mode does not finish on its own, so no result was recorded.')
  if (!outcome || typeof outcome !== 'object') return unknown('The tool returned no result for this command.')

  // A command that exits non-zero comes back as isError with the text 'Exit code N ...' and a
  // string result; only a successful run carries the structured record.
  if (parsed.exitEcho) return classifyExitEcho(parsed, check, outcome)
  if (outcome.isError === true) return classifyFailure(parsed, check, outcome)
  if (!outcome.result || typeof outcome.result !== 'object') return unknown('The tool returned no result for this command.')
  const r = outcome.result
  if (r.backgroundTaskId || r.backgroundedByUser || r.backgroundedByTurnAbort || r.backgroundedToDeliverMessage || r.timedOutAfterMs) {
    return unknown('The command moved to the background before it finished.')
  }
  if (r.interrupted === true) return unknown('The command was interrupted before it finished.')
  if (typeof r.interrupted !== 'boolean') return unknown('The tool did not report whether the command finished.')
  if (!parsed.simple) return unknown('This compound command does not show which part decided the exit status.')

  if (typeof r.returnCodeInterpretation === 'string' && r.returnCodeInterpretation) {
    return unknown('The command exited with a status that the tool did not treat as a plain success.')
  }
  // `&&` chains only reach the end when every command succeeded, so the exit status is 0.
  return { status: 'passed', reason: null, exitCode: 0 }
}

// "npm test; \"EXIT: $LASTEXITCODE\"": the shell itself printed the check's exit status.
function classifyExitEcho(parsed, check, outcome) {
  const unknown = (reason) => ({ status: 'unknown', reason, exitCode: null })
  const r = outcome.result && typeof outcome.result === 'object' ? outcome.result : null
  if (r) {
    if (r.backgroundTaskId || r.backgroundedByUser || r.backgroundedByTurnAbort || r.backgroundedToDeliverMessage || r.timedOutAfterMs) {
      return unknown('The command moved to the background before it finished.')
    }
    if (r.interrupted === true) return unknown('The command was interrupted before it finished.')
  }
  if (!parsed.simple) return unknown('This compound command does not show which part decided the exit status.')
  const last = check.index === parsed.total - 1
  if (parsed.checks.length !== 1 || !last) return unknown('The printed exit status may belong to another command in this chain.')
  const code = parseTrailingCode(r ? r.stdout : outcome.text)
  if (code === null) return unknown('The exit status line could not be read from the output.')
  return code === 0 ? { status: 'passed', reason: null, exitCode: 0 } : { status: 'failed', reason: null, exitCode: code }
}

function classifyFailure(parsed, check, outcome) {
  const unknown = (reason) => ({ status: 'unknown', reason, exitCode: null })
  const exitCode = parseExitCode(outcome.text)
  if (!parsed.simple) return unknown('This compound command does not show which part decided the exit status.')
  if (exitCode === null) return unknown('The tool reported an error but no exit status.')
  const last = check.index === parsed.total - 1
  const onlyCheck = parsed.checks.length === 1
  if (onlyCheck && last) return { status: 'failed', reason: null, exitCode }
  return unknown('Another command in this chain may have failed, so the result is not tied to this check.')
}

// --- Display -------------------------------------------------------------------------------------

export function displayStatus(record) {
  if (!record) return { status: STATUS.NOT_RUN, detail: null }
  if (record.status === 'running') return { status: STATUS.RUNNING, detail: null }
  if (record.status === 'unknown') return { status: STATUS.UNKNOWN, detail: record.reason || null }
  if (record.staleAt) {
    return {
      status: STATUS.STALE,
      detail: record.staleReason || 'Files changed after this check completed.',
      last: record.status === 'passed' ? STATUS.PASSED : STATUS.FAILED,
    }
  }
  return { status: record.status === 'passed' ? STATUS.PASSED : STATUS.FAILED, detail: null }
}

export const ICONS = {
  [STATUS.NOT_RUN]: '○',
  [STATUS.RUNNING]: '◌',
  [STATUS.PASSED]: '✓',
  [STATUS.FAILED]: '✗',
  [STATUS.STALE]: '↻',
  [STATUS.UNKNOWN]: '?',
}

export const STATUS_COLORS = {
  [STATUS.NOT_RUN]: undefined,
  [STATUS.RUNNING]: 'cyan',
  [STATUS.PASSED]: 'green',
  [STATUS.FAILED]: 'red',
  [STATUS.STALE]: 'yellow',
  [STATUS.UNKNOWN]: 'yellow',
}

export function relevantToCwd(record, cwd) {
  if (!cwd) return true
  return isUnder(record.location, cwd) || isUnder(cwd, record.location)
}

// One entry per kind for the status line: the most recent record near `cwd`.
export function kindSummary(ledger, cwd, customKinds) {
  const kinds = [...DEFAULT_KINDS]
  for (const k of customKinds || []) if (!kinds.includes(k)) kinds.push(k)
  const records = Object.values(ledger.records).filter((r) => relevantToCwd(r, cwd))
  return kinds.map((kind) => {
    const mine = records.filter((r) => r.kind === kind).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    const record = mine[0] || null
    return { kind, label: kindLabel(kind), record, ...displayStatus(record) }
  })
}

export function hasAnyRecord(ledger) {
  return Object.keys(ledger.records).length > 0
}

export function formatClock(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

export function formatDuration(ms) {
  if (typeof ms !== 'number' || ms < 0) return ''
  if (ms < 1000) return ms + 'ms'
  const s = ms / 1000
  if (s < 60) return s.toFixed(1) + 's'
  const m = Math.floor(s / 60)
  return m + 'm ' + Math.round(s - m * 60) + 's'
}

export function summaryLine(record) {
  if (!record) return ''
  const bits = []
  if (record.endedAt) bits.push(formatClock(record.endedAt))
  else if (record.startedAt) bits.push('started ' + formatClock(record.startedAt))
  if (record.endedAt && record.startedAt) bits.push(formatDuration(record.endedAt - record.startedAt))
  if (typeof record.exitCode === 'number') bits.push('exit ' + record.exitCode)
  return bits.join(' · ')
}

// --- Ledger updates -------------------------------------------------------------------------------

function pushRun(runs, record) {
  const run = {
    key: record.key,
    kind: record.kind,
    location: record.location,
    command: record.command,
    status: record.status,
    startedAt: record.startedAt,
    endedAt: record.endedAt || null,
  }
  return [...runs, run].slice(-MAX_RUNS)
}

export function beginRecord(ledger, check, startSig, root, now) {
  const key = recordKey(check.location, check.kind, check.scope)
  const record = {
    key,
    kind: check.kind,
    location: check.location,
    scope: check.scope,
    root,
    command: check.command,
    filtered: check.filtered,
    status: 'running',
    startedAt: now,
    endedAt: null,
    exitCode: null,
    reason: null,
    summary: '',
    startSig,
    endSig: null,
    dirtyDuringRun: false,
    staleAt: null,
    staleReason: null,
    staleFiles: [],
  }
  return { ...ledger, records: { ...ledger.records, [key]: record } }
}

// Puts a record back the way it was before this run began (the tool call never ran).
export function restoreRecord(ledger, key, previous) {
  const records = { ...ledger.records }
  if (previous) records[key] = previous
  else delete records[key]
  return { ...ledger, records }
}

export function finishRecord(ledger, key, startedAt, finish) {
  const current = ledger.records[key]
  if (!current || current.startedAt !== startedAt) return ledger // a newer run owns this key
  let record = {
    ...current,
    status: finish.status,
    endedAt: finish.now,
    exitCode: finish.exitCode,
    reason: finish.reason,
    summary: finish.summary,
    endSig: finish.endSig,
  }
  if (record.status === 'passed' || record.status === 'failed') {
    const changedDuring = current.dirtyDuringRun || (current.startSig && finish.endSig && current.startSig.hash !== finish.endSig.hash)
    if (changedDuring) {
      record = {
        ...record,
        staleAt: finish.now,
        staleReason: staleReasonFor(finish.duringCategories && finish.duringCategories.length ? finish.duringCategories : ['source'], 'running'),
        staleFiles: finish.duringFiles || [],
      }
    }
  }
  return { ...ledger, records: { ...ledger.records, [key]: record }, runs: pushRun(ledger.runs, record) }
}

// A file changed through Claude's own tools or a shell command we could read.
export function applyEdit(ledger, absPath, now, extra) {
  const path = normalizePath(absPath)
  let changed = false
  const records = {}
  for (const [key, rec] of Object.entries(ledger.records)) {
    records[key] = rec
    if (!rec.root || !isUnder(path, rec.root)) continue
    const rel = relativeTo(path, rec.root)
    if (!isTrackedPath(rel, extra)) continue
    if (rec.status === 'running') {
      if (!rec.dirtyDuringRun) {
        records[key] = { ...rec, dirtyDuringRun: true }
        changed = true
      }
      continue
    }
    if ((rec.status === 'passed' || rec.status === 'failed') && !rec.staleAt) {
      records[key] = {
        ...rec,
        staleAt: now,
        staleReason: staleReasonFor([categorizePath(rel)]),
        staleFiles: [rel],
      }
      changed = true
    }
  }
  return changed ? { ...ledger, records } : ledger
}

// A change we cannot name: mark every finished result under `root` as stale for `reason`.
export function applyUnnamedChange(ledger, root, now, reason) {
  let changed = false
  const records = {}
  for (const [key, rec] of Object.entries(ledger.records)) {
    records[key] = rec
    if (!rec.root || !(isUnder(root, rec.root) || isUnder(rec.root, root))) continue
    if (rec.status === 'running') {
      if (!rec.dirtyDuringRun) records[key] = { ...rec, dirtyDuringRun: true }
      changed = true
    } else if ((rec.status === 'passed' || rec.status === 'failed') && !rec.staleAt) {
      records[key] = { ...rec, staleAt: now, staleReason: reason, staleFiles: [] }
      changed = true
    }
  }
  return changed ? { ...ledger, records } : ledger
}

// A fingerprint scan of `root` found `sig`. Compares it with each finished record's end fingerprint.
// `previous` is { hash, reason, files } describing what changed since the scan with that hash;
// a record whose end fingerprint is some other scan gets the generic reason.
export function applyScan(ledger, root, sig, now, previous) {
  let changed = false
  const records = {}
  for (const [key, rec] of Object.entries(ledger.records)) {
    records[key] = rec
    if (rec.root !== root || !sig) continue
    if ((rec.status !== 'passed' && rec.status !== 'failed') || rec.staleAt || !rec.endSig) continue
    if (rec.endSig.partial || sig.partial) continue // a capped scan cannot prove a difference
    if (rec.endSig.hash === sig.hash) continue
    const known = previous && previous.hash === rec.endSig.hash
    records[key] = {
      ...rec,
      staleAt: now,
      staleReason: known && previous.reason ? previous.reason : 'Files changed after this check completed.',
      staleFiles: known && previous.files ? previous.files.slice(0, MAX_STALE_FILES) : [],
    }
    changed = true
  }
  return changed ? { ...ledger, records } : ledger
}

// Records still marked Running after a reload or restart can no longer be completed.
export function settleRunning(ledger) {
  let changed = false
  const records = {}
  for (const [key, rec] of Object.entries(ledger.records)) {
    if (rec.status === 'running') {
      records[key] = { ...rec, status: 'unknown', reason: 'The session reloaded before this check reported a result.' }
      changed = true
    } else records[key] = rec
  }
  return changed ? { ...ledger, records } : ledger
}

export function activeRoots(ledger) {
  const roots = new Set()
  for (const rec of Object.values(ledger.records)) {
    if (!rec.root) continue
    if (rec.status === 'running' || ((rec.status === 'passed' || rec.status === 'failed') && !rec.staleAt)) roots.add(rec.root)
  }
  return [...roots]
}

// Text that goes into the prompt box when the user presses "Prepare checks".
export function preparePrompt(items) {
  const lines = items.map((i) => '- ' + i.command + (i.location ? ' (in ' + i.location + ')' : ''))
  return (
    'Please re-run these checks now and tell me the real results from the tool output, not from memory:\n' +
    (lines.length ? lines.join('\n') : '- the project’s test, type-check, and build commands') +
    '\nRun each one separately and wait for it to finish.'
  )
}
