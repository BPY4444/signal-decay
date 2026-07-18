// SIGNAL DECAY — progression: XP/levels, salvage, precursor cores, WRECK tiers, crafting,
// fabricator/console proximity. CONTRACT §4-progression.
// NOTE: combat.js rolls cfg.coreChance and emits 'core:drop'; we only count it here (no re-roll).
import { bus, S, clamp } from './core.js';

const TIER_COST = { 2: 1, 3: 2, 4: 3 };          // cores to reach tier N
const HACK_RANGE = [0, 8, 12, 15, 15];
const CAPACITY = [0, 2, 4, 6, 10];   // army-sized: player asked for a horde, not a duo

export function initProgression(G) {

  function xpNeeded(level) { return Math.round(100 * Math.pow(level, 1.4)); }

  function addXP(n) {
    if (!(n > 0)) return;
    S.xp += n;
    while (S.xp >= xpNeeded(S.level)) {
      S.xp -= xpNeeded(S.level);
      S.level++;
      G.player?.applyLevelBonuses?.();
      bus.emit('player:levelup', { level: S.level });
      bus.emit('sfx', { name: 'levelup' });
    }
  }

  function addSalvage(gain) {
    if (!gain) return;
    for (const k of ['alloy', 'circuits', 'cells']) {
      if (gain[k]) S.salvage[k] = Math.max(0, S.salvage[k] + gain[k]);
    }
  }

  /* ---------------- hack gating ---------------- */
  function hackRange() { return HACK_RANGE[clamp(S.wreckTier, 1, 4)]; }
  function capacity() { return CAPACITY[clamp(S.wreckTier, 1, 4)]; }

  function canHack(e) {
    if (!e || e.dying || e.captured) return false;
    if (e.cfg.tier > S.wreckTier) return false;
    if (e.type === 'colossus') return S.wreckTier >= 4;
    if (S.captured.length >= capacity()) return false;
    if (!G.player) return false;
    return G.player.pos.distanceTo(e.pos) <= hackRange() + 0.5;
  }

  /* ---------------- WRECK tiers ---------------- */
  function tryUpgradeWreck() {
    if (S.wreckTier >= 4) return { ok: false, reason: 'WRECK IS ALREADY ASCENDANT' };
    const cost = TIER_COST[S.wreckTier + 1];
    if (S.cores < cost) return { ok: false, reason: `NEED ${cost} PRECURSOR CORE${cost > 1 ? 'S' : ''} (HAVE ${S.cores})` };
    S.cores -= cost;
    S.wreckTier++;
    bus.emit('wreck:tier', { tier: S.wreckTier });
    bus.emit('sfx', { name: 'levelup' });
    if (S.wreckTier >= 3) G.world?.openSpireGate?.();
    return { ok: true };
  }

  /* ---------------- crafting ---------------- */
  // where 'bench' = requires standing at a Crafting Bench (B to build one, 8 alloy + 4 circuits)
  const recipes = [
    {
      id: 'grenade', name: 'EMP GRENADE',
      cost: { alloy: 5, circuits: 3, cells: 1 },
      blocked: () => (S.wreckTier < 2 ? 'WRECK T2 REQUIRED' : null),
      apply: () => { S.grenades++; },
    },
    {
      id: 'capacitor', name: 'SHIELD CAPACITOR  (+25 SHIELD)',
      cost: { alloy: 8, circuits: 4, cells: 2 }, oneTime: true,
      blocked: () => (S.flags.crafted_capacitor ? 'INSTALLED' : !S.nearBench ? 'NEEDS CRAFTING BENCH' : null),
      apply: () => { G.player.shieldMax += 25; G.player.shield += 25; },
    },
    {
      id: 'amplifier', name: 'ARC AMPLIFIER  (+40% DISABLE SPEED)',
      cost: { alloy: 10, circuits: 8, cells: 3 }, oneTime: true,
      blocked: () => (S.flags.crafted_amplifier ? 'INSTALLED' : !S.nearBench ? 'NEEDS CRAFTING BENCH' : null),
      apply: () => { S.mods.arc = 1.4; },
    },
    {
      id: 'overdrive', name: 'RIFLE OVERDRIVE  (+50% DAMAGE)',
      cost: { alloy: 14, circuits: 6, cells: 3 }, oneTime: true,
      blocked: () => (S.flags.crafted_overdrive ? 'INSTALLED'
        : S.wreckTier < 2 ? 'WRECK T2 REQUIRED'
        : !S.nearBench ? 'NEEDS CRAFTING BENCH' : null),
      apply: () => { S.mods.rifle = 1.5; },
    },
  ];
  // ui compatibility: expose live req text + canCraft
  for (const r of recipes) {
    r.canCraft = () => !r.blocked();
    Object.defineProperty(r, 'req', { get: () => r.blocked() || '' });
  }

  function craft(recipeId) {
    const r = recipes.find(x => x.id === recipeId);
    if (!r) return { ok: false, reason: 'UNKNOWN PATTERN' };
    const why = r.blocked();
    if (why) return { ok: false, reason: why };
    for (const k in r.cost) {
      if ((S.salvage[k] || 0) < r.cost[k]) return { ok: false, reason: 'INSUFFICIENT SALVAGE' };
    }
    for (const k in r.cost) S.salvage[k] -= r.cost[k];
    if (r.oneTime) S.flags['crafted_' + r.id] = true;
    r.apply();
    bus.emit('crafted', { id: r.id });
    bus.emit('sfx', { name: 'levelup' });
    return { ok: true };
  }

  /* ---------------- hand-harvesting resource nodes ---------------- */
  function harvestNode(n) {
    if (!n || (n.cooldownT || 0) > 0) return;
    n.cooldownT = 18;
    if (n.mesh) n.mesh.scale.setScalar(0.45); // regrows as it recharges
    const amount = 3;
    addSalvage({ [n.type]: amount });
    addXP(3);
    bus.emit('harvest', { type: n.type, n: amount, pos: n.pos.clone(), hand: true });
    bus.emit('sfx', { name: 'harvest' });
  }

  /* ---------------- XP + core listeners ---------------- */
  function creditSource(source) {
    // credit player, turret, or captured machines; never hostile-on-hostile
    if (!source || source === 'player' || source === 'turret') return true;
    return source.faction === 'captured' || source === G.player;
  }

  let pity = 0; // warden/halo kills since last core
  bus.on('machine:destroyed', (p) => {
    const e = p?.e; if (!e) return;
    if (e.faction === 'hostile' && creditSource(p.source)) addXP(e.cfg.xp || 10);
    if (e.faction === 'hostile' && (e.type === 'warden' || e.type === 'halo')) {
      pity++;
      if (pity >= 3) { // guaranteed pity drop; combat's own roll resets us via 'core:drop'
        bus.emit('core:drop', { pos: e.pos?.clone?.() });
      }
    }
  });
  bus.on('core:drop', () => {
    pity = 0;
    S.cores++;
    bus.emit('sfx', { name: 'pickup' });
  });
  bus.on('core:pickup', () => { /* world already incremented S.cores */ });

  bus.on('hack:success', (p) => { if (p?.e) addXP((p.e.cfg.xp || 10) * 2); });

  bus.on('zone:enter', (p) => {
    const key = 'visited_' + p.zone;
    if (!S.flags[key]) { S.flags[key] = true; addXP(50); }
  });
  bus.on('scan:first', () => addXP(10));

  /* ---------------- proximity + node recharge ---------------- */
  function update(dt) {
    // node cooldowns tick + regrow
    const nodes = G.world?.nodes;
    if (nodes) for (const n of nodes) {
      if ((n.cooldownT || 0) > 0) {
        n.cooldownT -= dt;
        if (n.mesh) {
          const s = n.cooldownT <= 0 ? 1 : 0.45 + 0.55 * (1 - n.cooldownT / 18);
          n.mesh.scale.setScalar(s);
        }
      }
    }

    const P = G.player?.pos;
    const pos = G.world?.positions;
    if (!P || !pos) return;
    S.nearFabricator = pos.fabricator ? P.distanceTo(pos.fabricator) < 4.5 : false;
    S.nearConsole = pos.shuttleConsole ? P.distanceTo(pos.shuttleConsole) < 4.5 : false;
    S.nearBench = false;
    const placed = G.base?.placed;
    if (placed) for (const b of placed) {
      if (b.id === 'bench' && P.distanceTo(b.pos) < 4.5) { S.nearBench = true; break; }
    }
  }

  return {
    update, addXP, addSalvage, canHack, hackRange, capacity,
    tryUpgradeWreck, craft, recipes, xpNeeded, harvestNode,
  };
}
