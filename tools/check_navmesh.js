// Checks the navmeshes against tarkov.dev's positions: spawns, extracts, transits and quest spots should sit on the
// walkable mesh (close in plan view and height) and be reachable from the spawns (locked doors shut).
// Usage: node tools/check_navmesh.js [map ...]
const fs = require('fs');
const path = require('path');
const { N, load, data, ROOT } = require('./nav_util');

const D = data();
const MESH_OF = { 'night-factory': 'factory', 'ground-zero-21': 'ground-zero', 'ground-zero-tutorial': null, 'the-lab-dark': 'the-lab' };
const pct = (a, n) => (n ? Math.round(100 * a / n) + '%' : '-');
const q = (arr, f) => { if (!arr.length) return NaN; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
const fmt = p => `(${p.x}, ${p.y}, ${p.z})`;

const only = process.argv.slice(2);
for (const key of Object.keys(D.mapFeatures)) {
  if (only.length && !only.includes(key)) continue;
  const meshKey = key in MESH_OF ? MESH_OF[key] : key;
  if (!meshKey || !fs.existsSync(path.join(ROOT, 'navmesh', meshKey + '.bin'))) { console.log(`\n== ${key}: no navmesh`); continue; }
  const m = load(meshKey);
  const f = D.mapFeatures[key];
  // main island: the one most spawns are on
  const votes = new Map();
  for (const sp of f.spawns) { const h = N.locate(m, sp); if (h) votes.set(m.comp[h.poly], (votes.get(m.comp[h.poly]) || 0) + 1); }
  const main = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
  const mainComp = main ? main[0] : -1;
  const firstMain = f.spawns.map(sp => N.locate(m, sp)).find(h => h && m.comp[h.poly] === mainComp);
  const mainReach = firstMain ? N.reachable(m, firstMain) : null;
  console.log(`\n== ${key} (${m.P} polys${m.linkKind ? `, ${m.linkKind.filter(k => k).length} drop/climb/vault links` : ''}, main island ${pct(mainComp >= 0 ? m.comp.sizes[mainComp] : 0, m.P)} of polys)`);
  const sets = {
    spawns: f.spawns, extracts: f.extracts, transits: f.transits,
    objectives: D.tasks.flatMap(t => t.objectives.flatMap(o => (o.points || []).filter(p => p.map === key).map(p => ({ ...p, label: `${t.name}: ${o.description}` })))),
  };
  const bad = [];
  for (const [name, pts] of Object.entries(sets)) {
    if (!pts.length) continue;
    const ds = [], dys = [];
    let onMain = 0;
    for (const p of pts) {
      const hit = N.locate(m, p, { reach: mainReach });
      if (!hit) { bad.push(`${name} not on mesh: ${p.name || p.label || ''} ${fmt(p)}`); continue; }
      ds.push(hit.d); if (typeof p.y === 'number') dys.push(p.y - hit.y);
      if (mainReach ? mainReach[hit.poly] : m.comp[hit.poly] === mainComp) onMain++;
      else bad.push(`${name} not walkable from the spawns, nearest is on an island (${m.comp.sizes[m.comp[hit.poly]]} polys): ${p.name || p.label || ''} ${fmt(p)}`);
      if (hit.d > 5) bad.push(`${name} ${hit.d.toFixed(1)} m from the nearest walkable spot: ${p.name || p.label || ''} ${fmt(p)}`);
    }
    console.log(`${name.padEnd(10)} n=${String(pts.length).padStart(4)}  to mesh: median ${q(ds, 0.5).toFixed(2)} m, p90 ${q(ds, 0.9).toFixed(2)}, max ${Math.max(...ds).toFixed(1)}  height: median ${q(dys, 0.5).toFixed(2)}, p10 ${q(dys, 0.1).toFixed(2)}, p90 ${q(dys, 0.9).toFixed(2)}  reachable ${pct(onMain, pts.length)}`);
  }
  // Every spawn to every PMC/shared extract (walking distances).
  const exs = f.extracts.filter(e => e.faction !== 'scav');
  let pairs = 0, reach = 0;
  const ratio = [], perEx = exs.map(() => 0);
  const t1 = Date.now();
  const spawns = f.spawns.slice(0, 60);
  for (const sp of spawns) {
    const a = N.locate(m, sp);
    if (!a) continue;
    const res = N.distancesFrom(m, a, exs.map(e => N.locate(m, e, { reach: N.reachable(m, a) })));
    res.forEach((d, i) => { pairs++; if (d < Infinity) { reach++; perEx[i]++; ratio.push(d / Math.max(1, Math.hypot(sp.x - exs[i].x, sp.z - exs[i].z))); } });
  }
  if (pairs) {
    console.log(`spawn->extract: ${reach}/${pairs} walkable, walking/straight median ${q(ratio, 0.5).toFixed(2)} p90 ${q(ratio, 0.9).toFixed(2)} (${((Date.now() - t1) / spawns.length).toFixed(0)} ms per spawn)`);
    const never = exs.filter((e, i) => !perEx[i]).map(e => e.name);
    if (never.length) console.log(`  extracts no spawn can walk to: ${never.join(', ')}`);
  }
  for (const b of bad.slice(0, 15)) console.log('  ! ' + b);
  if (bad.length > 15) console.log(`  … ${bad.length - 15} more`);
}
