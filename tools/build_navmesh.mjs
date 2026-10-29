// Build a player navmesh from the game's collision geometry (navmesh/geom/<map>.bin, from extract_geometry.py) with
// Recast, and write it in the tracker's format (navmesh/<map>.bin, read by nav.js).
// The map is built in square regions on one global tile grid (keeps WASM memory small), then all tiles are welded
// into one polygon mesh with portals across tile borders.
// Usage: node tools/build_navmesh.mjs <map> [...]   (needs: npm install recast-navigation, run from a dir that has it)
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(process.env.RECAST_DIR ? path.join(process.env.RECAST_DIR, 'x.js') : import.meta.url);
const R = require('recast-navigation');
const { init } = R;
const { buildTiledNavMeshRcConfig } = require('@recast-navigation/generators');

// Player: capsule radius ~0.3 m, can crouch under ~1.3 m, steps up ~0.45 m, walks slopes up to ~50°.
const CS = +(process.env.NAV_CS || 0.1), CH = +(process.env.NAV_CH || 0.1);
const CFG = {
  cs: CS, ch: CH, tileSize: 128, borderSize: 0,
  walkableSlopeAngle: 50, walkableHeight: Math.ceil(1.3 / CH), walkableClimb: Math.floor(0.45 / CH), walkableRadius: Math.ceil(0.3 / CS),
  maxEdgeLen: Math.round(12 / CS), maxSimplificationError: 1.3, minRegionArea: 12, mergeRegionArea: 40,
  maxVertsPerPoly: 6, detailSampleDist: 6, detailSampleMaxError: 1,
};
const TILE_M = CFG.tileSize * CS;
const REGION_TILES = Math.max(4, Math.round(150 / (CFG.tileSize * CS))); // tiles per region side (~150 m)
const EXT = 0x8000;
const DOOR_AREA = 2;
// Water (from the Water layer's bullet-impact surfaces): floor more than DEEP below the surface can't be walked
// (deep water), WADE..DEEP below is wading (slow).
const WADE_AREA = 8, DEEP_AREA = 9, WADE = 0.5, DEEP = 1.4;

// Door volume on the navmesh: the door's collider bounds, widened across its thin axis so the doorway gets its own
// polygons, and down to the floor (Recast marks spans by their floor height).
function doorBox(d) {
  const lo = d.lo.slice(), hi = d.hi.slice();
  const thin = hi[0] - lo[0] < hi[2] - lo[2] ? 0 : 2;
  lo[thin] -= 0.35; hi[thin] += 0.35;
  lo[1] -= 1.0; hi[1] = Math.max(hi[1], lo[1] + 2);
  return { lo, hi };
}

