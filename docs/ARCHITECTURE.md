# Architecture

GitManager is an Electron application with three layers: a React renderer that only draws and asks, a narrow preload bridge, and a main process that owns every effect (files, Git, processes, the browser). The logic of the main process lives in plain Node modules that do not import Electron, so it is tested without a window.

```
src/
  core/        Node modules, no Electron. Tested directly.
    paths.ts       Windows and WSL path namespaces, conversions, service directories
    exec.ts        process invocation (never a shell string), Git and WSL command construction, wsl --list parsing
    git/status.ts  porcelain v2 parsing, sync classification, the fast-forward pull plan
    git/ops.ts     Git operations: status, fetch, pull (ff-only), branches, switch, track, log, compare, remote check
    git/errors.ts  concise error messages from Git output
    git/branches.ts  branch overview: default branch detection, ahead/behind for every ref, branch details (read-only)
    discovery.ts   bounded repository search (native file walk, `find` inside WSL), worktree/submodule recognition, common locations
    autodiscovery.ts  background discovery at launch and on request: registers new repositories, skips removed ones
    startup.ts     Windows startup entry (login items), the --launched-at-login argument, start minimized and tray rules
    profiles.ts    trust fingerprint, env files, launch planning
    processes.ts   ServiceManager: spawn, readiness, logs, graceful tree termination
    readiness.ts   HTTP and TCP probes
    launchers.ts   Chrome and Edge discovery, opening URLs, editor command
    store.ts       configuration file: atomic writes, validation on load
    validate.ts    validation of everything that crosses a trust boundary
  core/storage/  GitHub Actions storage maintenance (see "Storage module" below)
    gh.ts          the GhApi seam; GhCli runs `gh api` (argument arrays, no token), error mapping, sign-in state
    github.ts      typed, paginated, rate-limit-aware endpoint calls (the only DELETE is one artifact by id)
    classify.ts    pure classification: Protected, Keep, Review, Delete candidate, Expired
    scanner.ts     per-repository inventory with bounded concurrency; a failed lookup lowers confidence, never the other repositories
    cleanup.ts     cleanup plan and the executor: revalidate, delete, confirm with GitHub
    audit.ts       append-only, hash-chained local audit log
    scheduler.ts   schedule arithmetic and the automatic-safe split; service.ts owns scan, operations, schedule and persisted state
    config.ts      settings, per-repository policies, presets, pins (validated on load); alerts.ts derived warnings
  core/runners/  Tools: GitHub Actions self-hosted runners (see "Runners module" below)
    model.ts       scopes, identities, reconciliation of local installations with GitHub records, capabilities, runs-on
    hosts.ts       HostShell: this computer, a WSL distribution (wsl.exe --exec, -u root), an SSH host (every token quoted); probing; SSH config
    discovery.ts   bounded read-only discovery per host: one sh run (Linux, macOS, WSL, SSH), sc.exe and folders (Windows)
    github.ts      the runner API: list, get, tokens, delete, downloads, groups, organizations, latest release and checksums
    install.ts     request validation, the plan (checks and exact commands), the executor (steps, redaction, cancellation, partial outcomes)
    lifecycle.ts   start, stop, restart, inspect, diagnostics, check-update, update, unregister, uninstall
    workflows.ts   runs-on reader and label matching
    manager.ts     RunnerManager: inventory, scans, jobs, actions, persistence (runners-state.json), events
    config.ts      the runners section of gitmanager.json, validated on load
  shared/      types and the API contract shared by all three layers (type-only, plus the method list)
  main/
    backend.ts     application logic behind the API; validates arguments, returns Results
    ipc.ts         one ipcMain handler per API method, sender check, error mapping, event forwarding
    preload.ts     contextBridge: exposes exactly the API methods, nothing else
    chrome.ts      title bar (window controls overlay) colours and height, brand icon files
    tray.ts        notification area icon with Open and Quit
    main.ts        window, single instance, tray, security settings, quit handling
  renderer/    React interface built from Summa-UI (see SUMMA_UI_ADOPTION.md)
    tools/         the Tools view (registry of tools) and tools/runners/ (Runner Manager: table, details, wizard, discovery, workflows)
third_party/summa-ui/   pinned Summa-UI guidance bundle and reference implementation (verified, unmodified)
```

