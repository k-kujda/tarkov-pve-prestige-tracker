// A point the spawns can't walk to: which island is it on, and where does that island come closest to the area the
// spawns can reach (gap width and height difference)? Usage: node tools/island_gaps.js map x,y,z
const { N, load, data } = require('./nav_util');
const [key, xyz] = process.argv.slice(2);
const [x, y, z] = xyz.split(',').map(Number);
const m = load(key, { lockedClosed: false }), D = data();
const reach = new Uint8Array(m.P);
for (const sp of D.mapFeatures[key].spawns) { const a = N.locate(m, sp); if (a && !reach[a.poly]) { const r = N.reachable(m, a); for (let p = 0; p < m.P; p++) if (r[p]) reach[p] = 1; } }
const t = N.locate(m, { x, y, z }, { symmetric: true });
console.log(`point snaps ${t.d.toFixed(2)} m away at y ${t.y.toFixed(2)}; island ${m.comp.sizes[m.comp[t.poly]]} polys; reachable: ${!!reach[t.poly]}`);
// the island (polys reachable from the point, ignoring drops back) = flood from the point
const isl = N.reachable(m, t);
const e = N.openEdges(m), res = [];
for (let i = 0; i < e.length; i += 3) {
  const p = e[i]; if (!isl[p] || reach[p]) continue;
  const va = e[i + 1] * 3, vb = e[i + 2] * 3;
  const mx = (m.verts[va] + m.verts[vb]) / 2, mz = (m.verts[va + 2] + m.verts[vb + 2]) / 2, my = (m.verts[va + 1] + m.verts[vb + 1]) / 2;
  for (const q of N.polysNear(m, mx, mz, 3)) {
    if (!reach[q]) continue;
    const c = N.closestOnPoly(m, q, mx, mz);
    if (c.d < 3 && Math.abs(c.y - my) < 4) res.push({ x: mx, y: my, z: mz, d: c.d, dy: c.y - my });
  }
}
res.sort((a, b) => a.d + Math.abs(a.dy) - b.d - Math.abs(b.dy));
const seen = [];
for (const r of res) {
  if (seen.some(s => Math.hypot(s.x - r.x, s.z - r.z) < 3)) continue;
  seen.push(r);
  console.log(`  ${r.x.toFixed(1)} ${r.y.toFixed(1)} ${r.z.toFixed(1)}: gap ${r.d.toFixed(2)} m, reachable side ${r.dy >= 0 ? r.dy.toFixed(2) + ' m higher' : (-r.dy).toFixed(2) + ' m lower'}`);
  if (seen.length >= 8) break;
}
if (!seen.length) console.log('  no reachable mesh within 3 m of the island');
