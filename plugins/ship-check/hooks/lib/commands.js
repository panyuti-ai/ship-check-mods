// Recognizes test, build and type-check commands in a Bash command line.
// Pure functions: no Claude Code API is used here.

import { resolveDir } from './paths.js'

// Display names for the built-in kinds; custom kinds are capitalized from their id.
export const KIND_LABELS = { test: 'Tests', typecheck: 'Types', build: 'Build' }
export const DEFAULT_KINDS = ['test', 'typecheck', 'build']

export function kindLabel(kind) {
  if (KIND_LABELS[kind]) return KIND_LABELS[kind]
  return kind.charAt(0).toUpperCase() + kind.slice(1)
}

// Splits a command line on `&&`. `simple` is false when anything else could change which command
// decides the exit status: pipes, `;`, `||`, backgrounding, subshells, substitutions, newlines.
export function tokenizeChain(cmd, ps = false) {
  const segments = []
  let tokens = []
  let cur = ''
  let has = false
  let simple = true
  let quote = null

  const pushToken = () => {
    if (has) tokens.push(cur)
    cur = ''
    has = false
  }
  const pushSegment = () => {
    pushToken()
    if (tokens.length) segments.push(tokens)
    tokens = []
  }

  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < cmd.length) cur += cmd[++i]
      else cur += c
      has = true
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      has = true
      continue
    }
    if (c === '\\' && i + 1 < cmd.length && /[\s"'\\$&|;]/.test(cmd[i + 1])) {
      cur += cmd[++i]
      has = true
      continue
    }
    if (c === '\n' || c === '\r') {
      simple = false
      pushSegment()
      continue
    }
    if (/\s/.test(c)) {
      pushToken()
      continue
    }
    if (c === '&') {
      if (ps && !has && tokens.length === 0 && cmd[i + 1] !== '&') continue // the call operator: & "path"
      if (cmd[i + 1] === '&') {
        pushSegment()
        i++
        continue
      }
      if (cmd[i + 1] === '>' || cmd[i - 1] === '>') {
        cur += c // a redirect such as 2>&1 or &>file
        has = true
        continue
      }
      simple = false // a single & runs the command in the background
      pushSegment()
      continue
    }
    if (c === '|') {
      simple = false
      if (cmd[i + 1] === '|') i++
      pushSegment()
      continue
    }
    if (c === ';') {
      simple = false
      pushSegment()
      continue
    }
    if ((!ps && c === '`') || c === '(' || c === ')' || (c === '$' && cmd[i + 1] === '(')) {
      simple = false
      cur += c
      has = true
      continue
    }
    cur += c
    has = true
  }
  if (quote) simple = false
  pushSegment()
  return { segments, simple }
}

// Drops leading `time`, `env`, VAR=value words, and redirections.
function cleanTokens(tokens) {
  const out = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (/^\d*>>?(&\d+)?$/.test(t) || /^&>/.test(t)) {
      i++ // the operator and its target
      continue
    }
    if (/^\d*>>?\S/.test(t) || /^<\S/.test(t)) continue
    out.push(t)
  }
  let start = 0
  while (start < out.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(out[start]) || out[start] === 'time' || out[start] === 'env')) start++
  return out.slice(start)
}

const WATCH_FLAG = /^--watch(All)?(=true)?$/
const PM_NAMES = ['npm', 'pnpm', 'yarn', 'bun']

export function kindForScript(name) {
  if (!name) return null
  if (/watch/i.test(name)) return null
  if (/^(test|tests|unit|test:.+|tests:.+|unit:.+)$/i.test(name)) return 'test'
  if (/^(typecheck|type-check|check-types|check:types|types|tsc|tsc:check|typecheck:.+|type-check:.+)$/i.test(name)) return 'typecheck'
  if (/^(build|build:.+)$/i.test(name)) return 'build'
  return null
}

function kindForTool(tool, args) {
  if (tool === 'tsc') {
    if (args.some((a) => /^-{1,2}noEmit$/i.test(a))) return { kind: 'typecheck' }
    if (args.includes('--watch') || args.includes('-w')) return { kind: 'build', watch: true }
    return { kind: 'build' }
  }
  if (tool === 'vitest') {
    const run = args[0] === 'run' || args.includes('--run')
    return { kind: 'test', watch: !run || args.some((a) => WATCH_FLAG.test(a)) }
  }
  if (tool === 'jest') return { kind: 'test', watch: args.some((a) => WATCH_FLAG.test(a)) }
  return null
}