## Security

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, no webview. The preload can only `require('electron')` and exposes a fixed list of request functions (`window.gitmanager`).
- Every IPC handler checks that the request comes from GitManager's own page, validates every argument (ids, paths, branch names, URLs, environment variable names, distribution names) and returns a Result. Unexpected errors are logged in the main process; the page gets a short message.
- The page cannot open windows, navigate elsewhere, attach webviews or obtain permissions. A Content Security Policy allows only the bundled script.
- Processes are started with argument arrays, never by concatenating a shell string from untrusted input. The only shell strings are the service commands the user typed into a profile, which is their purpose.
- Branch names are checked before Git sees them (nothing that starts with `-`, no `..`, no control characters), so they cannot be read as options.

### Trusted profiles

A repository can contain anything, including files that look like configuration. GitManager never reads commands from a repository and never runs anything automatically. Profiles are created in GitManager and stored in the user's configuration file. A profile runs only when its *fingerprint* (repository location, runtime, working directory, and for each service the command, directory, environment and env file path) matches the fingerprint the user approved in the confirmation dialog that shows the exact commands. Editing any of these resets trust; renaming, readiness checks and the browser URL do not.

## Git safety model

| Operation | Implementation | Refused before running when |
| --- | --- | --- |
| Status | `git status --porcelain=v2 --branch -z` with `GIT_OPTIONAL_LOCKS=0` | |
| Remote check | `git ls-remote --heads -- <remote>` | |
| Fetch | `git fetch -- <upstream remote or origin>` (or `--all` when ambiguous) | no remote |
| Pull | fetch, then `git merge --ff-only --no-autostash --no-edit <upstream>` | diverged, detached, no upstream, upstream gone, conflicts, nothing to pull |
| Switch | `git switch --no-guess <branch>` | services running, conflicts, unsafe or unknown name |
| Track | `git switch --no-guess --track -c <branch> <remote>/<branch>` | services running, local name exists, remote ref missing |

All Git commands run with `GIT_TERMINAL_PROMPT=0` (there is no terminal; credential helpers such as Git Credential Manager still work), `LC_ALL=C` (messages can be recognized) and a timeout. `--no-autostash` overrides a `merge.autostash` setting, and using `merge --ff-only` instead of `pull` makes a `pull.rebase` setting irrelevant, so user configuration cannot turn a pull into a stash, a merge commit or a rebase. One changing operation runs per repository at a time.

## Windows and WSL execution

A repository's `Location` is either `{ kind: 'native', path }` or `{ kind: 'wsl', distro, path }`, decided once at registration from what the user entered (`\\wsl.localhost\<distro>\...` and `\\wsl$\<distro>\...` become WSL locations). Every later operation derives its command from the location, so Windows Git never touches a WSL repository and Windows paths never reach Linux tools.