// One tile, following @recast-navigation/generators' generateTileNavMeshData, plus door areas.
function buildTile(ctx, verts, tris, rcConfig, chunky, tile, doors, water) {
  const cfg = R.cloneRcConfig(rcConfig);
  const bmin = [...tile.bmin], bmax = [...tile.bmax];
  bmin[0] -= cfg.borderSize * cfg.cs; bmin[2] -= cfg.borderSize * cfg.cs; bmax[0] += cfg.borderSize * cfg.cs; bmax[2] += cfg.borderSize * cfg.cs;
  for (let k = 0; k < 3; k++) { cfg.set_bmin(k, bmin[k]); cfg.set_bmax(k, bmax[k]); }
  const hf = R.allocHeightfield();
  const free = [];
  try {
    if (!R.createHeightfield(ctx, hf, cfg.width, cfg.height, bmin, bmax, cfg.cs, cfg.ch)) return null;
    const ids = new R.ChunkIdsArray(); ids.resize(4096); free.push(ids);
    const n = chunky.getChunksOverlappingRect([bmin[0], bmin[2]], [bmax[0], bmax[2]], ids, 4096);
    if (!n) return null;
    for (let i = 0; i < n; i++) {
      const id = ids.get(i), node = chunky.nodes(id), nt = node.n, nodeTris = chunky.getNodeTris(id);
      const areas = new R.TriangleAreasArray(); areas.resize(nt);
      R.markWalkableTriangles(ctx, cfg.walkableSlopeAngle, verts, tris.size, nodeTris, nt, areas);
      const ok = R.rasterizeTriangles(ctx, verts, tris.size, nodeTris, areas, nt, hf, cfg.walkableClimb);
      areas.destroy();
      if (!ok) return null;
    }
    R.filterLowHangingWalkableObstacles(ctx, cfg.walkableClimb, hf);
    R.filterLedgeSpans(ctx, cfg.walkableHeight, cfg.walkableClimb, hf);
    R.filterWalkableLowHeightSpans(ctx, cfg.walkableHeight, hf);
    const chf = R.allocCompactHeightfield();
    free.push(() => R.freeCompactHeightfield(chf));
    if (!R.buildCompactHeightfield(ctx, cfg.walkableHeight, cfg.walkableClimb, hf, chf)) return null;
    if (!R.erodeWalkableArea(ctx, cfg.walkableRadius, chf)) return null;
    for (const w of water) {
      if (w.x1 < bmin[0] || w.x0 > bmax[0] || w.z1 < bmin[2] || w.z0 > bmax[2]) continue;
      const fa = new R.FloatArray(); fa.copy(w.v);
      R.markConvexPolyArea(ctx, fa, 3, w.y - DEEP, w.y - WADE, WADE_AREA, chf);
      R.markConvexPolyArea(ctx, fa, 3, w.y - 200, w.y - DEEP, DEEP_AREA, chf);
      fa.destroy();
    }
    for (const d of doors) {
      if (d.box.hi[0] < bmin[0] || d.box.lo[0] > bmax[0] || d.box.hi[2] < bmin[2] || d.box.lo[2] > bmax[2]) continue;
      R.markBoxArea(ctx, d.box.lo, d.box.hi, DOOR_AREA, chf);
    }
    if (!R.buildDistanceField(ctx, chf)) return null;
    if (!R.buildRegions(ctx, chf, cfg.borderSize, cfg.minRegionArea, cfg.mergeRegionArea)) return null;
    const cset = R.allocContourSet(); free.push(() => R.freeContourSet(cset));
    if (!R.buildContours(ctx, chf, cfg.maxSimplificationError, cfg.maxEdgeLen, cset, R.Recast.RC_CONTOUR_TESS_WALL_EDGES)) return null;
    const pmesh = R.allocPolyMesh(); free.push(() => R.freePolyMesh(pmesh));
    if (!R.buildPolyMesh(ctx, cset, cfg.maxVertsPerPoly, pmesh)) return null;
    const dmesh = R.allocPolyMeshDetail(); free.push(() => R.freePolyMeshDetail(dmesh));
    if (!R.buildPolyMeshDetail(ctx, pmesh, chf, cfg.detailSampleDist, cfg.detailSampleMaxError, dmesh)) return null;
    if (!pmesh.npolys()) return null;
    for (let i = 0; i < pmesh.npolys(); i++) {
      if (pmesh.areas(i) === R.Recast.RC_WALKABLE_AREA) pmesh.setAreas(i, 0);
      pmesh.setFlags(i, 1);
    }
    const params = new R.NavMeshCreateParams();
    params.setPolyMeshCreateParams(pmesh);
    params.setPolyMeshDetailCreateParams(dmesh);
    params.setWalkableHeight(cfg.walkableHeight * cfg.ch);
    params.setWalkableRadius(cfg.walkableRadius * cfg.cs);
    params.setWalkableClimb(cfg.walkableClimb * cfg.ch);
    params.setCellSize(cfg.cs); params.setCellHeight(cfg.ch);
    params.setBuildBvTree(false);
    params.setTileX(tile.x); params.setTileY(tile.y);
    const res = R.createNavMeshData(params);
    return res.success ? res.navMeshData : null;
  } finally {
    R.freeHeightfield(hf);
    for (const f of free) typeof f === 'function' ? f() : f.destroy();
  }
}

