# First-release acceptance

`scripts/e2e.mjs` runs the first-release scenario end to end against the built application. The results below are from the run recorded in [`acceptance-report.json`](acceptance-report.json), on Linux (Electron 45 under Xvfb), with real Git repositories, a real Vite dev server, a real Spring Boot application started by `./mvnw spring-boot:run`, and Chromium as "Chrome".

## The fixture

A CaissaTrainer-shaped project (`scripts/e2e/template`): `frontend/` with `npm run dev` (Vite on port 5173, proxying `/api` to the backend) and `backend/` with a Spring Boot 3.3 application on port 8080 and a generated Maven wrapper. It is committed to a fresh repository, pushed to a bare `origin`, and cloned twice: the clone registered in GitManager and a teammate clone that pushes changes during the run.

## Results: 23 of 23 steps passed

| # | Scenario step | Verified by |
| --- | --- | --- |
| 1 | Open GitManager | first-run empty state shown |
| 2 | Register an existing repository | Add repository dialog with the clone's path; listed in the sidebar |
| 3-5 | Branch and working tree status | `main`, Clean, Up to date, `origin, reachable` (a real `git ls-remote`) |
| 6 | Uncommitted work detected | `README.md` edited outside GitManager; Refresh shows "1 changed" |
| 7 | Fetch | the teammate pushed 2 commits; after Fetch, `HEAD` is unchanged |
| 8-9 | Ahead, behind or diverged | "2 commits to pull", Pull 2 appears, History lists the incoming commits |
| 10 | Fast-forward pull | `HEAD == origin/main`, the uncommitted edit is intact, `git stash list` is empty |
| 11-12 | Switch branch without losing work | `origin/feature/board-themes` chosen in the picker creates a tracking branch; the uncommitted edit came along |
| 13 | Configure and select a profile | Frontend (`npm run dev`, `frontend`, ready when http://localhost:5173 responds) and Backend (`./mvnw spring-boot:run`, `backend`, ready when port 8080 is open) |
| 14-16 | Start both, observe progress | trust confirmation lists both commands; Backend shows Starting while Maven runs; each becomes Ready only when its own check passes |
| 17-18 | Logs | Spring Boot's "Started App" and Vite's banner in each service's output |
| 19 | Open in Chrome | GitManager launches the configured Chrome; the test reads the open tab over the DevTools endpoint: `http://localhost:5173/`, title "CaissaTrainer · backend UP" (the page reached Spring Boot through Vite) |
| 20 | Branch switch while running | the confirmation "Stop services to switch branches?" appears; Cancel leaves the branch unchanged |
| 21 | Stop both | both Stopped; ports 5173 and 8080 closed; the Spring Boot JVM (a grandchild of the shell GitManager started) is gone |
| 22 | Close and reopen | repository, profile, selected profile and branch restored from the configuration file |
| 23 | Unsafe operation refused | a local commit and a teammate commit make `main` diverge; Pull is refused with an explanation; `HEAD`, the working tree and the stash are unchanged, and the remote file did not appear |

Screenshots of each stage are in [`screenshots/`](screenshots/). The same scenario also ran Summa-UI's objective checks on five screens (see [SUMMA_UI_ADOPTION.md](SUMMA_UI_ADOPTION.md)).

The automated tests (`npm test`, 56 tests) additionally cover, against temporary repositories and real processes: status parsing for every change kind and every sync state, pull refusals (diverged, local changes would be overwritten, `pull.rebase` and `merge.autostash` configured), switch refusal when changes would be overwritten, branch name injection, tracking branch creation, process tree termination including grandchildren, a port already in use (refused, other process untouched), readiness timeout, forced stop after the grace period, restart, concurrent services, configuration persistence and corrupt files, trust fingerprints, env files and path conversion.

## Not verified here

- **Windows 11 and WSL 2.** The development environment is a Linux container without Windows or WSL. The Windows branches (cmd.exe services, taskkill tree termination, Chrome discovery, Explorer) and the WSL branches (wsl.exe Git, `setsid` process groups, `--list --verbose` parsing, UNC paths, `/mnt` conversion) are covered by unit tests of the exact commands they construct, not by running them. The CI workflow runs the unit and integration suite on `windows-latest`, which exercises the native Windows process code for real; WSL is not available on hosted runners. Please run the scenario on a Windows 11 machine with a WSL repository before relying on the WSL path.
- **The Windows installer** is built by CI on `windows-latest` (electron-builder, NSIS and zip). It was not built or installed in this environment.
- **Real Google Chrome.** The run used Chromium through a small launcher script (a separate profile, `--no-sandbox` because the container runs as root, a debugging port so the test can read the tab). GitManager only received the launcher's path as "Chrome location"; on Windows it finds Chrome in its standard install locations.
- **Credential prompts.** The fixture remote is a local bare repository. GitManager leaves authentication to Git (credential helpers work; terminal prompts are disabled because there is no terminal); a remote that needs an interactive terminal prompt will fail with an authentication message instead of hanging.
