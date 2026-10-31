<p><img src="assets/brand/GitManager-Summa-128.png" width="96" height="96" alt="GitManager logo: an emerald Git branch on a charcoal tile"></p>

# GitManager

A desktop workspace for managing Git repositories, syncing branches, and launching development projects with one click. Built with Summa-UI.

Open GitManager, select a repository, fetch and pull, pick a branch, press Run, open the app in Chrome. GitManager is a local tool: no server, no account, no cloud. It uses the Git you already have, with your existing configuration, remotes and credentials.

![GitManager running a frontend and a backend](docs/screenshots/09-services-ready.png)

## What it does

**Repositories**
- Automatic discovery at every launch: common development folders (`<home>\source\repos`, `<home>\Projects`, `C:\Projects`, `D:\dev` and similar, found from your home folder and drive letters, never from a user name) and the home folders of your WSL 2 distributions. Repositories appear in the list as they are found; worktrees are recognized, submodules and dependency folders are skipped, and the same folder reached through different paths (`\\wsl.localhost\...`, `/mnt/c/...`, junctions, letter case) is registered once. WSL scans stay on the Linux file system, so Windows drives are not scanned twice.
- Rescan from the add menu or Settings, and a deeper search of whole drives (or the whole home folder) on request. Discovery only registers repositories: it never pulls, switches, runs commands or writes to a repository.
- Register repositories yourself from a folder picker, a typed path, or a WSL path (`\\wsl.localhost\Ubuntu\home\me\app`, or `/home/me/app` with a distribution), or search folders you choose.
- A repository you remove stays removed: discovery remembers it (Settings lists them, with Restore).
- Searchable list with commits to pull or push and a marker when services are running. When repositories live in more than one environment, the list is grouped under headings (Windows, then each WSL distribution, for example `WSL (Ubuntu-24.04)`), so a project cloned in both is never ambiguous; searching for a distribution name narrows to it.
- Remove a repository from GitManager; the folder on disk is never touched.

**Git**
- Current branch, working tree (clean, changed, untracked, conflicts), relation to the upstream (up to date, ahead, behind, diverged, no upstream, upstream gone, detached), remote configured and reachable.
- Fetch, compare incoming and outgoing commits, pull fast-forward only, list local and remote branches, switch branches, create a tracking branch from a remote branch, recent commits, open the folder, open in your editor.
- Concise errors with Git's own output one click away.

**Branches**
- Each repository opens on its **Overview** (status, fetch and pull, development services). The **Branches** tab is the deeper view: every local and remote-tracking branch compared with the repository's real default branch, searchable, filterable (All, Local, Remote) and sortable (name, ahead, behind, recent activity).
- The default branch comes from Git metadata, never from the name: the remote's recorded HEAD (`refs/remotes/<remote>/HEAD`), or what the remote advertises (`git ls-remote --symref`, read-only). `main`, `master`, `dev` or anything else works. When it cannot be determined (no remote, several remotes without origin), GitManager says so and you choose a comparison base, which is remembered per repository.
- Ahead and behind come from the commit graph (`rev-list --left-right --count <default>...<branch>`, or the equivalent `for-each-ref %(ahead-behind)` in one call on Git 2.41+). States: Up to date, Ahead, Behind, Diverged, Unrelated. Upstream sync is a separate column, and local and remote branches are separate rows with their own counts.
- Opening a branch shows its reference, comparison base, counts, latest commit, the commits only on it, the commits on the default branch it lacks, and the files changed since the merge base. Switching (or creating a local tracking branch) is an explicit button that reuses the safe switch, including the running-services guard. Inspection itself only reads.
- Remote data is labelled with the time of the last fetch, so it is not mistaken for live GitHub state.

Removing a repository from the list never touches its files, and deleting its local folder is a separate, explicit action (right-click a repository, Delete local folder): inspected first, moved to the recycle bin or trash, never silently permanent, never anything on GitHub. See [Repository actions](docs/REPOSITORIES.md). Apart from that action, GitManager never discards changes, resets, force-pulls, rebases, merges, deletes branches (the Storage view deletes GitHub Actions artifacts only, and nothing else), force-pushes or stashes. Pull is `git fetch` followed by `git merge --ff-only --no-autostash`; a diverged branch, a missing upstream or conflicts are refused before anything runs, and when Git itself refuses (local changes would be overwritten) the repository is left exactly as it was.

**Development services**
- Each repository can have several profiles. A profile has a runtime (Windows, or a WSL distribution), a working directory, one or more services, a URL to open and a preferred browser (Chrome, Edge, system default).
- Each service has a command, a directory, environment variables, an optional env file and a readiness check (URL responds, or port open) with a timeout.
- Run starts all services concurrently; each has its own state (Starting, Ready, Running, Failed, Stopped) and its own output. A service is Ready only when its check passes; without a check it is Running, never Ready.
- Stop ends the process tree GitManager started (gracefully, then forced after a grace period). It never kills "whatever uses the port". If the readiness port is already taken before a start, GitManager refuses to start and leaves the other process alone.
- Switching branches while services run asks you to stop them first.
- Nothing from a repository is ever executed automatically. A profile runs only after you review its exact commands and trust it, and any change to a command, directory, environment or runtime asks again.

