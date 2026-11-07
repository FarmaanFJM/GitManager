# Development control center

What GitManager does beyond repositories and Git, how it does it, and what has and has not been verified. Interface rules: [Summa-UI TOP](SUMMA_UI_ADOPTION.md#top-principle).

## Terminal

An embedded terminal in a bottom dock (Ctrl+`): tabs, one shell picker, New tab, Close. Reached from **Terminal** on a repository row, the repository header, a service, a worktree or a runner. It opens in the right folder and shell with no `cd`.

- **Shells.** Windows PowerShell, PowerShell 7 when installed, every WSL distribution `wsl.exe --list` reports (none is hardcoded), or the login shell on macOS and Linux. The last shell chosen for a repository is remembered.
- **Paths.** A WSL repository opens in its own distribution (`wsl.exe -d <distro> --cd <path>`). A Windows folder opened in WSL goes through `/mnt/<drive>`; a UNC path to another distribution is refused. A WSL repository opened in PowerShell starts in the home folder and changes directory itself.
- **Safety.** Process creation is in the main process (`node-pty`, ConPTY on Windows). The page sends `{ target, shellId }`; the main process resolves the target and plans an argv array. No repository path is concatenated into a command string, and GitManager never runs anything on its own: the user types.
- **Lifecycle.** Sessions live in the main process, so changing views never ends one; the dock redraws from a bounded replay buffer. Closing a tab whose shell runs a command asks first. Quitting asks when a terminal runs a command or a service runs. An exited shell stays readable until closed (Reopen, Close).
- **Copy output.** The copy icon in the dock header copies the last command with its output, every command with its output, or everything the terminal holds. Each command is recorded where Enter was pressed and read back from the terminal's own buffer, so the text is exactly what was on screen: the prompt and the command as completed or recalled from history, then what it printed. The shell's next, empty prompt is left out. Limits: a command is recorded only when Enter is pressed on its own (a multi-line paste is one entry), programs that take over the screen (editors, pagers) are not split into commands, and the prompt is recognised by its last character (`>`, `$`, `#`, `%`).
- **Runner terminal.** WSL runner: its distribution, its folder, the service user (systemd `User=`), else the folder's owner, else the distribution default. Windows runner: PowerShell in the installation folder. Root is never used. If the interactive account differs from the service account, or cannot be determined, a note says so. SSH runners are not supported yet.

## Processes and ports

**Processes** lists what listens on a port plus what GitManager started. Windows and each WSL distribution are scanned separately (PIDs are never mixed). A process belongs to a repository only by its working directory, executable or command path inside a registered repository or worktree, never by port number. Per row: Inspect, Terminal in its repository, Open repository, Copy PID, Copy command, Stop.

- **Ownership.** A process GitManager started stops normally. An external process stops only after a confirmation naming it ("Stop java (PID 4120)?"). The identity (PID, start time, command) is re-checked right before the signal so a reused PID is not killed. Permission failures say so concisely; GitManager never elevates.
- **Before start.** A profile whose expected ports (the readiness port and the service's `ports`) are held by another process does not start: "Port 8080 occupied" with Inspect.
- **Windows.** One fixed PowerShell command (`Get-NetTCPConnection` joined with `Win32_Process`) feeds the list. Windows exposes no working directory or environment of another process, so association uses the executable and command line there.

## Environment (read-only)

Two sources, never merged:

- **Runtime**: what the process received. For a service GitManager started, the environment captured at launch. For an outside Linux or WSL process, `/proc/<pid>/environ` (the environment at exec, not later changes). Windows cannot expose another process's environment; the view says so instead of showing a partial list.
- **Files**: `.env*`, `application.properties`, `application.yml`, runner `.env`. These are read from disk; the view states that changed files do not update a running process, and for Spring they are not the properties the application resolved.

Values that look sensitive start concealed; Reveal, Show all, Hide all and Copy are one click, with no password or warning. Values are never truncated by GitManager, and are never written to logs.

## Sync with Remote

Fetch, Pull and Sync stay distinct. Sync is `git fetch --prune`, then a plan: local branches whose upstream is gone are **delete-safe** (contained in the remote default branch), **needs review** (unique commits: unmerged or squash-merged, never deleted unless you tick the branch), or **protected** (default, `develop`, `release/*`, checked out in any worktree). Branches with no upstream are intentionally local and left alone. The default branch comes from repository metadata. Execution re-verifies every tip, uses `git branch -d`, records the SHA of each deletion with its recovery command, and keeps partial results. If the current branch is stale and the tree is clean it offers to switch to the default; a dirty tree is never touched. `git-clean-branches.ps1` was not found in any accessible repository, so the behavior implements the described intent, not that script.

## Pull while services run

Fetch and Pull work with services running (Switching branches still asks to stop them). After a pull, the changed files are matched against each running service (technology from its command and directory, never from its port): config and dependency descriptors read at start are *restart needed*, source is *restart suggested* unless the command watches or hot-reloads, and a dev-server source change is *hot reload* (no prompt). The result is one line: "Backend updated · Restart", or "3 services need attention". Restart stops the service gracefully, starts it with the same command, directory and environment, and reports success only after it is ready (or has stayed alive when it has no readiness check).

## Profiles and worktrees

A profile may bind to a worktree (`worktreePath`), and services have a start order (`dependsOn`, dependencies start first and are awaited), an optional URL (Open URL, Copy URL) and expected ports. Worktrees: list, create (existing or new branch, suggested folder), Terminal Here, Copy Path, Switch View, Remove (blockers and consequences shown first; changes are discarded only after an explicit tick).

## Runners

Terminal, Logs, Environment, Dependencies, Restart. Dependencies run **inside the runner's own environment** (the WSL distribution or Windows), under both the login PATH and the PATH recorded by the runner (`.path`): a tool found only on the login PATH is reported "Not on the runner PATH". Found, missing, error and unknown stay distinct. Nothing is installed; Terminal opens in the runner for that.

## Verification status

| | Linux (verified here) | Windows, WSL |
| --- | --- | --- |
| Terminal, shell planning | real PTY in Electron, correct folder, exit codes | argv and path translation unit-tested; **not run** |
| Processes, ports, stop, live environment | real processes, real `/proc` | PowerShell and `wsl.exe` paths fixture-tested; **not run** |
| Sync, worktrees, pull, affected services, restart | real Git repositories and processes | same code; WSL directory probes **not run** |
| Runner dependencies | real native shell | PowerShell script and `wsl.exe --exec` **not run** |

`npm test` (unit and integration), `npm run test:e2e:devtools` (real Electron under Xvfb), and the existing `test:e2e:menus`, `test:e2e:runners`, `test:e2e:storage`. The original `test:e2e` needs Java and Maven and was not run.
