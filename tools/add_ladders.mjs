// Add off-mesh navigation links for climbable ladders and hatches whose top and bottom
// navmesh polys land in disconnected components (i.e. the ladder geometry is absent from
// the walkable mesh, unlike most ladders which Recast already captures as walkable rung surfaces).
//
// Investigation summary (2026-10):
//   - No dedicated Ladder / LadderTrigger / Climbable MonoBehaviour class exists in 1.x scenes.
//   - Tarkov ladders are solid-geometry walkable by Recast; the AI navmesh confirms this.
//   - Confirmed navigable: the-lab LadderLevel shafts, customs construction_ladder, all others.
//   - One real gap found: shoreline EastWing FarSideLadder — a ~9.7 m shaft connecting a
//     small isolated sub-floor (226 polys, comp ≠ big) to the main sanatorium roof area.
//   - Source: SpatialAudioPortal GameObjects named *Ladder*/*Hatch* were extracted from all
//     map scenes and grouped by XZ proximity; connectivity was tested with N.findPath.
//
// Runs after add_links.mjs (v3 binary required), updates navmesh/<map>.bin in place.
//
// Link kinds used:
//   KIND=2 (climb) for the upward direction — matches existing climb semantics.
//   KIND=1 (drop)  for the downward direction — matches existing drop semantics.
//   KIND=4 (ladder) is defined as a constant for future use; nav.js must add
//     MOVE_COST[4] = 5 (5 extra metres per full-shaft climb) before KIND_LADDER_UP
//     can be switched to 4 without breaking pathfinding.
//
// Usage: node tools/add_ladders.mjs <map> [...]

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const N = require('../nav.js');

// Change KIND_LADDER_UP to 4 once nav.js MOVE_COST is extended to [0, 1, 3, 2, 5].
const KIND_LADDER_UP = 2;   // climb  (nav.js MOVE_COST[2] = 3 extra metres)
const KIND_LADDER_DOWN = 1; // drop   (nav.js MOVE_COST[1] = 1 extra metre)
// export const KIND_LADDER = 4;  // future: dedicated ladder kind

// Baked-in ladder shaft data extracted from SpatialAudioPortal GameObjects (see header).
// Only shafts with confirmed connectivity gaps are listed.  Navigable shafts — where Recast
// already built walkable rung surfaces — are not listed (they need no extra links).
// Each entry: bottom and top are the portal-trigger world positions; the tool snaps them to
// the nearest navmesh poly before adding the link.
const LADDER_SHAFTS = {
  // factory: all ladder shafts connected (Coridor_smerti ladder at ~(67,-1,10) is walkable)
  // customs: all ladder shafts connected (construction_ladder at ~(196,0,-139) is walkable)
  // woods, reserve: no named ladder portals found
  // the-lab: all LadderLevel shafts (-125, -335) and Medical ladders connected via rung geometry
  // interchange, lighthouse, streets-of-tarkov, ground-zero: all shafts connected
  // the-labyrinth, terminal, icebreaker: no ladder portals found

  shoreline: [
    {
      // EastWing FarSideLadder: small isolated sub-floor (comp ≠ main) → sanatorium roof.
      // AudioPortal: FROM_EastWing_ToTheRoof_TO_EastWing_FarSideLadder (1) at top,
      //              FROM_EastWing_1st_MainHall_TO_EastWing_BackSideLadder at bottom area.
      bottom: [-358.65, -3.84, -87.74],
      top:    [-358.51,  5.84, -85.37],
      note: 'EastWing_FarSideLadder',
    },
  ],
};

