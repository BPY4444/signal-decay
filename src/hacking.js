// SIGNAL DECAY — hacking: radial WRECK intrusion minigame on #hack-radial/#hack-canvas.
// Contract: §4-hacking. Owns the hack DOM entirely. Emits hack:start/success/fail.
import { bus, S, input, diff, clamp } from './core.js';

const SIZE = 480;
const CX = SIZE / 2, CY = SIZE / 2;
const R_BAND = 186;          // radius of the target-arc band
const BAND_W = 24;           // band stroke width
const R_TICK_IN = 208, R_TICK_OUT = 220;
const ARC_BASE_DEG = 28;     // base arc width, degrees
const SWEEP_BASE_DEG = 140;  // base sweep speed, deg/s
const EDGE_GRACE = 2.5;      // degrees of forgiveness on arc edges
const INTRO_T = 0.5;         // sync-up delay before the sweep runs

const CYAN = '#4be8ff';
const CYAN_DIM = '#2a97ad';
const AMBER = '#ffb545';
const VIOLET = '#b47aff';
const RED = '#ff4d4d';

export function initHacking(G) {
  const panelEl = document.getElementById('hack-radial');
  const canvas = document.getElementById('hack-canvas');
  const hintEl = document.getElementById('hack-hint');
  let ctx = null, dpr = 1;
  if (canvas) {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    canvas.style.width = SIZE + 'px';
    canvas.style.height = SIZE + 'px';
    ctx = canvas.getContext('2d');
  }

  let round = null;   // { e, arcs:[{start,width,cleared,clearedT}], sweep, speed, intro, t }
  let after = null;   // post-result splash: { t, dur, color, text, sub }
  let ringRot = 0;    // aesthetic slow rotation applied uniformly to ring + arcs + sweep
  let flashes = [];   // [{t, dur, ang|null, color}] clear-blips + rings

  /* ---------------- angle helpers (game degrees: 0 = top, clockwise) ---------------- */
  function toRad(deg) { return (deg - 90 + ringRot) * Math.PI / 180; }
  function circDist(a, b) { let d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; }
  function cwFrom(from, to) { return ((to - from) % 360 + 360) % 360; }
  function crossed(from, delta, target) { const t = cwFrom(from, target); return t > 1e-4 && t <= delta; }
  function insideArc(ang, arc) {
    const rel = cwFrom(arc.start, ang);
    return rel <= arc.width + EDGE_GRACE || rel >= 360 - EDGE_GRACE;
  }

  /* ---------------- round construction ---------------- */
  function buildArcs(n, arcW) {
    // rejection-sample arc START angles so arc CENTERS keep >= max(35°, non-overlap) separation
    const sep = Math.max(35, arcW * 1.15);
    const starts = [];
    let tries = 0;
    while (starts.length < n && tries < 500) {
      tries++;
      const s = Math.random() * 360;
      let ok = true;
      for (let i = 0; i < starts.length; i++) {
        if (circDist(starts[i] + arcW / 2, s + arcW / 2) < sep) { ok = false; break; }
      }
      if (ok) starts.push(s);
    }
    // fallback: even spacing with jitter (guaranteed valid)
    while (starts.length < n) {
      starts.length = 0;
      const base = Math.random() * 360;
      const step = 360 / n;
      const jit = Math.max(0, (step - sep) * 0.45);
      for (let i = 0; i < n; i++) starts.push((base + i * step + (Math.random() * 2 - 1) * jit + 360) % 360);
    }
    return starts.map(s => ({ start: s, width: arcW, cleared: false, clearedT: 0 }));
  }

  function pickSweepStart(arcs) {
    // start the sweep clear of every arc, with lead room before the nearest one
    for (let tries = 0; tries < 120; tries++) {
      const a = Math.random() * 360;
      let ok = true;
      for (const arc of arcs) {
        const rel = cwFrom(arc.start, a);
        if (rel <= arc.width + 12 || rel >= 360 - 24) { ok = false; break; }
      }
      if (ok) return a;
    }
    return (arcs[0].start - 60 + 720) % 360;
  }

  function show() {
    if (panelEl) panelEl.classList.remove('hidden');
    if (hintEl) hintEl.textContent = 'SPACE — SEVER LOCK ON HIGHLIGHTED ARCS';
  }
  function hide() {
    if (panelEl) panelEl.classList.add('hidden');
  }

  /* ---------------- lifecycle ---------------- */
  function start(e) {
    if (round || after) return;
    if (!e || e.dying) return;
    const colossusOpen = e.type === 'colossus' && (e.hackWindow || 0) > 0;
    if (e.state !== 'DISABLED' && !colossusOpen) return;

    const d = diff(); // read LIVE — mid-session difficulty changes apply
    const arcW = ARC_BASE_DEG * d.arcWidth * (1 + 0.12 * ((S.wreckTier || 1) - 1));
    const n = clamp((e.cfg && e.cfg.hackArcs) || 2, 1, 8);
    const arcs = buildArcs(n, arcW);

    round = {
      e,
      arcs,
      sweep: pickSweepStart(arcs),
      speed: SWEEP_BASE_DEG * d.sweep,
      intro: INTRO_T,
      t: 0,
    };
    flashes.length = 0;
    e.hackLock = true;
    S.mode = 'hack';
    input.consume('Space');
    show();
    bus.emit('hack:start', { e });
    bus.emit('sfx', { name: 'ui' });
    draw();
  }

  function endRound() {
    if (!round) return null;
    const e = round.e;
    round = null;
    e.hackLock = false;
    if (S.mode === 'hack') S.mode = 'play';
    return e;
  }

  function succeed() {
    const e = endRound();
    if (!e) return;
    after = { t: 0, dur: 0.5, color: CYAN, text: 'LOCK SEVERED', sub: 'WRECK: INTRUSION COMPLETE' };
    flashes.push({ t: 0, dur: 0.5, ang: null, color: CYAN });
    bus.emit('hack:success', { e });
    bus.emit('sfx', { name: 'hackGood' });
  }

  function fail() {
    const e = endRound();
    if (!e) return;
    if (S.stats) S.stats.hacksFailed = (S.stats.hacksFailed || 0) + 1;
    after = { t: 0, dur: 0.5, color: RED, text: 'INTRUSION REJECTED', sub: 'TARGET REBOOTING — HOSTILE' };
    flashes.push({ t: 0, dur: 0.5, ang: null, color: RED });
    bus.emit('hack:fail', { e });
    bus.emit('sfx', { name: 'hackFail' });
    bus.emit('shake', { i: 0.2 });
  }

  function abortQuiet() {
    endRound();
    after = null;
    flashes.length = 0;
    hide();
  }

  // machine died or rebooted out from under us mid-hack → bail without penalty
  bus.on('machine:destroyed', (p) => {
    try { if (round && p && p.e === round.e) abortQuiet(); } catch (err) { /* never throw */ }
  });
  bus.on('machine:rebooted', (p) => {
    try { if (round && p && p.e === round.e) abortQuiet(); } catch (err) { /* never throw */ }
  });
  // a menu opening (or ESC dropping pointer lock) mid-hack bails the hack without penalty —
  // the paused loop would otherwise leave a frozen radial painted behind the panel
  bus.on('ui:open', (p) => {
    try { if (round && p && p.panel) abortQuiet(); } catch (err) { /* never throw */ }
  });
  bus.on('pointerlock:lost', () => {
    try { if (round) abortQuiet(); } catch (err) { /* never throw */ }
  });

  /* ---------------- per-frame ---------------- */
  function update(dt) {
    ringRot = (ringRot + dt * 4) % 360;
    for (let i = flashes.length - 1; i >= 0; i--) {
      flashes[i].t += dt;
      if (flashes[i].t >= flashes[i].dur) flashes.splice(i, 1);
    }

    if (after) {
      after.t += dt;
      if (after.t >= after.dur) { after = null; hide(); }
      else drawAfter();
      return;
    }
    if (!round) return;
    if (S.mode !== 'hack') { abortQuiet(); return; } // something external yanked the mode

    round.t += dt;
    for (const a of round.arcs) if (a.cleared) a.clearedT += dt;

    if (round.intro > 0) {
      round.intro -= dt;
      input.consume('Space'); // don't let buffered jumps sever a lock
      draw();
      return;
    }

    const prev = round.sweep;
    const delta = round.speed * dt;
    round.sweep = (round.sweep + delta) % 360;

    if (input.pressed('Space')) {
      input.consume('Space');
      let hit = null;
      for (const a of round.arcs) {
        if (!a.cleared && insideArc(round.sweep, a)) { hit = a; break; }
      }
      if (hit) {
        hit.cleared = true;
        hit.clearedT = 0;
        flashes.push({ t: 0, dur: 0.35, ang: hit.start + hit.width / 2, color: CYAN });
        bus.emit('sfx', { name: 'hackTick' });
        if (round.arcs.every(a => a.cleared)) { succeed(); return; }
      } else {
        fail();
        return;
      }
    }

    // sweep fully passed a live arc's trailing edge without a press → FAIL
    for (const a of round.arcs) {
      if (!a.cleared && crossed(prev, delta, (a.start + a.width) % 360)) { fail(); return; }
    }

    draw();
  }

  /* ---------------- drawing ---------------- */
  function resetTransform() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawBackplate() {
    // dark radial panel disc
    const g = ctx.createRadialGradient(CX, CY, 30, CX, CY, 238);
    g.addColorStop(0, 'rgba(9, 16, 26, 0.96)');
    g.addColorStop(0.72, 'rgba(7, 12, 22, 0.92)');
    g.addColorStop(0.94, 'rgba(10, 18, 30, 0.75)');
    g.addColorStop(1, 'rgba(10, 18, 30, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(CX, CY, 239, 0, Math.PI * 2);
    ctx.fill();

    // faint interior scan-rings
    ctx.strokeStyle = 'rgba(75,232,255,0.06)';
    ctx.lineWidth = 1;
    for (let r = 60; r <= 160; r += 34) {
      ctx.beginPath();
      ctx.arc(CX, CY, r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // outer rim, double line
    ctx.strokeStyle = 'rgba(75,232,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(CX, CY, 232, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(75,232,255,0.14)';
    ctx.beginPath(); ctx.arc(CX, CY, 226, 0, Math.PI * 2); ctx.stroke();

    // counter-rotating dashed accent ring
    ctx.save();
    ctx.translate(CX, CY);
    ctx.rotate(-ringRot * 2 * Math.PI / 180);
    ctx.strokeStyle = 'rgba(180,122,255,0.22)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 22]);
    ctx.beginPath(); ctx.arc(0, 0, 168, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  function drawTicks() {
    for (let i = 0; i < 72; i++) {
      const major = i % 6 === 0;
      const a = toRad(i * 5);
      const rIn = major ? R_TICK_IN - 4 : R_TICK_IN;
      ctx.strokeStyle = major ? 'rgba(75,232,255,0.5)' : 'rgba(75,232,255,0.18)';
      ctx.lineWidth = major ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(CX + Math.cos(a) * rIn, CY + Math.sin(a) * rIn);
      ctx.lineTo(CX + Math.cos(a) * R_TICK_OUT, CY + Math.sin(a) * R_TICK_OUT);
      ctx.stroke();
    }
  }

  function drawArc(arc) {
    const a0 = toRad(arc.start);
    const a1 = toRad(arc.start + arc.width);
    if (arc.cleared) {
      // dim violet, brief pop right after clearing
      const pop = clamp(1 - arc.clearedT / 0.3, 0, 1);
      ctx.save();
      ctx.strokeStyle = VIOLET;
      ctx.globalAlpha = 0.34 + pop * 0.5;
      ctx.lineWidth = BAND_W - 8 + pop * 10;
      ctx.shadowColor = VIOLET;
      ctx.shadowBlur = 6 + pop * 22;
      ctx.beginPath();
      ctx.arc(CX, CY, R_BAND, a0, a1);
      ctx.stroke();
      ctx.restore();
    } else {
      // live: cyan gradient band + glow + bright inner filament
      const mid = toRad(arc.start + arc.width / 2);
      const gx0 = CX + Math.cos(a0) * R_BAND, gy0 = CY + Math.sin(a0) * R_BAND;
      const gx1 = CX + Math.cos(a1) * R_BAND, gy1 = CY + Math.sin(a1) * R_BAND;
      const grad = ctx.createLinearGradient(gx0, gy0, gx1, gy1);
      grad.addColorStop(0, CYAN_DIM);
      grad.addColorStop(0.5, '#8ff4ff');
      grad.addColorStop(1, CYAN_DIM);
      const pulse = 0.82 + 0.18 * Math.sin(S.time * 6 + arc.start);
      ctx.save();
      ctx.strokeStyle = grad;
      ctx.globalAlpha = pulse;
      ctx.lineWidth = BAND_W;
      ctx.shadowColor = CYAN;
      ctx.shadowBlur = 20;
      ctx.beginPath();
      ctx.arc(CX, CY, R_BAND, a0, a1);
      ctx.stroke();
      // bright filament
      ctx.strokeStyle = '#dffbff';
      ctx.globalAlpha = pulse;
      ctx.lineWidth = 2.5;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(CX, CY, R_BAND, a0, a1);
      ctx.stroke();
      ctx.restore();
      // end-cap notches
      ctx.save();
      ctx.strokeStyle = CYAN;
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 2;
      for (const aa of [a0, a1]) {
        ctx.beginPath();
        ctx.moveTo(CX + Math.cos(aa) * (R_BAND - BAND_W / 2 - 5), CY + Math.sin(aa) * (R_BAND - BAND_W / 2 - 5));
        ctx.lineTo(CX + Math.cos(aa) * (R_BAND + BAND_W / 2 + 5), CY + Math.sin(aa) * (R_BAND + BAND_W / 2 + 5));
        ctx.stroke();
      }
      // chevron at arc center pointing inward
      const cxm = CX + Math.cos(mid) * (R_BAND - BAND_W / 2 - 14);
      const cym = CY + Math.sin(mid) * (R_BAND - BAND_W / 2 - 14);
      ctx.translate(cxm, cym);
      ctx.rotate(mid + Math.PI / 2);
      ctx.strokeStyle = CYAN;
      ctx.globalAlpha = 0.55 + 0.35 * Math.sin(S.time * 8);
      ctx.beginPath();
      ctx.moveTo(-5, 4); ctx.lineTo(0, -3); ctx.lineTo(5, 4);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawSweep(alpha) {
    const sw = round.sweep;
    // trail: fading amber segments behind the hand
    const TRAIL_DEG = 42, SEGS = 14;
    ctx.save();
    ctx.lineWidth = BAND_W - 4;
    ctx.lineCap = 'butt';
    for (let i = 0; i < SEGS; i++) {
      const f0 = i / SEGS, f1 = (i + 1) / SEGS;
      const s0 = toRad(sw - TRAIL_DEG * (1 - f0));
      const s1 = toRad(sw - TRAIL_DEG * (1 - f1));
      ctx.strokeStyle = AMBER;
      ctx.globalAlpha = alpha * 0.30 * f1 * f1;
      ctx.beginPath();
      ctx.arc(CX, CY, R_BAND, s0, s1);
      ctx.stroke();
    }
    ctx.restore();

    // hand
    const a = toRad(sw);
    const ca = Math.cos(a), sa = Math.sin(a);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 2.5;
    ctx.shadowColor = AMBER;
    ctx.shadowBlur = 14;
    ctx.beginPath();
    ctx.moveTo(CX + ca * 52, CY + sa * 52);
    ctx.lineTo(CX + ca * (R_TICK_OUT - 2), CY + sa * (R_TICK_OUT - 2));
    ctx.stroke();
    // hot head where the hand crosses the band
    ctx.fillStyle = '#ffe4ae';
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(CX + ca * R_BAND, CY + sa * R_BAND, 6, 0, Math.PI * 2);
    ctx.fill();
    // tail pommel
    ctx.fillStyle = AMBER;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(CX + ca * 52, CY + sa * 52, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawGlyph(e, cleared, total) {
    // rotating hex frame
    ctx.save();
    ctx.translate(CX, CY);
    ctx.rotate(ringRot * 0.5 * Math.PI / 180);
    ctx.strokeStyle = 'rgba(180,122,255,0.55)';
    ctx.lineWidth = 1.5;
    ctx.shadowColor = VIOLET;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3;
      const x = Math.cos(a) * 44, y = Math.sin(a) * 44;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    // text block (unrotated)
    const name = ((e.cfg && e.cfg.name) || e.type || 'MACHINE').toUpperCase();
    const cls = ((e.cfg && e.cfg.cls) || 'robotic').toUpperCase();
    const tier = (e.cfg && e.cfg.tier) || 1;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.shadowColor = CYAN;
    ctx.shadowBlur = 8;
    ctx.fillStyle = '#eafcff';
    ctx.font = '600 15px Consolas, Menlo, monospace';
    ctx.fillText(name, CX, CY - 14);
    ctx.shadowBlur = 4;
    ctx.fillStyle = CYAN_DIM;
    ctx.font = '10px Consolas, Menlo, monospace';
    ctx.fillText('T' + tier + ' // ' + cls, CX, CY + 2);
    ctx.shadowColor = VIOLET;
    ctx.fillStyle = VIOLET;
    ctx.fillText('WRECK T' + (S.wreckTier || 1), CX, CY + 17);
    // lock progress pips
    const pipW = 10, gap = 6;
    const x0 = CX - ((total * pipW + (total - 1) * gap) / 2);
    for (let i = 0; i < total; i++) {
      const done = i < cleared;
      ctx.shadowColor = done ? CYAN : 'transparent';
      ctx.shadowBlur = done ? 8 : 0;
      ctx.fillStyle = done ? CYAN : 'rgba(75,232,255,0.18)';
      ctx.fillRect(x0 + i * (pipW + gap), CY + 30, pipW, 4);
    }
    ctx.restore();
  }

  function drawFlashes() {
    for (const f of flashes) {
      const k = f.t / f.dur;
      const fade = 1 - k;
      ctx.save();
      if (f.ang == null) {
        // full result ring expanding from the band
        ctx.strokeStyle = f.color;
        ctx.globalAlpha = fade * 0.8;
        ctx.lineWidth = 3 + fade * 5;
        ctx.shadowColor = f.color;
        ctx.shadowBlur = 24;
        ctx.beginPath();
        ctx.arc(CX, CY, R_BAND + k * 46, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        // clear-blip at the severed arc
        const a = toRad(f.ang);
        const x = CX + Math.cos(a) * R_BAND, y = CY + Math.sin(a) * R_BAND;
        ctx.fillStyle = '#ffffff';
        ctx.globalAlpha = fade;
        ctx.shadowColor = f.color;
        ctx.shadowBlur = 26;
        ctx.beginPath();
        ctx.arc(x, y, 5 + k * 18, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }

  function draw() {
    if (!ctx || !round) return;
    resetTransform();
    ctx.clearRect(0, 0, SIZE, SIZE);
    drawBackplate();
    drawTicks();

    const introK = round.intro > 0 ? 1 - round.intro / INTRO_T : 1;
    for (const arc of round.arcs) drawArc(arc);
    drawSweep(0.25 + 0.75 * introK);
    drawFlashes();

    const total = round.arcs.length;
    const cleared = round.arcs.reduce((n, a) => n + (a.cleared ? 1 : 0), 0);
    drawGlyph(round.e, cleared, total);

    if (round.intro > 0) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.fillStyle = AMBER;
      ctx.globalAlpha = 0.5 + 0.5 * Math.sin(S.time * 14);
      ctx.font = '11px Consolas, Menlo, monospace';
      ctx.shadowColor = AMBER;
      ctx.shadowBlur = 8;
      ctx.fillText('SYNCHRONIZING…', CX, CY + 58);
      ctx.restore();
    }

    // faint cosmetic interference line (per-frame jitter is fine here)
    ctx.save();
    ctx.globalAlpha = 0.05 + Math.random() * 0.04;
    ctx.strokeStyle = CYAN;
    ctx.lineWidth = 1;
    const ly = Math.random() * SIZE;
    ctx.beginPath();
    ctx.moveTo(CX - 200, ly);
    ctx.lineTo(CX + 200, ly);
    ctx.stroke();
    ctx.restore();
  }

  function drawAfter() {
    if (!ctx || !after) return;
    resetTransform();
    ctx.clearRect(0, 0, SIZE, SIZE);
    const fade = 1 - after.t / after.dur;
    ctx.save();
    ctx.globalAlpha = fade;
    drawBackplate();
    drawTicks();
    ctx.restore();
    drawFlashes();
    ctx.save();
    ctx.globalAlpha = Math.min(1, fade * 1.6);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = after.color;
    ctx.shadowColor = after.color;
    ctx.shadowBlur = 16;
    ctx.font = '600 20px Consolas, Menlo, monospace';
    ctx.fillText(after.text, CX, CY - 8);
    ctx.shadowBlur = 6;
    ctx.font = '11px Consolas, Menlo, monospace';
    ctx.globalAlpha = Math.min(1, fade * 1.2) * 0.8;
    ctx.fillText(after.sub, CX, CY + 16);
    ctx.restore();
  }

  return {
    update,
    start,
    get active() { return !!round; },
    get round() { return round; },   // read-only debug/telemetry view of the live round
  };
}
