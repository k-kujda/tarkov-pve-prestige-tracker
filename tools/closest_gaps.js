// Where does the area reachable from a map's first spawn come closest to big unreachable islands?
// Usage: node tools/closest_gaps.js map [minIslandPolys] [x,y,z start]
const { N, load, data } = require('./nav_util');
const key = process.argv[2], minSize = +(process.argv[3] || 200);
const m = load(key, { lockedClosed: false }), D = data();
const from = process.argv[4] ? (([x, y, z]) => ({ x, y, z }))(process.argv[4].split(',').map(Number)) : D.mapFeatures[key].spawns[0];
const a = N.locate(m, from);
const r = N.reachable(m, a);
const near = [], e = N.openEdges(m);
for (let i = 0; i < e.length; i += 3) {
  const p = e[i]; if (!r[p]) continue;
  const va = e[i + 1] * 3, vb = e[i + 2] * 3;
  const mx = (m.verts[va] + m.verts[vb]) / 2, mz = (m.verts[va + 2] + m.verts[vb + 2]) / 2, my = (m.verts[va + 1] + m.verts[vb + 1]) / 2;
  for (const q of N.polysNear(m, mx, mz, 2.5)) {
    if (r[q] || m.comp.sizes[m.comp[q]] < minSize) continue;
    const c = N.closestOnPoly(m, q, mx, mz);
    if (c.d < 2.5 && Math.abs(c.y - my) < 3) near.push({ x: mx, y: my, z: mz, d: c.d, dy: c.y - my, size: m.comp.sizes[m.comp[q]] });
  }
}
near.sort((a, b) => (a.d + Math.abs(a.dy)) - (b.d + Math.abs(b.dy)));
const seen = [];
for (const n of near) {
  if (seen.some(s => Math.hypot(s.x - n.x, s.z - n.z) < 3)) continue;
  seen.push(n);
  console.log(`${n.x.toFixed(1)} ${n.y.toFixed(1)} ${n.z.toFixed(1)}  gap ${n.d.toFixed(2)} m, dy ${n.dy.toFixed(2)} m -> island of ${n.size}`);
  if (seen.length >= 10) break;
}
