// SIGNAL DECAY — combat: weapons, damage routing, crosshair target, tracers, hit FX.
// CONTRACT §4-combat / §6b. Only damage entry point for machines is damageMachine().
import * as THREE from 'three';
import { bus, S, input, rng, rngInt, clamp, makeCanvasTexture } from './core.js';

export function initCombat(G) {
  const scene = G.engine.scene;
  const camera = G.engine.camera;

  /* ---------------- module scratch (no per-frame allocs in hot loops) ---------------- */
  const _camPos = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _right = new THREE.Vector3();
  const _upV = new THREE.Vector3(0, 1, 0);
  const _muzzle = new THREE.Vector3();
  const _end = new THREE.Vector3();
  const _tmp = new THREE.Vector3();
  const _tmp2 = new THREE.Vector3();
  const _gp = new THREE.Vector3();
  const _ndc = new THREE.Vector2(0, 0);
  const raycaster = new THREE.Raycaster();

  /* ---------------- shared FX assets ---------------- */
  const glowTex = makeCanvasTexture(64, (ctx, s) => {
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.6)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
  }, { repeat: false });

  /* ---------------- tracer pool ---------------- */
  const TRACERS = 26;
  const tracers = [];
  for (let i = 0; i < TRACERS; i++) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const line = new THREE.Line(geo, mat);
    line.visible = false;
    line.frustumCulled = false;
    scene.add(line);
    tracers.push({ line, mat, t: 0, ttl: 0.09 });
  }
  let tracerIdx = 0;
  function spawnTracer(from, to, color, ttl) {
    let tr = null;
    for (let i = 0; i < TRACERS; i++) {
      const c = tracers[(tracerIdx + i) % TRACERS];
      if (!c.line.visible) { tr = c; tracerIdx = (tracerIdx + i + 1) % TRACERS; break; }
    }
    if (!tr) { tr = tracers[tracerIdx]; tracerIdx = (tracerIdx + 1) % TRACERS; }
    const p = tr.line.geometry.attributes.position;
    p.setXYZ(0, from.x, from.y, from.z);
    p.setXYZ(1, to.x, to.y, to.z);
    p.needsUpdate = true;
    tr.line.geometry.computeBoundingSphere?.();
    tr.mat.color.set(color !== undefined && color !== null ? color : 0xffe2b0);
    tr.mat.opacity = 1;
    tr.t = 0;
    tr.ttl = ttl || 0.09;
    tr.line.visible = true;
  }

  // anyone (base turret etc.) can request a tracer via bus
  bus.on('tracer', (d) => {
    try {
      if (d && d.from && d.to) spawnTracer(d.from, d.to, d.color, 0.12);
    } catch (err) { /* never throw from handler */ }
  });

  /* ---------------- spark pool (impact bursts) ---------------- */
  const SPARKS = 44;
  const sparks = [];
  for (let i = 0; i < SPARKS; i++) {
    const mat = new THREE.SpriteMaterial({
      map: glowTex, color: 0xffc27a, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const spr = new THREE.Sprite(mat);
    spr.visible = false;
    spr.scale.setScalar(0.14);
    scene.add(spr);
    sparks.push({ spr, mat, vel: new THREE.Vector3(), t: 0, ttl: 0.4 });
  }
  let sparkIdx = 0;
  function burst(pos, color, n, speed) {
    for (let k = 0; k < n; k++) {
      const sp = sparks[sparkIdx];
      sparkIdx = (sparkIdx + 1) % SPARKS;
      sp.spr.visible = true;
      sp.spr.position.copy(pos);
      sp.mat.color.set(color);
      sp.mat.opacity = 1;
      // cosmetic jitter — Math.random OK per contract
      sp.vel.set(Math.random() - 0.5, Math.random() * 0.7 + 0.15, Math.random() - 0.5)
        .normalize().multiplyScalar(speed * (0.5 + Math.random() * 0.8));
      sp.t = 0;
      sp.ttl = 0.28 + Math.random() * 0.22;
      sp.spr.scale.setScalar(0.1 + Math.random() * 0.1);
    }
  }

  /* ---------------- muzzle flash ---------------- */
  const mfMat = new THREE.SpriteMaterial({
    map: glowTex, color: 0xffdca0, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const mfSpr = new THREE.Sprite(mfMat);
  mfSpr.visible = false;
  scene.add(mfSpr);
  let mfT = 0;

  /* ---------------- arc caster beam (rebuilt every frame) ---------------- */
  const BEAM_PTS = 16;
  function makeBeamLine(color, opacity) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(BEAM_PTS * 3), 3));
    const mat = new THREE.LineBasicMaterial({
      color, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const line = new THREE.Line(geo, mat);
    line.visible = false;
    line.frustumCulled = false;
    scene.add(line);
    return line;
  }
  const beamOuter = makeBeamLine(0x4be8ff, 0.8);
  const beamInner = makeBeamLine(0xffffff, 0.95);
  const beamGlowMat = new THREE.SpriteMaterial({
    map: glowTex, color: 0x9ff4ff, transparent: true, opacity: 0.9,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const beamGlow = new THREE.Sprite(beamGlowMat); // impact-end glow
  beamGlow.visible = false;
  beamGlow.scale.setScalar(0.9);
  scene.add(beamGlow);

  function buildBeam(from, to) {
    const po = beamOuter.geometry.attributes.position;
    const pi = beamInner.geometry.attributes.position;
    const len = from.distanceTo(to);
    for (let i = 0; i < BEAM_PTS; i++) {
      const t = i / (BEAM_PTS - 1);
      _tmp.lerpVectors(from, to, t);
      const amp = Math.sin(Math.PI * t) * (0.06 + len * 0.022);
      const jx = (Math.random() - 0.5) * amp, jy = (Math.random() - 0.5) * amp, jz = (Math.random() - 0.5) * amp;
      po.setXYZ(i, _tmp.x + jx, _tmp.y + jy, _tmp.z + jz);
      pi.setXYZ(i, _tmp.x + jx * 0.35, _tmp.y + jy * 0.35, _tmp.z + jz * 0.35);
    }
    po.needsUpdate = true;
    pi.needsUpdate = true;
    beamOuter.visible = beamInner.visible = true;
    beamGlow.visible = true;
    beamGlow.position.copy(to);
    beamGlow.scale.setScalar(0.7 + Math.random() * 0.5);
  }

  /* ---------------- EMP grenade pool + pulse FX ---------------- */
  const gGeo = new THREE.SphereGeometry(0.16, 18, 14);
  const gMat = new THREE.MeshStandardMaterial({
    color: 0x3a2c14, metalness: 0.7, roughness: 0.35,
    emissive: 0xffb545, emissiveIntensity: 2.2,
  });
  const GRENADES = 5;
  const grenades = [];
  for (let i = 0; i < GRENADES; i++) {
    const mesh = new THREE.Mesh(gGeo, gMat);
    mesh.visible = false;
    mesh.castShadow = true;
    scene.add(mesh);
    grenades.push({ mesh, vel: new THREE.Vector3(), t: 0, active: false });
  }

  const ringGeo = new THREE.RingGeometry(0.86, 1.0, 48);
  ringGeo.rotateX(-Math.PI / 2);
  const RINGS = 6;
  const rings = [];
  for (let i = 0; i < RINGS; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0x6ff0ff, transparent: true, opacity: 0, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const mesh = new THREE.Mesh(ringGeo, mat);
    mesh.visible = false;
    mesh.frustumCulled = false;
    scene.add(mesh);
    rings.push({ mesh, mat, t: 0, ttl: 0.55, active: false, maxR: 7.5 });
  }
  function spawnRing(pos, ttl, maxR, color) {
    const r = rings.find((x) => !x.active) || rings[0];
    r.active = true;
    r.t = 0;
    r.ttl = ttl;
    r.maxR = maxR;
    r.mat.color.set(color);
    r.mesh.position.copy(pos);
    r.mesh.position.y += 0.25;
    r.mesh.scale.setScalar(0.4);
    r.mat.opacity = 0.95;
    r.mesh.visible = true;
  }

  const FLASHES = 4;
  const flashes = [];
  for (let i = 0; i < FLASHES; i++) {
    const mat = new THREE.SpriteMaterial({
      map: glowTex, color: 0xaef6ff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const spr = new THREE.Sprite(mat);
    spr.visible = false;
    scene.add(spr);
    flashes.push({ spr, mat, t: 0, ttl: 0.35, active: false });
  }
  function spawnFlash(pos, scale, color) {
    const f = flashes.find((x) => !x.active) || flashes[0];
    f.active = true;
    f.t = 0;
    f.mat.color.set(color);
    f.mat.opacity = 1;
    f.spr.position.copy(pos);
    f.spr.scale.setScalar(scale);
    f.spr.visible = true;
  }

  const LIGHTS = 3;
  const pulseLights = [];
  for (let i = 0; i < LIGHTS; i++) {
    const light = new THREE.PointLight(0x7ff4ff, 0, 20, 2);
    scene.add(light);
    pulseLights.push({ light, t: 0, active: false, peak: 30 });
  }
  function spawnLight(pos, color, peak) {
    const L = pulseLights.find((x) => !x.active) || pulseLights[0];
    L.active = true;
    L.t = 0;
    L.peak = peak;
    L.light.color.set(color);
    L.light.position.copy(pos);
    L.light.position.y += 0.6;
    L.light.intensity = peak;
  }

  /* ---------------- damage routing ---------------- */
  function hitFlash(e) {
    const mats = e && e.parts && e.parts.emissiveMats;
    if (!mats) return;
    for (let i = 0; i < mats.length; i++) {
      const m = mats[i];
      if (m && m.emissiveIntensity !== undefined && m.emissiveIntensity < 3.2) m.emissiveIntensity = 3.2;
    }
  }

  function emitDmgNum(pos, amount, kind) {
    const a = Math.round(amount);
    if (a < 1) return;
    bus.emit('dmgnum', { pos: pos.clone(), amount: a, kind });
  }

  function hitPosFor(e, hitPos) {
    if (hitPos) return hitPos;
    _tmp2.copy(e.pos);
    _tmp2.y += ((e.cfg && e.cfg.scale) || 1) * 1.2;
    return _tmp2;
  }

  function destroyedFlow(e, source) {
    if (e.dying) return;
    e.hull = 0;
    e.dying = true;
    const hostile = !e.captured && e.faction !== 'captured';
    if (hostile) {
      S.stats.destroyed++;
      const cfg = e.cfg || {};
      if (cfg.salvage) {
        const loot = {};
        let any = false;
        for (const k in cfg.salvage) {
          const r = cfg.salvage[k];
          if (!r || r.length < 2) continue;
          const n = rngInt(r[0], r[1]);
          if (n > 0) { loot[k] = n; any = true; }
        }
        if (any && G.progression && G.progression.addSalvage) G.progression.addSalvage(loot);
      }
      if (cfg.coreChance && rng() < cfg.coreChance) {
        bus.emit('core:drop', { pos: e.pos.clone() });
      }
    }
    bus.emit('machine:destroyed', { e, source });
    bus.emit('sfx', { name: 'death' });
    _tmp.copy(e.pos);
    _tmp.y += ((e.cfg && e.cfg.scale) || 1) * 1.0;
    burst(_tmp, 0xff8a5e, 10, 8);
    burst(_tmp, 0x4be8ff, 5, 5);
    if (G.player && G.player.pos && e.pos.distanceTo(G.player.pos) < 35) {
      if (G.engine && G.engine.shake) G.engine.shake(0.3);
    }
  }

  // §6b special routing: rifle hull → named plate only; sourceless hull → 50% to current
  // unbroken plate; stab → exposed core part only.
  function damageColossus(e, hull, stab, source, part, hitPos) {
    let appliedHull = 0, appliedStab = 0;
    if (hull > 0 && e.plates && e.plates.length) {
      let idx = -1, eff = 1;
      if (typeof part === 'string' && part.indexOf('plate') === 0) {
        const pi = parseInt(part.slice(5), 10);
        if (e.plates[pi] && !e.plates[pi].broken) idx = pi;
        // named hit on a broken plate / bad index: shot pings off, no hull damage
      } else if (source !== 'player') {
        // turrets / captured units without part info: half-effect on current unbroken plate
        idx = e.plates.findIndex((p) => p && !p.broken);
        eff = 0.5;
      }
      if (idx >= 0) {
        const pl = e.plates[idx];
        appliedHull = hull * eff;
        pl.hp = Math.max(0, pl.hp - appliedHull);
        let dp = hitPos;
        if (!dp && pl.mesh && pl.mesh.getWorldPosition) dp = pl.mesh.getWorldPosition(_tmp2);
        emitDmgNum(dp || hitPosFor(e, null), appliedHull, 'hull');
        if (pl.mesh && pl.mesh.material && pl.mesh.material.emissiveIntensity !== undefined
            && pl.mesh.material.emissiveIntensity < 3.2) pl.mesh.material.emissiveIntensity = 3.2;
        if (pl.hp <= 0 && !pl.broken) {
          pl.broken = true;
          if (e.coreIdx === null || e.coreIdx === undefined) e.coreIdx = idx;
          bus.emit('colossus:plate', { i: idx });
          bus.emit('sfx', { name: 'slam' });
          if (G.engine && G.engine.shake) G.engine.shake(0.45);
        }
      }
    }
    if (stab > 0 && e.coreIdx !== null && e.coreIdx !== undefined
        && part === 'core' + e.coreIdx && e.coreStab > 0) {
      appliedStab = stab;
      e.coreStab = Math.max(0, e.coreStab - stab);
      emitDmgNum(hitPos || hitPosFor(e, null), stab, 'stab');
      if (e.coreStab <= 0) {
        bus.emit('colossus:core', { i: e.coreIdx });
        bus.emit('sfx', { name: 'emp' });
      }
    }
    hitFlash(e);
    bus.emit('machine:damaged', { e, hull: appliedHull, stab: appliedStab });
  }

  // THE damage entry point. partName/hitPos are optional extras used by combat's own raycasts;
  // external callers (ai, mounts, base) pass (e, {hull|stab}, sourceEntity).
  function damageMachine(e, amounts, source, partName, hitPos) {
    if (!e || e.dying) return;
    let hull = (amounts && amounts.hull) || 0;
    let stab = (amounts && amounts.stab) || 0;
    if (hull <= 0 && stab <= 0) return;

    if (e.type === 'colossus' && !e.captured) {
      damageColossus(e, hull, stab, source, partName, hitPos);
      return;
    }

    if (e.state === 'DISABLED') stab = 0; // disabled machines take hull but not stability
    const prevStab = e.stability;
    if (hull > 0) e.hull = Math.max(0, e.hull - hull);
    if (stab > 0) e.stability = Math.max(0, e.stability - stab);

    hitFlash(e);
    const dp = hitPosFor(e, hitPos);
    if (hull > 0) emitDmgNum(dp, hull, 'hull');
    if (stab > 0) emitDmgNum(dp, stab, 'stab');
    bus.emit('machine:damaged', { e, hull, stab });

    if (e.hull <= 0) {
      destroyedFlow(e, source); // captured units destructible by hostiles too (no loot/stats inside)
      return;
    }
    if (prevStab > 0 && e.stability <= 0 && !e.captured && e.state !== 'DISABLED') {
      bus.emit('machine:disabled', { e }); // ai owns the state transition
      bus.emit('sfx', { name: 'emp' });
    }
  }

  /* ---------------- aiming helpers ---------------- */
  function camAim() {
    camera.getWorldPosition(_camPos);
    camera.getWorldDirection(_dir);
    _right.crossVectors(_dir, _upV);
    if (_right.lengthSq() < 1e-6) _right.set(1, 0, 0);
    else _right.normalize();
    const pp = G.player && G.player.pos;
    if (pp) {
      _muzzle.copy(pp);
      _muzzle.y += 1.45;
      _muzzle.addScaledVector(_right, 0.32).addScaledVector(_dir, 0.55);
    } else {
      _muzzle.copy(_camPos).addScaledVector(_dir, 1);
    }
  }

  function raycastMachines(far) {
    const cols = G.machines && G.machines.colliders;
    if (!cols || !cols.length) return null;
    raycaster.setFromCamera(_ndc, camera);
    raycaster.far = far;
    const hits = raycaster.intersectObjects(cols, false);
    for (let i = 0; i < hits.length; i++) {
      const obj = hits[i].object;
      const ent = obj.userData && obj.userData.entity;
      if (ent && !ent.dying) {
        return { entity: ent, point: hits[i].point, part: obj.userData.part, dist: hits[i].distance };
      }
    }
    return null;
  }

  // cheap terrain hit along camera ray (for tracer endpoints / impact dust)
  function groundHit(origin, dir, maxD) {
    if (!G.world || !G.world.getGroundHeight) return null;
    for (let t = 3; t <= maxD; t += 3) {
      _gp.copy(origin).addScaledVector(dir, t);
      if (_gp.y <= G.world.getGroundHeight(_gp.x, _gp.z)) {
        // refine one step back
        for (let b = t - 3; b <= t; b += 0.75) {
          _gp.copy(origin).addScaledVector(dir, b);
          if (_gp.y <= G.world.getGroundHeight(_gp.x, _gp.z)) return _gp;
        }
        return _gp;
      }
    }
    return null;
  }

  /* ---------------- weapons ---------------- */
  let heat = 0;          // 0..100
  let lockout = 0;       // overheat lockout seconds
  let fireT = 0;         // rifle refire timer
  let arcActive = false;
  let arcTickT = 0;
  let crossT = 0;

  function switchWeapon(n) {
    if (S.weapon === n) return;
    S.weapon = n;
    bus.emit('sfx', { name: 'ui' });
  }

  function fireRifle() {
    camAim();
    heat += 9;
    bus.emit('sfx', { name: 'shot' });
    if (G.engine && G.engine.shake) G.engine.shake(0.06);
    // muzzle flash
    mfT = 0.05;
    mfSpr.visible = true;
    mfSpr.position.copy(_muzzle).addScaledVector(_dir, 0.25);
    mfSpr.scale.setScalar(0.42 + Math.random() * 0.3);
    mfMat.rotation = Math.random() * Math.PI * 2;
    mfMat.opacity = 1;

    const hit = raycastMachines(120);
    if (hit) {
      _end.copy(hit.point);
      burst(hit.point, 0xffd9a0, 6, 6.5);
      bus.emit('sfx', { name: 'hit' });
      damageMachine(hit.entity, { hull: 12 }, 'player', hit.part, hit.point);
    } else {
      const g = groundHit(_camPos, _dir, 120);
      if (g) {
        _end.copy(g);
        burst(g, 0xc9a0ff, 4, 4); // violet soil puff
      } else {
        _end.copy(_camPos).addScaledVector(_dir, 120);
      }
    }
    spawnTracer(_muzzle, _end, 0xffe2b0, 0.08);

    if (heat >= 100) {
      heat = 100;
      lockout = 2;
      bus.emit('sfx', { name: 'ui' }); // distinct overheat blip
    }
  }

  function arcUpdate(dt) {
    camAim();
    const hit = raycastMachines(22);
    if (hit) {
      _end.copy(hit.point);
    } else {
      const g = groundHit(_camPos, _dir, 22);
      if (g) _end.copy(g);
      else _end.copy(_camPos).addScaledVector(_dir, 22);
    }
    arcTickT += dt;
    while (arcTickT >= 0.1) {
      arcTickT -= 0.1;
      if (hit && hit.entity) {
        let stab = 3;   // 30 stab/s
        const hull = 0.2; // 2 hull/s
        if (hit.entity.state === 'PULL_UP') stab *= 2;
        damageMachine(hit.entity, { hull, stab }, 'player', hit.part, hit.point);
      }
    }
    buildBeam(_muzzle, _end);
    if (G.engine && G.engine.shake) G.engine.shake(0.02); // hum
  }

  function stopArcVisual() {
    beamOuter.visible = beamInner.visible = false;
    beamGlow.visible = false;
  }

  function throwGrenade() {
    const g = grenades.find((x) => !x.active);
    if (!g) return;
    camAim();
    S.grenades = Math.max(0, S.grenades - 1);
    g.active = true;
    g.t = 0;
    g.mesh.visible = true;
    g.mesh.position.copy(_muzzle);
    g.vel.copy(_dir).addScaledVector(_upV, 0.25).normalize().multiplyScalar(18);
    bus.emit('sfx', { name: 'shot' });
  }

  function detonate(g) {
    g.active = false;
    g.mesh.visible = false;
    const pos = g.mesh.position;
    spawnRing(pos, 0.55, 7.5, 0x6ff0ff);
    spawnRing(pos, 0.75, 5.5, 0xb0f8ff);
    spawnFlash(pos, 5, 0xaef6ff);
    spawnLight(pos, 0x7ff4ff, 34);
    burst(pos, 0x8ef0ff, 10, 9);
    for (let i = 0; i < S.machines.length; i++) {
      const e = S.machines[i];
      if (!e || e.dying) continue;
      if (e.pos.distanceTo(pos) <= 7) damageMachine(e, { stab: 60 }, 'player');
    }
    bus.emit('sfx', { name: 'emp' });
    if (G.engine && G.engine.shake) G.engine.shake(0.35);
  }

  function updateGrenades(dt) {
    for (let i = 0; i < GRENADES; i++) {
      const g = grenades[i];
      if (!g.active) continue;
      g.t += dt;
      g.vel.y -= 22 * dt;
      g.mesh.position.addScaledVector(g.vel, dt);
      g.mesh.rotation.x += dt * 7;
      g.mesh.rotation.z += dt * 5;
      const p = g.mesh.position;
      const gy = (G.world && G.world.getGroundHeight) ? G.world.getGroundHeight(p.x, p.z) : -1e9;
      if (g.t >= 2.5 || p.y <= gy + 0.18) {
        if (p.y < gy + 0.18) p.y = gy + 0.18;
        detonate(g);
      }
    }
  }

  /* ---------------- crosshair target (10Hz) ---------------- */
  function updateCrosshair() {
    const cols = G.machines && G.machines.colliders;
    if (!cols || !cols.length) { S.crosshairTarget = null; return; }
    raycaster.setFromCamera(_ndc, camera);
    raycaster.far = 140;
    const hits = raycaster.intersectObjects(cols, false);
    for (let i = 0; i < hits.length; i++) {
      const ent = hits[i].object.userData && hits[i].object.userData.entity;
      if (ent && !ent.dying) { S.crosshairTarget = ent; return; }
    }
    S.crosshairTarget = null;
  }

  /* ---------------- FX decay ---------------- */
  function updateFX(dt) {
    for (let i = 0; i < TRACERS; i++) {
      const tr = tracers[i];
      if (!tr.line.visible) continue;
      tr.t += dt;
      const k = tr.t / tr.ttl;
      if (k >= 1) { tr.line.visible = false; tr.mat.opacity = 0; }
      else tr.mat.opacity = 1 - k;
    }
    for (let i = 0; i < SPARKS; i++) {
      const sp = sparks[i];
      if (!sp.spr.visible) continue;
      sp.t += dt;
      const k = sp.t / sp.ttl;
      if (k >= 1) { sp.spr.visible = false; sp.mat.opacity = 0; continue; }
      sp.vel.y -= 14 * dt;
      sp.spr.position.addScaledVector(sp.vel, dt);
      sp.mat.opacity = 1 - k;
      const sc = (0.14) * (1 - k * 0.6);
      sp.spr.scale.setScalar(sc);
    }
    if (mfT > 0) {
      mfT -= dt;
      if (mfT <= 0) { mfSpr.visible = false; mfMat.opacity = 0; }
      else mfMat.opacity = mfT / 0.05;
    }
    for (let i = 0; i < RINGS; i++) {
      const r = rings[i];
      if (!r.active) continue;
      r.t += dt;
      const k = r.t / r.ttl;
      if (k >= 1) { r.active = false; r.mesh.visible = false; r.mat.opacity = 0; continue; }
      const ease = 1 - (1 - k) * (1 - k);
      r.mesh.scale.setScalar(0.4 + (r.maxR - 0.4) * ease);
      r.mat.opacity = 0.95 * (1 - k);
    }
    for (let i = 0; i < FLASHES; i++) {
      const f = flashes[i];
      if (!f.active) continue;
      f.t += dt;
      const k = f.t / f.ttl;
      if (k >= 1) { f.active = false; f.spr.visible = false; f.mat.opacity = 0; continue; }
      f.mat.opacity = 1 - k;
      f.spr.scale.multiplyScalar(1 + dt * 3);
    }
    for (let i = 0; i < LIGHTS; i++) {
      const L = pulseLights[i];
      if (!L.active) continue;
      L.t += dt;
      L.light.intensity = Math.max(0, L.peak * (1 - L.t / 0.4));
      if (L.t >= 0.4) { L.active = false; L.light.intensity = 0; }
    }
  }

  /* ---------------- per-frame update ---------------- */
  function update(dt) {
    // crosshair raycast at 10Hz
    crossT -= dt;
    if (crossT <= 0) { crossT = 0.1; updateCrosshair(); }

    // rifle heat management (always cooling)
    heat = Math.max(0, heat - 30 * dt);
    if (lockout > 0) lockout -= dt;
    if (fireT > 0) fireT -= dt;

    // weapon switching — play mode only (build mode's 1/2/3 belongs to base.js)
    if (S.mode === 'play' && !S.mounted && !S.piloting) {
      if (input.pressed('Digit1')) switchWeapon(1);
      if (input.pressed('Digit2')) switchWeapon(2);
      if (input.pressed('Digit3')) {
        if (S.wreckTier >= 2) switchWeapon(3);
        else bus.emit('sfx', { name: 'ui' }); // deny blip — EMP craft is T2-gated
      }
    }

    const canFire = S.mode === 'play' && !S.mounted && !S.piloting && input.pointerLocked;
    let arcNow = false;

    if (canFire) {
      if (S.weapon === 1) {
        if (input.mouse0 && lockout <= 0 && fireT <= 0) {
          fireT = 0.125; // 8 rps
          fireRifle();
        }
      } else if (S.weapon === 2) {
        if (input.mouse0) {
          arcNow = true;
          arcUpdate(dt);
        }
      } else if (S.weapon === 3) {
        if (input.mouse0Pressed) {
          if (S.grenades > 0) throwGrenade();
          else bus.emit('sfx', { name: 'ui' });
        }
      }
    }

    if (arcNow && !arcActive) {
      arcActive = true;
      arcTickT = 0;
      bus.emit('arc:on', {});
    } else if (!arcNow && arcActive) {
      arcActive = false;
      bus.emit('arc:off', {});
      stopArcVisual();
    }

    updateGrenades(dt);
    updateFX(dt);
  }

  function currentWeapon() {
    if (S.weapon === 2) return { id: 2, name: 'ARC CASTER', ammoText: 'CHARGE ∞' };
    if (S.weapon === 3) return { id: 3, name: 'EMP GRENADE', ammoText: '× ' + S.grenades };
    return {
      id: 1, name: 'SCRAP RIFLE',
      ammoText: lockout > 0 ? 'OVERHEATED' : 'HEAT ' + Math.round(heat) + '%',
    };
  }

  return { update, damageMachine, currentWeapon };
}
