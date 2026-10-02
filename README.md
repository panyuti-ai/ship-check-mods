# ship-check-mods

A Claude Code marketplace with one mod: **Ship Check**, a development verification board.

When Claude changes your code, Ship Check shows which checks really ran, how they ended, and whether each result still matches the code on disk. It never takes Claude's word for it. A check is *Passed* only when the tool that ran it said so.

```
Tests ✓ | Types ↻ Stale | Build ○ Not run
```

## Features

- **A status line above the prompt.** One short line per project: `Tests ✓ | Types ↻ Stale | Build ○ Not run`. When the same kind of check has results in several folders (for example the tests of two packages), the line shows the worst one, in the order Failed, Stale, Unknown, Running, Passed, so a failure is never hidden behind a newer pass elsewhere. Open the panel to see every folder. It updates quietly and never pops up a notification.
- **A detailed panel.** Press **Details** on the status line, or run `/ship-check`, to open **Ship Check**. For each check it shows the result, the time, the command, the project location, and why a result is stale.
- **View output.** Each row has a **View output** button that shows a length-limited tail of the real tool output.
- **Prepare checks.** Puts a request to re-run stale, failed, unknown or not-yet-run checks into the prompt box. Nothing is sent until you press Enter.
- **Honest statuses.** Every check is in exactly one state:

| Status | Meaning |
| :-- | :-- |
| Not run | No result has been recorded for this project yet. |
| Running | The check has started and has not reported back. |
| Passed | The tool reported a clean finish. |
| Failed | The tool reported a non-zero exit status. |
| Stale | The check finished, but files changed afterwards (or while it ran). |
| Unknown | The check ran, but the tool gave no reliable way to tell how it ended. |

## What is recognized

- **npm, pnpm, yarn and bun**: `test`, `build`, and type-check scripts (`typecheck`, `type-check`, `check-types`, `tsc`), including `npm run <script>`, `pnpm -C dir`, `yarn workspace <name> <script>`, `npm --prefix dir`, `--workspace` / `--filter`, and a leading `cd dir &&`.
- **Direct tools**: `tsc` (`--noEmit` counts as a type check), `vitest run`, `jest`, `npx`/`bunx` forms of those.
- **Your own commands** (see Settings).

Ship Check reads the **Bash** tool and the **PowerShell** tool (Windows), and looks through `cmd /c "..."` and `bash -c "..."` wrappers.

The same check in two different project locations, or two workspaces, is recorded separately.

## How a result is decided

Only the tool result counts. A check is **Passed** or **Failed** only when the exit status the tool reported can be tied to that check:

- A clean finish → **Passed**.
- An error with an `Exit code N` line → **Failed**, and `N` is shown.
- Anything else → **Unknown**, with the reason shown in the panel.

What each tool reports, and so what Ship Check trusts:

| Shell | The tool reports | Trusted forms | Unknown |
| :-- | :-- | :-- | :-- |
| **Bash** | The exit status of the last statement | `npm test`, `cd app && npm test`, `cd app; npm test`, a check that is the last command of a `;` list, and `npm test; echo "EXIT: $?"` (the printed status is read) | A pipe (`npm test \| tail`), `\|\|`, background jobs, `;` followed by another command, a failure in an `&&` chain that could belong to an earlier command. After a pipe, `echo "${PIPESTATUS[0]}"` is read. |
| **PowerShell** | `$LASTEXITCODE`: the exit status of the last native program | `Set-Location x; npm test`, a check followed by cmdlets, strings, `Write-Output`, or `if ($?) {...}` / `if ($LASTEXITCODE -ne 0) {...}` blocks that run no program, a pipeline into cmdlets (`npm test \| Select-Object -Last 1`), PowerShell 7 `&&` chains | A later native program (`npm test; npm run build` — the first check), a pipeline into a program (`npm test \| findstr x`), `||`, an assignment like `$x = npm test` |
| **cmd.exe** | The exit status of the last command | `cmd /c "npm test"`, `cmd /c "cd app && npm test"`, `cmd /c "a & b"` (the last command) | The same forms as above |

