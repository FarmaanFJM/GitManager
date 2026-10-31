# Proposal for Summa-UI: opaque menus and popovers

Status: **not submitted as a rule.** This is the evidence and a suggested direction, recorded in the summa-ui repository as feedback issue FB-0046 (proposed classification `guidance-incorrect`, principle P07). Confirming the classification, drafting a proposal and approving a guidance version are the owner's decisions (summa-ui `CLAUDE.md`, `docs/FEEDBACK_WORKFLOW.md`). GitManager keeps working on the pinned `guidance-v0.1.0` in the meantime, with a local override.

## What the pinned release does

`src/styles/base.css` (guidance-v0.1.0) draws every `.popover` (the surface of `Menu`, `MenuButton`, `Dropdown`, context menus and GitManager's branch picker) as:

```css
background: color-mix(in srgb, var(--s4) 88%, transparent);
backdrop-filter: var(--glass);        /* blur(14px) saturate(1.2) */
```

and principle 7 says the theme is "matte, restrained, slightly glassy". 12 % of whatever lies behind a menu shows through its labels, and the blur does not hide text that is still legible at that opacity. In GitManager the three-dot menu of Runner Details opened over registration text, warnings and labels, and the two layers of text competed. `tokens.json` already says `--s4` is for "Menus, popovers, toasts, pressed states" and that elevation goes dark to light (P02); nothing says menus must be translucent.

## Suggested direction (for the owner to accept, change or reject)

1. `.popover` uses the solid `--s4` surface and no `backdrop-filter`. `--glass` stays available for anything the owner still wants glassy, or is retired.
2. P07 drops "slightly glassy" or limits it to non-text-bearing chrome.
3. The entrance animation of `.popover` (`pop-in`) fades from opacity 0, so a menu is translucent for its first frames; moving it with a transform only avoids that.
4. A check: a floating surface that carries text must have a computed background alpha of 1 and no backdrop filter.
5. Disabled menu items: `--text-3` on `--s4` is 2.45:1, below 3:1, so disabled actions are barely readable. A step brighter (GitManager uses a 55 % mix of `--text` into `--s4`, 4.2:1) keeps them clearly dimmer than enabled items and still readable.

Not proposed: any change to existing applications. They keep the version they recorded.

## What GitManager does meanwhile

`src/renderer/app.css` (loaded after the pinned CSS) overrides `.popover` for the whole application, and the pinned files stay byte for byte as released (`npm run verify:summa-ui` passes). The override and its measurements are described in [SUMMA_UI_ADOPTION.md](../SUMMA_UI_ADOPTION.md), deviation D14.
