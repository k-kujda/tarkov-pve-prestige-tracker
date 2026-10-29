// Heights of all collision triangles (from navmesh/geom/<map>.bin) directly above/below a plan-view point.
// Usage: node tools/column.js map x z
const fs = require('fs'), path = require('path');
const [key, X, Z] = [process.argv[2], +process.argv[3], +process.argv[4]];
const b = fs.readFileSync(path.join(__dirname, '..', 'navmesh', 'geom', key + '.bin'));
const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const nv = new Uint32Array(ab, 8, 1)[0], nt = new Uint32Array(ab, 12, 1)[0];
const V = new Float32Array(ab, 16, nv * 3), T = new Uint32Array(ab, 16 + nv * 12, nt * 3);
const hits = [];
for (let t = 0; t < nt * 3; t += 3) {
  const a = T[t] * 3, bb = T[t + 1] * 3, c = T[t + 2] * 3;
  const x0 = V[a], z0 = V[a + 2], x1 = V[bb], z1 = V[bb + 2], x2 = V[c], z2 = V[c + 2];
  if (X < Math.min(x0, x1, x2) || X > Math.max(x0, x1, x2) || Z < Math.min(z0, z1, z2) || Z > Math.max(z0, z1, z2)) continue;
  const den = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
  if (Math.abs(den) < 1e-9) continue;
  const l0 = ((z1 - z2) * (X - x2) + (x2 - x1) * (Z - z2)) / den, l1 = ((z2 - z0) * (X - x2) + (x0 - x2) * (Z - z2)) / den, l2 = 1 - l0 - l1;
  if (l0 < 0 || l1 < 0 || l2 < 0) continue;
  const y = l0 * V[a + 1] + l1 * V[bb + 1] + l2 * V[c + 1];
  const ux = x1 - x0, uy = V[bb + 1] - V[a + 1], uz = z1 - z0, wx = x2 - x0, wy = V[c + 1] - V[a + 1], wz = z2 - z0;
  const ny = uz * wx - ux * wz, nl = Math.hypot(uy * wz - uz * wy, ny, ux * wy - uy * wx);
  hits.push({ y, up: ny / nl, t: t / 3 });
}
hits.sort((p, q) => p.y - q.y);
for (const h of hits) console.log(h.y.toFixed(2).padStart(8), h.up > 0.64 ? 'floor(up)' : h.up < -0.64 ? 'ceiling(down)' : 'steep', 'tri', h.t);