Also **Unknown**:

- background runs and commands that timed out into the background
- interrupted commands
- watch mode (`--watch`, plain `vitest`), which never finishes by itself
- a `cd` or `Set-Location` that failed, because the check may then have run in another directory
- a tool result with no completion information
- a command run by **a tool Ship Check does not know**. If a future Claude Code version adds another way to run commands, a check seen there is listed as Unknown with the tool's name, instead of being silently ignored.

Test counts are **not** shown. Test runners print summaries in too many formats to parse reliably, so Ship Check shows the real output instead of a guessed number.

A run that passes extra arguments (for example `npm test -- -t login`) is marked in the panel, because it may not cover everything.

## When a result goes stale

A finished result becomes **Stale** when any tracked file under the project changes afterwards. A change that happens while the check is running also makes the result stale, because the result may not match the latest code.

Ship Check notices:

| Change | How it is noticed |
| :-- | :-- |
| Claude's Edit, Write, MultiEdit and NotebookEdit tools | The tool call, immediately. |
| Files changed by a Bash command | The file list the Bash tool reports. If the tool cannot report one, every finished result in that project is marked stale to be safe. |
| Edits you make yourself | A fingerprint comparison when a turn ends, and when you submit a prompt. |
| Git commit or branch changes | The fingerprint includes `HEAD`. |

The fingerprint is `HEAD` plus the modified and untracked files that Git reports, with each file's size and modified time. Outside a Git repository it walks the folder with caps (depth 5, 1,500 entries); if a cap is hit the fingerprint is marked partial and is never used to claim that something changed.

**Never counted:** `node_modules`, `.git`, `dist`, `build`, `out`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.cache`, `coverage`, `.nyc_output`, `target`, `__pycache__`, `.venv`, `.claude`, `*.log`, `*.tsbuildinfo`, and similar generated output.

The stale reason names the kind of change: source files, configuration files (`tsconfig*`, `*.config.*`, `.env*`), or dependency files (`package.json`, lockfiles).

## Requirements

- **A Claude Code that supports mods.** Anthropic's documentation says mods need Claude Code 2.1.287 or later. In the terminal, check with `claude --version`. The desktop app bundles its own copy of Claude Code; Ship Check also loaded in a Windows desktop app whose built-in version was 2.1.286, so if it does not appear, update the app first.
- Git is optional but recommended; it makes change detection faster and more precise.
- The terminal and the **Code** tab of the desktop app can load mods. Other places (the VS Code chat panel, `claude -p`, cloud sessions) run a mod's hooks but do not draw its interface.

## Settings

Both settings are optional, and Ship Check works without them. To change them, open `/plugin` in a terminal session, select **ship-check**, and choose **Configure options**, or edit `pluginConfigs` in your settings file.

- **Extra checks**: your own commands, one per entry, written as `kind=command`. The kind becomes the label in the status line.
  ```
  lint=npm run lint
  e2e=npx playwright test
  ```
- **Ignored paths**: folders or files whose changes should not make a result stale, such as `generated`.

Both are optional.

## Troubleshooting

If the status line does not appear, start Claude Code with `SHIP_CHECK_DEBUG` set to a file path (for example `$env:SHIP_CHECK_DEBUG = "C:\temp\ship.json"` in PowerShell). Ship Check then writes the size the band was given and the number of recorded checks to that file. The status line appears once at least one check has run.

## Try it locally

From a clone of this repository:

```bash
claude --plugin-dir ./plugins/ship-check
```

Then ask Claude to run your tests, and open the panel with `/ship-check`. Edits to the mod reload while the session runs.

Run the checks for the mod itself:

```bash
claude plugin validate .
claude plugin validate ./plugins/ship-check --strict
cd plugins/ship-check && claude plugin test
```

## Install

### In the Claude desktop app (no terminal)

Use a recent Claude desktop app. Ship Check was tested in the **Code** tab of the Windows app. If it does not show up after the steps below, update the app and try again.

1. Open **Settings** and choose **Plugins** (under *Customize*).
2. Click **Add**, then **Add from a repository**.
3. Enter `panyuti-ai/ship-check-mods` and confirm.
4. Open the **Discover** tab, find **Ship Check**, and install it. It then appears under **Yours** with its switch turned on.
5. **Wait a few minutes**, then open a **new session** in the **Code** tab. A session that was already open when you installed does not have it, and a new session can still miss it for the first minutes after the install.
6. Ask Claude to run your tests, a type check, or a build. The status line appears above the prompt, with a **Details** button at its end. Press **Details** to open the **Ship Check** panel on the right.
7. To open the panel before any check has run, type `/ship-check` and press Enter. Below the prompt you may then see an orange line, `/ship-check isn't a command here.` It is only a notice from the app, which does not know commands that a mod adds: the panel still opens.

