# Changelog

## 1.0.2

**Terminal**
- Right-click pastes (or opens a small Copy / Paste menu over a selection). Ctrl+V, Shift+Insert and Ctrl+Shift+V paste. Pasted text is never run: trailing line breaks are dropped and nothing sends Enter. Ctrl+C is still the interrupt.
- New **Settings > Terminal**: default shell (PowerShell, PowerShell 7, WSL distribution), font, size, line height, cursor, scrollback, Select to copy, Copy in context menu, Right-click to paste. Saved between restarts and applied to open terminals. The Select to copy switch moved here from the terminal header.
- **Placeholder completion**: paste a command with `YOUR_TOKEN`, `<API_KEY>`, `{{ name }}` and the like and a compact dialog asks for the values, masks secrets, lets you review the result and inserts the corrected command without running it. Conservative detection; Paste Original and Cancel always available. See [docs/TERMINAL.md](docs/TERMINAL.md).

**Changes**
- New **Changes** tab and a "Changes, N files" summary on the Overview; changed-file counts in the repository list. Staged, unstaged, untracked, deleted, renamed and conflicted files with readable, highlighted diffs.
- Stage, unstage, discard (confirmed, with a recovery command), restore deleted files, delete untracked files (trash first), stage / unstage / discard single hunks, commit, open in editor. Multi-select and batch operations.
- **Stashes**: stash (message, untracked), preview, apply, pop, drop with confirmation; applying never overwrites local changes. See [docs/CHANGES.md](docs/CHANGES.md).
- The view refreshes when the repository changes outside GitManager (no polling).

**Branches**
- Select one, several, a range, all visible or all eligible; deletion status per branch; **Delete…** with `git branch -d` for safe branches and a separate, acknowledged `-D` for branches whose commits exist nowhere else.
- **Clean Local Branches**: optional fetch and prune, a preview of merged, upstream-gone, unmerged and protected branches, per-branch recheck, partial results, and a recovery command (with Restore) for every deletion. Remote branches are never deleted. See [docs/BRANCHES.md](docs/BRANCHES.md).

**Blockers**
- A refused pull, switch or deletion now says what is in the way (files, services, worktree, lock, permission) and offers only the actions that resolve it: View Changes, Stash Changes, Stop services, Open Worktree, Switch to the default branch.

**Under the hood**
- Version 1.0.2. New IPC methods for working-tree, stash and branch operations (arguments validated in the main process, Git run with argument arrays). `OpError` can carry a `blocker`.

## 1.0.1 and earlier

See the Git history and the release notes of each tag.
