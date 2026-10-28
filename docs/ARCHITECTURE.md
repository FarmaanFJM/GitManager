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
    profiles.ts    trust fingerprint, env files, launch planning
    processes.ts   ServiceManager: spawn, readiness, logs, graceful tree termination
    readiness.ts   HTTP and TCP probes
    launchers.ts   Chrome and Edge discovery, opening URLs, editor command
    store.ts       configuration file: atomic writes, validation on load
    validate.ts    validation of everything that crosses a trust boundary
  shared/      types and the API contract shared by all three layers (type-only, plus the method list)
  main/
    backend.ts     application logic behind the API; validates arguments, returns Results
    ipc.ts         one ipcMain handler per API method, sender check, error mapping, event forwarding
    preload.ts     contextBridge: exposes exactly the API methods, nothing else
    main.ts        window, security settings, quit handling
  renderer/    React interface built from Summa-UI (see SUMMA_UI_ADOPTION.md)
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