**Storage (GitHub Actions artifacts)**
- A **Storage** view in the sidebar answers three questions: what is consuming your GitHub Actions artifact storage, what can be deleted safely, and how much space that recovers. Scan reads every repository you can write to through your own GitHub CLI session (`gh auth login`): artifacts with size, dates, workflow, run, branch and commit, plus Actions caches and packages, listed separately and never added to the artifact total.
- Each artifact is classified Protected, Keep, Review or Delete candidate with the reason shown. Evidence and audit artifacts, the current release, open pull requests, pinned artifacts and protected repositories are never offered; the newest two successful builds of each kind (and the last usable installer of each platform) are kept; uncertain artifacts go to Review and are never selected for you. Age alone decides nothing.
- **Review cleanup** previews exactly what would be deleted, by repository, with reasons and the space recovered, then deletes through GitHub's documented artifact API after one explicit authorization. Every artifact is revalidated with GitHub immediately before deletion; anything that changed or became protected is skipped. Only artifacts GitHub confirms are gone count as reclaimed, and each attempt and outcome goes to a local, tamper-evident audit log.
- **Auto Cleanup** is off by default: manual, recommendations, or automatic safe cleanup per repository, daily, weekly or monthly, running only while GitManager is open. No token is ever requested, no service is installed, and Git branch management is untouched.
- It does not invent numbers: GitHub's API reports neither your included allowance nor package sizes, so GitManager shows neither, labels accrued GB-hours separately from stored bytes, and says "Billing data unavailable" when billing cannot be read. See [Storage](docs/STORAGE.md).

![Storage overview](docs/screenshots/storage-01-overview.png)

**Tools: Runners (GitHub Actions self-hosted runners)**
- A **Tools** entry in the sidebar holds developer utilities; the first is **Runners**. One table answers which runners you have, which are online, offline or busy (from GitHub), which system and machine host each one and whether it is native, WSL 2 or remote, where it is installed, which repository or organization it serves, its labels and version, and what GitManager can do with it.
- Automatic discovery: installations on this computer and in WSL 2 distributions (and on SSH hosts you allow), recognized by the runner's own metadata and service registrations, never by folder name; plus the runners GitHub lists for your repositories and organizations, read through your GitHub CLI sign-in. Local observations and GitHub facts are reconciled by runner id and kept apart; what could not be read is reported as a limitation.
- **Add runner**: platform, environment (this computer, a WSL distribution, an allowed SSH host), repository or organization, configuration, a reviewed plan with every command, then the real installation: official package, published SHA-256, extraction, the runner's configure with a one-time registration token, the service (systemd, launchd or Windows service), start, and verification against GitHub and the local state. A failure stops at its step and reports exactly what was done.
- Start, stop, restart, inspect, logs, check for updates, update in place, remove the registration, uninstall (the exact directory shown first), each only when possible and safe; a busy runner is never interrupted without an explicit confirmation. Tokens are never stored or shown. See [Runners](docs/RUNNERS.md).

![Runner inventory](docs/screenshots/runners-03-inventory.png)

**Window and startup**
- On Windows there is no separate title bar: Windows' own minimize, maximize (with Snap layouts) and close buttons sit on the charcoal main panel (`#1B1C1C`), beside the repository header, and the GitManager logo and name are at the top of the sidebar. Drag the top of the window to move it, double-click to maximize; resizing and Snap work as in any Windows app.
- Settings, General (all off by default): **Launch at Windows startup**, **Start minimized** (only for that automatic start: GitManager waits in the notification area) and **Minimize to system tray** (click the tray icon to bring the window back; its menu has Open GitManager and Quit GitManager).
- The startup switch shows what Windows will actually do, including an entry turned off in Task Manager. The entry points at the installed `GitManager.exe` and is removed when GitManager is uninstalled.
- Starting with Windows never starts services, pulls or switches branches. One GitManager runs at a time; starting it again brings the open window forward.

## Windows and WSL 2

- Native repositories use the Git on your PATH. WSL repositories use the Git inside their own distribution through `wsl.exe --exec`, never Windows Git on a `\\wsl$` path.
- WSL services start inside the distribution (`bash -lc`, so your login PATH, nvm, SDKMAN and similar apply) in their own process group, so Stop can end the whole Linux tree.
- Readiness checks run from Windows against `localhost`, so Ready also proves the browser on Windows can reach the service. If it cannot, the message points at WSL localhost forwarding.
- A Windows drive repository can run its services in WSL (`C:\code\app` becomes `/mnt/c/code/app`). A WSL repository always runs in its own distribution.
- Nothing assumes a user name, a folder layout, a distribution or installed tools.

## Install and run

Requirements: Git, Node.js 22 or newer. For WSL repositories, WSL 2 with Git installed inside the distribution.

```bash
npm install
npm run build
npm start
```

If Electron reports a missing binary after `npm install` (some environments skip install scripts), run `node node_modules/electron/install.js`.

Development with hot reload for the interface: `npm run dev` (restart it after changing `src/main`, `src/core` or `src/shared`).

