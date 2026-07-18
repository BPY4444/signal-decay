// SIGNAL DECAY — machines: roster data, procedural creature meshes, spawn/populate/respawn,
// per-type animation, faction FX. See CONTRACT.md §4-machines, §6, §6b, §7.
import * as THREE from 'three';
import {
  bus, S, rng, rngRange, rngInt, rngPick, clamp, lerp, damp, dist2d,
  makeCanvasTexture, makeNoiseNormalMap,
} from './core.js';

/* module-scope scratch (no per-frame allocs in hot loops) */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();

const COL_HOSTILE = 0xff2a2a;
const COL_DISABLED = 0xffb545;
const COL_CAPTURED = 0x35e0ff;
const COL_PRECURSOR = 0xb47aff;
const COL_PLATE = 0xd63cff;      // red-violet armor plates
const COL_CORE = 0xd9c8ff;       // white-violet cores

export function initMachines(G) {
  const scene = G.engine.scene;

  /* ================= shared textures & materials ================= */

  function brushedTex(base, streakRGB, tint) {
    return makeCanvasTexture(256, (ctx, s) => {
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, s, s);
      // horizontal brushed streaks
      for (let i = 0; i < 850; i++) {
        const y = rng() * s;
        ctx.strokeStyle = `rgba(${streakRGB},${(rng() * 0.09).toFixed(3)})`;
        ctx.lineWidth = 0.4 + rng() * 1.5;
        const x0 = rng() * s;
        ctx.beginPath();
        ctx.moveTo(x0 - s * 0.6, y);
        ctx.lineTo(x0 + s * 0.6, y + rngRange(-1.5, 1.5));
        ctx.stroke();
      }
      // dark scratches
      for (let i = 0; i < 90; i++) {
        ctx.strokeStyle = `rgba(8,10,14,${(rng() * 0.16).toFixed(3)})`;
        ctx.lineWidth = 0.4 + rng() * 0.8;
        const y = rng() * s, x0 = rng() * s;
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x0 + rngRange(-40, 40), y + rngRange(-3, 3));
        ctx.stroke();
      }
      // wear blotches
      for (let i = 0; i < 42; i++) {
        ctx.fillStyle = `rgba(0,0,0,${(rng() * 0.09).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(rng() * s, rng() * s, 4 + rng() * 20, 0, 7);
        ctx.fill();
      }
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = tint;
      ctx.fillRect(0, 0, s, s);
      ctx.globalAlpha = 1;
    });
  }

  const carbonTex = makeCanvasTexture(128, (ctx, s) => {
    ctx.fillStyle = '#14171c';
    ctx.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 4) {
      for (let x = 0; x < s; x += 4) {
        const odd = ((x + y) / 4) % 2;
        ctx.fillStyle = odd ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.12)';
        ctx.fillRect(x, y, 4, 4);
      }
    }
  });

  const nmapFine = makeNoiseNormalMap(128, 10, 0.5);

  const MAT = {
    body: [
      new THREE.MeshStandardMaterial({ map: brushedTex('#8b95a3', '228,236,246', '#9bb7c9'), metalness: 0.88, roughness: 0.38, normalMap: nmapFine, normalScale: new THREE.Vector2(0.3, 0.3) }),
      new THREE.MeshStandardMaterial({ map: brushedTex('#5a616c', '188,198,214', '#6a7fa0'), metalness: 0.85, roughness: 0.44, normalMap: nmapFine, normalScale: new THREE.Vector2(0.3, 0.3) }),
      new THREE.MeshStandardMaterial({ map: brushedTex('#7d7890', '214,204,236', '#a78ec9'), metalness: 0.82, roughness: 0.42, normalMap: nmapFine, normalScale: new THREE.Vector2(0.3, 0.3) }),
    ],
    carbon: new THREE.MeshStandardMaterial({ map: carbonTex, color: 0xffffff, metalness: 0.15, roughness: 0.9 }),
    inset: new THREE.MeshStandardMaterial({ color: 0x222a33, metalness: 0.6, roughness: 0.58 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x171b21, metalness: 0.4, roughness: 0.7 }),
    violet: new THREE.MeshStandardMaterial({ color: 0x2a2140, emissive: COL_PRECURSOR, emissiveIntensity: 1.5, metalness: 0.3, roughness: 0.4 }),
    fragment: new THREE.MeshStandardMaterial({ color: 0x3a2435, emissive: COL_PLATE, emissiveIntensity: 1.4, metalness: 0.4, roughness: 0.6 }),
    tag: new THREE.MeshBasicMaterial({ color: COL_CAPTURED, transparent: true, opacity: 0.35, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending }),
    collider: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }),
  };
  const EM_BASE = new THREE.MeshStandardMaterial({ color: 0x0a0d12, emissive: COL_HOSTILE, emissiveIntensity: 2.2, metalness: 0.2, roughness: 0.35 });
  const PLATE_BASE = new THREE.MeshStandardMaterial({ color: 0x241826, emissive: COL_PLATE, emissiveIntensity: 1.9, metalness: 0.55, roughness: 0.4 });
  const CORE_BASE = new THREE.MeshStandardMaterial({ color: 0x101018, emissive: COL_CORE, emissiveIntensity: 3.0, metalness: 0.1, roughness: 0.25 });

  /* ================= TYPES (data-defined roster, CONTRACT §7) ================= */

  const TYPES = {
    drifter: {
      name: 'Drifter', tier: 1, cls: 'robotic', flying: true, hoverH: 3.2, scale: 1,
      hull: 35, stability: 30, speed: 7, fleeSpeed: 13, turnRate: 2.5,
      detect: { range: 25, fov: 120 },
      attack: null, alarm: true, alarmWindup: 2, fleeAt: 1, flanks: false, callsHelp: false,
      hackArcs: 2, xp: 15,
      salvage: { alloy: [1, 2], circuits: [1, 3], cells: [0, 1] }, coreChance: 0.02,
    },
    skitter: {
      name: 'Skitter', tier: 1, cls: 'robotic', flying: false, hoverH: 0, scale: 1,
      hull: 50, stability: 35, speed: 3.5, fleeSpeed: 6, turnRate: 2.0,
      detect: { range: 8, fov: 90 },
      attack: null, alarm: false, fleeAt: 1, flanks: false, callsHelp: false,
      hackArcs: 2, xp: 12,
      salvage: { alloy: [2, 4], circuits: [1, 2], cells: [0, 1] }, coreChance: 0.02,
    },
    strider: {
      name: 'Strider', tier: 2, cls: 'sentient', flying: false, hoverH: 0, scale: 1,
      hull: 140, stability: 70, speed: 10, fleeSpeed: 12.5, turnRate: 3.0,
      detect: { range: 45, fov: 140 },
      attack: { dmg: 12, range: 2.8, cooldown: 1.6, telegraph: 0.35 },
      alarm: false, fleeAt: 0.25, flanks: true, callsHelp: false,
      hackArcs: 3, xp: 40,
      salvage: { alloy: [3, 5], circuits: [2, 4], cells: [1, 2] }, coreChance: 0.15,
    },
    warden: {
      name: 'Warden', tier: 3, cls: 'sentient', flying: false, hoverH: 0, scale: 1,
      hull: 320, stability: 110, speed: 4.2, fleeSpeed: 4.2, turnRate: 1.6,
      detect: { range: 35, fov: 120 },
      attack: { dmg: 26, range: 3.5, cooldown: 2.8, telegraph: 0.8, aoe: 6 },
      alarm: false, fleeAt: 0, flanks: false, callsHelp: true, converges: true,
      hackArcs: 3, xp: 80,
      salvage: { alloy: [5, 8], circuits: [3, 5], cells: [2, 3] }, coreChance: 0.5,
    },
    halo: {
      name: 'Halo', tier: 3, cls: 'sentient', flying: true, hoverH: 22, scale: 1,
      hull: 110, stability: 80, speed: 14, fleeSpeed: 17, turnRate: 2.2,
      detect: { range: 60, fov: 200 },
      attack: { dmg: 16, type: 'dive', cooldown: 6 },
      alarm: false, fleeAt: 0.2, flanks: false, callsHelp: true, wingSize: [2, 3],
      hackArcs: 3, xp: 60,
      salvage: { alloy: [3, 5], circuits: [3, 5], cells: [2, 4] }, coreChance: 0.35,
    },
    colossus: {
      name: 'Colossus', tier: 4, cls: 'sentient', flying: false, hoverH: 0, scale: 5,
      // hull huge + stability huge: colossus is only damageable through plates/cores (§6b);
      // §7 writes stability "0 (cores instead)" — a literal 0 would trip the generic
      // stability≤0→DISABLED path, so a sentinel value is used and combat routes specially.
      hull: 99999, stability: 99999, speed: 2.2, fleeSpeed: 2.2, turnRate: 0.5,
      detect: { range: 60, fov: 360 },
      attack: { slam: { dmg: 35, r: 9 }, stomp: { dmg: 25, r: 5 }, sweep: { dmg: 30 } },
      alarm: false, fleeAt: 0, flanks: false, callsHelp: false, plateHP: 220,
      hackArcs: 4, xp: 400,
      salvage: { alloy: [20, 30], circuits: [15, 22], cells: [10, 16] }, coreChance: 0,
    },
  };

  /* ================= geometry cache + small builders ================= */

  const _geo = new Map();
  function geo(key, fn) {
    if (!_geo.has(key)) _geo.set(key, fn());
    return _geo.get(key);
  }
  function M(g, mat, cast = true) {
    const m = new THREE.Mesh(g, mat);
    m.castShadow = cast;
    m.receiveShadow = true;
    return m;
  }
  function lathe(key, pts, seg = 32) {
    return geo(key, () => new THREE.LatheGeometry(pts.map((p) => new THREE.Vector2(p[0], p[1])), seg));
  }
  function insetPanel(parent, w, h, d, x, y, z, ry = 0, rx = 0, rz = 0) {
    const m = M(geo(`in|${w}|${h}|${d}`, () => new THREE.BoxGeometry(w, h, d)), MAT.inset, false);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    parent.add(m);
    return m;
  }
  function antenna(parent, tipMat, x, y, z, len, leanX = 0, leanZ = 0) {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    g.rotation.set(leanX, 0, leanZ);
    const rod = M(geo(`ant|${len.toFixed(2)}`, () => new THREE.CylinderGeometry(0.011, 0.022, len, 8)), MAT.carbon, false);
    rod.position.y = len / 2;
    g.add(rod);
    if (tipMat) {
      const tip = M(geo('anttip', () => new THREE.SphereGeometry(0.035, 10, 8)), tipMat, false);
      tip.position.y = len;
      g.add(tip);
    }
    parent.add(g);
    return g;
  }
  function jointHousing(parent, r, x, y, z) {
    const s = M(geo(`jh|${r.toFixed(2)}`, () => new THREE.SphereGeometry(r, 18, 14)), MAT.carbon);
    s.position.set(x, y, z);
    parent.add(s);
    const ring = M(geo(`jhr|${r.toFixed(2)}`, () => new THREE.TorusGeometry(r * 0.92, r * 0.2, 8, 20)), MAT.inset, false);
    ring.position.set(x, y, z);
    ring.rotation.y = Math.PI / 2;
    parent.add(ring);
    return s;
  }
  function addCollider(e, w, h, d, cy) {
    const c = new THREE.Mesh(geo(`col|${w}|${h}|${d}`, () => new THREE.BoxGeometry(w, h, d)), MAT.collider);
    c.position.y = cy;
    c.renderOrder = -1;
    c.userData.entity = e;
    e.group.add(c);
    colliders.push(c);
    e.collider = c;
    return c;
  }
  function addTag(e, w, h, d, cy) {
    const t = new THREE.Mesh(geo(`col|${w}|${h}|${d}`, () => new THREE.BoxGeometry(w, h, d)), MAT.tag);
    t.scale.setScalar(1.06);
    t.position.y = cy;
    t.renderOrder = 999;
    t.visible = false;
    e.group.add(t);
    e.tagMesh = t;
    return t;
  }

  /* ================= mesh builders (forward = -Z, matches player.js yaw math) ================= */

  function buildDrifter(e, em) {
    const P = e.parts, body = new THREE.Group();
    P.body = body;
    e.group.add(body);
    const eMat = em();

    // rounded teardrop-disc hull, 1.1m diameter
    const hull = M(lathe('drifterHull', [
      [0.001, -0.19], [0.28, -0.17], [0.47, -0.09], [0.55, 0.0],
      [0.5, 0.1], [0.34, 0.18], [0.14, 0.22], [0.001, 0.23],
    ]), MAT.body[0]);
    body.add(hull);

    // ducted fan: recessed ring + spinning rotor
    const duct = M(geo('drifterDuct', () => new THREE.TorusGeometry(0.3, 0.055, 12, 28)), MAT.carbon, false);
    duct.rotation.x = Math.PI / 2;
    duct.position.y = 0.16;
    body.add(duct);
    const rotor = new THREE.Group();
    rotor.position.y = 0.15;
    const hub = M(geo('drifterHub', () => new THREE.SphereGeometry(0.06, 12, 10)), MAT.dark, false);
    rotor.add(hub);
    for (let i = 0; i < 3; i++) {
      const blade = M(geo('drifterBlade', () => new THREE.BoxGeometry(0.42, 0.012, 0.08)), MAT.dark, false);
      blade.position.x = 0.14;
      const bg = new THREE.Group();
      bg.rotation.y = (i / 3) * Math.PI * 2;
      bg.add(blade);
      rotor.add(bg);
    }
    body.add(rotor);
    P.rotor = rotor;

    // single big sensor eye (front = -Z) + carbon rim
    const eye = M(geo('drifterEye', () => new THREE.SphereGeometry(0.13, 18, 14)), eMat, false);
    eye.position.set(0, 0.01, -0.46);
    body.add(eye);
    const rim = M(geo('drifterEyeRim', () => new THREE.TorusGeometry(0.14, 0.03, 8, 20)), MAT.carbon, false);
    rim.position.set(0, 0.01, -0.44);
    body.add(rim);

    // emissive accent band around the rim
    const band = M(geo('drifterBand', () => new THREE.TorusGeometry(0.52, 0.014, 8, 40)), eMat, false);
    band.rotation.x = Math.PI / 2;
    band.position.y = 0.02;
    body.add(band);

    // 3 antennae swept back
    antenna(body, eMat, 0, 0.16, 0.34, 0.55, 0.85, 0);
    antenna(body, eMat, 0.16, 0.14, 0.3, 0.45, 0.8, -0.35);
    antenna(body, eMat, -0.16, 0.14, 0.3, 0.45, 0.8, 0.35);

    // panel insets + underside sensor pod
    insetPanel(body, 0.2, 0.02, 0.14, 0.24, 0.14, -0.16, 0.5);
    insetPanel(body, 0.2, 0.02, 0.14, -0.24, 0.14, -0.16, -0.5);
    insetPanel(body, 0.16, 0.02, 0.22, 0, 0.16, 0.3);
    const pod = M(geo('drifterPod', () => new THREE.CylinderGeometry(0.09, 0.06, 0.14, 14)), MAT.carbon, false);
    pod.position.y = -0.22;
    body.add(pod);

    addCollider(e, 1.15, 0.6, 1.15, 0);
    addTag(e, 1.15, 0.6, 1.15, 0);
  }

  function buildSkitter(e, em) {
    const P = e.parts, body = new THREE.Group();
    body.position.y = 0.55;
    P.body = body;
    P.bodyBaseY = 0.55;
    e.group.add(body);
    const eMat = em();

    // domed lathed carapace (~1.4m across)
    const shell = M(lathe('skitterShell', [
      [0.6, -0.06], [0.7, 0.04], [0.66, 0.16], [0.52, 0.28], [0.3, 0.37], [0.001, 0.41],
    ]), MAT.body[1]);
    body.add(shell);
    const under = M(geo('skitterUnder', () => new THREE.SphereGeometry(0.5, 20, 14)), MAT.carbon);
    under.scale.set(1.05, 0.5, 1.15);
    under.position.y = -0.12;
    body.add(under);

    // eye strip + antennae + panel insets
    const strip = M(geo('skitterStrip', () => new THREE.BoxGeometry(0.46, 0.055, 0.05)), eMat, false);
    strip.position.set(0, 0.04, -0.63);
    body.add(strip);
    antenna(body, eMat, 0.12, 0.3, -0.4, 0.4, -0.7, -0.15);
    antenna(body, eMat, -0.12, 0.3, -0.4, 0.4, -0.7, 0.15);
    insetPanel(body, 0.3, 0.02, 0.2, 0, 0.36, 0.15, 0, -0.25);
    insetPanel(body, 0.18, 0.02, 0.26, 0.32, 0.24, 0.1, 0.4, 0, -0.55);
    insetPanel(body, 0.18, 0.02, 0.26, -0.32, 0.24, 0.1, -0.4, 0, 0.55);
    const vent = M(geo('skitterVent', () => new THREE.CylinderGeometry(0.09, 0.11, 0.1, 12)), MAT.inset, false);
    vent.position.set(0, 0.32, 0.34);
    body.add(vent);

    // 6 jointed legs (2-seg, tripod gait). Legs hang from root so feet stay planted.
    P.legs = [];
    for (let i = 0; i < 6; i++) {
      const side = i < 3 ? -1 : 1;
      const rank = i % 3;
      const dz = (rank - 1) * 0.7;
      const theta = Math.atan2(-dz, side); // leg built along +X, rotated outward
      const hip = new THREE.Group();
      hip.position.set(side * 0.36, 0.5, (rank - 1) * 0.3);
      hip.rotation.y = theta;
      hip.rotation.z = 0.55;
      const upper = M(geo('skitterUpper', () => new THREE.CapsuleGeometry(0.05, 0.3, 4, 10)), MAT.body[1], false);
      upper.rotation.z = Math.PI / 2;
      upper.position.x = 0.17;
      hip.add(upper);
      jointHousing(hip, 0.06, 0.35, 0, 0);
      const knee = new THREE.Group();
      knee.position.x = 0.35;
      knee.rotation.z = -1.5;
      const low = M(geo('skitterLower', () => new THREE.CylinderGeometry(0.016, 0.036, 0.52, 8)), MAT.carbon, false);
      low.rotation.z = Math.PI / 2;
      low.position.x = 0.26;
      knee.add(low);
      const tip = M(geo('skitterTip', () => new THREE.SphereGeometry(0.03, 8, 6)), MAT.dark, false);
      tip.position.x = 0.52;
      knee.add(tip);
      hip.add(knee);
      e.group.add(hip);
      P.legs.push({ hip, knee, baseY: theta, baseZ: 0.55, kneeZ: -1.5, phase: ((rank + (side > 0 ? 1 : 0)) % 2) * Math.PI + rank * 0.25 });
    }

    // 2 harvester claws
    P.claws = [];
    for (let sIdx = 0; sIdx < 2; sIdx++) {
      const side = sIdx === 0 ? -1 : 1;
      const arm = new THREE.Group();
      arm.position.set(side * 0.24, 0.38, -0.5);
      arm.rotation.x = 0.45;
      const seg = M(geo('skitterArm', () => new THREE.CapsuleGeometry(0.05, 0.26, 4, 10)), MAT.body[1], false);
      seg.rotation.x = Math.PI / 2;
      seg.position.z = -0.15;
      arm.add(seg);
      const pincer = new THREE.Group();
      pincer.position.z = -0.32;
      const c1 = M(geo('skitterClaw', () => new THREE.TorusGeometry(0.11, 0.032, 8, 12, 2.1)), MAT.carbon, false);
      c1.rotation.set(0, Math.PI / 2, 0.5);
      const c2 = c1.clone();
      c2.rotation.z = -2.6;
      pincer.add(c1, c2);
      arm.add(pincer);
      e.group.add(arm);
      P.claws.push({ arm, pincer, phase: sIdx * 1.4 });
    }

    addCollider(e, 1.4, 0.95, 1.5, 0.5);
    addTag(e, 1.4, 0.95, 1.5, 0.5);
  }

  function buildStrider(e, em) {
    const P = e.parts, body = new THREE.Group();
    P.body = body;
    P.bodyBaseY = 0;
    e.group.add(body);
    const eMat = em();

    // sleek capsule torso, ~1.45m at shoulder
    const torso = M(geo('striderTorso', () => new THREE.CapsuleGeometry(0.33, 1.05, 8, 20)), MAT.body[2]);
    torso.rotation.x = Math.PI / 2;
    torso.position.set(0, 1.45, 0.02);
    torso.scale.set(1, 1.12, 1);
    body.add(torso);
    // spine ridge + flank accent strips + panel insets
    const spine = M(geo('striderSpine', () => new THREE.CapsuleGeometry(0.09, 0.9, 4, 10)), MAT.carbon, false);
    spine.rotation.x = Math.PI / 2;
    spine.position.set(0, 1.83, 0.05);
    body.add(spine);
    for (const sd of [-1, 1]) {
      const strip = M(geo('striderStrip', () => new THREE.BoxGeometry(0.02, 0.05, 0.85)), eMat, false);
      strip.position.set(sd * 0.345, 1.5, 0);
      body.add(strip);
      insetPanel(body, 0.02, 0.2, 0.42, sd * 0.32, 1.32, 0.28);
      insetPanel(body, 0.02, 0.22, 0.3, sd * 0.33, 1.55, -0.42);
    }
    insetPanel(body, 0.26, 0.03, 0.5, 0, 1.86, -0.2);

    // neck + wedge head with emissive eye band + jaw
    const neck = M(geo('striderNeck', () => new THREE.CapsuleGeometry(0.11, 0.34, 4, 12)), MAT.carbon, false);
    neck.position.set(0, 1.68, -0.72);
    neck.rotation.x = 1.05;
    body.add(neck);
    const head = new THREE.Group();
    head.position.set(0, 1.84, -0.95);
    P.head = head;
    const skull = M(geo('striderSkull', () => new THREE.SphereGeometry(0.17, 18, 14)), MAT.body[2]);
    skull.scale.set(1, 0.9, 1.1);
    head.add(skull);
    const wedge = M(geo('striderWedge', () => new THREE.CylinderGeometry(0.03, 0.165, 0.55, 14)), MAT.body[2]);
    wedge.rotation.x = -Math.PI / 2;
    wedge.position.z = -0.3;
    head.add(wedge);
    const eyeBand = M(geo('striderEyeBand', () => new THREE.TorusGeometry(0.135, 0.026, 8, 20, 3.4)), eMat, false);
    eyeBand.position.set(0, 0.02, -0.22);
    eyeBand.rotation.set(Math.PI / 2, 0, -1.7);
    head.add(eyeBand);
    const jaw = new THREE.Group();
    jaw.position.set(0, -0.1, -0.12);
    const jawM = M(geo('striderJaw', () => new THREE.BoxGeometry(0.14, 0.05, 0.42)), MAT.carbon, false);
    jawM.position.z = -0.18;
    jaw.add(jawM);
    head.add(jaw);
    P.jaw = jaw;
    body.add(head);

    // tail antenna, sways
    const tail = new THREE.Group();
    tail.position.set(0, 1.52, 0.62);
    tail.rotation.x = -0.85;
    const tailRod = M(geo('striderTail', () => new THREE.CylinderGeometry(0.012, 0.035, 0.75, 8)), MAT.carbon, false);
    tailRod.position.y = 0.37;
    tail.add(tailRod);
    const tailTip = M(geo('anttip', () => new THREE.SphereGeometry(0.035, 10, 8)), eMat, false);
    tailTip.position.y = 0.75;
    tail.add(tailTip);
    body.add(tail);
    P.tail = tail;

    // saddle on the back
    const saddle = new THREE.Object3D();
    saddle.position.set(0, 1.82, 0.18);
    body.add(saddle);
    const pad = M(geo('striderPad', () => new THREE.BoxGeometry(0.34, 0.06, 0.5)), MAT.inset, false);
    pad.position.set(0, 1.78, 0.18);
    body.add(pad);
    P.saddle = saddle;
    e.saddle = saddle;

    // 4 articulated 3-seg legs, inverse knee (digitigrade)
    P.legs = [];
    const anchors = [
      [-0.26, 1.32, -0.42], [0.26, 1.32, -0.42],
      [-0.28, 1.38, 0.45], [0.28, 1.38, 0.45],
    ];
    for (let i = 0; i < 4; i++) {
      const [ax, ay, az] = anchors[i];
      const hip = new THREE.Group();
      hip.position.set(ax, ay, az);
      hip.rotation.x = 0.3;
      const thigh = M(geo('striderThigh', () => new THREE.CapsuleGeometry(0.095, 0.44, 4, 12)), MAT.body[2]);
      thigh.position.y = -0.28;
      hip.add(thigh);
      jointHousing(hip, 0.11, 0, 0, 0);
      const knee = new THREE.Group();
      knee.position.y = -0.58;
      knee.rotation.x = -1.0;
      const shank = M(geo('striderShank', () => new THREE.CapsuleGeometry(0.055, 0.46, 4, 10)), MAT.carbon);
      shank.position.y = -0.29;
      knee.add(shank);
      jointHousing(knee, 0.08, 0, 0, 0);
      const ankle = new THREE.Group();
      ankle.position.y = -0.58;
      ankle.rotation.x = 0.85;
      const met = M(geo('striderMet', () => new THREE.CylinderGeometry(0.032, 0.05, 0.34, 10)), MAT.carbon, false);
      met.position.y = -0.17;
      ankle.add(met);
      const foot = M(geo('striderFoot', () => new THREE.ConeGeometry(0.07, 0.16, 10)), MAT.dark, false);
      foot.position.y = -0.36;
      foot.rotation.x = Math.PI;
      ankle.add(foot);
      knee.add(ankle);
      hip.add(knee);
      e.group.add(hip);
      P.legs.push({ hip, knee, ankle, hipX: 0.3, kneeX: -1.0, ankleX: 0.85, phase: (i === 0 || i === 3) ? 0 : Math.PI });
    }

    addCollider(e, 1.1, 2.1, 2.4, 1.15);
    addTag(e, 1.1, 2.1, 2.4, 1.15);
  }

  function buildWarden(e, em) {
    const P = e.parts, body = new THREE.Group();
    P.body = body;
    P.bodyBaseY = 0;
    e.group.add(body);
    const eMat = em();

    // pelvis + massive lathed torso (3.2m tall overall)
    const pelvis = M(geo('wardenPelvis', () => new THREE.SphereGeometry(0.42, 18, 14)), MAT.carbon);
    pelvis.scale.set(1.15, 0.7, 0.9);
    pelvis.position.y = 1.6;
    body.add(pelvis);
    const torso = M(lathe('wardenTorso', [
      [0.4, -0.55], [0.68, -0.35], [0.78, 0.0], [0.82, 0.3], [0.7, 0.52], [0.35, 0.62], [0.001, 0.64],
    ]), MAT.body[1]);
    torso.position.y = 2.32;
    torso.scale.set(1.12, 1, 0.88);
    body.add(torso);

    // chest core (emissive) + rim
    const core = M(geo('wardenCore', () => new THREE.CylinderGeometry(0.2, 0.2, 0.07, 22)), eMat, false);
    core.rotation.x = Math.PI / 2;
    core.position.set(0, 2.42, -0.66);
    body.add(core);
    const coreRim = M(geo('wardenCoreRim', () => new THREE.TorusGeometry(0.24, 0.05, 10, 24)), MAT.carbon, false);
    coreRim.position.set(0, 2.42, -0.66);
    body.add(coreRim);
    const coreLight = new THREE.PointLight(COL_HOSTILE, 2.5, 8);
    coreLight.position.set(0, 2.42, -0.85);
    body.add(coreLight);
    P.lights = [coreLight];

    // shoulder armor plates with inset paneling
    for (const sd of [-1, 1]) {
      const pauldron = M(geo('wardenPauldron', () => new THREE.SphereGeometry(0.5, 20, 14, 0, Math.PI * 2, 0, Math.PI * 0.55)), MAT.body[1]);
      pauldron.scale.set(0.95, 0.8, 1.05);
      pauldron.position.set(sd * 0.98, 2.78, 0);
      body.add(pauldron);
      insetPanel(body, 0.34, 0.05, 0.4, sd * 1.0, 3.05, 0, 0, 0, sd * -0.35);
      insetPanel(body, 0.03, 0.3, 0.5, sd * 0.86, 2.3, 0);
      const strip = M(geo('wardenStrip', () => new THREE.BoxGeometry(0.02, 0.34, 0.05)), eMat, false);
      strip.position.set(sd * 0.9, 2.32, -0.5);
      body.add(strip);
    }
    insetPanel(body, 0.5, 0.05, 0.6, 0, 2.9, 0.35, 0, 0.3);

    // small sensor head + antenna cluster
    const head = new THREE.Group();
    head.position.set(0, 3.06, -0.22);
    const dome = M(geo('wardenHead', () => new THREE.SphereGeometry(0.18, 16, 12)), MAT.carbon);
    dome.scale.set(1, 0.85, 1.05);
    head.add(dome);
    const visor = M(geo('wardenVisor', () => new THREE.BoxGeometry(0.22, 0.045, 0.04)), eMat, false);
    visor.position.set(0, 0.01, -0.17);
    head.add(visor);
    body.add(head);
    P.head = head;
    antenna(body, eMat, 0.5, 3.15, 0.2, 0.5, -0.25, -0.3);
    antenna(body, null, 0.62, 3.05, 0.25, 0.35, -0.15, -0.5);
    antenna(body, eMat, -0.55, 3.1, 0.22, 0.42, -0.2, 0.35);

    // huge arms: shoulder → forearm → fist
    P.arms = [];
    for (const sd of [-1, 1]) {
      const shoulder = new THREE.Group();
      shoulder.position.set(sd * 0.95, 2.72, 0);
      shoulder.rotation.x = 0.12;
      const upper = M(geo('wardenUpperArm', () => new THREE.CapsuleGeometry(0.13, 0.42, 4, 12)), MAT.carbon);
      upper.position.y = -0.28;
      shoulder.add(upper);
      const elbow = new THREE.Group();
      elbow.position.y = -0.6;
      elbow.rotation.x = -0.55;
      jointHousing(elbow, 0.15, 0, 0, 0);
      const forearm = M(geo('wardenForearm', () => new THREE.CapsuleGeometry(0.24, 0.55, 6, 16)), MAT.body[1]);
      forearm.position.y = -0.42;
      elbow.add(forearm);
      const fist = M(geo('wardenFist', () => new THREE.SphereGeometry(0.29, 16, 12)), MAT.carbon);
      fist.scale.set(0.9, 0.85, 1.1);
      fist.position.y = -0.85;
      elbow.add(fist);
      insetPanel(elbow, 0.2, 0.3, 0.04, sd * 0.2, -0.45, -0.18, 0, 0.2);
      shoulder.add(elbow);
      body.add(shoulder);
      P.arms.push({ shoulder, elbow, baseX: 0.12 });
    }

    // heavy 2-seg legs + big feet
    P.legs = [];
    for (const sd of [-1, 1]) {
      const hip = new THREE.Group();
      hip.position.set(sd * 0.42, 1.58, 0);
      const thigh = M(geo('wardenThigh', () => new THREE.CapsuleGeometry(0.2, 0.5, 6, 14)), MAT.body[1]);
      thigh.position.y = -0.35;
      hip.add(thigh);
      jointHousing(hip, 0.17, 0, 0, 0);
      const knee = new THREE.Group();
      knee.position.y = -0.76;
      jointHousing(knee, 0.15, 0, 0, 0);
      const shin = M(geo('wardenShin', () => new THREE.CapsuleGeometry(0.16, 0.48, 6, 14)), MAT.carbon);
      shin.position.y = -0.34;
      knee.add(shin);
      const shinStrip = M(geo('wardenShinStrip', () => new THREE.BoxGeometry(0.04, 0.3, 0.02)), eMat, false);
      shinStrip.position.set(0, -0.35, -0.17);
      knee.add(shinStrip);
      const foot = M(geo('wardenFoot', () => new THREE.BoxGeometry(0.42, 0.18, 0.62)), MAT.dark);
      foot.position.set(0, -0.72, -0.08);
      knee.add(foot);
      insetPanel(knee, 0.3, 0.05, 0.44, 0, -0.64, -0.08);
      hip.add(knee);
      e.group.add(hip);
      P.legs.push({ hip, knee, phase: sd < 0 ? 0 : Math.PI });
    }

    addCollider(e, 2.0, 3.2, 1.6, 1.6);
    addTag(e, 2.0, 3.2, 1.6, 1.6);
  }

  function buildHalo(e, em) {
    const P = e.parts, body = new THREE.Group();
    P.body = body;
    P.bodyBaseY = 0;
    e.group.add(body);
    const eMat = em();
    const pulseMat = em(); // exhausts + strobes: own instance so blink/flicker can override
    P.pulseMat = pulseMat;

    // swept lifting-body wing (extruded planform, beveled = smooth-ish airfoil)
    const wingGeo = geo('haloWing', () => {
      const sh = new THREE.Shape();
      sh.moveTo(0, 1.55);
      sh.quadraticCurveTo(0.55, 1.05, 1.95, -0.42);
      sh.quadraticCurveTo(2.05, -0.62, 1.7, -0.66);
      sh.quadraticCurveTo(0.8, -0.5, 0.3, -1.02);
      sh.quadraticCurveTo(0, -1.18, -0.3, -1.02);
      sh.quadraticCurveTo(-0.8, -0.5, -1.7, -0.66);
      sh.quadraticCurveTo(-2.05, -0.62, -1.95, -0.42);
      sh.quadraticCurveTo(-0.55, 1.05, 0, 1.55);
      const g = new THREE.ExtrudeGeometry(sh, { depth: 0.13, bevelEnabled: true, bevelThickness: 0.09, bevelSize: 0.11, bevelSegments: 3, steps: 1, curveSegments: 22 });
      g.translate(0, 0, -0.065);
      g.rotateX(-Math.PI / 2);   // shape +y (nose) → world -Z
      g.scale(0.82, 1, 0.82);
      g.computeVertexNormals();
      return g;
    });
    const wing = M(wingGeo, MAT.body[0]);
    body.add(wing);

    // central fuselage + drooped nose w/ red targeting eye
    const fus = M(geo('haloFus', () => new THREE.CapsuleGeometry(0.26, 1.2, 6, 16)), MAT.body[0]);
    fus.rotation.x = Math.PI / 2;
    fus.position.set(0, 0.05, -0.35);
    body.add(fus);
    const eye = M(geo('haloEye', () => new THREE.SphereGeometry(0.11, 16, 12)), eMat, false);
    eye.position.set(0, -0.02, -1.32);
    body.add(eye);
    const eyeRim = M(geo('haloEyeRim', () => new THREE.TorusGeometry(0.12, 0.028, 8, 18)), MAT.carbon, false);
    eyeRim.position.set(0, -0.02, -1.28);
    body.add(eyeRim);

    // twin engine nacelles with emissive exhausts
    P.nacelles = [];
    for (const sd of [-1, 1]) {
      const nac = M(geo('haloNacelle', () => new THREE.CapsuleGeometry(0.15, 0.7, 6, 14)), MAT.carbon);
      nac.rotation.x = Math.PI / 2;
      nac.position.set(sd * 0.85, -0.06, 0.32);
      body.add(nac);
      const intake = M(geo('haloIntake', () => new THREE.TorusGeometry(0.15, 0.035, 8, 18)), MAT.inset, false);
      intake.position.set(sd * 0.85, -0.06, -0.14);
      body.add(intake);
      const exhaust = M(geo('haloExhaust', () => new THREE.CylinderGeometry(0.11, 0.13, 0.06, 16)), pulseMat, false);
      exhaust.rotation.x = Math.PI / 2;
      exhaust.position.set(sd * 0.85, -0.06, 0.82);
      body.add(exhaust);
      P.nacelles.push(nac);
    }

    // wingtip strobes + spine antennae + panel insets + accent strips
    for (const sd of [-1, 1]) {
      const strobe = M(geo('haloStrobe', () => new THREE.SphereGeometry(0.05, 10, 8)), pulseMat, false);
      strobe.position.set(sd * 1.58, 0.03, -0.32);
      body.add(strobe);
      const strip = M(geo('haloStrip', () => new THREE.BoxGeometry(0.55, 0.015, 0.05)), eMat, false);
      strip.position.set(sd * 0.95, 0.1, -0.05);
      strip.rotation.y = sd * 0.55;
      body.add(strip);
      insetPanel(body, 0.5, 0.02, 0.3, sd * 0.7, 0.12, -0.3, sd * 0.5);
    }
    antenna(body, eMat, 0, 0.12, 0.35, 0.35, 0.6, 0);
    antenna(body, null, 0.1, 0.12, 0.45, 0.25, 0.7, -0.2);
    insetPanel(body, 0.24, 0.02, 0.5, 0, 0.16, 0.1);

    // saddle behind the spine
    const saddle = new THREE.Object3D();
    saddle.position.set(0, 0.28, -0.25);
    body.add(saddle);
    P.saddle = saddle;
    e.saddle = saddle;

    addCollider(e, 3.4, 0.75, 2.4, 0);
    addTag(e, 3.4, 0.75, 2.4, 0);
  }

  function buildColossus(e, em) {
    const P = e.parts, body = new THREE.Group();
    P.body = body;
    P.bodyBaseY = 0;
    e.group.add(body);
    const eMat = em();

    // cathedral-mass hull ~14m long, back ridge, keel
    const hull = M(geo('colHull', () => new THREE.CapsuleGeometry(3.0, 7.0, 8, 26)), MAT.body[1]);
    hull.rotation.x = Math.PI / 2;
    hull.position.y = 7.6;
    hull.scale.set(0.92, 1.15, 1);
    body.add(hull);
    const keel = M(geo('colKeel', () => new THREE.SphereGeometry(1.0, 18, 14)), MAT.carbon);
    keel.scale.set(2.1, 1.5, 5.4);
    keel.position.y = 5.9;
    body.add(keel);

    // rib arches over the spine (cathedral silhouette)
    for (let i = 0; i < 4; i++) {
      const rib = M(geo('colRib', () => new THREE.TorusGeometry(3.35, 0.17, 8, 22, Math.PI)), MAT.carbon, false);
      rib.position.set(0, 7.6, -3.6 + i * 2.4);
      body.add(rib);
    }
    // dorsal ridge fins + antenna spires w/ violet precursor tips
    for (let i = 0; i < 3; i++) {
      const fin = M(geo('colFin', () => new THREE.ConeGeometry(0.7, 2.2, 12)), MAT.body[1]);
      fin.position.set(0, 11.4, -2.4 + i * 2.4);
      fin.scale.set(0.5, 1, 1.4);
      body.add(fin);
      const spire = M(geo(`colSpire${i}`, () => new THREE.CylinderGeometry(0.06, 0.22, 4.5 + i * 0.8, 10)), MAT.carbon, false);
      spire.position.set(i === 1 ? 0 : (i - 1) * 1.4, 12.6 + (i === 1 ? 1.2 : 0), 1.2 + i * 1.1);
      spire.rotation.z = (i - 1) * 0.12;
      body.add(spire);
      const tip = M(geo('colSpireTip', () => new THREE.SphereGeometry(0.22, 12, 10)), MAT.violet, false);
      tip.position.copy(spire.position);
      tip.position.y += (4.5 + i * 0.8) / 2;
      body.add(tip);
    }
    // violet precursor seams along the flanks + hull panel insets
    for (const sd of [-1, 1]) {
      const seam = M(geo('colSeam', () => new THREE.BoxGeometry(0.1, 0.16, 9.5)), MAT.violet, false);
      seam.position.set(sd * 2.72, 8.6, 0);
      body.add(seam);
      insetPanel(body, 0.2, 1.4, 3.2, sd * 2.62, 7.0, 2.2);
      insetPanel(body, 0.2, 1.1, 2.4, sd * 2.66, 7.2, -3.4);
    }
    insetPanel(body, 2.6, 0.2, 3.0, 0, 10.55, -1.0);

    // low sensor head, front underside, emissive eye cluster
    const head = new THREE.Group();
    head.position.set(0, 5.7, -7.0);
    const skull = M(geo('colSkull', () => new THREE.SphereGeometry(1.15, 22, 16)), MAT.body[1]);
    skull.scale.set(1.25, 0.75, 1.6);
    head.add(skull);
    for (let i = -1; i <= 1; i++) {
      const eEye = M(geo('colEye', () => new THREE.SphereGeometry(0.17, 12, 10)), eMat, false);
      eEye.position.set(i * 0.55, 0.02, -1.55);
      head.add(eEye);
    }
    const jawPlate = M(geo('colJaw', () => new THREE.BoxGeometry(1.5, 0.3, 1.6)), MAT.carbon, false);
    jawPlate.position.set(0, -0.62, -0.7);
    head.add(jawPlate);
    const headLight = new THREE.PointLight(COL_HOSTILE, 5, 26);
    headLight.position.set(0, 0, -1.8);
    head.add(headLight);
    P.lights = [headLight];
    body.add(head);
    P.head = head;

    // 4 tower legs with joint housings; slow ponderous gait
    P.legs = [];
    const legAnchors = [[-2.5, -3.5], [2.5, -3.5], [-2.5, 3.6], [2.5, 3.6]];
    for (let i = 0; i < 4; i++) {
      const [ax, az] = legAnchors[i];
      const sd = Math.sign(ax);
      const hip = new THREE.Group();
      hip.position.set(ax, 7.0, az);
      hip.rotation.z = sd * -0.16;
      jointHousing(hip, 1.05, 0, 0, 0);
      const thigh = M(geo('colThigh', () => new THREE.CylinderGeometry(0.72, 0.62, 3.2, 16)), MAT.body[1]);
      thigh.position.y = -1.7;
      hip.add(thigh);
      const knee = new THREE.Group();
      knee.position.y = -3.35;
      knee.rotation.z = sd * 0.16;
      jointHousing(knee, 0.85, 0, 0, 0);
      const shin = M(geo('colShin', () => new THREE.CylinderGeometry(0.52, 0.72, 3.6, 16)), MAT.carbon);
      shin.position.y = -1.95;
      knee.add(shin);
      const foot = M(geo('colFoot', () => new THREE.CylinderGeometry(1.35, 1.5, 0.7, 18)), MAT.dark);
      foot.position.y = -3.85;
      knee.add(foot);
      insetPanel(knee, 0.9, 0.24, 0.9, 0, -3.45, 0);
      hip.add(knee);
      e.group.add(hip);
      P.legs.push({ hip, knee, baseZ: sd * -0.16, kneeZ: sd * 0.16, phase: (i === 0 || i === 3) ? 0 : Math.PI, planted: false });
    }

    // three glowing armor plates (left leg / right leg / flank) + hidden cores (§6b)
    e.plates = [];
    e.cores = [];
    const plateSpecs = [
      { side: 'left', parent: P.legs[0].hip, pos: [-1.05, -1.6, 0], scl: [0.85, 1.5, 1.0], rotZ: Math.PI / 2, r: 1.05, coreR: 0.55 },
      { side: 'right', parent: P.legs[1].hip, pos: [1.05, -1.6, 0], scl: [0.85, 1.5, 1.0], rotZ: -Math.PI / 2, r: 1.05, coreR: 0.55 },
      { side: 'flank', parent: body, pos: [-2.55, 7.6, 0.8], scl: [1.0, 1.35, 1.6], rotZ: Math.PI / 2, r: 1.6, coreR: 0.8 },
    ];
    for (let i = 0; i < 3; i++) {
      const sp = plateSpecs[i];
      const plateMat = PLATE_BASE.clone();
      const plate = M(geo(`colPlate${sp.r}`, () => new THREE.SphereGeometry(sp.r, 22, 16, 0, Math.PI * 2, 0, Math.PI * 0.5)), plateMat);
      plate.scale.set(sp.scl[0], sp.scl[1] * 0.42, sp.scl[2]);
      plate.position.set(sp.pos[0], sp.pos[1], sp.pos[2]);
      plate.rotation.z = sp.rotZ;
      plate.userData.entity = e;
      plate.userData.part = 'plate' + i;
      sp.parent.add(plate);
      colliders.push(plate);
      e.plates.push({ mesh: plate, hp: TYPES.colossus.plateHP, hpMax: TYPES.colossus.plateHP, broken: false, side: sp.side, mat: plateMat });

      const coreMat = CORE_BASE.clone();
      const core = M(geo(`colCore${sp.coreR}`, () => new THREE.SphereGeometry(sp.coreR, 20, 16)), coreMat, false);
      // sit the core just inside where the plate was (pulled toward the centerline)
      core.position.set(sp.pos[0] * 0.68, sp.pos[1], sp.pos[2]);
      core.visible = false;
      core.userData.entity = e;
      core.userData.part = 'core' + i;
      sp.parent.add(core);
      e.cores.push({ mesh: core, mat: coreMat, done: false });
    }
    e.coreIdx = null;
    e.coreStab = 100;
    e.hackWindow = 0;
    e.hacksDone = 0;

    addCollider(e, 6.2, 8.5, 15.5, 7.4);
    addTag(e, 6.2, 8.5, 15.5, 7.4);
  }

  const BUILDERS = {
    drifter: buildDrifter, skitter: buildSkitter, strider: buildStrider,
    warden: buildWarden, halo: buildHalo, colossus: buildColossus,
  };

  /* ================= entity factory ================= */

  const colliders = [];
  let nextId = 1;
  let colossusRef = null;

  function groundY(x, z) {
    return G.world?.getGroundHeight?.(x, z) ?? 0;
  }

  function spawn(type, pos) {
    const cfg = TYPES[type];
    if (!cfg) return null;
    const group = new THREE.Group();
    const e = {
      id: nextId++, type, cfg, group, pos: group.position,
      yaw: rngRange(0, Math.PI * 2), vel: new THREE.Vector3(),
      hull: cfg.hull, hullMax: cfg.hull, stability: cfg.stability, stabilityMax: cfg.stability,
      state: 'PATROL', stateT: 0,
      faction: 'hostile', captured: false,
      disabledT: 0, hackLock: false,
      target: null, alertPos: null,
      home: null, patrol: null,
      order: { mode: 'follow' },
      assignedNode: null,
      memory: { playerSeen: 0, escaped: false },
      collider: null,
      parts: { emissiveMats: [] },
      tagMesh: null, saddle: null,
      flying: cfg.flying, hoverH: cfg.hoverH,
      dying: false, deadT: 0,
      wing: null,
    };
    const em = () => {
      const m = EM_BASE.clone();
      e.parts.emissiveMats.push(m);
      return m;
    };
    BUILDERS[type](e, em);

    const gx = pos?.x ?? 0, gz = pos?.z ?? 0;
    group.position.set(gx, groundY(gx, gz) + (cfg.flying ? cfg.hoverH : 0), gz);
    group.rotation.y = e.yaw;
    e.home = group.position.clone();
    e.anim = {
      phase: rng() * Math.PI * 2, gait: rng() * Math.PI * 2,
      bank: 0, prevYaw: e.yaw, slump: 0,
      lastPos: group.position.clone(),
      facKey: '', dyingInit: false, strobeAcc: 0, strobeOn: true,
      tiltX: 0, tiltZ: 0, jawT: 0, armT: 0.12,
    };
    if (type === 'colossus') colossusRef = e;
    applyFaction(e);
    scene.add(group);
    S.machines.push(e);
    return e;
  }

  /* ================= faction FX ================= */

  function applyFaction(e) {
    if (!e || !e.parts) return;
    const disabled = e.state === 'DISABLED';
    const hex = disabled ? COL_DISABLED : e.faction === 'captured' ? COL_CAPTURED : COL_HOSTILE;
    for (const m of e.parts.emissiveMats) m.emissive.setHex(hex);
    if (e.parts.lights) for (const l of e.parts.lights) l.color.setHex(hex);
    if (e.type === 'colossus' && e.plates) {
      const cap = e.faction === 'captured';
      for (const p of e.plates) p.mat.emissive.setHex(cap ? COL_CAPTURED : COL_PLATE);
      for (const c of e.cores) if (!c.done) c.mat.emissive.setHex(cap ? COL_CAPTURED : COL_CORE);
    }
    if (e.anim) e.anim.facKey = disabled ? 'dis' : e.faction;
  }

  /* ================= populate (BRIEF §6.2 zones) ================= */

  const CRASH = { x: -150, z: -150 };
  const DRYSEA = { x: 50, z: -50 };
  const SPIRE = { x: 180, z: 180 };
  let wingSeq = 3;

  function ringPoint(cx, cz, rMin, rMax) {
    const a = rng() * Math.PI * 2, r = rngRange(rMin, rMax);
    return { x: clamp(cx + Math.cos(a) * r, -280, 280), z: clamp(cz + Math.sin(a) * r, -280, 280) };
  }

  function nodesNear(x, z, maxD) {
    const nodes = G.world?.nodes || [];
    const out = [];
    for (const n of nodes) {
      if (!n?.pos) continue;
      const d = dist2d(n.pos.x, n.pos.z, x, z);
      if (d <= maxD) out.push({ n, d });
    }
    out.sort((a, b) => a.d - b.d);
    return out.map((o) => o.n);
  }

  function pickCircuit(x, z) {
    const near = nodesNear(x, z, 140);
    const pts = [];
    for (let i = 0; i < Math.min(3, near.length); i++) pts.push(near[i].pos.clone());
    while (pts.length < 3) {
      const p = ringPoint(x, z, 15, 45);
      pts.push(new THREE.Vector3(p.x, groundY(p.x, p.z), p.z));
    }
    return { nodes: pts, i: 0 };
  }

  function spawnSkitterPair(x, z) {
    const circuit = pickCircuit(x, z);
    const out = [];
    for (let k = 0; k < 2; k++) {
      const e = spawn('skitter', { x: x + rngRange(-3, 3), z: z + rngRange(-3, 3) });
      if (!e) continue;
      e.patrol = { nodes: circuit.nodes.map((v) => v.clone()), i: k % circuit.nodes.length };
      out.push(e);
    }
    return out;
  }

  function spawnHaloWing(cx, cz, n, wingId) {
    for (let k = 0; k < n; k++) {
      const e = spawn('halo', { x: cx + rngRange(-12, 12), z: cz + rngRange(-12, 12) });
      if (e) e.wing = wingId;
    }
  }

  function populate() {
    const P = G.world?.positions || {};
    const ps = P.playerSpawn;

    // --- Crashfield: 3 drifters + 2 skitter pairs ---
    let placed = 0, guard = 0;
    while (placed < 3 && guard++ < 60) {
      const p = ringPoint(CRASH.x, CRASH.z, 30, 85);
      if (ps && dist2d(p.x, p.z, ps.x, ps.z) < 28) continue;
      spawn('drifter', p);
      placed++;
    }
    const crashNodes = nodesNear(CRASH.x, CRASH.z, 110);
    for (let i = 0; i < 2; i++) {
      const at = crashNodes[i]?.pos || ringPoint(CRASH.x, CRASH.z, 40, 80);
      if (ps && dist2d(at.x, at.z, ps.x, ps.z) < 25) {
        const alt = ringPoint(CRASH.x, CRASH.z, 50, 90);
        spawnSkitterPair(alt.x, alt.z);
      } else spawnSkitterPair(at.x, at.z);
    }

    // --- Dry Sea: 3 striders spread, 2 skitter pairs, halo wing of 3, 2 drifters ---
    const striderSpots = [];
    guard = 0;
    while (striderSpots.length < 3 && guard++ < 80) {
      const p = ringPoint(DRYSEA.x, DRYSEA.z, 20, 105);
      let ok = true;
      for (const s of striderSpots) if (dist2d(p.x, p.z, s.x, s.z) < 45) { ok = false; break; }
      if (ok) striderSpots.push(p);
    }
    for (const p of striderSpots) spawn('strider', p);
    const dryNodes = nodesNear(DRYSEA.x, DRYSEA.z, 130);
    for (let i = 0; i < 2; i++) {
      const at = dryNodes[i + 1]?.pos || ringPoint(DRYSEA.x, DRYSEA.z, 30, 90);
      spawnSkitterPair(at.x, at.z);
    }
    spawnHaloWing(DRYSEA.x + 20, DRYSEA.z - 10, 3, 1);
    for (let i = 0; i < 2; i++) spawn('drifter', ringPoint(DRYSEA.x, DRYSEA.z, 25, 95));

    // --- Relay Spire: 4 wardens at posts, halo wing of 2, 1 drifter, colossus ---
    const posts = (P.wardenPosts && P.wardenPosts.length >= 4) ? P.wardenPosts : [
      new THREE.Vector3(165, 0, 170), new THREE.Vector3(196, 0, 166),
      new THREE.Vector3(168, 0, 200), new THREE.Vector3(206, 0, 196),
    ];
    for (let i = 0; i < 4; i++) {
      const e = spawn('warden', posts[i]);
      if (e && posts[i]) e.home = new THREE.Vector3(posts[i].x, groundY(posts[i].x, posts[i].z), posts[i].z);
    }
    spawnHaloWing(SPIRE.x, SPIRE.z, 2, 2);
    spawn('drifter', ringPoint(SPIRE.x, SPIRE.z, 20, 55));
    const cs = P.colossusSpawn || new THREE.Vector3(200, 0, 210);
    spawn('colossus', cs);
  }

  /* ================= respawn (wild population upkeep) ================= */

  const WILD_TARGET = { drifter: 6, skitter: 8, strider: 4, halo: 5 };
  const pending = [];   // { type, t, n }
  let auditT = 0;

  function wildCount(type) {
    let n = 0;
    for (const e of S.machines) {
      if (e.type === type && e.faction === 'hostile' && !e.dying) n++;
    }
    return n;
  }
  function pendingCount(type) {
    let n = 0;
    for (const p of pending) if (p.type === type) n += p.n;
    return n;
  }

  function respawnAudit() {
    for (const type of Object.keys(WILD_TARGET)) {
      let deficit = WILD_TARGET[type] - wildCount(type) - pendingCount(type);
      while (deficit > 0) {
        const n = type === 'skitter' ? Math.min(2, deficit) : 1;
        pending.push({ type, t: rngRange(60, 120), n });
        deficit -= n;
      }
    }
  }

  function wildSpawnPoint(type) {
    const pp = G.player?.pos;
    for (let att = 0; att < 12; att++) {
      let p;
      if (type === 'strider') p = ringPoint(DRYSEA.x, DRYSEA.z, 20, 110);
      else if (type === 'halo') { const a = rngPick([DRYSEA, SPIRE]); p = ringPoint(a.x, a.z, 15, 80); }
      else if (type === 'skitter') {
        const nodes = G.world?.nodes || [];
        const n = nodes.length ? rngPick(nodes) : null;
        p = n?.pos ? { x: n.pos.x, z: n.pos.z } : ringPoint(CRASH.x, CRASH.z, 30, 90);
      } else { const a = rngPick([CRASH, DRYSEA]); p = ringPoint(a.x, a.z, 25, 100); }
      if (!pp || dist2d(p.x, p.z, pp.x, pp.z) > 80) return p;
    }
    return null;
  }

  function fireRespawn(p) {
    if (S.machines.length + p.n > 35) { p.t = 15; return false; }
    const at = wildSpawnPoint(p.type);
    if (!at) { p.t = 12; return false; }
    if (p.type === 'skitter') spawnSkitterPair(at.x, at.z);
    else if (p.type === 'halo') {
      // rejoin the smallest live wing, or start a new one
      const sizes = new Map();
      for (const e of S.machines) if (e.type === 'halo' && !e.dying && e.faction === 'hostile' && e.wing != null)
        sizes.set(e.wing, (sizes.get(e.wing) || 0) + 1);
      let wingId = null, best = Infinity;
      for (const [w, n] of sizes) if (n < 3 && n < best) { best = n; wingId = w; }
      if (wingId == null) wingId = wingSeq++;
      const e = spawn('halo', at);
      if (e) e.wing = wingId;
    } else spawn(p.type, at);
    return true;
  }

  /* ================= colossus plate break / debris ================= */

  const debris = [];   // { mesh, vel, rot, life, maxLife }
  const debrisGeo = new THREE.IcosahedronGeometry(1, 0);

  function burst(wx, wy, wz, n, size, mat) {
    for (let i = 0; i < n && debris.length < 90; i++) {
      const m = new THREE.Mesh(debrisGeo, mat);
      m.castShadow = false;
      const s = size * (0.5 + Math.random());
      m.scale.setScalar(s);
      m.position.set(wx + (Math.random() - 0.5) * size * 3, wy + (Math.random() - 0.5) * size * 2, wz + (Math.random() - 0.5) * size * 3);
      scene.add(m);
      debris.push({
        mesh: m,
        vel: new THREE.Vector3((Math.random() - 0.5) * 8, 4 + Math.random() * 7, (Math.random() - 0.5) * 8),
        rot: (Math.random() - 0.5) * 9,
        life: 1.3, maxLife: 1.3,
      });
    }
  }

  function updateDebris(dt) {
    for (let i = debris.length - 1; i >= 0; i--) {
      const d = debris[i];
      d.life -= dt;
      if (d.life <= 0) { scene.remove(d.mesh); debris.splice(i, 1); continue; }
      d.vel.y -= 22 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      d.mesh.rotation.x += d.rot * dt;
      d.mesh.rotation.z += d.rot * 0.7 * dt;
      const k = d.life / d.maxLife;
      d.mesh.scale.setScalar(Math.max(0.01, d.mesh.scale.x * (0.985)));
      d.mesh.material.opacity = k;
    }
  }

  function breakPlate(i) {
    const e = colossusRef;
    if (!e || i == null) return;
    const p = e.plates?.[i];
    if (!p || p.shattered) return;
    p.broken = true;
    p.shattered = true;
    p.hp = 0;
    p.mesh.getWorldPosition(_v1);
    p.mesh.visible = false;
    const ci = colliders.indexOf(p.mesh);
    if (ci >= 0) colliders.splice(ci, 1);
    burst(_v1.x, _v1.y, _v1.z, 12, 0.35, MAT.fragment);
    const core = e.cores?.[i];
    if (core) {
      core.mesh.visible = true;
      if (!colliders.includes(core.mesh)) colliders.push(core.mesh);
      e.coreIdx = i;
    }
    bus.emit('sfx', { name: 'slam' });
    bus.emit('shake', { i: 0.5 });
  }

  /* ================= per-type animation ================= */

  function localVel(e) {
    _fwd.set(-Math.sin(e.yaw), 0, -Math.cos(e.yaw));
    _right.set(Math.cos(e.yaw), 0, -Math.sin(e.yaw));
    return { f: e.vel.dot(_fwd), r: e.vel.dot(_right) };
  }

  function animDrifter(e, dt, spd, t) {
    const P = e.parts, a = e.anim;
    P.rotor.rotation.y += dt * (e.state === 'DISABLED' ? 1.5 : 24 + spd * 1.6);
    const bob = (1 - a.slump) * Math.sin(t * 2.1 + a.phase) * 0.12;
    P.body.position.y = bob - a.slump * 0.14;
    const lv = localVel(e);
    a.tiltX = damp(a.tiltX, clamp(-lv.f * 0.05, -0.35, 0.35) + a.slump * 0.45, 6, dt);
    a.tiltZ = damp(a.tiltZ, clamp(lv.r * 0.05, -0.3, 0.3), 6, dt);
    P.body.rotation.x = a.tiltX;
    P.body.rotation.z = a.tiltZ;
  }

  function animSkitter(e, dt, spd, t) {
    const P = e.parts, a = e.anim;
    const amt = clamp(spd / e.cfg.speed, 0, 1.25);
    a.gait += dt * (spd * 2.4 + 0.35);
    const sl = a.slump;
    for (const leg of P.legs) {
      const s = Math.sin(a.gait + leg.phase);
      const lift = Math.max(0, s) * 0.32 * amt;
      leg.hip.rotation.z = leg.baseZ + lift * (1 - sl) - sl * 0.45;
      leg.hip.rotation.y = leg.baseY + Math.cos(a.gait + leg.phase) * 0.22 * amt * (1 - sl);
      leg.knee.rotation.z = leg.kneeZ - lift * 0.55 - sl * 0.35;
    }
    P.body.position.y = P.bodyBaseY + Math.abs(Math.sin(a.gait)) * 0.035 * amt - sl * 0.26;
    P.body.rotation.z = Math.sin(a.gait) * 0.03 * amt + sl * 0.12;
    for (const c of P.claws) {
      c.arm.rotation.x = 0.45 + Math.sin(t * 1.8 + c.phase) * 0.14 * (1 - sl) + sl * 0.6;
      c.pincer.rotation.y = Math.sin(t * 2.6 + c.phase) * 0.25 * (1 - sl);
    }
  }

  function animStrider(e, dt, spd, t) {
    const P = e.parts, a = e.anim;
    const amt = clamp(spd / e.cfg.speed, 0, 1.35);
    a.gait += dt * (spd * 1.35 + 0.4);
    const sl = a.slump;
    for (const leg of P.legs) {
      const s = Math.sin(a.gait + leg.phase);
      leg.hip.rotation.x = leg.hipX + s * 0.5 * amt * (1 - sl) + sl * 0.5;
      leg.knee.rotation.x = leg.kneeX + Math.max(0, -s) * 0.6 * amt * (1 - sl) - sl * 0.75;
      leg.ankle.rotation.x = leg.ankleX - s * 0.28 * amt * (1 - sl) + sl * 0.3;
    }
    P.body.position.y = P.bodyBaseY + Math.abs(Math.sin(a.gait)) * 0.06 * amt - sl * 0.6;
    P.body.rotation.z = Math.sin(a.gait) * 0.025 * amt + sl * 0.14;
    P.body.rotation.x = sl * 0.1;
    // head scan when calm, locked forward when hunting; jaw snaps in ATTACK
    const hunting = e.state === 'ATTACK' || e.state === 'FLANK';
    P.head.rotation.y = damp(P.head.rotation.y, hunting ? 0 : Math.sin(t * 0.7 + a.phase) * 0.3, 4, dt);
    a.jawT = damp(a.jawT, e.state === 'ATTACK' ? 0.4 + Math.sin(t * 9) * 0.22 : 0.05, 8, dt);
    P.jaw.rotation.x = a.jawT;
    P.tail.rotation.x = -0.85 + Math.sin(t * 2 + a.gait) * 0.1;
    P.tail.rotation.z = Math.sin(t * 1.3 + a.phase) * 0.15;
  }

  function animWarden(e, dt, spd, t) {
    const P = e.parts, a = e.anim;
    const amt = clamp(spd / e.cfg.speed, 0, 1.15);
    a.gait += dt * (spd * 0.95 + 0.12);
    const sl = a.slump;
    for (const leg of P.legs) {
      const s = Math.sin(a.gait + leg.phase);
      leg.hip.rotation.x = s * 0.48 * amt * (1 - sl) + sl * 0.35;
      leg.knee.rotation.x = Math.max(0, -s) * 0.45 * amt * (1 - sl) - sl * 0.55;
      // stomp feedback on foot plant
      const planted = s < -0.85;
      if (planted && !leg.planted && amt > 0.25) {
        leg.planted = true;
        const pp = G.player?.pos;
        if (pp) {
          const d = pp.distanceTo(e.pos);
          if (d < 32) { bus.emit('sfx', { name: 'stomp' }); bus.emit('shake', { i: clamp(0.14 * (1 - d / 32), 0.02, 0.14) }); }
        }
      } else if (!planted) leg.planted = false;
    }
    P.body.position.y = P.bodyBaseY + Math.abs(Math.cos(a.gait)) * 0.09 * amt - sl * 0.5;
    P.body.rotation.z = Math.sin(a.gait) * 0.05 * amt + sl * 0.16;
    a.armT = damp(a.armT, e.state === 'ATTACK' ? -0.95 : 0.12, 5, dt);
    for (let i = 0; i < P.arms.length; i++) {
      const arm = P.arms[i];
      arm.shoulder.rotation.x = a.armT - Math.sin(a.gait + (i === 0 ? 0 : Math.PI)) * 0.28 * amt * (1 - sl);
    }
    P.head.rotation.y = Math.sin(t * 0.5 + a.phase) * 0.35 * (1 - amt);
  }

  function animHalo(e, dt, spd, t) {
    const P = e.parts, a = e.anim;
    // bank from yaw rate (ai steers via vel/yaw; we tilt)
    let dy = e.yaw - a.prevYaw;
    dy = ((dy + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    a.prevYaw = e.yaw;
    const yawRate = dt > 0 ? dy / dt : 0;
    a.bank = damp(a.bank, clamp(yawRate * 0.5, -0.85, 0.85) * (1 - a.slump), 4.5, dt);
    P.body.rotation.z = a.bank + a.slump * 0.35;
    const diveP = e.state === 'DIVE' ? -0.55 : e.state === 'PULL_UP' ? 0.4 : 0;
    a.tiltX = damp(a.tiltX, clamp(e.vel.y * -0.04, -0.4, 0.4) + diveP + a.slump * 0.18, 4, dt);
    P.body.rotation.x = a.tiltX;
    P.body.position.y = (1 - a.slump) * Math.sin(t * 1.6 + a.phase) * 0.16 - a.slump * 0.1;
    // exhaust flicker + wingtip strobe blink share pulseMat (per-frame cosmetic jitter OK)
    const blink = ((t + a.phase) % 1.1) < 0.09;
    P.pulseMat.emissiveIntensity = e.state === 'DISABLED'
      ? 0.4 + Math.sin(t * 5) * 0.25
      : (blink ? 5 : 1.7 + spd * 0.1 + Math.random() * 0.55);
  }

  function animColossus(e, dt, spd, t) {
    const P = e.parts, a = e.anim;
    const amt = clamp(spd / e.cfg.speed, 0, 1);
    a.gait += dt * (spd * 0.5 + 0.03);
    for (const leg of P.legs) {
      const s = Math.sin(a.gait + leg.phase);
      leg.hip.rotation.x = s * 0.2 * amt;
      leg.knee.rotation.x = Math.max(0, -s) * 0.26 * amt;
      const planted = s < -0.9;
      if (planted && !leg.planted && amt > 0.15) {
        leg.planted = true;
        const pp = G.player?.pos;
        if (pp) {
          const d = pp.distanceTo(e.pos);
          if (d < 85) { bus.emit('sfx', { name: 'stomp' }); bus.emit('shake', { i: clamp(0.45 * (1 - d / 85), 0.04, 0.45) }); }
        }
      } else if (!planted) leg.planted = false;
    }
    P.body.position.y = Math.sin(a.gait * 2) * 0.14 * amt;
    P.body.rotation.z = Math.sin(a.gait) * 0.02 * amt;
    P.body.rotation.x = Math.cos(a.gait) * 0.012 * amt;
    P.head.rotation.y = Math.sin(t * 0.3 + a.phase) * 0.3;
    // plate shimmer + exposed core pulse
    for (const p of e.plates) {
      if (!p.broken) p.mat.emissiveIntensity = 1.8 + Math.sin(t * 2.5 + p.hp * 0.05) * 0.4 + (1 - p.hp / p.hpMax) * 1.2;
    }
    for (let i = 0; i < e.cores.length; i++) {
      const c = e.cores[i];
      if (!c.mesh.visible || c.done) continue;
      c.mat.emissiveIntensity = e.hackWindow > 0 && e.coreIdx === i
        ? 3.6 + Math.sin(t * 10) * 1.9
        : 2.6 + Math.sin(t * 4 + i) * 0.8;
    }
  }

  const ANIMS = {
    drifter: animDrifter, skitter: animSkitter, strider: animStrider,
    warden: animWarden, halo: animHalo, colossus: animColossus,
  };

  /* ================= dying + removal ================= */

  function updateDying(e, dt) {
    const a = e.anim;
    if (!a.dyingInit) {
      a.dyingInit = true;
      e.state = 'DYING';
      bus.emit('sfx', { name: 'death' });
      const big = e.type === 'warden' ? 0.35 : e.type === 'colossus' ? 0.8 : 0.15;
      const pp = G.player?.pos;
      if (pp && pp.distanceTo(e.pos) < 70) bus.emit('shake', { i: big });
      burst(e.pos.x, e.pos.y + 0.8, e.pos.z, e.type === 'colossus' ? 20 : 6, e.type === 'colossus' ? 0.5 : 0.14, MAT.fragment);
      a.fallDir = Math.random() * Math.PI * 2;
    }
    e.deadT += dt;
    // spark strobe on all emissives
    a.strobeAcc -= dt;
    if (a.strobeAcc <= 0) {
      a.strobeAcc = 0.05 + Math.random() * 0.1;
      a.strobeOn = !a.strobeOn;
    }
    const inten = a.strobeOn ? 4.5 : 0.15;
    for (const m of e.parts.emissiveMats) m.emissiveIntensity = inten;
    if (e.plates) for (const p of e.plates) p.mat.emissiveIntensity = inten * 0.5;
    // collapse: flyers drop fast, walkers sink + keel over
    const gy = groundY(e.pos.x, e.pos.z);
    if (e.flying && e.pos.y > gy + 0.4) {
      e.pos.y = Math.max(gy + 0.3, e.pos.y - dt * 14);
      e.group.rotation.z += dt * 1.6;
    } else if (e.deadT > 0.6) {
      const sink = e.type === 'colossus' ? 1.6 : 0.5;
      e.pos.y -= dt * sink;
      e.group.rotation.x = damp(e.group.rotation.x, Math.cos(a.fallDir) * 0.4, 1.6, dt);
      e.group.rotation.z = damp(e.group.rotation.z, Math.sin(a.fallDir) * 0.4, 1.6, dt);
      if (e.parts.body) e.parts.body.scale.y = damp(e.parts.body.scale.y, 0.72, 1.5, dt);
    }
    if (e.deadT >= 2.5) remove(e);
  }

  function arrRemove(arr, item) {
    const i = arr.indexOf(item);
    if (i >= 0) arr.splice(i, 1);
  }

  function remove(e) {
    if (!e || e._removed) return;
    e._removed = true;
    scene.remove(e.group);
    arrRemove(S.machines, e);
    arrRemove(S.captured, e);
    for (let i = colliders.length - 1; i >= 0; i--) {
      if (colliders[i].userData.entity === e) colliders.splice(i, 1);
    }
    // dispose only per-entity cloned materials; geometry + body mats are shared
    for (const m of e.parts.emissiveMats) m.dispose?.();
    if (e.plates) for (const p of e.plates) p.mat?.dispose?.();
    if (e.cores) for (const c of e.cores) c.mat?.dispose?.();
    if (e === colossusRef) colossusRef = null;
  }

  /* ================= update ================= */

  function update(dt) {
    const t = S.time;
    const pp = G.player?.pos;

    for (let i = S.machines.length - 1; i >= 0; i--) {
      const e = S.machines[i];
      if (!e.anim) continue;
      if (e.dying) { updateDying(e, dt); continue; }

      // faction re-check (self-heals even if applyFaction wasn't called on a transition)
      const fk = e.state === 'DISABLED' ? 'dis' : e.faction;
      if (e.anim.facKey !== fk) applyFaction(e);

      // emissive pulse by faction/state (DISABLED pulses 0.3..1.5)
      const mats = e.parts.emissiveMats;
      let base;
      if (e.state === 'DISABLED') base = 0.9 + 0.6 * Math.sin(t * 5 + e.anim.phase);
      else if (e.state === 'ALARM') base = ((t * 7 + e.anim.phase) % 1) < 0.5 ? 4.2 : 0.6;
      else if (e.faction === 'captured') base = 1.7 + 0.25 * Math.sin(t * 2.2 + e.anim.phase);
      else base = 2.1 + 0.3 * Math.sin(t * 3 + e.anim.phase);
      for (let k = 0; k < mats.length; k++) mats[k].emissiveIntensity = base;
      if (e.parts.lights) for (const l of e.parts.lights) l.intensity = base * (e.type === 'colossus' ? 2.2 : 1.1);

      // observed speed (covers ai-driven vel AND mounted/piloted movement)
      _v1.copy(e.pos).sub(e.anim.lastPos);
      const obs = dt > 0 ? Math.min(_v1.length() / dt, 40) : 0;
      e.anim.lastPos.copy(e.pos);
      const spd = Math.max(e.vel.length(), obs);

      e.group.rotation.y = e.yaw;
      e.group.rotation.x = damp(e.group.rotation.x, 0, 5, dt);
      e.group.rotation.z = damp(e.group.rotation.z, 0, 5, dt);

      // disabled slump + defensive ground-drop for flyers
      e.anim.slump = damp(e.anim.slump, e.state === 'DISABLED' ? 1 : 0, 4, dt);
      if (e.state === 'DISABLED' && e.flying) {
        const gy = groundY(e.pos.x, e.pos.z);
        if (e.pos.y > gy + 0.4) e.pos.y = damp(e.pos.y, gy + 0.35, 2.5, dt);
      }

      // full articulation only near the player; distant machines keep pose
      if (!pp || pp.distanceTo(e.pos) < 160) ANIMS[e.type]?.(e, dt, spd, t);
    }

    updateDebris(dt);

    // respawn upkeep
    auditT += dt;
    if (auditT >= 3) { auditT = 0; respawnAudit(); }
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      p.t -= dt;
      if (p.t <= 0 && fireRespawn(p)) pending.splice(i, 1);
    }
  }

  /* ================= bus wiring (defensive: never throw) ================= */

  bus.on('machine:disabled', (p) => { try { if (p?.e) applyFaction(p.e); } catch (_) {} });
  bus.on('machine:rebooted', (p) => { try { if (p?.e) applyFaction(p.e); } catch (_) {} });
  bus.on('machine:captured', (p) => { try { if (p?.e) applyFaction(p.e); } catch (_) {} });
  bus.on('hack:success', (p) => { try { if (p?.e) applyFaction(p.e); } catch (_) {} });
  bus.on('colossus:plate', (p) => { try { breakPlate(p?.i); } catch (_) {} });
  bus.on('colossus:core', () => {
    try {
      const e = colossusRef;
      if (!e || e.coreIdx == null) return;
      const c = e.cores?.[e.coreIdx];
      if (c) c.mesh.getWorldPosition(_v1), burst(_v1.x, _v1.y, _v1.z, 6, 0.2, MAT.fragment);
      bus.emit('shake', { i: 0.3 });
    } catch (_) {}
  });
  bus.on('colossus:hacked', () => {
    try {
      const e = colossusRef;
      if (!e || e.coreIdx == null) return;
      const c = e.cores?.[e.coreIdx];
      if (c) {
        c.done = true;
        c.mat.emissive.setHex(COL_CAPTURED);
        c.mat.emissiveIntensity = 2.2;
      }
    } catch (_) {}
  });

  return { TYPES, spawn, populate, update, remove, colliders, applyFaction };
}
