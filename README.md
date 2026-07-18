# SIGNAL DECAY

An open-world machine-survival prototype, playable in the browser.

**▶ Play: https://bpy4444.github.io/signal-decay/**

Crash-land on Vesper-9, recover the snarky ancient AI **WRECK**, and hack the planet's
machine ecosystem into your own army — disable machines with the Arc Caster, capture them
through WRECK's radial hack, ride them, and work your way up to the Colossus at the Relay Spire.

Everything is procedural at runtime — geometry, textures, audio. No assets, no build step;
Three.js loads from a CDN. If your machine struggles, add `?gfx=low` to the URL.

## Controls

| Key | Action |
|---|---|
| WASD / mouse | Move / look (click to lock pointer) |
| SHIFT | Sprint (gallop while mounted) |
| SPACE | Jump · hack-arc sever · climb (Halo) |
| LMB / RMB | Fire / aim · lunge-bite on a Strider |
| 1 / 2 / 3 | Scrap Rifle / Arc Caster / EMP Grenade |
| E | Interact: hack, mount/dismount, fabricator, orbital console |
| Q | Command captured units (orders, node diet, pilot Drifter) |
| TAB | Inventory / craft / WRECK upgrades |
| F | First ↔ third person · B build mode · ESC pause |

## Run locally

```bash
git clone https://github.com/BPY4444/signal-decay.git
cd signal-decay
python3 -m http.server 8080   # then open http://localhost:8080
```
