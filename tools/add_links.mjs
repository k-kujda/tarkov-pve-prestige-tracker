// Add movement links the walkable mesh can't express: dropping off ledges, climbing onto ledges and vaulting over
// low obstacles. Candidates are found along the mesh's open edges and each one is checked against the collision
// geometry with rays, so walls, windows and invisible borders still block.
// Reads navmesh/v2/<map>.bin (or navmesh/<map>.bin when that is a fresh v2 build from build_navmesh.mjs) + navmesh/geom/<map>.bin, writes navmesh/<map>.bin v3:
// the same layout plus linkKind u8[nLinks] (0 walk, 1 drop, 2 climb, 3 vault).
// Usage: node tools/add_links.mjs <map> [...]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = require('../nav.js');

// Tarkov movement limits (approximate): vault over obstacles up to ~1.3 m, climb onto ledges up to ~1.5 m,
// drop from up to ~2.4 m without fall damage.
const STEP = 0.45, CLIMB = 1.5, DROP = 2.4, VAULT_TOP = 1.3;
const PROBES = [0.35, 0.6, 0.85, 1.1, 1.4];
const SAMPLE = 0.6, SPACING = 2.0;
export const KIND = { walk: 0, drop: 1, climb: 2, vault: 3 };

function readGeom(key) {
  const b = fs.readFileSync(path.join(ROOT, 'navmesh', 'geom', key + '.bin'));
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const nv = new Uint32Array(ab, 8, 1)[0], nt = new Uint32Array(ab, 12, 1)[0];
  return { V: new Float32Array(ab, 16, nv * 3), T: new Uint32Array(ab, 16 + nv * 12, nt * 3), nt };
}

// Uniform plan-view grid over collision triangles, for short segment queries.
function triGrid(g, cell = 2) {
  const { V, T, nt } = g;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < V.length; i += 3) { if (V[i] < x0) x0 = V[i]; if (V[i] > x1) x1 = V[i]; if (V[i + 2] < z0) z0 = V[i + 2]; if (V[i + 2] > z1) z1 = V[i + 2]; }
  const gw = Math.ceil((x1 - x0) / cell) + 1, gh = Math.ceil((z1 - z0) / cell) + 1;
  const counts = new Uint32Array(gw * gh + 1);
  const range = t => {
    const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
    const i0 = Math.floor((Math.min(V[a], V[b], V[c]) - x0) / cell), i1 = Math.floor((Math.max(V[a], V[b], V[c]) - x0) / cell);
    const j0 = Math.floor((Math.min(V[a + 2], V[b + 2], V[c + 2]) - z0) / cell), j1 = Math.floor((Math.max(V[a + 2], V[b + 2], V[c + 2]) - z0) / cell);
    return [i0, i1, j0, j1];
  };
  const BIG = 64; // huge triangles (terrain-wide planes) go to a separate list instead of every cell
  const big = [];
  for (let t = 0; t < nt; t++) {
    const [i0, i1, j0, j1] = range(t);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > BIG) { big.push(t); continue; }
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) counts[j * gw + i + 1]++;
  }
  for (let i = 1; i <= gw * gh; i++) counts[i] += counts[i - 1];
  const fill = counts.slice(0, gw * gh), cells = new Uint32Array(counts[gw * gh]);
  for (let t = 0; t < nt; t++) {
    const [i0, i1, j0, j1] = range(t);
    if ((i1 - i0 + 1) * (j1 - j0 + 1) > BIG) continue;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cells[fill[j * gw + i]++] = t;
  }
  return { x0, z0, cell, gw, gh, start: counts, cells, big: Uint32Array.from(big), V, T };
}

