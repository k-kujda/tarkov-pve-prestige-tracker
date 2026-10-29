// Route computations off the page's main thread: loads a map's navmesh once and answers distance-matrix, path and
// wall-drawing requests. Messages: { id, type, map, ... } -> { id, ok, ... } (or { id, error }).
/* global TarkovNav */
importScripts('/nav.js');
const N = TarkovNav;
const meshes = new Map(); // map -> Promise<mesh>

function loadMesh(map) {
  if (!meshes.has(map)) {
    meshes.set(map, (async () => {
      const [bin, meta] = await Promise.all([
        fetch('/api/navmesh?map=' + encodeURIComponent(map)).then(r => { if (!r.ok) throw new Error('no navmesh for this map'); return r.arrayBuffer(); }),
        fetch('/api/navmesh?meta=1&map=' + encodeURIComponent(map)).then(r => (r.ok ? r.json() : { doors: [] })),
      ]);
      const m = N.parse(bin);
      m.meta = meta;
      return m;
    })());
    meshes.get(map).catch(() => meshes.delete(map));
  }
  return meshes.get(map);
}

// Locked doors are closed unless their key is among `keys` (item ids the player has or picks up on the way).
function applyDoors(m, keys) {
  if (!m.door) return;
  const have = new Set(keys || []);
  const sig = [...have].sort().join(',');
  if (m._doorSig === sig) return;
  m._doorSig = sig;
  N.setBlockedDoors(m, Uint8Array.from(m.meta.doors || [], d => (d.state === 1 && !(d.key && have.has(d.key)) ? 1 : 0)));
}

// Route costs per poly: minefields (deadly) 25x and sniper zones 6x, so routes go around them whenever they can;
// walkable terrain outside the map's playable bounds (background beyond the invisible walls) 12x.
// hazards = { mines: [[x, z]...][], snipers: [...], bounds: [x0, z0, x1, z1] }
function applyHazards(m, hazards) {
  const sig = JSON.stringify(hazards || null);
  if (m._hazSig === sig) return;
  m._hazSig = sig;
  m.costMul = null;
  if (!hazards) return;
  m.costMul = new Float32Array(m.P).fill(1);
  const b = hazards.bounds;
  if (b) for (let p = 0; p < m.P; p++) if (m.cx[p] < b[0] || m.cx[p] > b[2] || m.cz[p] < b[1] || m.cz[p] > b[3]) m.costMul[p] = 12;
  markZones(m, hazards.snipers, 6);
  markZones(m, hazards.mines, 25);
}
function markZones(m, polys, mul) {
  if (!polys || !polys.length) return;
  const inside = (x, z, poly) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [ax, az] = poly[i], [bx, bz] = poly[j];
      if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) c = !c;
    }
    return c;
  };
  for (const poly of polys) {
    const xs = poly.map(p => p[0]), zs = poly.map(p => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
    for (const p of N.polysNear(m, (x0 + x1) / 2, (z0 + z1) / 2, Math.max(x1 - x0, z1 - z0) / 2 + 1)) if (inside(m.cx[p], m.cz[p], poly)) m.costMul[p] = Math.max(m.costMul[p], mul);
  }
}

// Snap request points { x, z, y? } to the mesh. The first point is the start (spawn): the others prefer its island,
// so a spot behind a gate that never opens (or up on a ledge you can only drop from) resolves to the nearest
// place you can actually walk to.
function locateAll(m, pts) {
  let start = pts[0] ? N.locate(m, pts[0]) : null;
  // A start on a small cut-off island (a stairwell the mesh doesn't connect): use the nearest spot on the main area.
  if (start) {
    const big = m.comp.big;
    if (m.comp[start.poly] !== big && m.comp.sizes[m.comp[start.poly]] < 0.05 * m.comp.sizes[big]) {
      if (!m._mainMask || m._mainMaskFor !== m.comp) { m._mainMask = Uint8Array.from(m.comp, c => (c === big ? 1 : 0)); m._mainMaskFor = m.comp; }
      const alt = N.locate(m, pts[0], { reach: m._mainMask });
      if (alt && m._mainMask[alt.poly] && Math.hypot(alt.x - pts[0].x, alt.z - pts[0].z) < 15) start = alt;
    }
  }
  const reach = start ? N.reachable(m, start) : null;
  return pts.map((p, i) => (i === 0 ? start : p ? N.locate(m, p, { reach }) : null));
}