### Windows package

```bash
npm run package:win
```

produces an NSIS installer and a portable zip in `release/` (x64, unsigned, no auto-update). Build it on Windows; the GitHub Actions workflow builds the same package on `windows-latest` and attaches it to every run as the `GitManager-windows-x64` artifact. Windows SmartScreen warns about unsigned installers; choose "More info", then "Run anyway".

Your configuration (repositories, profiles, settings) lives in `%APPDATA%\GitManager\gitmanager.json` on Windows (`~/.config/GitManager` on Linux, `~/Library/Application Support/GitManager` on macOS). It is never written into a repository.

## Tests

```bash
npm run verify:summa-ui   # the pinned Summa-UI release is intact
npm run verify:branding   # logo colours, transparency, ICO frames, packaging icons
npm run typecheck
npm test                  # unit and integration tests: temporary Git repositories and real processes
npm run test:e2e          # the first-release acceptance scenario against the built app
npm run test:e2e:storage  # the Storage scenario: the real app against a stand-in for the GitHub CLI (no network, no real repository)
npm run test:e2e:menus   # the repository context menu, removal and deletion with a real trash, opaque menus measured in the real window, retiring an orphaned runner (Linux)
npm run test:e2e:runners  # the Runners scenario: discovery, GitHub reconciliation, the wizard installing a stand-in runner package, lifecycle (Linux)
node scripts/e2e-windows.mjs release/GitManager-<version>-x64.exe   # Windows: install and test the installed build
```

`npm run test:e2e` builds a CaissaTrainer-shaped project (a Vite frontend and a Spring Boot backend started with `./mvnw spring-boot:run`) in a real Git repository with a bare remote and a teammate clone, then drives GitManager through registration, fetch, fast-forward pull, branch switching, profile setup, Run, readiness, logs, Open in Chrome, Stop, restart of the app, and a refused unsafe pull. It needs Java and Maven, Chrome or Chromium, and a display (`xvfb-run` on Linux). It also checks the title bar layout, the tray, start minimized at sign-in and the single instance. It writes screenshots, Summa-UI check results and a step report to `e2e-output/`.

`npm run test:e2e:storage` launches the built app with `GITMANAGER_GH` pointing at `scripts/e2e/fake-gh.mjs`, a stand-in for `gh api` that serves a demonstration world of four repositories and applies deletions to it, then drives Storage: scan, tables, filters, sorting, pinning, cleanup preview, a dry run, real deletion with GitHub-confirmed results, the audit log, Auto Cleanup, persistence across a restart, and the sign-in and permission errors. Needs a display (`xvfb-run` on Linux); no Java or Chrome. It writes screenshots and a step report to `e2e-output/storage/`.

`npm run test:e2e:runners` launches the built app with the same stand-in GitHub CLI extended with the self-hosted runner endpoints, a registered installation on disk and a stand-in runner package served from a local folder (`GITMANAGER_RUNNER_PACKAGE_DIR`) whose `config.sh` registers with that world exactly as the real one would, then drives the Runners tool: discovery folders, scan, reconciliation with GitHub, search, filters, sorting, details, diagnostics, workflow matching, the wizard with a blocked plan and a real installation (verified download, extraction, registration token, GitHub verification), the narrow layout, protected operations, removing a GitHub-only registration, unregistering and uninstalling, Settings, and persistence across a restart. Needs a display (`xvfb-run` on Linux). It writes screenshots and a step report to `e2e-output/runners/`.

`scripts/e2e-windows.mjs` (Windows only, run by CI on `windows-latest`) installs the NSIS installer silently, starts the installed `GitManager.exe` and drives it with real Windows mouse and keyboard input: double-click and the caption buttons to maximize, restore and minimize, dragging and resizing, Win+Left, the colours around the caption buttons in both window states and at 150 % scale, the startup entry in the registry (including one turned off in Task Manager), minimize to tray, the second instance, and that uninstalling removes the startup entry.

## Documentation

- [Storage](docs/STORAGE.md): artifact inventory, classification rules, safe deletion, Auto Cleanup, and what the GitHub API cannot tell.
- [Repository actions](docs/REPOSITORIES.md): the right-click menu, removing a repository from GitManager and deleting its local folder safely.
- [Runners](docs/RUNNERS.md): the Tools section and the Runner Manager: discovery, installation, service management, WSL, permissions, security, troubleshooting and what was verified.
- [Live verification](docs/LIVE_VERIFICATION.md): qualifying Storage against real GitHub and Windows, with an independent reconciliation script.
- [Architecture](docs/ARCHITECTURE.md): modules, process model, security, Windows and WSL execution.
- [Summa-UI adoption](docs/SUMMA_UI_ADOPTION.md): pinned release, component reuse, deviations, check results, feedback filed.
- [Acceptance results](docs/ACCEPTANCE.md): what was verified, how, and what was not.
- [Branding](docs/BRANDING.md): the Summa application logo system and how GitManager uses it.
- [Third-party notices](THIRD_PARTY_NOTICES.md).

## License

MIT, see [LICENSE](LICENSE).
