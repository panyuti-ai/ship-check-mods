// Builds the element trees for the status line and the Ship Check pane.
// `els` is what `$.ui.resolve(e)` returned: { Box, Text, Button, ... }. No Claude Code API is called here.

import { displayStatus, STATUS, ICONS, STATUS_COLORS, kindSummary, summaryLine } from './model.js'
import { kindLabel, DEFAULT_KINDS } from './commands.js'
import { displayLocation } from './paths.js'

const OUTPUT_LINES = 14

function statusText(Text, status, key) {
  const props = { key, children: [ICONS[status] + ' ' + status] }
  const color = STATUS_COLORS[status]
  if (color) props.color = color
  return Text(props)
}

// "Tests ✓ | Types ↻ Stale | Build ○ Not run"
export function buildStrip(els, ledger, cwd, customKinds, onOpen) {
  const { Box, Text, Button } = els
  const items = kindSummary(ledger, cwd, customKinds)
  const children = []
  items.forEach((item, i) => {
    if (i > 0) children.push(Text({ key: 'sep-' + i, dimColor: true, children: ['|'] }))
    const color = STATUS_COLORS[item.status]
    const mark = item.status === STATUS.PASSED ? ICONS[item.status] : ICONS[item.status] + ' ' + item.status
    const parts = [Text({ key: 'l-' + item.kind, children: [item.label] })]
    const markProps = { key: 'm-' + item.kind, children: [mark] }
    if (color) markProps.color = color
    parts.push(Text(markProps))
    children.push(Box({ key: 'k-' + item.kind, flexDirection: 'row', columnGap: 1, children: parts }))
  })
  // A button, because some apps do not offer a command that a mod registers.
  if (onOpen) children.push(Button({ key: 'open', label: 'Details', plain: true, onPress: onOpen }))
  return Box({ flexDirection: 'row', columnGap: 1, children })
}

function outputBlock(els, record, key) {
  const { Box, Text } = els
  const lines = (record.summary || '').split('\n')
  const shown = lines.slice(-OUTPUT_LINES)
  const children = []
  if (!record.summary) children.push(Text({ key: key + '-none', dimColor: true, children: ['No output was captured.'] }))
  else {
    if (lines.length > shown.length) children.push(Text({ key: key + '-cut', dimColor: true, children: ['… showing the last ' + shown.length + ' lines'] }))
    shown.forEach((line, i) => children.push(Text({ key: key + '-o' + i, dimColor: true, wrap: 'truncate-end', children: [line === '' ? ' ' : line] })))
  }
  return Box({ key: key + '-out', flexDirection: 'column', paddingLeft: 2, children })
}

function recordRows(els, record, cwd, expanded, onToggle) {
  const { Box, Text, Button } = els
  const shown = displayStatus(record)
  const key = record.key
  const rows = []

  const head = [Text({ key: key + '-label', bold: true, children: [kindLabel(record.kind)] }), statusText(Text, shown.status, key + '-st')]
  const when = summaryLine(record)
  if (when) head.push(Text({ key: key + '-when', dimColor: true, children: [when] }))
  rows.push(Box({ key: key + '-head', flexDirection: 'row', columnGap: 2, children: head }))

  const where = displayLocation(record.location, cwd) + (record.scope ? ' · ' + record.scope : '')
  rows.push(Text({ key: key + '-cmd', dimColor: true, wrap: 'truncate-end', children: ['  ' + record.command + '  ·  ' + where] }))

  if (shown.detail) rows.push(Text({ key: key + '-why', children: ['  ' + shown.detail] }))
  if (shown.status === STATUS.STALE) {
    const files = (record.staleFiles || []).slice(0, 3)
    const tail = files.length ? ' Changed: ' + files.join(', ') + ((record.staleFiles || []).length > files.length ? ', …' : '') : ''
    rows.push(Text({ key: key + '-last', dimColor: true, children: ['  Last result: ' + shown.last + '.' + tail] }))
  }
  if (record.filtered && (shown.status === STATUS.PASSED || shown.status === STATUS.FAILED || shown.status === STATUS.STALE)) {
    rows.push(Text({ key: key + '-filter', dimColor: true, children: ['  This run passed extra arguments, so it may not cover everything.'] }))
  }

  if (record.summary || shown.status !== STATUS.RUNNING) {
    const open = expanded === key
    rows.push(
      Button({
        key: 'out-' + key,
        label: open ? 'Hide output' : 'View output',
        onPress: () => onToggle(key),
      }),
    )
    if (open) rows.push(outputBlock(els, record, key))
  }
  return Box({ key: key + '-card', flexDirection: 'column', children: rows })
}

function notRunRow(els, kind) {
  const { Box, Text } = els
  return Box({
    key: 'nr-' + kind,
    flexDirection: 'row',
    columnGap: 2,
    children: [Text({ key: 'nr-l-' + kind, bold: true, children: [kindLabel(kind)] }), statusText(Text, STATUS.NOT_RUN, 'nr-s-' + kind)],
  })
}

export function buildPane(els, { ledger, cwd, expanded, customKinds, onToggle, onPrepare }) {
  const { Box, Text, Button } = els
  const records = Object.values(ledger.records).sort(
    (a, b) => a.location.localeCompare(b.location) || a.kind.localeCompare(b.kind) || a.scope.localeCompare(b.scope),
  )
  const children = [Text({ key: 'title', bold: true, children: ['Ship Check'] })]

  if (records.length === 0) {
    children.push(Text({ key: 'empty', children: ['No checks have run yet. Ask Claude to run your tests, type check, or build.'] }))
  }

  let lastLocation = null
  for (const record of records) {
    if (record.location !== lastLocation) {
      children.push(Text({ key: 'loc-' + record.location, dimColor: true, children: [' '] }))
      children.push(Text({ key: 'locn-' + record.location, dimColor: true, children: [displayLocation(record.location, cwd)] }))
      lastLocation = record.location
    }
    children.push(recordRows(els, record, cwd, expanded, onToggle))
  }

  // Default kinds nobody has run near the current directory.
  const kinds = [...DEFAULT_KINDS, ...(customKinds || []).filter((k) => !DEFAULT_KINDS.includes(k))]
  const missing = kindSummary(ledger, cwd, customKinds).filter((s) => !s.record && kinds.includes(s.kind))
  if (missing.length) {
    children.push(Text({ key: 'nr-gap', dimColor: true, children: [' '] }))
    for (const m of missing) children.push(notRunRow(els, m.kind))
  }

  children.push(Text({ key: 'gap-btn', children: [' '] }))
  children.push(
    Box({
      key: 'actions',
      flexDirection: 'row',
      columnGap: 2,
      children: [Button({ key: 'prepare', label: 'Prepare checks', hotkey: 'p', autoFocus: true, onPress: onPrepare })],
    }),
  )
  children.push(Text({ key: 'note', dimColor: true, children: ['Results come only from what the tools reported, not from Claude’s summaries.'] }))
  return Box({ flexDirection: 'column', children })
}
