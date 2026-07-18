// SIGNAL DECAY — mounts: shared MountController for Strider (ground) + Halo (arcade flight).
// CONTRACT §4-mounts. Ridden machine's AI suspends (state 'MOUNTED'); we own movement + camera.
import * as THREE from 'three';
import { bus, S, input, clamp, damp, angleLerp } from './core.js';

const GRAVITY = -25;

export function initMounts(G) {
  let camYaw = 0, camPitch = -0.25;
  let vy = 0, onGround = true;
  let galloping = false;
  let lungeCd = 0, lungeT = 0;
  let prevState = null;

  const saddleWorld = new THREE.Vector3();
  const moveDir = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const lookAt = new THREE.Vector3();
  const toTarget = new THREE.Vector3();

  function mount(e) {
    if (S.mounted || !e || e.dying || !e.captured) return;
    if (e.type !== 'strider' && e.type !== 'halo') return;
    S.mounted = e;
    prevState = e.state;
    e.state = 'MOUNTED';
    e.vel.set(0, 0, 0);
    camYaw = G.player.yaw;
    camPitch = -0.25;
    vy = 0; onGround = true; lungeCd = 0; lungeT = 0;
    G.player.cameraMode = 'third';
    bus.emit('mount:on', { e });
    bus.emit('sfx', { name: 'mount' });
  }

  function dismount(safe = false) {
    const e = S.mounted;
    if (!e) return;
    S.mounted = null;
    if (!e.dying) {
      e.state = 'IDLE';
      e.order = { mode: 'follow' };
      // settle flyer/ground unit
      if (!e.flying) e.pos.y = G.world.getGroundHeight(e.pos.x, e.pos.z);
    }
    // place player beside the mount, on the ground
    const p = G.player;
    p.pos.set(e.pos.x + 2, 0, e.pos.z + 1);
    G.world.resolveCollisions(p.pos, 0.45);
    p.pos.y = G.world.getGroundHeight(p.pos.x, p.pos.z);
    p.yaw = camYaw;
    bus.emit('mount:off', { e });
    if (!safe) bus.emit('sfx', { name: 'mount' });
  }

  /* ---------------- rider chip damage + mount death ---------------- */
  bus.on('machine:damaged', (p) => {
    if (p?.e && p.e === S.mounted && p.hull > 0) {
      G.player.damage(p.hull * 0.5, p.e.pos);
    }
  });
  bus.on('machine:destroyed', (p) => {
    if (p?.e && p.e === S.mounted) dismount(true);
  });

  /* ---------------- movement ---------------- */
  function striderUpdate(e, dt) {
    const p = G.player;
    // input dir, camera-relative
    let ix = 0, iz = 0;
    if (input.key('KeyW')) iz -= 1;
    if (input.key('KeyS')) iz += 1;
    if (input.key('KeyA')) ix -= 1;
    if (input.key('KeyD')) ix += 1;
    const hasInput = ix !== 0 || iz !== 0;

    galloping = input.key('ShiftLeft') && hasInput && p.stamina > 1;
    if (galloping) p.stamina = Math.max(0, p.stamina - 15 * dt);
    const speed = galloping ? 24 : 16;

    if (hasInput) {
      const sin = Math.sin(camYaw), cos = Math.cos(camYaw);
      moveDir.set(ix * cos - iz * sin, 0, ix * sin + iz * cos).normalize();
      const targetYaw = Math.atan2(-moveDir.x, -moveDir.z);
      e.yaw = angleLerp(e.yaw, targetYaw, 1 - Math.exp(-8 * dt));
      e.vel.x = damp(e.vel.x, moveDir.x * speed, 6, dt);
      e.vel.z = damp(e.vel.z, moveDir.z * speed, 6, dt);
    } else {
      e.vel.x = damp(e.vel.x, 0, 8, dt);
      e.vel.z = damp(e.vel.z, 0, 8, dt);
    }

    // lunge-bite
    lungeCd -= dt;
    if (input.mouse0Pressed && lungeCd <= 0) {
      lungeCd = 0.8; lungeT = 0.22;
      bus.emit('sfx', { name: 'hit' });
      // cone hit: nearest hostile within 3.5m, ±40° of facing
      let best = null, bd = 3.5 + 2.0;
      for (const m of S.machines) {
        if (m === e || m.faction !== 'hostile' || m.dying) continue;
        toTarget.copy(m.pos).sub(e.pos);
        const d = toTarget.length();
        if (d > bd) continue;
        const ang = Math.atan2(-toTarget.x, -toTarget.z);
        let da = Math.abs(ang - e.yaw) % (Math.PI * 2);
        if (da > Math.PI) da = Math.PI * 2 - da;
        if (da < 0.7) { best = m; bd = d; }
      }
      if (best) {
        G.combat.damageMachine(best, { hull: 25 }, e);
        bus.emit('shake', { i: 0.15 });
      }
    }
    if (lungeT > 0) { // forward dash burst
      lungeT -= dt;
      e.vel.x += -Math.sin(e.yaw) * 30 * dt / 0.22 * 3;
      e.vel.z += -Math.cos(e.yaw) * 30 * dt / 0.22 * 3;
    }

    // vertical
    const ground = G.world.getGroundHeight(e.pos.x, e.pos.z);
    if (onGround && input.pressed('Space')) { vy = 9; onGround = false; bus.emit('sfx', { name: 'jump' }); }
    vy += GRAVITY * dt;
    e.pos.x += e.vel.x * dt;
    e.pos.z += e.vel.z * dt;
    e.pos.y += vy * dt;
    if (e.pos.y <= ground) { e.pos.y = ground; vy = 0; onGround = true; }
    G.world.resolveCollisions(e.pos, 1.0);
  }

  function haloUpdate(e, dt) {
    // arcade: heading follows camera yaw, W thrusts, SPACE/CTRL vertical, hard ceiling
    e.yaw = angleLerp(e.yaw, camYaw + Math.PI, 1 - Math.exp(-5 * dt)); // mesh faces -Z
    fwd.set(-Math.sin(e.yaw), 0, -Math.cos(e.yaw));

    let thrust = 0;
    if (input.key('KeyW')) thrust = 20;
    else if (input.key('KeyS')) thrust = -6;
    e.vel.x = damp(e.vel.x, fwd.x * thrust, 3.5, dt);
    e.vel.z = damp(e.vel.z, fwd.z * thrust, 3.5, dt);

    let vyTarget = 0;
    if (input.key('Space')) vyTarget = 8;
    else if (input.key('ControlLeft') || input.key('ControlRight') || input.key('KeyC')) vyTarget = -8;
    e.vel.y = damp(e.vel.y, vyTarget, 5, dt);

    e.pos.addScaledVector(e.vel, dt);
    const ground = G.world.getGroundHeight(e.pos.x, e.pos.z);
    e.pos.y = clamp(e.pos.y, ground + 2, ground + 60);
    G.world.resolveCollisions(e.pos, 1.2);
    // auto-hover bob when idle
    if (thrust === 0 && vyTarget === 0) e.pos.y += Math.sin(S.time * 2.1) * 0.35 * dt;
  }

  /* ---------------- camera ---------------- */
  function updateCamera(e, dt) {
    camYaw -= input.mouseDX * 0.0022;
    camPitch = clamp(camPitch - input.mouseDY * 0.0022, -1.1, 0.9);

    const boom = e.type === 'halo' ? 10 : 7;
    const cam = G.engine.camera;
    const cy = Math.cos(camPitch), sy = Math.sin(camPitch);
    camPos.set(
      e.pos.x + Math.sin(camYaw) * boom * cy,
      e.pos.y + 2.5 + boom * sy * -1 + 1.2,
      e.pos.z + Math.cos(camYaw) * boom * cy
    );
    // keep camera above terrain
    const g = G.world.getGroundHeight(camPos.x, camPos.z);
    if (camPos.y < g + 0.5) camPos.y = g + 0.5;
    cam.position.lerp(camPos, 1 - Math.exp(-12 * dt));
    lookAt.set(e.pos.x, e.pos.y + 1.8, e.pos.z);
    cam.lookAt(lookAt);
  }

  function update(dt) {
    const e = S.mounted;
    if (!e) return;
    if (S.mode !== 'play') { updateCamera(e, dt); return; }
    if (e.dying) { dismount(true); return; }

    if (e.type === 'strider') striderUpdate(e, dt);
    else haloUpdate(e, dt);

    // pin player to saddle
    if (e.saddle) {
      e.saddle.getWorldPosition(saddleWorld);
      G.player.pos.copy(saddleWorld);
    } else {
      G.player.pos.set(e.pos.x, e.pos.y + 1.6, e.pos.z);
    }
    G.player.yaw = e.yaw;

    updateCamera(e, dt);
  }

  return { update, mount, dismount };
}
