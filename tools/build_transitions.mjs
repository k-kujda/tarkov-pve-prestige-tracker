// Build floor-transition markers for each map from the walkable navmesh.
// Outputs only REAL level connectors that a player uses to change storey:
//   - Staircases / ramps connecting two stacked floor levels (height gain >= 2.2 m).
//   - Drop-downs / climb-ups between stacked levels with |dy| >= 1.5 m.
//   - Ladders, hatches (via explicit linkKind 2/4 with large dy).
//
// Floor layers are the served map data's (server.js withLocalData: tarkov.dev's layers plus data/floors.json,
// data/floor-areas.json and data/map-transforms.json).  Maps with no floors (Woods, Lighthouse) use storeys:
// how many walkable floors lie right beneath a surface.
//
// Kept: both landings have another walkable floor right above or below them (a storey, 2.2–15 m apart), both are
// inside the drawn map, and on maps without floor data the connector is within 20 m of a door. That drops hills,
// cliffs and rock overhangs that cross a height band.
//
// Algorithm:
//   Walk links (kind 0):
//     1. Collect all cross-floor walk-link edges with |edge_dy| <= 8 m (excludes extreme
//        artifact links that span the full depth between real map and off-map polys).
//     2. Cluster by (sorted floor pair, XZ proximity <= WALK_CLUSTER_R = 10 m,
//        Y proximity <= WALK_CLUSTER_Y = 15 m).  The Y gate prevents deep artifact
//        clusters at y ≈ -200 m from merging with real staircase clusters at y ≈ -7 m
//        that share the same XZ footprint (reserve bunker + artifact chain, for example).
//     3. For each cluster compute per-floor seed-Y extents and do a walk-only BFS
//        within BFS_RADIUS = 20 m from the cluster centroid.  Polys whose Y falls
//        outside [seed_minY − 12, seed_maxY + 12] for their floor are excluded from
//        the Y statistics (BFS_Y_BUFFER, prevents artifact expansion during BFS).
//     4. Compute IQR-trimmed-mean Y for each floor in the BFS result.
//     5. Accept only clusters where |trimMean_upper − trimMean_lower| >= 2.2 m.
//     6. from  = lower floor (lower trimmed-mean Y), to = upper floor.
//        from.y  = trimmed-mean Y of lower-floor BFS polys.
//        to.y    = trimmed-mean Y of upper-floor BFS polys.
//        from.x/z = centroid of lower-floor seed polys; to.x/z of upper-floor seeds.
//        kind = 'stairs' (or 'ramp' when XZ span >> vertical span).
//
//   Drop / climb links (kind 1 = drop, 2 = climb):
//     1. Collect cross-floor links with |dy| >= DROP_MIN_DY = 1.5 m.
//     2. Cluster by (sorted floor pair, broad kind, XZ proximity <= DC_CLUSTER_R = 8 m).
//     3. Accept only clusters where cluster-mean |dy| >= 2.2 m.
//     4. from.y = IQR-trimmed-mean of lower endpoint Y values (robust to artifact polys).
//        to.y   = IQR-trimmed-mean of upper endpoint Y values.
//        Post-filter: skip if |to.y − from.y| < 2.2 m (floating-point safety).
//     5. kind = 'drop' (kind 1 or 3), 'ladder' (kind 2 with mean dy > 4 m) or 'climb'.
//
//   floorOf(): mirrors index.html logic exactly — checks layer extents+areas in order,
//     falls back to 'Ground floor'.  Layer data from latest cache/pve-v*.json mapDefs.
//
//   Output schema per record:
//     {
//       kind:      "stairs" | "ramp" | "ladder" | "drop" | "climb",
//       from:      { floor: string, x, y, z },
//       to:        { floor: string, x, y, z },
//       building:  string | null,
//       fromFloor: string,   // same as from.floor, for debug
//       toFloor:   string,   // same as to.floor, for debug
//     }
//
// Usage: node --max-old-space-size=12000 tools/build_transitions.mjs [map ...]
// Default: all maps.  Maps run 3 at a time in parallel.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT    = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const N       = require('../nav.js');

const MAPS = [
  'customs', 'factory', 'woods', 'shoreline', 'interchange', 'the-lab', 'reserve',
  'lighthouse', 'streets-of-tarkov', 'ground-zero', 'the-labyrinth', 'terminal', 'icebreaker',
];

