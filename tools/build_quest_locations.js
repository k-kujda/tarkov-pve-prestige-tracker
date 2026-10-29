// Fill in exact spots for in-raid objectives tarkov.dev has no position for, from the game's own quest objects
// (navmesh/zones/<map>.json, written by tools/extract_zones.py). Writes data/quest-locations.json, which server.js lays
// over the tarkov.dev data.
//
// tarkov.dev's zone positions agree with the game's triggers of the same id (533 zones, median 0.00 m apart), so only
// objectives without any point are filled:
//   1. HandlerCompleteQuestCondition objects (interactive quest spots such as repairs) name the quest id and the
//      objective id they complete: exact.
//   2. A short hand-checked list of triggers whose id differs from anything in the quest data (see MANUAL).
// Usage: node tools/build_quest_locations.js
const fs = require('fs');
const path = require('path');
const { data, ROOT } = require('./nav_util');

const D = data();
const ZONES = path.join(ROOT, 'navmesh', 'zones');
const IN_RAID = new Set(['visit', 'mark', 'plantItem', 'plantQuestItem', 'findQuestItem', 'useItem', 'shoot', 'extract']);

// objective id -> trigger on a map, checked by hand against the game scenes.
const MANUAL = {
  // Beneath The Streets: "Locate the passage leading to The Lab on Streets of Tarkov" — the Tour step trigger at the
  // Streets → Lab transit (same spot as tarkov.dev's "Transit to The Lab").
  '66aba85403e0ee3101042878': { map: 'streets-of-tarkov', zone: 'Tour_10_transition_from_streets', note: 'Passage to The Lab: the Streets → Lab transit point' },
  // Wiring the Vessel: "Install the hacking device in the central control station room" — the only plant trigger on
  // Icebreaker no quest data uses ("install_device", three spots side by side on the lower deck by the control room).
  '69e559bf4b53b554a2779130': { map: 'icebreaker', zone: 'install_device', note: 'Central control station, lower deck: plant the device at one of these spots (from the game\'s install_device trigger)' },
};

const zonesByMap = {};
for (const f of fs.readdirSync(ZONES).filter(f => f.endsWith('.json'))) zonesByMap[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(ZONES, f), 'utf8'));
const r1 = v => Math.round(v * 10) / 10;
const point = (map, z, kind) => ({ map, x: r1(z.center[0]), y: r1(z.center[1]), z: r1(z.center[2]), kind,
  outline: z.lo && z.hi && (z.hi[0] - z.lo[0] > 2 || z.hi[2] - z.lo[2] > 2) ? [[r1(z.lo[0]), r1(z.lo[2])], [r1(z.hi[0]), r1(z.lo[2])], [r1(z.hi[0]), r1(z.hi[2])], [r1(z.lo[0]), r1(z.hi[2])]] : undefined });

// Objective id -> handler spots.
const handlers = new Map();
for (const [map, zones] of Object.entries(zonesByMap)) {
  for (const z of zones) {
    if (z.script !== 'HandlerCompleteQuestCondition') continue;
    for (const s of z.strings || []) {
      if (!/^[0-9a-f]{24}$/.test(s)) continue;
      if (!handlers.has(s)) handlers.set(s, []);
      const list = handlers.get(s);
      if (!list.some(p => p.map === map && Math.hypot(p.x - z.center[0], p.z - z.center[2]) < 0.5)) list.push(point(map, z, 'zone'));
    }
  }
}

const out = {};
let missing = [];
for (const t of D.tasks) {
  for (const o of t.objectives) {
    if (!IN_RAID.has(o.type) || (o.points && o.points.length)) continue;
    if (MANUAL[o.id]) {
      const m = MANUAL[o.id];
      const pts = (zonesByMap[m.map] || []).filter(z => z.id === m.zone).map(z => point(m.map, z, 'zone'));
      if (!pts.length) throw new Error(`${t.name}: trigger ${m.zone} not found on ${m.map}`);
      out[o.id] = { task: t.name, verified: true, source: 'game trigger ' + m.zone, note: m.note, points: pts };
      continue;
    }
    const h = handlers.get(o.id);
    if (h) { out[o.id] = { task: t.name, verified: true, source: 'game HandlerCompleteQuestCondition', points: h }; continue; }
    // Only spot objectives are worth listing as missing (kills and extracts are anywhere / at any exit by design).
    if (!['shoot', 'extract'].includes(o.type) && (o.maps || []).length) missing.push(`${t.name}: ${o.description}`);
  }
}
for (const v of Object.values(out)) for (const p of v.points) if (!p.outline) delete p.outline;
fs.writeFileSync(path.join(ROOT, 'data', 'quest-locations.json'), JSON.stringify(out, null, 1) + '\n');
console.log(`${Object.keys(out).length} objectives filled:`);
for (const v of Object.values(out)) console.log(`  ${v.task}: ${v.points.length} spot(s) on ${v.points[0].map} (${v.source})`);
console.log(`${missing.length} spot objectives still without a position${missing.length ? ':\n  ' + missing.join('\n  ') : ''}`);
