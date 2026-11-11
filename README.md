# Zolf Mods Tab Notes

A [Sine](https://github.com/CosmoCreeper/Sine) mod for Zen Browser: attach a note to any tab.

## Features

- Right-click a tab → **Add Note...** (right above *Change Label*). When the tab already has a note the entry becomes **Delete Note...**.
- A small custom note window (not a system dialog): rich text with **bold**, *italic*, underline and strikethrough buttons, saved automatically while you type. `Enter` closes it, `Shift+Enter` adds a new line, `Esc` closes it.
- Tabs with a note get a discreet indicator: a **ribbon** or a note **icon** (next to the mute button on regular tabs; on Essentials you choose the corner/position). Hover it to peek at the note and edit it right there.
- While you are editing, the first click outside only closes the note - it never reaches the page or the tabs behind it.
- The note window uses the Zen colors of the current space. Size: small / medium / large.
- Indicator colors: black, blue, green, orange, pink, purple, red, white, yellow or the Zen accent color.

## Settings

The first entry of every dropdown is built into Zen/Sine and is the default choice of that setting.

| Setting | Options (default first) |
| --- | --- |
| Note indicator | Ribbon, Icon |
| Ribbon corner on essentials | Right, Left (only for Ribbon) |
| Icon position on essentials | Top left, Top right, Bottom right, Bottom left, Middle high, Middle low (only for Icon) |
| Indicator color | Yellow, Black, Blue, Green, Orange, Pink, Purple, Red, White, Zen accent color |
| Note window size | Medium, Small, Large |

## Where notes are stored

- In the tab's session data (so a note comes back with *Restore closed tab*).
- In `zolfmods-tab-notes.json` in your Firefox profile folder, keyed by the tab id (so it survives restarts, also for pinned tabs and Essentials). Notes older than 120 days whose tab no longer exists are removed from this file.
- Notes saved by the old *RandomZenTweaks* mod are imported automatically.

## Requirements

- Zen Browser
- Sine with **Allow installing JS from unofficial sources** enabled. JavaScript mods run in the browser's privileged UI context - install only if you trust the source.

## Installation

1. Zen: **Settings → Sine Mods** → enable installing JS from unofficial sources.
2. Install from GitHub: `MrZolf/ZolfModsTabNotes`.
3. Restart Zen.

After disabling the mod restart Zen so the script is unloaded.

## Files

- `theme.json` - Sine metadata and script registration.
- `preferences.json` - the settings above.
- `chrome.css` - styles of the indicator, the note window and the menu icon.
- `tab-notes.uc.js` - the privileged script.
# ZolfModsTabNotes