function addLadderLinks(key) {
  const shafts = LADDER_SHAFTS[key];
  if (!shafts || shafts.length === 0) {
    console.log(`${key}: no unconnected ladder shafts defined — skip`);
    return;
  }

  const binPath = path.join(ROOT, 'navmesh', key + '.bin');
  if (!fs.existsSync(binPath)) {
    console.error(`${key}: navmesh not found at ${binPath}`);
    return;
  }

  const m = N.parse(fs.readFileSync(binPath));
  const { verts, pstart, pidx, area, lstart, links, P } = m;
  const origV = m.V; // vertex count before we add any

  // First pass: snap all shafts and validate
  const toAdd = []; // {bPoly, tPoly, bPos:[x,y,z], tPos:[x,y,z], note}
  for (const shaft of shafts) {
    const bLoc = N.locate(m, { x: shaft.bottom[0], z: shaft.bottom[2], y: shaft.bottom[1] });
    const tLoc = N.locate(m, { x: shaft.top[0],    z: shaft.top[2],    y: shaft.top[1]    });

    if (!bLoc || !tLoc) {
      console.log(`${key}: ${shaft.note}: could not snap to navmesh — skip`);
      continue;
    }
    if (m.comp[bLoc.poly] === m.comp[tLoc.poly]) {
      console.log(`${key}: ${shaft.note}: already connected (comp=${m.comp[bLoc.poly]}) — skip`);
      continue;
    }
    const dy = (shaft.top[1] - shaft.bottom[1]).toFixed(1);
    console.log(`${key}: +ladder ${shaft.note} dy=${dy}m  bottom=p${bLoc.poly}(y=${bLoc.y.toFixed(2)}) top=p${tLoc.poly}(y=${tLoc.y.toFixed(2)})`);
    toAdd.push({ bPoly: bLoc.poly, tPoly: tLoc.poly, bPos: [bLoc.x, bLoc.y, bLoc.z], tPos: [tLoc.x, tLoc.y, tLoc.z], note: shaft.note });
  }

  if (toAdd.length === 0) {
    console.log(`${key}: no new ladder links needed`);
    return;
  }

  // Assign new vertex indices and build per-poly extra link lists
  const extraVerts = [];
  const extra = Array.from({ length: P }, () => []); // poly -> [[other, va, vb, kind], ...]
  let vi = origV;
  for (const s of toAdd) {
    const vBot = vi++;
    const vTop = vi++;
    extraVerts.push(...s.bPos, ...s.tPos);
    extra[s.bPoly].push([s.tPoly, vBot, vTop, KIND_LADDER_UP]);   // climb up
    extra[s.tPoly].push([s.bPoly, vTop, vBot, KIND_LADDER_DOWN]); // drop down
  }
  const totalV = vi;

  // Build updated vertex array
  const allV = new Float32Array(totalV * 3);
  allV.set(verts);
  allV.set(new Float32Array(extraVerts), origV * 3);

  // Build updated link arrays
  const lflat = [], kinds = [], lstart2 = new Uint32Array(P + 1);
  for (let p = 0; p < P; p++) {
    for (let l = lstart[p]; l < lstart[p + 1]; l++) {
      lflat.push(links[l * 3], links[l * 3 + 1], links[l * 3 + 2]);
      kinds.push(m.linkKind ? m.linkKind[l] : 0);
    }
    for (const [o, a, b, kd] of extra[p]) {
      lflat.push(o, a, b);
      kinds.push(kd);
    }
    lstart2[p + 1] = lflat.length / 3;
  }

  const nI = pidx.length;
  const pad  = (4 - (P % 4)) % 4;
  const kpad = (4 - (kinds.length % 4)) % 4;

  const parts = [
    Buffer.from('TNAV'),
    Buffer.from(new Uint32Array([3, totalV, P, nI, lflat.length / 3]).buffer),
    Buffer.from(allV.buffer),
    Buffer.from(pstart.slice().buffer),
    Buffer.from(pidx.slice().buffer),
    Buffer.from(area.slice()),
    Buffer.alloc(pad),
    Buffer.from(lstart2.buffer),
    Buffer.from(new Uint32Array(lflat).buffer),
    Buffer.from((m.door || new Int32Array(P).fill(-1)).slice().buffer),
    Buffer.from(new Uint8Array(kinds)),
    Buffer.alloc(kpad),
  ];
  fs.writeFileSync(binPath, Buffer.concat(parts));
  console.log(`${key}: wrote ${toAdd.length} ladder link pair(s) (+${extraVerts.length / 3} verts, total ${lflat.length / 3} links)`);
}

for (const key of process.argv.slice(2)) addLadderLinks(key);
