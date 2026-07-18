// SIGNAL DECAY — audio: WebAudio-synthesized ambient drone, wind, combat layer, all SFX.
// CONTRACT §4-audio. No audio files; every sound built from oscillators/noise at runtime.
import { bus, S, clamp, lerp } from './core.js';

export function initAudio(G) {
  let ctx = null;
  try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { /* no audio */ }
  if (!ctx) return { update() {} };

  const master = ctx.createGain();
  master.gain.value = 0.5;
  master.connect(ctx.destination);

  bus.on('input:first', () => { ctx.resume().catch(() => {}); });

  const now = () => ctx.currentTime;

  /* ---------------- shared noise buffer ---------------- */
  const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  {
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  function noiseSource() {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    return src;
  }

  /* ---------------- ambient drone pad ---------------- */
  // zone voicings: [root, interval ratio, filter cutoff, level]
  const ZONES = {
    crashfield: { root: 82.4, ratio: 1.26, cutoff: 520, level: 0.055 },   // warm maj-3rd-ish
    drysea:     { root: 73.4, ratio: 1.5,  cutoff: 380, level: 0.05 },    // hollow fifth
    spire:      { root: 61.7, ratio: 1.067, cutoff: 240, level: 0.06 },   // dark minor 2nd
  };
  const padGain = ctx.createGain(); padGain.gain.value = 0;
  const padFilter = ctx.createBiquadFilter();
  padFilter.type = 'lowpass'; padFilter.frequency.value = 480; padFilter.Q.value = 1.2;
  const padDelay = ctx.createDelay(1.0); padDelay.delayTime.value = 0.31;
  const padFb = ctx.createGain(); padFb.gain.value = 0.35;
  padFilter.connect(padGain);
  padGain.connect(master);
  padGain.connect(padDelay); padDelay.connect(padFb); padFb.connect(padDelay);
  padFb.connect(master);

  const padOscs = [];
  [['sawtooth', 1, 0.5], ['sawtooth', 1.007, 0.5], ['triangle', 2.0, 0.7]].forEach(([type, mult, g]) => {
    const o = ctx.createOscillator(); o.type = type;
    const og = ctx.createGain(); og.gain.value = g;
    o.frequency.value = 82.4 * mult;
    o.connect(og); og.connect(padFilter);
    o.start();
    padOscs.push({ o, mult });
  });
  // slow filter sweep LFO
  const padLfo = ctx.createOscillator(); padLfo.frequency.value = 0.05;
  const padLfoG = ctx.createGain(); padLfoG.gain.value = 140;
  padLfo.connect(padLfoG); padLfoG.connect(padFilter.frequency); padLfo.start();

  /* ---------------- wind ---------------- */
  const wind = noiseSource();
  const windFilter = ctx.createBiquadFilter();
  windFilter.type = 'bandpass'; windFilter.frequency.value = 600; windFilter.Q.value = 0.6;
  const windGain = ctx.createGain(); windGain.gain.value = 0.03;
  wind.connect(windFilter); windFilter.connect(windGain); windGain.connect(master);
  wind.start();

  /* ---------------- combat tension layer ---------------- */
  const combatGain = ctx.createGain(); combatGain.gain.value = 0;
  combatGain.connect(master);
  const throb = ctx.createOscillator(); throb.type = 'square'; throb.frequency.value = 55;
  const throbAmp = ctx.createGain(); throbAmp.gain.value = 0;
  const throbLfo = ctx.createOscillator(); throbLfo.frequency.value = 2;
  const throbLfoG = ctx.createGain(); throbLfoG.gain.value = 0.5;
  throbLfo.connect(throbLfoG); throbLfoG.connect(throbAmp.gain);
  const throbFilt = ctx.createBiquadFilter(); throbFilt.type = 'lowpass'; throbFilt.frequency.value = 220;
  throb.connect(throbAmp); throbAmp.connect(throbFilt); throbFilt.connect(combatGain);
  throb.start(); throbLfo.start();
  const riser = ctx.createOscillator(); riser.type = 'sine'; riser.frequency.value = 80;
  const riserG = ctx.createGain(); riserG.gain.value = 0.12;
  riser.connect(riserG); riserG.connect(combatGain);
  riser.start();
  let riserT = 0;

  /* ---------------- synth helpers ---------------- */
  function tone({ freq = 440, freqEnd = null, type = 'sine', dur = 0.15, gain = 0.2, attack = 0.005, pan = 0, filter = null }) {
    const t = now();
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (freqEnd != null) o.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let head = o;
    if (filter) {
      const f = ctx.createBiquadFilter(); f.type = filter.type || 'lowpass';
      f.frequency.value = filter.freq || 800; f.Q.value = filter.q || 1;
      o.connect(f); head = f;
    }
    let out = g;
    if (pan) { const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); out = p; }
    head.connect(g); out.connect(master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  function burst({ dur = 0.12, gain = 0.25, filterFreq = 1400, filterType = 'lowpass', q = 0.8, freqEnd = null, pan = 0 }) {
    const t = now();
    const src = noiseSource();
    const f = ctx.createBiquadFilter(); f.type = filterType; f.frequency.setValueAtTime(filterFreq, t); f.Q.value = q;
    if (freqEnd != null) f.frequency.exponentialRampToValueAtTime(Math.max(30, freqEnd), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let out = g;
    if (pan) { const p = ctx.createStereoPanner(); p.pan.value = pan; g.connect(p); out = p; }
    src.connect(f); f.connect(g); out.connect(master);
    src.start(t); src.stop(t + dur + 0.05);
  }

  function arp(freqs, step = 0.07, opts = {}) {
    freqs.forEach((f, i) => setTimeout(() => tone({ freq: f, type: 'triangle', dur: 0.18, gain: 0.16, ...opts }), i * step * 1000));
  }

  /* ---------------- arc caster loop ---------------- */
  let arcNodes = null;
  function arcOn() {
    if (arcNodes) return;
    const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 780;
    const o2 = ctx.createOscillator(); o2.type = 'sawtooth'; o2.frequency.value = 792;
    const nz = noiseSource();
    const nf = ctx.createBiquadFilter(); nf.type = 'highpass'; nf.frequency.value = 3000;
    const g = ctx.createGain(); g.gain.value = 0;
    g.gain.setTargetAtTime(0.05, now(), 0.03);
    const lfo = ctx.createOscillator(); lfo.frequency.value = 13;
    const lg = ctx.createGain(); lg.gain.value = 0.02;
    lfo.connect(lg); lg.connect(g.gain);
    o1.connect(g); o2.connect(g); nz.connect(nf); nf.connect(g); g.connect(master);
    o1.start(); o2.start(); nz.start(); lfo.start();
    arcNodes = { stop() { g.gain.setTargetAtTime(0, now(), 0.04); setTimeout(() => { try { o1.stop(); o2.stop(); nz.stop(); lfo.stop(); } catch (_) {} }, 250); } };
  }
  function arcOff() { if (arcNodes) { arcNodes.stop(); arcNodes = null; } }
  bus.on('arc:on', arcOn);
  bus.on('arc:off', arcOff);

  /* ---------------- sfx dispatch ---------------- */
  const SFX = {
    shot() { burst({ dur: 0.09, gain: 0.22, filterFreq: 2400, freqEnd: 300 }); tone({ freq: 180, freqEnd: 70, type: 'square', dur: 0.07, gain: 0.12 }); },
    emp() { tone({ freq: 900, freqEnd: 80, type: 'sawtooth', dur: 0.5, gain: 0.2 }); burst({ dur: 0.45, gain: 0.14, filterFreq: 900, freqEnd: 120 }); },
    hit() { tone({ freq: 320, freqEnd: 140, type: 'triangle', dur: 0.06, gain: 0.14 }); },
    hackTick() { tone({ freq: 1250, type: 'square', dur: 0.05, gain: 0.12 }); },
    hackGood() { arp([523, 784, 1046]); },
    hackFail() { tone({ freq: 300, freqEnd: 90, type: 'sawtooth', dur: 0.45, gain: 0.2, filter: { type: 'lowpass', freq: 900 } }); },
    alarm() { [0, 0.22, 0.44].forEach((d, i) => setTimeout(() => { tone({ freq: 700, type: 'square', dur: 0.1, gain: 0.12 }); tone({ freq: 950, type: 'square', dur: 0.1, gain: 0.12, attack: 0.05 }); }, d * 1000)); },
    levelup() { arp([440, 554, 659, 880], 0.08); },
    ui() { tone({ freq: 880, type: 'sine', dur: 0.05, gain: 0.08 }); },
    capture() { arp([392, 494, 587, 784], 0.1, { dur: 0.4, gain: 0.12 }); },
    mount() { tone({ freq: 220, freqEnd: 520, type: 'sawtooth', dur: 0.25, gain: 0.1, filter: { type: 'lowpass', freq: 1200 } }); },
    turret() { burst({ dur: 0.06, gain: 0.1, filterFreq: 1800, freqEnd: 400 }); },
    slam() { tone({ freq: 48, freqEnd: 30, type: 'sine', dur: 0.5, gain: 0.4 }); burst({ dur: 0.35, gain: 0.2, filterFreq: 500, freqEnd: 60 }); },
    stomp() { tone({ freq: 70, freqEnd: 38, type: 'sine', dur: 0.3, gain: 0.3 }); },
    dive() { tone({ freq: 1400, freqEnd: 250, type: 'sawtooth', dur: 0.8, gain: 0.07, filter: { type: 'lowpass', freq: 2000 } }); },
    harvest() { tone({ freq: 660, type: 'sine', dur: 0.06, gain: 0.09 }); setTimeout(() => tone({ freq: 990, type: 'sine', dur: 0.06, gain: 0.09 }), 80); },
    pickup() { arp([784, 1175], 0.06); },
    death() { burst({ dur: 0.35, gain: 0.25, filterFreq: 1200, freqEnd: 100 }); tone({ freq: 140, freqEnd: 40, type: 'square', dur: 0.3, gain: 0.12 }); },
    playerHurt() { tone({ freq: 120, freqEnd: 60, type: 'sine', dur: 0.2, gain: 0.3 }); burst({ dur: 0.15, gain: 0.1, filterFreq: 700, filterType: 'highpass' }); },
    jump() { tone({ freq: 300, freqEnd: 420, type: 'sine', dur: 0.1, gain: 0.05 }); },
  };
  bus.on('sfx', (p) => {
    if (!p || !SFX[p.name] || ctx.state !== 'running') return;
    try { SFX[p.name](p); } catch (_) {}
  });

  /* ---------------- update: crossfades + gusts + distant one-shots ---------------- */
  let tick = 0;
  let curZone = null;
  let distantT = 20;

  function update(dt) {
    tick -= dt;
    riserT += dt;
    if (riserT > 8) { riserT = 0; if (S.danger > 0.3) { riser.frequency.setValueAtTime(80, now()); riser.frequency.exponentialRampToValueAtTime(320, now() + 8); } }
    if (tick > 0) return;
    tick = 0.25; // 4Hz control rate
    if (ctx.state !== 'running') return;

    const t = now();

    // zone pad voicing (4s glide) + night dim
    const z = ZONES[S.zone] || ZONES.crashfield;
    if (curZone !== S.zone) {
      curZone = S.zone;
      padOscs.forEach(({ o, mult }, i) => {
        const f = i === 1 ? z.root * z.ratio : z.root * mult;
        o.frequency.setTargetAtTime(f, t, 2.0);
      });
      padFilter.frequency.setTargetAtTime(z.cutoff, t, 2.0);
    }
    const nightMul = 1 - 0.3 * S.night;
    padGain.gain.setTargetAtTime(z.level * nightMul, t, 1.5);
    padFilter.Q.setTargetAtTime(1.2 + S.night * 1.6, t, 2.0);

    // wind gusts
    const gust = 0.02 + Math.random() * 0.035;
    windGain.gain.setTargetAtTime(gust, t, 1.2);
    windFilter.frequency.setTargetAtTime(400 + Math.random() * 500, t, 1.5);

    // combat layer
    const target = S.danger > 0.3 ? 0.22 : 0;
    combatGain.gain.setTargetAtTime(target, t, target > 0 ? 0.4 : 1.2);
    throbAmp.gain.setTargetAtTime(target > 0 ? 0.5 : 0, t, 0.5);

    // sparse distant machine sounds — loneliness
    distantT -= 0.25;
    if (distantT <= 0) {
      distantT = 15 + Math.random() * 25;
      const pan = Math.random() * 1.6 - 0.8;
      if (Math.random() < 0.5) tone({ freq: 180 + Math.random() * 200, freqEnd: 90, type: 'sine', dur: 1.2, gain: 0.025, pan });
      else burst({ dur: 0.6, gain: 0.02, filterFreq: 300 + Math.random() * 400, q: 6, pan });
    }
  }

  return { update };
}
