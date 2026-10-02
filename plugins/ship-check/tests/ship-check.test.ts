import { expect, test } from 'claude-code/testing'

const CWD = 'c:/work/app'
const STRIP = { hasSurvey: false, isWorking: false, maxRows: 3, bodyColumns: 100, scroll: { offset: 0, bodyRows: 3 }, view: {} }
const PANE = { title: 'Ship Check', isFocused: true, bodyColumns: 100, placement: 'inline', scroll: { offset: 0, bodyRows: 12 }, view: {} }

type Sim = { head: string; dirty: Record<string, string>; broken?: boolean }

// A tiny fake world beneath the plugin: a Git repo at the session directory, and what Bash printed.
function world(on: any, sim: Sim, cwd = CWD) {
  on('session.cwd', () => ({ value: cwd }))
  on('process.run', (_$: any, e: any) => {
    const argv: string[] = e.argv || []
    if (sim.broken) return { deny: 'blocked' }
    const done = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] !== 'git') return done('', 1)
    if (argv.includes('--show-toplevel')) return done(CWD + '\n')
    if (argv.includes('HEAD')) return done(sim.head + '\n')
    if (argv.includes('status')) return done(Object.keys(sim.dirty).map((p) => ' M ' + p + '\0').join(''))
    return done('')
  })
  on('fs.stat', (_$: any, e: any) => {
    if (sim.broken) return { deny: 'blocked' }
    const rel = String(e.path).replace(CWD + '/', '')
    if (!(rel in sim.dirty)) return { deny: 'missing' }
    return { value: { kind: 'file', size: sim.dirty[rel].length, mtimeMs: sim.dirty[rel].length * 1000, isLink: false } }
  })
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('ui.render', () => ({ type: 'engine', ref: 1 }))
  on('ui.close', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.start', (_$: any, e: any) => e)
}

function bash(over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { result: { stdout: 'all good', stderr: '', interrupted: false, ...over }, ...extra }
}

// What the Bash tool really returns for a non-zero exit: isError, the text, and a string result.
function failed(code: number, more = '') {
  const text = 'Exit code ' + code + '\n' + more
  return { result: 'Error: ' + text, isError: true, text }
}

async function stripText($: any) {
  const ui = await $.ui.mount({ plugin: 'ship-check', surface: 'terminal', component: 'AbovePrompt', props: STRIP })
  const texts = (await ui.findAll({ type: 'Text' })).map((t: any) => t.text)
  return texts.join(' ')
}

async function paneTexts($: any) {
  const ui = await $.ui.mount({ plugin: 'ship-check', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'ship-check' })
  return (await ui.findAll({ type: 'Text' })).map((t: any) => t.text) as string[]
}

test('a passing and a failing check show up with their real status', async ($, on) => {
  const sim: Sim = { head: 'a1', dirty: {} }
  world(on, sim)
  let n = 0
  on('tool.call', () => {
    n += 1
    return n === 1 ? bash() : failed(2, 'src/a.ts(1,1): error TS2322')
  })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'npm run typecheck' })
  const strip = await stripText($)
  expect(strip).toContain('Tests ✓')
  expect(strip).toContain('Types ✗ Failed')
  expect(strip).toContain('Build ○ Not run')
  const pane = (await paneTexts($)).join('\n')
  expect(pane).toContain('Ship Check')
  expect(pane).toContain('exit 2')
})

test('Claude saying the tests passed is not evidence: only tool results count', async ($, on) => {
  const sim: Sim = { head: 'a1', dirty: {} }
  world(on, sim)
  on('tool.call', () => bash())
  // an Edit and a prompt that claims success do not create a Passed check
  await $.tool.call({ tool: 'Edit', file_path: CWD + '/src/a.ts', old_string: 'a', new_string: 'b' })
  expect(await stripText($)).not.toContain('✓')
  const pane = (await paneTexts($)).join('\n')
  expect(pane).toContain('No checks have run yet')
})

