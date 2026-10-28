# Third-party notices

## Included in this repository

| Component | Location | License | Notes |
| --- | --- | --- | --- |
| Summa-UI guidance bundle v0.1.0 | `third_party/summa-ui/guidance/` | Owned by FarmaanFJM (FarmaanFJM/summa-ui); the summa-ui repository has no license file at the pinned release | Vendored unmodified from tag `guidance-v0.1.0`, verified by digest. |
| Summa-UI reference implementation | `third_party/summa-ui/src/` | As above | `src/ui`, `src/presets`, `src/styles/base.css` from the same commit, unmodified, verified by sha256. |
| Summa-UI tooling | `scripts/summa-ui/verify-vendored.mjs`, `record-guidance-usage.mjs`, `collector.mjs` | As above | Copied unmodified from the release (`scripts/` and `scripts/lib/`). `verify-reference.mjs` and `checks.mjs` are GitManager's own. |
| Lucide icons (165-icon subset) | `third_party/summa-ui/guidance/icons/`, embedded in `third_party/summa-ui/src/ui/icons.tsx` | ISC, Copyright (c) Lucide Icons and Contributors | Full text in `third_party/summa-ui/guidance/icons/LICENSE`. |

## Bundled into the application

| Component | License |
| --- | --- |
| Electron (includes Chromium and Node.js) | MIT; Chromium's licenses ship with the packaged app as `LICENSES.chromium.html` |
| React, React DOM, scheduler | MIT, Copyright (c) Meta Platforms, Inc. and affiliates |

## Development only (not shipped)

TypeScript (Apache-2.0), Vite and @vitejs/plugin-react (MIT), Vitest (MIT), Playwright (Apache-2.0), electron-builder (MIT), resedit (MIT, reads icon resources in `scripts/verify-branding.mjs`), @types packages (MIT). The acceptance fixture downloads Vite (MIT), Spring Boot (Apache-2.0) and generates an Apache Maven Wrapper script (Apache-2.0) at test time; none of them are committed.

## Brand assets

`assets/brand/` holds the GitManager logo (SVG, PNG and ICO) and the Summa logo system description, supplied by the project owner for GitManager. `build/icon.ico` and `build/icon.png` are copies of the supplied ICO and 512 px PNG.
