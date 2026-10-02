// Reads a whole shell command line and decides, for every check inside it, how far the tool's exit
// status can be trusted. Pure functions: no Claude Code API is used here.
//
// What the tools report, measured against real sessions:
//   Bash        the exit status of the last statement.
//   PowerShell  `$LASTEXITCODE`: the exit status of the last native program that ran, however many
//               cmdlets, pipelines into cmdlets, or `if` blocks follow it.
//
// Each check gets a `mode`:
//   exact         the tool's exit status is this check's exit status.
//   success-only  a clean finish proves this check passed, but a failure could belong to another
//                 command in the same `&&` chain.
//   echo          the shell printed the status (`echo "EXIT: $?"`), so it is read from the output.
//   none          the exit status cannot be tied to this check.

import { interpretSegment, tokenizeChain } from './commands.js'
import { resolveDir } from './paths.js'

const OR_FLAG = /\|\|/
const BACKGROUND = /(?<![&>])&(?![&>])/
const SUBSHELL_SH = /\$\(|\(|\)|`/
const SUBSHELL_PS = /\$\(|\(|\)/
const CMDLET = /^[A-Za-z]+-[A-Za-z]+/
const UNSAFE_CMDLET = /^(invoke-|start-process|start-job|new-object|add-type)/i
const PS_ALIASES = new Set(['select', 'where', 'foreach', 'sort', 'group', 'measure', 'tee', 'ft', 'fl', 'more', 'oh', 'ogv'])

// Replaces the inside of quoted strings with `_`, keeping every index the same.
function stripQuoted(s) {
  let out = ''
  let q = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) {
      if (c === q) {
        q = null
        out += c
      } else out += '_'
    } else {
      out += c
      if (c === '"' || c === "'") q = c
    }
  }
  return { text: out, unterminated: q !== null }
}

// Splits `orig` where `match(stripped, i)` returns a separator length, outside () {} [].
function splitBy(orig, stripped, match) {
  const out = []
  let start = 0
  let depth = 0
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped[i]
    if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') depth = Math.max(0, depth - 1)
    if (depth === 0) {
      const len = match(stripped, i)
      if (len > 0) {
        out.push(orig.slice(start, i))
        start = i + len
        i += len - 1
      }
    }
  }
  out.push(orig.slice(start))
  return out.map((s) => s.trim()).filter(Boolean)
}

const matchStatementEnd = (s, i) => (s[i] === ';' || s[i] === '\n' || s[i] === '\r' ? 1 : 0)
const matchAndAnd = (s, i) => (s[i] === '&' && s[i + 1] === '&' ? 2 : 0)
const matchPipe = (s, i) => (s[i] === '|' && s[i + 1] !== '|' && s[i - 1] !== '|' ? 1 : 0)

function isCmdletStage(stage) {
  const first = stage.trim().split(/\s+/)[0] || ''
  if (UNSAFE_CMDLET.test(first)) return false
  return CMDLET.test(first) || PS_ALIASES.has(first.toLowerCase())
}

// One statement: its `&&` chain, each segment's pipeline, and flags for forms we cannot follow.
function parseStatement(text, ps, customChecks) {
  const { text: stripped, unterminated } = stripQuoted(text)
  const s = ps ? stripped.replace(/^&\s+/, ' ') : stripped
  const flags = {
    or: OR_FLAG.test(s),
    bg: BACKGROUND.test(s),
    sub: (ps ? SUBSHELL_PS : SUBSHELL_SH).test(s),
    unterminated,
  }
  const segTexts = splitBy(text, stripped, matchAndAnd)
  const chain = segTexts.map((segText) => {
    const segStripped = stripQuoted(segText).text
    const stages = splitBy(segText, segStripped, matchPipe)
    const head = stages[0] || ''
    const tokens = tokenizeChain(head, ps).segments[0] || []
    const interp = interpretSegment(tokens, customChecks, ps)
    let kind = 'other'
    if (interp && interp.type === 'cd') kind = 'cd'
    else if (interp && interp.type === 'check') kind = 'check'
    return {
      text: segText,
      stages,
      pipe: stages.length > 1,
      nativePipe: ps && stages.slice(1).some((st) => !isCmdletStage(st)),
      interp,
      kind,
    }
  })
  return { text, flags, chain }
}

// --- Statements that cannot change the exit status ---------------------------------------------

function braceBodies(s) {
  const bodies = []
  let depth = 0
  let start = -1
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') {
      if (depth === 0) start = i + 1
      depth++
    } else if (s[i] === '}') {
      depth = Math.max(0, depth - 1)
      if (depth === 0 && start >= 0) {
        bodies.push(s.slice(start, i))
        start = -1
      }
    }
  }
  return bodies
}

// True when a PowerShell statement runs no native program, so `$LASTEXITCODE` stays as it was.
export function psStatementNonNative(stmt, customChecks) {
  const s = stmt.trim()
  if (!s) return true
  const { text: st } = stripQuoted(s)
  if (/^["']/.test(s) && !/[|&]/.test(st)) return true
  if (/^\$(\?|LASTEXITCODE)\s*$/i.test(s)) return true
  if (/^\$\w+\s*=/.test(s)) return false // an assignment may hold a native program
  if (/^exit\s+\$LASTEXITCODE\s*$/i.test(s)) return true
  const first = (s.split(/\s+/)[0] || '').toLowerCase()

  if (/^(if|elseif)\b/.test(first) || first === 'if(') {
    const open = st.indexOf('(')
    if (open < 0) return false
    let depth = 0
    let close = -1
    for (let i = open; i < st.length; i++) {
      if (st[i] === '(') depth++
      else if (st[i] === ')') {
        depth--
        if (depth === 0) {
          close = i
          break
        }
      }
    }
    if (close < 0) return false
    const condition = st.slice(open + 1, close)
    if (!/^[\w\s$?!.\-='"<>]*$/.test(condition)) return false
    const bodies = braceBodies(s.slice(close + 1))
    if (!bodies.length) return false
    return bodies.every((b) => splitBy(b, stripQuoted(b).text, matchStatementEnd).every((x) => psStatementNonNative(x, customChecks)))
  }

  const tokens = tokenizeChain(s, true).segments[0] || []
  const interp = interpretSegment(tokens, customChecks, true)
  if (interp && interp.type === 'cd') return true
  if (interp && interp.type === 'check') return false
  if (/\$\(|\(/.test(st)) return false
  if (/^(write-host|write-output|write-information|write-warning|write-verbose|echo)\b/i.test(s)) return true
  if (UNSAFE_CMDLET.test(first)) return false
  if (CMDLET.test(first)) {
    // every pipeline stage must be a cmdlet too
    return splitBy(s, st, matchPipe).every(isCmdletStage)
  }
  return false
}

// `echo "EXIT: $?"` (or `${PIPESTATUS[0]}` after a pipeline): the shell printed the status itself.
export function exitEchoSh(stmt, afterPipe) {
  const s = stmt.trim()
  if (!/^(echo|printf)\b/.test(s)) return false
  const { text: st } = stripQuoted(s)
  if (/[|&;]|\$\(|`/.test(st)) return false
  if (/\$\{PIPESTATUS\[0\]\}/.test(s)) return true
  return !afterPipe && /\$\?/.test(s)
}

