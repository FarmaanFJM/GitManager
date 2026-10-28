# Branding: the Summa application logo system

GitManager is the first application to use the Summa application logo system (`assets/brand/SUMMA-LOGO-SYSTEM-v2.md`, supplied by the owner as a proposed baseline). This page documents how GitManager applies it and how a future Summa application should reproduce it. It describes application identity only; it does not change the approved Summa-UI guidance (see "Relation to Summa-UI" below).

<img src="../assets/brand/GitManager-Summa-128.png" width="64" height="64" alt="GitManager logo">

## The system

| Rule | Value |
| --- | --- |
| Tile | One rounded square, exactly `#1B1C1C` (Summa-UI's `--s1`, the main panel surface) |
| Symbol | One flat, centred symbol, exactly `#10B981` (Summa-UI's `--accent`, emerald) |
| Outside the tile | Transparent (real alpha channel, never a black square) |
| Not allowed | Gradients, glow, shadows, gloss, textures, outlines, initials, lettering |
| Geometry (1024 canvas) | Tile `x=48 y=48 w=928 h=928 rx=198`; symbol drawn with a 54 px round-capped stroke and 62 px radius nodes inside roughly the middle 60 % |
| Symbol | Different for every application and taken from what it does |

GitManager's symbol is a Git branch: a vertical trunk between two nodes and a curved branch to a third node.

## Files

| File | Use |
| --- | --- |
| `assets/brand/GitManager-Summa.svg` | Canonical source. Defines the geometry and the two colours. |
| `assets/brand/GitManager-Summa.png`, `-512`, `-256`, `-128`, `-64`, `-32` | Supplied raster exports (RGBA). README, documentation, Linux and macOS icon (`build/icon.png` is the 512 export). |
| `assets/brand/GitManager-Summa.ico` | Supplied Windows icon: 16, 24, 32, 48, 64, 128 and 256 px frames. `build/icon.ico` is a byte-identical copy. |
| `assets/brand/SUMMA-LOGO-SYSTEM-v2.md` | The owner's description of the system, as supplied. |

The supplied files are used unchanged. They were not regenerated or redrawn.

## Where GitManager uses it

| Place | How |
| --- | --- |
| Windows executable | electron-builder `win.icon: build/icon.ico` embeds the ICO in `GitManager.exe` |
| Installer and uninstaller | `nsis.installerIcon`, `uninstallerIcon`, `installerHeaderIcon` |
| Desktop and Start menu shortcuts | created by the installer (`createDesktopShortcut`, `createStartMenuShortcut`), which point at the executable and so show its icon |
| Taskbar and title bar | the executable's icon, and `BrowserWindow({ icon })` set to the ICO on Windows (the 256 PNG elsewhere) |
| Notification area | the tray icon (Minimize to system tray, Start minimized) uses the ICO on Windows, so Windows picks the 16, 24 or 32 px frame for the display scale; the 32 px PNG elsewhere |
| Title bar | there is no separate title bar on Windows: the sidebar's brand row (logo and name) is its left part, next to Windows' caption buttons on the charcoal panel (see ARCHITECTURE.md, Title bar) |
| In the app | the sidebar's brand row (Summa-UI's `.brand`) shows the SVG at 24 px; the page icon is the SVG |
| README and GitHub | the 128 px PNG at the top of the README |

## Verification

`npm run verify:branding` (also in CI) checks, without image libraries:

- the SVG contains exactly the two brand colours, a rounded tile, and no gradient, filter, text, image or effect;
- every PNG is 8-bit RGBA with transparent corners, contains exactly `#1B1C1C` and `#10B981`, and every opaque pixel is one of the two colours or an anti-aliasing blend of them (anything else would be a gradient, glow or shadow);
- the ICO has all seven frames with transparency;
- packaging points the executable, installer, uninstaller and shortcuts at `build/icon.ico`, which equals the supplied ICO, and the window icon is packaged.

With `--exe <file>` it also reads the icon resources of a built Windows executable and requires all seven GitManager frames byte for byte. The CI Windows job runs it on the packaged `GitManager.exe` and on the installer, and the same check fails on Electron's stock `electron.exe` (0 of 7 frames), so a build that still carried the default Electron icon would fail.

### Findings on the supplied ICO

The supplied ICO's frames were downsampled with a sharpening (ringing) filter:

- the 16 to 64 px frames contain overshoot greens (for example `#0FC98B`, brighter than `#10B981`) and a few dark reddish fringe pixels (for example `#1C1115`) next to the symbol;
- the 24 px frame contains no pixel of exactly `#10B981`; the 16, 32 and 48 px frames contain only a handful.

At actual size the difference from a clean rendering is barely visible (compared at 16, 32 and 48 px on dark and light backgrounds), so the supplied ICO ships as supplied, and the verifier reports these as warnings. If exact colours at small sizes matter, the owner can re-export the ICO from the canonical SVG with a renderer that does not sharpen (for example resvg or librsvg, nearest or box downsampling); note that below about 20 px the 54 px stroke is thinner than one pixel, so no faithful rendering has fully emerald pixels at 16 px.

## For the next Summa application

1. Copy the SVG, keep the tile `rect` exactly as it is, and replace only the `<g>` with the new symbol, using the same stroke width (54), round caps and joins, node radius (62) where nodes are used, and the same visual weight and padding.
2. Choose a symbol that shows what the application does. No letters.
3. Export PNGs at 1024, 512, 256, 128, 64 and 32, and an ICO with 16, 24, 32, 48, 64, 128 and 256 frames, keeping transparency. Prefer a renderer without sharpening.
4. Run a check equivalent to `scripts/verify-branding.mjs` (it is self-contained; change the file names).
5. Use it for the executable, installer, shortcuts, window and in-app brand row, as in the table above.

## Relation to Summa-UI

Summa-UI v0.1.0 has a `Brand` component whose mark is an emerald square with the generic `layers` icon. GitManager keeps Summa-UI's brand row (`.brand`: layout, type, spacing) and shows its own logo instead of that generic mark, because the logo system gives every application its own symbol on a charcoal tile. The approved guidance was not changed. The difference is recorded as feedback in summa-ui (FB-0010) so the owner can decide whether the logo system becomes part of the guidance.