function generateRegion(pos, idx, config, doors, water) {
  const ctx = new R.RecastBuildContext();
  const [bbMin, bbMax] = config.bounds;
  const { config: rcConfig, tileWidth, tileHeight, tcs, orig, maxTiles, maxPolysPerTile } = buildTiledNavMeshRcConfig({ recastConfig: config, navMeshBounds: [bbMin, bbMax] });
  const navMesh = new R.NavMesh();
  if (!navMesh.initTiled(R.NavMeshParams.create({ orig, tileWidth: config.tileSize * config.cs, tileHeight: config.tileSize * config.cs, maxTiles, maxPolys: maxPolysPerTile }))) throw new Error('initTiled failed');
  const verts = new R.VerticesArray(); verts.copy(pos);
  const tris = new R.TrianglesArray(); tris.copy(idx);
  const chunky = new R.RecastChunkyTriMesh();
  if (!chunky.init(verts, tris, idx.length / 3, 256)) throw new Error('chunky tri mesh failed');
  for (let y = 0; y < tileHeight; y++) for (let x = 0; x < tileWidth; x++) {
    const tile = { x, y, bmin: [bbMin[0] + x * tcs, bbMin[1], bbMin[2] + y * tcs], bmax: [bbMin[0] + (x + 1) * tcs, bbMax[1], bbMin[2] + (y + 1) * tcs] };
    const data = buildTile(ctx, verts, tris, rcConfig, chunky, tile, doors, water);
    if (data) navMesh.addTile(data, R.Detour.DT_TILE_FREE_DATA, 0);
  }
  verts.destroy(); tris.destroy();
  return navMesh;
}

function readGeom(key) {
  const b = fs.readFileSync(path.join(ROOT, 'navmesh', 'geom', key + '.bin'));
  const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const [nv, nt] = [new Uint32Array(ab, 8, 1)[0], new Uint32Array(ab, 12, 1)[0]];
  return { verts: new Float32Array(ab, 16, nv * 3), tris: new Uint32Array(ab, 16 + nv * 12, nt * 3) };
}

function readWater(key) {
  const file = path.join(ROOT, 'navmesh', 'geom', key + '.water.bin');
  if (!fs.existsSync(file)) return [];
  const b = fs.readFileSync(file), ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  const nv = new Uint32Array(ab, 8, 1)[0], nt = new Uint32Array(ab, 12, 1)[0];
  const V = new Float32Array(ab, 16, nv * 3), T = new Uint32Array(ab, 16 + nv * 12, nt * 3), out = [];
  for (let t = 0; t < nt; t++) {
    const v = [];
    for (let k = 0; k < 3; k++) { const i = T[t * 3 + k] * 3; v.push(V[i], V[i + 1], V[i + 2]); }
    // skip vertical faces (sides of water boxes): only the surface matters
    const ux = v[3] - v[0], uz = v[5] - v[2], wx = v[6] - v[0], wz = v[8] - v[2];
    if (Math.abs(ux * wz - uz * wx) < 1e-4) continue;
    out.push({ v, y: (v[1] + v[4] + v[7]) / 3, x0: Math.min(v[0], v[3], v[6]), x1: Math.max(v[0], v[3], v[6]), z0: Math.min(v[2], v[5], v[8]), z1: Math.max(v[2], v[5], v[8]) });
  }
  return out;
}

// Triangles overlapping a plan-view box, re-indexed.
// Triangle lists per region (a triangle goes to every region its bounds overlap, with a margin).
function bucket(g, gx0, gz0, RS, nx, nz, margin) {
  const { verts: V, tris: T } = g;
  const lists = Array.from({ length: nx * nz }, () => []);
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * 3, b = T[t + 1] * 3, c = T[t + 2] * 3;
    const i0 = Math.max(0, Math.floor((Math.min(V[a], V[b], V[c]) - margin - gx0) / RS)), i1 = Math.min(nx - 1, Math.floor((Math.max(V[a], V[b], V[c]) + margin - gx0) / RS));
    const j0 = Math.max(0, Math.floor((Math.min(V[a + 2], V[b + 2], V[c + 2]) - margin - gz0) / RS)), j1 = Math.min(nz - 1, Math.floor((Math.max(V[a + 2], V[b + 2], V[c + 2]) + margin - gz0) / RS));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) lists[j * nx + i].push(t);
  }
  return lists;
}

