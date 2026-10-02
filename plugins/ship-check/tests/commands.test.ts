import { expect, test } from 'claude-code/testing'
import { analyzeCommand, parseCustomChecks, tokenizeChain } from '../hooks/lib/commands.js'
import { classifyOutcome, applyEdit, beginRecord, finishRecord, emptyLedger, isTrackedPath, displayStatus, staleReasonFor, settleRunning } from '../hooks/lib/model.js'
import { normalizePath, resolveDir } from '../hooks/lib/paths.js'

const CWD = 'c:/work/app'

function kinds(cmd: string, custom = []) {
  return analyzeCommand(cmd, CWD, custom).checks.map((c: any) => c.kind + '@' + c.location + (c.scope ? '#' + c.scope : ''))
}

test('recognizes npm, pnpm, yarn and bun check commands', () => {
  expect(kinds('npm test')).toEqual(['test@c:/work/app'])
  expect(kinds('npm run build')).toEqual(['build@c:/work/app'])
  expect(kinds('npm run typecheck')).toEqual(['typecheck@c:/work/app'])
  expect(kinds('pnpm test')).toEqual(['test@c:/work/app'])
  expect(kinds('pnpm build')).toEqual(['build@c:/work/app'])
  expect(kinds('pnpm run type-check')).toEqual(['typecheck@c:/work/app'])
  expect(kinds('yarn test')).toEqual(['test@c:/work/app'])
  expect(kinds('yarn typecheck')).toEqual(['typecheck@c:/work/app'])
  expect(kinds('bun test')).toEqual(['test@c:/work/app'])
  expect(kinds('bun run build')).toEqual(['build@c:/work/app'])
  expect(kinds('npx tsc --noEmit')).toEqual(['typecheck@c:/work/app'])
  expect(kinds('CI=1 npm test')).toEqual(['test@c:/work/app'])
})

test('ignores commands that are not checks', () => {
  expect(kinds('npm install')).toEqual([])
  expect(kinds('git status')).toEqual([])
  expect(kinds('npm run dev')).toEqual([])
  expect(kinds('ls -la')).toEqual([])
})

test('follows cd and package-manager directory flags into separate locations', () => {
  expect(kinds('cd packages/a && npm test')).toEqual(['test@c:/work/app/packages/a'])
  expect(kinds('npm --prefix packages/b test')).toEqual(['test@c:/work/app/packages/b'])
  expect(kinds('pnpm -C packages/c run build')).toEqual(['build@c:/work/app/packages/c'])
  expect(kinds('yarn --cwd packages/d test')).toEqual(['test@c:/work/app/packages/d'])
  expect(kinds('npm test -w web')).toEqual(['test@c:/work/app#web'])
  expect(kinds('pnpm --filter api test')).toEqual(['test@c:/work/app#api'])
})

test('treats pipes, semicolons and background jobs as compound', () => {
  expect(tokenizeChain('npm test | tail -5').simple).toBe(false)
  expect(tokenizeChain('npm test; echo done').simple).toBe(false)
  expect(tokenizeChain('npm test || true').simple).toBe(false)
  expect(tokenizeChain('npm test &').simple).toBe(false)
  expect(tokenizeChain('npm test 2>&1').simple).toBe(true)
  expect(tokenizeChain('cd app && npm test && npm run build').simple).toBe(true)
  expect(tokenizeChain('echo "a | b" && npm test').simple).toBe(true)
})

test('detects watch mode', () => {
  expect(analyzeCommand('npm test -- --watch', CWD, []).hasWatch).toBe(true)
  expect(analyzeCommand('npx vitest', CWD, []).hasWatch).toBe(true)
  expect(analyzeCommand('npx vitest run', CWD, []).hasWatch).toBe(false)
  expect(analyzeCommand('npm test', CWD, []).hasWatch).toBe(false)
})

test('reads custom checks from configuration', () => {
  const custom = parseCustomChecks(['lint=npm run lint', 'bad line', 'Make = make  check'])
  expect(custom).toEqual([
    { kind: 'lint', command: 'npm run lint' },
    { kind: 'make', command: 'make check' },
  ])
  expect(kinds('npm run lint', custom)).toEqual(['lint@c:/work/app'])
  expect(kinds('make check', custom)).toEqual(['make@c:/work/app'])
})

