// Walk the AI navmesh path between two points and report where the player mesh's island changes (a gap).
// Usage: node tools/trace_gap.js map x1 y1 z1 x2 y2 z2 [--open]
const fs = require('fs'), path = require('path');
const { N, load, ROOT } = require('./nav_util');
const [key, ...rest] = process.argv.slice(2);
const v = rest.filter(x => !x.startsWith('--')).map(Number);
const ai = N.parse(fs.readFileSync(path.join(ROOT, 'navmesh', 'ai', key + '.bin')));
const pm = load(key, { lockedClosed: !process.argv.includes('--open') });
const A = { x: v[0], y: v[1], z: v[2] }, B = { x: v[3], y: v[4], z: v[5] };
const r = N.findPath(ai, N.locate(ai, A), N.locate(ai, B));
if (!r) { console.log('no AI path'); process.exit(); }
let prev = null, last = null;
for (let i = 1; i < r.points.length; i++) {
  const a = r.points[i - 1], b = r.points[i], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 0.25));
  for (let k = 0; k <= n; k++) {
    const p = { x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n, z: a.z + (b.z - a.z) * k / n };
    const h = N.locate(pm, p, { minSize: 0, symmetric: true });
    const tag = !h ? 'none' : (h.d > 0.6 || Math.abs(h.y - p.y) > 0.8) ? `off(${h.d.toFixed(1)}m,dy ${(h.y - p.y).toFixed(1)})` : 'island ' + pm.comp.sizes[pm.comp[h.poly]];
    if (tag !== prev && last) console.log(`   (last ${prev} at ${last.x.toFixed(2)} ${last.y.toFixed(2)} ${last.z.toFixed(2)})`);
    last = p;
    if (tag !== prev) { console.log(`${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)} -> ${tag}${h && pm.door && pm.door[h.poly] >= 0 ? ' door ' + pm.meta.doors[pm.door[h.poly]].name + ' state ' + pm.meta.doors[pm.door[h.poly]].state : ''}`); prev = tag; }
  }
}