// --- Wrappers: cmd /c "..." and sh -c "..." --------------------------------------------------------

function unwrap(text) {
  const t = text.trim()
  let m = /^cmd(?:\.exe)?\s+((?:\/[a-z]\s+)*)\/c\s+([\s\S]+)$/i.exec(t)
  if (m) {
    let inner = m[2].trim()
    if (inner.startsWith('"')) {
      const close = inner.indexOf('"', 1)
      if (close !== inner.length - 1) return null // text after the quoted command: not a plain wrapper
      inner = inner.slice(1, -1)
    }
    return { inner, shell: 'cmd' }
  }
  m = /^(?:bash|sh|zsh)\s+-[a-z]*c\s+(['"])([\s\S]*)\1$/i.exec(t)
  if (m) return { inner: m[2], shell: 'sh' }
  return null
}

// In cmd, a lone `&` separates commands like `;` does elsewhere.
function cmdAmpersands(text) {
  const { text: st } = stripQuoted(text)
  let out = ''
  for (let i = 0; i < text.length; i++) {
    if (st[i] === '&' && st[i + 1] !== '&' && st[i - 1] !== '&' && st[i - 1] !== '>' && st[i + 1] !== '>') out += ';'
    else out += text[i]
  }
  return out
}

// --- The analysis ---------------------------------------------------------------------------------------

function decideMode(check, statements, ps) {
  const none = (reason) => ({ mode: 'none', reason })
  const st = statements[check.si]
  const seg = st.chain[check.ci]
  if (st.flags.unterminated) return none('The command has an unterminated quote, so it cannot be read reliably.')
  if (st.flags.or || st.flags.bg || st.flags.sub) return none('This compound command does not show which part decided the exit status.')

  const later = statements.slice(check.si + 1)
  const lastSegment = check.ci === st.chain.length - 1
  const earlierOnlyCd = st.chain.slice(0, check.ci).every((s) => s.kind === 'cd')
  const successOnly = (reason) => ({ mode: 'success-only', reason })

  if (ps) {
    if (seg.nativePipe) return none('The check is piped into another program, so the exit status may belong to that program.')
    if (!later.every((s) => psStatementNonNative(s.text))) return none('Another command ran after this check, so the exit status may belong to it.')
    if (!lastSegment) return successOnly('A later command in this && chain decided the exit status.')
    if (!earlierOnlyCd) return successOnly('An earlier command in this && chain may have failed instead of this check.')
    return { mode: 'exact', reason: null }
  }

  if (later.length) {
    if (later.every((s) => exitEchoSh(s.text, seg.pipe))) {
      if (!lastSegment || !earlierOnlyCd) return none('The printed exit status may belong to another command in this chain.')
      return { mode: 'echo', reason: null }
    }
    return none('A later command decided the exit status.')
  }
  if (seg.pipe) return none('The check is piped into another command, so the exit status may belong to that command.')
  if (!lastSegment) return successOnly('A later command in this && chain decided the exit status.')
  if (!earlierOnlyCd) return successOnly('An earlier command in this && chain may have failed instead of this check.')
  return { mode: 'exact', reason: null }
}

export function analyzeCommand(cmd, baseDir, customChecks, options = {}) {
  let ps = options.powershell === true
  let text = String(cmd)
  const wrapped = unwrap(text)
  if (wrapped) {
    text = wrapped.shell === 'cmd' ? cmdAmpersands(wrapped.inner) : wrapped.inner
    ps = false
  }

  const result = { checks: [], hasWatch: false, unresolvedDir: false, shell: ps ? 'powershell' : wrapped ? wrapped.shell : 'sh' }
  const { text: stripped } = stripQuoted(text)
  const statements = splitBy(text, stripped, matchStatementEnd).map((s) => parseStatement(s, ps, customChecks))

  let dir = baseDir || null
  let cdSeen = false
  statements.forEach((st, si) => {
    st.chain.forEach((seg, ci) => {
      const info = seg.interp
      if (!info) return
      if (info.type === 'unsupported-cd') {
        st.flags.sub = true
        return
      }
      if (info.type === 'cd') {
        dir = info.dir ? resolveDir(dir, info.dir) : null
        cdSeen = true
        return
      }
      let location = dir
      if (info.cwdArg) location = resolveDir(dir, info.cwdArg)
      if (!location) {
        result.unresolvedDir = true
        return
      }
      if (info.watch) result.hasWatch = true
      result.checks.push({
        si,
        ci,
        kind: info.kind,
        location,
        scope: info.scope || '',
        watch: !!info.watch,
        filtered: !!info.filtered,
        command: info.text,
        cdUsed: cdSeen,
      })
    })
  })

  for (const check of result.checks) Object.assign(check, decideMode(check, statements, ps))
  return result
}
