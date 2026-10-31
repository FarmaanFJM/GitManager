# Storage: GitHub Actions artifact maintenance

GitManager's **Storage** view finds what is using your GitHub Actions artifact storage, separates what is safe to delete from what must stay, shows what a cleanup would recover, deletes only what you approve, and can optionally do the routine part on a schedule. Open GitManager, Storage, Scan, Review cleanup, Delete.

It is a maintenance tool for build output, not a dashboard of invented numbers: every figure comes from the GitHub API through your own GitHub CLI session, and every limit of that API is stated in the interface.

![Storage overview](screenshots/storage-01-overview.png)

## Requirements and sign-in

- The [GitHub CLI](https://cli.github.com) (`gh`) signed in: `gh auth login`. GitManager runs `gh api` and uses that session. **It never asks for a token, never reads one (`gh auth token` is not used), never logs or stores one, and sends nothing to any server of its own.**
- Scanning needs read access (any `gh auth login` session). Deleting needs write access to the repository's Actions: with a classic token that is the `repo` scope, which `gh auth login` grants by default.
- Without the write scope GitManager stays read-only and says so, with the command to fix it: `gh auth refresh -s repo`. It requests no other privilege by itself. Two optional extras need more scope, and the interface says which when they are missing: package listing (`gh auth refresh -s read:packages`) and billing (a classic token needs the `user` scope).
- Missing sign-in, a missing CLI and insufficient permission are reported separately.

## Discovery

**Scan** inventories every repository you can write to (Settings in Auto Cleanup: all you can write to, or only the ones you own; archived ones optional) using paginated calls, four repositories at a time. A repository that cannot be read is listed as such and does not affect the others. For each repository GitManager reads:

| Data | Endpoint |
| --- | --- |
| Repositories and your permission | `GET /user/repos` |
| Artifacts (name, size, created, expires, run, branch, commit) | `GET /repos/{o}/{r}/actions/artifacts` |
| Workflow runs (workflow, conclusion, event, pull requests) | `GET /repos/{o}/{r}/actions/runs`, then `.../runs/{id}` for runs not in the list (at most 60 per scan; completed runs are cached for the session) |
| Open pull requests | `GET /repos/{o}/{r}/pulls?state=open` |
| Releases and the commit of their tags | `GET /repos/{o}/{r}/releases`, `GET /repos/{o}/{r}/commits/{tag}` |
| Documentation (root and `docs/` Markdown, at most 15 files of 256 KB) | `GET /repos/{o}/{r}/git/trees/HEAD`, `.../contents/{path}` |
| Actions cache usage and entries | `GET /repos/{o}/{r}/actions/cache/usage`, `.../actions/caches` |
| Packages | `GET /user/packages?package_type=...` |
| Billing for the current month | `GET /users/{login}/settings/billing/usage` |

### What the numbers mean

- **Retained artifacts** is the sum of the sizes of artifacts that have not expired, as of the last scan. Expired artifacts are listed but hold no bytes and are excluded.
- **Actions caches** are shown separately. They have their own allowance (normally 10 GB per repository), are evicted automatically by GitHub, and do not count against the pooled artifact and package storage. They are never added to the artifact total. GitManager lists them read-only; it does not delete caches.
- **Packages** are listed (name, type, visibility, version count). GitHub counts Packages and Actions artifacts against the **same pooled storage allowance**, so the artifact total can understate what counts against it. **The GitHub API does not expose package sizes**, so none are shown and none are estimated.
- **Billing** shows what GitHub reports for the month: storage accrued in **GB-hours** and runner **minutes**. GB-hours are accumulated over time, not bytes stored now, and are never converted into or added to the retained-bytes figure. **GitHub's API does not report your included allowance**, so GitManager shows no allowance, remaining quota or percentage and does not estimate one. If billing cannot be read it says **Billing data unavailable** and links to GitHub's billing page. Organization-owned repositories are billed to the organization.
- After a deletion GitHub can take time to recalculate storage usage and billing; github.com may lag behind the real state.

## Classification

Every non-expired artifact is classified, and the reason is shown. Age alone never decides anything.

| Class | Meaning | Examples |
| --- | --- | --- |
| **Protected** | Never offered, not selectable. | Protected repository, pinned artifact, evidence (name or workflow matches `qualification`, `audit`, `evidence`, `attestation`, `provenance`, `sbom`, or your own words), cited by documentation, built for the current release (latest published release, drafts, latest pre-release) |
| **Keep** | Retained by the rules, not selectable. | Its workflow run is still active, one of the newest N successful builds of its family on its branch (default 2), an open pull request's newest builds, the last usable installer of a platform and architecture, or a superseded build held back by an optional grace period (shown as Grace period) |
| **Review** | Uncertain, never selected for you. | Failed or cancelled output (unless your policy allows it), a build of a release tag that is not the current release, GitHub metadata missing, too few newer successful builds, purpose not recognised, category not enabled, or any case where a lookup failed |
| **Delete candidate** | Redundant build output, verified. | N newer successful builds of the same workflow, output, platform, architecture and branch already exist, nothing above applies, every lookup it depends on succeeded, and the optional grace period (default none) has passed |
| **Expired** | Already purged by GitHub. | Nothing to reclaim |

How the rules work:

- **Verified supersession, not age.** A routine successful CI build becomes a delete candidate the moment N newer successful builds of its family exist on the same branch, with no waiting period by default. If a repository produces thirty 250 MB installers in one day, the newest two are kept and the other 28 are candidates immediately. Every candidate states the evidence in its reason: how many newer successful builds exist, which branch, and whether a grace period applies.
- **Compatible families and channels.** Builds are compared only with builds of the same workflow file, output purpose (installer, build, CI report, log), platform, architecture and normalised name (version numbers, commit ids and run numbers are ignored), and the same *channel*: the default branch, one other branch (each pull request's branch is its own), or one release tag. A Windows x64 installer is never superseded by an arm64 or Linux build, and an experimental pull request build never supersedes the default branch's last usable installer.
- **Newest N successful.** Only completed runs that concluded `success` count as successors; a run still in progress or a failed run never supersedes anything. A protected artifact still occupies one of the newest-N slots. N is at least 1 and is set per repository.
- **Optional grace period.** The policy can retain superseded builds until they are a number of days old (and the same for CI reports and logs). It defaults to 0, so immediate supersession-based cleanup is always possible; a nonzero value only delays eligibility and is shown as "Grace period" with the date it ends.
- **Failed and cancelled output.** Output of failed or cancelled runs is Review by default, however many newer successful builds exist, because it may be the only evidence of a problem. The grace period does not apply to it, so changing the grace period alone can never reclaim it. Two ways forward, both explicit:
  - **Manual review (no policy change).** Failed output that N newer successful builds of the same workflow, output, platform, architecture and branch already supersede is flagged *superseded failed output* (Review, reason code `failed-superseded`). Review cleanup lists it in its own group, "Failed or cancelled output, superseded", with nothing selected; you can tick items or use "Select all superseded failed output", then delete with the same single authorization. It is never selected by "all verified delete candidates" and is never deleted automatically. Release builds, current-release artifacts, evidence and audit artifacts, pinned artifacts and protected repositories are Protected before this rule applies; the newest N successful builds are Keep; failed output on an open pull request's branch stays an ordinary failed-run Review and is not in the group.
  - **Failure-output policy (opt-in).** "Offer once superseded" (with its own number of days) makes such output a Delete candidate for the manual preview. Automatic cleanup still never deletes it.
- **CI installers are not releases.** A successful installer uploaded after every merge or pull request is ordinary build output, whatever its name says (`...-release-...`, `...-setup`, `...-installer`). Only a run on the tag of a current release (latest published release, drafts, latest pre-release), or for its commit, makes an artifact Protected. A run on any other release tag or a `release` event is a release build and is never offered automatically (Review). A GitHub Release's own assets are a different object that GitManager neither lists nor deletes.
- **Last usable installer.** For each platform and architecture, the newest successful installer (preferring the default branch) is kept whatever the policy says.
- **Documentation.** A run URL (`.../actions/runs/{id}`) in the documentation protects that run's artifacts. An artifact name protects it only if the name is unique in the repository, because a recurring name such as `app-windows-x64` says nothing about one particular build.
- **Context.** If pull requests, releases, documentation or runs could not be read, candidates move to Review ("Could not check ..."). Missing metadata (run, creation date, branch or workflow) also means Review. GitManager does not guess.
- **Heuristics.** Categories and purposes are inferred from names and workflow metadata, never from file contents. `node scripts/verify/live.mjs explain --repo <owner/name>` prints, per artifact family, which rule holds every copy and what the inventory would reclaim under other grace periods.

## Repository details

Select a repository for a sortable, searchable table: artifact, type, size, created, workflow and run (opens the run on GitHub), branch and commit, classification and reason. Filters: All, Protected, Keep, Review, Delete candidate, Expired. The row menu pins an artifact (never deleted); the repository menu protects the whole repository, opens its cleanup policy or its Actions page. Pins and protections are stored locally in GitManager's configuration file.

![Repository artifacts](screenshots/storage-03-repository-artifacts.png)

## Cleanup preview and deletion

**Review cleanup** shows exactly what would be deleted, grouped by repository: each artifact with size, date, reason and run, the repositories affected, and the total that would be recovered. All verified candidates are selected; you can untick any, a whole repository, or all of them. Review (uncertain) artifacts are listed apart, never selected, and can be ticked individually. Protected and kept artifacts are listed as excluded with their reasons. Large lists stay readable: eight artifacts per repository are shown with "Show all".

![Cleanup preview](screenshots/storage-04-cleanup-preview.png)

There is one explicit authorization: the red button, whose label states the count, the size and that it is permanent. **Check without deleting** runs the same revalidation and sends no deletion request.

Before anything is deleted, per repository and per artifact, GitManager:

1. reads the repository again (permission, archived state) and re-classifies it with the current pins, protections and policy;
2. requires the artifact to still exist with the same id, name, size and workflow run, and to have the classification it had in the scan, else **skips it** (changed, now protected, now kept);
3. reads the artifact once more immediately before the request;
4. writes the attempt to the audit log, then sends `DELETE /repos/{o}/{r}/actions/artifacts/{id}` for that one artifact.

GitHub Releases and release assets are never touched (they are different endpoints GitManager does not call). There is no wildcard or bulk endpoint: ids are validated integers, one request each, paced about a second apart. GitManager never tries to get around a permission error: on `403` it stops that repository and carries on with the others; on `401` it stops everything; on a rate limit it waits if GitHub says it will lift within a minute and otherwise stops and reports the remainder as not attempted. Cancel stops after the current artifact.

**Results are GitHub's, not a prediction.** After the deletions the repository is listed again; an artifact counts as deleted only if GitHub no longer lists it. Per artifact the result is one of: deleted (confirmed), accepted but still listed (unconfirmed, not counted), already gone, skipped (changed or protected), denied, rate limited, failed, not attempted. Then the affected repositories are re-scanned so the screen shows GitHub's numbers.

![Result](screenshots/storage-06-cleanup-result.png)

### Audit log

`storage-audit.jsonl` next to `gitmanager.json` records artifact id, name, repository, workflow run, size, time, trigger (manual or scheduled) and outcome. An attempt is written before the request and its result after, so an interrupted run leaves a visible attempt that the next scan settles (gone means deleted, still listed means it did not happen). Each line contains the hash of the previous one; editing, removing or reordering a line is reported in the Activity tab. It contains no credentials and never leaves the computer.

## Auto Cleanup

Off by default. Nothing is scheduled, scanned or deleted until you turn it on.

![Auto Cleanup](screenshots/storage-08-auto-cleanup.png)

- **Modes, per repository.** *Manual*: scan and clean only when you ask (scheduled scans skip these repositories). *Automatic recommendations*: scheduled scans prepare suggestions and nothing is deleted; they appear as a banner to review. *Automatic safe cleanup*: scheduled runs delete only verifiably superseded builds and reports whose context was fully read, under a policy you approved. Failed output is never deleted automatically.
- **Policy** (per repository, plus a default that starts Manual): number of newest successful builds to keep, an optional grace period for superseded builds and for reports and logs (default 0), what to do with failed or cancelled output (default: only you decide), categories that may become candidates, evidence words that are always preserved, and the size above which an automatic run waits for your approval instead of deleting ("require manual review for large deletions", default 1 GB).
- **Approval.** Automatic safe cleanup needs an explicit approval of exactly the values shown. Changing any value withdraws it and the repository runs as *recommendations* until you approve again.
- **Presets** (Summa: strict evidence preservation; Herc's Adventure: newest two builds; Markdown Studio: newest two installers per platform; GitManager: newest two Windows builds) only fill the form for you to review. They are proposals, not safety guarantees, are not applied to any repository by name, and do not know which of your artifacts are "private" or "verified".
- **Schedule.** Daily, weekly or monthly. The view shows the next scheduled scan, the last scheduled run and the last completed cleanup. **The schedule runs only while GitManager is running**, including minimized to the tray. If GitManager was closed when a run was due it runs shortly after the next launch. No Windows service or scheduled task is installed, and GitManager's startup and tray settings are unchanged (starting with Windows is its own opt-in in Settings). Closing GitManager means nothing runs.
- **Run now** performs one pass with the same rules, which is how to see what automation would do.
- **Alerts** in Storage (all can be switched off): sharp growth since the previous scan, a repository keeping many large copies of one build, old builds being a large share of storage, a quota error reported by GitHub while GitManager is talking to it, and a scheduled cleanup or scan that failed. An optional warning level in GB is your own number: GitManager cannot read your allowance and will not guess one. Optional system notifications are one quiet line per scheduled run.

## Verifying cleanups

Set `GITMANAGER_GH_REQUEST_LOG` to a file and GitManager appends one line per `gh api` request (time, method, path; never a header, body or credential) and phase markers (`MARK BEGIN scan`, `MARK BEGIN cleanup dryRun=true|false`, `MARK END ...`). A read-only scan or dry run contains only GET; a deletion is legitimate only as a single-artifact `DELETE /repos/{o}/{r}/actions/artifacts/{id}` inside a `cleanup dryRun=false` phase, once per audit attempt. A log that spans a scan and a cleanup therefore *does* contain DELETEs: 23 confirmed deletions in the audit log correspond to exactly 23 DELETE requests, one per artifact, and `node scripts/verify/live.mjs requests <log> --audit <storage-audit.jsonl>` checks that mapping and reports any DELETE outside an authorized phase, any other mutation, any repeat, and any mismatch with the audit log. `--expect none` is for a log taken before the cleanup. After a cleanup, `node scripts/verify/live.mjs deletions --audit <storage-audit.jsonl>` confirms every deleted id is gone from GitHub and that none of them would be Protected or Keep when the pre-deletion inventory is rebuilt.

## Packages permission

Listing packages needs the `read:packages` scope: GitHub's REST documentation for `GET /user/packages` states that "OAuth app tokens and personal access tokens (classic) need the `read:packages` scope". A default `gh auth login` session (`repo`, `read:org`, `gist`) lacks it, so GitManager reports Packages as unavailable with the fix. The minimum addition, and the only scope added, is:

```
gh auth refresh -h github.com -s read:packages
```

Without it everything else works. Even with it, the API returns name, type, visibility, version count and repository but no size, so package bytes are never shown. (Fine-grained tokens are not documented for these endpoints.)

## Limitations

- GitHub does not report included storage allowance, package sizes, or cache costs, so GitManager shows none of them. Billing needs extra permission and may be unavailable.
- GitManager does not see workflow uploads as they happen. A *storage quota exceeded* failure inside a workflow is not observed; the quota alert fires only when GitHub reports it in a response GitManager receives.
- Only artifacts that GitHub still lists can be found. Per scan: 10,000 artifacts per repository, 500 recent workflow runs plus up to 60 looked up individually, 15 documentation files.
- Classification is conservative inference from names and workflow metadata. "Private" or "verified" builds, qualification status and "ongoing audit investigations" are recognised only through your evidence words, pins, protected repositories and documentation references.
- Repositories in WSL or on Windows are irrelevant here: GitHub is addressed by repository name through `gh`, independent of local clones. Cleanup is separate from Git branch management; GitManager still never deletes branches.
- Caches and packages are inventoried read-only; they cannot be deleted from GitManager.
- Artifact deletion cannot be undone by GitManager or by GitHub.

## Where things are stored

| What | Where |
| --- | --- |
| Settings, policies, protected repositories, pins | `gitmanager.json` (`storage` key), local |
| Last scan | `storage-state.json`, local |
| Audit log | `storage-audit.jsonl`, local |
| Credentials | Not stored by GitManager; `gh` holds the session |
