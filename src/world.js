// SIGNAL DECAY — world: terrain, two-sun sky + day/night, fog, scatter, props, nodes, spire gate,
// arena, collisions. See CONTRACT.md §4-world. Owns S.zone / S.night. Emits 'zone:enter', 'core:pickup'.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  bus, S, rng, rngRange, rngInt, rngPick, noise2, fbm2,
  clamp, lerp, dist2d, makeCanvasTexture, makeNoiseNormalMap,
} from './core.js';

/* module-scope scratch (no per-frame allocs) */
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
const ZEROM = new THREE.Matrix4().makeScale(0, 0, 0);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function initWorld(G) {
  const scene = G.engine.scene;
  const camera = G.engine.camera;

  /* ============================== LAYOUT CONSTANTS ============================== */
  const SIZE = 600, HALF = 300, SEG = 256, STEP = SIZE / SEG, GRID = SEG + 1;
  const CRASH_X = -150, CRASH_Z = -150;          // crashfield center
  const SPIRE_X = 180, SPIRE_Z = 180;            // relay spire center
  const ARENA_X = 200, ARENA_Z = 210;            // colossus arena
  const GATE_R = 142;                            // spire barrier radius (collision shell)
  const WRECK_YAW = 2.45;                        // hull axis yaw
  const WAX = Math.cos(WRECK_YAW), WAZ = Math.sin(WRECK_YAW);

  /* ============================== BIOME MASKS ============================== */
  function crashWf(x, z) {
    const d = dist2d(x, z, CRASH_X, CRASH_Z);
    const wr = clamp01((195 - d) / 75);
    const wd = clamp01(((-x - z) * 0.5 - 120) / 70); // SW diagonal lobe
    return Math.max(wr, wd);
  }
  function spireWf(x, z) {
    const d = dist2d(x, z, SPIRE_X, SPIRE_Z);
    const wr = clamp01((175 - d) / 75);
    const wd = clamp01(((x + z) * 0.5 - 175) / 55); // NE diagonal lobe
    return Math.max(wr, wd);
  }

  function terrace(h, step) {
    const k = h / step, fk = Math.floor(k), f = k - fk;
    const s = f * f * (3 - 2 * f);
    return (fk + s * 0.8 + f * 0.2) * step;
  }

  function segDist2d(px, pz, ax, az, bx, bz) {
    const dx = bx - ax, dz = bz - az;
    const L2 = dx * dx + dz * dz;
    let t = L2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / L2 : 0;
    t = clamp01(t);
    return dist2d(px, pz, ax + dx * t, az + dz * t);
  }

  /* ============================== HEIGHT FUNCTION ============================== */
  function heightFn(x, z) {
    const wC = crashWf(x, z), wS = spireWf(x, z);
    const wD = clamp01(1 - wC - wS);
    const wSum = wC + wS + wD || 1;

    // crashfield: gentle rolling, scorch-flattened near wreck
    let hC = fbm2(x * 0.0085 + 3.1, z * 0.0085 - 7.4, 4) * 7.5
           + fbm2(x * 0.035, z * 0.035, 2) * 0.9;
    const dw = dist2d(x, z, CRASH_X, CRASH_Z);
    const flat = clamp01((50 - dw) / 32);
    hC = lerp(hC, -0.4 + fbm2(x * 0.05, z * 0.05, 2) * 0.35, flat * 0.9);

    // dry sea: near-flat with dried directional wave-ripple crests
    const warp = noise2(x * 0.018, z * 0.018) * 2.6;
    const rip = Math.sin((x * 0.42 - z * 0.31) * 0.55 + warp);
    const crest = Math.pow(Math.max(rip, 0), 3);
    const hD = fbm2(x * 0.006 - 11, z * 0.006 + 5, 3) * 1.8 + crest * 0.85 + 0.2;

    // spire: broken / terraced steps, flattened at the arena + tower pedestal
    let hS = fbm2(x * 0.011 - 8, z * 0.011 + 14, 4) * 15 + 5;
    hS = terrace(hS, 2.6);
    const dA = dist2d(x, z, ARENA_X, ARENA_Z);
    hS = lerp(hS, 5.5, clamp01((36 - dA) / 16) * 0.92);
    const dT = dist2d(x, z, SPIRE_X, SPIRE_Z);
    hS = lerp(hS, 8, clamp01((24 - dT) / 12) * 0.8);

    return (wC * hC + wD * hD + wS * hS) / wSum;
  }

  /* heightfield grid — the ONE source of truth for mesh + sampler */
  const H = new Float32Array(GRID * GRID);
  for (let iz = 0; iz < GRID; iz++) {
    const z = -HALF + iz * STEP;
    for (let ix = 0; ix < GRID; ix++) {
      H[iz * GRID + ix] = heightFn(-HALF + ix * STEP, z);
    }
  }

  function getGroundHeight(x, z) {
    const fx = clamp((x + HALF) / STEP, 0, SEG - 1e-4);
    const fz = clamp((z + HALF) / STEP, 0, SEG - 1e-4);
    const ix = fx | 0, iz = fz | 0, tx = fx - ix, tz = fz - iz;
    const i = iz * GRID + ix;
    const a = H[i], b = H[i + 1], c = H[i + GRID], d = H[i + GRID + 1];
    return a + (b - a) * tx + (c - a) * tz + (a - b - c + d) * tx * tz;
  }

  /* ============================== PROCEDURAL TEXTURES ============================== */
  // near-white soil detail (multiplies vertex colors)
  const groundDetail = makeCanvasTexture(256, (ctx, s) => {
    ctx.fillStyle = '#d8d2de'; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 2400; i++) {
      const g = 190 + Math.floor(rng() * 60);
      ctx.fillStyle = `rgba(${g},${g - 6},${g + 8},${0.25 + rng() * 0.4})`;
      ctx.fillRect(rng() * s, rng() * s, 1 + rng() * 2.5, 1 + rng() * 2.5);
    }
    for (let i = 0; i < 60; i++) { // faint blotches
      const r = 8 + rng() * 26;
      const gr = ctx.createRadialGradient(rng() * s, rng() * s, 0, rng() * s, rng() * s, r);
      gr.addColorStop(0, 'rgba(120,105,140,0.10)'); gr.addColorStop(1, 'rgba(120,105,140,0)');
      ctx.fillStyle = gr; ctx.fillRect(0, 0, s, s);
    }
    ctx.strokeStyle = 'rgba(90,80,110,0.22)'; ctx.lineWidth = 1;
    for (let i = 0; i < 26; i++) { // hairline cracks
      ctx.beginPath();
      let x = rng() * s, y = rng() * s; ctx.moveTo(x, y);
      for (let k = 0; k < 5; k++) { x += (rng() - 0.5) * 30; y += (rng() - 0.5) * 30; ctx.lineTo(x, y); }
      ctx.stroke();
    }
  });
  groundDetail.repeat.set(64, 64);
  const groundNormal = makeNoiseNormalMap(256, 12, 1.6);
  groundNormal.repeat.set(64, 64);

  // brushed metal w/ wear + panel seams
  const metalTex = makeCanvasTexture(256, (ctx, s) => {
    ctx.fillStyle = '#a7abb9'; ctx.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y++) { // horizontal brushing
      const g = 150 + Math.floor(noise2(3.3, y * 0.35) * 40 + rng() * 18);
      ctx.fillStyle = `rgba(${g},${g + 3},${g + 12},0.35)`;
      ctx.fillRect(0, y, s, 1);
    }
    ctx.strokeStyle = 'rgba(40,42,58,0.55)'; ctx.lineWidth = 2;
    for (let i = 0; i < 5; i++) { // panel seams
      const p = rng() * s;
      ctx.beginPath(); ctx.moveTo(p, 0); ctx.lineTo(p, s); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, rng() * s); ctx.lineTo(s, rng() * s); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(30,32,44,0.8)';
    for (let i = 0; i < 46; i++) { // rivets
      ctx.beginPath(); ctx.arc(rng() * s, rng() * s, 1.6, 0, 7); ctx.fill();
    }
    for (let i = 0; i < 18; i++) { // grey-violet scorch wear (no browns)
      const r = 6 + rng() * 22;
      const gr = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      gr.addColorStop(0, 'rgba(52,44,66,0.5)'); gr.addColorStop(1, 'rgba(52,44,66,0)');
      ctx.save(); ctx.translate(rng() * s, rng() * s); ctx.fillStyle = gr;
      ctx.fillRect(-r, -r, r * 2, r * 2); ctx.restore();
    }
  });
  const metalNormal = makeNoiseNormalMap(128, 22, 0.6);

  // bone-white strata rock for mineral spires
  const rockTex = makeCanvasTexture(256, (ctx, s) => {
    ctx.fillStyle = '#d9d3da'; ctx.fillRect(0, 0, s, s);
    for (let y = 0; y < s; y += 2) { // wavy strata bands
      const g = 200 + Math.floor(noise2(1.7, y * 0.12) * 26);
      ctx.fillStyle = `rgba(${g},${g - 4},${g + 2},0.5)`;
      ctx.fillRect(0, y, s, 2);
    }
    for (let i = 0; i < 1400; i++) {
      const g = 175 + Math.floor(rng() * 70);
      ctx.fillStyle = `rgba(${g},${g - 8},${g},${0.2 + rng() * 0.3})`;
      ctx.fillRect(rng() * s, rng() * s, 1 + rng() * 2, 1 + rng() * 2);
    }
    ctx.strokeStyle = 'rgba(140,128,150,0.35)'; ctx.lineWidth = 1;
    for (let i = 0; i < 20; i++) {
      ctx.beginPath();
      let x = rng() * s, y = 0; ctx.moveTo(x, y);
      while (y < s) { x += (rng() - 0.5) * 14; y += 10 + rng() * 22; ctx.lineTo(x, y); }
      ctx.stroke();
    }
  });
  const rockNormal = makeNoiseNormalMap(128, 14, 1.1);

  // scrolling hex energy grid for the gate
  const hexTex = makeCanvasTexture(256, (ctx, s) => {
    ctx.clearRect(0, 0, s, s);
    const R = 18, h = R * Math.sin(Math.PI / 3);
    ctx.lineWidth = 2; ctx.shadowBlur = 8;
    for (let row = -1; row < s / h + 2; row++) {
      for (let col = -1; col < s / (R * 1.5) + 2; col++) {
        const cx = col * R * 1.5, cy = row * h * 2 + (col % 2 ? h : 0);
        const violet = (row + col) % 3 !== 0;
        ctx.strokeStyle = violet ? 'rgba(196,110,255,0.85)' : 'rgba(255,80,110,0.9)';
        ctx.shadowColor = violet ? '#b47aff' : '#ff4d6a';
        ctx.beginPath();
        for (let k = 0; k <= 6; k++) {
          const a = (k / 6) * Math.PI * 2;
          const px = cx + Math.cos(a) * R * 0.92, py = cy + Math.sin(a) * R * 0.92;
          k === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }
  }, { srgb: true, repeat: true });

  // soft radial glow (suns, core pickups, spire tip)
  const glowTex = makeCanvasTexture(128, (ctx, s) => {
    const gr = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.22, 'rgba(255,255,255,0.85)');
    gr.addColorStop(0.55, 'rgba(255,255,255,0.22)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, s, s);
  }, { repeat: false });

  // hard-cored sun disc
  const sunTex = makeCanvasTexture(128, (ctx, s) => {
    const gr = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)');
    gr.addColorStop(0.18, 'rgba(255,255,255,1)');
    gr.addColorStop(0.26, 'rgba(255,255,255,0.5)');
    gr.addColorStop(0.6, 'rgba(255,255,255,0.12)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, s, s);
  }, { repeat: false });

  // soft smoke puff
  const smokeTex = makeCanvasTexture(128, (ctx, s) => {
    const gr = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(96,86,116,0.55)');
    gr.addColorStop(0.5, 'rgba(72,64,92,0.3)');
    gr.addColorStop(1, 'rgba(60,54,80,0)');
    ctx.fillStyle = gr; ctx.fillRect(0, 0, s, s);
  }, { repeat: false });

  /* ============================== TERRAIN MESH ============================== */
  const terrainGeo = new THREE.PlaneGeometry(SIZE, SIZE, SEG, SEG);
  terrainGeo.rotateX(-Math.PI / 2);
  {
    const posA = terrainGeo.attributes.position;
    for (let i = 0; i < posA.count; i++) {
      const x = posA.getX(i), z = posA.getZ(i);
      const ix = Math.round((x + HALF) / STEP), iz = Math.round((z + HALF) / STEP);
      posA.setY(i, H[iz * GRID + ix]);
    }
    posA.needsUpdate = true;
    terrainGeo.computeVertexNormals();
  }

  /* vertex colors: violet soil / scorch / salt veins / spire cooling */
  {
    const posA = terrainGeo.attributes.position;
    const colors = new Float32Array(posA.count * 3);
    const cBase = new THREE.Color(0x6b5a86);   // desaturated violet soil
    const cLight = new THREE.Color(0x84709c);
    const cDark = new THREE.Color(0x4e4168);
    const cScorch = new THREE.Color(0x231d2c); // charred near wreck
    const cSalt = new THREE.Color(0xe9e4ef);   // dry-sea salt veins
    const cSpire = new THREE.Color(0x4c4880);  // cooler violet near spire
    const cCrest = new THREE.Color(0x9a87ae);  // pale ripple crests
    for (let i = 0; i < posA.count; i++) {
      const x = posA.getX(i), z = posA.getZ(i), y = posA.getY(i);
      const wC = crashWf(x, z), wS = spireWf(x, z);
      const wD = clamp01(1 - wC - wS);
      // base variation
      const v = fbm2(x * 0.02 + 9, z * 0.02 - 4, 3);
      _c1.copy(cBase);
      if (v > 0) _c1.lerp(cLight, v * 0.85); else _c1.lerp(cDark, -v * 0.9);
      // crest highlight in dry sea (height-driven)
      if (wD > 0.15 && y > 0.75) _c1.lerp(cCrest, clamp01((y - 0.75) / 0.9) * wD * 0.5);
      // salt veins: ridged-noise threshold, dry sea only
      const rid = 1 - Math.abs(fbm2(x * 0.045 + 21, z * 0.045 + 13, 4));
      if (rid > 0.78) _c1.lerp(cSalt, clamp01((rid - 0.78) / 0.22) * wD * 0.95);
      // cooler violet toward the spire
      if (wS > 0) _c1.lerp(cSpire, wS * 0.62);
      // scorch: radial burn + trench gouge behind the wreck
      const dw = dist2d(x, z, CRASH_X, CRASH_Z);
      let sc = clamp01((46 - dw) / 28);
      const tD = segDist2d(x, z, CRASH_X, CRASH_Z, CRASH_X - WAX * 58, CRASH_Z - WAZ * 58);
      sc = Math.max(sc, clamp01((9 - tD) / 7) * 0.92);
      if (sc > 0) _c1.lerp(cScorch, sc * (0.65 + 0.3 * clamp01(fbm2(x * 0.09, z * 0.09, 3) + 0.5)));
      colors[i * 3] = _c1.r; colors[i * 3 + 1] = _c1.g; colors[i * 3 + 2] = _c1.b;
    }
    terrainGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }

  const terrainMat = new THREE.MeshStandardMaterial({
    map: groundDetail, normalMap: groundNormal, normalScale: new THREE.Vector2(0.7, 0.7),
    vertexColors: true, roughness: 0.94, metalness: 0.02,
  });
  const terrain = new THREE.Mesh(terrainGeo, terrainMat);
  terrain.receiveShadow = true;
  scene.add(terrain);

  /* ============================== LANDMARK POSITIONS ============================== */
  const gph = getGroundHeight;
  const positions = {
    playerSpawn:    new THREE.Vector3(-137, gph(-137, -138), -138),
    wreck:          new THREE.Vector3(CRASH_X, gph(CRASH_X, CRASH_Z), CRASH_Z),
    fabricator:     new THREE.Vector3(-141.5, gph(-141.5, -146), -146),
    shuttleConsole: new THREE.Vector3(-128, gph(-128, -166), -166),
    spireGate:      new THREE.Vector3(79.6, gph(79.6, 79.6), 79.6),
    arenaCenter:    new THREE.Vector3(ARENA_X, gph(ARENA_X, ARENA_Z), ARENA_Z),
    colossusSpawn:  new THREE.Vector3(203, gph(203, 222), 222),
    wardenPosts: [
      new THREE.Vector3(150, gph(150, 150), 150),
      new THREE.Vector3(210, gph(210, 140), 140),
      new THREE.Vector3(140, gph(140, 210), 210),
      new THREE.Vector3(225, gph(225, 215), 215),
    ],
    corePickups: [
      new THREE.Vector3(35, gph(35, -125), -125),
      new THREE.Vector3(-45, gph(-45, 60), 60),
    ],
  };

  /* ============================== SKY DOME + STARS + SUN DISCS ============================== */
  const skyGroup = new THREE.Group();
  scene.add(skyGroup);

  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      uNight:    { value: 0 },
      uTopDay:   { value: new THREE.Color(0x3b2a63) },
      uMidDay:   { value: new THREE.Color(0x8f5a8f) },
      uHorDay:   { value: new THREE.Color(0xff9a63) },
      uTopNight: { value: new THREE.Color(0x0c1230) },
      uMidNight: { value: new THREE.Color(0x24355c) },
      uHorNight: { value: new THREE.Color(0x1d4a58) },
      uSunDir:   { value: new THREE.Vector3(0, 1, 0) },
      uSun2Dir:  { value: new THREE.Vector3(0, 1, 0) },
    },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform float uNight;
      uniform vec3 uTopDay, uMidDay, uHorDay, uTopNight, uMidNight, uHorNight;
      uniform vec3 uSunDir, uSun2Dir;
      varying vec3 vDir;
      void main() {
        vec3 dir = normalize(vDir);
        float t = clamp(dir.y, 0.0, 1.0);
        vec3 hor = mix(uHorDay, uHorNight, uNight);
        vec3 mid = mix(uMidDay, uMidNight, uNight);
        vec3 top = mix(uTopDay, uTopNight, uNight);
        vec3 col = mix(hor, mid, smoothstep(0.0, 0.16, t));
        col = mix(col, top, smoothstep(0.10, 0.55, t));
        // amber sun halo (dies at night)
        float g = pow(max(dot(dir, uSunDir), 0.0), 9.0);
        col += vec3(1.0, 0.52, 0.2) * g * 0.65 * (1.0 - uNight);
        // teal sun halo (persists)
        float g2 = pow(max(dot(dir, uSun2Dir), 0.0), 26.0);
        col += vec3(0.35, 0.9, 0.95) * g2 * 0.4;
        // below-horizon falloff (never black)
        col *= 1.0 + min(dir.y, 0.0) * 0.75;
        gl_FragColor = vec4(col, 1.0);
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(700, 32, 16), skyMat);
  sky.frustumCulled = false;
  skyGroup.add(sky);

  // stars — fade in at night
  const starGeo = new THREE.BufferGeometry();
  {
    const n = 900, arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const a = rng() * Math.PI * 2, y = 0.04 + rng() * 0.96;
      const r = Math.sqrt(1 - y * y) * 680;
      arr[i * 3] = Math.cos(a) * r; arr[i * 3 + 1] = y * 680; arr[i * 3 + 2] = Math.sin(a) * r;
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(arr, 3));
  }
  const starMat = new THREE.PointsMaterial({
    size: 1.7, sizeAttenuation: false, color: 0xcfe4ff, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
  });
  const stars = new THREE.Points(starGeo, starMat);
  stars.frustumCulled = false;
  skyGroup.add(stars);

  // two visible sun discs
  const sunSpriteMat = new THREE.SpriteMaterial({
    map: sunTex, color: 0xffb066, blending: THREE.AdditiveBlending,
    depthWrite: false, transparent: true, fog: false,
  });
  const sunSprite = new THREE.Sprite(sunSpriteMat);
  sunSprite.scale.set(120, 120, 1);
  skyGroup.add(sunSprite);
  const sun2SpriteMat = new THREE.SpriteMaterial({
    map: sunTex, color: 0x8ff0ef, blending: THREE.AdditiveBlending,
    depthWrite: false, transparent: true, fog: false,
  });
  const sun2Sprite = new THREE.Sprite(sun2SpriteMat);
  sun2Sprite.scale.set(38, 38, 1);
  skyGroup.add(sun2Sprite);

  /* ============================== TWO SUNS + FILL LIGHTS ============================== */
  const sunLight = new THREE.DirectionalLight(0xffc07a, 2.6); // primary amber
  sunLight.castShadow = true;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.left = -45; sunLight.shadow.camera.right = 45;
  sunLight.shadow.camera.top = 45; sunLight.shadow.camera.bottom = -45;
  sunLight.shadow.camera.near = 5; sunLight.shadow.camera.far = 420;
  sunLight.shadow.bias = -0.0006;
  sunLight.shadow.normalBias = 0.35;
  scene.add(sunLight); scene.add(sunLight.target);

  const sun2Light = new THREE.DirectionalLight(0x7ae0e0, 0.85); // secondary teal-white
  sun2Light.castShadow = true;
  sun2Light.shadow.mapSize.set(1024, 1024);
  sun2Light.shadow.camera.left = -34; sun2Light.shadow.camera.right = 34;
  sun2Light.shadow.camera.top = 34; sun2Light.shadow.camera.bottom = -34;
  sun2Light.shadow.camera.near = 5; sun2Light.shadow.camera.far = 380;
  sun2Light.shadow.bias = -0.0008;
  sun2Light.shadow.normalBias = 0.5;
  scene.add(sun2Light); scene.add(sun2Light.target);

  const hemi = new THREE.HemisphereLight(0x8a5c9e, 0x40305c, 0.55);
  scene.add(hemi);
  const amb = new THREE.AmbientLight(0x2a2440, 0.22);
  scene.add(amb);

  /* day/night constant palettes (lerped per frame into live colors) */
  const C_SUN_HIGH = new THREE.Color(0xffc07a), C_SUN_LOW = new THREE.Color(0xff7038);
  const C_FOG_DAY = new THREE.Color(0x7d5a86), C_FOG_NIGHT = new THREE.Color(0x1c2a44);
  const C_FOG_SPIRE = new THREE.Color(0x3a3358);
  const C_HEMI_SKY_D = new THREE.Color(0x8a5c9e), C_HEMI_SKY_N = new THREE.Color(0x1d3a4e);
  const C_HEMI_GND_D = new THREE.Color(0x40305c), C_HEMI_GND_N = new THREE.Color(0x141a2c);

  /* fog: warm violet, denser + cooler toward the spire (animated per frame) */
  const fog = new THREE.FogExp2(0x7d5a86, 0.0035);
  scene.fog = fog;

  /* ============================== DRIFTING SPORES ============================== */
  const SPORE_N = G.gfxLow ? 400 : 1500, SPORE_BOX = 120, SPORE_HALF = 60;
  let sporeMult = 1;
  const sporeGeo = new THREE.TetrahedronGeometry(0.09, 0);
  const sporeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const spores = new THREE.InstancedMesh(sporeGeo, sporeMat, SPORE_N);
  spores.frustumCulled = false;
  spores.castShadow = false; spores.receiveShadow = false;
  const spX = new Float32Array(SPORE_N), spY = new Float32Array(SPORE_N), spZ = new Float32Array(SPORE_N);
  const spPh = new Float32Array(SPORE_N), spSc = new Float32Array(SPORE_N), spSp = new Float32Array(SPORE_N);
  for (let i = 0; i < SPORE_N; i++) {
    spX[i] = rng() * SPORE_BOX; spY[i] = rng() * 70; spZ[i] = rng() * SPORE_BOX;
    spPh[i] = rng() * Math.PI * 2;
    spSc[i] = 0.55 + rng() * 0.9;
    spSp[i] = 0.6 + rng() * 0.8;
    // HDR instance colors so spores catch bloom: violet / teal mix
    if (rng() < 0.62) _c1.setRGB(2.0, 1.15, 2.7); else _c1.setRGB(0.9, 2.3, 2.4);
    spores.setColorAt(i, _c1);
    spores.setMatrixAt(i, ZEROM);
  }
  if (spores.instanceColor) spores.instanceColor.needsUpdate = true;
  scene.add(spores);
  let sporePrevVis = 0;

  function wrapCoord(v, center, range) {
    return center + ((((v - center + range * 0.5) % range) + range) % range) - range * 0.5;
  }

  function updateSpores() {
    const pp = G.player?.pos || positions.playerSpawn;
    const t = S.time;
    const vis = Math.min(SPORE_N, Math.floor(SPORE_N * (0.5 + 0.5 * S.night) * sporeMult));
    for (let i = 0; i < vis; i++) {
      const drift = t * spSp[i];
      const wx = wrapCoord(spX[i] + drift * 0.9 + Math.sin(t * 0.31 * spSp[i] + spPh[i]) * 1.6, pp.x, SPORE_BOX);
      const wz = wrapCoord(spZ[i] + drift * 0.55 + Math.cos(t * 0.27 * spSp[i] + spPh[i] * 1.7) * 1.6, pp.z, SPORE_BOX);
      const wy = wrapCoord(spY[i] + Math.sin(t * 0.4 * spSp[i] + spPh[i]) * 2 + t * 0.14, pp.y + 16, 72);
      const s = spSc[i];
      _m.makeScale(s, s, s);
      _m.setPosition(wx, wy, wz);
      spores.setMatrixAt(i, _m);
    }
    for (let i = vis; i < sporePrevVis; i++) spores.setMatrixAt(i, ZEROM);
    sporePrevVis = vis;
    spores.instanceMatrix.needsUpdate = true;
  }

  /* ============================== WIND SWAY (shader hook) ============================== */
  const uTime = { value: 0 };
  function addSway(mat, amp, freq, weightExpr) {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          vec4 wp0 = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float swayW = ${weightExpr};
          transformed.x += sin(uTime * ${freq.toFixed(3)} + wp0.x * 0.43 + wp0.z * 0.31) * ${amp.toFixed(3)} * swayW;
          transformed.z += cos(uTime * ${(freq * 0.83).toFixed(3)} + wp0.x * 0.37 - wp0.z * 0.29) * ${(amp * 0.7).toFixed(3)} * swayW;
        }`);
    };
  }

  /* ============================== CRASHFIELD GRASS (chunked, ~20k blades) ============================== */
  const bladeGeo = new THREE.BufferGeometry();
  {
    const pos = new Float32Array([
      -0.06, 0, 0,   0.06, 0, 0,   -0.035, 0.55, 0.02,
       0.035, 0.55, 0.02,   0, 1.05, 0.05,
    ]);
    const col = new Float32Array([
      0.24, 0.18, 0.32,  0.24, 0.18, 0.32,  0.42, 0.31, 0.53,
      0.42, 0.31, 0.53,  0.66, 0.5, 0.79,
    ]);
    bladeGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    bladeGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    bladeGeo.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4]);
    bladeGeo.computeVertexNormals();
  }
  const grassMat = new THREE.MeshStandardMaterial({
    vertexColors: true, side: THREE.DoubleSide, roughness: 0.88, metalness: 0,
    emissive: 0x160b26, emissiveIntensity: 0.35,
  });
  addSway(grassMat, 0.2, 1.7, 'pow(clamp(position.y, 0.0, 1.05) / 1.05, 1.6)');

  const GRASS_N = G.gfxLow ? 5000 : 20000, CHUNK = 60;
  const grassChunks = []; // { mesh, cx, cz }
  {
    const buckets = new Map();
    let placed = 0, att = 0;
    while (placed < GRASS_N && att++ < GRASS_N * 7) {
      const x = rngRange(-298, 45), z = rngRange(-298, 45);
      if (crashWf(x, z) < 0.42) continue;
      if (dist2d(x, z, CRASH_X, CRASH_Z) < 42) continue;              // scorched bare
      if (fbm2(x * 0.02 + 40, z * 0.02 - 17, 3) < -0.28) continue;    // patchy meadow
      const key = `${Math.floor((x + 300) / CHUNK)}_${Math.floor((z + 300) / CHUNK)}`;
      if (!buckets.has(key)) buckets.set(key, []);
      _v1.set(x, getGroundHeight(x, z) - 0.02, z);
      _e.set((rng() - 0.5) * 0.22, rng() * Math.PI * 2, (rng() - 0.5) * 0.22);
      _q.setFromEuler(_e);
      const w = 0.8 + rng() * 0.6, h = 0.6 + rng() * 0.75;
      _v2.set(w, h, w);
      buckets.get(key).push(new THREE.Matrix4().compose(_v1, _q, _v2));
      placed++;
    }
    for (const [key, mats] of buckets) {
      const mesh = new THREE.InstancedMesh(bladeGeo, grassMat, mats.length);
      for (let i = 0; i < mats.length; i++) mesh.setMatrixAt(i, mats[i]);
      mesh.frustumCulled = false; // chunk-level distance culling below
      mesh.castShadow = false; mesh.receiveShadow = true;
      const [gx, gz] = key.split('_').map(Number);
      const cx = gx * CHUNK - 300 + CHUNK / 2, cz = gz * CHUNK - 300 + CHUNK / 2;
      grassChunks.push({ mesh, cx, cz });
      scene.add(mesh);
    }
  }

  /* ============================== TWO-TIER SCATTER HELPER ============================== */
  const scatterSets = [];
  function composeEntry(x, y, z, rx, ry, rz, sx, sy, sz) {
    _v1.set(x, y, z); _e.set(rx, ry, rz); _q.setFromEuler(_e); _v2.set(sx, sy, sz);
    return { x, z, m: new THREE.Matrix4().compose(_v1, _q, _v2) };
  }
  function makeTiered(geoNear, matNear, geoFar, matFar, entries, { castShadow = false, maxDist = 180 } = {}) {
    const n = entries.length;
    const near = new THREE.InstancedMesh(geoNear, matNear, n);
    near.castShadow = castShadow; near.receiveShadow = true; near.frustumCulled = false;
    let far = null;
    if (geoFar) {
      far = new THREE.InstancedMesh(geoFar, matFar || matNear, n);
      far.castShadow = false; far.receiveShadow = true; far.frustumCulled = false;
    }
    for (let i = 0; i < n; i++) {
      near.setMatrixAt(i, entries[i].m);
      if (far) far.setMatrixAt(i, ZEROM);
    }
    scene.add(near); if (far) scene.add(far);
    scatterSets.push({ near, far, entries, st: new Int8Array(n).fill(1), maxDist });
    return near;
  }
  function refreshScatter(px, pz) {
    for (const s of scatterSets) {
      let dn = false, df = false;
      for (let i = 0; i < s.entries.length; i++) {
        const en = s.entries[i];
        const v = dist2d(px, pz, en.x, en.z) < s.maxDist ? 1 : 0;
        if (v !== s.st[i]) {
          s.st[i] = v;
          s.near.setMatrixAt(i, v ? en.m : ZEROM); dn = true;
          if (s.far) { s.far.setMatrixAt(i, v ? ZEROM : en.m); df = true; }
        }
      }
      if (dn) s.near.instanceMatrix.needsUpdate = true;
      if (df) s.far.instanceMatrix.needsUpdate = true;
    }
  }

  function scatterPlace(count, testFn, makeFn) {
    const out = [];
    let att = 0;
    while (out.length < count && att++ < count * 30) {
      const x = rngRange(-292, 292), z = rngRange(-292, 292);
      if (!testFn(x, z)) continue;
      out.push(makeFn(x, z));
    }
    return out;
  }

  /* ---------- crashfield debris chunks ---------- */
  const debrisMat = new THREE.MeshStandardMaterial({
    map: metalTex, normalMap: metalNormal, color: 0x555a6e,
    metalness: 0.7, roughness: 0.55,
  });
  const charMat = new THREE.MeshStandardMaterial({ color: 0x1c1722, roughness: 0.95, metalness: 0.25 });
  makeTiered(
    new THREE.DodecahedronGeometry(0.55, 0), debrisMat, null, null,
    scatterPlace(140,
      (x, z) => crashWf(x, z) > 0.45 && dist2d(x, z, CRASH_X, CRASH_Z) < 95 && dist2d(x, z, CRASH_X, CRASH_Z) > 9,
      (x, z) => composeEntry(x, getGroundHeight(x, z) + 0.1, z,
        rng() * Math.PI, rng() * Math.PI * 2, rng() * Math.PI,
        0.4 + rng() * 1.5, 0.3 + rng() * 0.9, 0.4 + rng() * 1.5)),
    { castShadow: false, maxDist: 160 });

  /* ---------- dry-sea bone-white mineral spires ---------- */
  const mineralMat = new THREE.MeshStandardMaterial({
    map: rockTex, normalMap: rockNormal, color: 0xe8e2e6,
    roughness: 0.8, metalness: 0.05,
  });
  const mineralGeo = (() => {
    const pts = [];
    for (let i = 0; i <= 7; i++) {
      const t = i / 7;
      const r = (1 - t) * (0.95 + (i % 2 ? 0.22 : -0.08)) + 0.02;
      pts.push(new THREE.Vector2(r, t * 6));
    }
    return new THREE.LatheGeometry(pts, 10);
  })();
  const mineralFarGeo = new THREE.ConeGeometry(0.9, 6, 6);
  mineralFarGeo.translate(0, 3, 0);
  makeTiered(mineralGeo, mineralMat, mineralFarGeo, mineralMat,
    scatterPlace(55,
      (x, z) => crashWf(x, z) < 0.25 && spireWf(x, z) < 0.25 && fbm2(x * 0.015 + 77, z * 0.015, 3) > 0.05,
      (x, z) => composeEntry(x, getGroundHeight(x, z) - 0.35, z,
        (rng() - 0.5) * 0.24, rng() * Math.PI * 2, (rng() - 0.5) * 0.24,
        0.6 + rng() * 1.5, 0.6 + rng() * 1.8, 0.6 + rng() * 1.5)),
    { castShadow: true, maxDist: 240 });

  /* ---------- dry-sea teal crystal-flora clumps ---------- */
  const floraMat = new THREE.MeshStandardMaterial({
    color: 0x1d5a58, emissive: 0x2fe0cd, emissiveIntensity: 0.85,
    roughness: 0.3, metalness: 0.1, flatShading: true,
  });
  const floraGeo = (() => {
    const parts = [];
    for (let k = 0; k < 4; k++) {
      const g = new THREE.OctahedronGeometry(0.16 + rng() * 0.14, 0);
      g.scale(1, 1.7 + rng() * 1.3, 1);
      g.rotateX((rng() - 0.5) * 0.8); g.rotateZ((rng() - 0.5) * 0.8);
      g.translate((rng() - 0.5) * 0.5, 0.24, (rng() - 0.5) * 0.5);
      parts.push(g);
    }
    return mergeGeometries(parts);
  })();
  makeTiered(floraGeo, floraMat, null, null,
    scatterPlace(130,
      (x, z) => crashWf(x, z) < 0.3 && spireWf(x, z) < 0.3 && fbm2(x * 0.03 - 31, z * 0.03 + 8, 3) > -0.05,
      (x, z) => composeEntry(x, getGroundHeight(x, z), z,
        0, rng() * Math.PI * 2, 0, 0.7 + rng() * 1.1, 0.7 + rng() * 1.2, 0.7 + rng() * 1.1)),
    { maxDist: 170 });

  /* ---------- spire violet crystal clusters ---------- */
  const crystalMat = new THREE.MeshStandardMaterial({
    color: 0x6a3fd0, emissive: 0x8a5cff, emissiveIntensity: 0.9,
    roughness: 0.14, metalness: 0.12, flatShading: true,
  });
  const crystalGeo = (() => {
    const parts = [];
    for (let k = 0; k < 5; k++) {
      const g = new THREE.OctahedronGeometry(0.3 + rng() * 0.35, 0);
      g.scale(1, 2.2 + rng() * 2.2, 1);
      g.rotateX((rng() - 0.5) * 1.1); g.rotateZ((rng() - 0.5) * 1.1);
      g.translate((rng() - 0.5) * 1.3, 0.55, (rng() - 0.5) * 1.3);
      parts.push(g);
    }
    return mergeGeometries(parts);
  })();
  const crystalFarGeo = new THREE.OctahedronGeometry(0.55, 0);
  crystalFarGeo.scale(1, 3, 1); crystalFarGeo.translate(0, 1.1, 0);
  makeTiered(crystalGeo, crystalMat, crystalFarGeo, crystalMat,
    scatterPlace(95,
      (x, z) => spireWf(x, z) > 0.45 && dist2d(x, z, ARENA_X, ARENA_Z) > 26 && dist2d(x, z, SPIRE_X, SPIRE_Z) > 12,
      (x, z) => composeEntry(x, getGroundHeight(x, z) - 0.15, z,
        0, rng() * Math.PI * 2, 0, 0.8 + rng() * 1.6, 0.8 + rng() * 1.7, 0.8 + rng() * 1.6)),
    { castShadow: true, maxDist: 220 });

  /* ---------- spire antenna reeds (swaying, emissive tips) ---------- */
  const reedMat = new THREE.MeshStandardMaterial({ color: 0x201b30, roughness: 0.6, metalness: 0.65 });
  addSway(reedMat, 0.3, 1.3, 'pow(clamp(position.y, 0.0, 2.4) / 2.4, 2.0)');
  const reedGeo = new THREE.CylinderGeometry(0.018, 0.04, 2.4, 5);
  reedGeo.translate(0, 1.2, 0);
  const tipMat = new THREE.MeshStandardMaterial({
    color: 0x2a1846, emissive: 0xb47aff, emissiveIntensity: 2.1, roughness: 0.4,
  });
  addSway(tipMat, 0.3, 1.3, '1.0');
  const tipGeo = new THREE.SphereGeometry(0.07, 6, 5);
  tipGeo.translate(0, 2.4, 0);
  {
    const reedEntries = [];
    let placedClusters = 0, att = 0;
    while (placedClusters < 42 && att++ < 900) {
      const x = rngRange(60, 292), z = rngRange(60, 292);
      if (spireWf(x, z) < 0.4) continue;
      if (dist2d(x, z, ARENA_X, ARENA_Z) < 26) continue;
      placedClusters++;
      const n = rngInt(6, 10);
      for (let k = 0; k < n; k++) {
        const rx = x + (rng() - 0.5) * 5, rz = z + (rng() - 0.5) * 5;
        reedEntries.push(composeEntry(rx, getGroundHeight(rx, rz) - 0.05, rz,
          (rng() - 0.5) * 0.2, rng() * Math.PI * 2, (rng() - 0.5) * 0.2,
          1, 0.7 + rng() * 0.8, 1));
      }
    }
    makeTiered(reedGeo, reedMat, null, null, reedEntries, { maxDist: 150 });
    makeTiered(tipGeo, tipMat, null, null, reedEntries.map(e => ({ x: e.x, z: e.z, m: e.m.clone() })), { maxDist: 150 });
  }

  /* ---------- dead machine husks (map-wide precursor language) ---------- */
  const huskGeo = (() => {
    const body = new THREE.CapsuleGeometry(0.6, 1.6, 4, 10);
    body.rotateZ(Math.PI / 2); body.translate(0, 0.35, 0);
    const box = new THREE.BoxGeometry(0.7, 0.5, 0.9);
    box.translate(0.9, 0.3, 0.2);
    const shard = new THREE.OctahedronGeometry(0.3, 0);
    shard.scale(1, 2.4, 1); shard.rotateZ(0.4); shard.translate(-0.4, 0.8, 0);
    // capsule/box are indexed, octahedron is not — normalize before merging
    return mergeGeometries([body.toNonIndexed(), box.toNonIndexed(), shard]);
  })();
  makeTiered(huskGeo, charMat, null, null,
    scatterPlace(14,
      (x, z) => dist2d(x, z, CRASH_X, CRASH_Z) > 40 && dist2d(x, z, ARENA_X, ARENA_Z) > 30,
      (x, z) => composeEntry(x, getGroundHeight(x, z) - 0.25, z,
        (rng() - 0.5) * 0.4, rng() * Math.PI * 2, (rng() - 0.5) * 0.4,
        1 + rng() * 1.6, 0.8 + rng() * 1.2, 1 + rng() * 1.6)),
    { castShadow: true, maxDist: 200 });

  /* ---------- precursor ribcage arches + cable vines ---------- */
  const archMat = new THREE.MeshStandardMaterial({
    map: metalTex, normalMap: metalNormal, color: 0x2b2738,
    metalness: 0.85, roughness: 0.42,
  });
  const archGeo = new THREE.TorusGeometry(1, 0.09, 8, 26, Math.PI * 0.85);
  archGeo.rotateZ((Math.PI - Math.PI * 0.85) / 2); // center arc apex upward
  const archTops = [];
  {
    const entries = [];
    let placed = 0, att = 0;
    while (placed < 14 && att++ < 600) {
      const x = rngRange(70, 290), z = rngRange(70, 290);
      if (spireWf(x, z) < 0.5) continue;
      if (dist2d(x, z, ARENA_X, ARENA_Z) < 30 || dist2d(x, z, SPIRE_X, SPIRE_Z) < 14) continue;
      const R = 6 + rng() * 7;
      const y = getGroundHeight(x, z) - 0.8;
      entries.push(composeEntry(x, y, z, 0, rng() * Math.PI * 2, (rng() - 0.5) * 0.25, R, R, R));
      archTops.push(new THREE.Vector3(x, y + R * 0.97, z));
      placed++;
    }
    makeTiered(archGeo, archMat, null, null, entries, { castShadow: true, maxDist: 320 });
  }
  const vineMat = new THREE.MeshStandardMaterial({
    color: 0x1a1626, roughness: 0.7, metalness: 0.4,
    emissive: 0x5a3a9e, emissiveIntensity: 0.25,
  });
  {
    const tubes = [];
    for (let i = 0; i < archTops.length; i++) {
      for (let j = i + 1; j < archTops.length; j++) {
        const a = archTops[i], b = archTops[j];
        const d = a.distanceTo(b);
        if (d > 8 && d < 45 && tubes.length < 18) {
          const mid = a.clone().add(b).multiplyScalar(0.5);
          mid.y -= d * 0.18; // catenary sag
          const curve = new THREE.CatmullRomCurve3([a.clone(), mid, b.clone()]);
          tubes.push(new THREE.TubeGeometry(curve, 16, 0.09, 5, false));
        }
      }
    }
    if (tubes.length) {
      const vines = new THREE.Mesh(mergeGeometries(tubes), vineMat);
      vines.castShadow = false; vines.receiveShadow = true;
      scene.add(vines);
    }
  }

  /* ---------- spire point lights + light shafts (shadowless) ---------- */
  const shaftMat = new THREE.MeshBasicMaterial({
    color: 0x8a5cff, transparent: true, opacity: 0.07,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
  });
  const spireLights = [];
  const lightSpots = [[168, 195], [200, 205], [186, 168]];
  for (const [lx, lz] of lightSpots) {
    const ly = getGroundHeight(lx, lz);
    const pl = new THREE.PointLight(0x9a5cff, 90, 70, 2);
    pl.position.set(lx, ly + 6, lz);
    pl.castShadow = false;
    scene.add(pl); spireLights.push(pl);
    const cone = new THREE.Mesh(new THREE.ConeGeometry(4, 28, 12, 1, true), shaftMat);
    cone.position.set(lx, ly + 14, lz);
    cone.rotation.z = (rng() - 0.5) * 0.3;
    scene.add(cone);
  }

  /* ---------- wreck smoke columns + fires ---------- */
  const smokeSprites = []; // { spr, x, z, baseY, age, rate, drift }
  const smokeMat = new THREE.SpriteMaterial({
    map: smokeTex, transparent: true, opacity: 0.35, depthWrite: false, color: 0x9a8ab0,
  });
  const smokeSpots = [
    [CRASH_X + 3, CRASH_Z + 2], [CRASH_X - 6, CRASH_Z - 4],
    [CRASH_X + WAX * 14, CRASH_Z + WAZ * 14], [CRASH_X - WAX * 20, CRASH_Z - WAZ * 18],
  ];
  for (const [sx, sz] of smokeSpots) {
    const baseY = getGroundHeight(sx, sz) + 1;
    for (let k = 0; k < 10; k++) {
      const spr = new THREE.Sprite(smokeMat.clone());
      spr.position.set(sx, baseY, sz);
      scene.add(spr);
      smokeSprites.push({
        spr, x: sx, z: sz, baseY,
        age: rng(), rate: 0.09 + rng() * 0.06, drift: (rng() - 0.5) * 1.4,
      });
    }
  }
  const fireMat = new THREE.MeshStandardMaterial({
    color: 0x631f08, emissive: 0xff9040, emissiveIntensity: 3.2, roughness: 0.6,
  });
  const fires = []; // { mesh, light, base }
  const fireSpots = [
    [CRASH_X + 4, CRASH_Z + 3], [CRASH_X - 7, CRASH_Z - 3],
    [CRASH_X + WAX * 13, CRASH_Z + WAZ * 13 + 2], [CRASH_X - WAX * 19, CRASH_Z - WAZ * 17],
  ];
  fireSpots.forEach(([fx, fz], i) => {
    const fy = getGroundHeight(fx, fz);
    const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.34, 1), fireMat);
    mesh.position.set(fx, fy + 0.25, fz);
    mesh.scale.y = 1.5;
    scene.add(mesh);
    let light = null;
    if (i < 2) { // shadow-less flicker lights on the two big fires only
      light = new THREE.PointLight(0xff8c3a, 26, 16, 2);
      light.position.set(fx, fy + 1.2, fz);
      scene.add(light);
    }
    fires.push({ mesh, light, base: 1 });
  });

  /* ============================== PROPS ============================== */
  const hullMat = new THREE.MeshStandardMaterial({
    map: metalTex, normalMap: metalNormal, color: 0xb8bfd2,
    metalness: 0.72, roughness: 0.48,
  });
  const windowMat = new THREE.MeshStandardMaterial({
    color: 0x241608, emissive: 0xffb545, emissiveIntensity: 1.8, roughness: 0.4,
  });
  const cyanScreenMat = new THREE.MeshStandardMaterial({
    color: 0x06232a, emissive: 0x4be8ff, emissiveIntensity: 1.6, roughness: 0.35,
  });

  /* ---------- crashed human ship ---------- */
  const wreckGroup = new THREE.Group();
  wreckGroup.position.copy(positions.wreck);
  wreckGroup.rotation.y = -WRECK_YAW;
  scene.add(wreckGroup);
  {
    // main fuselage — lying capsule, tilted, half-settled into the scorch
    const hull = new THREE.Mesh(new THREE.CapsuleGeometry(3.4, 13, 6, 24), hullMat);
    hull.rotation.z = Math.PI / 2;
    hull.rotation.x = 0.09;
    hull.position.set(-1.5, 2.4, 0);
    hull.castShadow = true; hull.receiveShadow = true;
    wreckGroup.add(hull);
    // torn break ring — jagged charred plates at the forward end
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + rng() * 0.4;
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.6 + rng() * 1.6, 1.1 + rng()), charMat);
      plate.position.set(5.6 + rng() * 0.8, 2.4 + Math.sin(a) * 2.9, Math.cos(a) * 2.9);
      plate.rotation.set(a, rng() * 0.8, 0.5 + rng() * 0.9);
      plate.castShadow = true;
      wreckGroup.add(plate);
    }
    // severed nose section, thrown forward along the trench
    const nose = new THREE.Mesh(new THREE.CapsuleGeometry(2.5, 4, 6, 20), hullMat);
    nose.rotation.z = Math.PI / 2 + 0.5;
    nose.rotation.y = 0.4;
    nose.position.set(13, 1.4, 2.5);
    nose.castShadow = true; nose.receiveShadow = true;
    wreckGroup.add(nose);
    // amber emissive windows along the hull flank
    for (let i = 0; i < 6; i++) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.32, 0.1), windowMat);
      w.position.set(-5.5 + i * 1.7, 3.1, 3.42);
      wreckGroup.add(w);
    }
    // fins
    for (const s of [-1, 1]) {
      const fin = new THREE.Mesh(new THREE.BoxGeometry(3.2, 2.6, 0.24), hullMat);
      fin.position.set(-7.5, 4.4, s * 1.8);
      fin.rotation.x = s * 0.7;
      fin.castShadow = true;
      wreckGroup.add(fin);
    }
    // antenna mast + blinking beacon
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.1, 4.6, 6), hullMat);
    mast.position.set(-4, 6.6, 0.5);
    mast.rotation.z = 0.3;
    wreckGroup.add(mast);
  }
  const beaconMat = new THREE.MeshStandardMaterial({
    color: 0x2a0d10, emissive: 0xff4d4d, emissiveIntensity: 2.4, roughness: 0.4,
  });
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), beaconMat);
  beacon.position.set(-4.7, 8.8, 0.5);
  wreckGroup.add(beacon);

  /* ---------- fabricator unit ---------- */
  {
    const fab = new THREE.Group();
    fab.position.copy(positions.fabricator);
    fab.rotation.y = 0.7;
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.9, 1.1), hullMat);
    body.position.y = 0.95;
    body.castShadow = true; body.receiveShadow = true;
    fab.add(body);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.6), cyanScreenMat);
    screen.position.set(0, 1.35, 0.56);
    fab.add(screen);
    const vent = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.28, 0.06), charMat);
    vent.position.set(0, 0.4, 0.56);
    fab.add(vent);
    const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 1.6, 5), hullMat);
    rod.position.set(0.55, 2.6, -0.3);
    fab.add(rod);
    // power cable back to the wreck
    const cable = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0.3, -0.5),
      new THREE.Vector3(-3, 0.15, -2),
      positions.wreck.clone().sub(positions.fabricator).setY(1.2),
    ]), 12, 0.07, 5), charMat);
    fab.add(cable);
    scene.add(fab);
  }

  /* ---------- shuttle console (orbital map) ---------- */
  const holoRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.85, 0.045, 8, 40),
    new THREE.MeshBasicMaterial({
      color: 0x4be8ff, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
  {
    const con = new THREE.Group();
    con.position.copy(positions.shuttleConsole);
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.75, 1.1, 10), hullMat);
    ped.position.y = 0.55;
    ped.castShadow = true;
    con.add(ped);
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.55, 0.1), cyanScreenMat);
    panel.position.set(0, 1.25, 0.15);
    panel.rotation.x = -0.5;
    con.add(panel);
    holoRing.position.y = 2.1;
    holoRing.rotation.x = Math.PI / 2.4;
    con.add(holoRing);
    scene.add(con);
  }

  /* ---------- the relay spire tower (visible map-wide) ---------- */
  const spireRingMat = new THREE.MeshStandardMaterial({
    color: 0x2a1846, emissive: 0xa06aff, emissiveIntensity: 2.2, roughness: 0.35, metalness: 0.3,
  });
  {
    const tower = new THREE.Group();
    tower.position.set(SPIRE_X, gph(SPIRE_X, SPIRE_Z) - 1, SPIRE_Z);
    const profile = [
      [6.5, 0], [5.2, 8], [4.2, 18], [3.5, 30], [2.5, 45],
      [1.7, 62], [1.0, 76], [0.28, 90],
    ].map(([r, y]) => new THREE.Vector2(r, y));
    const body = new THREE.Mesh(new THREE.LatheGeometry(profile, 12), archMat);
    body.castShadow = true; body.receiveShadow = true;
    tower.add(body);
    for (const hgt of [12, 26, 42, 58, 73]) { // violet emissive rings
      const rr = 6.5 * (1 - hgt / 95) + 0.3;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(rr, 0.22, 6, 28), spireRingMat);
      ring.rotation.x = Math.PI / 2;
      ring.position.y = hgt;
      tower.add(ring);
    }
    // crystal eruption at the base
    for (let k = 0; k < 6; k++) {
      const c = new THREE.Mesh(new THREE.OctahedronGeometry(1 + rng() * 1.4, 0), crystalMat);
      c.scale.y = 2.2 + rng() * 1.8;
      const a = rng() * Math.PI * 2;
      c.position.set(Math.cos(a) * (5 + rng() * 3), 1.4, Math.sin(a) * (5 + rng() * 3));
      c.rotation.set((rng() - 0.5) * 0.7, rng() * Math.PI, (rng() - 0.5) * 0.7);
      c.castShadow = true;
      tower.add(c);
    }
    const tip = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xb47aff, blending: THREE.AdditiveBlending,
      depthWrite: false, transparent: true,
    }));
    tip.scale.set(14, 14, 1);
    tip.position.y = 90;
    tower.add(tip);
    scene.add(tower);
  }

  /* ---------- colossus arena — ring of broken pillars ---------- */
  const pillarCircles = []; // 2D colliders {x,z,r}
  {
    const arena = new THREE.Group();
    scene.add(arena);
    const n = 10;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng() * 0.25;
      const px = ARENA_X + Math.cos(a) * 21, pz = ARENA_Z + Math.sin(a) * 21;
      const h = 3.5 + rng() * 5.5, r = 1.15 + rng() * 0.5;
      const pil = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.82, r, h, 9), archMat);
      pil.position.set(px, getGroundHeight(px, pz) + h / 2 - 0.5, pz);
      pil.rotation.set((rng() - 0.5) * 0.16, rng() * Math.PI, (rng() - 0.5) * 0.16);
      pil.castShadow = true; pil.receiveShadow = true;
      arena.add(pil);
      if (rng() < 0.45) { // crystal reclamation on some pillars
        const c = new THREE.Mesh(new THREE.OctahedronGeometry(0.5 + rng() * 0.5, 0), crystalMat);
        c.scale.y = 2 + rng() * 1.5;
        c.position.set(px + (rng() - 0.5) * 1.6, getGroundHeight(px, pz) + 0.8, pz + (rng() - 0.5) * 1.6);
        c.rotation.y = rng() * Math.PI;
        arena.add(c);
      }
      pillarCircles.push({ x: px, z: pz, r: r + 0.25 });
    }
  }

  /* ---------- warden post obelisks ---------- */
  for (const wp of positions.wardenPosts) {
    const ob = new THREE.Group();
    ob.position.copy(wp);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.55, 3.4, 4), archMat);
    shaft.position.y = 1.7;
    shaft.rotation.y = rng() * Math.PI;
    shaft.castShadow = true;
    ob.add(shaft);
    const cap = new THREE.Mesh(new THREE.OctahedronGeometry(0.3, 0), spireRingMat);
    cap.position.y = 3.7;
    ob.add(cap);
    scene.add(ob);
    pillarCircles.push({ x: wp.x, z: wp.z, r: 0.85 });
  }

  /* ---------- precursor core pickups ---------- */
  const coreMat = new THREE.MeshStandardMaterial({
    color: 0x3a1c66, emissive: 0xb47aff, emissiveIntensity: 2.6, roughness: 0.2, metalness: 0.1,
  });
  const corePickups = []; // { group, pos, baseY, taken }
  for (const cp of positions.corePickups) {
    const g = new THREE.Group();
    g.position.copy(cp);
    const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.45, 0), coreMat);
    crystal.scale.y = 1.5;
    g.add(crystal);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xb47aff, blending: THREE.AdditiveBlending,
      depthWrite: false, transparent: true, opacity: 0.85,
    }));
    glow.scale.set(3.2, 3.2, 1);
    g.add(glow);
    scene.add(g);
    corePickups.push({ group: g, pos: cp, baseY: cp.y, taken: false });
  }

  /* ============================== SPIRE ZONE GATE ============================== */
  // Energy shell arc at GATE_R around the spire; the in-map arc spans the whole approach.
  let gateOpen = false, gateOpening = false, gateAnimT = 0;
  const gateMat = new THREE.MeshBasicMaterial({
    map: hexTex, color: 0xd85caa, transparent: true, opacity: 0.5,
    blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false, fog: false,
  });
  gateMat.map = hexTex; hexTex.repeat.set(46, 3);
  const gateWall = new THREE.Mesh(
    // cylinder θ→dir(sinθ,cosθ); world arc φ∈[126°,324°] ⇒ θ = 90°−φ
    new THREE.CylinderGeometry(GATE_R, GATE_R, 22, 96, 1, true,
      THREE.MathUtils.degToRad(90 - 324), THREE.MathUtils.degToRad(198)),
    gateMat);
  gateWall.position.set(SPIRE_X, 9, SPIRE_Z);
  gateWall.frustumCulled = false;
  scene.add(gateWall);
  // gate pylons flanking the SW approach point
  const pylonMat = new THREE.MeshStandardMaterial({
    color: 0x241a3a, emissive: 0xd85caa, emissiveIntensity: 1.6, metalness: 0.5, roughness: 0.4,
  });
  const gatePylons = [];
  for (const off of [-0.06, 0.06]) { // ±~3.5° around φ=225°
    const a = Math.PI * 1.25 + off;
    const px = SPIRE_X + Math.cos(a) * GATE_R, pz = SPIRE_Z + Math.sin(a) * GATE_R;
    const py = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.8, 12, 6), pylonMat);
    py.position.set(px, getGroundHeight(px, pz) + 5, pz);
    py.castShadow = true;
    scene.add(py); gatePylons.push(py);
    pillarCircles.push({ x: px, z: pz, r: 1.1 });
  }

  function openSpireGate() {
    if (gateOpen || gateOpening) return;
    gateOpening = true; gateAnimT = 0;
    bus.emit('sfx', { name: 'ui' });
    bus.emit('shake', { i: 0.35 });
  }

  /* ============================== RESOURCE NODES ============================== */
  const nodeMats = {
    alloy: new THREE.MeshStandardMaterial({
      color: 0xcfc4a4, metalness: 0.85, roughness: 0.32,
      emissive: 0xffb545, emissiveIntensity: 0.7,
    }),
    circuits: new THREE.MeshStandardMaterial({
      color: 0x184a4c, metalness: 0.4, roughness: 0.4,
      emissive: 0x3fe8d8, emissiveIntensity: 0.8,
    }),
    cells: new THREE.MeshStandardMaterial({
      color: 0x3a2468, metalness: 0.2, roughness: 0.35,
      emissive: 0xb47aff, emissiveIntensity: 0.85,
    }),
  };
  const nodeRockMat = new THREE.MeshStandardMaterial({ color: 0x3c3450, roughness: 0.9, metalness: 0.1 });
  const nodes = [];
  function buildNode(type, x, z) {
    const g = new THREE.Group();
    const y = getGroundHeight(x, z);
    g.position.set(x, y, z);
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(0.7, 0), nodeRockMat);
    rock.position.y = 0.1; rock.scale.y = 0.55;
    rock.rotation.y = rng() * Math.PI;
    rock.receiveShadow = true;
    g.add(rock);
    const mat = nodeMats[type];
    if (type === 'alloy') {
      for (let k = 0; k < 3; k++) { // amber-white metallic shards
        const c = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.9 + rng() * 0.5, 6), mat);
        c.position.set((rng() - 0.5) * 0.7, 0.55, (rng() - 0.5) * 0.7);
        c.rotation.set((rng() - 0.5) * 0.7, rng() * Math.PI, (rng() - 0.5) * 0.7);
        c.castShadow = true;
        g.add(c);
      }
    } else if (type === 'circuits') {
      for (let k = 0; k < 5; k++) { // teal cube cluster
        const s = 0.2 + rng() * 0.2;
        const c = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), mat);
        c.position.set((rng() - 0.5) * 0.8, 0.3 + rng() * 0.5, (rng() - 0.5) * 0.8);
        c.rotation.set(rng(), rng() * Math.PI, rng());
        c.castShadow = true;
        g.add(c);
      }
    } else {
      for (let k = 0; k < 2; k++) { // violet pods
        const c = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.42, 4, 10), mat);
        c.position.set((rng() - 0.5) * 0.6, 0.5, (rng() - 0.5) * 0.6);
        c.rotation.z = (rng() - 0.5) * 0.5;
        c.castShadow = true;
        g.add(c);
      }
    }
    scene.add(g);
    nodes.push({ pos: g.position, type, mesh: g });
  }
  {
    const typeCycle = ['alloy', 'circuits', 'cells'];
    let ti = 0, placed = 0, att = 0;
    const nodeOK = (x, z) =>
      dist2d(x, z, CRASH_X, CRASH_Z) > 18 &&
      dist2d(x, z, ARENA_X, ARENA_Z) > 32 &&
      !nodes.some(nd => dist2d(x, z, nd.pos.x, nd.pos.z) < 28);
    // 9 crashfield / 11 dry sea / 4 spire outskirts
    while (placed < 9 && att++ < 800) {
      const x = rngRange(-290, 30), z = rngRange(-290, 30);
      if (crashWf(x, z) < 0.5 || !nodeOK(x, z)) continue;
      buildNode(typeCycle[ti++ % 3], x, z); placed++;
    }
    placed = 0; att = 0;
    while (placed < 11 && att++ < 1200) {
      const x = rngRange(-200, 290), z = rngRange(-290, 290);
      if (crashWf(x, z) > 0.3 || spireWf(x, z) > 0.3 || !nodeOK(x, z)) continue;
      buildNode(typeCycle[ti++ % 3], x, z); placed++;
    }
    placed = 0; att = 0;
    while (placed < 4 && att++ < 800) {
      const x = rngRange(40, 290), z = rngRange(40, 290);
      const w = spireWf(x, z);
      if (w < 0.35 || w > 0.9 || !nodeOK(x, z)) continue;
      if (dist2d(x, z, SPIRE_X, SPIRE_Z) < GATE_R + 6 && dist2d(x, z, SPIRE_X, SPIRE_Z) > GATE_R - 6) continue;
      buildNode(typeCycle[ti++ % 3], x, z); placed++;
    }
  }

  /* ============================== COLLISIONS ============================== */
  // wreck hull capsule endpoints (2D)
  const WRA = { x: CRASH_X + WAX * 8, z: CRASH_Z + WAZ * 8 };
  const WRB = { x: CRASH_X - WAX * 8, z: CRASH_Z - WAZ * 8 };
  const NOSE = { x: CRASH_X + WAX * 14, z: CRASH_Z + WAZ * 14 };
  const circles = [
    { x: NOSE.x, z: NOSE.z, r: 3.2 },
    { x: SPIRE_X, z: SPIRE_Z, r: 8.5 },                                // spire tower base
    { x: positions.fabricator.x, z: positions.fabricator.z, r: 1.3 },
    { x: positions.shuttleConsole.x, z: positions.shuttleConsole.z, r: 0.9 },
    ...pillarCircles,
  ];

  function pushCircle(pos, radius, cx, cz, cr) {
    const dx = pos.x - cx, dz = pos.z - cz;
    const d = Math.hypot(dx, dz), min = cr + radius;
    if (d < min && d > 1e-5) {
      const s = min / d;
      pos.x = cx + dx * s;
      pos.z = cz + dz * s;
    } else if (d <= 1e-5) {
      pos.x = cx + min;
    }
  }

  function resolveCollisions(pos, radius = 0.6) {
    // world bounds
    pos.x = clamp(pos.x, -295, 295);
    pos.z = clamp(pos.z, -295, 295);
    // wreck hull capsule
    {
      const dx = WRB.x - WRA.x, dz = WRB.z - WRA.z;
      const L2 = dx * dx + dz * dz;
      let t = ((pos.x - WRA.x) * dx + (pos.z - WRA.z) * dz) / L2;
      t = clamp01(t);
      pushCircle(pos, radius, WRA.x + dx * t, WRA.z + dz * t, 5.2);
    }
    for (let i = 0; i < circles.length; i++) {
      const c = circles[i];
      pushCircle(pos, radius, c.x, c.z, c.r);
    }
    // closed gate: thin shell at GATE_R — blocks crossing either way, ignores deep insiders
    if (!gateOpen) {
      const dx = pos.x - SPIRE_X, dz = pos.z - SPIRE_Z;
      const d = Math.hypot(dx, dz);
      const rr = radius + 0.7;
      if (Math.abs(d - GATE_R) < rr && d > 0.01) {
        const target = d < GATE_R ? GATE_R - rr : GATE_R + rr;
        const s = target / d;
        pos.x = SPIRE_X + dx * s;
        pos.z = SPIRE_Z + dz * s;
      }
    }
    return pos;
  }

  /* ============================== ZONES ============================== */
  function zoneAt(x, z) {
    const wS = spireWf(x, z), wC = crashWf(x, z);
    if (wS >= 0.5 && wS >= wC) return 'spire';
    if (wC >= 0.45) return 'crashfield';
    return 'drysea';
  }

  /* ============================== PERF HOOKS ============================== */
  function setSecondSunShadow(on) {
    sun2Light.castShadow = !!on; // degrade to shadowless teal light; never removed
  }
  function setSporeDensity(mult) {
    sporeMult = clamp(mult, 0, 2);
  }

  /* ============================== UPDATE ============================== */
  const DAY_LEN = 480; // 8-minute full cycle
  const sunDir = new THREE.Vector3(0.4, 0.6, 0.3);
  const sun2Dir = new THREE.Vector3(-0.3, 0.3, 0.5);
  let scatterTimer = 0;
  let pendingZone = null, pendingT = 0;

  function update(dt) {
    const t = S.time;
    const pp = G.player?.pos || positions.playerSpawn;

    /* ---- day/night cycle ---- */
    const ang = ((t / DAY_LEN) % 1) * Math.PI * 2 + 0.5;
    const elev = Math.sin(ang) * 0.85;                 // amber sun rises + sets
    const az = ang * 0.6 + 1.0;
    sunDir.set(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev));
    const elev2 = 0.2 + 0.1 * Math.sin(ang * 0.5);     // teal sun stays low, never sets
    const az2 = az + 0.7;                              // ~40° offset
    sun2Dir.set(Math.cos(az2) * Math.cos(elev2), Math.sin(elev2), Math.sin(az2) * Math.cos(elev2));
    const dayF = clamp01((sunDir.y + 0.12) / 0.30);
    S.night = 1 - dayF;

    /* ---- suns: shadow follow-boxes snapped to player ---- */
    const tx = Math.round(pp.x / 4) * 4, tz = Math.round(pp.z / 4) * 4;
    const ty = getGroundHeight(tx, tz);
    sunLight.target.position.set(tx, ty, tz);
    sunLight.position.set(
      tx + sunDir.x * 170, ty + Math.max(sunDir.y, 0.06) * 170, tz + sunDir.z * 170);
    sunLight.intensity = 2.6 * dayF;
    sunLight.color.lerpColors(C_SUN_LOW, C_SUN_HIGH, clamp01(sunDir.y / 0.5));
    sun2Light.target.position.set(tx, ty, tz);
    sun2Light.position.set(tx + sun2Dir.x * 150, ty + sun2Dir.y * 150, tz + sun2Dir.z * 150);
    sun2Light.intensity = lerp(0.85, 0.55, S.night);

    hemi.color.lerpColors(C_HEMI_SKY_D, C_HEMI_SKY_N, S.night);
    hemi.groundColor.lerpColors(C_HEMI_GND_D, C_HEMI_GND_N, S.night);
    hemi.intensity = lerp(0.55, 0.3, S.night);

    /* ---- fog: warm violet day / cool night, denser + cooler toward the spire ---- */
    const spireW = spireWf(pp.x, pp.z);
    _c1.lerpColors(C_FOG_DAY, C_FOG_NIGHT, S.night);
    _c1.lerp(C_FOG_SPIRE, spireW * 0.55);
    fog.color.copy(_c1);
    fog.density = lerp(0.0035, 0.0052, spireW) * (1 + S.night * 0.18);

    /* ---- sky dome + stars + sun discs (camera-locked) ---- */
    skyGroup.position.copy(camera.position);
    skyMat.uniforms.uNight.value = S.night;
    skyMat.uniforms.uSunDir.value.copy(sunDir);
    skyMat.uniforms.uSun2Dir.value.copy(sun2Dir);
    starMat.opacity = S.night * (0.72 + 0.1 * Math.sin(t * 2.7));
    sunSprite.position.copy(sunDir).multiplyScalar(640);
    sunSpriteMat.opacity = clamp01((sunDir.y + 0.1) / 0.15);
    _c1.setHex(0xffc887).lerp(_c2.setHex(0xff6a30), clamp01(1 - sunDir.y / 0.45));
    sunSpriteMat.color.copy(_c1);
    sun2Sprite.position.copy(sun2Dir).multiplyScalar(640);
    sun2SpriteMat.opacity = 0.85;

    /* ---- spores + wind ---- */
    updateSpores();
    uTime.value = t;

    /* ---- scatter LOD + grass chunks @4Hz ---- */
    scatterTimer += dt;
    if (scatterTimer > 0.25) {
      scatterTimer = 0;
      refreshScatter(pp.x, pp.z);
      for (let i = 0; i < grassChunks.length; i++) {
        const c = grassChunks[i];
        c.mesh.visible = dist2d(pp.x, pp.z, c.cx, c.cz) < 230;
      }
    }

    /* ---- emissive pulses ---- */
    nodeMats.alloy.emissiveIntensity = 0.55 + 0.4 * (0.5 + 0.5 * Math.sin(t * 2.2));
    nodeMats.circuits.emissiveIntensity = 0.6 + 0.45 * (0.5 + 0.5 * Math.sin(t * 2.2 + 2.1));
    nodeMats.cells.emissiveIntensity = 0.6 + 0.45 * (0.5 + 0.5 * Math.sin(t * 2.2 + 4.2));
    crystalMat.emissiveIntensity = 0.75 + 0.3 * Math.sin(t * 1.3) + S.night * 0.35;
    floraMat.emissiveIntensity = 0.7 + 0.3 * Math.sin(t * 1.7 + 1.3) + S.night * 0.4;
    spireRingMat.emissiveIntensity = 1.9 + 0.7 * (0.5 + 0.5 * Math.sin(t * 0.9));
    beaconMat.emissiveIntensity = 1.0 + 1.8 * (0.5 + 0.5 * Math.sin(t * 3.1));
    shaftMat.opacity = 0.05 + 0.03 * (0.5 + 0.5 * Math.sin(t * 0.7)) + S.night * 0.03;
    for (let i = 0; i < spireLights.length; i++) {
      spireLights[i].intensity = 82 + 18 * Math.sin(t * 1.1 + i * 2.3);
    }

    /* ---- gate ---- */
    if (!gateOpen) {
      hexTex.offset.x -= dt * 0.06;
      hexTex.offset.y += dt * 0.012;
      let op = 0.42 + 0.14 * (0.5 + 0.5 * Math.sin(t * 1.9));
      if (gateOpening) {
        gateAnimT += dt / 2; // ~2s dissolve
        op *= clamp01(1 - gateAnimT);
        hexTex.offset.x -= dt * 0.4 * gateAnimT; // scroll frenzy while dissolving
        pylonMat.emissiveIntensity = 1.6 * clamp01(1 - gateAnimT);
        if (gateAnimT >= 1) {
          gateOpen = true; gateOpening = false;
          gateWall.visible = false;
          bus.emit('sfx', { name: 'emp' });
        }
      }
      gateMat.opacity = op;
    }

    /* ---- core pickups ---- */
    for (let i = 0; i < corePickups.length; i++) {
      const cp = corePickups[i];
      if (cp.taken) continue;
      cp.group.rotation.y += dt * 1.4;
      cp.group.position.y = cp.baseY + 1.2 + Math.sin(t * 1.5 + i * 2) * 0.3;
      if (G.player && cp.group.position.distanceTo(pp) < 2.5) {
        cp.taken = true;
        scene.remove(cp.group);
        S.cores++;
        bus.emit('core:pickup', { pos: cp.pos });
        bus.emit('sfx', { name: 'pickup' });
      }
    }

    /* ---- smoke + fires + holo (cosmetic jitter → Math.random OK) ---- */
    for (let i = 0; i < smokeSprites.length; i++) {
      const sm = smokeSprites[i];
      sm.age += dt * sm.rate * 2;
      if (sm.age > 1) sm.age -= 1;
      const a = sm.age;
      sm.spr.position.set(
        sm.x + sm.drift * a * 4 + Math.sin(t * 0.6 + i) * 0.4 * a,
        sm.baseY + a * 15,
        sm.z + Math.cos(t * 0.5 + i * 1.7) * 0.4 * a);
      const sc = 1.6 + a * 7;
      sm.spr.scale.set(sc, sc, 1);
      sm.spr.material.opacity = 0.34 * Math.sin(a * Math.PI);
    }
    for (let i = 0; i < fires.length; i++) {
      const f = fires[i];
      f.mesh.scale.set(1 + Math.random() * 0.22, 1.4 + Math.random() * 0.35, 1 + Math.random() * 0.22);
      if (f.light) f.light.intensity = 20 + Math.random() * 12;
    }
    holoRing.rotation.z += dt * 1.2;
    holoRing.position.y = 2.1 + Math.sin(t * 1.1) * 0.12;

    /* ---- zone crossing (0.6s dwell to avoid boundary flapping) ---- */
    if (G.player) {
      const zNow = zoneAt(pp.x, pp.z);
      if (zNow !== S.zone) {
        if (zNow === pendingZone) {
          pendingT += dt;
          if (pendingT > 0.6) {
            S.zone = zNow;
            pendingZone = null;
            bus.emit('zone:enter', { zone: zNow });
          }
        } else { pendingZone = zNow; pendingT = 0; }
      } else { pendingZone = null; }
    }
  }

  /* ============================== API ============================== */
  return {
    update,
    getGroundHeight,
    zoneAt,
    resolveCollisions,
    nodes,
    openSpireGate,
    get spireGateOpen() { return gateOpen; },
    setSecondSunShadow,
    setSporeDensity,
    positions,
  };
}
