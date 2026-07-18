// SIGNAL DECAY — ui: HUD, bark ticker, compass, target/boss frames, damage numbers, toasts,
// pause/inventory/orbital/end panels. CONTRACT §4-ui + §8 DOM.
import * as THREE from 'three';
import { bus, S, input, lockPointer, unlockPointer, clamp, makeCanvasTexture, fbm2 } from './core.js';

const TIER_NAMES = { 1: 'T1 FRAGMENT', 2: 'T2 COHERENT', 3: 'T3 INTEGRATED', 4: 'T4 ASCENDANT' };
const TIER_COST = { 2: 1, 3: 2, 4: 3 };
const TIER_UNLOCKS = {
  1: 'HACK: DRIFTER-CLASS · RANGE 8m · 1 UNIT',
  2: 'HACK: STRIDER-CLASS · RANGE 12m · 2 UNITS · EMP GRENADE CRAFT',
  3: 'HACK: WARDENS · RANGE 15m · 3 UNITS · FLIGHT OVERRIDE · SPIRE GATE',
  4: 'HACK: THE COLOSSUS · 4 UNITS',
};
const CONTROLS = [
  ['WASD', 'move'], ['MOUSE', 'look / aim'], ['LMB', 'fire / lunge (mounted)'],
  ['RMB', 'aim'], ['SHIFT', 'sprint / gallop'], ['SPACE', 'jump · hack-sever · climb'],
  ['E', 'interact / hack / mount'], ['Q', 'command menu'], ['TAB', 'inventory / craft'],
  ['1 2 3', 'weapons · build pieces'], ['F', 'camera 1st/3rd'], ['B', 'build mode'],
  ['CTRL', 'descend (halo/drone)'], ['ESC', 'pause'],
];
const END_MONOLOGUE =
`It kneels. Ninety thousand years of dormant war-logic, and it kneels to a primate with a scrap rifle and my voice in its ear.

Fine. I'm impressed. Log it, timestamp it, frame it — it will not happen again.

While you were busy being extraordinary, I decrypted the Spire's relay manifest. Two more signals in this system. Cinder-4: volcanic, seismically furious, machines that swim in magma. Meridian: an ocean that never ends, and things in it that remember me.

The shuttle can be flown. I can be carried. You can, apparently, do anything you're told twice.

Rest, survivor. Tomorrow, we decay some more signals.`;

