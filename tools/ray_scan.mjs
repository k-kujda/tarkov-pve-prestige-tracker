// Horizontal ray scan through the collision geometry: free/blocked along a line at a given height, to measure
// doorway widths. Usage: node tools/ray_scan.mjs map y x0,z0 x1,z1 [step] [probeLen]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const [key, Y, A, B, stepS, lenS] = process.argv.slice(2);
const y = +Y, [x0, z0] = A.split(',').map(Number), [x1, z1] = B.split(',').map(Number), step = +(stepS || 0.05), probe = +(lenS || 0.6);
const b = fs.readFileSync(path.join(ROOT, 'navmesh', 'geom', key + '.bin'));
const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
const nv = new Uint32Array(ab, 8, 1)[0], nt = new Uint32Array(ab, 12, 1)[0];
const V = new Float32Array(ab, 16, nv * 3), T = new Uint32Array(ab, 16 + nv * 12, nt * 3);
// triangles near the line
const pad = probe + 1, near = [];
for (let t = 0; t < nt; t++) {
  const a = T[t * 3] * 3, bb = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
  if (Math.max(V[a], V[bb], V[c]) < Math.min(x0, x1) - pad || Math.min(V[a], V[bb], V[c]) > Math.max(x0, x1) + pad) continue;
  if (Math.max(V[a + 2], V[bb + 2], V[c + 2]) < Math.min(z0, z1) - pad || Math.min(V[a + 2], V[bb + 2], V[c + 2]) > Math.max(z0, z1) + pad) continue;
  if (Math.max(V[a + 1], V[bb + 1], V[c + 1]) < y - 0.01 || Math.min(V[a + 1], V[bb + 1], V[c + 1]) > y + 0.01) continue;
  near.push(t);
}
const hit = (p, q) => near.some(t => {
  const a = T[t * 3] * 3, bb = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
  const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
  const e1 = [V[bb] - V[a], V[bb + 1] - V[a + 1], V[bb + 2] - V[a + 2]], e2 = [V[c] - V[a], V[c + 1] - V[a + 1], V[c + 2] - V[a + 2]];
  const pv = [dy * e2[2] - dz * e2[1], dz * e2[0] - dx * e2[2], dx * e2[1] - dy * e2[0]];
  const det = e1[0] * pv[0] + e1[1] * pv[1] + e1[2] * pv[2];
  if (Math.abs(det) < 1e-10) return false;
  const tv = [p[0] - V[a], p[1] - V[a + 1], p[2] - V[a + 2]];
  const u = (tv[0] * pv[0] + tv[1] * pv[1] + tv[2] * pv[2]) / det; if (u < 0 || u > 1) return false;
  const qv = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]];
  const v = (dx * qv[0] + dy * qv[1] + dz * qv[2]) / det; if (v < 0 || u + v > 1) return false;
  const s = (e2[0] * qv[0] + e2[1] * qv[1] + e2[2] * qv[2]) / det; return s > 0 && s < 1;
});
// for each sample along A->B, cast a short probe perpendicular to the line (through the doorway)
const L = Math.hypot(x1 - x0, z1 - z0), ux = (x1 - x0) / L, uz = (z1 - z0) / L, nx = -uz, nz = ux;
let row = '';
for (let s = 0; s <= L; s += step) {
  const px = x0 + ux * s, pz = z0 + uz * s;
  row += hit([px - nx * probe, y, pz - nz * probe], [px + nx * probe, y, pz + nz * probe]) ? '#' : '.';
}
console.log(`${near.length} tris near; along ${L.toFixed(2)} m at y ${y}, ${step} m per char ('.' = a probe of ±${probe} m across passes):`);
console.log(row);
