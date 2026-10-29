# Live verification of Storage (real GitHub, real Windows)

Everything in Storage has been tested against mocks and a stand-in `gh`. This runbook is how to qualify it against the real GitHub API with your own `gh` session. It is ordered so that nothing can be deleted until the read-only phases have passed, and the only deletion is one disposable canary artifact.

`scripts/verify/live.mjs` re-reads GitHub independently with `gh api` and compares it with what GitManager stored. It is read-only except `canary-create` and `canary-cleanup`. It never runs `gh auth token` and never prints a credential. Run `npm run build` first.

Request logging for the proof of "only GETs": set `GITMANAGER_GH_REQUEST_LOG` to a file before starting GitManager. Every `gh api` call appends one line, ISO time, method and path, and nothing else (no headers, no bodies, no credentials; a unit test checks this).

```powershell
git fetch origin claude/magical-babbage-vwecrt; git checkout claude/magical-babbage-vwecrt
npm ci; npm run build
$env:GITMANAGER_GH_REQUEST_LOG = "$env:TEMP\gm-scan.log"; Remove-Item $env:GITMANAGER_GH_REQUEST_LOG -ErrorAction SilentlyContinue
npm start
```

Start it from the Start menu or a plain terminal; both should find `gh` (PATH, then `C:\Program Files\GitHub CLI\gh.exe` and `%LOCALAPPDATA%\Programs\GitHub CLI\gh.exe`).

## 1. Session

```powershell
node scripts/verify/live.mjs env
```

Shows the `gh` version, sign-in status (token line removed), the login and the scopes GitHub reports. Deletion needs `repo`. Missing `repo` only blocks the canary; everything else is read-only.

## 2. One read-only Scan

In GitManager: Storage, Scan once. Auto Cleanup stays off; do not open Review cleanup. Then:

```powershell
node scripts/verify/live.mjs requests $env:TEMP\gm-scan.log --expect none
```

Must report zero mutating requests. Any DELETE, POST, PUT or PATCH is a release blocker.

## Why is a family not reclaimable?

```powershell
node scripts/verify/live.mjs explain --repo FarmaanFJM/markdown-studio
node scripts/verify/live.mjs explain --repo FarmaanFJM/markdown-studio --save $env:TEMP\ms   # keep the raw inventory; re-run later with --from $env:TEMP\ms
```

Read-only. Prints each artifact family with its age range and the rule holding every copy, today's reclaimable total with the default age, and what-if totals for other ages and later days.

## 3 to 6. Independent reconciliation

```powershell
node scripts/verify/live.mjs reconcile --repos FarmaanFJM/GitManager,FarmaanFJM/summa --sample 20
node scripts/verify/live.mjs reconcile            # every scanned repository
```

The script reads the state file GitManager saved (`%APPDATA%\GitManager\storage-state.json`), pages through every artifact and run list on GitHub itself, and checks:

- the repository set against the documented eligibility rule;
- every artifact, field by field (id, name, size, created, expires, expired, run, branch, sha), including all pages;
- the retained-bytes total (non-expired bytes) per repository and overall;
- sampled workflow runs (workflow, status, conclusion, event, branch, sha, URL), including runs outside the first five run pages, which exercises the `GET .../actions/runs/{id}` fallback;
- cache usage per repository, kept apart from artifact bytes;
- package count; billing availability as the app reports it;
- the classification audit: for every artifact it re-derives from GitHub whether the app's class is justified (evidence words, release tag and its commit, open PRs, running runs, newest-N successful per family, last installer per platform, documentation run URLs). A delete candidate that violates any rule, or whose context lookup fails independently, is a FAIL. It prints sample artifacts per class and reason with the rule and the GitHub evidence.

Compare the "retained" and "reclaimable" figures it prints with the Overview tiles, and the delete-candidate total with the Review cleanup preview.

To exercise fail-closed behaviour without touching GitHub, scan with a sign-in that lacks access to pull requests or documentation for one repository (or run with the network down for a rescan): its delete candidates must move to Review with "Could not check ...". The unit tests cover each lookup.

## 7. Windows checks

