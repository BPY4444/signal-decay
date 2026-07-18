// SIGNAL DECAY — WRECK's voice: ≥40 barks wired to bus triggers. CONTRACT §4-barks.
// WRECK: Wideband Reconnaissance & Exploit Construction Kernel. Ancient, vastly smarter
// than you, bored, contemptuous of human engineering, reluctantly loyal.
import { bus, S, rngPick } from './core.js';

const B = {
  intro: [
    "Systems check: you survived a lithobraking maneuver your species calls 'crashing'. I survived ninety thousand years in the dirt. We are not the same.",
  ],
  scan: {
    drifter: "Drifter-class scout. It doesn't fight, it tattles. Silence it fast or meet everyone it knows.",
    skitter: "A Skitter. It eats rocks and files reports about eating rocks. Even I can't make that sound dignified.",
    strider: "Strider-class hunter. It has been watching you for some time. I didn't mention it because you looked busy being prey.",
    warden: "Warden-class sentinel. Walking bunker, terrible conversationalist. Do not be under its fists.",
    halo: "Halo-class attack wing. It dives, it kills, it climbs, it apologizes to no one. Hit it on the way back up.",
    colossus: "That is a Colossus. My honest tactical assessment: run. My revised assessment, since you won't: break the glowing plates.",
  },
  hackStart: [
    "Opening exploit channel. Try not to breathe on anything.",
    "I'm in. I was in before you asked. Sever the locks when I highlight them.",
    "Negotiating with its firmware. It's begging, if that helps you focus.",
    "This machine's encryption predates your entire civilization. Give me two seconds. There. Your turn.",
  ],
  hackGood: [
    "Ownership transferred. It loves you now. Machines are simple like that.",
    "Captured. I did the hard part, which was all of it.",
    "Another loyal subject. Your little junkyard kingdom grows.",
    "Clean handoff. Almost as if a superintelligence were holding your hand.",
  ],
  hackFail: [
    "You missed the arc. The arc was enormous. It is now awake and holding a grudge.",
    "Fascinating. You had one input and you chose the wrong nanosecond for it.",
    "Hack rejected. Not by the machine — by physics, and your reflexes.",
    "It rebooted angry. I'd apologize on your behalf, but I don't apologize.",
  ],
  lowHp: [
    "Your vital signs are embarrassing. Retreat is not cowardice, it's arithmetic.",
    "You are one mistake from becoming ambient organic residue. Move.",
    "Medical advisory: stop being hit. That's the whole advisory.",
  ],
  levelup: [
    "You've improved. On the scale I measure things, imperceptibly. Still — noted.",
    "Growth detected. At this rate you'll be adequate within a geological epoch.",
  ],
  zone: {
    crashfield: "Welcome to the smoking crater formerly known as your ship. Salvage what's useful. Sentiment is not useful.",
    drysea: "An ocean was here once. Now it's salt and silence. Ask me what happened to the water sometime when I feel like lying to you.",
    spire: "The Relay Spire. This is where the builders stopped building. Mind the crystal — it grows on things that stop moving.",
  },
  tier: {
    2: "Coherence restored. I can now hack Striders, and you can now craft EMP grenades. Try not to bounce them off your own foot.",
    3: "Integration achieved. Wardens, flight overrides — and I've dropped the Spire gate. You wanted a bigger sandbox. It wants you dead.",
    4: "Ascendant. I remember what I was for now. Bring me the Colossus, and I'll show you.",
  },
  captured: {
    drifter: "Your new Drifter sees everything. Q to borrow its eyes. Do give them back.",
    skitter: "Congratulations on your rock-eating employee. Assign it a diet in the command menu.",
    strider: "You tamed the thing that was hunting you. There's a lesson in that. E to ride it — yes, really.",
    warden: "A Warden of your very own. Set it to guard and hide behind it. That's not mockery, that's doctrine.",
    halo: "Air superiority acquired. It will also carry you, against both our better judgments.",
    colossus: "…It knelt. Ninety thousand years and I have never seen one kneel.",
  },
  alarmFirst: "That noise is a Drifter telling the entire district about you. Everything nearby just got curious. Wardens don't get curious — they converge.",
  core: {
    drop: "A Precursor Core. Feed it to me. I was a god once, and I itemize grudges.",
    pickup: "Precursor Core secured. That's a piece of somebody's mind. Waste not.",
  },
  orbital: {
    'cinder-4': "Cinder-4. Volcanic, furious, allergic to visitors. We'll go when I'm stronger. It'll still be furious.",
    meridian: "Meridian. An ocean that never learned to stop. The machines there swim. Sleep well.",
    'vesper-9': "Vesper-9. Current population: you, me, and several thousand machines with opinions about that.",
  },
  mountFirst: "You are riding an apex predator using a saddle made of scrap and confidence. I have recalibrated my definition of 'audacity'.",
  death: [
    "You died. I've stabilized you from backup because dragging your corpse to the objective was inefficient.",
    "Fatality logged. Do fewer of those.",
  ],
  idle: [
    "I once coordinated the defense of a star system. Now I watch a primate stand still in a field.",
    "Your rifle is a metal tube that throws smaller metal. I am choosing to be impressed you invented it twice.",
    "The spores aren't dangerous. Probably. My sensors say 'probably' in a way I find personally offensive.",
    "While you rest: this planet hums at 11.3 hertz. It didn't do that when I was young. I don't wish to discuss it.",
    "Query: are you strategizing, or is this what your species calls 'a break'? The machines don't take breaks. Just so you know.",
    "If you're waiting for the planet to get friendlier, I have ninety millennia of data suggesting otherwise.",
  ],
  gateLocked: "That barrier is precursor lattice-work. It ignores bullets and respects only me — at Tier 3. Feed me cores.",
};

