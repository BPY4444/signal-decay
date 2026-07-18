// SIGNAL DECAY — player: kinematic capsule controller, vitals, camera rig (1st/3rd), body mesh.
// CONTRACT §4-player. Movement/camera only in play|build|menu|hack and never while mounted/piloting.
import * as THREE from 'three';
import {
  bus, S, input, clamp, lerp, damp, angleLerp, rng, rngRange,
  makeCanvasTexture, makeNoiseNormalMap,
} from './core.js';

/* tuning */
const WALK_SPEED = 6;
const SPRINT_SPEED = 9;
const STAM_DRAIN = 20;       // /s sprinting
const STAM_REGEN = 14;       // /s after delay
const STAM_DELAY = 1.0;      // s after sprint stops
const GRAVITY = -25;
const JUMP_V = 8.5;
const COYOTE = 0.1;
const SHIELD_REGEN = 10;     // /s
const SHIELD_DELAY = 4.0;    // s after last damage
const LOOK_SENS = 0.0022;
const PITCH_MAX = 1.45;
const BOOM_LEN = 4.5;
const BOOM_UP = 2.0;
const BOOM_AIM = 3.0;
const AIM_SIDE = 0.55;
const EYE_H = 1.7;
const CAM_CLEAR = 0.4;
const FOV_BASE = 70;
const FOV_AIM = 50;
const RADIUS = 0.45;
const INVULN = 2.0;

/* module-scope scratch (no per-frame allocs) */
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _move = new THREE.Vector3();
const _look = new THREE.Vector3();
const _camDesired = new THREE.Vector3();
const _pivot = new THREE.Vector3();
const _sample = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