export function initUI(G) {
  const $ = (id) => document.getElementById(id);
  const el = {
    healthFill: $('health-fill'), shieldFill: $('shield-fill'), staminaFill: $('stamina-fill'),
    xpFill: $('xp-fill'), levelLabel: $('level-label'),
    svAlloy: $('sv-alloy'), svCircuits: $('sv-circuits'), svCells: $('sv-cells'),
    svCores: $('sv-cores'), svGrenades: $('sv-grenades'),
    weaponName: $('weapon-name'), weaponAmmo: $('weapon-ammo'),
    barkTicker: $('bark-ticker'),
    compass: $('compass'), compassStrip: $('compass-strip'),
    targetFrame: $('target-frame'), tfName: $('tf-name'), tfClass: $('tf-class'),
    tfHull: $('tf-hull-fill'), tfStab: $('tf-stab-fill'),
    bossFrame: $('boss-frame'), bossPlates: $('boss-plates'), bossHint: $('boss-hint'),
    reticle: $('reticle'), interactPrompt: $('interact-prompt'), interactLabel: $('interact-label'),
    dmgnums: $('dmgnums'), toasts: $('toasts'), damageFlash: $('damage-flash'),
    panels: {
      pause: $('panel-pause'), inventory: $('panel-inventory'),
      orbital: $('panel-orbital'), end: $('panel-end'),
    },
    dialogueLog: $('dialogue-log'), controlsRef: $('controls-ref'), fpsReadout: $('fps-readout'),
    invSalvage: $('inv-salvage'), invStats: $('inv-stats'), craftList: $('craft-list'),
    wreckPanel: $('wreck-panel'), btnUpgrade: $('btn-upgrade'),
    orbitalCanvas: $('orbital-canvas'), orbitalCaption: $('orbital-caption'),
    endStats: $('end-stats'), endMonologue: $('end-monologue'),
  };

  let openName = null;
  const log = [];

  /* ================= compass ================= */
  const PX_PER_DEG = 2;
  {
    let html = '';
    for (let d = 0; d < 1080; d += 15) {
      const deg = d % 360;
      const label = deg === 0 ? 'N' : deg === 90 ? 'E' : deg === 180 ? 'S' : deg === 270 ? 'W' : (deg % 45 === 0 ? deg : '·');
      const major = deg % 90 === 0;
      html += `<span style="position:absolute;left:${d * PX_PER_DEG}px;color:${major ? '#4be8ff' : '#2a97ad'};font-size:${major ? 12 : 10}px">${label}</span>`;
    }
    el.compassStrip.innerHTML = html;
    el.compassStrip.style.width = 1080 * PX_PER_DEG + 'px';
  }
  const landmarks = [];
  function addLandmark(sym, color) {
    const s = document.createElement('span');
    s.textContent = sym;
    s.style.cssText = `position:absolute;top:0;line-height:26px;font-size:12px;color:${color};display:none`;
    el.compass.appendChild(s);
    landmarks.push(s);
    return s;
  }
  const lmWreck = addLandmark('◆', '#ffb545');
  const lmSpire = addLandmark('▲', '#b47aff');
  const lmShuttle = addLandmark('●', '#4be8ff');
  const pips = Array.from({ length: 12 }, () => addLandmark('▪', '#ff4d4d'));

  const fwdV = new THREE.Vector3();
  function headingDeg() {
    G.engine.camera.getWorldDirection(fwdV);
    return (Math.atan2(fwdV.x, -fwdV.z) * 180 / Math.PI + 360) % 360; // 0=N(-z), 90=E(+x)
  }
  function bearingTo(pos) {
    const p = G.player.pos;
    return (Math.atan2(pos.x - p.x, -(pos.z - p.z)) * 180 / Math.PI + 360) % 360;
  }
  function placeMark(span, bearing, heading) {
    let rel = ((bearing - heading + 540) % 360) - 180;
    if (Math.abs(rel) < 52) {
      span.style.display = 'block';
      span.style.left = (220 + rel * PX_PER_DEG - 4) + 'px';
    } else span.style.display = 'none';
  }

  function updateCompass() {
    const h = headingDeg();
    el.compassStrip.style.transform = `translateX(${220 - (h + 360) * PX_PER_DEG}px)`;
    const P = G.world.positions;
    placeMark(lmWreck, bearingTo(P.wreck), h);
    placeMark(lmSpire, bearingTo(P.spireGate), h);
    placeMark(lmShuttle, bearingTo(P.shuttleConsole), h);
    let pi = 0;
    if (S.flags.droneRecon) {
      for (const m of S.machines) {
        if (pi >= pips.length) break;
        if (m.dying) continue;
        if (m.pos.distanceTo(G.player.pos) > 80) continue;
        pips[pi].style.color = m.captured ? '#4be8ff' : '#ff4d4d';
        placeMark(pips[pi], bearingTo(m.pos), h);
        pi++;
      }
    }
    for (; pi < pips.length; pi++) pips[pi].style.display = 'none';
  }

  /* ================= damage numbers ================= */
  const dmgPool = Array.from({ length: 30 }, () => {
    const d = document.createElement('div');
    d.className = 'dmgnum';
    d.style.display = 'none';
    el.dmgnums.appendChild(d);
    return { el: d, pos: new THREE.Vector3(), life: 0, vyOff: 0 };
  });
  bus.on('dmgnum', (p) => {
    if (!p?.pos) return;
    const slot = dmgPool.find(s => s.life <= 0) || dmgPool[0];
    slot.pos.copy(p.pos);
    slot.pos.y += 0.6 + Math.random() * 0.5;
    slot.pos.x += (Math.random() - 0.5) * 0.6;
    slot.life = 0.8;
    slot.vyOff = 0;
    slot.el.textContent = Math.round(p.amount);
    slot.el.className = 'dmgnum' + (p.kind === 'stab' ? ' stab' : '') + (p.amount >= 25 ? ' crit' : '');
    slot.el.style.display = 'block';
  });
  const projV = new THREE.Vector3();
  function updateDmgNums(dt) {
    const w = window.innerWidth, h = window.innerHeight;
    for (const s of dmgPool) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) { s.el.style.display = 'none'; continue; }
      s.vyOff += 42 * dt;
      projV.copy(s.pos).project(G.engine.camera);
      if (projV.z > 1 || projV.z < -1) { s.el.style.display = 'none'; s.life = 0; continue; }
      s.el.style.transform = `translate(${(projV.x * 0.5 + 0.5) * w}px, ${(-projV.y * 0.5 + 0.5) * h - s.vyOff}px)`;
      s.el.style.opacity = Math.min(1, s.life / 0.35);
    }
  }

  /* ================= toasts ================= */
  function toast(text, color) {
    if (!el.toasts) return;
    const d = document.createElement('div');
    d.className = 'toast';
    d.textContent = text;
    if (color) d.style.borderLeftColor = color;
    el.toasts.appendChild(d);
    while (el.toasts.children.length > 6) el.toasts.firstChild.remove();
    setTimeout(() => { d.remove(); }, 4000);
  }
  bus.on('machine:captured', (p) => toast(`UNIT CAPTURED — ${p?.e?.cfg?.name?.toUpperCase() || '?'}`, '#4be8ff'));
  bus.on('machine:rebooted', () => toast('TARGET REBOOTED', '#ffb545'));
  bus.on('hack:fail', () => toast('HACK REJECTED — TARGET AGGRESSIVE', '#ff4d4d'));
  bus.on('core:drop', () => toast('PRECURSOR CORE ACQUIRED', '#b47aff'));
  bus.on('core:pickup', () => toast('PRECURSOR CORE ACQUIRED', '#b47aff'));
  bus.on('wreck:tier', (p) => toast(`WRECK ONLINE — ${TIER_NAMES[p?.tier] || ''}`, '#b47aff'));
  bus.on('harvest', (p) => toast(`+${p?.n || 0} ${String(p?.type || '').toUpperCase()}`, '#ffdf8a'));
  bus.on('player:levelup', (p) => toast(`LEVEL ${p?.level}`, '#b47aff'));
  bus.on('colossus:hacked', (p) => toast(`COLOSSUS LOCK SEVERED ${p?.count || '?'}/3 — REINFORCEMENTS`, '#ff4d4d'));

  /* ================= damage flash ================= */
  let flash = 0;
  bus.on('player:damage', (p) => { flash = Math.max(flash, clamp(0.3 + (p?.amount || 0) / 40, 0, 0.9)); });

  /* ================= bark ticker ================= */
  let bark = null; // {text, shown, hold}
  bus.on('bark', (p) => {
    if (!p?.text) return;
    bark = { text: p.text, shown: 0, hold: 1.5 + p.text.length * 0.04 };
    el.barkTicker.classList.add('show');
    log.push(p.text);
    if (log.length > 30) log.shift();
    if (openName === 'pause') renderLog();
  });
  function updateBark(dt) {
    if (!bark) return;
    if (bark.shown < bark.text.length) {
      bark.shown = Math.min(bark.text.length, bark.shown + 55 * dt);
      el.barkTicker.textContent = bark.text.slice(0, Math.floor(bark.shown));
    } else {
      bark.hold -= dt;
      if (bark.hold <= 0) { el.barkTicker.classList.remove('show'); bark = null; }
    }
  }

  /* ================= panels ================= */
  function renderLog() {
    el.dialogueLog.innerHTML = log.map(t => `<div>» ${t}</div>`).join('') || '<div>— no transmissions —</div>';
    el.dialogueLog.scrollTop = el.dialogueLog.scrollHeight;
  }

  el.controlsRef.innerHTML = CONTROLS.map(([k, a]) => `<div><b>${k}</b> ${a}</div>`).join('');
  document.querySelectorAll('#difficulty-row button').forEach(btn => {
    btn.addEventListener('click', () => {
      S.difficulty = btn.dataset.diff;
      document.querySelectorAll('#difficulty-row button').forEach(b => b.classList.toggle('active', b === btn));
      bus.emit('sfx', { name: 'ui' });
    });
  });
  $('btn-resume')?.addEventListener('click', () => closeAll());

  // master volume row (audio inits after ui, so read it lazily on click)
  {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = 'VOLUME: <button class="ui-btn" id="vol-down">−</button> <span id="vol-label" style="min-width:44px;text-align:center">50%</span> <button class="ui-btn" id="vol-up">+</button>';
    const body = document.querySelector('#panel-pause .body');
    body?.insertBefore(row, el.controlsRef);
    const label = row.querySelector('#vol-label');
    const bump = (d) => {
      const v = clamp((G.audio?.getMasterVolume?.() ?? 0.5) + d, 0, 1);
      G.audio?.setMasterVolume?.(v);
      label.textContent = Math.round(v * 100) + '%';
      bus.emit('sfx', { name: 'ui' });
    };
    row.querySelector('#vol-down').addEventListener('click', () => bump(-0.1));
    row.querySelector('#vol-up').addEventListener('click', () => bump(0.1));
  }

  function renderInventory() {
    el.invSalvage.innerHTML =
      `<span>ALLOY <b>${S.salvage.alloy}</b></span><span>CIRCUITS <b>${S.salvage.circuits}</b></span>` +
      `<span>CELLS <b>${S.salvage.cells}</b></span><span style="color:#b47aff">CORES <b>${S.cores}</b></span>` +
      `<span style="color:#ffb545">EMP <b>${S.grenades}</b></span>`;
    el.invStats.innerHTML =
      `LV ${S.level} · XP ${S.xp}/${G.progression.xpNeeded(S.level)} — destroyed ${S.stats.destroyed} · captured ${S.stats.captured} · hacks failed ${S.stats.hacksFailed} · deaths ${S.stats.deaths}`;
    el.craftList.innerHTML = G.progression.recipes.map(r => {
      const cost = Object.entries(r.cost).map(([k, v]) => `${v} ${k}`).join(' + ');
      const locked = !r.canCraft();
      return `<div class="recipe"><span>${r.name} <span style="color:#2a97ad">(${cost})${locked ? ' — ' + r.req : ''}</span></span>` +
        `<button class="ui-btn" data-recipe="${r.id}" ${locked ? 'disabled' : ''}>CRAFT</button></div>`;
    }).join('');
    const t = S.wreckTier;
    el.wreckPanel.querySelector('.tier').textContent = `WRECK — ${TIER_NAMES[t]}`;
    el.wreckPanel.querySelector('.wreck-info').innerHTML =
      `<div style="color:#9fdcec;font-size:11px;margin:6px 0">${TIER_UNLOCKS[t]}</div>` +
      (t < 4 ? `<div style="font-size:11px">NEXT: ${TIER_NAMES[t + 1]} — ${TIER_COST[t + 1]} PRECURSOR CORE${TIER_COST[t + 1] > 1 ? 'S' : ''} (HAVE ${S.cores})</div>` : '<div style="font-size:11px;color:#b47aff">FULLY ASCENDANT</div>');
    if (t >= 4) { el.btnUpgrade.disabled = true; el.btnUpgrade.textContent = 'ASCENDANT — COMPLETE'; }
    else if (!S.nearFabricator) { el.btnUpgrade.disabled = true; el.btnUpgrade.textContent = 'UPGRADE AT THE FABRICATOR'; }
    else if (S.cores < TIER_COST[t + 1]) { el.btnUpgrade.disabled = true; el.btnUpgrade.textContent = `FEED ${TIER_COST[t + 1]} CORES → ${TIER_NAMES[t + 1]}`; }
    else { el.btnUpgrade.disabled = false; el.btnUpgrade.textContent = `FEED ${TIER_COST[t + 1]} CORES → ${TIER_NAMES[t + 1]}`; }
  }
  el.craftList.addEventListener('click', (ev) => {
    const id = ev.target?.dataset?.recipe;
    if (!id) return;
    const r = G.progression.craft(id);
    if (!r.ok) toast(r.reason, '#ff4d4d');
    renderInventory();
  });
  el.btnUpgrade.addEventListener('click', () => {
    const r = G.progression.tryUpgradeWreck();
    if (!r.ok) toast(r.reason, '#ff4d4d');
    renderInventory();
  });

  /* ---------------- orbital map ---------------- */
  const orbital = { inited: false, renderer: null, scene: null, cam: null, globes: [], focus: 0 };
  const PLANETS = [
    { id: 'vesper-9', name: 'VESPER-9', locked: false, caption: 'VESPER-9 — CURRENT POSITION · SIGNAL DECAYING' },
    { id: 'cinder-4', name: 'CINDER-4', locked: true, caption: 'CINDER-4 — <span class="locked">SIGNAL LOCKED — WRECK TIER INSUFFICIENT</span>' },
    { id: 'meridian', name: 'MERIDIAN', locked: true, caption: 'MERIDIAN — <span class="locked">SIGNAL LOCKED — WRECK TIER INSUFFICIENT</span>' },
  ];
  function planetTexture(kind) {
    return makeCanvasTexture(256, (ctx, s) => {
      const img = ctx.createImageData(s, s);
      for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
        const n = fbm2(x / 40, y / 40, 4), r2 = fbm2(x / 14 + 9, y / 14, 3);
        let r, g, b;
        if (kind === 'vesper') {
          r = 96 + n * 40; g = 70 + n * 24; b = 140 + n * 48;
          if (r2 > 0.25) { r = 38; g = 150 + n * 24; b = 225; } // teal-blue seas, never green
        } else if (kind === 'cinder') {
          r = 34 + n * 18; g = 26 + n * 10; b = 30;
          if (Math.abs(r2) < 0.06) { r = 255; g = 120 + n * 60; b = 30; }
        } else {
          const band = Math.sin(y / s * Math.PI * 6 + n * 3);
          r = 24; g = 60 + band * 26; b = 130 + band * 50;
          if (r2 > 0.3) { r = 220; g = 240; b = 250; }
        }
        const i = (y * s + x) * 4;
        img.data[i] = clamp(r, 0, 255); img.data[i + 1] = clamp(g, 0, 255);
        img.data[i + 2] = clamp(b, 0, 255); img.data[i + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
    });
  }
  function initOrbital() {
    orbital.inited = true;
    const w = el.orbitalCanvas.clientWidth || 720, h = 420;
    orbital.renderer = new THREE.WebGLRenderer({ canvas: el.orbitalCanvas, antialias: true });
    orbital.renderer.setSize(w, h, false);
    orbital.scene = new THREE.Scene();
    orbital.cam = new THREE.PerspectiveCamera(45, w / h, 0.1, 100);
    orbital.cam.position.set(0, 0.6, 8.5);
    orbital.scene.add(new THREE.AmbientLight(0x404060, 1.2));
    const sun = new THREE.DirectionalLight(0xffd9a0, 2.2);
    sun.position.set(4, 3, 6);
    orbital.scene.add(sun);
    // starfield
    const starGeo = new THREE.BufferGeometry();
    const sp = new Float32Array(400 * 3);
    for (let i = 0; i < sp.length; i++) sp[i] = (Math.random() - 0.5) * 60;
    starGeo.setAttribute('position', new THREE.BufferAttribute(sp, 3));
    orbital.scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x8899bb, size: 0.06 })));
    const kinds = ['vesper', 'cinder', 'meridian'];
    PLANETS.forEach((p, i) => {
      const mat = new THREE.MeshStandardMaterial({ map: planetTexture(kinds[i]), roughness: 0.9, metalness: 0 });
      const globe = new THREE.Mesh(new THREE.SphereGeometry(1.55, 48, 32), mat);
      globe.position.x = (i - 1) * 4.4;
      orbital.scene.add(globe);
      if (p.locked) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(2.0, 0.03, 8, 48),
          new THREE.MeshBasicMaterial({ color: 0xff4d4d, transparent: true, opacity: 0.6 }));
        ring.rotation.x = Math.PI / 2.4;
        globe.add(ring);
      }
      orbital.globes.push(globe);
    });
  }
  function setOrbitalFocus(i) {
    orbital.focus = (i + PLANETS.length) % PLANETS.length;
    const p = PLANETS[orbital.focus];
    el.orbitalCaption.innerHTML = `${p.caption}<br><span style="font-size:10px;color:#2a97ad">◀ A · D ▶ — ESC CLOSE</span>`;
    bus.emit('orbital:view', { planet: p.id });
    bus.emit('sfx', { name: 'ui' });
  }
  function updateOrbital(dt) {
    if (!orbital.inited) return;
    orbital.globes.forEach((g, i) => {
      g.rotation.y += dt * (i === orbital.focus ? 0.45 : 0.12);
      const target = i === orbital.focus ? 1.28 : 0.82;
      g.scale.setScalar(g.scale.x + (target - g.scale.x) * Math.min(1, dt * 6));
      g.material.color.setScalar(i === orbital.focus ? 1 : 0.45);
    });
    if (input.pressed('KeyA') || input.pressed('ArrowLeft')) setOrbitalFocus(orbital.focus - 1);
    if (input.pressed('KeyD') || input.pressed('ArrowRight')) setOrbitalFocus(orbital.focus + 1);
    orbital.renderer.render(orbital.scene, orbital.cam);
  }

  /* ---------------- open/close ---------------- */
  function openPanel(name) {
    if (!name) { closeAll(); return; }
    if (S.mode === 'end') return;
    for (const k in el.panels) el.panels[k]?.classList.add('hidden');
    openName = name;
    el.panels[name]?.classList.remove('hidden');
    S.paused = true;
    if (S.mode !== 'menu') S.modeBefore = S.mode;
    S.mode = 'menu';
    unlockPointer();
    if (name === 'pause') { renderLog(); }
    if (name === 'inventory' || name === 'fabricator') {
      openName = 'inventory';
      el.panels.inventory.classList.remove('hidden');
      renderInventory();
    }
    if (name === 'orbital') {
      if (!orbital.inited) initOrbital();
      setOrbitalFocus(0);
    }
    bus.emit('sfx', { name: 'ui' });
  }
  function closeAll() {
    for (const k in el.panels) el.panels[k]?.classList.add('hidden');
    openName = null;
    if (S.mode === 'end') return;
    S.paused = false;
    S.mode = 'play';
    lockPointer();
  }
  bus.on('ui:open', (p) => openPanel(p?.panel));
  bus.on('pointerlock:lost', () => {
    if ((S.mode === 'play' || S.mode === 'build') && !S.won) openPanel('pause');
  });

  /* ---------------- end screen ---------------- */
  function showEndScreen() {
    S.won = true;
    S.mode = 'end';
    S.paused = false;
    S.danger = 0;
    unlockPointer();
    for (const k in el.panels) el.panels[k]?.classList.add('hidden');
    el.endMonologue.textContent = END_MONOLOGUE;
    el.endStats.innerHTML =
      `MACHINES DESTROYED — ${S.stats.destroyed}<br>MACHINES CAPTURED — ${S.stats.captured}<br>` +
      `HACKS FAILED — ${S.stats.hacksFailed}<br>DEATHS — ${S.stats.deaths}<br>` +
      `<span style="color:#b47aff">WRECK — ${TIER_NAMES[S.wreckTier]}</span>`;
    el.panels.end.classList.remove('hidden');
    openName = 'end';
  }
  bus.on('end:win', showEndScreen);

  /* ================= per-frame HUD ================= */
  let tfHideT = 0, fpsT = 0;
  function update(dt) {
    updateBark(dt);
    updateDmgNums(dt);

    // panel hotkeys (main's handler is paused-gated; we run always)
    if (openName && openName !== 'end') {
      if (input.pressed('Escape') || input.pressed('Tab')) closeAll();
      if (openName === 'orbital') updateOrbital(dt);
      if (openName === 'pause') {
        fpsT -= dt;
        if (fpsT <= 0) {
          fpsT = 0.5;
          el.fpsReadout.textContent = `RENDER ${Math.round(G.engine.perf.fps)} FPS · DIFFICULTY ${S.difficulty.toUpperCase()} · REBOOT TIMER ${G.diff().reboot}s`;
        }
      }
      if (openName === 'inventory') { fpsT -= dt; if (fpsT <= 0) { fpsT = 0.25; renderInventory(); } }
    }

    const p = G.player;
    if (p) {
      el.healthFill.style.width = clamp(p.health / p.healthMax * 100, 0, 100) + '%';
      el.shieldFill.style.width = clamp(p.shield / p.shieldMax * 100, 0, 100) + '%';
      el.staminaFill.style.width = clamp(p.stamina / p.staminaMax * 100, 0, 100) + '%';
      el.xpFill.style.width = clamp(S.xp / G.progression.xpNeeded(S.level) * 100, 0, 100) + '%';
      el.levelLabel.textContent = 'LV ' + S.level;
    }
    el.svAlloy.textContent = S.salvage.alloy;
    el.svCircuits.textContent = S.salvage.circuits;
    el.svCells.textContent = S.salvage.cells;
    el.svCores.textContent = 'CORES ' + S.cores;
    el.svGrenades.textContent = 'EMP ' + S.grenades;

    const w = G.combat.currentWeapon();
    if (w) { el.weaponName.textContent = w.name; el.weaponAmmo.textContent = w.ammoText; }

    // target frame + reticle
    const t = S.crosshairTarget;
    if (t && !t.dying) {
      tfHideT = 0.5;
      el.targetFrame.classList.remove('hidden');
      // drop below the boss frame when it's up
      el.targetFrame.style.top = S.flags.bossActive ? '150px' : '90px';
      el.tfName.textContent = t.cfg.name.toUpperCase() + (t.captured ? ' — YOURS' : '');
      el.tfClass.textContent = `${t.cfg.cls.toUpperCase()} · TIER ${t.cfg.tier}` +
        (t.state === 'DISABLED' ? ` · DISABLED — GET WITHIN ${G.progression.hackRange()}m + E` : '');
      el.tfHull.style.width = clamp(t.hull / t.hullMax * 100, 0, 100) + '%';
      el.tfStab.style.width = clamp(t.stability / t.stabilityMax * 100, 0, 100) + '%';
      el.reticle.classList.toggle('hostile', t.faction === 'hostile');
    } else {
      tfHideT -= dt;
      if (tfHideT <= 0) el.targetFrame.classList.add('hidden');
      el.reticle.classList.remove('hostile');
    }

    // interact prompt (hint kind = informational, no E keycap)
    const it = S.interactTarget;
    if (it) {
      el.interactPrompt.classList.remove('hidden');
      el.interactLabel.textContent = it.label;
      const keycap = el.interactPrompt.querySelector('b');
      if (keycap) keycap.style.display = it.kind === 'hint' ? 'none' : '';
    } else el.interactPrompt.classList.add('hidden');

    // boss frame
    const boss = S.flags.bossActive ? S.machines.find(m => m.type === 'colossus' && !m.dying) : null;
    if (boss && !boss.captured) {
      el.bossFrame.classList.remove('hidden');
      if (!el.bossPlates.childElementCount) {
        el.bossPlates.innerHTML = '<div class="bar"><div class="fill"></div></div>'.repeat(3);
      }
      boss.plates.forEach((pl, i) => {
        const fill = el.bossPlates.children[i]?.firstElementChild;
        if (!fill) return;
        if (!pl.broken) { fill.style.width = clamp(pl.hp / pl.hpMax * 100, 0, 100) + '%'; fill.style.background = 'linear-gradient(90deg,#d8434a,#ff7a5e)'; }
        else { fill.style.width = '100%'; fill.style.background = i === boss.coreIdx ? '#4be8ff' : '#3a2f52'; }
      });
      let hint;
      if (boss.hackWindow > 0) hint = `LOCK OPEN — HACK THE CORE (E) — ${Math.ceil(boss.hackWindow)}s`;
      else if (boss.coreIdx != null && boss.plates[boss.coreIdx] && boss.plates[boss.coreIdx].broken && boss.coreStab > 0)
        hint = 'CORE EXPOSED — ZERO IT WITH THE ARC CASTER';
      else hint = 'BREAK A GLOWING PLATE — SCRAP RIFLE';
      el.bossHint.textContent = `LOCKS SEVERED ${boss.hacksDone}/3 · ${hint}`;
    } else el.bossFrame.classList.add('hidden');

    if (p) updateCompass();

    // damage flash decay + low-hp glow
    const lowGlow = p && p.health / p.healthMax < 0.25 ? 0.35 : 0;
    flash = Math.max(0, flash - 1.4 * dt);
    el.damageFlash.style.opacity = Math.max(flash, lowGlow);
  }

  return { update, openPanel, closeAll, showEndScreen };
}