test('normalizes Windows and Git Bash spellings to one path', () => {
  expect(normalizePath('C:\\Users\\me\\app')).toBe('c:/Users/me/app')
  expect(normalizePath('/c/Users/me/app')).toBe('c:/Users/me/app')
  expect(resolveDir('c:/work/app', '../other')).toBe('c:/work/other')
  expect(resolveDir('c:/work/app', '~/x')).toBe(null)
})

function outcome(over: any = {}) {
  return { result: { stdout: 'ok', stderr: '', interrupted: false }, ...over }
}

test('only a reliable tool result becomes Passed or Failed', () => {
  const parsed = analyzeCommand('npm test', CWD, [])
  const check = parsed.checks[0]
  expect(classifyOutcome(parsed, check, outcome()).status).toBe('passed')
  expect(classifyOutcome(parsed, check, outcome({ isError: true, text: 'Exit code 1\nboom' }))).toMatchObject({ status: 'failed', exitCode: 1 })
  // no result, no status flags, background, interruption, compound: all Unknown
  expect(classifyOutcome(parsed, check, { isError: true, text: 'Error: something odd', result: 'Error: something odd' }).status).toBe('unknown')
  expect(classifyOutcome(parsed, check, undefined).status).toBe('unknown')
  expect(classifyOutcome(parsed, check, { result: {} }).status).toBe('unknown')
  expect(classifyOutcome(parsed, check, outcome({ result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } })).status).toBe('unknown')
  expect(classifyOutcome(parsed, check, outcome({ result: { stdout: '', stderr: '', interrupted: true } })).status).toBe('unknown')
  expect(classifyOutcome(parsed, check, outcome({ result: { stdout: '', stderr: '', interrupted: false, timedOutAfterMs: 5000 } })).status).toBe('unknown')
  const piped = analyzeCommand('npm test | tail -5', CWD, [])
  expect(classifyOutcome(piped, piped.checks[0], outcome()).status).toBe('unknown')
  const watch = analyzeCommand('npm test -- --watch', CWD, [])
  expect(classifyOutcome(watch, watch.checks[0], outcome()).status).toBe('unknown')
})

test('a failure inside an && chain is only attributed when the check is the last command', () => {
  const last = analyzeCommand('cd app && npm test', CWD, [])
  expect(classifyOutcome(last, last.checks[0], outcome({ isError: true, text: 'Exit code 1' })).status).toBe('failed')
  const first = analyzeCommand('npm test && npm run build', CWD, [])
  expect(classifyOutcome(first, first.checks[0], outcome({ isError: true, text: 'Exit code 1' })).status).toBe('unknown')
  expect(classifyOutcome(first, first.checks[0], outcome()).status).toBe('passed')
})

test('files that checks produce, and dependency folders, never count as changes', () => {
  expect(isTrackedPath('src/a.ts', [])).toBe(true)
  expect(isTrackedPath('node_modules/x/index.js', [])).toBe(false)
  expect(isTrackedPath('dist/main.js', [])).toBe(false)
  expect(isTrackedPath('coverage/lcov.info', [])).toBe(false)
  expect(isTrackedPath('tsconfig.tsbuildinfo', [])).toBe(false)
  expect(isTrackedPath('generated/x.ts', ['generated'])).toBe(false)
})

test('stale reasons are written in plain English', () => {
  expect(staleReasonFor(['source'])).toBe('Source files changed after this check completed.')
  expect(staleReasonFor(['dependency'])).toBe('Dependency files changed after this check completed.')
  expect(staleReasonFor(['source', 'config'])).toBe('Source and configuration files changed after this check completed.')
  expect(staleReasonFor(['source'], 'running')).toBe('Source files changed while this check was running.')
})

function finished(status: 'passed' | 'failed', location = CWD) {
  const check = { kind: 'test', location, scope: '', command: 'npm test', filtered: false }
  let ledger = beginRecord(emptyLedger(), check, { hash: 'a', count: 1, partial: false }, location, 1000)
  ledger = finishRecord(ledger, location + '|test|', 1000, { status, reason: null, exitCode: 0, summary: 'x', endSig: { hash: 'a', count: 1, partial: false }, now: 2000 })
  return ledger
}

