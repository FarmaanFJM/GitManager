# Summa application logo system (proposed baseline)

## Invariants

- One rounded-square charcoal tile in exactly `#1B1C1C`.
- The area outside the tile is **transparent** (real alpha channel).
- One clear, application-specific symbol centered on the tile in exactly `#10B981` emerald.
- Flat vector shapes: no gradient, bevel, shine, glow, texture, shadow, lettering or decorative framing.
- Maintain ample padding and legibility at 32x32 and 16x16.
- Keep the tile shape, colors, padding logic and symbol weight consistent across future Summa product icons.
- Each application uses a different, semantically meaningful symbol. No change to other existing apps in this task.

## GitManager

- Symbol: git branch with three circular nodes and curved connecting line.
- Canonical source: `GitManager-Summa.svg`.
- Exports: transparent PNGs and a multi-size Windows `.ico`.
- Use the assets for app window, taskbar, installer, shortcut and README.

## Technical note

The SVG defines the official geometry and exact colors; raster exports are generated from it. Preserve transparency instead of exporting a black rectangular image.
