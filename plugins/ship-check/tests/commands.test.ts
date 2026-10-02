import { expect, test } from 'claude-code/testing'
import { parseCustomChecks, tokenizeChain } from '../hooks/lib/commands.js'
import { analyzeCommand } from '../hooks/lib/analyze.js'
import { summaryLine, classifyOutcome, applyEdit, beginRecord, finishRecord, emptyLedger, isTrackedPath, displayStatus, staleReasonFor, settleRunning } from '../hooks/lib/model.js'
import { normalizePath, resolveDir, displayLocation } from '../hooks/lib/paths.js'

const CWD = 'c:/work/app'

function analyze(cmd: string, options: any = {}, custom: any[] = []) {
  return analyzeCommand(cmd, CWD, custom, options)
}

function kinds(cmd: string, options: any = {}, custom: any[] = []) {
  return analyze(cmd, options, custom).checks.map((c: any) => c.kind + '@' + c.location + (c.scope ? '#' + c.scope : ''))
}

// What the tools really return (measured in real sessions).
const OK = (stdout = '1 passed') => ({ result: { stdout, stderr: '', interrupted: false } })
const FAIL = (code = 2, more = 'boom') => {
  const text = 'Exit code ' + code + '\n' + more
  return { result: 'Error: ' + text, isError: true, text }
}

// Runs one command through the analysis and classifies the first check against an outcome.
function verdict(cmd: string, outcome: any, options: any = {}, which = 0) {
  const parsed = analyze(cmd, options)
  return classifyOutcome(parsed, parsed.checks[which], outcome)
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
  expect(kinds('$out = Get-Content x', { powershell: true })).toEqual([])
})

test('follows cd and package-manager directory flags into separate locations', () => {
  expect(kinds('cd packages/a && npm test')).toEqual(['test@c:/work/app/packages/a'])
  expect(kinds('npm --prefix packages/b test')).toEqual(['test@c:/work/app/packages/b'])
  expect(kinds('pnpm -C packages/c run build')).toEqual(['build@c:/work/app/packages/c'])
  expect(kinds('yarn --cwd packages/d test')).toEqual(['test@c:/work/app/packages/d'])
  expect(kinds('npm test -w web')).toEqual(['test@c:/work/app#web'])
  expect(kinds('pnpm --filter api test')).toEqual(['test@c:/work/app#api'])
  expect(kinds('Set-Location pkg; npm test', { powershell: true })).toEqual(['test@c:/work/app/pkg'])
  expect(kinds('cd pkg; npm test')).toEqual(['test@c:/work/app/pkg'])
})

test('tokenizeChain still marks compound forms', () => {
  expect(tokenizeChain('npm test | tail -5').simple).toBe(false)
  expect(tokenizeChain('npm test || true').simple).toBe(false)
  expect(tokenizeChain('npm test &').simple).toBe(false)
  expect(tokenizeChain('npm test 2>&1').simple).toBe(true)
  expect(tokenizeChain('cd app && npm test && npm run build').simple).toBe(true)
  expect(tokenizeChain('echo "a | b" && npm test').simple).toBe(true)
})

test('detects watch mode', () => {
  expect(analyze('npm test -- --watch').hasWatch).toBe(true)
  expect(analyze('npx vitest').hasWatch).toBe(true)
  expect(analyze('npx vitest run').hasWatch).toBe(false)
  expect(verdict('npm test -- --watch', OK()).status).toBe('unknown')
})

test('reads custom checks from configuration', () => {
  const custom = parseCustomChecks(['lint=npm run lint', 'bad line', 'Make = make  check'])
  expect(custom).toEqual([
    { kind: 'lint', command: 'npm run lint' },
    { kind: 'make', command: 'make check' },
  ])
  expect(kinds('npm run lint', {}, custom)).toEqual(['lint@c:/work/app'])
  expect(kinds('make check', {}, custom)).toEqual(['make@c:/work/app'])
})

test('normalizes Windows and Git Bash spellings to one path', () => {
  expect(normalizePath('C:\\Users\\me\\app')).toBe('c:/Users/me/app')
  expect(normalizePath('/c/Users/me/app')).toBe('c:/Users/me/app')
  expect(resolveDir('c:/work/app', '../other')).toBe('c:/work/other')
  expect(resolveDir('c:/work/app', '~/x')).toBe(null)
})

// --- Bash -------------------------------------------------------------------------------------------