// Reads one package-manager invocation. Returns null when it is not a recognized check.
function interpretPackageManager(pm, rest) {
  const info = { pm, cwdArg: null, scope: '', watch: false, filtered: false, script: null, builtinTest: false }
  let i = 0
  let command = null
  const take = () => rest[++i]

  for (; i < rest.length; i++) {
    const t = rest[i]
    if (t === '--') break
    if (t.startsWith('-')) {
      let m
      if ((m = /^--(prefix|cwd|dir)=(.*)$/.exec(t))) info.cwdArg = m[2]
      else if (t === '--prefix' || t === '--cwd' || t === '--dir' || t === '-C') info.cwdArg = take()
      else if ((m = /^--(workspace|filter)=(.*)$/.exec(t))) info.scope += (info.scope ? ',' : '') + m[2]
      else if (t === '--workspace' || t === '-w' || t === '--filter' || t === '-F') {
        const v = take()
        if (v) info.scope += (info.scope ? ',' : '') + v
      } else if (t === '-r' || t === '--recursive' || t === '--workspaces') info.scope += (info.scope ? ',' : '') + '*'
      else if (WATCH_FLAG.test(t)) info.watch = true
      continue
    }
    command = t
    break
  }
  if (command === null) return null

  let script = null
  const after = rest.slice(i + 1)
  const scriptArgs = []
  let passthrough = false
  const addScope = (v) => {
    if (v) info.scope += (info.scope ? ',' : '') + v
  }
  const readScriptTokens = (list) => {
    for (let k = 0; k < list.length; k++) {
      const a = list[k]
      if (a === '--') {
        passthrough = true
        continue
      }
      if (passthrough) {
        info.filtered = true
        if (WATCH_FLAG.test(a) || a === '-w') info.watch = true
        continue
      }
      let m
      if (WATCH_FLAG.test(a)) info.watch = true
      else if ((m = /^--(workspace|filter)=(.*)$/.exec(a))) addScope(m[2])
      else if (a === '--workspace' || a === '-w' || a === '--filter' || a === '-F') addScope(list[++k])
      else if ((m = /^--(prefix|cwd|dir)=(.*)$/.exec(a))) info.cwdArg = m[2]
      else if (a === '--prefix' || a === '--cwd' || a === '--dir' || a === '-C') info.cwdArg = list[++k]
      else if (a === '-r' || a === '--recursive' || a === '--workspaces') addScope('*')
      else if (!a.startsWith('-')) scriptArgs.push(a)
    }
  }

  if (command === 'test' || command === 't' || command === 'tst') {
    script = 'test'
    if (pm === 'bun') info.builtinTest = true
    readScriptTokens(after)
  } else if (command === 'run' || command === 'run-script' || command === 'rum' || command === 'urn') {
    // flags may sit between `run` and the script name
    const idx = after.findIndex((a) => !a.startsWith('-'))
    if (idx === -1) return null
    for (const a of after.slice(0, idx)) {
      if (WATCH_FLAG.test(a)) info.watch = true
    }
    script = after[idx]
    readScriptTokens(after.slice(idx + 1))
  } else if (command === 'workspace' && pm === 'yarn') {
    info.scope += (info.scope ? ',' : '') + (after[0] || '')
    const idx = after.slice(1).findIndex((a) => !a.startsWith('-'))
    if (idx === -1) return null
    script = after.slice(1)[idx]
    readScriptTokens(after.slice(1 + idx + 1))
  } else if (command === 'build' && pm === 'bun') {
    script = 'build'
    readScriptTokens(after)
  } else if (pm !== 'npm' && kindForScript(command)) {
    script = command // pnpm build, yarn typecheck, bun typecheck
    readScriptTokens(after)
  } else if (command === 'exec' || command === 'x' || command === 'dlx') {
    const tool = after[0]
    const toolInfo = tool ? kindForTool(tool, after.slice(1)) : null
    if (!toolInfo) return null
    return { ...info, kind: toolInfo.kind, watch: info.watch || !!toolInfo.watch, script: tool }
  } else {
    return null
  }

  const kind = kindForScript(script)
  if (!kind) return null
  if (scriptArgs.length) info.filtered = true // e.g. `pnpm test src/a.test.ts`
  return { ...info, kind, script }
}

