// The values Ship Check keeps in `$.state`, so they survive a hot reload.
declare module 'claude-code' {
  interface PluginState {
    'ship-check': {
      ledger: {
        records: Record<string, ShipCheckRecord>
        runs: ShipCheckRun[]
      }
      view: { expanded: string | null }
    }
  }

  interface ShipCheckSig {
    hash: string
    count: number
    partial: boolean
  }

  interface ShipCheckRecord {
    key: string
    kind: string
    location: string
    scope: string
    root: string
    command: string
    filtered: boolean
    status: 'running' | 'passed' | 'failed' | 'unknown'
    startedAt: number
    endedAt: number | null
    exitCode: number | null
    reason: string | null
    summary: string
    startSig: ShipCheckSig | null
    endSig: ShipCheckSig | null
    dirtyDuringRun: boolean
    staleAt: number | null
    staleReason: string | null
    staleFiles: string[]
  }

  interface ShipCheckRun {
    key: string
    kind: string
    location: string
    command: string
    status: string
    startedAt: number
    endedAt: number | null
  }
}
