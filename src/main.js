// SIGNAL DECAY — main: bootstrap, module wiring, game loop, interact routing. See CONTRACT.md §5.
import * as THREE from 'three';
import { bus, S, input, DIFF, diff, initInput } from './core.js';
import { initEngine } from './engine.js';
import { initWorld } from './world.js';
import { initPlayer } from './player.js';
import { initMachines } from './machines.js';
import { initAI } from './ai.js';
import { initCombat } from './combat.js';
import { initHacking } from './hacking.js';
import { initCapture } from './capture.js';
import { initMounts } from './mounts.js';
import { initBase } from './base.js';
import { initProgression } from './progression.js';
import { initBarks } from './barks.js';
import { initUI } from './ui.js';
import { initAudio } from './audio.js';

const G = { THREE, bus, S, input, DIFF, diff };
window.G = G; // debug/test hook

const loadingStatus = document.getElementById('loading-status');
function status(t) { if (loadingStatus) loadingStatus.textContent = t; }

function boot() {
  status('BINDING INPUT…');
  initInput();

  status('IGNITING RENDERER…');
  G.engine = initEngine(G);

  status('TERRAFORMING VESPER-9…');
  G.world = initWorld(G);

  status('FABRICATING MACHINE ECOSYSTEM…');
  G.machines = initMachines(G);

  status('WAKING SURVIVOR…');
  G.player = initPlayer(G);

  status('SEEDING HOSTILE INTELLIGENCE…');
  G.ai = initAI(G);
  G.combat = initCombat(G);
  G.hacking = initHacking(G);
  G.capture = initCapture(G);
  G.mounts = initMounts(G);
  G.base = initBase(G);
  G.progression = initProgression(G);

  status('DECOMPRESSING WRECK PERSONALITY MATRIX…');
  G.barks = initBarks(G);
  G.ui = initUI(G);
  G.audio = initAudio(G);

  status('POPULATING ECOSYSTEM…');
  G.machines.populate();

  // dismiss loading screen on first interaction
  const loading = document.getElementById('loading');
  status('READY. CLICK TO TAKE CONTROL.');
  const dismiss = () => {
    loading.style.opacity = '0';
    setTimeout(() => loading.classList.add('hidden'), 850);
    loading.removeEventListener('click', dismiss);
  };
  loading.addEventListener('click', dismiss);

  requestAnimationFrame(frame);
}

/* ---------------- interact targeting ---------------- */
function computeInteractTarget() {
  if (S.mode !== 'play') { S.interactTarget = null; return; }
  if (S.mounted) { S.interactTarget = { kind: 'dismount', label: 'DISMOUNT' }; return; }
  if (S.piloting) { S.interactTarget = null; return; }

  const p = G.player.pos;

  // hackable disabled machine (or colossus open hack window) in WRECK range
  let best = null, bestD = Infinity;
  const range = G.progression.hackRange();
  for (const e of S.machines) {
    if (e.dying || e.captured) continue;
    const hackable = e.state === 'DISABLED' || (e.type === 'colossus' && e.hackWindow > 0);
    if (!hackable) continue;
    const d = p.distanceTo(e.pos);
    if (d <= range && d < bestD && G.progression.canHack(e)) { best = e; bestD = d; }
  }
  if (best) {
    S.interactTarget = { kind: 'hack', entity: best, label: `HACK ${best.cfg.name.toUpperCase()}` };
    return;
  }

  // mount a captured rideable adjacent
  for (const e of S.captured) {
    if (e.dying) continue;
    if ((e.type === 'strider' || e.type === 'halo') && p.distanceTo(e.pos) < 4.5) {
      S.interactTarget = { kind: 'mount', entity: e, label: `MOUNT ${e.cfg.name.toUpperCase()}` };
      return;
    }
  }

  if (S.nearFabricator) { S.interactTarget = { kind: 'fabricator', label: 'FABRICATOR' }; return; }
  if (S.nearConsole) { S.interactTarget = { kind: 'console', label: 'ORBITAL MAP' }; return; }
  S.interactTarget = null;
}

function handleGlobalKeys() {
  // E — interact
  if (input.pressed('KeyE') && S.mode === 'play') {
    const t = S.interactTarget;
    if (t) {
      input.consume('KeyE');
      if (t.kind === 'dismount') G.mounts.dismount();
      else if (t.kind === 'hack') G.hacking.start(t.entity);
      else if (t.kind === 'mount') G.mounts.mount(t.entity);
      else if (t.kind === 'fabricator') bus.emit('ui:open', { panel: 'fabricator' });
      else if (t.kind === 'console') bus.emit('ui:open', { panel: 'orbital' });
    }
  }
  // F — camera toggle
  if (input.pressed('KeyF') && S.mode === 'play' && !S.mounted && !S.piloting) {
    G.player.cameraMode = G.player.cameraMode === 'third' ? 'first' : 'third';
    bus.emit('sfx', { name: 'ui' });
  }
  // B — build mode
  if (input.pressed('KeyB') && (S.mode === 'play' || S.mode === 'build') && !S.mounted && !S.piloting) {
    G.base.toggleBuildMode();
  }
  // TAB — inventory
  if (input.pressed('Tab')) {
    if (S.mode === 'play') bus.emit('ui:open', { panel: 'inventory' });
    else if (S.mode === 'menu') bus.emit('ui:open', { panel: null }); // close
  }
}

/* ---------------- game loop ---------------- */
let last = performance.now();
let acc = 0;

function frame(now) {
  requestAnimationFrame(frame);
  let dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  try {
    if (!S.paused && S.mode !== 'end') {
      S.time += dt;
      computeInteractTarget();
      handleGlobalKeys();

      G.player.update(dt);
      G.mounts.update(dt);
      G.capture.update(dt);
      G.ai.update(dt);
      G.machines.update(dt);
      G.combat.update(dt);
      G.hacking.update(dt);
      G.base.update(dt);
      G.world.update(dt);
      G.progression.update(dt);
      G.barks.update(dt);
    }
    G.ui.update(dt);
    G.audio.update(dt);
    G.engine.render(dt);
  } catch (err) {
    // never let one bad frame kill the loop; log at 1Hz max
    acc += dt;
    if (acc > 1) { console.error('[frame]', err); acc = 0; }
  }
  input.endFrame();
}

try {
  boot();
} catch (err) {
  console.error('[boot]', err);
  status('BOOT FAILURE — ' + err.message);
  const sub = document.querySelector('#loading .sub');
  if (sub) sub.textContent = String(err.stack || err);
}