To turn it off or remove it later, use **Settings → Plugins → Yours**.

### In the terminal

```
/plugin marketplace add panyuti-ai/ship-check-mods
/plugin install ship-check@ship-check-mods
/reload-plugins
```

The terminal and the desktop app's Code tab read the same plugin settings on one computer, so a plugin installed in one is available in the other.

## Update

**Desktop app:** open **Settings → Plugins → Yours** and use the menu (⋮) next to Ship Check or its marketplace to update. The menu wording can differ between app versions. Start a new session afterwards, because a running session keeps the version it loaded.

**Terminal:** `marketplace update` takes the marketplace's **name** (`ship-check-mods`), not the GitHub path, so these commands are the same for everyone:

```
/plugin marketplace update ship-check-mods
/plugin update ship-check@ship-check-mods
/reload-plugins
```

Claude Code caches an installed plugin by version, so a new release must raise `version` in both `plugins/ship-check/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.

## Known limits

- **How each shell reports its exit status was measured, not documented.** The table above comes from real Claude Code 2.1.287 sessions with the Bash and PowerShell tools. PowerShell 7's `&&` and `||` are covered by unit tests only, and the `cmd /c` handling rests on the PowerShell tool reporting the wrapped command's status. If a Claude Code release changes what the tools report, results may become Unknown or, in the worst case, wrong; please open an issue.
- **Only Claude's own tool calls are observed.** Checks you run in your own terminal are not recorded. A file you change there is still noticed as a change, at the next turn end or prompt.
- **The scope of "stale" is the whole Git repository.** In a monorepo, an edit in one package marks results from other packages stale too. This is deliberately cautious.
- **Edits you make are noticed late.** There is no file watcher; changes you make by hand are noticed when a turn ends or you submit a prompt, not the instant you save.
- **Same-size, same-second edits can be missed by the fingerprint.** Claude's own edits are tracked by tool call, so this only affects hand edits made within the clock resolution of a file system.
- **A check that writes tracked files makes itself stale.** For example a test that rewrites a snapshot. Add the folder to *Ignored paths*.
- **Filtered runs overwrite the full run.** The latest run of a check in a location is the one shown.
- **`bashEditDiff` is an internal field.** Ship Check uses the file list the Bash tool reports when it is there and falls back to the fingerprint when it is not. If a future Claude Code version removes it, stale detection still works, just a little later.
- **Mods are early access.** The API can change between Claude Code releases. This version was built and tested against Claude Code 2.1.287.
- **State lives for the session.** Results survive a hot reload but reset on `/clear`, `/resume` and `/branch`.
- **Locations.** `cd` to a path that uses `~`, a variable, or `-` cannot be resolved, so that check is not recorded.

## Layout

```
ship-check-mods/
├── .claude-plugin/marketplace.json
├── plugins/ship-check/
│   ├── .claude-plugin/plugin.json
│   ├── hooks/
│   │   ├── hooks.json
│   │   ├── register.js        # wires events to the board
│   │   └── lib/               # command parsing, shell analysis, statuses, views (no Claude Code API calls)
│   ├── types/index.d.ts       # the state the mod keeps
│   └── tests/
├── README.md
└── LICENSE
```

## License

MIT. See [LICENSE](LICENSE).