function clip(g, x0, z0, x1, z1, list) {
  const { verts: V, tris: T } = g;
  const map = new Map(), pos = [], idx = [];
  for (const t of list) {
    const a = T[t] * 3, b = T[t + 1] * 3, c = T[t + 2] * 3;
    if (Math.max(V[a], V[b], V[c]) < x0 || Math.min(V[a], V[b], V[c]) > x1 || Math.max(V[a + 2], V[b + 2], V[c + 2]) < z0 || Math.min(V[a + 2], V[b + 2], V[c + 2]) > z1) continue;
    for (const v of [T[t], T[t + 1], T[t + 2]]) {
      let i = map.get(v);
      if (i === undefined) { i = pos.length / 3; map.set(v, i); pos.push(V[v * 3], V[v * 3 + 1], V[v * 3 + 2]); }
      idx.push(i);
    }
  }
  return { pos, idx };
}

function exportTiles(navMesh, out) {
  for (let i = 0; i < navMesh.getMaxTiles(); i++) {
    const tile = navMesh.getTile(i), h = tile.header();
    if (!h || !h.polyCount()) continue;
    const nv = h.vertCount(), verts = new Float32Array(nv * 3);
    for (let k = 0; k < nv * 3; k++) verts[k] = tile.verts(k);
    const polys = [];
    for (let p = 0; p < h.polyCount(); p++) {
      const poly = tile.polys(p);
      if (poly.getType() !== 0) continue; // off-mesh connection
      const n = poly.vertCount(), vs = [], ns = [];
      for (let k = 0; k < n; k++) { vs.push(poly.verts(k)); ns.push(poly.neis(k)); }
      polys.push({ vs, ns, area: poly.areaAndType() & 0x3f, local: p });
    }
    out.push({ verts, polys });
  }
}

// Weld tiles: shared vertices, internal portals, and tile-border portals (overlapping parts of border edges).
function weld(tiles) {
  const vkey = new Map(), verts = [];
  const vid = (x, y, z) => {
    const k = `${Math.round(x * 200)},${Math.round(y * 200)},${Math.round(z * 200)}`;
    let i = vkey.get(k);
    if (i === undefined) { i = verts.length / 3; vkey.set(k, i); verts.push(x, y, z); }
    return i;
  };
  const polys = [], areas = [], links = [];
  const border = new Map();
  for (const t of tiles) {
    const ids = [];
    for (let k = 0; k < t.verts.length / 3; k++) ids.push(vid(t.verts[k * 3], t.verts[k * 3 + 1], t.verts[k * 3 + 2]));
    const localToGlobal = new Map();
    t.polys.forEach((p, i) => localToGlobal.set(p.local, polys.length + i));
    for (const p of t.polys) { polys.push(p.vs.map(v => ids[v])); areas.push(p.area); links.push([]); }
    for (const p of t.polys) {
      const gp = localToGlobal.get(p.local), n = p.vs.length;
      for (let k = 0; k < n; k++) {
        const a = polys[gp][k], b = polys[gp][(k + 1) % n], nb = p.ns[k];
        if (!nb) continue;
        if (!(nb & EXT)) { const o = localToGlobal.get(nb - 1); if (o !== undefined) links[gp].push([o, a, b]); continue; }
        const side = nb & 0xff, axis = side === 0 || side === 4 ? 0 : 2;
        const key = axis + ':' + Math.round(verts[a * 3 + axis] * 20);
        if (!border.has(key)) border.set(key, []);
        border.get(key).push([gp, a, b]);
      }
    }
  }
  let joined = 0;
  const yAt = (a, b, axis, u) => { const d = verts[b * 3 + axis] - verts[a * 3 + axis]; if (Math.abs(d) < 1e-6) return (verts[a * 3 + 1] + verts[b * 3 + 1]) / 2; const t = (u - verts[a * 3 + axis]) / d; return verts[a * 3 + 1] + (verts[b * 3 + 1] - verts[a * 3 + 1]) * t; };
  for (const [key, edges] of border) {
    const axis = +key[0], other = axis === 0 ? 2 : 0;
    const spans = edges.map(([gp, a, b]) => { const u = verts[a * 3 + other], w = verts[b * 3 + other]; return [Math.min(u, w), Math.max(u, w), gp, a, b]; }).sort((p, q) => p[0] - q[0]);
    for (let i = 0; i < spans.length; i++) {
      const [lo, hi, gp, a, b] = spans[i];
      for (let j = i + 1; j < spans.length; j++) {
        const [lo2, hi2, gp2, a2, b2] = spans[j];
        if (lo2 >= hi - 0.01) break;
        if (gp2 === gp) continue;
        const s = Math.max(lo, lo2), e = Math.min(hi, hi2);
        if (e - s < 0.05) continue;
        const ys1 = yAt(a, b, other, s), ye1 = yAt(a, b, other, e), ys2 = yAt(a2, b2, other, s), ye2 = yAt(a2, b2, other, e);
        if (Math.abs(ys1 - ys2) > 0.6 || Math.abs(ye1 - ye2) > 0.6) continue;
        const fixed = verts[a * 3 + axis];
        const P = [0, 0, 0], Q = [0, 0, 0];
        P[axis] = Q[axis] = fixed; P[other] = s; Q[other] = e; P[1] = (ys1 + ys2) / 2; Q[1] = (ye1 + ye2) / 2;
        const va = vid(...P), vb = vid(...Q);
        links[gp].push([gp2, va, vb]); links[gp2].push([gp, va, vb]);
        joined++;
      }
    }
  }
  return { verts, polys, areas, links, joined };
}