- No console window flashes during Scan (processes start hidden).
- Close and reopen GitManager: Storage shows the last scan without new requests, then Scan again works.
- Files in `%APPDATA%\GitManager`: `gitmanager.json` (settings, `storage` section), `storage-state.json`, `storage-audit.jsonl` after the canary.
- Open run links open the right `github.com/.../actions/runs/<id>` page, and the billing link opens `github.com/settings/billing`.
- Press Stop during a Scan: the app stays usable and the previous results remain.
- No token or `Authorization` text in any file under `%APPDATA%\GitManager` or in the console output: `Select-String -Path "$env:APPDATA\GitManager\*" -Pattern 'ghp_|gho_|github_pat_|authorization|bearer'` finds nothing.

## 8. Dry run

Review cleanup, then Check without deleting. Do not press the red button.

```powershell
node scripts/verify/live.mjs requests $env:TEMP\gm-scan.log --expect none
```

Still zero mutations. The log must show a repository read, artifact list and run reads for every selected artifact's repository, and a GET of each selected artifact only in a real deletion (a dry run stops before the final per-artifact read by design; it re-reads the repository and re-classifies).

## 9. Canary deletion

```powershell
node scripts/verify/live.mjs snapshot --repos FarmaanFJM/GitManager --out before.json
node scripts/verify/live.mjs canary-create --repo FarmaanFJM/GitManager
```

This pushes a temporary orphan branch `storage-canary-<time>` holding only a canary workflow (the repository's own CI does not exist on that branch, so nothing else runs), producing three tiny artifacts named `gitmanager-storage-canary` with 1-day retention. It prints each artifact's id, size, run and sha. Record them.

Start a fresh request log, then in GitManager: Scan, open FarmaanFJM/GitManager, filter Review. The oldest canary artifact is Review because its purpose is not recognised and two newer successful artifacts of the same name exist. No policy is changed. Review cleanup, tick only that artifact under "Review", and press Delete. Then:

```powershell
node scripts/verify/live.mjs requests $env:TEMP\gm-canary.log --expect canary --repo FarmaanFJM/GitManager --id <artifact id>
node scripts/verify/live.mjs snapshot --repos FarmaanFJM/GitManager --out after.json
node scripts/verify/live.mjs diff before.json after.json --expect-id <artifact id>
```

(Take `before.json` after `canary-create` so the new canary artifacts are in it.) The request check proves exactly one `DELETE /repos/FarmaanFJM/GitManager/actions/artifacts/<id>`, a prior GET of that artifact, a fresh artifact listing after it, and no release, cache, package or branch mutation. The diff proves nothing else disappeared. Clean up:

```powershell
node scripts/verify/live.mjs canary-cleanup --repo FarmaanFJM/GitManager --branch storage-canary-<time> --yes
```

## After a cleanup: deletions and requests

```powershell
node scripts/verify/live.mjs deletions --audit "$env:APPDATA\GitManager\storage-audit.jsonl"
node scripts/verify/live.mjs requests $env:TEMP\gm-scan.log --audit "$env:APPDATA\GitManager\storage-audit.jsonl"
```

`deletions` proves every id the audit log confirms deleted is absent from GitHub and that none would have been Protected or Keep. `requests` expects DELETEs only inside authorized cleanup phases, one per audit attempt. Use `--expect none` only on a log from before any cleanup (scan and dry run). A log that contains both a scan and a cleanup is expected to contain the cleanup's DELETEs.

## 10. Audit log

```powershell
node scripts/verify/live.mjs audit
```

Verifies the hash chain, that every attempt precedes its result, the recorded fields, no credential text, and that editing an old entry in a copy is detected. The real log is never modified.

## 11. Auto Cleanup safety

Use the unit and acceptance tests for the semantics (`test/storage/service.test.ts`, `scripts/e2e-storage.mjs`), then on Windows confirm nothing is installed:

```powershell
Get-ScheduledTask | Where-Object { $_.TaskName -match 'GitManager' }
Get-Service | Where-Object { $_.Name -match 'GitManager' }
Get-ItemProperty HKCU:\Software\Microsoft\Windows\CurrentVersion\Run | Select-String GitManager
```

The first two must be empty; the third only if you enabled "Launch at Windows startup" yourself. Leave Auto Cleanup off and every repository on Manual.