test('an edit after a passing check makes it Stale with a clear reason', async ($, on) => {
  const sim: Sim = { head: 'a1', dirty: {} }
  world(on, sim)
  on('tool.call', () => bash())
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(await stripText($)).toContain('Tests ✓')
  await $.tool.call({ tool: 'Edit', file_path: CWD + '/src/a.ts', old_string: 'a', new_string: 'b' })
  expect(await stripText($)).toContain('Tests ↻ Stale')
  const pane = (await paneTexts($)).join('\n')
  expect(pane).toContain('Source files changed after this check completed.')
  expect(pane).toContain('Last result: Passed.')
})

test('a person editing files between turns also makes a result Stale', async ($, on) => {
  const sim: Sim = { head: 'a1', dirty: {} }
  world(on, sim)
  on('tool.call', () => bash())
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  sim.dirty['src/b.ts'] = 'edited by hand'
  await $.prompt.submit({ text: 'looks good, ship it' })
  expect(await stripText($)).toContain('Tests ↻ Stale')
})

test('files a check produces itself do not make it Stale', async ($, on) => {
  const sim: Sim = { head: 'a1', dirty: {} }
  world(on, sim)
  on('tool.call', () => {
    sim.dirty['dist/main.js'] = 'built'
    sim.dirty['coverage/lcov.info'] = 'cov'
    return bash()
  })
  await $.tool.call({ tool: 'Bash', command: 'npm run build' })
  await $.prompt.submit({ text: 'next' })
  expect(await stripText($)).toContain('Build ✓')
})

test('no reliable result means Unknown, never Passed', async ($, on) => {
  const sim: Sim = { head: 'a1', dirty: {} }
  world(on, sim)
  let mode = 0
  on('tool.call', () => {
    mode += 1
    if (mode === 1) return bash() // piped, so the status belongs to `tail`
    if (mode === 2) return bash({ backgroundTaskId: 'bg-1' })
    return { result: {} } // the tool reported nothing useful
  })
  await $.tool.call({ tool: 'Bash', command: 'npm test | tail -5' })
  expect(await stripText($)).toContain('Tests ? Unknown')
  await $.tool.call({ tool: 'Bash', command: 'npm run build' })
  expect(await stripText($)).toContain('Build ? Unknown')
  await $.tool.call({ tool: 'Bash', command: 'npm run typecheck' })
  const strip = await stripText($)
  expect(strip).toContain('Types ? Unknown')
  expect(strip).not.toContain('✓')
})

test('watch mode is never shown as Passed', async ($, on) => {
  const sim: Sim = { head: 'a1', dirty: {} }
  world(on, sim)
  on('tool.call', () => bash())
  await $.tool.call({ tool: 'Bash', command: 'npm test -- --watch' })
  const pane = (await paneTexts($)).join('\n')
  expect(pane).toContain('Watch mode does not finish on its own')
  expect(await stripText($)).not.toContain('Tests ✓')
})

test('the same check in two project locations is recorded separately', async ($, on) => {
  const sim: Sim = { head: 'a1', dirty: {} }
  world(on, sim)
  let n = 0
  on('tool.call', () => {
    n += 1
    return n === 1 ? bash() : failed(1)
  })
  await $.tool.call({ tool: 'Bash', command: 'cd packages/a && npm test' })
  await $.tool.call({ tool: 'Bash', command: 'cd packages/b && npm test' })
  const pane = await paneTexts($)
  const joined = pane.join('\n')
  expect(joined).toContain('./packages/a')
  expect(joined).toContain('./packages/b')
  expect(pane.filter((t) => t === '✓ Passed')).toHaveLength(1)
  expect(pane.filter((t) => t === '✗ Failed')).toHaveLength(1)
})