function writeTNAV(file, { verts, polys, areas, links, door }) {
  const P = polys.length, nI = polys.reduce((s, p) => s + p.length, 0);
  const lflat = [];
  const lstart = new Uint32Array(P + 1);
  for (let i = 0; i < P; i++) {
    const seen = new Set();
    for (const [o, a, b] of links[i]) { const k = o + ',' + a + ',' + b; if (seen.has(k)) continue; seen.add(k); lflat.push(o, a, b); }
    lstart[i + 1] = lflat.length / 3;
  }
  const pstart = new Uint32Array(P + 1), pidx = new Uint32Array(nI);
  let k = 0;
  polys.forEach((p, i) => { for (const v of p) pidx[k++] = v; pstart[i + 1] = k; });
  const pad = (4 - (P % 4)) % 4;
  const parts = [
    Buffer.from('TNAV'), Buffer.from(new Uint32Array([2, verts.length / 3, P, nI, lflat.length / 3]).buffer),
    Buffer.from(new Float32Array(verts).buffer), Buffer.from(pstart.buffer), Buffer.from(pidx.buffer),
    Buffer.from(new Uint8Array(areas)), Buffer.alloc(pad), Buffer.from(lstart.buffer), Buffer.from(new Uint32Array(lflat).buffer), Buffer.from(door.buffer),
  ];
  fs.writeFileSync(file, Buffer.concat(parts));
}

