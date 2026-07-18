// SIGNAL DECAY — engine: renderer, gameplay camera, post stack, screen shake, perf watchdog.
// CONTRACT §4-engine. Owns #game canvas GL context; world/player place the camera, we only
// perturb it (shake) inside render() and restore afterwards.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { bus, clamp } from './core.js';

const VignetteShader = {
  name: 'SDVignette',
  uniforms: {
    tDiffuse: { value: null },
    strength: { value: 0.35 },
    tint: { value: new THREE.Color(0x0a0614) }, // deep violet edge, per palette
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float strength;
    uniform vec3 tint;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      vec2 d = (vUv - 0.5) * vec2(1.15, 1.0);
      float r = length(d) * 1.4142;
      float vig = strength * smoothstep(0.55, 1.35, r);
      c.rgb = mix(c.rgb, tint * 0.15, vig);
      gl_FragColor = c;
    }`,
};

export function initEngine(G) {
  const canvas = document.getElementById('game');
  // ?gfx=low — potato/headless preset: no shadows, no SSAO, half-res pipeline. Logic unchanged.
  const gfxLow = new URLSearchParams(location.search).get('gfx') === 'low';
  G.gfxLow = gfxLow;

  /* ---------------- renderer ---------------- */
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
    stencil: false,
  });
  const pixelRatio = gfxLow ? 0.5 : Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = !gfxLow;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  /* ---------------- scene + camera ---------------- */
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14091f); // fallback until world installs the sky
  const camera = new THREE.PerspectiveCamera(
    70, window.innerWidth / window.innerHeight, 0.1, 900);
  camera.position.set(0, 6, 12);
  scene.add(camera); // so camera-attached objects (muzzle flash, etc.) render

  /* ---------------- post stack: Render → SSAO → Bloom → Vignette → Output ---------------- */
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(window.innerWidth, window.innerHeight);

  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  let bloomPass = null;
  try {
    bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight), 0.55, 0.4, 0.85);
    composer.addPass(bloomPass);
  } catch (err) {
    console.warn('[engine] bloom unavailable', err);
  }

  let vignettePass = null;
  try {
    vignettePass = new ShaderPass(VignetteShader);
    composer.addPass(vignettePass);
  } catch (err) {
    console.warn('[engine] vignette unavailable', err);
  }

  try {
    composer.addPass(new OutputPass());
  } catch (err) {
    console.warn('[engine] output pass unavailable', err);
  }

  // SSAO loaded async so a missing/broken addon can never break boot; inserted
  // right after RenderPass to match contract order (Render → SSAO → Bloom → ...).
  let ssaoPass = null;
  if (!gfxLow) import('three/addons/postprocessing/SSAOPass.js')
    .then(({ SSAOPass }) => {
      try {
        const pass = new SSAOPass(scene, camera, window.innerWidth, window.innerHeight);
        // half-res: EffectComposer re-calls setSize with full buffer size on add/resize,
        // so wrap setSize to keep the 0.5 scale sticky.
        const orig = pass.setSize.bind(pass);
        pass.setSize = (w, h) => orig(Math.max(1, Math.floor(w * 0.5)), Math.max(1, Math.floor(h * 0.5)));
        pass.kernelRadius = 0.85;
        pass.minDistance = 0.0008;
        pass.maxDistance = 0.06;
        pass.output = SSAOPass.OUTPUT.Default;
        if (degradeStep >= 2) pass.enabled = false; // watchdog already cut SSAO before it loaded
        const i = composer.passes.indexOf(renderPass);
        composer.insertPass(pass, i + 1); // insertPass sizes the pass from composer buffers
        ssaoPass = pass;
      } catch (err) {
        console.warn('[engine] SSAO unavailable, skipping', err);
      }
    })
    .catch((err) => console.warn('[engine] SSAO addon failed to load, skipping', err));

  /* ---------------- resize ---------------- */
  let bloomScale = 1; // watchdog step 4 halves this; never below 0.5, bloom never removed
  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    composer.setSize(w, h);
    if (bloomPass) {
      try { bloomPass.setSize(w * bloomScale, h * bloomScale); } catch (_) {}
    }
  }
  window.addEventListener('resize', resize);

  /* ---------------- screen shake (trauma model) ---------------- */
  let trauma = 0;
  const TRAUMA_DECAY = 2.2;         // per second
  const SHAKE_POS = 0.32;           // meters at full shake
  const SHAKE_ROT = 0.035;          // radians at full shake
  const savedPos = new THREE.Vector3();
  const savedQuat = new THREE.Quaternion();
  const eulerScratch = new THREE.Euler();
  const quatScratch = new THREE.Quaternion();

  function shake(intensity) {
    const i = typeof intensity === 'number' && isFinite(intensity) ? intensity : 0;
    trauma = clamp(trauma + i, 0, 1.5);
  }
  bus.on('shake', (p) => {
    try { shake(p && typeof p === 'object' ? p.i : p); } catch (_) {}
  });

  /* ---------------- perf watchdog ---------------- */
  const perf = { fps: 60 };
  let winTime = 0, winFrames = 0;   // rolling 2s window
  let lowTime = 0;                  // continuous seconds below 45fps
  let degradeStep = 0;              // 0..4, one-way ladder, never re-upgrades
  const stepNames = [
    'full quality',
    'secondary sun shadow off',
    'SSAO off',
    'spore density halved',
    'bloom half resolution',
  ];

  function setQualityNote() {
    console.info(`[engine] quality: ${stepNames[degradeStep]} (avg ${perf.fps.toFixed(0)} fps)`);
  }

  function degrade() {
    if (degradeStep >= 4) return;
    degradeStep++;
    try {
      if (degradeStep === 1) {
        G.world?.setSecondSunShadow?.(false);
      } else if (degradeStep === 2) {
        if (ssaoPass) ssaoPass.enabled = false; // if not loaded yet, load hook checks degradeStep
      } else if (degradeStep === 3) {
        G.world?.setSporeDensity?.(0.5);
      } else if (degradeStep === 4) {
        bloomScale = 0.5;
        if (bloomPass) bloomPass.setSize(window.innerWidth * 0.5, window.innerHeight * 0.5);
      }
    } catch (err) {
      console.warn('[engine] degrade step failed', err);
    }
    setQualityNote();
  }

  function tickWatchdog(dt) {
    winTime += dt; winFrames++;
    if (winTime >= 2) {
      perf.fps = winFrames / winTime;
      winTime = 0; winFrames = 0;
    }
    if (perf.fps < 45 && degradeStep < 4) {
      lowTime += dt;
      if (lowTime >= 4) { degrade(); lowTime = 0; }
    } else {
      lowTime = 0;
    }
  }

  /* ---------------- render ---------------- */
  function render(dt) {
    if (!(dt >= 0) || dt > 1) dt = 0.016;
    tickWatchdog(dt);

    // shake: perturb AFTER controllers placed the camera, restore after composer runs
    const shaking = trauma > 0.001;
    if (shaking) {
      const amt = trauma * trauma; // trauma² feel curve
      savedPos.copy(camera.position);
      savedQuat.copy(camera.quaternion);
      camera.position.x += (Math.random() * 2 - 1) * SHAKE_POS * amt;
      camera.position.y += (Math.random() * 2 - 1) * SHAKE_POS * amt;
      camera.position.z += (Math.random() * 2 - 1) * SHAKE_POS * amt * 0.4;
      eulerScratch.set(
        (Math.random() * 2 - 1) * SHAKE_ROT * amt,
        (Math.random() * 2 - 1) * SHAKE_ROT * amt,
        (Math.random() * 2 - 1) * SHAKE_ROT * amt * 1.5);
      camera.quaternion.multiply(quatScratch.setFromEuler(eulerScratch));
      trauma = Math.max(0, trauma - TRAUMA_DECAY * dt);
    }

    try {
      composer.render(dt);
    } catch (err) {
      // a broken pass must never kill the frame — fall back to raw render
      try { renderer.render(scene, camera); } catch (_) {}
      console.warn('[engine] composer failed, raw render fallback', err);
    }

    if (shaking) {
      camera.position.copy(savedPos);
      camera.quaternion.copy(savedQuat);
    }
  }

  return { renderer, scene, camera, render, shake, setQualityNote, perf };
}
