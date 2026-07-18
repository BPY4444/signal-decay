// SIGNAL DECAY — capture: captured-unit orders, Q command menu, skitter harvesting,
// drifter drone cam + wall-tagging. CONTRACT §4-capture.
import * as THREE from 'three';
import { bus, S, input, clamp, damp } from './core.js';

const NODE_CYCLE = [null, 'alloy', 'circuits', 'cells'];

export function initCapture(G) {
  const qmenu = document.getElementById('qmenu');
  const qlist = document.getElementById('qmenu-list');
  let menuOpen = false;
  let selIdx = 0;

  /* ---------------- capture / release ---------------- */
  function capture(e) {
    if (!e || e.captured) return;
    e.faction = 'captured';
    e.captured = true;
    e.state = 'IDLE';
    e.target = null;
    e.order = { mode: 'follow' };
    e.hull = Math.min(e.hullMax, e.hull + e.hullMax * 0.3);
    e.stability = e.stabilityMax;
    G.machines.applyFaction(e);
    if (!S.captured.includes(e)) S.captured.push(e);
    S.stats.captured++;
    bus.emit('machine:captured', { e });
    bus.emit('sfx', { name: 'capture' });
  }

  function release(e) {
    const i = S.captured.indexOf(e);
    if (i >= 0) S.captured.splice(i, 1);
    if (e === S.piloting) unpilot();
    if (selIdx >= S.captured.length) selIdx = Math.max(0, S.captured.length - 1);
  }

  bus.on('hack:success', (p) => {
    if (p?.e && p.e.type !== 'colossus') capture(p.e);
  });
  bus.on('machine:destroyed', (p) => { if (p?.e?.captured) release(p.e); });

  /* ---------------- orders ---------------- */
  function setOrder(e, order) {
    if (!e || !e.captured) return;
    e.order = order;
    if (order.mode === 'guard' && !order.anchor) order.anchor = G.player.pos.clone();
    e.patrolDirty = true;
    bus.emit('sfx', { name: 'ui' });
  }

  function assignNode(e, nodeType) {
    if (!e || e.type !== 'skitter') return;
    e.assignedNode = nodeType;
    e.patrolDirty = true;
    bus.emit('sfx', { name: 'ui' });
  }

  /* ---------------- Q menu ---------------- */
  function orderLabel(e) {
    const o = e.order || {};
    if (e === S.piloting) return 'PILOTED';
    if (e === S.mounted) return 'MOUNTED';
    let s = (o.mode || 'follow').toUpperCase();
    if (o.mode === 'attackTarget' && o.target) s += ' → ' + (o.target.cfg?.name || '?').toUpperCase();
    if (e.type === 'skitter') s += ' · DIET: ' + (e.assignedNode || 'ANY').toUpperCase();
    return s;
  }

  function renderMenu() {
    if (!qlist) return;
    const cap = G.progression.capacity();
    let html = `<div class="qorder">UNITS ${S.captured.length}/${cap} — [1-4] SELECT · <span class="qkey">F</span> FOLLOW · <span class="qkey">T</span> STAY · <span class="qkey">G</span> GUARD HERE · <span class="qkey">R</span> ATTACK MY TARGET · <span class="qkey">N</span> DIET (SKITTER) · <span class="qkey">P</span> PILOT (DRIFTER) · Q CLOSE</div>`;
    if (!S.captured.length) {
      html += `<div class="qunit"><span class="qname">NO CAPTURED UNITS</span><div class="qorder">Disable a machine with the Arc Caster, then hack it (E).</div></div>`;
    }
    S.captured.forEach((e, i) => {
      const selMark = i === selIdx ? '▶ ' : '&nbsp;&nbsp;';
      html += `<div class="qunit">${selMark}<span class="qkey">[${i + 1}]</span> <span class="qname">${e.cfg.name.toUpperCase()}</span>` +
        ` <span class="qorder">T${e.cfg.tier} · HULL ${Math.round(e.hull)}/${e.hullMax} · ${orderLabel(e)}</span></div>`;
    });
    qlist.innerHTML = html;
  }

  function openMenu() {
    if (S.mode !== 'play' || S.piloting) return;
    menuOpen = true;
    S.mode = 'menu';
    selIdx = clamp(selIdx, 0, Math.max(0, S.captured.length - 1));
    renderMenu();
    qmenu?.classList.remove('hidden');
    bus.emit('sfx', { name: 'ui' });
  }
  function closeMenu() {
    menuOpen = false;
    qmenu?.classList.add('hidden');
    if (S.mode === 'menu') S.mode = 'play';
  }

  function menuInput() {
    if (input.pressed('KeyQ') || input.pressed('Escape')) { input.consume('KeyQ'); closeMenu(); return; }
    for (let i = 0; i < 4; i++) {
      if (input.pressed('Digit' + (i + 1)) && i < S.captured.length) { selIdx = i; renderMenu(); }
    }
    const e = S.captured[selIdx];
    if (!e) return;
    if (input.pressed('KeyF')) { setOrder(e, { mode: 'follow' }); renderMenu(); }
    if (input.pressed('KeyT')) { setOrder(e, { mode: 'stay' }); renderMenu(); }
    if (input.pressed('KeyG')) { setOrder(e, { mode: 'guard', anchor: G.player.pos.clone() }); renderMenu(); }
    if (input.pressed('KeyR')) {
      const t = S.crosshairTarget;
      if (t && t.faction === 'hostile' && !t.dying) { setOrder(e, { mode: 'attackTarget', target: t }); renderMenu(); }
    }
    if (input.pressed('KeyN') && e.type === 'skitter') {
      const next = NODE_CYCLE[(NODE_CYCLE.indexOf(e.assignedNode ?? null) + 1) % NODE_CYCLE.length];
      assignNode(e, next); renderMenu();
    }
    if (input.pressed('KeyP') && e.type === 'drifter' && e !== S.mounted) {
      closeMenu();
      pilot(e);
    }
  }

  /* ---------------- drone cam ---------------- */
  let droneYaw = 0, dronePitch = 0;
  const dvel = new THREE.Vector3();
  const dfwd = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const lookPt = new THREE.Vector3();
  const tether = new THREE.Vector3();
  let tagScanT = 0;

  function pilot(e) {
    if (!e || e.type !== 'drifter' || !e.captured || S.mounted) return;
    S.piloting = e;
    S.mode = 'drone';
    droneYaw = G.player.yaw;
    dronePitch = 0;
    e.vel.set(0, 0, 0);
    dvel.set(0, 0, 0);
    bus.emit('sfx', { name: 'ui' });
  }

  function unpilot() {
    if (!S.piloting) return;
    S.piloting = null;
    if (S.mode === 'drone') S.mode = 'play';
    bus.emit('sfx', { name: 'ui' });
  }

  bus.on('machine:damaged', (p) => { if (p?.e && p.e === S.piloting) unpilot(); });
  bus.on('pointerlock:lost', () => { if (S.piloting) unpilot(); });

  function droneUpdate(dt) {
    const e = S.piloting;
    if (!e || e.dying) { unpilot(); return; }
    if (input.pressed('KeyQ') || input.pressed('KeyE') || input.pressed('Escape')) {
      input.consume('KeyQ'); input.consume('KeyE');
      unpilot(); return;
    }

    droneYaw -= input.mouseDX * 0.0022;
    dronePitch = clamp(dronePitch - input.mouseDY * 0.0022, -1.2, 1.2);

    let ix = 0, iz = 0, iy = 0;
    if (input.key('KeyW')) iz -= 1;
    if (input.key('KeyS')) iz += 1;
    if (input.key('KeyA')) ix -= 1;
    if (input.key('KeyD')) ix += 1;
    if (input.key('Space')) iy += 1;
    if (input.key('ControlLeft') || input.key('ControlRight') || input.key('KeyC')) iy -= 1;

    const sin = Math.sin(droneYaw), cos = Math.cos(droneYaw);
    const SPEED = 14;
    dvel.x = damp(dvel.x, (ix * cos - iz * sin) * SPEED, 6, dt);
    dvel.z = damp(dvel.z, (ix * sin + iz * cos) * SPEED, 6, dt);
    dvel.y = damp(dvel.y, iy * SPEED * 0.7, 6, dt);
    e.pos.addScaledVector(dvel, dt);
    e.yaw = droneYaw;

    // altitude + tether + world limits
    const g = G.world.getGroundHeight(e.pos.x, e.pos.z);
    e.pos.y = clamp(e.pos.y, g + 0.6, g + 45);
    tether.copy(e.pos).sub(G.player.pos);
    const d = tether.length();
    if (d > 120) e.pos.copy(G.player.pos).addScaledVector(tether.normalize(), 120);
    G.world.resolveCollisions(e.pos, 0.6);

    // chase camera
    const cam = G.engine.camera;
    dfwd.set(-Math.sin(droneYaw) * Math.cos(dronePitch), Math.sin(dronePitch), -Math.cos(droneYaw) * Math.cos(dronePitch));
    camPos.copy(e.pos).addScaledVector(dfwd, -2.6);
    camPos.y += 0.8;
    const cg = G.world.getGroundHeight(camPos.x, camPos.z);
    if (camPos.y < cg + 0.3) camPos.y = cg + 0.3;
    cam.position.lerp(camPos, 1 - Math.exp(-14 * dt));
    lookPt.copy(e.pos).addScaledVector(dfwd, 6);
    cam.lookAt(lookPt);

    // wall-tag scan
    tagScanT -= dt;
    if (tagScanT <= 0) {
      tagScanT = 0.25;
      for (const m of S.machines) {
        if (m.faction !== 'hostile' || m.dying || !m.tagMesh) continue;
        if (m.pos.distanceTo(e.pos) <= 40) {
          m.tagMesh.visible = true;
          m._tagUntil = S.time + 8;
        }
      }
    }
  }

  /* ---------------- skitter harvest ---------------- */
  const chew = new Map(); // entity -> timer

  function harvestUpdate(dt) {
    for (const e of S.captured) {
      if (e.type !== 'skitter' || e.dying) continue;
      let node = null, bd = 3.5;
      for (const n of G.world.nodes) {
        const d = e.pos.distanceTo(n.pos);
        if (d < bd) { bd = d; node = n; }
      }
      if (node && e.vel.lengthSq() < 4) {
        const t = (chew.get(e) || 0) + dt;
        if (t >= 5) {
          chew.set(e, 0);
          const type = e.assignedNode || node.type;
          G.progression.addSalvage({ [type]: 2 });
          bus.emit('harvest', { type, n: 2, pos: e.pos.clone() });
          bus.emit('sfx', { name: 'harvest' });
        } else chew.set(e, t);
      } else chew.set(e, 0);
    }
  }

  /* ---------------- update ---------------- */
  function update(dt) {
    // tag expiry runs globally so tags persist (then fade) after unpiloting
    for (const m of S.machines) {
      if (m._tagUntil && (S.time > m._tagUntil || m.captured)) {
        if (m.tagMesh) m.tagMesh.visible = false;
        m._tagUntil = 0;
      }
    }

    // recon flag: any live captured drifter widens compass awareness
    S.flags.droneRecon = S.captured.some(e => e.type === 'drifter' && !e.dying);

    if (S.piloting) { droneUpdate(dt); return; }

    if (menuOpen) {
      if (S.mode !== 'menu') { closeMenu(); } // something external closed us
      else menuInput();
    } else if (input.pressed('KeyQ') && S.mode === 'play' && !S.mounted) {
      input.consume('KeyQ');
      openMenu();
    }

    harvestUpdate(dt);
  }

  return { update, capture, release, setOrder, assignNode, pilot, unpilot };
}