async function build(key) {
  const t0 = Date.now();
  const g = readGeom(key);
  const doorsFile = path.join(ROOT, 'navmesh', 'geom', key + '.doors.json');
  // Only locked doors get their own navmesh area (to shut them for routing): shut and open doors are walked through,
  // and marking them carves narrow doorways into slivers (an open leaf's bounds lie across the frame).
  const doors = (fs.existsSync(doorsFile) ? JSON.parse(fs.readFileSync(doorsFile, 'utf8')) : []).filter(d => d.active && d.state === 1);
  for (const d of doors) d.box = doorBox(d);
  const water = readWater(key);
  if (water.length) console.log(`  ${water.length} water triangles`);
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < g.verts.length; i += 3) {
    const x = g.verts[i], y = g.verts[i + 1], z = g.verts[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const bounds = JSON.parse(process.env.NAV_BOUNDS || 'null');
  if (bounds) [x0, z0, x1, z1] = bounds;
  const gx0 = Math.floor(x0 / TILE_M) * TILE_M, gz0 = Math.floor(z0 / TILE_M) * TILE_M;
  const RS = REGION_TILES * TILE_M;
  const tiles = [];
  const nx = Math.ceil((x1 - gx0) / RS), nz = Math.ceil((z1 - gz0) / RS);
  console.log(`${key}: ${g.tris.length / 3} tris, ${(x1 - x0).toFixed(0)} x ${(z1 - z0).toFixed(0)} m, ${nx * nz} regions`);
  const margin = CFG.walkableRadius * CS + 2;
  const buckets = bucket(g, gx0, gz0, RS, nx, nz, margin);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const rx0 = gx0 + i * RS, rz0 = gz0 + j * RS;
    const { pos, idx } = clip(g, rx0 - margin, rz0 - margin, rx0 + RS + margin, rz0 + RS + margin, buckets[j * nx + i]);
    if (!idx.length) continue;
    // Recast tiles need a border to see geometry just outside them (walls next to the tile edge).
    // Height range of this region's geometry; Recast spans hold 13 bits of height (819 m at 0.1 m), so far-below
    // kill planes (Reserve has one at -985 m) are cut off by keeping the top 600 m.
    let ry0 = Infinity, ry1 = -Infinity;
    for (let k = 1; k < pos.length; k += 3) { if (pos[k] < ry0) ry0 = pos[k]; if (pos[k] > ry1) ry1 = pos[k]; }
    ry0 = Math.max(ry0, ry1 - 600);
    const cfg = { ...CFG, borderSize: CFG.walkableRadius + 3, bounds: [[rx0, ry0 - 1, rz0], [rx0 + RS, ry1 + 1, rz0 + RS]] };
    const navMesh = generateRegion(pos, idx, cfg, doors, water);
    const before = tiles.length;
    exportTiles(navMesh, tiles);
    navMesh.destroy();
    process.stdout.write(`  region ${i},${j}: ${idx.length / 3} tris -> ${tiles.length - before} tiles\n`);
  }
  const w = weld(tiles);
  // Which door each door-area poly belongs to (the door whose volume holds its centre).
  w.door = new Int32Array(w.polys.length).fill(-1);
  let doorPolys = 0;
  w.polys.forEach((p, i) => {
    if (w.areas[i] !== DOOR_AREA) return;
    let x = 0, y = 0, z = 0;
    for (const v of p) { x += w.verts[v * 3]; y += w.verts[v * 3 + 1]; z += w.verts[v * 3 + 2]; }
    x /= p.length; y /= p.length; z /= p.length;
    let best = -1, bd = Infinity;
    doors.forEach((d, k) => {
      const b = d.box, dd = Math.max(b.lo[0] - x, 0, x - b.hi[0]) + Math.max(b.lo[2] - z, 0, z - b.hi[2]) + Math.max(b.lo[1] - y, 0, y - b.hi[1]);
      if (dd < bd) { bd = dd; best = k; }
    });
    if (best >= 0 && bd < 0.5) { w.door[i] = best; doorPolys++; }
  });
  writeTNAV(path.join(ROOT, 'navmesh', key + '.bin'), w);
  const meta = { map: key, built: new Date().toISOString(), config: CFG,
    doors: doors.map(d => ({ id: d.id, key: d.key, state: d.state, class: d.class, name: d.name, pos: d.pos, lo: d.box.lo, hi: d.box.hi })) };
  fs.writeFileSync(path.join(ROOT, 'navmesh', key + '.json'), JSON.stringify(meta));
  console.log(`  ${doors.length} doors, ${doorPolys} door polys`);
  console.log(`${key}: ${w.polys.length} polys, ${w.verts.length / 3} verts, ${w.joined} border portals, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

await init();
for (const key of process.argv.slice(2)) await build(key);