export function initPlayer(G) {
  const scene = G.engine.scene;
  const world = G.world;

  /* ---------------- root object ---------------- */
  const obj = new THREE.Group();
  obj.name = 'player';
  const spawn = world?.positions?.playerSpawn;
  if (spawn) obj.position.copy(spawn);
  else obj.position.set(-150, 0, -150);
  obj.position.y = world?.getGroundHeight
    ? world.getGroundHeight(obj.position.x, obj.position.z)
    : obj.position.y;
  scene.add(obj);

  /* ---------------- materials / textures ---------------- */
  // brushed violet-grey suit: vertical strokes + panel seams over noise base (seeded, not Math.random)
  const suitTex = makeCanvasTexture(256, (ctx, s) => {
    ctx.fillStyle = '#4a4356';
    ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 900; i++) {
      const x = rng() * s, y = rng() * s, l = 6 + rng() * 26;
      const v = 58 + rng() * 34;
      ctx.strokeStyle = `rgba(${v + 14},${v + 4},${v + 30},${0.10 + rng() * 0.14})`;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + rngRange(-1.5, 1.5), y + l); ctx.stroke();
    }
    // panel seams
    ctx.strokeStyle = 'rgba(18,14,26,0.55)'; ctx.lineWidth = 2;
    for (let i = 0; i < 5; i++) {
      const y = (i + 0.5 + rngRange(-0.15, 0.15)) * (s / 5);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(s, y); ctx.stroke();
    }
    for (let i = 0; i < 4; i++) {
      const x = (i + 0.5 + rngRange(-0.2, 0.2)) * (s / 4);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, s); ctx.stroke();
    }
    // scuffed highlights
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = `rgba(190,180,210,${0.03 + rng() * 0.05})`;
      ctx.fillRect(rng() * s, rng() * s, 2 + rng() * 6, 1 + rng() * 2);
    }
  });
  suitTex.repeat.set(1.6, 1.6);
  const suitNormal = makeNoiseNormalMap(128, 10, 0.8);

  const suitMat = new THREE.MeshStandardMaterial({
    map: suitTex, normalMap: suitNormal, color: 0xbfb4d4,
    metalness: 0.45, roughness: 0.62,
  });
  const jointMat = new THREE.MeshStandardMaterial({
    color: 0x1c1a24, metalness: 0.7, roughness: 0.42, normalMap: suitNormal,
  });
  const helmetMat = new THREE.MeshStandardMaterial({
    map: suitTex, color: 0xd8d0ea, metalness: 0.6, roughness: 0.35,
  });
  const visorMat = new THREE.MeshStandardMaterial({
    color: 0x061a20, metalness: 0.2, roughness: 0.15,
    emissive: 0x4be8ff, emissiveIntensity: 1.6,
  });
  const wreckMat = new THREE.MeshStandardMaterial({
    color: 0x2a1440, metalness: 0.3, roughness: 0.3,
    emissive: 0xb47aff, emissiveIntensity: 2.2,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: 0x0a2026, emissive: 0x2a97ad, emissiveIntensity: 1.1,
    metalness: 0.4, roughness: 0.5,
  });

  /* ---------------- body mesh (~1.8m survivor, faces -Z at rot 0) ---------------- */
  const body = new THREE.Group();
  obj.add(body);

  function cast(m) { m.castShadow = true; m.receiveShadow = false; return m; }

  // torso
  const torso = cast(new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.52, 8, 20), suitMat));
  torso.position.y = 1.12;
  body.add(torso);
  // chest plate accent strips
  const stripGeo = new THREE.BoxGeometry(0.05, 0.3, 0.02);
  const stripL = cast(new THREE.Mesh(stripGeo, accentMat));
  stripL.position.set(-0.14, 1.22, -0.245); stripL.rotation.x = -0.08;
  const stripR = stripL.clone(); stripR.position.x = 0.14;
  body.add(stripL, stripR);
  // pelvis
  const pelvis = cast(new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.12, 6, 16), jointMat));
  pelvis.position.y = 0.82;
  body.add(pelvis);

  // helmet + visor
  const helmet = cast(new THREE.Mesh(new THREE.SphereGeometry(0.195, 24, 18), helmetMat));
  helmet.position.y = 1.63;
  body.add(helmet);
  const visor = new THREE.Mesh(new THREE.SphereGeometry(0.155, 20, 14), visorMat);
  visor.position.set(0, 1.64, -0.1);
  visor.scale.set(1, 0.62, 0.72);
  body.add(visor);
  // neck ring
  const neck = cast(new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.1, 16), jointMat));
  neck.position.y = 1.46;
  body.add(neck);

  // backpack + WRECK core (the violet sphere IS WRECK)
  const pack = cast(new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.44, 0.17), jointMat));
  pack.position.set(0, 1.16, 0.26);
  body.add(pack);
  const packRib = cast(new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.06, 0.19), suitMat));
  packRib.position.set(0, 1.3, 0.26);
  const packRib2 = packRib.clone(); packRib2.position.y = 1.02;
  body.add(packRib, packRib2);
  const wreckCore = new THREE.Mesh(new THREE.SphereGeometry(0.095, 20, 14), wreckMat);
  wreckCore.position.set(0, 1.18, 0.37);
  body.add(wreckCore);
  const wreckHousing = cast(new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.022, 10, 24), jointMat));
  wreckHousing.position.copy(wreckCore.position);
  body.add(wreckHousing);
  const antenna = cast(new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.012, 0.4, 8), jointMat));
  antenna.position.set(0.14, 1.5, 0.28);
  antenna.rotation.z = -0.12;
  body.add(antenna);
  const antennaTip = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 8), wreckMat);
  antennaTip.position.set(0.165, 1.7, 0.28);
  body.add(antennaTip);
  const wreckLight = new THREE.PointLight(0xb47aff, 0.6, 3.2, 2);
  wreckLight.position.copy(wreckCore.position);
  body.add(wreckLight);

  // limbs: pivot groups so swing animates from joints
  const armGeo = new THREE.CapsuleGeometry(0.06, 0.42, 6, 12);
  const legGeo = new THREE.CapsuleGeometry(0.08, 0.5, 6, 12);
  const bootGeo = new THREE.BoxGeometry(0.13, 0.09, 0.22);
  const shoulderGeo = new THREE.SphereGeometry(0.09, 14, 10);

  function makeArm(side) {
    const pivot = new THREE.Group();
    pivot.position.set(0.34 * side, 1.36, 0);
    const shoulder = cast(new THREE.Mesh(shoulderGeo, jointMat));
    pivot.add(shoulder);
    const arm = cast(new THREE.Mesh(armGeo, suitMat));
    arm.position.y = -0.3;
    pivot.add(arm);
    const glove = cast(new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), jointMat));
    glove.position.y = -0.56;
    pivot.add(glove);
    body.add(pivot);
    return pivot;
  }
  function makeLeg(side) {
    const pivot = new THREE.Group();
    pivot.position.set(0.14 * side, 0.78, 0);
    const leg = cast(new THREE.Mesh(legGeo, suitMat));
    leg.position.y = -0.36;
    pivot.add(leg);
    const boot = cast(new THREE.Mesh(bootGeo, jointMat));
    boot.position.set(0, -0.7, -0.04);
    pivot.add(boot);
    body.add(pivot);
    return pivot;
  }
  const armL = makeArm(-1), armR = makeArm(1);
  const legL = makeLeg(-1), legR = makeLeg(1);

  /* ---------------- controller state ---------------- */
  const api = {
    obj,
    pos: obj.position,
    yaw: Math.PI * 0.25,
    pitch: -0.08,
    health: 100, healthMax: 100,
    shield: 50, shieldMax: 50,
    stamina: 100, staminaMax: 100,
    cameraMode: 'third',
    velY: 0,
    onGround: true,
    update,
    damage,
    applyLevelBonuses,
  };

  const velH = new THREE.Vector3();       // horizontal velocity (persistent)
  const smPivot = new THREE.Vector3();    // smoothed camera pivot
  smPivot.copy(obj.position); smPivot.y += BOOM_UP;
  let coyoteT = 0;
  let sinceDamage = 999;
  let sinceSprint = 999;
  let invulnT = 0;
  let sprintLock = false;
  let walkPhase = 0;
  let bodyYaw = api.yaw;
  let fov = FOV_BASE;
  let camInit = false;
  let dead = false;

  const CONTROL_MODES = { play: 1, build: 1, menu: 1, hack: 1 };

  /* ---------------- vitals ---------------- */
  function damage(amount, srcPos) {
    if (dead || invulnT > 0 || !(amount > 0)) return;
    sinceDamage = 0;
    let rem = amount;
    if (api.shield > 0) {
      const absorbed = Math.min(api.shield, rem);
      api.shield -= absorbed;
      rem -= absorbed;
    }
    if (rem > 0) api.health = Math.max(0, api.health - rem);
    try {
      bus.emit('player:damage', { amount });
      bus.emit('shake', { i: 0.25 });
      bus.emit('sfx', { name: 'playerHurt' });
    } catch (_) {}
    if (api.health <= 0) die();
  }

  function die() {
    if (dead) return;
    dead = true;
    S.stats.deaths++;
    try { bus.emit('player:death', {}); bus.emit('shake', { i: 0.8 }); } catch (_) {}
    // respawn
    const sp = G.world?.positions?.playerSpawn;
    if (sp) obj.position.copy(sp);
    if (G.world?.getGroundHeight) obj.position.y = G.world.getGroundHeight(obj.position.x, obj.position.z);
    api.health = api.healthMax;
    api.shield = api.shieldMax;
    api.stamina = api.staminaMax;
    api.velY = 0;
    velH.set(0, 0, 0);
    invulnT = INVULN;
    sinceDamage = 999;
    smPivot.copy(obj.position); smPivot.y += BOOM_UP;
    dead = false;
  }

  function applyLevelBonuses() {
    api.healthMax += 10;
    api.staminaMax += 10;
    api.health = Math.min(api.healthMax, api.health + api.healthMax * 0.25);
    api.stamina = Math.min(api.staminaMax, api.stamina + api.staminaMax * 0.25);
  }

  function regenVitals(dt) {
    invulnT = Math.max(0, invulnT - dt);
    sinceDamage += dt;
    sinceSprint += dt;
    if (sinceDamage >= SHIELD_DELAY && api.shield < api.shieldMax) {
      api.shield = Math.min(api.shieldMax, api.shield + SHIELD_REGEN * dt);
    }
    if (sinceSprint >= STAM_DELAY && api.stamina < api.staminaMax) {
      api.stamina = Math.min(api.staminaMax, api.stamina + STAM_REGEN * dt);
    }
    if (sprintLock && api.stamina > 15) sprintLock = false;
  }

  /* ---------------- update ---------------- */
  function update(dt) {
    regenVitals(dt);
    // WRECK core pulse (cosmetic)
    const pulse = 1.9 + Math.sin(S.time * 3.1) * 0.55;
    wreckMat.emissiveIntensity = pulse;
    wreckLight.intensity = 0.45 + Math.sin(S.time * 3.1) * 0.14;

    // mounted / piloting: mounts/capture own movement AND camera; body stays visible
    if (S.mounted || S.piloting) {
      body.visible = true;
      restPose(dt);
      return;
    }
    if (!CONTROL_MODES[S.mode]) { body.visible = api.cameraMode === 'third'; return; }

    const hackFrozen = S.mode === 'hack';

    /* look */
    if (!hackFrozen) {
      api.yaw -= input.mouseDX * LOOK_SENS;
      api.pitch = clamp(api.pitch - input.mouseDY * LOOK_SENS, -PITCH_MAX, PITCH_MAX);
    }

    /* movement basis (camera-relative, planar) */
    _fwd.set(-Math.sin(api.yaw), 0, -Math.cos(api.yaw));
    _right.set(Math.cos(api.yaw), 0, -Math.sin(api.yaw));

    let ix = 0, iz = 0;
    if (!hackFrozen) {
      if (input.key('KeyW')) iz += 1;
      if (input.key('KeyS')) iz -= 1;
      if (input.key('KeyD')) ix += 1;
      if (input.key('KeyA')) ix -= 1;
    }
    _move.set(0, 0, 0);
    const moving = (ix !== 0 || iz !== 0);
    if (moving) {
      _move.addScaledVector(_fwd, iz).addScaledVector(_right, ix).normalize();
    }

    // sprint
    const wantSprint = moving && !hackFrozen &&
      (input.key('ShiftLeft') || input.key('ShiftRight')) &&
      !sprintLock && api.stamina > 0;
    let speed = WALK_SPEED;
    if (wantSprint) {
      speed = SPRINT_SPEED;
      api.stamina = Math.max(0, api.stamina - STAM_DRAIN * dt);
      sinceSprint = 0;
      if (api.stamina <= 0) sprintLock = true;
    }

    // horizontal velocity smoothing
    velH.x = damp(velH.x, _move.x * speed, 12, dt);
    velH.z = damp(velH.z, _move.z * speed, 12, dt);
    obj.position.x += velH.x * dt;
    obj.position.z += velH.z * dt;

    /* vertical: gravity, jump, ground follow */
    api.velY += GRAVITY * dt;
    obj.position.y += api.velY * dt;

    const groundY = G.world?.getGroundHeight
      ? G.world.getGroundHeight(obj.position.x, obj.position.z) : 0;

    if (obj.position.y <= groundY + 0.02 && api.velY <= 0) {
      obj.position.y = groundY;
      api.velY = 0;
      api.onGround = true;
      coyoteT = COYOTE;
    } else {
      api.onGround = false;
      coyoteT = Math.max(0, coyoteT - dt);
    }

    if (!hackFrozen && input.pressed('Space') && coyoteT > 0) {
      api.velY = JUMP_V;
      api.onGround = false;
      coyoteT = 0;
      try { bus.emit('sfx', { name: 'jump' }); } catch (_) {}
    }

    // static obstacle pushout (gate, pillars, hull, bounds)
    if (G.world?.resolveCollisions) G.world.resolveCollisions(obj.position, RADIUS);

    /* body animation */
    animateBody(dt, moving, wantSprint ? SPRINT_SPEED : WALK_SPEED);

    /* camera */
    placeCamera(dt, hackFrozen);
  }

  /* ---------------- body animation ---------------- */
  function animateBody(dt, moving, targetSpeed) {
    const planar = Math.hypot(velH.x, velH.z);
    const speedK = clamp(planar / SPRINT_SPEED, 0, 1);
    walkPhase += planar * dt * 2.4;

    // facing: movement direction when moving; camera yaw when aiming/firing
    const engaging = (input.mouse2 || input.mouse0) && (S.mode === 'play' || S.mode === 'build');
    let targetYaw = bodyYaw;
    if (engaging) targetYaw = api.yaw;
    else if (moving && planar > 0.4) targetYaw = Math.atan2(-velH.x, -velH.z);
    bodyYaw = angleLerp(bodyYaw, targetYaw, 1 - Math.exp(-12 * dt));
    body.rotation.y = bodyYaw;

    // bob + forward lean
    body.position.y = Math.abs(Math.sin(walkPhase)) * 0.055 * speedK + (api.onGround ? 0 : 0.03);
    body.rotation.x = speedK * 0.14;
    body.rotation.z = damp(body.rotation.z, -clamp(input.mouseDX * 0.002, -0.1, 0.1) * speedK, 8, dt);

    // limb swing (airborne: tuck)
    const amp = api.onGround ? 0.75 * speedK : 0.25;
    const sw = Math.sin(walkPhase);
    if (api.onGround) {
      legL.rotation.x = sw * amp;
      legR.rotation.x = -sw * amp;
      armL.rotation.x = -sw * amp * 0.8;
      armR.rotation.x = sw * amp * 0.8;
    } else {
      legL.rotation.x = damp(legL.rotation.x, -0.4, 8, dt);
      legR.rotation.x = damp(legR.rotation.x, 0.25, 8, dt);
      armL.rotation.x = damp(armL.rotation.x, -0.9, 8, dt);
      armR.rotation.x = damp(armR.rotation.x, -0.9, 8, dt);
    }
    if (engaging) {
      // raise right arm toward aim
      armR.rotation.x = damp(armR.rotation.x, -1.35 - api.pitch * 0.6, 14, dt);
    }
  }

  function restPose(dt) {
    legL.rotation.x = damp(legL.rotation.x, 0, 6, dt);
    legR.rotation.x = damp(legR.rotation.x, 0, 6, dt);
    armL.rotation.x = damp(armL.rotation.x, 0, 6, dt);
    armR.rotation.x = damp(armR.rotation.x, 0, 6, dt);
    body.rotation.x = damp(body.rotation.x, 0, 6, dt);
    body.rotation.z = damp(body.rotation.z, 0, 6, dt);
    body.position.y = damp(body.position.y, 0, 6, dt);
  }

  /* ---------------- camera rig ---------------- */
  function placeCamera(dt, hackFrozen) {
    const cam = G.engine?.camera;
    if (!cam) return;

    // FOV: RMB aim zoom (play/build only)
    const aiming = input.mouse2 && (S.mode === 'play' || S.mode === 'build');
    fov = damp(fov, aiming ? FOV_AIM : FOV_BASE, 10, dt);
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }

    _euler.set(api.pitch, api.yaw, 0, 'YXZ');

    if (api.cameraMode === 'first') {
      body.visible = false;
      cam.position.set(obj.position.x, obj.position.y + EYE_H, obj.position.z);
      cam.quaternion.setFromEuler(_euler);
      // never below terrain
      const g = G.world?.getGroundHeight ? G.world.getGroundHeight(cam.position.x, cam.position.z) : 0;
      if (cam.position.y < g + CAM_CLEAR) cam.position.y = g + CAM_CLEAR;
      camInit = true;
      return;
    }

    body.visible = true;

    // smoothed pivot follow
    _pivot.set(obj.position.x, obj.position.y + BOOM_UP, obj.position.z);
    if (!camInit) { smPivot.copy(_pivot); camInit = true; }
    const l = hackFrozen ? 30 : 14;
    smPivot.x = damp(smPivot.x, _pivot.x, l, dt);
    smPivot.y = damp(smPivot.y, _pivot.y, l, dt);
    smPivot.z = damp(smPivot.z, _pivot.z, l, dt);

    // full look vector (with pitch)
    _look.set(
      -Math.sin(api.yaw) * Math.cos(api.pitch),
      Math.sin(api.pitch),
      -Math.cos(api.yaw) * Math.cos(api.pitch)
    );

    const boomTarget = aiming ? BOOM_AIM : BOOM_LEN;
    const side = aiming ? AIM_SIDE : 0;

    // terrain-aware boom: sample ground along the boom, shorten to keep CAM_CLEAR above
    let boom = boomTarget;
    if (G.world?.getGroundHeight) {
      const STEPS = 8;
      for (let i = 1; i <= STEPS; i++) {
        const t = (i / STEPS) * boomTarget;
        _sample.copy(smPivot).addScaledVector(_look, -t);
        const g = G.world.getGroundHeight(_sample.x, _sample.z);
        if (_sample.y < g + CAM_CLEAR) {
          // pull boom in just short of the blocking sample
          boom = Math.max(0.6, ((i - 1) / STEPS) * boomTarget);
          break;
        }
      }
    }

    _camDesired.copy(smPivot).addScaledVector(_look, -boom);
    if (side !== 0) {
      _right.set(Math.cos(api.yaw), 0, -Math.sin(api.yaw));
      _camDesired.addScaledVector(_right, side);
    }
    // final terrain clamp at the camera point itself
    if (G.world?.getGroundHeight) {
      const g = G.world.getGroundHeight(_camDesired.x, _camDesired.z);
      if (_camDesired.y < g + CAM_CLEAR) _camDesired.y = g + CAM_CLEAR;
    }

    cam.position.copy(_camDesired);
    cam.quaternion.setFromEuler(_euler);
  }

  return api;
}
