// For extracts/quest spots no spawn can walk to: are they behind locked doors (which ones, which keys)?
// Usage: node tools/why_unreachable.js map
const { N, load, data } = require('./nav_util');
const key = process.argv[2], meshKey = { 'night-factory': 'factory', 'ground-zero-21': 'ground-zero', 'the-lab-dark': 'the-lab' }[key] || key;
const D = data(), f = D.mapFeatures[key];
const shut = load(meshKey), open = load(meshKey, { lockedClosed: false });
const keyName = id => ((D.keys || []).find(k => k.id === id) || { name: id || '(no key: lever/power/breach)' }).name;
const spawn = f.spawns.map(s => N.locate(shut, s)).find(Boolean);
const shutReach = N.reachable(shut, spawn);
const pts = [
  ...f.extracts.filter(e => e.faction !== 'scav').map(e => ({ ...e, label: 'extract ' + e.name })),
  ...D.tasks.flatMap(t => t.objectives.flatMap(o => (o.points || []).filter(p => p.map === key).map(p => ({ ...p, label: `${t.name}: ${o.description}` })))),
];
const seen = new Set();
for (const p of pts) {
  const k = p.label + p.x + p.z;
  if (seen.has(k)) continue; seen.add(k);
  const b = N.locate(shut, p, { reach: shutReach });
  const exact = N.locate(shut, p);
  // Reachable, and at the spot itself (not just the nearest reachable place)?
  if (b && isFinite(N.distancesFrom(shut, spawn, [b])[0])) {
    const off = Math.hypot(b.x - p.x, b.z - p.z), dy = (p.y ?? b.y) - b.y;
    if (b.poly === exact.poly || (off < 3 && dy > -1 && dy < 2.5)) continue;
    console.log(`≈ ${p.label}: nearest walkable spot is ${off.toFixed(1)} m away, ${dy.toFixed(1)} m below the spot`);
    continue;
  }
  const a2 = N.locate(open, f.spawns[0]), b2 = N.locate(open, p, { reach: N.reachable(open, a2) });
  const r = b2 && N.findPath(open, a2, b2);
  if (!r) { console.log(`✗ ${p.label} (${p.x}, ${p.y}, ${p.z}): not reachable even with every locked door open`); continue; }
  const doors = N.doorsOnPath(open, a2, b2, r).map(i => open.meta.doors[i]).filter(d => d.state === 1);
  console.log(`🔑 ${p.label}: behind ${doors.map(d => `${d.class === 'KeycardDoor' ? 'keycard ' : ''}door "${d.name}" at (${d.pos.map(v => v.toFixed(0)).join(', ')}) — ${keyName(d.key)}`).join('; ')}`);
}