// Does the segment p->q hit any collision triangle? (Möller–Trumbore, both faces)
function blocked(G, p, q) {
  const { V, T } = G;
  const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
  const i0 = Math.max(0, Math.floor((Math.min(p[0], q[0]) - G.x0) / G.cell)), i1 = Math.min(G.gw - 1, Math.floor((Math.max(p[0], q[0]) - G.x0) / G.cell));
  const j0 = Math.max(0, Math.floor((Math.min(p[2], q[2]) - G.z0) / G.cell)), j1 = Math.min(G.gh - 1, Math.floor((Math.max(p[2], q[2]) - G.z0) / G.cell));
  const test = t => {
    const a = T[t * 3] * 3, b = T[t * 3 + 1] * 3, c = T[t * 3 + 2] * 3;
    const e1x = V[b] - V[a], e1y = V[b + 1] - V[a + 1], e1z = V[b + 2] - V[a + 2];
    const e2x = V[c] - V[a], e2y = V[c + 1] - V[a + 1], e2z = V[c + 2] - V[a + 2];
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(det) < 1e-10) return false;
    const inv = 1 / det, tx = p[0] - V[a], ty = p[1] - V[a + 1], tz = p[2] - V[a + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) return false;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) return false;
    const s = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return s > 1e-4 && s < 1 - 1e-4;
  };
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const c = j * G.gw + i;
    for (let k = G.start[c]; k < G.start[c + 1]; k++) if (test(G.cells[k])) return true;
  }
  for (const t of G.big) if (test(t)) return true;
  return false;
}