// Interprets one `&&` segment: a directory change, a check, or something else (null).
export function interpretSegment(rawTokens, customChecks) {
  const tokens = cleanTokens(rawTokens)
  if (tokens.length === 0) return null

  if (/^(cd|chdir|sl|set-location)$/i.test(tokens[0])) return { type: 'cd', dir: tokens[1] && !tokens[1].startsWith('-') ? tokens[1] : tokens[2] || null }
  if (tokens[0] === 'pushd' || tokens[0] === 'popd') return { type: 'unsupported-cd' }

  const text = tokens.join(' ')
  for (const custom of customChecks || []) {
    if (text === custom.command || text.startsWith(custom.command + ' ')) {
      const rest = text.slice(custom.command.length).trim()
      return {
        type: 'check',
        kind: custom.kind,
        pm: 'custom',
        cwdArg: null,
        scope: '',
        watch: /(^|\s)--watch(All)?(\s|$)/.test(rest),
        filtered: false,
        text,
      }
    }
  }

  let head = tokens[0]
  let rest = tokens.slice(1)
  if (head === 'npx' || head === 'bunx' || head === 'pnpx') {
    const toolInfo = rest[0] ? kindForTool(rest[0], rest.slice(1)) : null
    if (!toolInfo) return null
    return { type: 'check', kind: toolInfo.kind, pm: head, cwdArg: null, scope: '', watch: !!toolInfo.watch, filtered: false, text }
  }
  if (head === 'tsc' || head === 'vitest' || head === 'jest') {
    const toolInfo = kindForTool(head, rest)
    return { type: 'check', kind: toolInfo.kind, pm: 'direct', cwdArg: null, scope: '', watch: !!toolInfo.watch, filtered: false, text }
  }
  if (!PM_NAMES.includes(head)) return null
  const found = interpretPackageManager(head, rest)
  if (!found) return null
  return { type: 'check', ...found, text }
}

// A PowerShell statement that only prints $LASTEXITCODE, as in: npm test; "EXIT: $LASTEXITCODE"
export function isExitEcho(stmt) {
  const s = stmt.trim()
  if (!/\$LASTEXITCODE/.test(s)) return false
  return /^(["'].*["']|(write-host|write-output|echo)\b.*|\$LASTEXITCODE)$/i.test(s)
}

// Splits on top-level semicolons (PowerShell statements), ignoring those inside quotes.
function splitStatements(cmd) {
  const out = []
  let cur = ''
  let quote = null
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i]
    if (quote) {
      if (ch === quote) quote = null
      cur += ch
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    if (ch === ';') {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out.filter((s) => s.trim() !== '')
}

// Parses a whole command line. `baseDir` is the session's working directory.
export function analyzeCommand(cmd, baseDir, customChecks, options = {}) {
  const ps = options.powershell === true
  let exitEcho = false
  if (ps) {
    const statements = splitStatements(cmd)
    if (statements.length > 1 && statements.slice(1).every(isExitEcho) && !isExitEcho(statements[0])) {
      cmd = statements[0]
      exitEcho = true
    }
  }
  const { segments, simple } = tokenizeChain(cmd, ps)
  const result = { simple, total: segments.length, checks: [], unresolvedDir: false, hasWatch: false, exitEcho }
  let dir = baseDir || null
  segments.forEach((tokens, index) => {
    const seg = interpretSegment(tokens, customChecks)
    if (!seg) return
    if (seg.type === 'unsupported-cd') {
      result.simple = false
      return
    }
    if (seg.type === 'cd') {
      dir = seg.dir ? resolveDir(dir, seg.dir) : null
      return
    }
    let location = dir
    if (seg.cwdArg) location = resolveDir(dir, seg.cwdArg)
    if (!location) {
      result.unresolvedDir = true
      return
    }
    if (seg.watch) result.hasWatch = true
    result.checks.push({
      index,
      kind: seg.kind,
      location,
      scope: seg.scope || '',
      watch: !!seg.watch,
      filtered: !!seg.filtered,
      command: seg.text,
    })
  })
  return result
}

// Parses user config lines such as `lint=npm run lint` into custom checks.
export function parseCustomChecks(lines) {
  const out = []
  for (const line of Array.isArray(lines) ? lines : []) {
    if (typeof line !== 'string') continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const kind = line.slice(0, eq).trim().toLowerCase()
    const command = line
      .slice(eq + 1)
      .trim()
      .split(/\s+/)
      .join(' ')
    if (!/^[a-z0-9-]{1,16}$/.test(kind) || !command) continue
    out.push({ kind, command })
  }
  return out
}