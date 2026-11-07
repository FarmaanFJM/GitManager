# Releasing GitManager

The application version is `version` in `package.json` (with `package-lock.json` in step). Electron's `app.getVersion()`, the Windows file and product version, the installer and the Add or remove programs entry, and the artifact names `GitManager-<version>-x64.exe` and `.zip` all come from it.

1. Set the version and merge it to `main`: `npm version <x.y.z> --no-git-tag-version` (updates the lockfile too).
2. Tag the merged commit and push the tag: `git tag v<x.y.z> && git push origin v<x.y.z>`.
3. The **Release** workflow checks out that tag, refuses to continue unless the tagged commit is on `main` and the tag is exactly `v<package.json version>`, builds the unsigned installer and zip, checks the version stamped into the files, installs the installer on Windows and runs the installed-build tests, then publishes the release with `SHA256SUMS.txt`. Run it again for an existing tag with the workflow's manual trigger.

`npm run verify:release` checks `package.json` against the lockfile (and the tag on a tag build). `node scripts/release/check.mjs --artifacts release` checks a finished build. CI runs both.
