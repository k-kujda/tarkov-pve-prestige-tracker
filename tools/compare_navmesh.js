// Cross-check the player navmesh (built from collision geometry) against the game's own AI navmesh
// (navmesh/ai/<map>.bin): random points on the AI mesh's main island should be on the player mesh, and walking
// distances between random pairs should agree (the player mesh may be a little shorter: thinner agent, crouching).
// Usage: node tools/compare_navmesh.js map [pairs] [--worst n]   (writes navmesh/tmp/<map>-worst.json for rendering)
const fs = require('fs');
const path = require('path');
const { N, load, ROOT } = require('./nav_util');

const key = process.argv[2], pairs = +(process.argv[3] || 300);
const worstN = process.argv.includes('--worst') ? +process.argv[process.argv.indexOf('--worst') + 1] : 5;
const ai = N.parse(fs.readFileSync(path.join(ROOT, 'navmesh', 'ai', key + '.bin')));
const pm = load(key);
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const big = ai.comp.big;
const polys = [], cum = [];
let tot = 0;
for (let p = 0; p < ai.P; p++) {
  if (ai.comp[p] !== big) continue;
  const b = p * 4;
  tot += Math.max(0.01, (ai.bb[b + 2] - ai.bb[b]) * (ai.bb[b + 3] - ai.bb[b + 1]));
  polys.push(p); cum.push(tot);
}
const pick = () => {
  const r = rnd() * tot; let lo = 0, hi = cum.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < r) lo = mid + 1; else hi = mid; }
  const p = polys[lo];
  return { x: ai.cx[p], y: ai.cy[p], z: ai.cz[p] };
};
const fmt = p => `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`;
let missing = 0, unreachable = 0;
const res = [], missPts = [], unreach = [];
for (let t = 0; t < pairs; t++) {
  const A = pick(), B = pick();
  const a1 = N.locate(ai, A), b1 = N.locate(ai, B);
  const r1 = a1 && b1 && N.findPath(ai, a1, b1);
  if (!r1) continue;
  const a2 = N.locate(pm, A, { symmetric: true }), b2 = N.locate(pm, B, { symmetric: true });
  const bad = h => !h || h.d > 1 || Math.abs(h.y - (h === a2 ? A : B).y) > 1;
  if (bad(a2) || bad(b2)) { missing++; missPts.push(bad(a2) ? A : B); continue; }
  const r2 = N.findPath(pm, a2, b2);
  if (!r2) { unreachable++; unreach.push([A, B, r1.length]); continue; }
  res.push({ r: r2.length / r1.length, A, B, r1, r2 });
}
res.sort((x, y) => x.r - y.r);
const q = f => res[Math.floor(f * (res.length - 1))].r;
console.log(`${key}: ${res.length + missing + unreachable} pairs on the AI mesh: ${missing} with an end off the player mesh, ${unreachable} unreachable on it`);
console.log(`walk distance player/AI: p5 ${q(0.05).toFixed(2)} p25 ${q(0.25).toFixed(2)} median ${q(0.5).toFixed(2)} p75 ${q(0.75).toFixed(2)} p95 ${q(0.95).toFixed(2)}`);
for (const p of missPts.slice(0, 6)) { const h = N.locate(pm, p, { minSize: 0 }); console.log(`  no player mesh at ${fmt(p)}${h ? ` (nearest ${h.d.toFixed(1)} m away, dy ${(h.y - p.y).toFixed(1)})` : ''}`); }
for (const [A, B, d] of unreach.slice(0, 6)) console.log(`  unreachable ${fmt(A)} -> ${fmt(B)} (AI ${d.toFixed(0)} m)`);
const worst = [...res.slice(0, worstN), ...res.slice(-worstN)];
for (const w of worst) console.log(`  ratio ${w.r.toFixed(2)}: ${fmt(w.A)} -> ${fmt(w.B)}  AI ${w.r1.length.toFixed(0)} m, player ${w.r2.length.toFixed(0)} m`);
fs.mkdirSync(path.join(ROOT, 'navmesh', 'tmp'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'navmesh', 'tmp', key + '-worst.json'), JSON.stringify(worst.map(w => ({ r: w.r, ai: w.r1.points, pm: w.r2.points }))));