// ── Constants ────────────────────────────────────────────────────────────────
const WALK_CLUSTER_R   = 10;  // m — XZ radius for clustering walk cross-floor links
const WALK_CLUSTER_Y   = 15;  // m — Y radius for clustering walk cross-floor links (separates real from artifact)
const DC_CLUSTER_R     = 8;   // m — XZ radius for clustering drop/climb links
const BFS_RADIUS       = 20;  // m — XZ radius for the landing-Y BFS expansion
const MIN_DY           = 2.2; // m — minimum height gain to be a real level connector
const DROP_MIN_DY      = 1.5; // m — minimum |dy| per drop/climb link to consider
const MAX_WALK_LINK_DY = 8;   // m — skip walk cross-floor edges with |dy| > this (artifact links)
const BUILDING_RADIUS  = 40;  // m — label search radius for building name
const round2          = v => Math.round(v * 100) / 100;

// ── Data loading ─────────────────────────────────────────────────────────────
function loadCacheData() {
  const dir  = path.join(ROOT, 'cache');
  const file = fs.readdirSync(dir)
    .filter(f => /^pve-v\d+\.json$/.test(f))
    .sort((a, b) => parseInt(b.slice(5)) - parseInt(a.slice(5)))[0];
  return JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')).data;
}

function loadFloorsJson() {
  const fp = path.join(ROOT, 'data', 'floors.json');
  if (!fs.existsSync(fp)) return {};
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

// Convert floors.json array to the layers format used by floorOf:
//   [{name, height[, short]}] → [{name, height, extents:[]}]
function floorsToLayers(arr) {
  return arr.map(e => ({ name: e.name, height: e.height, extents: [] }));
}

// ── Floor label assignment ────────────────────────────────────────────────────
// Mirrors the floorMatch / floorOf logic from index.html exactly.
// Returns the floor name string (layer.name if matched, 'Ground floor' otherwise).
const GROUND = 'Ground floor';

function floorOf(m, p, layers) {
  const x = m.cx[p], y = m.cy[p], z = m.cz[p];
  for (const layer of layers) {
    const exts = (layer.extents && layer.extents.length > 0) ? layer.extents : [{ height: layer.height, areas: [] }];
    for (const ext of exts) {
      if (y < ext.height[0] || y >= ext.height[1]) continue;
      const areas = ext.areas || [];
      if (areas.length === 0) return layer.name;      // height-band only
      for (const area of areas) {
        const x1 = Math.min(area.x1, area.x2), x2 = Math.max(area.x1, area.x2);
        const z1 = Math.min(area.z1, area.z2), z2 = Math.max(area.z1, area.z2);
        if (x >= x1 && x <= x2 && z >= z1 && z <= z2) return layer.name;
      }
    }
  }
  return GROUND;
}

// ── Nearest building label ───────────────────────────────────────────────────
function nearestLabel(labels, x, z) {
  if (!labels || !labels.length) return null;
  let best = null, bd = BUILDING_RADIUS;
  for (const l of labels) {
    const d = Math.hypot((l.x || 0) - x, (l.z || 0) - z);
    if (d < bd) { bd = d; best = l; }
  }
  return best ? (best.text || '').replace(/\n/g, ' ') : null;
}

// ── Clustering ───────────────────────────────────────────────────────────────
// Greedy XZ clustering.  Returns array of {cx, cz, items[]} objects.
// pts must have {x, z} fields.
function clusterByXZ(pts, radius) {
  const clusters = [];
  for (const pt of pts) {
    let best = null, bestD = radius;
    for (const c of clusters) {
      const d = Math.hypot(c.cx - pt.x, c.cz - pt.z);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best) {
      best.items.push(pt);
      const n = best.items.length;
      best.cx = best.items.reduce((s, i) => s + i.x, 0) / n;
      best.cz = best.items.reduce((s, i) => s + i.z, 0) / n;
    } else {
      clusters.push({ cx: pt.x, cz: pt.z, items: [pt] });
    }
  }
  return clusters;
}

// XZ+Y clustering — like clusterByXZ but also checks |cy - pt.y| <= yRadius.
// pts must have {x, y, z} fields.  Prevents deep artifact links from merging with
// real map staircases that share the same XZ footprint.
function clusterByXZY(pts, xzRadius, yRadius) {
  const clusters = [];
  for (const pt of pts) {
    let best = null, bestD = xzRadius;
    for (const c of clusters) {
      if (Math.abs(c.cy - pt.y) > yRadius) continue;
      const d = Math.hypot(c.cx - pt.x, c.cz - pt.z);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best) {
      best.items.push(pt);
      const n = best.items.length;
      best.cx = best.items.reduce((s, i) => s + i.x, 0) / n;
      best.cy = best.items.reduce((s, i) => s + i.y, 0) / n;
      best.cz = best.items.reduce((s, i) => s + i.z, 0) / n;
    } else {
      clusters.push({ cx: pt.x, cy: pt.y, cz: pt.z, items: [pt] });
    }
  }
  return clusters;
}

// ── Walk-only BFS within radius ───────────────────────────────────────────────
// Returns a Map<floorLabel → [y values]> for all polys reachable via walk (kind 0) links.
// yBand: optional Map<floorLabel → [minY, maxY]> — if present, only include polys whose
// Y is within [minY - BFS_Y_BUFFER, maxY + BFS_Y_BUFFER].  This excludes deep off-map
// artifact polys (e.g., reserve bunkers at y = -140 m) from contaminating floor statistics.
const BFS_Y_BUFFER = 12;   // m — allowed Y deviation from seed-poly Y range per floor

function bfsFloorYs(m, polyFloor, seedPolys, cx, cz, radius, yBand) {
  const visited = new Set(seedPolys);
  const queue   = seedPolys.slice();
  const byFloor = new Map();

  const addPoly = p => {
    const fl = polyFloor[p];
    if (yBand) {
      const b = yBand.get(fl);
      if (b && (m.cy[p] < b[0] - BFS_Y_BUFFER || m.cy[p] > b[1] + BFS_Y_BUFFER)) return;
    }
    if (!byFloor.has(fl)) byFloor.set(fl, []);
    byFloor.get(fl).push(m.cy[p]);
  };

  for (const p of seedPolys) addPoly(p);

  while (queue.length) {
    const cur = queue.shift();
    for (let l = m.lstart[cur]; l < m.lstart[cur + 1]; l++) {
      if (m.linkKind && m.linkKind[l] !== 0) continue;   // walk links only
      const nb = m.links[l * 3];
      if (visited.has(nb)) continue;
      if (Math.hypot(m.cx[nb] - cx, m.cz[nb] - cz) > radius) continue;
      visited.add(nb);
      queue.push(nb);
      addPoly(nb);
    }
  }
  return byFloor;
}

function mean(arr) { return arr.reduce((s, v) => s + v, 0) / arr.length; }
function median(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
// IQR-trimmed mean: use middle 50% of values (robust to extreme outliers such as off-map polys).
function trimmedMean(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const q1 = Math.floor(s.length * 0.25), q3 = Math.ceil(s.length * 0.75);
  const trimmed = s.slice(q1, q3);
  return trimmed.length ? trimmed.reduce((a, b) => a + b, 0) / trimmed.length : mean(s);
}

// ── Transition detection ─────────────────────────────────────────────────────
function buildTransitions(m, layers, labels) {
  // Assign floor labels
  const polyFloor = new Array(m.P);
  for (let p = 0; p < m.P; p++) polyFloor[p] = typeof layers === 'function' ? layers(p) : floorOf(m, p, layers);

  const out = [];

  // ── 1. Walk link clusters ────────────────────────────────────────────────
  {
    // Collect raw cross-floor walk edges (undirected, deduplicated)
    const rawWalk = [];
    const seen    = new Set();

    for (let p = 0; p < m.P; p++) {
      for (let l = m.lstart[p]; l < m.lstart[p + 1]; l++) {
        if (m.linkKind && m.linkKind[l] !== 0) continue;
        const q   = m.links[l * 3];
        if (q <= p) continue;
        if (polyFloor[p] === polyFloor[q]) continue;
        // Skip artifact-level connections (e.g., y=-140 artifact linked to y=-7 real map).
        if (Math.abs(m.cy[p] - m.cy[q]) > MAX_WALK_LINK_DY) continue;
        const eid = p * 200000 + q;
        if (seen.has(eid)) continue;
        seen.add(eid);
        rawWalk.push({
          p, q,
          x: (m.cx[p] + m.cx[q]) / 2,
          y: (m.cy[p] + m.cy[q]) / 2,   // link Y midpoint — used for XZ+Y clustering
          z: (m.cz[p] + m.cz[q]) / 2,
          fp: polyFloor[p],
          fq: polyFloor[q],
        });
      }
    }

    // Group by sorted floor pair, cluster within XZ+Y radius
    const groups = new Map();
    for (const e of rawWalk) {
      const [a, b] = [e.fp, e.fq].sort();
      const gk = a + '|' + b;
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk).push(e);
    }

    for (const [gk, edges] of groups) {
      const clusters = clusterByXZY(edges, WALK_CLUSTER_R, WALK_CLUSTER_Y);

      for (const c of clusters) {
        // Collect all seed polys for the BFS
        const seedSet = new Set();
        for (const e of c.items) { seedSet.add(e.p); seedSet.add(e.q); }
        const seeds = [...seedSet];

        // Compute per-floor Y bands from seed polys to filter artifact polys in the BFS.
        const [flA, flB] = gk.split('|');
        const yBand = new Map();
        for (const p of seeds) {
          const fl = polyFloor[p], y = m.cy[p];
          const b = yBand.get(fl);
          if (!b) yBand.set(fl, [y, y]);
          else { b[0] = Math.min(b[0], y); b[1] = Math.max(b[1], y); }
        }

        // Walk-only BFS within BFS_RADIUS from centroid, Y-range filtered.
        const byFloor = bfsFloorYs(m, polyFloor, seeds, c.cx, c.cz, BFS_RADIUS, yBand);

        // Need Y statistics for both floors in the group key
        const ysA = byFloor.get(flA) || [];
        const ysB = byFloor.get(flB) || [];
        if (!ysA.length || !ysB.length) continue;

        // Use trimmed means (IQR) to be robust to extreme off-map polys.
        const mA = trimmedMean(ysA), mB = trimmedMean(ysB);
        if (Math.abs(mA - mB) + 1e-9 < MIN_DY) continue;  // not a real storey change

        // Lower floor = the one with lower trimmed-mean Y
        const [loFloor, hiFloor, loYs, hiYs] =
          mA < mB ? [flA, flB, ysA, ysB] : [flB, flA, ysB, ysA];

        const loMeanY = trimmedMean(loYs), hiMeanY = trimmedMean(hiYs);

        // Use cluster centroid for x/z (staircase x/z is approximated by midpoints of links)
        const fromXs = [], fromZs = [], toXs = [], toZs = [];
        for (const e of c.items) {
          if (polyFloor[e.p] === loFloor) { fromXs.push(m.cx[e.p]); fromZs.push(m.cz[e.p]); }
          else                            { toXs.push(m.cx[e.p]);   toZs.push(m.cz[e.p]);   }
          if (polyFloor[e.q] === loFloor) { fromXs.push(m.cx[e.q]); fromZs.push(m.cz[e.q]); }
          else                            { toXs.push(m.cx[e.q]);   toZs.push(m.cz[e.q]);   }
        }
        const fx = fromXs.length ? mean(fromXs) : c.cx;
        const fz = fromZs.length ? mean(fromZs) : c.cz;
        const tx = toXs.length   ? mean(toXs)   : c.cx;
        const tz = toZs.length   ? mean(toZs)   : c.cz;

        // Kind: 'ramp' if horizontal span is >> vertical span, else 'stairs'
        const xzSpan = c.items.length > 0
          ? Math.max(...c.items.map(e => Math.hypot(m.cx[e.p] - c.cx, m.cz[e.p] - c.cz)))
          : 0;
        const dySpan = Math.abs(hiMeanY - loMeanY);
        const kind   = xzSpan > 3 * dySpan ? 'ramp' : 'stairs';

        const building = nearestLabel(labels, c.cx, c.cz);

        out.push({
          kind,
          from:      { floor: loFloor, x: round2(fx), y: round2(loMeanY), z: round2(fz) },
          to:        { floor: hiFloor, x: round2(tx), y: round2(hiMeanY), z: round2(tz) },
          building,
          fromFloor: loFloor,
          toFloor:   hiFloor,
        });
      }
    }
  }

  // ── 2. Drop / climb clusters ─────────────────────────────────────────────
  {
    const rawDC = [];
    const seen  = new Set();

    for (let p = 0; p < m.P; p++) {
      for (let l = m.lstart[p]; l < m.lstart[p + 1]; l++) {
        const kd = m.linkKind ? m.linkKind[l] : 0;
        if (kd !== 1 && kd !== 2 && kd !== 3 && kd !== 4) continue;
        const q   = m.links[l * 3];
        const eid = Math.min(p, q) * 200000 + Math.max(p, q);
        if (seen.has(eid)) continue;
        seen.add(eid);
        const dy = m.cy[q] - m.cy[p];
        if (Math.abs(dy) < DROP_MIN_DY) continue;
        if (polyFloor[p] === polyFloor[q]) continue;
        const loP = dy < 0 ? q : p;  // lower poly
        const hiP = dy < 0 ? p : q;  // higher poly
        rawDC.push({
          kd,
          loP, hiP,
          x: (m.cx[p] + m.cx[q]) / 2,
          z: (m.cz[p] + m.cz[q]) / 2,
          fp: polyFloor[p],
          fq: polyFloor[q],
          dy: Math.abs(dy),
        });
      }
    }

    // Group by sorted floor pair + broad kind (drop vs climb)
    const groups = new Map();
    for (const e of rawDC) {
      const [a, b] = [e.fp, e.fq].sort();
      // kind 1,3 = drop; kind 2,4 = climb
      const kindGroup = (e.kd === 1 || e.kd === 3) ? 'drop' : 'climb';
      const gk = a + '|' + b + '|' + kindGroup;
      if (!groups.has(gk)) groups.set(gk, []);
      groups.get(gk).push(e);
    }

    for (const [gk, edges] of groups) {
      const clusters = clusterByXZ(edges, DC_CLUSTER_R);

      for (const c of clusters) {
        const avgDy = mean(c.items.map(e => e.dy));
        if (avgDy + 1e-9 < MIN_DY) continue;   // +epsilon handles float rounding of exact 2.2

        const loXs = c.items.map(e => m.cx[e.loP]);
        const loYs = c.items.map(e => m.cy[e.loP]);
        const loZs = c.items.map(e => m.cz[e.loP]);
        const hiXs = c.items.map(e => m.cx[e.hiP]);
        const hiYs = c.items.map(e => m.cy[e.hiP]);
        const hiZs = c.items.map(e => m.cz[e.hiP]);

        // Use dominant floor for from/to
        const loFloorCounts = new Map();
        const hiFloorCounts = new Map();
        for (const e of c.items) {
          const lf = polyFloor[e.loP], hf = polyFloor[e.hiP];
          loFloorCounts.set(lf, (loFloorCounts.get(lf) || 0) + 1);
          hiFloorCounts.set(hf, (hiFloorCounts.get(hf) || 0) + 1);
        }
        const domLoFloor = [...loFloorCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        const domHiFloor = [...hiFloorCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];

        const parts = gk.split('|');
        const kindGroup = parts[2];  // 'drop' or 'climb'
        let kind = kindGroup;
        if (kindGroup === 'climb' && avgDy > 4) kind = 'ladder';

        const building = nearestLabel(labels, c.cx, c.cz);

        // Use trimmedMean for Y to resist artifact polys below the real map.
        const fromY = round2(trimmedMean(loYs));
        const toY   = round2(trimmedMean(hiYs));
        // Post-filter: computed Y difference must still be >= MIN_DY (float safety).
        if (toY - fromY + 1e-9 < MIN_DY) continue;
        out.push({
          kind,
          from:      { floor: domLoFloor, x: round2(mean(loXs)), y: fromY, z: round2(mean(loZs)) },
          to:        { floor: domHiFloor, x: round2(mean(hiXs)), y: toY,   z: round2(mean(hiZs)) },
          building,
          fromFloor: domLoFloor,
          toFloor:   domHiFloor,
        });
      }
    }
  }

  return out;
}

// ── Main ─────────────────────────────────────────────────────────────────────
// The served map data: tarkov.dev's plus the local fixes in data/ (floors, floor areas, projections).
const cacheData  = require('../server.js').withLocalData(loadCacheData());
const floorsJson = loadFloorsJson();
const keys       = process.argv.slice(2).length ? process.argv.slice(2) : MAPS;

fs.mkdirSync(path.join(ROOT, 'data', 'transitions'), { recursive: true });

const PARALLELISM = 3;

async function processMap(key) {
  const binPath = path.join(ROOT, 'navmesh', key + '.bin');
  if (!fs.existsSync(binPath)) {
    console.log(`${key}: no navmesh — skip`);
    return;
  }

  // Resolve floor layers
  const mapDef = (cacheData.mapDefs || {})[key] || {};
  let layers, m0 = null;
  if (mapDef.layers && mapDef.layers.length > 0) {
    layers = mapDef.layers;
  } else if (floorsJson[key]) {
    layers = floorsToLayers(floorsJson[key]);
  } else {
    // No floors defined (Woods, Lighthouse): a surface's storey is how many walkable floors lie right beneath it, so
    // a chalet's upper floor is storey 1 wherever the hillside under it is.
    m0 = N.parse(fs.readFileSync(binPath));
    const storey = new Int16Array(m0.P);
    for (let p = 0; p < m0.P; p++) {
      const ys = [];
      for (const q of N.polysNear(m0, m0.cx[p], m0.cz[p], 0.3)) {
        if (q === p) continue;
        const c = N.closestOnPoly(m0, q, m0.cx[p], m0.cz[p]);
        if (c.d < 0.05 && c.y < m0.cy[p] - MIN_DY) ys.push(c.y);
      }
      ys.sort((a, b) => b - a);
      let n = 0, last = m0.cy[p];
      for (const y of ys) if (last - y >= MIN_DY) { n++; last = y; }
      storey[p] = n;
    }
    layers = q => 'Storey ' + storey[q];
    console.log(`${key}: no floor layers — storeys from stacked walkable floors`);
  }

  const labels = mapDef.labels || [];
  const m      = m0 || N.parse(fs.readFileSync(binPath));

  // Keep only connectors between stacked levels: one landing has another walkable floor right above or below it
  // (a storey, 2.2–15 m apart). Hillsides and terrain crossing a map-wide height band never do.
  const stacked = q => N.polysNear(m, q.x, q.z, 1).some(pp => {
    const c = N.closestOnPoly(m, pp, q.x, q.z), dy = Math.abs(c.y - q.y);
    return c.d < 0.3 && dy >= MIN_DY && dy <= 15;
  });
  const all = buildTransitions(m, layers, labels);
  // ...and inside the drawn map (outside it are the out-of-bounds mountains, where rock overhangs look stacked).
  const bd = mapDef.bounds;
  const inMap = q => !bd || (q.x >= Math.min(bd[0][0], bd[1][0]) && q.x <= Math.max(bd[0][0], bd[1][0]) && q.z >= Math.min(bd[0][1], bd[1][1]) && q.z <= Math.max(bd[0][1], bd[1][1]));
  // Without floor data, rock overhangs stack too: there only connectors within 20 m of a door count (buildings).
  const doors = m0 ? (JSON.parse(fs.readFileSync(path.join(ROOT, 'navmesh', key + '.json'), 'utf8')).doors || []) : null;
  const byDoor = q => !doors || doors.some(d => Math.hypot(d.pos[0] - q.x, d.pos[2] - q.z) < 20 && Math.abs(d.pos[1] - q.y) < 8);
  const transitions = all.filter(t => stacked(t.from) && stacked(t.to) && inMap(t.from) && inMap(t.to) && byDoor(t.from));
  console.log(`${key}: ${all.length - transitions.length} of ${all.length} dropped (no stacked level at either landing, or outside the map)`);

  const json = JSON.stringify(transitions, null, 2);
  fs.writeFileSync(path.join(ROOT, 'data', 'transitions', key + '.json'), json);

  // Summary by kind
  const counts = {};
  for (const t of transitions) counts[t.kind] = (counts[t.kind] || 0) + 1;
  const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') || '(none)';
  console.log(`${key}: ${transitions.length} transitions [${summary}]`);
  return transitions.length;
}

// Run maps in batches of PARALLELISM
const totals = {};
for (let i = 0; i < keys.length; i += PARALLELISM) {
  const batch   = keys.slice(i, i + PARALLELISM);
  const results = await Promise.all(batch.map(k => processMap(k)));
  for (let j = 0; j < batch.length; j++) {
    if (results[j] != null) totals[batch[j]] = results[j];
  }
}

const total = Object.values(totals).reduce((s, v) => s + v, 0);
console.log(`\nTotal: ${total} transitions across ${Object.keys(totals).length} maps`);