test('results survive a reload of the mod, and an unfinished check settles to Unknown', async ($, on) => {
  const sim: Sim = { head: 'a1', dirty: {} }
  world(on, sim)
  on('tool.call', () => bash())
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(await stripText($)).toContain('Tests ✓')
  // session.start runs again after every hot reload; state kept in $.state must still be there
  await $.session.start({ cwd: CWD })
  expect(await stripText($)).toContain('Tests ✓')
})

test('if the mod itself fails, the tool call still goes through', async ($, on) => {
  const sim: Sim = { head: 'a1', dirty: {}, broken: true }
  world(on, sim)
  on('tool.call', () => bash({ stdout: 'tool output survived' }))
  const result: any = await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(result.result.stdout).toBe('tool output survived')
})

test('the panel and the Prepare checks button use English text and fill the prompt box', async ($, on) => {
  const sim: Sim = { head: 'a1', dirty: {} }
  world(on, sim)
  on('tool.call', () => bash())
  let filled = ''
  on('prompt.fill', (_$: any, e: any) => {
    filled = e.text
    return { isFilled: true }
  })
  on('fs.read', () => ({ deny: 'no package.json' }))
  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Edit', file_path: CWD + '/src/a.ts', old_string: 'a', new_string: 'b' })
  const ui = await $.ui.mount({ plugin: 'ship-check', surface: 'terminal', component: 'Pane', props: PANE, requestId: 'ship-check' })
  const buttons = (await ui.findAll({ type: 'Button' })).map((b: any) => b.props.label)
  expect(buttons).toContain('View output')
  expect(buttons).toContain('Prepare checks')
  await ui.press({ key: 'prepare' })
  expect(filled).toContain('npm test')
  expect(filled).toContain('re-run these checks')
})

test('the PowerShell tool is observed like Bash, including the exit-status echo', async ($, on) => {
  const sim: Sim = { head: 'a1', dirty: {} }
  world(on, sim)
  let n = 0
  on('tool.call', () => {
    n += 1
    return n === 1 ? bash({ stdout: '1 passed\nEXIT: 0' }) : failed(2, 'boom\nEXIT: 2')
  })
  await $.tool.call({ tool: 'PowerShell', command: 'npm test; "EXIT: $LASTEXITCODE"' })
  await $.tool.call({ tool: 'PowerShell', command: 'npm run typecheck; "EXIT: $LASTEXITCODE"' })
  const strip = await stripText($)
  expect(strip).toContain('Tests ✓')
  expect(strip).toContain('Types ✗ Failed')
})

test('PowerShell: Set-Location with ;, if blocks and pipelines into cmdlets all give real results', async ($, on) => {
  const sim: Sim = { head: 'a1', dirty: {} }
  world(on, sim)
  const results = [bash(), failed(2), bash()]
  let n = 0
  on('tool.call', () => results[n++])
  await $.tool.call({ tool: 'PowerShell', command: 'Set-Location pkg; npm test' })
  await $.tool.call({ tool: 'PowerShell', command: 'npm run typecheck; if ($?) { "ok" } else { "not ok" }' })
  await $.tool.call({ tool: 'PowerShell', command: 'npm run build | Select-Object -Last 1' })
  const strip = await stripText($)
  expect(strip).toContain('Tests ✓')
  expect(strip).toContain('Types ✗ Failed')
  expect(strip).toContain('Build ✓')
  // the Set-Location run is a different location from the other two
  const pane = (await paneTexts($)).join('\n')
  expect(pane).toContain('./pkg')
})

test('a command run by a tool Ship Check does not know is shown as Unknown, not ignored', async ($, on) => {
  const sim: Sim = { head: 'a1', dirty: {} }
  world(on, sim)
  on('tool.call', () => ({ result: 'started in another terminal' }))
  await $.tool.call({ tool: 'FutureShell', command: 'npm test' })
  const strip = await stripText($)
  expect(strip).toContain('Tests ? Unknown')
  const pane = (await paneTexts($)).join('\n')
  expect(pane).toContain('FutureShell')
  expect(pane).toContain('cannot read results from')
})