test('Bash: only a reliable tool result becomes Passed or Failed', () => {
  expect(verdict('npm test', OK()).status).toBe('passed')
  expect(verdict('npm test', FAIL(1))).toMatchObject({ status: 'failed', exitCode: 1 })
  expect(verdict('npm test', undefined).status).toBe('unknown')
  expect(verdict('npm test', { result: {} }).status).toBe('unknown')
  expect(verdict('npm test', { isError: true, text: 'Error: something odd', result: 'Error: something odd' }).status).toBe('unknown')
  expect(verdict('npm test', { result: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b1' } }).status).toBe('unknown')
  expect(verdict('npm test', { result: { stdout: '', stderr: '', interrupted: true } }).status).toBe('unknown')
  expect(verdict('npm test', { result: { stdout: '', stderr: '', interrupted: false, timedOutAfterMs: 5000 } }).status).toBe('unknown')
})

test('Bash: pipes, ||, background jobs and later commands hide the real exit status', () => {
  expect(verdict('npm test | tail -5', OK()).status).toBe('unknown')
  expect(verdict('npm test || true', OK()).status).toBe('unknown')
  expect(verdict('npm test &', OK()).status).toBe('unknown')
  expect(verdict('npm test; echo done', OK()).status).toBe('unknown')
  expect(verdict('npm test; npm run build', OK(), {}, 0).status).toBe('unknown')
  // the last command in a ; list decides the status, so it is trusted
  expect(verdict('npm test; npm run build', OK(), {}, 1).status).toBe('passed')
  expect(verdict('npm test; npm run typecheck', FAIL(2), {}, 1)).toMatchObject({ status: 'failed', exitCode: 2 })
  expect(verdict('cd app; npm test', FAIL(1))).toMatchObject({ status: 'failed', exitCode: 1 })
})

test('Bash: a failure in an && chain is only blamed on the check when nothing but cd came before it', () => {
  expect(verdict('cd app && npm test', FAIL(1))).toMatchObject({ status: 'failed', exitCode: 1 })
  expect(verdict('npm test && npm run build', FAIL(1), {}, 0).status).toBe('unknown')
  expect(verdict('npm test && npm run build', OK(), {}, 0).status).toBe('passed')
  // a failed earlier command must not be reported as a failed check that never ran
  expect(verdict('git pull && npm test', FAIL(1, 'fatal: not a git repository')).status).toBe('unknown')
  expect(verdict('git pull && npm test', OK()).status).toBe('passed')
})

test('Bash: the shell printing its own exit status is read from the output', () => {
  const echo = 'npm test; echo "EXIT: $?"'
  expect(analyze(echo).checks[0].mode).toBe('echo')
  expect(verdict(echo, OK('1 passed\nEXIT: 0')).status).toBe('passed')
  expect(verdict(echo, OK('boom\nEXIT: 2'))).toMatchObject({ status: 'failed', exitCode: 2 })
  expect(verdict(echo, OK('no status line')).status).toBe('unknown')
  // after a pipeline only PIPESTATUS[0] belongs to the check
  expect(verdict('npm test | tail -3; echo "EXIT: ${PIPESTATUS[0]}"', OK('x\nEXIT: 1'))).toMatchObject({ status: 'failed', exitCode: 1 })
  expect(verdict('npm test | tail -3; echo "EXIT: $?"', OK('x\nEXIT: 0')).status).toBe('unknown')
})

test('Bash: a cd that fails does not give a result for the wrong directory', () => {
  const out = { ...OK(), text: 'bash: cd: nope: No such file or directory\n1 passed' }
  expect(verdict('cd nope; npm test', out).status).toBe('unknown')
  expect(verdict('cd nope; npm test', OK()).status).toBe('passed')
})

// --- PowerShell -----------------------------------------------------------------------------------

test('PowerShell: the tool reports the exit status of the last native program', () => {
  const ps = { powershell: true }
  // all of these were measured against the real PowerShell tool
  expect(verdict('npm run typecheck', FAIL(2), ps)).toMatchObject({ status: 'failed', exitCode: 2 })
  expect(verdict('Set-Location pkg; npm run typecheck', FAIL(2), ps)).toMatchObject({ status: 'failed', exitCode: 2 })
  expect(verdict('Set-Location pkg; npm test', OK(), ps).status).toBe('passed')
  expect(verdict('npm run typecheck; if ($?) { "ok" } else { "not ok" }', FAIL(2), ps)).toMatchObject({ status: 'failed', exitCode: 2 })
  expect(verdict('npm run typecheck; if ($LASTEXITCODE -ne 0) { Write-Output "failed" }', FAIL(2), ps)).toMatchObject({ status: 'failed', exitCode: 2 })
  expect(verdict('npm run typecheck; Write-Output done', FAIL(2), ps)).toMatchObject({ status: 'failed', exitCode: 2 })
  expect(verdict('npm test; "EXIT: $LASTEXITCODE"', OK('1 passed\nEXIT: 0'), ps).status).toBe('passed')
  expect(verdict('npm test; "EXIT: $LASTEXITCODE"', FAIL(2, 'EXIT: 2'), ps)).toMatchObject({ status: 'failed', exitCode: 2 })
})

test('PowerShell: a pipeline into cmdlets keeps the native exit status, a pipeline into a program does not', () => {
  const ps = { powershell: true }
  expect(verdict('npm run typecheck | Select-Object -Last 1', FAIL(2), ps)).toMatchObject({ status: 'failed', exitCode: 2 })
  expect(verdict('npm test | Select-Object -Last 1', OK(), ps).status).toBe('passed')
  expect(verdict('npm test 2>&1 | Out-String', OK(), ps).status).toBe('passed')
  expect(verdict('npm test | findstr passed', OK(), ps).status).toBe('unknown')
  expect(verdict('npm test | node filter.js', OK(), ps).status).toBe('unknown')
})

test('PowerShell: a later native command takes over the exit status', () => {
  const ps = { powershell: true }
  expect(verdict('npm test; npm run typecheck', FAIL(2), ps, 0).status).toBe('unknown')
  expect(verdict('npm test; npm run typecheck', FAIL(2), ps, 1)).toMatchObject({ status: 'failed', exitCode: 2 })
  expect(verdict('npm run typecheck; npm test', OK(), ps, 0).status).toBe('unknown')
  expect(verdict('npm run typecheck; npm test', OK(), ps, 1).status).toBe('passed')
  expect(verdict('npm test; node other.js', OK(), ps).status).toBe('unknown')
  expect(verdict('npm test; $x = npm -v', OK(), ps).status).toBe('unknown')
  expect(verdict('npm test; if ($?) { npm run build }', OK(), ps).status).toBe('unknown')
  expect(verdict('npm test; Invoke-Expression "npm run build"', OK(), ps).status).toBe('unknown')
})

test('PowerShell 7: && and || chains', () => {
  const ps = { powershell: true }
  expect(verdict('cd pkg && npm test', FAIL(1), ps)).toMatchObject({ status: 'failed', exitCode: 1 })
  expect(verdict('npm run build && npm test', FAIL(1), ps, 1).status).toBe('unknown')
  expect(verdict('npm run build && npm test', OK(), ps, 1).status).toBe('passed')
  expect(verdict('npm test || Write-Host failed', OK(), ps).status).toBe('unknown')
  expect(kinds('Set-Location pkg && npm test', ps)).toEqual(['test@c:/work/app/pkg'])
})

test('PowerShell: a Set-Location that failed is not trusted', () => {
  const out = { ...OK(), text: "Set-Location : Cannot find path 'C:\\nope' because it does not exist.\n1 passed" }
  expect(verdict('Set-Location nope; npm test', out, { powershell: true }).status).toBe('unknown')
})

// --- cmd.exe and other wrappers -----------------------------------------------------------------

test('cmd.exe: cmd /c wrappers are looked through', () => {
  expect(kinds('cmd /c "npm run typecheck"')).toEqual(['typecheck@c:/work/app'])
  expect(kinds('cmd.exe /d /s /c "cd pkg && npm test"')).toEqual(['test@c:/work/app/pkg'])
  expect(kinds('cmd /c npm test')).toEqual(['test@c:/work/app'])
  expect(verdict('cmd /c "npm run typecheck"', FAIL(2))).toMatchObject({ status: 'failed', exitCode: 2 })
  expect(verdict('cmd /c npm test', OK()).status).toBe('passed')
  // in cmd a lone & runs the next command regardless, so the last one decides the status
  expect(verdict('cmd /c "npm test & npm run build"', OK(), {}, 0).status).toBe('unknown')
  expect(verdict('cmd /c "npm test & npm run build"', OK(), {}, 1).status).toBe('passed')
  // cmd /c "x" && y is the outer shell's chain, not a wrapper
  expect(kinds('cmd /c "echo hi" && npm test')).toEqual(['test@c:/work/app'])
  expect(kinds('bash -c "npm test"')).toEqual(['test@c:/work/app'])
})

test('a tool Ship Check cannot read is shown as Unknown with the reason', () => {
  const parsed: any = analyze('npm test')
  parsed.untrustedTool = 'RunShell'
  const out = classifyOutcome(parsed, parsed.checks[0], OK())
  expect(out.status).toBe('unknown')
  expect(out.reason).toContain('RunShell')
})

// --- Staleness (unchanged) ---------------------------------------------------------------------

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

test('the project folder is shown by name, sub-folders relative to it', () => {
  expect(displayLocation('c:/work/app', 'c:/work/app')).toBe('app')
  expect(displayLocation('c:/work/app/packages/a', 'c:/work/app')).toBe('./packages/a')
  expect(displayLocation('c:/elsewhere/x', 'c:/work/app')).toBe('c:/elsewhere/x')
})

test('checks that ran in one command say the time is for the whole command', () => {
  const rec = { startedAt: 1000, endedAt: 3300, exitCode: 0, together: 3 }
  expect(summaryLine(rec)).toContain('2.3s for the whole command')
  expect(summaryLine({ ...rec, together: 1 })).not.toContain('whole command')
  // a record saved before this field existed
  expect(summaryLine({ startedAt: 1000, endedAt: 3300, exitCode: 0 })).not.toContain('whole command')
})
