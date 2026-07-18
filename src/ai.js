// SIGNAL DECAY — ai: shared machine FSM, senses (vision/hearing/damage-aggro), alarm system,
// captured-unit order execution, machine-vs-machine combat, colossus phase controller.
// See CONTRACT.md §4-ai / §9, BRIEF §4.8. Cross-system access only via G.
import * as THREE from 'three';
import { bus, S, diff, clamp, damp, angleLerp, dist2d } from './core.js';

/* module-scope scratch — no per-frame Vector3 allocations in hot loops */
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _zero = new THREE.Vector3();

const TWO_PI = Math.PI * 2;
const CULL_DIST = 140;          // beyond this: 4Hz coarse tick
const ALARM_RADIUS = 80;
const HEAR_RADIUS = 40;
const COL_RING_HOSTILE = 0xff5030;
const COL_RING_CAPTURED = 0x35e0ff;

const RADIUS = { drifter: 0.7, skitter: 0.8, strider: 0.9, warden: 1.2, halo: 1.4, colossus: 4 };

function angDiff(a, b) {
  let d = (a - b) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  if (d < -Math.PI) d += TWO_PI;
  return d;
}

export function initAI(G) {
  const scene = G.engine.scene;

  /* ================= tiny per-entity ai scratch ================= */

  function ai(e) {
    if (!e.ai) {
      e.ai = {
        cullAcc: 0, hover: null, freeY: false,
        wx: null, wz: null,                      // wander target
        windup: 0, realarm: 12, lostT: 0,        // drifter
        commitT: 0, lookAway: 0, stalkAng: 0, stalkDir: 1, circDir: 1,
        phase: 'circle', t: 0, biteCd: 1,        // strider phases
        slamCd: 1.5, tele: 0, guardT: null, called: false,
        orb: Math.random() * TWO_PI, cd: 0, hit: false, fell: false,
        aim: null, diveDir: null, line: null, divedOnce: false,
        scanT: 0, stayPos: null, lastMode: null, lastNode: undefined,
        awake: false, staggerT: 0, atkCd: 3, pending: null,
        unseenT: 0,
      };
    }
    return e.ai;
  }

  function setState(e, s) {
    if (e.state !== s) { e.state = s; e.stateT = 0; }
  }

  /* ================= world / movement helpers ================= */

  function ground(x, z) { return G.world?.getGroundHeight?.(x, z) ?? 0; }

  function faceTo(e, x, z, dt, mult = 1) {
    const dx = x - e.pos.x, dz = z - e.pos.z;
    if (dx * dx + dz * dz < 1e-6) return;
    const desired = Math.atan2(-dx, -dz);          // forward = (-sin yaw, 0, -cos yaw)
    e.yaw = angleLerp(e.yaw, desired, Math.min(1, (e.cfg.turnRate || 2) * mult * dt));
  }

  // steer toward (x,z) at speed; returns remaining 2D distance
  function moveTo(e, x, z, speed, dt, turnMult = 1) {
    const d = dist2d(e.pos.x, e.pos.z, x, z);
    faceTo(e, x, z, dt, turnMult);
    const spd = Math.min(speed, d / Math.max(dt, 0.001));
    e.vel.x = -Math.sin(e.yaw) * spd;
    e.vel.z = -Math.cos(e.yaw) * spd;
    e.pos.x += e.vel.x * dt;
    e.pos.z += e.vel.z * dt;
    return d;
  }

  function moveAwayFrom(e, x, z, speed, dt) {
    const dx = e.pos.x - x, dz = e.pos.z - z;
    const l = Math.hypot(dx, dz) || 1;
    return moveTo(e, e.pos.x + (dx / l) * 25, e.pos.z + (dz / l) * 25, speed, dt, 1.4);
  }

  function hold(e) { e.vel.set(0, 0, 0); }

  // ground clamp / hover damp + static collision resolution
  function settle(e, dt) {
    const A = e.ai;
    if (e.flying) {
      if (!(A && A.freeY)) {
        const gy = ground(e.pos.x, e.pos.z);
        const h = (A && A.hover != null) ? A.hover : e.hoverH;
        e.pos.y = damp(e.pos.y, gy + h, 2.6, dt);
      }
    } else {
      e.pos.y = ground(e.pos.x, e.pos.z);
    }
    if (e.type !== 'colossus') G.world?.resolveCollisions?.(e.pos, RADIUS[e.type] || 1);
    else {
      e.pos.x = clamp(e.pos.x, -285, 285);
      e.pos.z = clamp(e.pos.z, -285, 285);
      e.pos.y = ground(e.pos.x, e.pos.z);
    }
  }

  /* ================= player tracking (for prediction/senses) ================= */

  const prevPP = new THREE.Vector3();
  const playerVel = new THREE.Vector3();
  let ppInit = false;

  /* ================= senses ================= */

  function detectRange(e) {
    let r = e.cfg.detect?.range ?? 20;
    if (e.cfg.cls === 'sentient') r *= 1 + 0.4 * S.night;      // night buff (sentient only)
    if (e.memory?.escaped) r *= 1.3;                            // strider grudge
    return r;
  }

  function canSeePlayer(e) {
    const pp = G.player?.pos;
    if (!pp) return false;
    const d = e.pos.distanceTo(pp);
    if (d > detectRange(e)) return false;
    const fovHalf = ((e.cfg.detect?.fov ?? 120) * Math.PI) / 360;
    if (fovHalf < Math.PI) {
      const ang = Math.atan2(-(pp.x - e.pos.x), -(pp.z - e.pos.z));
      if (Math.abs(angDiff(ang, e.yaw)) > fovHalf) return false;
    }
    e.memory.playerSeen = S.time;
    return true;
  }

  // nearest captured combat-visible unit (hostiles pick on the player's squad)
  function nearestCaptured(e, range) {
    let best = null, bestD = range;
    for (const m of S.captured) {
      if (!m || m.dying || m._removed || m === S.mounted || m === S.piloting) continue;
      if (m.type === 'colossus') continue;
      const d = e.pos.distanceTo(m.pos);
      if (d < bestD) { bestD = d; best = m; }
    }
    return best;
  }

  // returns 'player' | captured entity | null
  function senseWild(e) {
    if (canSeePlayer(e)) return 'player';
    if (e.cfg.attack) {
      const t = nearestCaptured(e, detectRange(e) * 0.8);
      if (t) return t;
    }
    return null;
  }

  /* ================= target plumbing (player or machine) ================= */

  function targetPos(e) {
    const t = e.target;
    if (t === 'player') return G.player?.pos || null;
    if (t && t.pos && !t.dying && !t._removed && t.state !== 'DISABLED') return t.pos;
    if (t) e.target = null;
    return null;
  }

  function hurtTarget(e, dmg) {
    if (e.target === 'player') {
      G.player?.damage?.(dmg, e.pos);
    } else if (e.target && e.target.pos) {
      G.combat?.damageMachine?.(e.target, { hull: dmg }, e);
    }
  }

  /* ================= alarm system ================= */

  function raiseAlarm(pos) {
    if (!pos) return;
    _c.set(pos.x, pos.y || 0, pos.z);
    bus.emit('alarm', { pos: _c.clone() });
    bus.emit('sfx', { name: 'alarm' });
  }

  function setInvestigate(e, pos) {
    if (!e.alertPos) e.alertPos = new THREE.Vector3();
    e.alertPos.set(pos.x, pos.y || 0, pos.z);
    setState(e, 'INVESTIGATE');
    ai(e).guardT = null;
  }

  function applyAlarm(pos) {
    if (!pos) return;
    for (const e of S.machines) {
      if (!e || e.dying || e.faction !== 'hostile') continue;
      if (e.type === 'skitter' || e.type === 'colossus') continue;
      if (e.state === 'DISABLED' || e === S.mounted || e === S.piloting) continue;
      if (dist2d(e.pos.x, e.pos.z, pos.x, pos.z) > ALARM_RADIUS) continue;
      if (e.cfg.converges) {
        if (!e.alertPos) e.alertPos = new THREE.Vector3();
        e.alertPos.set(pos.x, pos.y || 0, pos.z);
        setState(e, 'CONVERGE');
        ai(e).guardT = null;
      } else if (e.state === 'PATROL' || e.state === 'IDLE' || e.state === 'INVESTIGATE' || e.state === 'CHEW') {
        setInvestigate(e, pos);
      }
    }
  }

  // shared INVESTIGATE: walk to alertPos, look around, 6s give-up after arrival
  function tickInvestigate(e, dt, speed) {
    const A = ai(e);
    if (!e.alertPos) { setState(e, 'PATROL'); return; }
    const d = moveTo(e, e.alertPos.x, e.alertPos.z, speed, dt);
    if (d < 4) {
      hold(e);
      e.yaw += dt * 0.9;
      if (A.guardT == null) A.guardT = 6;
      A.guardT -= dt;
      if (A.guardT <= 0) { A.guardT = null; setState(e, 'PATROL'); }
    }
  }

  /* ================= shockwave ring pool ================= */

  const ringGeo = new THREE.RingGeometry(0.86, 1, 48);
  ringGeo.rotateX(-Math.PI / 2);
  const ringPool = [];
  const rings = [];      // active: { mesh, x, z, r, maxR, speed, dmg, band, hostile, hitPlayer }
  const ringQueue = [];  // pending staggered slams: { t, x, z, maxR, dmg, speed, band, hostile, color }

  function acquireRingMesh(color) {
    let m = ringPool.pop();
    if (!m) {
      m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending,
        depthWrite: false, side: THREE.DoubleSide,
      }));
      m.renderOrder = 20;
    }
    m.material.color.setHex(color);
    m.visible = true;
    scene.add(m);
    return m;
  }

  function spawnRing(x, z, maxR, dmg, speed = 12, band = 1.2, color = COL_RING_HOSTILE, hostile = true) {
    const mesh = acquireRingMesh(color);
    mesh.position.set(x, ground(x, z) + 0.22, z);
    mesh.scale.setScalar(1.2);
    rings.push({ mesh, x, z, r: 1.2, maxR, speed, dmg, band, hostile, hitPlayer: false });
  }

  function updateRings(dt) {
    for (let i = ringQueue.length - 1; i >= 0; i--) {
      const q = ringQueue[i];
      q.t -= dt;
      if (q.t <= 0) {
        spawnRing(q.x, q.z, q.maxR, q.dmg, q.speed, q.band, q.color, q.hostile);
        ringQueue.splice(i, 1);
      }
    }
    const pp = G.player?.pos;
    for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      r.r += r.speed * dt;
      r.mesh.scale.setScalar(r.r);
      r.mesh.material.opacity = 0.85 * clamp(1 - r.r / r.maxR, 0, 1);
      if (r.hostile && !r.hitPlayer && pp) {
        const d = dist2d(pp.x, pp.z, r.x, r.z);
        const low = pp.y - ground(pp.x, pp.z) < 1.15;   // jump to dodge
        if (Math.abs(d - r.r) < r.band && low) {
          r.hitPlayer = true;
          G.player?.damage?.(r.dmg, r.mesh.position);
          bus.emit('shake', { i: 0.35 });
          bus.emit('sfx', { name: 'hit' });
        }
      }
      if (r.r >= r.maxR) {
        scene.remove(r.mesh);
        r.mesh.visible = false;
        ringPool.push(r.mesh);
        rings.splice(i, 1);
      }
    }
  }

  // instant machine-side AoE for slams (opposing faction, never DISABLED, never colossus)
  function slamHitMachines(e, radius, dmg) {
    for (const m of S.machines) {
      if (!m || m === e || m.dying || m._removed) continue;
      if (m.faction === e.faction) continue;
      if (m.state === 'DISABLED' || m.type === 'colossus') continue;
      if (m.pos.distanceTo(e.pos) <= radius) G.combat?.damageMachine?.(m, { hull: dmg }, e);
    }
  }

  /* ================= halo telegraph line pool ================= */

  const linePool = [];

  function acquireLine() {
    let l = linePool.pop();
    if (!l) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      l = new THREE.Line(g, new THREE.LineBasicMaterial({
        color: 0xff2626, transparent: true, opacity: 0.85,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      l.frustumCulled = false;
      l.renderOrder = 21;
    }
    l.visible = true;
    scene.add(l);
    return l;
  }

  function updateLine(l, from, to) {
    const p = l.geometry.attributes.position;
    p.array[0] = from.x; p.array[1] = from.y; p.array[2] = from.z;
    p.array[3] = to.x; p.array[4] = to.y; p.array[5] = to.z;
    p.needsUpdate = true;
  }

  function clearLine(e) {
    const A = e.ai;
    if (A && A.line) {
      scene.remove(A.line);
      A.line.visible = false;
      linePool.push(A.line);
      A.line = null;
    }
  }

  /* ================= DISABLED / reboot ================= */

  function tickDisabled(e, dt) {
    const A = ai(e);
    hold(e);
    if (e.flying) {
      const gy = ground(e.pos.x, e.pos.z);
      if (e.pos.y > gy + 0.45) {
        e.pos.y = Math.max(gy + 0.4, e.pos.y - dt * 20);      // fall to the dirt over ~1s
      } else if (!A.fell) {
        A.fell = true;
        bus.emit('shake', { i: 0.12 });
        bus.emit('sfx', { name: 'stomp' });
      }
    } else {
      e.pos.y = ground(e.pos.x, e.pos.z);
    }
    if (e.hackLock) return;      // hacking freezes the reboot countdown
    e.disabledT -= dt;
    if (e.disabledT <= 0) reboot(e, false);
  }

  function reboot(e, angry) {
    e.disabledT = 0;
    e.hackLock = false;
    e.stability = e.stabilityMax * 0.5;
    const A = ai(e);
    A.fell = false; A.phase = 'circle'; A.tele = 0; A.t = 0;
    const pp = G.player?.pos;
    const near = pp && e.pos.distanceTo(pp) < 30;
    if (e.cfg.attack && (angry || near)) {
      e.target = 'player';
      setState(e, 'ATTACK');
    } else if (e.type === 'drifter' && (angry || near)) {
      A.windup = angry ? 0.6 : (e.cfg.alarmWindup ?? 2);
      setState(e, 'ALARM');
    } else if (e.type === 'skitter' && (angry || near)) {
      setState(e, 'FLEE');
    } else {
      e.target = null;
      setState(e, 'PATROL');
    }
    G.machines?.applyFaction?.(e);
    bus.emit('machine:rebooted', { e });
  }

  /* ================= DRIFTER ================= */

  function tickDrifter(e, dt) {
    const A = ai(e), cfg = e.cfg;
    const pp = G.player?.pos;
    A.hover = cfg.hoverH;
    A.freeY = false;
    switch (e.state) {
      case 'PATROL': {
        // low-hover meander across the whole map
        if (A.wx == null || dist2d(e.pos.x, e.pos.z, A.wx, A.wz) < 4) {
          A.wx = clamp(e.pos.x + (Math.random() * 2 - 1) * 160, -270, 270);
          A.wz = clamp(e.pos.z + (Math.random() * 2 - 1) * 160, -270, 270);
        }
        moveTo(e, A.wx, A.wz, cfg.speed * 0.75, dt);
        if (canSeePlayer(e)) { setState(e, 'ALARM'); A.windup = cfg.alarmWindup ?? 2; }
        break;
      }
      case 'INVESTIGATE': {
        tickInvestigate(e, dt, cfg.speed);
        if (canSeePlayer(e)) { setState(e, 'ALARM'); A.windup = cfg.alarmWindup ?? 2; }
        break;
      }
      case 'ALARM': {
        // red-strobe windup (machines.js strobes the ALARM state); kill/disable during it = silenced
        hold(e);
        A.hover = cfg.hoverH + 1.2;
        if (pp) faceTo(e, pp.x, pp.z, dt, 2.2);
        A.windup -= dt;
        if (A.windup <= 0 && pp) {
          raiseAlarm(pp);
          A.realarm = 12;
          A.lostT = 0;
          setState(e, 'FLEE');
        }
        break;
      }
      case 'FLEE': {
        if (!pp) { setState(e, 'PATROL'); break; }
        moveAwayFrom(e, pp.x, pp.z, cfg.fleeSpeed ?? cfg.speed * 1.7, dt);
        if (canSeePlayer(e)) {
          A.lostT = 0;
          A.realarm -= dt;
          if (A.realarm <= 0) { raiseAlarm(pp); A.realarm = 12; }   // re-alarm while player visible
        } else {
          A.lostT += dt;
          if (A.lostT > 5 && e.pos.distanceTo(pp) > 60) setState(e, 'PATROL');
        }
        break;
      }
      default: setState(e, 'PATROL');
    }
  }

  /* ================= SKITTER ================= */

  function ensurePatrol(e) {
    const A = ai(e);
    const want = e.assignedNode || null;
    const bad = !e.patrol || !e.patrol.nodes || !e.patrol.nodes.length;
    if (!e.patrolDirty && A.lastNode === want && !bad) return;
    e.patrolDirty = false;
    A.lastNode = want;
    const nodes = G.world?.nodes || [];
    const pref = [], rest = [];
    for (const n of nodes) {
      if (!n || !n.pos) continue;
      (want && n.type === want ? pref : rest).push(n);
    }
    const pool = pref.length ? pref : rest;
    pool.sort((x, y) => x.pos.distanceTo(e.pos) - y.pos.distanceTo(e.pos));
    const pts = [];
    for (let i = 0; i < Math.min(3, pool.length); i++) pts.push(pool[i].pos.clone());
    while (pts.length < 2) {
      const ax = clamp(e.pos.x + (Math.random() * 2 - 1) * 40, -280, 280);
      const az = clamp(e.pos.z + (Math.random() * 2 - 1) * 40, -280, 280);
      pts.push(new THREE.Vector3(ax, ground(ax, az), az));
    }
    e.patrol = { nodes: pts, i: 0 };
  }

  function skitterCircuit(e, dt) {
    ensurePatrol(e);
    const cfg = e.cfg;
    if (e.state === 'CHEW') {
      hold(e);
      if (e.stateT > 4) {
        e.patrol.i = (e.patrol.i + 1) % e.patrol.nodes.length;
        setState(e, 'PATROL');
      }
      return;
    }
    const n = e.patrol.nodes[e.patrol.i % e.patrol.nodes.length];
    const d = moveTo(e, n.x, n.z, cfg.speed, dt);
    if (d < 1.8) setState(e, 'CHEW');
  }

  function tickSkitter(e, dt) {
    const pp = G.player?.pos;
    switch (e.state) {
      case 'FLEE': {
        if (pp) moveAwayFrom(e, pp.x, pp.z, e.cfg.fleeSpeed ?? 6, dt);
        if (e.stateT > 2.6) setState(e, 'PATROL');
        break;
      }
      case 'PATROL':
      case 'CHEW':
        skitterCircuit(e, dt);
        break;
      default: setState(e, 'PATROL');
    }
  }

  /* ================= STRIDER ================= */

  function striderAttack(e, dt) {
    const A = ai(e), cfg = e.cfg, atk = cfg.attack || {};
    const tp = targetPos(e);
    if (!tp) { setState(e, e.captured ? 'IDLE' : 'PATROL'); return; }
    const d = dist2d(e.pos.x, e.pos.z, tp.x, tp.z);
    A.biteCd -= dt;
    switch (A.phase) {
      case 'tele': {
        hold(e);
        faceTo(e, tp.x, tp.z, dt, 3);
        A.t -= dt;
        if (A.t <= 0) { A.phase = 'lunge'; A.t = 0.55; }
        break;
      }
      case 'lunge': {
        const dd = moveTo(e, tp.x, tp.z, 24, dt, 3);
        A.t -= dt;
        if (dd <= (atk.range ?? 2.8)) {
          hurtTarget(e, atk.dmg ?? 12);
          bus.emit('sfx', { name: 'hit' });
          if (e.target === 'player') bus.emit('shake', { i: 0.18 });
          A.phase = 'retreat'; A.t = 0.9;
          A.biteCd = (atk.cooldown ?? 1.6) * (0.85 + Math.random() * 0.5);
        } else if (A.t <= 0) {
          A.phase = 'retreat'; A.t = 0.9;
          A.biteCd = atk.cooldown ?? 1.6;
        }
        break;
      }
      case 'retreat': {
        moveAwayFrom(e, tp.x, tp.z, cfg.speed * 0.9, dt);
        A.t -= dt;
        if (A.t <= 0 || d > 11) A.phase = 'circle';
        break;
      }
      default: {           // circle: strafe the 8-12m ring, forcing re-aim
        if (d > 26) { moveTo(e, tp.x, tp.z, cfg.speed, dt); break; }
        faceTo(e, tp.x, tp.z, dt, 1.8);
        const inv = 1 / Math.max(d, 0.01);
        const rx = (e.pos.x - tp.x) * inv, rz = (e.pos.z - tp.z) * inv;
        const radial = clamp((10 - d) * 0.35, -1, 1);
        let mx = -rz * A.circDir + rx * radial;
        let mz = rx * A.circDir + rz * radial;
        const ml = Math.hypot(mx, mz) || 1;
        const spd = cfg.speed * 0.72;
        e.vel.x = (mx / ml) * spd;
        e.vel.z = (mz / ml) * spd;
        e.pos.x += e.vel.x * dt;
        e.pos.z += e.vel.z * dt;
        if (Math.random() < dt * 0.25) A.circDir *= -1;
        if (A.biteCd <= 0 && d < 15) { A.phase = 'tele'; A.t = atk.telegraph ?? 0.35; }
      }
    }
  }

  function tickStrider(e, dt) {
    const A = ai(e), cfg = e.cfg;
    const pp = G.player?.pos;

    // sentient flee-when-losing
    if (e.hull < e.hullMax * (cfg.fleeAt ?? 0.25) && e.state !== 'FLEE') {
      e.memory.escaped = true;
      setState(e, 'FLEE');
    }

    switch (e.state) {
      case 'PATROL': {
        const home = e.home || e.pos;
        if (A.wx == null || dist2d(e.pos.x, e.pos.z, A.wx, A.wz) < 3) {
          A.wx = clamp(home.x + (Math.random() * 2 - 1) * 40, -280, 280);
          A.wz = clamp(home.z + (Math.random() * 2 - 1) * 40, -280, 280);
        }
        moveTo(e, A.wx, A.wz, cfg.speed * 0.5, dt);
        const t = senseWild(e);
        if (t === 'player') {
          setState(e, 'STALK');
          e.target = 'player';
          A.commitT = 8 + Math.random() * 7;
          A.lookAway = 0;
          A.stalkAng = Math.atan2(e.pos.z - (pp?.z ?? 0), e.pos.x - (pp?.x ?? 0));
          A.stalkDir = Math.random() < 0.5 ? -1 : 1;
        } else if (t) {
          e.target = t;
          A.phase = 'circle';
          setState(e, 'ATTACK');
        }
        break;
      }
      case 'INVESTIGATE': {
        tickInvestigate(e, dt, cfg.speed * 0.85);
        const t = senseWild(e);
        if (t === 'player') {
          setState(e, 'STALK');
          e.target = 'player';
          A.commitT = 8 + Math.random() * 7;
          A.lookAway = 0;
          A.stalkAng = Math.atan2(e.pos.z - (pp?.z ?? 0), e.pos.x - (pp?.x ?? 0));
        } else if (t) { e.target = t; A.phase = 'circle'; setState(e, 'ATTACK'); }
        break;
      }
      case 'STALK': {
        if (!pp) { setState(e, 'PATROL'); break; }
        e.target = 'player';
        // shadow at 25-35m on a drifting offset angle (cover-ish repositioning)
        A.stalkAng += dt * 0.25 * A.stalkDir;
        if (Math.random() < dt * 0.12) A.stalkDir *= -1;
        const tx = pp.x + Math.cos(A.stalkAng) * 30;
        const tz = pp.z + Math.sin(A.stalkAng) * 30;
        moveTo(e, tx, tz, cfg.speed * 0.85, dt);
        const seen = canSeePlayer(e);
        if (!seen && S.time - (e.memory.playerSeen || 0) > 10) { setState(e, 'PATROL'); break; }
        // commit when the timer runs out or the player looks away for 3s
        const dx = e.pos.x - pp.x, dz = e.pos.z - pp.z;
        const dd = Math.hypot(dx, dz) || 1;
        const pyaw = G.player?.yaw ?? 0;
        const dot = (-Math.sin(pyaw)) * (dx / dd) + (-Math.cos(pyaw)) * (dz / dd);
        if (dot < 0.1) A.lookAway += dt; else A.lookAway = 0;
        A.commitT -= dt;
        if (A.commitT <= 0 || A.lookAway >= 3) {
          setState(e, 'FLANK');
          A.t = 6;
          A.circDir = Math.random() < 0.5 ? -1 : 1;
        }
        break;
      }
      case 'FLANK': {
        if (!pp) { setState(e, 'PATROL'); break; }
        e.target = 'player';
        // approach through a point ±60° off the player's facing
        const pyaw = G.player?.yaw ?? 0;
        const fx = -Math.sin(pyaw), fz = -Math.cos(pyaw);
        const s60 = A.circDir * (Math.PI / 3);
        const cs = Math.cos(s60), sn = Math.sin(s60);
        const ox = fx * cs - fz * sn, oz = fx * sn + fz * cs;
        moveTo(e, pp.x + ox * 9, pp.z + oz * 9, cfg.speed, dt, 1.6);
        A.t -= dt;
        if (dist2d(e.pos.x, e.pos.z, pp.x, pp.z) < 12 || A.t <= 0) {
          A.phase = 'circle';
          setState(e, 'ATTACK');
        }
        break;
      }
      case 'ATTACK':
        striderAttack(e, dt);
        break;
      case 'FLEE': {
        if (pp) moveAwayFrom(e, pp.x, pp.z, cfg.fleeSpeed ?? 12.5, dt);
        // remember and re-stalk with the +30% grudge after 30s
        if (e.stateT > 30) setState(e, 'PATROL');
        break;
      }
      default: setState(e, 'PATROL');
    }
  }

  /* ================= WARDEN ================= */

  function wardenAttack(e, dt) {
    const A = ai(e), cfg = e.cfg, atk = cfg.attack || {};
    const tp = targetPos(e);
    if (!tp) { setState(e, e.captured ? 'IDLE' : 'PATROL'); return; }
    const d = dist2d(e.pos.x, e.pos.z, tp.x, tp.z);
    A.slamCd -= dt;
    if (A.tele > 0) {
      hold(e);
      faceTo(e, tp.x, tp.z, dt, 2);        // arms-up windup (machines.js raises arms in ATTACK)
      A.tele -= dt;
      if (A.tele <= 0) {
        bus.emit('sfx', { name: 'slam' });
        bus.emit('shake', { i: 0.4 });
        spawnRing(e.pos.x, e.pos.z, atk.aoe ?? 6, atk.dmg ?? 26, 11, 1.15,
          e.faction === 'captured' ? COL_RING_CAPTURED : COL_RING_HOSTILE, e.faction === 'hostile');
        slamHitMachines(e, atk.aoe ?? 6, atk.dmg ?? 26);
        A.slamCd = atk.cooldown ?? 2.8;
      }
    } else if (d > (atk.range ?? 3.5)) {
      moveTo(e, tp.x, tp.z, cfg.speed, dt);
    } else {
      hold(e);
      faceTo(e, tp.x, tp.z, dt, 2);
      if (A.slamCd <= 0) A.tele = atk.telegraph ?? 0.8;
    }
  }

  function tickWarden(e, dt) {
    const A = ai(e), cfg = e.cfg;
    // CALL_HELP once at 50% hull (wardens never flee)
    if (cfg.callsHelp && !A.called && e.hull < e.hullMax * 0.5) {
      A.called = true;
      raiseAlarm(e.pos);
    }
    switch (e.state) {
      case 'PATROL': {
        const home = e.home || e.pos;
        if (dist2d(e.pos.x, e.pos.z, home.x, home.z) > 3) {
          moveTo(e, home.x, home.z, cfg.speed, dt);
        } else {
          hold(e);
          e.yaw += Math.sin(S.time * 0.35 + e.id) * dt * 0.5;   // scan turns at post
        }
        const t = senseWild(e);
        if (t) { e.target = t; setState(e, 'ATTACK'); }
        break;
      }
      case 'INVESTIGATE': {
        tickInvestigate(e, dt, cfg.speed);
        const t = senseWild(e);
        if (t) { e.target = t; setState(e, 'ATTACK'); }
        break;
      }
      case 'CONVERGE': {
        if (!e.alertPos) { setState(e, 'PATROL'); break; }
        const d = moveTo(e, e.alertPos.x, e.alertPos.z, cfg.speed * 1.15, dt);
        if (d < 5) {
          hold(e);
          e.yaw += dt * 0.6;
          if (A.guardT == null) A.guardT = 20;    // hold the alarm point before returning to post
          A.guardT -= dt;
          if (A.guardT <= 0) { A.guardT = null; setState(e, 'PATROL'); }
        }
        const t = senseWild(e);
        if (t) { e.target = t; setState(e, 'ATTACK'); }
        break;
      }
      case 'ATTACK': {
        // taunt: prefer a captured follow-mode warden within 15m
        if (e.target === 'player') {
          for (const m of S.captured) {
            if (m && m.type === 'warden' && !m.dying && m.order?.mode === 'follow'
              && m !== S.mounted && m.pos.distanceTo(e.pos) < 15) { e.target = m; break; }
          }
        }
        if (e.target === 'player') {
          canSeePlayer(e);
          const pp = G.player?.pos;
          if (pp && e.pos.distanceTo(pp) > 45 && S.time - (e.memory.playerSeen || 0) > 6) {
            e.target = null;
            setState(e, 'PATROL');
            break;
          }
        }
        wardenAttack(e, dt);
        break;
      }
      default: setState(e, 'PATROL');
    }
  }

  /* ================= HALO ================= */

  const wingAnchors = new Map();
  function wingAnchor(e) {
    const key = e.wing != null ? 'w' + e.wing : 's' + e.id;
    let a = wingAnchors.get(key);
    if (!a) { a = (e.home || e.pos).clone(); wingAnchors.set(key, a); }
    return a;
  }

  function wingmateDiving(e) {
    if (e.wing == null) return false;
    for (const o of S.machines) {
      if (o === e || !o || o.type !== 'halo' || o.dying || o.wing !== e.wing) continue;
      if (o.state === 'DIVE' || (o.state === 'ATTACK' && o.ai && o.ai.phase === 'aim')) return true;
    }
    return false;
  }

  function haloAttack(e, dt) {
    const A = ai(e), cfg = e.cfg;
    const tp = targetPos(e);
    if (!tp) { clearLine(e); setState(e, e.captured ? 'IDLE' : 'PATROL'); return; }
    A.cd -= dt;
    if (A.phase === 'aim') {
      // red targeting-line telegraph, 0.8s, from halo to the locked strike point
      hold(e);
      faceTo(e, A.aim.x, A.aim.z, dt, 2.5);
      if (A.line) updateLine(A.line, e.pos, A.aim);
      A.t -= dt;
      if (A.t <= 0) {
        clearLine(e);
        if (!A.diveDir) A.diveDir = new THREE.Vector3();
        A.diveDir.copy(A.aim).sub(e.pos).normalize();
        A.hit = false;
        A.divedOnce = true;
        A.cd = cfg.attack?.cooldown ?? 6;
        A.freeY = true;
        setState(e, 'DIVE');
        bus.emit('sfx', { name: 'dive' });
      }
      return;
    }
    // climb: get to hoverH+15 above, orbit the target until it's this wing member's turn
    A.phase = 'climb';
    A.freeY = false;
    A.hover = cfg.hoverH + 15;
    A.orb += dt * 0.55;
    moveTo(e, tp.x + Math.cos(A.orb) * 26, tp.z + Math.sin(A.orb) * 26, cfg.speed, dt);
    const gy = ground(e.pos.x, e.pos.z);
    const atAlt = Math.abs(e.pos.y - (gy + cfg.hoverH + 15)) < 5;
    const staggerOK = e.faction !== 'hostile' || !wingmateDiving(e);
    if (A.cd <= 0 && atAlt && staggerOK) {
      A.phase = 'aim';
      A.t = 0.8;
      if (!A.aim) A.aim = new THREE.Vector3();
      const tv = e.target === 'player' ? playerVel : (e.target && e.target.vel) || _zero;
      const eta = clamp(e.pos.distanceTo(tp) / 28, 0, 1.4);
      A.aim.copy(tp).addScaledVector(tv, eta);
      A.aim.y = ground(A.aim.x, A.aim.z) + 1.4;
      A.line = acquireLine();
      updateLine(A.line, e.pos, A.aim);
    }
  }

  function haloDiveTick(e, dt) {
    const A = ai(e);
    if (!A.diveDir) { setState(e, 'PULL_UP'); A.t = 2.2; return; }
    A.freeY = true;
    e.vel.copy(A.diveDir).multiplyScalar(28);
    e.pos.addScaledVector(e.vel, dt);
    e.yaw = Math.atan2(-A.diveDir.x, -A.diveDir.z);
    const tp = targetPos(e);
    if (tp && !A.hit) {
      _b.copy(tp);
      _b.y += 1.0;
      if (e.pos.distanceTo(_b) < 2.5) {
        A.hit = true;
        hurtTarget(e, e.cfg.attack?.dmg ?? 16);
        bus.emit('sfx', { name: 'hit' });
        if (e.target === 'player') bus.emit('shake', { i: 0.25 });
      }
    }
    _b.copy(A.aim || e.pos).sub(e.pos);
    const passed = A.aim ? _b.dot(A.diveDir) < 0 : true;
    if (passed || e.pos.y < ground(e.pos.x, e.pos.z) + 1.6) {
      setState(e, 'PULL_UP');       // combat reads this: 2× arc stab window
      A.t = 2.2;
    }
  }

  function haloPullUp(e, dt) {
    const A = ai(e);
    A.freeY = true;
    e.vel.set(-Math.sin(e.yaw) * 8, 5, -Math.cos(e.yaw) * 8);
    e.pos.addScaledVector(e.vel, dt);
    A.t -= dt;
    if (A.t <= 0) {
      A.freeY = false;
      if (e.captured) {
        setState(e, 'IDLE');
        if (e.order?.mode === 'attackTarget' && A.divedOnce) e.order.mode = 'follow';
      } else if (targetPos(e)) {
        A.phase = 'climb';
        setState(e, 'ATTACK');
      } else {
        setState(e, 'PATROL');
      }
    }
  }

  function tickHalo(e, dt) {
    const A = ai(e), cfg = e.cfg;
    // sentient common: CALL_HELP at 40%, FLEE at 20%
    if (cfg.callsHelp && !A.called && e.hull < e.hullMax * 0.4) {
      A.called = true;
      raiseAlarm(e.pos);
    }
    if (e.hull < e.hullMax * (cfg.fleeAt ?? 0.2) && e.state !== 'FLEE') {
      clearLine(e);
      A.freeY = false;
      setState(e, 'FLEE');
    }
    switch (e.state) {
      case 'PATROL': {
        A.hover = cfg.hoverH;
        A.freeY = false;
        const anchor = wingAnchor(e);
        A.orb += dt * (cfg.speed / 28);          // wing orbit circuit, cohesion via shared anchor
        moveTo(e, anchor.x + Math.cos(A.orb) * 28, anchor.z + Math.sin(A.orb) * 28, cfg.speed * 0.8, dt);
        const t = senseWild(e);
        if (t) {
          e.target = t;
          A.phase = 'climb';
          A.cd = Math.random() * 2;              // stagger the wing's first dives
          setState(e, 'ATTACK');
        }
        break;
      }
      case 'INVESTIGATE': {
        A.hover = cfg.hoverH;
        A.freeY = false;
        tickInvestigate(e, dt, cfg.speed * 0.9);
        const t = senseWild(e);
        if (t) { e.target = t; A.phase = 'climb'; setState(e, 'ATTACK'); }
        break;
      }
      case 'ATTACK': haloAttack(e, dt); break;
      case 'DIVE': haloDiveTick(e, dt); break;
      case 'PULL_UP': haloPullUp(e, dt); break;
      case 'FLEE': {
        const pp = G.player?.pos;
        A.hover = cfg.hoverH + 14;
        A.freeY = false;
        if (pp) moveAwayFrom(e, pp.x, pp.z, cfg.fleeSpeed ?? 17, dt);
        if (e.stateT > 18 || (pp && e.pos.distanceTo(pp) > 120)) setState(e, 'PATROL');
        break;
      }
      default: setState(e, 'PATROL');
    }
  }

  /* ================= CAPTURED units (ai executes, capture.js owns order changes) ================= */

  const THREAT_STATES = new Set(['ATTACK', 'DIVE', 'PULL_UP', 'FLANK', 'CALL_HELP', 'CONVERGE', 'ALARM']);

  function acquireCapturedTarget(e) {
    const o = e.order || {};
    if (o.mode === 'attackTarget') {
      const t = o.target;
      if (t && !t.dying && !t._removed && t.faction === 'hostile' && t.state !== 'DISABLED' && t.type !== 'colossus') return t;
      o.mode = 'follow';        // ordered target dead/disabled → resume follow
      return null;
    }
    let cx, cz, r;
    if (o.mode === 'guard') {
      const anchor = o.anchor || e.ai.stayPos || e.pos;
      cx = anchor.x; cz = anchor.z; r = 20;
    } else if (o.mode === 'stay') {
      cx = e.pos.x; cz = e.pos.z; r = 14;
    } else {
      const pp = G.player?.pos;
      if (!pp) return null;
      cx = pp.x; cz = pp.z; r = 30;
    }
    let best = null, bestD = r;
    for (const m of S.machines) {
      if (!m || m.dying || m._removed || m.faction !== 'hostile') continue;
      if (m.state === 'DISABLED' || m.type === 'colossus') continue;
      // neutral stance: engage only real threats — an ARMED machine that has aggroed or is
      // mid-attack, or a drifter winding up its alarm (silencing it is the point). Never
      // chase passive wildlife or fleeing scouts across the map.
      const armed = !!(m.cfg && m.cfg.attack);
      if (!(armed && (m.target || THREAT_STATES.has(m.state))) && m.state !== 'ALARM') continue;
      const d = dist2d(m.pos.x, m.pos.z, cx, cz);
      if (d < bestD) { bestD = d; best = m; }
    }
    return best;
  }

  function capturedEscort(e, dt) {
    const A = ai(e), o = e.order || {};
    const pp = G.player?.pos;
    setState(e, 'IDLE');
    if (o.mode === 'stay') {
      if (!A.stayPos) A.stayPos = e.pos.clone();
      if (dist2d(e.pos.x, e.pos.z, A.stayPos.x, A.stayPos.z) > 2) {
        moveTo(e, A.stayPos.x, A.stayPos.z, e.cfg.speed * 0.7, dt);
      } else hold(e);
      return;
    }
    if (o.mode === 'guard') {
      const anchor = o.anchor || A.stayPos || (A.stayPos = e.pos.clone());
      if (dist2d(e.pos.x, e.pos.z, anchor.x, anchor.z) > 3) {
        moveTo(e, anchor.x, anchor.z, e.cfg.speed, dt);
      } else hold(e);
      return;
    }
    // follow (default): spring to 4m behind the player, teleport if left far behind
    if (!pp) { hold(e); return; }
    const pyaw = G.player?.yaw ?? 0;
    const bx = pp.x + Math.sin(pyaw) * 4;
    const bz = pp.z + Math.cos(pyaw) * 4;
    if (e.pos.distanceTo(pp) > 60) {
      e.pos.set(bx, ground(bx, bz) + (e.flying ? e.hoverH * 0.5 : 0), bz);
      hold(e);
      return;
    }
    const d = dist2d(e.pos.x, e.pos.z, bx, bz);
    if (d > 1.6) {
      const A2 = ai(e);
      // wall-stuck self-heal: measure ACTUAL displacement across ticks (vel is the
      // commanded speed, collisions cancel it) — no progress while far → warp to player
      const actualMoved = dist2d(e.pos.x, e.pos.z, A2.fpx ?? e.pos.x, A2.fpz ?? e.pos.z);
      moveTo(e, bx, bz, e.cfg.speed * (d > 12 ? 1.35 : 1), dt);
      A2.fpx = e.pos.x; A2.fpz = e.pos.z;
      A2.followStuckT = (d > 15 && actualMoved < e.cfg.speed * dt * 0.2)
        ? (A2.followStuckT || 0) + dt : 0;
      if (A2.followStuckT > 3) {
        A2.followStuckT = 0;
        e.pos.set(bx, ground(bx, bz) + (e.flying ? e.hoverH * 0.5 : 0), bz);
        hold(e);
      }
    } else hold(e);
  }

  function tickCaptured(e, dt) {
    const A = ai(e);
    const o = e.order || (e.order = { mode: 'follow' });
    if (A.lastMode !== o.mode) {          // order changed (capture.js) → reset execution scratch
      A.lastMode = o.mode;
      A.stayPos = null;
      A.divedOnce = false;
      A.phase = 'circle';
      if (e.state !== 'DIVE' && e.state !== 'PULL_UP') { e.target = null; setState(e, 'IDLE'); }
      clearLine(e);
    }

    if (e.type === 'colossus') { hold(e); setState(e, 'IDLE'); return; }

    if (e.type === 'skitter') {
      // harvesting handled by capture.js — ai walks the (assigned-node) circuit
      if (o.mode === 'stay') { capturedEscort(e, dt); return; }
      if (o.mode === 'follow' && !(G.world?.nodes?.length)) { capturedEscort(e, dt); return; }
      skitterCircuit(e, dt);
      return;
    }

    if (e.type === 'drifter') {
      // recon pet: hover orbit near the player, never fights
      A.hover = (e.hoverH || 3.2) + 1;
      A.freeY = false;
      const pp = G.player?.pos;
      setState(e, 'IDLE');
      if (!pp) { hold(e); return; }
      if (e.pos.distanceTo(pp) > 60) {
        e.pos.set(pp.x + 3, pp.y + A.hover, pp.z + 3);
        hold(e);
        return;
      }
      A.orb += dt * 0.6;
      moveTo(e, pp.x + Math.cos(A.orb) * 5, pp.z + Math.sin(A.orb) * 5, e.cfg.speed, dt);
      return;
    }

    // combat-capable: strider / warden / halo
    if (e.type === 'halo') {
      if (e.state === 'DIVE') { haloDiveTick(e, dt); return; }
      if (e.state === 'PULL_UP') { haloPullUp(e, dt); return; }
      // hover low when idle so the player can actually reach the saddle; climb in combat
      A.hover = e.target ? e.cfg.hoverH * 0.55 : 2.4;
    }
    A.scanT -= dt;
    if (A.scanT <= 0) {
      A.scanT = 0.5;
      const t = acquireCapturedTarget(e);
      if (t) e.target = t;
      else if (e.target !== null && !targetPos(e)) e.target = null;
      // guard leash: drop targets that leave the guard bubble
      if (e.target && e.target !== 'player' && o.mode === 'guard') {
        const anchor = o.anchor || A.stayPos || e.pos;
        if (dist2d(e.target.pos.x, e.target.pos.z, anchor.x, anchor.z) > 28) e.target = null;
      }
      // follow/stay leash: never pursue beyond the player's fight bubble
      if (e.target && e.target !== 'player' && o.mode !== 'guard' && o.mode !== 'attackTarget') {
        const pp = G.player?.pos;
        if (pp && dist2d(e.target.pos.x, e.target.pos.z, pp.x, pp.z) > 42) e.target = null;
      }
    }
    if (e.target && targetPos(e)) {
      if (e.type === 'strider') { setState(e, 'ATTACK'); striderAttack(e, dt); }
      else if (e.type === 'warden') { setState(e, 'ATTACK'); wardenAttack(e, dt); }
      else {
        if (e.state !== 'ATTACK') { setState(e, 'ATTACK'); A.phase = 'climb'; A.cd = 0; }
        haloAttack(e, dt);
      }
      return;
    }
    capturedEscort(e, dt);
  }

  /* ================= COLOSSUS phase controller ================= */

  let colE = null;
  function findColossus() {
    if (colE && !colE._removed) return colE;
    colE = null;
    for (const e of S.machines) {
      if (e && e.type === 'colossus' && !e._removed) { colE = e; break; }
    }
    return colE;
  }

  function wakeColossus(e) {
    const A = ai(e);
    if (A.awake || e.captured) return;
    A.awake = true;
    A.atkCd = 3;
    S.flags.bossActive = true;
    bus.emit('sfx', { name: 'slam' });
    bus.emit('shake', { i: 0.8 });
  }

  function colossusTargetPos(e) {
    // draw fire: prefer captured units within 25m
    let best = null, bestD = 25;
    for (const m of S.captured) {
      if (!m || m.dying || m._removed || m === S.mounted || m === S.piloting) continue;
      const d = e.pos.distanceTo(m.pos);
      if (d < bestD) { bestD = d; best = m; }
    }
    if (best) { e.target = best; return best.pos; }
    e.target = 'player';
    return G.player?.pos || null;
  }

  function colossusExecute(e, kind, tp) {
    const atk = e.cfg.attack || {};
    if (kind === 'slam') {
      bus.emit('sfx', { name: 'slam' });
      bus.emit('shake', { i: 0.7 });
      // 3 expanding shockwave rings — jump to dodge at ground level
      for (let k = 0; k < 3; k++) {
        ringQueue.push({
          t: k * 0.35, x: e.pos.x, z: e.pos.z,
          maxR: 24, dmg: atk.slam?.dmg ?? 35, speed: 15, band: 1.4,
          hostile: true, color: COL_RING_HOSTILE,
        });
      }
      slamHitMachines(e, 10, atk.slam?.dmg ?? 35);
    } else if (kind === 'stomp') {
      bus.emit('sfx', { name: 'stomp' });
      bus.emit('shake', { i: 0.5 });
      const r = (atk.stomp?.r ?? 5) + 1.5;
      const pp = G.player?.pos;
      if (pp && dist2d(pp.x, pp.z, e.pos.x, e.pos.z) < r + 2.5) G.player?.damage?.(atk.stomp?.dmg ?? 25, e.pos);
      slamHitMachines(e, r + 2.5, atk.stomp?.dmg ?? 25);
    } else { // sweep: frontal arc
      bus.emit('sfx', { name: 'slam' });
      bus.emit('shake', { i: 0.5 });
      const dmg = atk.sweep?.dmg ?? 30;
      const pp = G.player?.pos;
      if (pp) {
        const d = dist2d(pp.x, pp.z, e.pos.x, e.pos.z);
        const ang = Math.atan2(-(pp.x - e.pos.x), -(pp.z - e.pos.z));
        if (d < 14 && Math.abs(angDiff(ang, e.yaw)) < Math.PI / 3) G.player?.damage?.(dmg, e.pos);
      }
      for (const m of S.machines) {
        if (!m || m === e || m.dying || m._removed || m.faction !== 'captured') continue;
        const d = dist2d(m.pos.x, m.pos.z, e.pos.x, e.pos.z);
        const ang = Math.atan2(-(m.pos.x - e.pos.x), -(m.pos.z - e.pos.z));
        if (d < 14 && Math.abs(angDiff(ang, e.yaw)) < Math.PI / 3) G.combat?.damageMachine?.(m, { hull: dmg }, e);
      }
    }
  }

  function tickColossus(e, dt) {
    const A = ai(e);
    const pp = G.player?.pos;
    if (e.captured) {
      hold(e);
      setState(e, 'IDLE');
      if (S.flags.bossActive) S.flags.bossActive = false;
      return;
    }
    if (!A.awake) {
      hold(e);
      setState(e, 'IDLE');
      if (pp && e.pos.distanceTo(pp) < 60) wakeColossus(e);
      else return;
    }
    // hack window countdown (frozen mid-hack); expiry re-arms the exposed core
    if (e.hackWindow > 0 && !e.hackLock) {
      e.hackWindow -= dt;
      if (e.hackWindow <= 0) {
        e.hackWindow = 0;
        e.coreStab = 100;
      }
    }
    if (A.staggerT > 0) {      // post-core-zero pseudo-vulnerable stagger
      A.staggerT -= dt;
      hold(e);
      return;
    }
    setState(e, 'ATTACK');
    const tp = colossusTargetPos(e);
    if (!tp) { hold(e); return; }
    const d = dist2d(e.pos.x, e.pos.z, tp.x, tp.z);
    A.atkCd -= dt;
    if (A.tele > 0) {
      hold(e);
      faceTo(e, tp.x, tp.z, dt, 1.2);
      A.tele -= dt;
      if (A.tele <= 0) colossusExecute(e, A.pending, tp);
    } else if (A.atkCd <= 0 && d < 30) {
      const ang = Math.atan2(-(tp.x - e.pos.x), -(tp.z - e.pos.z));
      const frontal = Math.abs(angDiff(ang, e.yaw)) < Math.PI / 3;
      A.pending = d < 8 ? 'stomp' : (frontal && d < 13 ? 'sweep' : 'slam');
      A.tele = A.pending === 'stomp' ? 0.55 : 0.85;
      A.atkCd = 4.2 + Math.random() * 2.2;
      bus.emit('sfx', { name: 'stomp' });   // windup cue
    } else if (d > 10) {
      moveTo(e, tp.x, tp.z, e.cfg.speed, dt, 1);   // slow-turn ponderous pursuit
    } else {
      hold(e);
      faceTo(e, tp.x, tp.z, dt, 1);
    }
  }

  function spawnWave(n) {
    const e = findColossus();
    const c = G.world?.positions?.arenaCenter || (e ? e.pos : null);
    if (!c || !G.machines?.spawn) return;
    const edge = () => {
      const a = Math.random() * TWO_PI;
      return { x: clamp(c.x + Math.cos(a) * 32, -280, 280), z: clamp(c.z + Math.sin(a) * 32, -280, 280) };
    };
    const enrage = (m, wing) => {
      if (!m) return;
      if (wing != null) m.wing = wing;
      m.target = 'player';
      const A = ai(m);
      if (m.type === 'halo') { A.phase = 'climb'; A.cd = Math.random() * 2; }
      setState(m, 'ATTACK');
    };
    const striders = 2;
    for (let i = 0; i < striders; i++) enrage(G.machines.spawn('strider', edge()));
    if (n === 2) {
      const wid = 810;
      for (let i = 0; i < 3; i++) enrage(G.machines.spawn('halo', edge()), wid);
    } else if (n >= 3) {
      const wid = 820;
      for (let i = 0; i < 2; i++) enrage(G.machines.spawn('halo', edge()), wid);
      enrage(G.machines.spawn('warden', edge()));
    }
  }

  function colossusHackSucceeded(e) {
    e.hacksDone = (e.hacksDone || 0) + 1;
    e.hackWindow = 0;
    e.hackLock = false;
    e.coreStab = 100;
    const A = ai(e);
    bus.emit('colossus:hacked', { count: e.hacksDone });
    spawnWave(e.hacksDone);      // escalation wave per BRIEF §4.6, even on the final hack
    if (e.hacksDone >= 3) {
      S.flags.bossActive = false;
      A.awake = false;
      hold(e);
      setState(e, 'IDLE');
      G.capture?.capture?.(e);
      bus.emit('colossus:captured', {});
      bus.emit('end:win', {});
    } else {
      e.coreIdx = null;          // next plate must be broken to expose the next core
      A.staggerT = 3;
    }
  }

  // handle object per CONTRACT §4-ai (combat/hacking normally use the bus instead)
  const colossusHandle = {
    plateBroken(i) { bus.emit('colossus:plate', { i }); },
    coreZeroed() { bus.emit('colossus:core', { i: findColossus()?.coreIdx ?? 0 }); },
    hackSucceeded() { const e = findColossus(); if (e) bus.emit('hack:success', { e }); },
  };

  /* ================= bus wiring (defensive: handlers never throw) ================= */

  bus.on('alarm', (p) => { try { applyAlarm(p?.pos); } catch (_) {} });

  // hearing: gunshots pull nearby calm hostiles toward the player's position
  let lastShotHeard = -9;
  bus.on('sfx', (p) => {
    try {
      if (!p || p.name !== 'shot') return;
      if (S.time - lastShotHeard < 0.6) return;
      lastShotHeard = S.time;
      const pp = G.player?.pos;
      if (!pp) return;
      for (const e of S.machines) {
        if (!e || e.dying || e.faction !== 'hostile') continue;
        if (e.type === 'skitter' || e.type === 'colossus') continue;
        if (e === S.mounted || e === S.piloting) continue;
        const st = e.state;
        if (st !== 'PATROL' && st !== 'IDLE' && st !== 'INVESTIGATE' && st !== 'CHEW') continue;
        if (e.pos.distanceTo(pp) <= HEAR_RADIUS) setInvestigate(e, pp);
      }
    } catch (_) {}
  });

  // damage aggro
  bus.on('machine:damaged', (p) => {
    try {
      const e = p?.e;
      if (!e || e.dying || e._removed) return;
      if (e.type === 'colossus') { if (!e.captured) wakeColossus(e); return; }
      if (e.captured || e.faction !== 'hostile') return;
      if (e.state === 'DISABLED' || e === S.mounted || e === S.piloting) return;
      const A = ai(e);
      if (e.type === 'skitter') {
        if (e.state !== 'FLEE') setState(e, 'FLEE');        // scuttle-flee briefly, then resume
        return;
      }
      if (e.type === 'drifter') {
        if (e.state !== 'ALARM' && e.state !== 'FLEE') {
          setState(e, 'ALARM');
          A.windup = e.cfg.alarmWindup ?? 2;
        }
        return;
      }
      // sentient: aggro the source ('player' unless a captured machine did it)
      const src = p.source;
      if (src && src.pos && src.faction === 'captured' && !src.dying) e.target = src;
      else if (!e.target) e.target = 'player';
      else if (e.target !== 'player' && (!e.target.pos || e.target.dying)) e.target = 'player';
      if (e.state !== 'ATTACK' && e.state !== 'DIVE' && e.state !== 'PULL_UP' && e.state !== 'FLEE') {
        A.phase = e.type === 'halo' ? 'climb' : 'circle';
        setState(e, 'ATTACK');
      }
    } catch (_) {}
  });

  bus.on('machine:disabled', (p) => {
    try {
      const e = p?.e;
      if (!e || e.dying || e.type === 'colossus') return;
      clearLine(e);
      const A = ai(e);
      A.fell = false;
      A.freeY = false;
      A.tele = 0;
      A.phase = 'circle';
      e.target = null;
      e.disabledT = diff().reboot;
      hold(e);
      setState(e, 'DISABLED');
    } catch (_) {}
  });

  bus.on('hack:fail', (p) => {
    try {
      const e = p?.e;
      if (!e || e.dying || e._removed) return;
      if (e.type === 'colossus') {
        e.hackWindow = 0;
        e.hackLock = false;
        e.coreStab = 100;
        ai(e).staggerT = 0;
        return;
      }
      if (e.state !== 'DISABLED') return;
      reboot(e, true);           // instant angry reboot: stability 50%, straight to ATTACK
    } catch (_) {}
  });

  bus.on('hack:success', (p) => {
    try {
      const e = p?.e;
      if (e && e.type === 'colossus') colossusHackSucceeded(e);
    } catch (_) {}
  });

  bus.on('colossus:plate', (p) => {
    try {
      const e = findColossus();
      if (!e || e.captured) return;
      if (p && p.i != null) e.coreIdx = p.i;
      wakeColossus(e);
      ai(e).staggerT = Math.max(ai(e).staggerT, 1.2);
    } catch (_) {}
  });

  bus.on('colossus:core', () => {
    try {
      const e = findColossus();
      if (!e || e.captured) return;
      e.hackWindow = 15 * (diff().reboot / 25);    // difficulty-scaled hack window
      ai(e).staggerT = 4;                          // stop attacking: stagger
      bus.emit('sfx', { name: 'emp' });
    } catch (_) {}
  });

  bus.on('machine:destroyed', (p) => {
    try {
      const dead = p?.e;
      if (!dead) return;
      clearLine(dead);
      for (const m of S.machines) {
        if (!m || m === dead) continue;
        if (m.target === dead) m.target = null;
        if (m.order && m.order.target === dead && m.order.mode === 'attackTarget') m.order.mode = 'follow';
      }
    } catch (_) {}
  });

  /* ================= per-type dispatch ================= */

  const TICKS = {
    drifter: tickDrifter,
    skitter: tickSkitter,
    strider: tickStrider,
    warden: tickWarden,
    halo: tickHalo,
  };

  /* ================= main update ================= */

  function update(dt) {
    const pp = G.player?.pos;
    if (pp) {
      if (!ppInit) { prevPP.copy(pp); ppInit = true; }
      if (dt > 0) {
        playerVel.set((pp.x - prevPP.x) / dt, (pp.y - prevPP.y) / dt, (pp.z - prevPP.z) / dt);
        if (playerVel.lengthSq() > 900) playerVel.set(0, 0, 0);   // respawn/teleport spike guard
      }
      prevPP.copy(pp);
    }

    let danger = false;

    for (let i = S.machines.length - 1; i >= 0; i--) {
      const e = S.machines[i];
      if (!e || e.dying || e._removed) continue;
      if (e === S.mounted || e === S.piloting) continue;
      if (e.state === 'MOUNTED') { setState(e, 'IDLE'); continue; }   // stale mount state recovery
      const A = ai(e);

      let step = dt;
      if (pp) {
        const d = e.pos.distanceTo(pp);
        if (d > CULL_DIST) {          // coarse 4Hz tick with accumulated dt
          A.cullAcc += dt;
          if (A.cullAcc < 0.25) continue;
          step = Math.min(A.cullAcc, 0.34);
          A.cullAcc = 0;
        } else A.cullAcc = 0;
        if (e.faction === 'hostile' && d < 60) {
          const st = e.state;
          if (st === 'CONVERGE'
            || ((st === 'ATTACK' || st === 'DIVE' || st === 'FLANK' || st === 'STALK') && e.target === 'player')) {
            danger = true;
          }
        }
      }

      e.stateT += step;

      if (e.type === 'colossus') {
        tickColossus(e, step);
        settle(e, step);
        if (!e.captured && A.awake && pp && e.pos.distanceTo(pp) < 60) danger = true;
        continue;
      }
      if (e.state === 'DISABLED') { tickDisabled(e, step); continue; }
      if (e.captured || e.faction === 'captured') {
        tickCaptured(e, step);
        settle(e, step);
        continue;
      }
      TICKS[e.type]?.(e, step);
      settle(e, step);
    }

    S.danger = danger ? 1 : Math.max(0, S.danger - dt * 0.4);

    updateRings(dt);
  }

  return {
    update,
    raiseAlarm,
    get colossus() { return findColossus() ? colossusHandle : null; },
  };
}
