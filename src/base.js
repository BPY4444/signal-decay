// SIGNAL DECAY — base building stub: foundation / wall / auto-turret. CONTRACT §4-base.
import * as THREE from 'three';
import { bus, S, input, makeCanvasTexture, fbm2, clamp } from './core.js';

const GRID = 2;

export function initBase(G) {
  const scene = G.engine.scene;

  /* ---------------- materials ---------------- */
  const metalTex = makeCanvasTexture(128, (ctx, s) => {
    ctx.fillStyle = '#5a5468';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 400; i++) {
      const x = (i * 37) % s, y = (i * 91) % s;
      const v = fbm2(x * 0.06, y * 0.06, 3) * 22;
      ctx.fillStyle = `rgb(${90 + v | 0},${84 + v | 0},${104 + v | 0})`;
      ctx.fillRect(x, y, 3, 1);
    }
  });
  const bodyMat = new THREE.MeshStandardMaterial({ map: metalTex, color: 0x8f89a4, roughness: 0.55, metalness: 0.75 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x24202e, roughness: 0.85, metalness: 0.4 });
  const glowMat = new THREE.MeshStandardMaterial({ color: 0x143038, emissive: 0x4be8ff, emissiveIntensity: 1.4, roughness: 0.4, metalness: 0.2 });
  const ghostOk = new THREE.MeshBasicMaterial({ color: 0x4be8ff, transparent: true, opacity: 0.35, depthWrite: false });
  const ghostBad = new THREE.MeshBasicMaterial({ color: 0xff4d4d, transparent: true, opacity: 0.35, depthWrite: false });

  /* ---------------- placeable defs ---------------- */
  function buildFoundation(mat) {
    const g = new THREE.Group();
    const slab = new THREE.Mesh(new THREE.BoxGeometry(4, 0.4, 4), mat || bodyMat);
    slab.position.y = 0.2; slab.castShadow = slab.receiveShadow = !mat;
    g.add(slab);
    if (!mat) {
      const trim = new THREE.Mesh(new THREE.BoxGeometry(4.1, 0.08, 4.1), glowMat);
      trim.position.y = 0.42; g.add(trim);
    }
    return g;
  }
  function buildWall(mat) {
    const g = new THREE.Group();
    const panel = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 0.25), mat || bodyMat);
    panel.position.y = 1.5; panel.castShadow = panel.receiveShadow = !mat;
    g.add(panel);
    if (!mat) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(4.02, 0.1, 0.27), glowMat);
      stripe.position.y = 2.6; g.add(stripe);
      for (const sx of [-1.9, 1.9]) {
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 3.1, 10), darkMat);
        post.position.set(sx, 1.55, 0); g.add(post);
      }
    }
    return g;
  }
  function buildTurret(mat) {
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.75, 0.5, 14), mat || darkMat);
    base.position.y = 0.25; base.castShadow = !mat;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 0.8, 10), mat || bodyMat);
    stem.position.y = 0.85;
    const head = new THREE.Group();
    head.position.y = 1.3;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.34, 18, 12), mat || bodyMat);
    dome.castShadow = !mat;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.9, 10), mat || darkMat);
    barrel.rotation.x = Math.PI / 2; barrel.position.z = 0.5;
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), mat || glowMat);
    eye.position.set(0, 0.12, 0.3);
    head.add(dome, barrel, eye);
    g.add(base, stem, head);
    g.userData.head = head;
    g.userData.muzzle = new THREE.Object3D();
    g.userData.muzzle.position.set(0, 0, 0.95);
    head.add(g.userData.muzzle);
    return g;
  }

  const placeables = [
    { id: 'foundation', name: 'FOUNDATION', cost: { alloy: 10 }, build: buildFoundation },
    { id: 'wall', name: 'WALL', cost: { alloy: 5 }, build: buildWall },
    { id: 'turret', name: 'AUTO-TURRET', cost: { alloy: 15, circuits: 10, cells: 2 }, build: buildTurret },
  ];

  const placed = [];      // { id, group, pos, head?, muzzle?, scanT, fireT, target }
  let sel = 0;
  let ghost = null;       // { group, id }
  const hintEl = document.getElementById('build-hint');

  function affordable(def) {
    return Object.entries(def.cost).every(([k, v]) => (S.salvage[k] || 0) >= v);
  }
  function costText(def) {
    return Object.entries(def.cost).map(([k, v]) => `${v} ${k.toUpperCase()}`).join(' + ');
  }

  function makeGhost() {
    if (ghost) { scene.remove(ghost.group); ghost = null; }
    const def = placeables[sel];
    const group = def.build(ghostOk);
    group.traverse(o => { if (o.isMesh) o.material = ghostOk; });
    scene.add(group);
    ghost = { group, def };
  }

  function updateHint(valid) {
    if (!hintEl) return;
    const def = placeables[sel];
    hintEl.textContent =
      `BUILD // [1/2/3] ${placeables.map((p, i) => (i === sel ? '▶' + p.name : p.name)).join('  ')} — ${costText(def)}` +
      (valid ? '  · LMB PLACE' : '  · INVALID') + '  · B EXIT';
  }

  function toggleBuildMode() {
    if (S.mode === 'build') {
      S.mode = 'play';
      if (ghost) { scene.remove(ghost.group); ghost = null; }
      hintEl?.classList.add('hidden');
    } else if (S.mode === 'play') {
      S.mode = 'build';
      sel = 0;
      makeGhost();
      hintEl?.classList.remove('hidden');
      bus.emit('sfx', { name: 'ui' });
    }
  }

  /* ---------------- placement ---------------- */
  const aim = new THREE.Vector3();
  const camDir = new THREE.Vector3();

  function updateGhost() {
    if (!ghost) return false;
    const cam = G.engine.camera;
    cam.getWorldDirection(camDir);
    // project 8m ahead, drop to ground, snap to grid
    aim.copy(cam.position).addScaledVector(camDir, 8);
    aim.x = Math.round(aim.x / GRID) * GRID;
    aim.z = Math.round(aim.z / GRID) * GRID;
    aim.y = G.world.getGroundHeight(aim.x, aim.z);

    const playerDist = G.player ? G.player.pos.distanceTo(aim) : 0;
    // slope check: sample 4 corners
    const h = aim.y;
    const s = 1.6;
    let maxDelta = 0;
    for (const [dx, dz] of [[s, s], [-s, s], [s, -s], [-s, -s]]) {
      maxDelta = Math.max(maxDelta, Math.abs(G.world.getGroundHeight(aim.x + dx, aim.z + dz) - h));
    }
    const slopeOk = maxDelta / s < Math.tan(25 * Math.PI / 180) * 1.6;
    const overlap = placed.some(p => p.pos.distanceTo(aim) < 1.8);
    const valid = playerDist <= 11 && slopeOk && !overlap && affordable(ghost.def);

    ghost.group.position.copy(aim);
    ghost.group.traverse(o => { if (o.isMesh) o.material = valid ? ghostOk : ghostBad; });
    updateHint(valid);
    return valid;
  }

  function place() {
    const def = placeables[sel];
    for (const k in def.cost) S.salvage[k] -= def.cost[k];
    const group = def.build();
    group.position.copy(ghost.group.position);
    scene.add(group);
    placed.push({
      id: def.id, group, pos: group.position.clone(),
      head: group.userData.head || null, muzzle: group.userData.muzzle || null,
      scanT: 0, fireT: 0, target: null,
    });
    bus.emit('sfx', { name: 'ui' });
  }

  /* ---------------- turret brain ---------------- */
  const muzzleWorld = new THREE.Vector3();
  const toT = new THREE.Vector3();

  function tickTurrets(dt) {
    for (const t of placed) {
      if (t.id !== 'turret') continue;
      t.scanT -= dt; t.fireT -= dt;
      if (t.scanT <= 0) {
        t.scanT = 0.5;
        t.target = null;
        let bd = 20;
        for (const e of S.machines) {
          if (e.faction !== 'hostile' || e.dying || e.state === 'DISABLED') continue;
          const d = e.pos.distanceTo(t.pos);
          if (d < bd) { bd = d; t.target = e; }
        }
      }
      const e = t.target;
      if (!e || e.dying || e.state === 'DISABLED') { t.target = null; continue; }
      if (t.head) {
        toT.copy(e.pos).sub(t.pos);
        t.head.rotation.y = Math.atan2(toT.x, toT.z);
      }
      if (t.fireT <= 0) {
        t.fireT = 0.5;
        t.muzzle ? t.muzzle.getWorldPosition(muzzleWorld) : muzzleWorld.copy(t.pos).setY(t.pos.y + 1.3);
        toT.copy(e.pos); toT.y += (e.cfg.flying ? 0 : 1);
        bus.emit('tracer', { from: muzzleWorld.clone(), to: toT.clone(), color: 0x4be8ff });
        G.combat.damageMachine(e, { hull: 3 }, 'turret');
        bus.emit('sfx', { name: 'turret' });
      }
    }
  }

  /* ---------------- update ---------------- */
  function update(dt) {
    tickTurrets(dt);
    if (S.mode !== 'build') return;

    for (let i = 0; i < 3; i++) {
      if (input.pressed('Digit' + (i + 1))) {
        input.consume('Digit' + (i + 1));
        sel = i; makeGhost();
        bus.emit('sfx', { name: 'ui' });
      }
    }
    const valid = updateGhost();
    if (input.mouse0Pressed && valid) place();
    if (input.pressed('Escape')) toggleBuildMode();
  }

  return { update, toggleBuildMode, placeables, placed };
}
