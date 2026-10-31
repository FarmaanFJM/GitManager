# Repository actions: remove and delete

Right-click a repository in the sidebar (or focus it and press Shift+F10 or the menu key). The menu uses Summa-UI's `Menu` on the opaque menu surface and acts on the row you clicked: the selected repository does not change, except through **Open repository**, or when the repository you remove or delete is the selected one (the repository that took its place is selected).

| Action | What it does |
| --- | --- |
| Open repository | Selects it. |
| Open folder | Opens the folder in the system file manager (WSL repositories through `\\wsl.localhost\<distro>`). |
| Copy folder path | Copies the path as registered. |
| Remove from GitManager | Forgets the repository and its profiles. **No file is touched.** The location is remembered in the ignored list, so automatic discovery and restarts do not bring it back; adding the folder manually lifts that. Disabled while its services run. |
| Delete local folder… | Deletes the project directory, `.git` included. **Never anything on GitHub.** See below. |

## Delete local folder

Opening the dialog changes nothing: the repository is inspected (read-only) and the dialog shows the name, the full folder (with the distribution for WSL), uncommitted changes, untracked files, commits not on the upstream (or, without an upstream, commits that exist on no remote), stashes, running services, nested repositories, linked worktrees and submodules. Work that would be lost needs a separate acknowledgement; an ordinary repository with such work can still be deleted after it. The button is a solid destructive button that names the destination ("Move folder to Recycle Bin").

**Recoverable by default.** Windows and macOS use the system recycle bin or trash (Electron's `shell.trashItem`). A WSL repository on the Linux file system uses the distribution's own freedesktop trash (`gio trash`, or `trash-put`); the Windows Recycle Bin cannot hold those files, and a repository under `/mnt/c` is trashed through its Windows path. If recoverable deletion is unavailable (no trash tool) or fails, **nothing is deleted** and the dialog says why; only then does it offer "Delete permanently", which needs its own acknowledgement and is a second request the backend also requires (`confirmPermanent`). There is no automatic fallback.

**Refused, whatever the confirmation:** drive roots, system folders, home folders and their ancestors, standard user folders; a folder that is a discovery root or contains one; a folder containing other registered repositories (it looks like a parent folder); a folder containing a GitHub Actions runner installation; a path that is, or passes through, a symbolic link or junction (register the real folder); a folder that is not the root of a working tree; a submodule folder; a repository whose linked worktree lives elsewhere (its Git data is here); and any repository whose GitManager-started services are running (stop them first, separately). A linked worktree itself can be deleted; GitManager then runs `git worktree prune` in the main repository. The backend re-runs all of this at the moment of deletion and requires the confirmed path to equal the registered path exactly.

**After a deletion.** The folder is checked on the file system; success is reported only if it is gone. Otherwise (a locked file, a trash that reported success but left the folder) the message says exactly what remains, and the repository stays in GitManager. On success the repository, its profiles and cached choices (selected profile, comparison base) are removed, repositories registered inside it are removed too, other repositories are untouched, the selection moves on, and a toast confirms. The location is not added to the ignored list: the folder is gone, so discovery has nothing to find, and a folder restored from the trash is discovered like any other. A repository whose folder is already missing is handled the same way and reported as "nothing was deleted".

## Verification

`test/repoDelete.test.ts` (real Git and file system for native repositories, the in-memory distribution for WSL): preview facts, protected paths on POSIX, Windows, UNC and WSL forms, parent folders, discovery roots, runner installations, symbolic links, submodules, worktrees, nested repositories, services, confirmation matching, missing folders, no trash, failing trash, a trash that lies, a locked file (partial deletion), state cleanup and rediscovery after removal and after deletion. `npm run test:e2e:menus` drives the real window: right-click, the menu's position and focus behaviour, removal, rescan, the deletion dialog and a real trash. Not verified on real systems: the Windows Recycle Bin and macOS Trash through `shell.trashItem`, WSL distributions with and without `gio`, and locked files on Windows; those paths use the same code with fakes.