test('an edit after a check completes makes it Stale, and edits elsewhere do not', () => {
  const ledger = finished('passed')
  expect(displayStatus(Object.values(ledger.records)[0] as any).status).toBe('Passed')
  const other = applyEdit(ledger, 'c:/elsewhere/a.ts', 3000, [])
  expect(displayStatus(Object.values(other.records)[0] as any).status).toBe('Passed')
  const ignored = applyEdit(ledger, 'c:/work/app/node_modules/x.js', 3000, [])
  expect(displayStatus(Object.values(ignored.records)[0] as any).status).toBe('Passed')
  const edited = applyEdit(ledger, 'C:\\work\\app\\src\\a.ts', 3000, [])
  const shown = displayStatus(Object.values(edited.records)[0] as any)
  expect(shown.status).toBe('Stale')
  expect(shown.detail).toBe('Source files changed after this check completed.')
})

test('a change while the check runs prevents a clean Passed', () => {
  const check = { kind: 'test', location: CWD, scope: '', command: 'npm test', filtered: false }
  let ledger = beginRecord(emptyLedger(), check, { hash: 'a', count: 1, partial: false }, CWD, 1000)
  ledger = applyEdit(ledger, 'c:/work/app/src/a.ts', 1500, [])
  ledger = finishRecord(ledger, CWD + '|test|', 1000, { status: 'passed', reason: null, exitCode: 0, summary: '', endSig: { hash: 'a', count: 1, partial: false }, now: 2000 })
  const shown = displayStatus(Object.values(ledger.records)[0] as any)
  expect(shown.status).toBe('Stale')
  expect(shown.detail).toBe('Source files changed while this check was running.')
})

test('the ledger survives a JSON round trip, and a Running record settles to Unknown after a reload', () => {
  const check = { kind: 'build', location: CWD, scope: '', command: 'npm run build', filtered: false }
  const running = beginRecord(emptyLedger(), check, { hash: 'a', count: 1, partial: false }, CWD, 1000)
  const revived = JSON.parse(JSON.stringify(running))
  expect(revived).toEqual(running)
  const settled = settleRunning(revived)
  expect(displayStatus(Object.values(settled.records)[0] as any).status).toBe('Unknown')
})

function psChecks(cmd: string) {
  return analyzeCommand(cmd, CWD, [], { powershell: true })
}

test('PowerShell: the exit-status echo that Claude appends is understood', () => {
  const parsed = psChecks('npm test; "EXIT: $LASTEXITCODE"')
  expect(parsed.checks.map((c: any) => c.kind)).toEqual(['test'])
  expect(parsed.exitEcho).toBe(true)
  expect(classifyOutcome(parsed, parsed.checks[0], { result: { stdout: '1 passed\nEXIT: 0', stderr: '', interrupted: false } }).status).toBe('passed')
  expect(classifyOutcome(parsed, parsed.checks[0], { result: { stdout: 'boom\nEXIT: 2', stderr: '', interrupted: false } })).toMatchObject({ status: 'failed', exitCode: 2 })
  // the status line cannot be read: never Passed
  expect(classifyOutcome(parsed, parsed.checks[0], { result: { stdout: 'no status here', stderr: '', interrupted: false } }).status).toBe('unknown')
})

test('PowerShell: a plain command and a pipeline', () => {
  expect(psChecks('npm run typecheck').checks.map((c: any) => c.kind)).toEqual(['typecheck'])
  const piped = psChecks('npm test | Select-Object -Last 1')
  expect(piped.simple).toBe(false)
  expect(classifyOutcome(piped, piped.checks[0], { result: { stdout: '1 passed', stderr: '', interrupted: false } }).status).toBe('unknown')
  // other statements after the check are not an exit-status echo
  const other = psChecks('npm test; Remove-Item x')
  expect(other.simple).toBe(false)
})

test('PowerShell: backslash paths are kept and a trailing echo of something else is not trusted', () => {
  expect(psChecks('cd C:\\work\\app\\pkg && npm test').checks[0].location).toBe('c:/work/app/pkg')
  expect(psChecks('npm test; "done"').exitEcho).toBe(false)
})
