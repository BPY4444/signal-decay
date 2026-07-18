// SIGNAL DECAY — core: event bus, input, global state, difficulty, seeded rng/noise, texture helpers.
// This file is the only module every system may import. See CONTRACT.md §2.
import * as THREE from 'three';

/* ---------------- event bus ---------------- */
export const bus = {
  _l: new Map(),
  on(name, fn) {
    if (!this._l.has(name)) this._l.set(name, []);
    this._l.get(name).push(fn);
    return fn;
  },
  off(name, fn) {
    const a = this._l.get(name);
    if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  },
  emit(name, payload) {
    const a = this._l.get(name);
    if (a) for (let i = 0; i < a.length; i++) {
      try { a[i](payload); } catch (err) { console.error(`[bus:${name}]`, err); }
    }
  },
};

/* ---------------- difficulty ---------------- */
export const DIFF = {
  easy:     { arcWidth: 1.5, sweep: 0.75, reboot: 35 },
  standard: { arcWidth: 1.0, sweep: 1.0,  reboot: 25 },
  hard:     { arcWidth: 0.6, sweep: 1.3,  reboot: 18 },
};
export function diff() { return DIFF[S.difficulty] || DIFF.standard; }

/* ---------------- global state ---------------- */
export const S = {
  time: 0,
  paused: false,
  mode: 'play',            // 'play' | 'hack' | 'menu' | 'build' | 'drone' | 'orbital' | 'end'
  difficulty: 'standard',
  zone: 'crashfield',
  wreckTier: 1,
  cores: 0,
  salvage: { alloy: 0, circuits: 0, cells: 0 },
  grenades: 0,
  xp: 0, level: 1,
  machines: [],
  captured: [],
  stats: { destroyed: 0, captured: 0, hacksFailed: 0, deaths: 0 },
  weapon: 1,
  crosshairTarget: null,
  interactTarget: null,
  mounted: null,
  piloting: null,
  night: 0,
  danger: 0,
  won: false,
  nearFabricator: false,
  nearConsole: false,
  flags: {},
};

/* ---------------- seeded rng + noise ---------------- */
let _seed = 1337 >>> 0;
export function rng() {
  _seed |= 0; _seed = (_seed + 0x6D2B79F5) | 0;
  let t = Math.imul(_seed ^ (_seed >>> 15), 1 | _seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export function rngRange(a, b) { return a + rng() * (b - a); }
export function rngInt(a, b) { return Math.floor(rngRange(a, b + 1)); }
export function rngPick(arr) { return arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))]; }

// deterministic hash-based value noise (independent of rng stream)
function hash2(x, y) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (((h ^ (h >>> 16)) >>> 0) / 4294967296) * 2 - 1;
}
function smooth(t) { return t * t * (3 - 2 * t); }
export function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  const u = smooth(xf), v = smooth(yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export function fbm2(x, y, oct = 4) {
  let amp = 0.5, f = 1, sum = 0, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += amp * noise2(x * f, y * f);
    norm += amp; amp *= 0.5; f *= 2.02;
  }
  return sum / norm;
}

/* ---------------- math helpers ---------------- */
export function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function damp(a, b, lambda, dt) { return lerp(a, b, 1 - Math.exp(-lambda * dt)); }
export function angleLerp(a, b, t) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
export function dist2d(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return Math.hypot(dx, dz); }

/* ---------------- canvas texture helpers ---------------- */
export function makeCanvasTexture(size, drawFn, { srgb = true, repeat = true } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  drawFn(ctx, size);
  const tex = new THREE.CanvasTexture(c);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { tex.wrapS = tex.wrapT = THREE.RepeatWrapping; }
  tex.anisotropy = 4;
  return tex;
}

// normal map from fbm height noise
export function makeNoiseNormalMap(size = 256, scale = 8, strength = 1.2) {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      h[y * size + x] = fbm2(x / size * scale, y / size * scale, 4);
  return makeCanvasTexture(size, (ctx, s) => {
    const img = ctx.createImageData(s, s);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const xl = h[y * s + ((x - 1 + s) % s)], xr = h[y * s + ((x + 1) % s)];
        const yu = h[((y - 1 + s) % s) * s + x], yd = h[((y + 1) % s) * s + x];
        let nx = (xl - xr) * strength, ny = (yu - yd) * strength, nz = 1;
        const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
        const i = (y * s + x) * 4;
        img.data[i] = (nx * 0.5 + 0.5) * 255;
        img.data[i + 1] = (ny * 0.5 + 0.5) * 255;
        img.data[i + 2] = (nz * 0.5 + 0.5) * 255;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, { srgb: false });
}

/* ---------------- input ---------------- */
export const input = {
  _held: new Set(),
  _pressed: new Set(),
  mouseDX: 0, mouseDY: 0,
  mouse0: false, mouse2: false,
  mouse0Pressed: false, mouse2Pressed: false,
  pointerLocked: false,
  _firstFired: false,

  key(code) { return this._held.has(code); },
  pressed(code) { return this._pressed.has(code); },
  consume(code) { this._held.delete(code); this._pressed.delete(code); },
  endFrame() {
    this._pressed.clear();
    this.mouse0Pressed = false; this.mouse2Pressed = false;
    this.mouseDX = 0; this.mouseDY = 0;
  },
};

const PREVENT = new Set(['Tab', 'Space', 'KeyQ', 'ControlLeft', 'ControlRight']);

export function initInput() {
  const canvas = document.getElementById('game');

  window.addEventListener('keydown', (e) => {
    if (PREVENT.has(e.code)) e.preventDefault();
    if (!e.repeat) {
      input._held.add(e.code);
      input._pressed.add(e.code);
      fireFirst();
    }
  });
  window.addEventListener('keyup', (e) => { input._held.delete(e.code); });
  window.addEventListener('blur', () => { input._held.clear(); });

  canvas.addEventListener('mousedown', (e) => {
    fireFirst();
    if (!input.pointerLocked && (S.mode === 'play' || S.mode === 'build')) {
      canvas.requestPointerLock();
    }
    if (e.button === 0) { input.mouse0 = true; input.mouse0Pressed = true; }
    if (e.button === 2) { input.mouse2 = true; input.mouse2Pressed = true; }
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) input.mouse0 = false;
    if (e.button === 2) input.mouse2 = false;
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault());
  window.addEventListener('mousemove', (e) => {
    if (input.pointerLocked) {
      input.mouseDX += e.movementX || 0;
      input.mouseDY += e.movementY || 0;
    }
  });
  document.addEventListener('pointerlockchange', () => {
    const was = input.pointerLocked;
    input.pointerLocked = document.pointerLockElement === canvas;
    if (was && !input.pointerLocked) bus.emit('pointerlock:lost', {});
  });

  function fireFirst() {
    if (!input._firstFired) { input._firstFired = true; bus.emit('input:first', {}); }
  }
}

export function lockPointer() {
  const canvas = document.getElementById('game');
  if (!input.pointerLocked) canvas.requestPointerLock();
}
export function unlockPointer() {
  if (input.pointerLocked) document.exitPointerLock();
}