function addLinks(key) {
  const t0 = Date.now();
  // The walk-only mesh (v2) is kept in navmesh/v2/ so links can be recomputed.
  const file = path.join(ROOT, 'navmesh', key + '.bin'), src = path.join(ROOT, 'navmesh', 'v2', key + '.bin');
  if (!fs.existsSync(src) || fs.statSync(file).mtimeMs > fs.statSync(src).mtimeMs && !N.parse(fs.readFileSync(file)).linkKind) {
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.copyFileSync(file, src);
  }
  const m = N.parse(fs.readFileSync(src));
  const G = triGrid(readGeom(key));
  const { verts, pstart, pidx, lstart, links } = m;
  const linked = p => { const s = new Set(); for (let l = lstart[p]; l < lstart[p + 1]; l++) s.add(links[l * 3]); return s; };
  const found = new Map(); // "a,b" -> [{s, q, kind}]
  const edges = N.openEdges(m);
  let rays = 0;
  for (let e = 0; e < edges.length; e += 3) {
    const A = edges[e], va = edges[e + 1], vb = edges[e + 2];
    const ax = verts[va * 3], ay = verts[va * 3 + 1], az = verts[va * 3 + 2], bx = verts[vb * 3], by = verts[vb * 3 + 1], bz = verts[vb * 3 + 2];
    const len = Math.hypot(bx - ax, bz - az);
    if (len < 0.2) continue;
    // outward normal: away from the poly's centre
    let nx = (bz - az) / len, nz = -(bx - ax) / len;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    if ((m.cx[A] - mx) * nx + (m.cz[A] - mz) * nz > 0) { nx = -nx; nz = -nz; }
    const near = linked(A);
    const n = Math.max(1, Math.round(len / SAMPLE));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n, sx = ax + (bx - ax) * t, sy = ay + (by - ay) * t, sz = az + (bz - az) * t;
      let done = false;
      for (const d of PROBES) {
        if (done) break;
        const qx = sx + nx * d, qz = sz + nz * d;
        for (const B of N.polysNear(m, qx, qz, 0.12)) {
          if (B === A || near.has(B)) continue;
          const c = N.closestOnPoly(m, B, qx, qz);
          if (c.d > 0.12) continue;
          const dy = c.y - sy;
          let kind = -1;
          const S = [sx, sy, sz], Q = [c.x, c.y, c.z];
          const top = Math.max(sy, c.y);
          if (Math.abs(dy) <= STEP) {
            // across a gap at about the same level: open (mesh crack) or a low obstacle to vault
            rays += 2;
            if (blocked(G, [sx, top + VAULT_TOP, sz], [Q[0], top + VAULT_TOP, Q[2]]) || blocked(G, [sx, top + 1.7, sz], [Q[0], top + 1.7, Q[2]])) continue;
            rays++;
            kind = blocked(G, [sx, top + 0.25, sz], [Q[0], top + 0.25, Q[2]]) ? KIND.vault : KIND.walk;
          } else if (dy > STEP && dy <= CLIMB) {
            // ledge up: the step itself is the only obstacle (clear just above the upper floor and at head height)
            rays += 2;
            if (blocked(G, [sx, c.y + 0.3, sz], [Q[0], c.y + 0.3, Q[2]]) || blocked(G, [sx, c.y + 1.2, sz], [Q[0], c.y + 1.2, Q[2]])) continue;
            kind = KIND.climb;
          } else if (dy < -STEP && dy >= -DROP) {
            // ledge down: clear forward at chest height, then clear straight down to the landing
            rays += 2;
            if (blocked(G, [sx, sy + 1.0, sz], [Q[0], sy + 1.0, Q[2]]) || blocked(G, [Q[0], sy + 1.0, Q[2]], [Q[0], c.y + 0.15, Q[2]])) continue;
            kind = KIND.drop;
          }
          if (kind < 0) continue;
          const k2 = A + ',' + B;
          const list = found.get(k2) || [];
          if (list.some(o => Math.hypot(o.s[0] - sx, o.s[2] - sz) < SPACING)) { done = true; continue; }
          list.push({ s: S, q: Q, kind });
          found.set(k2, list);
          done = true;
        }
      }
    }
  }
  // Write v3: original links + new ones (portal = a single point midway, at the higher end), and their kinds.
  const P = m.P;
  const newV = [], extra = Array.from({ length: P }, () => []);
  let nv = m.V;
  const counts = [0, 0, 0, 0];
  for (const [k2, list] of found) {
    const [A, B] = k2.split(',').map(Number);
    for (const { s, q, kind } of list) {
      const vx = (s[0] + q[0]) / 2, vz = (s[2] + q[2]) / 2, vy = Math.max(s[1], q[1]);
      const vi = nv++;
      newV.push(vx, vy, vz);
      extra[A].push([B, vi, vi, kind]);
      counts[kind]++;
      // walking, vaulting and climbing work both ways (climbing down = a short drop); drops are one-way
      if (kind !== KIND.drop) extra[B].push([A, vi, vi, kind === KIND.climb ? KIND.drop : kind]);
    }
  }
  const lflat = [], kinds = [], lstart2 = new Uint32Array(P + 1);
  for (let p = 0; p < P; p++) {
    for (let l = lstart[p]; l < lstart[p + 1]; l++) { lflat.push(links[l * 3], links[l * 3 + 1], links[l * 3 + 2]); kinds.push(0); }
    for (const [o, a, b, kd] of extra[p]) { lflat.push(o, a, b); kinds.push(kd); }
    lstart2[p + 1] = lflat.length / 3;
  }
  const allV = new Float32Array(nv * 3);
  allV.set(verts); allV.set(newV, m.V * 3);
  const nI = m.pidx.length, pad = (4 - (P % 4)) % 4, kpad = (4 - (kinds.length % 4)) % 4;
  const parts = [
    Buffer.from('TNAV'), Buffer.from(new Uint32Array([3, nv, P, nI, lflat.length / 3]).buffer),
    Buffer.from(allV.buffer), Buffer.from(m.pstart.slice().buffer), Buffer.from(m.pidx.slice().buffer),
    Buffer.from(m.area.slice()), Buffer.alloc(pad), Buffer.from(lstart2.buffer), Buffer.from(new Uint32Array(lflat).buffer),
    Buffer.from((m.door || new Int32Array(P).fill(-1)).slice().buffer), Buffer.from(new Uint8Array(kinds)), Buffer.alloc(kpad),
  ];
  fs.writeFileSync(file, Buffer.concat(parts));
  console.log(`${key}: +${counts[1]} drop, +${counts[2]} climb, +${counts[3]} vault, +${counts[0]} gap links (${rays} rays, ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}

for (const key of process.argv.slice(2)) addLinks(key);