const handlers = {
  async load({ map }) { const m = await loadMesh(map); return { polys: m.P, doors: (m.meta.doors || []).length }; },
  // Walking distances from each of `rows` (default: all points) to every point; Infinity where there's no path.
  // Returns rows.length x n values, row-major.
  async matrix({ map, points, keys, hazards, rows }) {
    const m = await loadMesh(map);
    applyDoors(m, keys); applyHazards(m, hazards);
    const loc = locateAll(m, points), n = points.length;
    rows = rows || points.map((_, i) => i);
    const dist = new Float64Array(rows.length * n).fill(Infinity);
    rows.forEach((i, k) => {
      if (!loc[i]) return;
      const row = N.distancesFrom(m, loc[i], loc);
      for (let j = 0; j < n; j++) dist[k * n + j] = j === i ? 0 : row[j];
    });
    return { dist, rows };
  },
  // Walking paths along a sequence of points (one per leg).
  async paths({ map, points, keys, hazards }) {
    const m = await loadMesh(map);
    applyDoors(m, keys); applyHazards(m, hazards);
    const loc = locateAll(m, points);
    const legs = [];
    for (let i = 1; i < loc.length; i++) {
      const a = loc[i - 1], b = loc[i];
      const r = a && b ? N.findPath(m, a, b) : null;
      const round = v => Math.round(v * 100) / 100;
      if (!r && a && b && m.door) {
        // No path: would a locked door's key open one? Report those doors (index, key) so the page can say what's needed.
        const saved = m.doorBlocked;
        N.setBlockedDoors(m, null);
        const b2 = N.locate(m, points[i]);
        const r2 = b2 ? N.findPath(m, a, b2) : null;
        const need = r2 ? N.doorsOnPath(m, a, b2, r2).map(k => m.meta.doors[k]).filter(d => d.state === 1 && saved && saved[m.meta.doors.indexOf(d)]) : [];
        N.setBlockedDoors(m, saved);
        legs.push({ blocked: true, needs: need.map(d => ({ key: d.key, name: d.name, pos: d.pos })) });
        continue;
      }
      legs.push(r ? {
        points: r.points.map(p => [round(p.x), round(p.y), round(p.z)]), length: r.length,
        moves: (r.moves || []).map(mv => ({ kind: mv.kind, x: round(mv.x), y: round(mv.y), z: round(mv.z) })),
        doors: N.doorsOnPath(m, a, b, r).map(i => { const d = m.meta.doors[i]; return { name: d.name, key: d.key, state: d.state, pos: d.pos }; }),
      } : null);
    }
    return { legs };
  },
  // Wall lines: edges of the walkable area with no neighbour (walls, fences, ledges), as [x1, z1, x2, z2, y] each.
  async walls({ map }) {
    const m = await loadMesh(map);
    const e = N.boundaryEdges(m), out = new Float32Array((e.length / 6) * 5);
    for (let i = 0, j = 0; i < e.length; i += 6, j += 5) {
      out[j] = e[i]; out[j + 1] = e[i + 2]; out[j + 2] = e[i + 3]; out[j + 3] = e[i + 5]; out[j + 4] = (e[i + 1] + e[i + 4]) / 2;
    }
    return { lines: out };
  },
};

self.onmessage = async ev => {
  const { id, type } = ev.data;
  try {
    const res = await handlers[type](ev.data);
    const transfer = Object.values(res).filter(v => v && v.buffer instanceof ArrayBuffer).map(v => v.buffer);
    self.postMessage({ id, ok: true, ...res }, transfer);
  } catch (e) {
    self.postMessage({ id, error: e.message || String(e) });
  }
};