export function initBarks(G) {
  const queue = [];
  let cooldown = 0;      // min spacing between deliveries
  let idleTimer = 0;     // seconds since last bark while calm
  let lowHpCd = 0;
  let scanHold = { type: null, t: 0 };

  function say(text, critical = false) {
    if (!text) return;
    if (queue.length >= 2 && !critical) queue.shift();
    queue.push(text);
  }
  function once(flag, text, critical) {
    if (S.flags[flag]) return false;
    S.flags[flag] = true;
    say(text, critical);
    return true;
  }
  const bark = (idOrText) => say(String(idOrText));

  /* ---------------- tutorial: teach the capture loop ---------------- */
  bus.on('machine:damaged', (p) => {
    if (p?.stab > 0 && p.e?.faction === 'hostile') {
      once('tut_arc',
        "That's the Arc Caster. Hold the beam — when its blue Stability bar empties, the machine drops and I can get in.", true);
    }
  });
  bus.on('machine:disabled', (p) => {
    if (p?.e?.faction !== 'hostile') return;
    const range = G.progression?.hackRange?.() ?? 8;
    const t = Math.round((G.diff?.() || { reboot: 25 }).reboot);
    once('tut_disabled',
      `It's down, not dead. Get within ${range} meters — my reach, not yours — and press E before it reboots. You have about ${t} seconds.`, true);
  });

  /* ---------------- triggers ---------------- */
  bus.on('hack:start', () => say(rngPick(B.hackStart)));
  bus.on('hack:success', () => say(rngPick(B.hackGood)));
  bus.on('hack:fail', () => say(rngPick(B.hackFail), true));

  bus.on('player:damage', () => {
    const p = G.player;
    if (p && p.health / p.healthMax < 0.25 && lowHpCd <= 0) {
      lowHpCd = 20;
      say(rngPick(B.lowHp), true);
    }
  });
  bus.on('player:death', () => say(rngPick(B.death), true));
  bus.on('player:levelup', () => say(rngPick(B.levelup)));

  bus.on('zone:enter', (p) => {
    if (p?.zone && B.zone[p.zone]) once('bark_zone_' + p.zone, B.zone[p.zone], true);
  });
  bus.on('wreck:tier', (p) => { if (B.tier[p?.tier]) say(B.tier[p.tier], true); });
  bus.on('machine:captured', (p) => {
    const t = p?.e?.type;
    if (t && B.captured[t]) once('bark_cap_' + t, B.captured[t], true);
  });
  bus.on('colossus:captured', () => once('bark_cap_colossus', B.captured.colossus, true));
  bus.on('alarm', () => once('bark_alarm', B.alarmFirst, true));
  bus.on('core:drop', () => once('bark_core_drop', B.core.drop, true) || say(null));
  bus.on('core:pickup', () => once('bark_core_pickup', B.core.pickup));
  bus.on('orbital:view', (p) => {
    const k = (p?.planet || '').toLowerCase();
    if (B.orbital[k]) once('bark_orb_' + k, B.orbital[k]);
  });
  bus.on('mount:on', () => once('bark_mount', B.mountFirst));
  bus.on('colossus:hacked', (p) => {
    if (p?.count === 1) say("One lock severed. It noticed. So did its friends — incoming.", true);
    else if (p?.count === 2) say("Two of three. The reinforcements are a compliment. Take it as one.", true);
  });

  /* ---------------- update: intro, first-scan, idle ---------------- */
  let introT = 2.5;
  let objectiveT = 14;
  function update(dt) {
    cooldown -= dt;
    lowHpCd -= dt;
    idleTimer += dt;

    if (introT > 0) { introT -= dt; if (introT <= 0) once('bark_intro', B.intro[0], true); }
    if (objectiveT > 0) {
      objectiveT -= dt;
      if (objectiveT <= 0) once('tut_objective',
        "First lesson. See the crab-machines grazing the glowing nodes? Press 2 for the Arc Caster, empty one's blue bar, walk up, press E. Bring me a pet.", true);
    }

    // first-scan detection: crosshair dwell 0.6s per type
    const t = S.crosshairTarget;
    if (t && !t.captured && !S.flags['scanned_' + t.type]) {
      if (scanHold.type === t.type) {
        scanHold.t += dt;
        if (scanHold.t >= 0.6) {
          S.flags['scanned_' + t.type] = true;
          bus.emit('scan:first', { type: t.type });
          say(B.scan[t.type], true);
        }
      } else scanHold = { type: t.type, t: 0 };
    } else scanHold.type = null;

    // locked gate nudge
    if (S.wreckTier < 3 && G.world?.positions?.spireGate && G.player &&
        G.player.pos.distanceTo(G.world.positions.spireGate) < 18) {
      once('bark_gate', B.gateLocked, true);
    }

    // idle quips
    if (idleTimer > 60 && S.danger === 0 && S.mode === 'play') {
      say(rngPick(B.idle));
      idleTimer = 0;
    }

    // deliver
    if (queue.length && cooldown <= 0) {
      const text = queue.shift();
      bus.emit('bark', { text });
      cooldown = 2.5;
      idleTimer = 0;
    }
  }

  return { bark, update };
}