| | Native (Windows) | WSL |
| --- | --- | --- |
| Git | `git <args>` with `cwd` | `wsl.exe -d <distro> --cd <path> --exec env GIT_...=... git <args>` |
| Service | `cmd.exe /d /s /c "<command>"` in the service directory | `wsl.exe -d <distro> --cd <dir> --exec env K=V... setsid -w bash -lc '<marker>; <command>'` |
| Stop | `taskkill /PID <pid> /T`, then `/F` after the grace period | `kill -TERM -- -<pgid>` inside the distribution, then `-KILL`, then `taskkill /T /F` on wsl.exe |
| Open folder | Explorer on the path | Explorer on `\\wsl.localhost\<distro>\<path>` |
| Editor | `cmd.exe /c "<editor> "<path>""` | `<editor> .` inside the distribution (VS Code's WSL integration) |
| Readiness | probe from Windows | probe from Windows through WSL localhost forwarding |
| Distributions | | `wsl.exe --list --verbose` (UTF-16 or UTF-8), Docker Desktop internals skipped |

On macOS and Linux (development, tests and future support) services run in the user's login shell in a new process group, stopped with `SIGTERM` to the group and `SIGKILL` after the grace period.

## Process lifecycle

`ServiceManager` keeps one entry per service (`profileId:serviceId`).

```
stopped ──Run──▶ starting ──check passes──▶ ready
                    │  └──no check configured──▶ running
                    ├──exits non-zero / cannot spawn──▶ failed
                    └──check never passes (timeout)──▶ failed (process kept; Stop is available)
ready/running/starting ──Stop──▶ stopping ──tree gone──▶ stopped
```

Output from stdout and stderr is split into lines, ANSI codes removed, carriage-return progress collapsed, kept in a ring buffer of 5000 lines per service and sent to the window in batches. On quit GitManager asks before stopping running services and stops them gracefully; if the process is killed, a synchronous last-resort cleanup forces the trees down.

## Storage module

`StorageService` (core/storage/service.ts, owned by `Backend`) is the only code that talks to GitHub, and only through the `GhApi` interface. `GhCli` implements it with `gh api -i -X <GET|DELETE> <path>`: arguments are an array, the path must match a strict allow-list pattern, `GH_PROMPT_DISABLED`, `NO_COLOR` and an empty `GH_DEBUG` are set, and the process inherits `gh`'s own session. The renderer receives results, never credentials, and has no way to run a command or call an arbitrary endpoint: the API surface is `storageState`, `storageScan`, `storagePreview`, `storageDelete` and a few setters whose arguments the backend validates (repository `owner/name`, positive integer ids, enumerated modes). `storageDelete` refuses without `confirm: true` (a dry run needs none and changes nothing).

Tests replace `GhApi` with an in-memory GitHub (`test/storage/fakeGithub.ts`) that can fail, rate-limit, change data between calls and ignore deletions. The acceptance scenario replaces the `gh` executable itself (`GITMANAGER_GH`).

- **Scan.** `listRepos`, then per repository (four at a time) artifacts, runs, open pull requests, releases, documentation, caches. Completed runs and documentation (by tree sha) are cached for the session. Each lookup that fails is recorded as a limit and sets a context flag; the classifier turns delete candidates into Review when a flag they depend on is false. Only sign-in and rate-limit failures end the whole scan, and the results read so far are kept.
- **Delete.** `executePlan` works per repository: it reads the repository and re-classifies with the *current* configuration, requires each artifact to match the scan (id, name, size, run, classification), reads the artifact once more, writes the attempt to the audit log, sends `DELETE /repos/{o}/{r}/actions/artifacts/{id}`, and afterwards lists the repository again to confirm. 403 stops that repository, 401 stops everything, a rate limit is waited out only when short, a cancel stops after the current artifact.
- **Schedule.** `StorageService.start()` runs a one-minute timer in the main process only while GitManager runs; it is off unless the user enabled it, scans only repositories whose mode is not manual, and deletes only through `splitForAuto` (approved policy hash, high-confidence reasons, complete context, below the large-deletion limit). Nothing is installed in the operating system.
- **Persistence.** Settings, policies, protected repositories and pins are the `storage` section of `gitmanager.json`, validated on load like the rest. The last scan (`storage-state.json`) and the audit log (`storage-audit.jsonl`) are separate files in the same folder.
- **Branches.** Storage has no connection to Git branch management; GitManager still never deletes branches.

## Runners module

`RunnerManager` (core/runners/manager.ts, owned by `Backend`) is the Tools section's first utility. Everything that touches a machine goes through a `HostShell` (core/runners/hosts.ts): `NativeShell` (fs and `spawn`), `WslShell` (`wsl.exe -d <distro> --exec …`, root through `-u root`) and `SshShell` (`ssh -o BatchMode=yes … <alias> <command>`, where the command is built by single-quoting every token). Elevation on this computer is `sudo -n` (Linux; refused up front when a password would be needed) or a PowerShell `Start-Process -Verb RunAs` whose script embeds every value as a quoted literal (Windows); macOS needs none for the runner's launchd agent.

GitHub access is a second `GhCli` with the `runners` profile: GET anywhere, POST only for registration and removal tokens, DELETE only for one runner by id; the Storage instance keeps its own rules unchanged. Tokens are returned to the install or remove step, kept in memory for that step, redacted (`redact.ts`) from every line of output and never persisted.

- **Discovery** (`discovery.ts`) is read-only and bounded. POSIX hosts run one fixed `sh` script with positional arguments (roots as `depth:path`), which prints tagged records: the `.runner` content (base64), the `.service` content, whether `.credentials` exists, the listener version (`Runner.Listener --version`, else the newest `_diag` log), the systemd or launchd state, and the listener processes whose working directory is the installation. Windows uses `sc.exe query` and `sc.exe qc` for the `actions.runner.*` services, the file system for folders, and `Get-CimInstance Win32_Process` for listener processes by executable path. An installation is recognized by `.runner`, or by the runner program next to `config.sh`/`config.cmd`.
- **Reconciliation** (`model.ts`) pairs a local installation with a GitHub record by the runner id in `.runner` within the same scope, or by name only inside one scope when the id is missing and the name is unique there. Everything unpaired is its own row. GitHub status (online, offline, busy) and the local service state are separate fields; `attention` lists the contradictions. `capabilitiesFor` decides what each row allows and why not.
- **Installation** (`install.ts`) validates the request, probes the host, checks the directory (absolute, no dot segments or quoting characters, not a system folder, new or empty, not an existing installation), collisions (name in scope, service name), prerequisites (systemd, user, sudo), GitHub access (administration, without requesting a token) and the package (downloads API with `sha256_checksum`, else the release notes markers; refused without a checksum or from a non-GitHub host). The executor runs eleven steps, downloads to a temporary folder of its own, verifies the SHA-256 (and again on the target after a copy), extracts with tar, runs `./config.sh` (POSIX) or `bin\Runner.Listener.exe configure` (Windows, as administrator with `--runasservice`), checks `.runner`, installs and starts the service, and verifies with `GET …/actions/runners/{id}` and a re-inspection. Failures keep every file and report the outcome (downloaded, extracted, registered, service installed, running).
- **Lifecycle** (`lifecycle.ts`) only acts on services recorded in `.service` and processes identified by path; busy runners need `allowBusy`, destructive operations need `confirm`; update sets `bin` and `externals` aside and restores them on failure; uninstall refuses while registered (unless unregistering first), refuses non-installations and system paths, and deletes exactly the installation directory.
- **Persistence.** The `runners` section of `gitmanager.json` (settings, roots, allowed SSH hosts, known installations) is validated on load; `runners-state.json` holds the last inventory and recent jobs with redacted output.
- **IPC.** `runners*` methods on the backend validate every argument (host, path, ids, enumerated actions, booleans coerced, scopes parsed); `runners-status` and `runners-changed` events keep the window current. The renderer refreshes GitHub on focus and on a timer; the manager rate-limits refreshes to one a minute.

## Persistence

One JSON file in the application data folder, written atomically (temporary file and rename, mode 0600). On load every record is validated; invalid records are dropped and reported, and an unreadable file is renamed to `*.corrupt-<time>` instead of being overwritten silently.

## Portability

Everything platform-specific is in `exec.ts`, `processes.ts` (`serviceSpec`, `signalTree`), `launchers.ts` and `paths.ts`. The Windows and WSL branches are covered by unit tests of the exact commands they build; the native POSIX branch runs for real in the test suite and the acceptance scenario.

## Automatic discovery

`AutoDiscovery` runs once the window has loaded (at every launch, unless turned off in Settings) and on request (Rescan, or a deep search of whole drives or the whole home folder). It never blocks the interface: it runs in the main process, reports progress as `discovery-status` events and each newly registered repository as a `repo-added` event, and the sidebar adds repositories as they arrive.

Targets, built at run time from the home folder (`os.homedir()`, or `GITMANAGER_HOME`) and drive letters, never from a user name:

- existing development folders in the home folder (`source\repos`, `Projects`, `code`, `dev`, `src`, `repos`, `GitHub`, `workspace`, `Documents\GitHub` and similar, depth from Settings, default 3) and the home folder itself (one level);
- on Windows, drive-level folders such as `C:\Projects` or `D:\dev` (each drive letter is probed with a short timeout, so a disconnected network drive cannot stall the scan);
- folders the user added under Repository folders;
- on Windows, the home folder of each WSL 2 distribution (asked inside the distribution), scanned with one `find` run there that stays on the Linux file system (`-xdev`, 9p and drvfs mounts and `/mnt` pruned), so Windows drives are never scanned a second time through WSL.

Each scan is bounded: depth, a folder budget (20 000), a repository cap (500), a time budget (30 s per location, 120 s in deep mode), no symbolic links or junctions, unreadable folders skipped, and dependency, build, hidden and operating system folders excluded. A `.git` directory with `HEAD` is a repository; a `.git` file pointing into `.git/worktrees/` is a linked worktree (registered and labelled); one pointing into `.git/modules/` is a submodule (skipped).

Deduplication uses `locationKey`: Windows paths compare case-insensitively with either separator, `\\wsl.localhost\<distro>\x` and `\\wsl$\<distro>\x` are the WSL path `/x`, and a WSL path under `/mnt/<drive>` is the Windows path it mirrors; native results are also resolved with `realpath`, which collapses junctions and symbolic links. Removing a repository records its key in `ignored`; discovery skips ignored keys, and adding the repository by hand (or Restore in Settings) lifts it. Manual repositories, profiles and settings are never touched by discovery, and nothing is executed in a discovered repository.

## Branch overview

`BranchInspector` answers the Branches tab with read-only commands only:

1. **Comparison base.** A base the user chose for this repository; else `refs/remotes/<remote>/HEAD`; else the remote's advertised HEAD from `git ls-remote --symref <remote> HEAD` (remembered until the next fetch, never written to `refs/remotes/<remote>/HEAD`). The remote is the current branch's upstream remote, else `origin`, else the only remote. With no remote, or several remotes and no origin, the result is no base with a reason, and the user picks one; nothing is guessed from branch names.
2. **All refs in one call.** `git for-each-ref` over `refs/heads` and `refs/remotes` with name, tip, HEAD marker, upstream and its track state, date, author and subject; on Git 2.41+ the same call returns `%(ahead-behind:<base>)` for every ref. Older Git falls back to `git rev-list --left-right --count <base>...<ref>` per ref (six in parallel natively, one `sh` loop for all refs inside WSL, with refs passed as arguments).
3. **Unrelated histories.** Only refs that are both ahead and behind get a `git merge-base` check; none means unrelated.
4. **Cache.** Counts are cached per repository by `<base tip>:<ref tip>`, so unchanged refs are never recomputed, and the cache is dropped after fetch, pull, switch and tracking-branch creation.
5. **Freshness.** The modification time of `FETCH_HEAD` tells the interface when remote-tracking refs were last updated.

Details for one ref use `git log <base>..<ref>`, `git log <ref>..<base>`, `git merge-base` and `git diff --name-status <base>...<ref>`. Refs are validated as `refs/heads/...` or `refs/remotes/...` before they reach Git. Switching from the details reuses the existing safe switch and its running-services guard.

## Title bar

On Windows the window has no separate title bar. `BrowserWindow` uses `titleBarStyle: 'hidden'` with a `titleBarOverlay` (`src/main/chrome.ts`): Windows keeps drawing its own caption buttons (minimize, maximize with Snap layouts on hover, close) in the top-right corner, on `#1B1C1C` (Summa-UI `--s1`) with `--text-2` symbols, 52 px tall like the header row. The page then forms the title bar itself:

- The main panel reaches the window's top and right edges (only its top-left corner is rounded), so the caption buttons sit on the panel surface they share a colour with, and its header row (repository name, branch picker, actions) is the title bar's middle. `env(titlebar-area-x/width/height)` gives the area beside the buttons; headers keep their actions out of the buttons' width.
- The sidebar's brand row (logo and name) is the title bar's left part, on the page surface `#141515`.
- One transparent, fixed strip covers the title bar area with `app-region: drag`. Every interactive element (buttons, inputs, tabs, switches, links, popovers, dialog backdrops) is `app-region: no-drag`, so a click on a control never starts a window drag; the acceptance scenarios check that no control in the strip is draggable and none sits under the caption buttons.

Moving, double-click to maximize, resizing from the edges and Snap are Windows' own behaviour on that region, not reimplemented. On macOS and Linux the native frame stays (`GITMANAGER_TITLEBAR=overlay` turns the overlay on for the acceptance scenario).

## Startup and tray

Three settings, all off by default (Settings, General):

- **Launch at Windows startup** writes the entry with `app.setLoginItemSettings({ openAtLogin, path: process.execPath, args: ['--launched-at-login'], name: 'GitManager', enabled })`: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\GitManager` = `"<install folder>\GitManager.exe" --launched-at-login`. It is refused in a development build (`app.isPackaged` false), so an entry never points at `electron.exe`. The switch shows what Windows will do (`app.getLoginItemSettings`, including Task Manager's StartupApproved state): an entry turned off in Task Manager reads as off, with the reason, and switching it on again re-approves it. The stored setting is corrected to match at every launch and whenever Settings opens. The uninstaller deletes the entry and its approval record (`build/installer.nsh`), except when an update runs the old uninstaller.
- **Start minimized** applies only when the process was started with `--launched-at-login`; a manual launch always opens the window. The window is created hidden and the tray icon shown.
- **Minimize to system tray** keeps a tray icon (the supplied ICO) while GitManager runs; minimizing hides the window from the taskbar. Clicking the icon restores the window; its menu has Open GitManager and Quit GitManager. Closing the window still quits (asking first when services run), and the tray icon is always present while the window is hidden, so a hidden GitManager can always be reached.

A launch at sign-in differs from any other launch only by the hidden window: no service is started, nothing is pulled or switched; automatic discovery runs in the background as usual. `app.requestSingleInstanceLock()` keeps one GitManager per user: a second launch (shortcut, startup entry) exits and brings the running window forward, from the tray if needed.
