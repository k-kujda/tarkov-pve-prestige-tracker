// Walkable-path routing on the game's own AI navmesh (extracted by tools/extract_navmesh.py into navmesh/<map>.bin).
// Shared by the browser (window.TarkovNav) and Node (require('./nav')) so routes can be tested from the command line.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TarkovNav = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const CELL = 4; // spatial grid cell (m)

  // File layout: "TNAV", version, nVerts, nPolys, nIdx, nLinks, verts f32[3n], polyStart u32[P+1], polyIdx u32[nIdx],
  // area u8[P] (padded to 4), linkStart u32[P+1], links u32[3 * nLinks] = (other poly, portal vert a, portal vert b),
  // from version 2 door i32[P] (index into the map's door list, -1 = not in a doorway), and from version 3
  // linkKind u8[nLinks] (0 walk, 1 drop down, 2 climb up, 3 vault over; movement links have a one-point portal).
  function parse(buf) {
    const ab = buf instanceof ArrayBuffer ? buf : buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const h = new Uint32Array(ab, 0, 6);
    if (String.fromCharCode(...new Uint8Array(ab, 0, 4)) !== 'TNAV' || h[1] < 1 || h[1] > 3) throw new Error('not a navmesh file');
    const V = h[2], P = h[3], I = h[4], Lk = h[5];
    let off = 24;
    const take = (Type, n) => { const a = new Type(ab, off, n); off += n * Type.BYTES_PER_ELEMENT; return a; };
    const verts = take(Float32Array, V * 3);
    const pstart = take(Uint32Array, P + 1);
    const pidx = take(Uint32Array, I);
    const area = take(Uint8Array, P);
    off += (4 - (P % 4)) % 4;
    const lstart = take(Uint32Array, P + 1);
    const links = take(Uint32Array, Lk * 3);
    const door = h[1] >= 2 ? take(Int32Array, P) : null;
    const linkKind = h[1] >= 3 ? take(Uint8Array, Lk) : null;
    const m = { V, P, verts, pstart, pidx, area, lstart, links, door, linkKind, doorBlocked: null };
    prepare(m);
    return m;
  }

  function prepare(m) {
    const { P, verts, pstart, pidx } = m;
    const cx = new Float32Array(P), cy = new Float32Array(P), cz = new Float32Array(P);
    const bb = new Float32Array(P * 4);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (let p = 0; p < P; p++) {
      let sx = 0, sy = 0, sz = 0, x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      const s = pstart[p], e = pstart[p + 1];
      for (let k = s; k < e; k++) {
        const v = pidx[k] * 3, x = verts[v], z = verts[v + 2];
        sx += x; sy += verts[v + 1]; sz += z;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      const n = e - s;
      cx[p] = sx / n; cy[p] = sy / n; cz[p] = sz / n;
      bb[p * 4] = x0; bb[p * 4 + 1] = z0; bb[p * 4 + 2] = x1; bb[p * 4 + 3] = z1;
      if (x0 < minX) minX = x0; if (z0 < minZ) minZ = z0; if (x1 > maxX) maxX = x1; if (z1 > maxZ) maxZ = z1;
    }
    const gw = Math.max(1, Math.ceil((maxX - minX) / CELL) + 1), gh = Math.max(1, Math.ceil((maxZ - minZ) / CELL) + 1);
    const counts = new Uint32Array(gw * gh + 1);
    const cellRange = p => [Math.floor((bb[p * 4] - minX) / CELL), Math.floor((bb[p * 4 + 1] - minZ) / CELL), Math.floor((bb[p * 4 + 2] - minX) / CELL), Math.floor((bb[p * 4 + 3] - minZ) / CELL)];
    for (let p = 0; p < P; p++) { const [a, b, c, d] = cellRange(p); for (let j = b; j <= d; j++) for (let i = a; i <= c; i++) counts[j * gw + i + 1]++; }
    for (let i = 1; i <= gw * gh; i++) counts[i] += counts[i - 1];
    const fill = counts.slice(0, gw * gh), cells = new Uint32Array(counts[gw * gh]);
    for (let p = 0; p < P; p++) { const [a, b, c, d] = cellRange(p); for (let j = b; j <= d; j++) for (let i = a; i <= c; i++) cells[fill[j * gw + i]++] = p; }
    Object.assign(m, { cx, cy, cz, bb, grid: { minX, minZ, gw, gh, start: counts, cells } });
    // One-way links (drops) also join islands for the island check; the search still only goes down them.
    m.revOneWay = new Map();
    if (m.linkKind) for (let p = 0; p < P; p++) for (let l = m.lstart[p]; l < m.lstart[p + 1]; l++) {
      if (m.linkKind[l] !== 1) continue;
      const o = m.links[l * 3];
      if (!m.revOneWay.has(o)) m.revOneWay.set(o, []);
      m.revOneWay.get(o).push(p);
    }
    m.comp = components(m);
  }

  // Extra cost (metres of walking) of a drop / climb / vault: they take a moment and make noise.
  const MOVE_COST = [0, 1, 3, 2];
  // Not walkable: a shut (locked) door, or deep water (area 9). Area 8 is wading: slower.
  const DEEP_WATER = 9, WADING = 8;
  const closedDoor = (m, p) => m.area[p] === DEEP_WATER || !!(m.doorBlocked && m.door && m.door[p] >= 0 && m.doorBlocked[m.door[p]]);
  // Which doors are shut for routing (e.g. locked doors without the key): Uint8Array over the door list, or null.
  function setBlockedDoors(m, blocked) {
    m.doorBlocked = blocked;
    m.comp = components(m);
  }

  // Connected components (islands that can't be walked between, e.g. roofs reached by jumping).
  function components(m) {
    const comp = new Int32Array(m.P).fill(-1), stack = [];
    let n = 0;
    const sizes = [];
    for (let s = 0; s < m.P; s++) {
      if (comp[s] >= 0) continue;
      comp[s] = n; stack.push(s);
      let size = 0;
      while (stack.length) {
        const p = stack.pop(); size++;
        if (closedDoor(m, p)) continue; // a locked door: its own island, nothing passes through
        for (let l = m.lstart[p]; l < m.lstart[p + 1]; l++) { const o = m.links[l * 3]; if (comp[o] < 0 && !closedDoor(m, o)) { comp[o] = n; stack.push(o); } }
        for (const o of m.revOneWay.get(p) || []) if (comp[o] < 0 && !closedDoor(m, o)) { comp[o] = n; stack.push(o); }
      }
      sizes.push(size); n++;
    }
    comp.sizes = sizes;
    // largest island (computed here: there can be ~10^5 islands, e.g. every deep-water poly is its own)
    let big = 0;
    for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[big]) big = i;
    comp.big = big;
    return comp;
  }

  // Closest point of polygon p to (x, z) in plan view, with the navmesh height there.
  function closestOnPoly(m, p, x, z) {
    const { verts, pstart, pidx } = m;
    const s = pstart[p], n = pstart[p + 1] - s;
    let inside = true, best = Infinity, bx = 0, bz = 0, by = 0;
    for (let k = 0; k < n; k++) {
      const a = pidx[s + k] * 3, b = pidx[s + (k + 1) % n] * 3;
      const ax = verts[a], az = verts[a + 2], ex = verts[b] - ax, ez = verts[b + 2] - az;
      const cr = ex * (z - az) - ez * (x - ax);
      if (cr > 1e-7) inside = false; // navmesh polys wind clockwise seen from above
      const L = ex * ex + ez * ez;
      let t = L > 0 ? ((x - ax) * ex + (z - az) * ez) / L : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + ex * t, pz = az + ez * t, d = (px - x) * (px - x) + (pz - z) * (pz - z);
      if (d < best) { best = d; bx = px; bz = pz; by = verts[a + 1] + (verts[b + 1] - verts[a + 1]) * t; }
    }
    if (inside && n >= 3) return { x, z, y: heightInPoly(m, p, x, z), d: 0 };
    return { x: bx, z: bz, y: by, d: Math.sqrt(best) };
  }
  function heightInPoly(m, p, x, z) {
    const { verts, pstart, pidx } = m;
    const s = pstart[p], n = pstart[p + 1] - s, v0 = pidx[s] * 3;
    for (let k = 1; k < n - 1; k++) {
      const v1 = pidx[s + k] * 3, v2 = pidx[s + k + 1] * 3;
      const x0 = verts[v0], z0 = verts[v0 + 2], x1 = verts[v1], z1 = verts[v1 + 2], x2 = verts[v2], z2 = verts[v2 + 2];
      const den = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
      if (Math.abs(den) < 1e-9) continue;
      const a = ((z1 - z2) * (x - x2) + (x2 - x1) * (z - z2)) / den, b = ((z2 - z0) * (x - x2) + (x0 - x2) * (z - z2)) / den, c = 1 - a - b;
      if (a >= -1e-4 && b >= -1e-4 && c >= -1e-4) return a * verts[v0 + 1] + b * verts[v1 + 1] + c * verts[v2 + 1];
    }
    return m.cy[p];
  }

  // Polys whose plan-view bounds come within r of (x, z).
  function polysNear(m, x, z, r) {
    const g = m.grid, out = [];
    const i0 = Math.max(0, Math.floor((x - r - g.minX) / CELL)), i1 = Math.min(g.gw - 1, Math.floor((x + r - g.minX) / CELL));
    const j0 = Math.max(0, Math.floor((z - r - g.minZ) / CELL)), j1 = Math.min(g.gh - 1, Math.floor((z + r - g.minZ) / CELL));
    const seen = new Set();
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const c = j * g.gw + i;
      for (let k = g.start[c]; k < g.start[c + 1]; k++) {
        const p = g.cells[k];
        if (seen.has(p)) continue;
        seen.add(p);
        const b = p * 4;
        if (x + r < m.bb[b] || x - r > m.bb[b + 2] || z + r < m.bb[b + 1] || z - r > m.bb[b + 3]) continue;
        out.push(p);
      }
    }
    return out;
  }

  // Snap a map point to the navmesh. With a height (y), the floor nearest to it wins (objective spots are often
  // at hand height, so being up to 1.8 m above the floor is free); without one, opts.pickY(y) scores candidate floors.
  // opts.minSize skips tiny islands (unreachable ledges) unless nothing else is near.
  function locate(m, p, opts = {}) {
    const hasY = typeof p.y === 'number';
    const minSize = opts.minSize ?? 50;
    let fallback = null;
    for (const r of [2, 6, 15, 40]) {
      let best = null;
      for (const poly of polysNear(m, p.x, p.z, r)) {
        const c = closestOnPoly(m, poly, p.x, p.z);
        if (c.d > r) continue;
        let cost = c.d;
        if (hasY) { const dy = p.y - c.y; cost += opts.symmetric ? Math.abs(dy) : dy > 0 ? Math.max(0, dy - 1.8) : -dy * 1.5; }
        else if (opts.pickY) cost += opts.pickY(c.y);
        if (m.comp.sizes[m.comp[poly]] < minSize) cost += 25;
        if (closedDoor(m, poly)) cost += 50;
        // opts.reach: polys reachable from the route's start (see reachable()); anywhere else only as a last resort
        if (opts.reach && !opts.reach[poly]) cost += 30;
        if (!best || cost < best.cost) best = { poly, x: c.x, y: c.y, z: c.z, d: c.d, cost };
      }
      // with opts.reach, keep looking further out for a reachable spot before settling for an unreachable one
      if (best && (!opts.reach || opts.reach[best.poly])) return best;
      if (best && (!fallback || best.cost < fallback.cost)) fallback = best;
    }
    return fallback;
  }

  // Polys that can be walked to from a located point (following one-way drops, not through shut doors).
  function reachable(m, from) {
    const seen = new Uint8Array(m.P), stack = [from.poly];
    seen[from.poly] = 1;
    while (stack.length) {
      const p = stack.pop();
      for (let l = m.lstart[p]; l < m.lstart[p + 1]; l++) {
        const o = m.links[l * 3];
        if (!seen[o] && !closedDoor(m, o)) { seen[o] = 1; stack.push(o); }
      }
    }
    return seen;
  }

  // Binary min-heap of (key, value) on typed arrays.
  function Heap(cap) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  Heap.prototype.push = function (key, val) {
    if (this.n === this.k.length) { const k = new Float64Array(this.n * 2), v = new Int32Array(this.n * 2); k.set(this.k); v.set(this.v); this.k = k; this.v = v; }
    let i = this.n++;
    while (i > 0) { const pa = (i - 1) >> 1; if (this.k[pa] <= key) break; this.k[i] = this.k[pa]; this.v[i] = this.v[pa]; i = pa; }
    this.k[i] = key; this.v[i] = val;
  };
  Heap.prototype.pop = function () {
    const top = this.v[0], key = this.k[--this.n], val = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = key; this.v[i] = val;
    return top;
  };

  // Per-mesh scratch buffers for searches.
  function scratch(m) {
    if (!m._s) m._s = { g: new Float64Array(m.P), par: new Int32Array(m.P), via: new Int32Array(m.P), ex: new Float32Array(m.P), ey: new Float32Array(m.P), ez: new Float32Array(m.P), stamp: new Uint32Array(m.P), closed: new Uint32Array(m.P), gen: 0 };
    const s = m._s;
    s.gen++;
    return s;
  }

  // Graph search over polys; a poly's cost is the length of the polyline through portal midpoints that reaches it.
  // goal: one located point (A*) or null to settle everything until `targets` (Set of polys) are all reached.
  function search(m, from, goal, targets, maxCost = Infinity) {
    const s = scratch(m), gen = s.gen, L = m.links, V = m.verts;
    const heap = new Heap(1024);
    const h = goal ? (x, y, z) => Math.hypot(goal.x - x, (goal.y - y) * 1.5, goal.z - z) * 0.999 : () => 0;
    s.g[from.poly] = 0; s.par[from.poly] = -1; s.via[from.poly] = -1; s.stamp[from.poly] = gen;
    s.ex[from.poly] = from.x; s.ey[from.poly] = from.y; s.ez[from.poly] = from.z;
    heap.push(h(from.x, from.y, from.z), from.poly);
    let left = targets ? targets.size : 0;
    while (heap.n) {
      const p = heap.pop();
      if (s.closed[p] === gen) continue;
      s.closed[p] = gen;
      if (goal && p === goal.poly) return s;
      if (targets && targets.has(p) && --left === 0) return s;
      const gp = s.g[p];
      if (gp > maxCost) break;
      const px = s.ex[p], py = s.ey[p], pz = s.ez[p];
      for (let l = m.lstart[p]; l < m.lstart[p + 1]; l++) {
        const o = L[l * 3];
        if (s.closed[o] === gen || closedDoor(m, o)) continue;
        const a = L[l * 3 + 1] * 3, b = L[l * 3 + 2] * 3;
        const mx = (V[a] + V[b]) / 2, my = (V[a + 1] + V[b + 1]) / 2, mz = (V[a + 2] + V[b + 2]) / 2;
        // The last leg goes straight to the goal point inside the goal poly.
        // m.costMul: optional per-poly cost factor (e.g. minefields), applied to the leg that enters the poly.
        const mul = (m.costMul ? m.costMul[o] : 1) * (m.area[o] === WADING ? 1.6 : 1);
        let ng = gp + Math.hypot(mx - px, my - py, mz - pz) * mul + (m.linkKind ? MOVE_COST[m.linkKind[l]] : 0);
        if (goal && o === goal.poly) ng += Math.hypot(goal.x - mx, goal.y - my, goal.z - mz) * mul;
        if (s.stamp[o] !== gen || ng < s.g[o]) {
          s.stamp[o] = gen; s.g[o] = ng; s.par[o] = p; s.via[o] = l;
          s.ex[o] = mx; s.ey[o] = my; s.ez[o] = mz;
          heap.push(ng + h(mx, my, mz), o);
        }
      }
    }
    return s;
  }

  const tri2 = (ax, az, bx, bz, cx, cz) => (cx - ax) * (bz - az) - (bx - ax) * (cz - az);

  // Simple stupid funnel algorithm (Mononen) on plan-view portals; heights come from the portal end points.
  function stringPull(m, start, end, startPoly, portalsRaw) {
    const V = m.verts;
    const pl = [{ x: start.x, y: start.y, z: start.z }], pr = [pl[0]];
    let fromPoly = startPoly;
    for (const pt of portalsRaw) {
      const A = { x: V[pt.a * 3], y: V[pt.a * 3 + 1], z: V[pt.a * 3 + 2] }, B = { x: V[pt.b * 3], y: V[pt.b * 3 + 1], z: V[pt.b * 3 + 2] };
      const cxp = m.cx[fromPoly], czp = m.cz[fromPoly];
      if (tri2(cxp, czp, A.x, A.z, B.x, B.z) < 0) { pr.push(A); pl.push(B); } else { pr.push(B); pl.push(A); }
      fromPoly = pt.to;
    }
    pl.push({ x: end.x, y: end.y, z: end.z }); pr.push(pl[pl.length - 1]);
    const pts = [pl[0]];
    let apex = pl[0], left = pl[0], right = pr[0], ai = 0, li = 0, ri = 0;
    for (let i = 1; i < pl.length && pts.length < 100000; i++) {
      const L = pl[i], R = pr[i];
      if (tri2(apex.x, apex.z, right.x, right.z, R.x, R.z) <= 0) {
        if ((apex.x === right.x && apex.z === right.z) || tri2(apex.x, apex.z, left.x, left.z, R.x, R.z) > 0) { right = R; ri = i; }
        else { pts.push(left); apex = left; ai = li; left = apex; right = apex; li = ri = ai; i = ai; continue; }
      }
      if (tri2(apex.x, apex.z, left.x, left.z, L.x, L.z) >= 0) {
        if ((apex.x === left.x && apex.z === left.z) || tri2(apex.x, apex.z, right.x, right.z, L.x, L.z) < 0) { left = L; li = i; }
        else { pts.push(right); apex = right; ai = ri; left = apex; right = apex; li = ri = ai; i = ai; continue; }
      }
    }
    const last = pl[pl.length - 1], tail = pts[pts.length - 1];
    if (tail.x !== last.x || tail.z !== last.z || tail.y !== last.y) pts.push(last);
    return pts;
  }

  function portalsTo(m, s, to) {
    const chain = [];
    for (let p = to; s.via[p] >= 0; p = s.par[p]) chain.push(s.via[p]);
    chain.reverse();
    const L = m.links;
    return chain.map(l => ({ a: L[l * 3 + 1], b: L[l * 3 + 2], to: L[l * 3], kind: m.linkKind ? m.linkKind[l] : 0 }));
  }

  const pathLength = pts => { let d = 0; for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z); return d; };

  // Walkable path between two located points: { points, length, polys } or null when they're on separate islands.
  function findPath(m, a, b) {
    if (m.comp[a.poly] !== m.comp[b.poly]) return null;
    if (a.poly === b.poly) { const pts = [a, b].map(q => ({ x: q.x, y: q.y, z: q.z })); return { points: pts, length: pathLength(pts), polys: [a.poly] }; }
    const s = search(m, a, b, null);
    if (s.closed[b.poly] !== s.gen) return null;
    const portals = portalsTo(m, s, b.poly);
    const pts = stringPull(m, a, b, a.poly, portals);
    const moves = [];
    for (const pt of portals) if (pt.kind) moves.push({ kind: pt.kind, x: m.verts[pt.a * 3], y: m.verts[pt.a * 3 + 1], z: m.verts[pt.a * 3 + 2] });
    return { points: pts, length: pathLength(pts), polys: [a.poly, ...portals.map(p => p.to)], moves };
  }

  // Doors a path goes through (indices into the map's door list), in order.
  function doorsOnPath(m, a, b, path) {
    if (!m.door || !path || !path.polys) return [];
    const out = [];
    for (const p of path.polys) { const d = m.door[p]; if (d >= 0 && out[out.length - 1] !== d) out.push(d); }
    return [...new Set(out)];
  }

  // Walking distance from `a` to each of `targets` (located points) with one search; Infinity when unreachable.
  function distancesFrom(m, a, targets, withPaths = false) {
    const want = new Set();
    for (const t of targets) if (t && t.poly !== a.poly && m.comp[t.poly] === m.comp[a.poly]) want.add(t.poly);
    const s = want.size ? search(m, a, null, want) : null;
    return targets.map(t => {
      if (!t || m.comp[t.poly] !== m.comp[a.poly]) return withPaths ? { length: Infinity, points: null } : Infinity;
      let pts;
      if (t.poly === a.poly) pts = [a, t];
      else if (s.closed[t.poly] !== s.gen) return withPaths ? { length: Infinity, points: null } : Infinity;
      else pts = stringPull(m, a, t, a.poly, portalsTo(m, s, t.poly));
      const length = pathLength(pts);
      return withPaths ? { length, points: pts } : length;
    });
  }

  // Poly edges not covered by portals to neighbours, as flat [poly, vertA, vertB, ...].
  function openEdges(m) {
    const { P, verts, pstart, pidx, lstart, links } = m;
    const out = [];
    for (let p = 0; p < P; p++) {
      const s = pstart[p], n = pstart[p + 1] - s;
      for (let k = 0; k < n; k++) {
        const a = pidx[s + k], b = pidx[s + (k + 1) % n];
        const ax = verts[a * 3], az = verts[a * 3 + 2], ex = verts[b * 3] - ax, ez = verts[b * 3 + 2] - az, len2 = ex * ex + ez * ez;
        if (len2 < 1e-6) continue;
        let cover = 0;
        for (let l = lstart[p]; l < lstart[p + 1]; l++) {
          const u = links[l * 3 + 1], w = links[l * 3 + 2];
          if (u === w) continue;
          if ((u === a && w === b) || (u === b && w === a)) { cover = 1; break; }
          const ux = verts[u * 3], uz = verts[u * 3 + 2], wx = verts[w * 3], wz = verts[w * 3 + 2];
          if (Math.abs(ex * (uz - az) - ez * (ux - ax)) > 0.02 * Math.sqrt(len2) || Math.abs(ex * (wz - az) - ez * (wx - ax)) > 0.02 * Math.sqrt(len2)) continue;
          const t1 = ((ux - ax) * ex + (uz - az) * ez) / len2, t2 = ((wx - ax) * ex + (wz - az) * ez) / len2;
          cover += Math.max(0, Math.min(1, Math.max(t1, t2)) - Math.max(0, Math.min(t1, t2)));
        }
        if (cover < 0.98) out.push(p, a, b);
      }
    }
    return new Uint32Array(out);
  }

  // Edges with no neighbour (walls, fences, drops), as flat [x1, y1, z1, x2, y2, z2, ...] for drawing.
  function boundaryEdges(m) {
    const e = openEdges(m), v = m.verts, out = new Float32Array((e.length / 3) * 6);
    for (let i = 0, j = 0; i < e.length; i += 3, j += 6) {
      const a = e[i + 1] * 3, b = e[i + 2] * 3;
      out[j] = v[a]; out[j + 1] = v[a + 1]; out[j + 2] = v[a + 2]; out[j + 3] = v[b]; out[j + 4] = v[b + 1]; out[j + 5] = v[b + 2];
    }
    return out;
  }

  return { parse, setBlockedDoors, locate, reachable, findPath, doorsOnPath, distancesFrom, openEdges, boundaryEdges, pathLength, polysNear, closestOnPoly };
});
