"""Extract the AI navmesh of every Tarkov map from the local game install into navmesh/ai/<map>.bin (the bots' mesh, used to cross-check the player navmesh).

The bots' baked Unity NavMesh (NavMeshData in the map's *_AI scene) is the walkable surface of the map:
walls, fences, floors, stairs and drops are all in it. Unity stores it as Detour-style tiles
("DNAV", version 16): header, verts, polys, detail meshes, detail verts, detail tris, BV tree.

Usage: python tools/extract_navmesh.py [game dir]   (needs: pip install UnityPy numpy)
"""
import os
import struct
import sys
import json
import time
from collections import defaultdict

import numpy as np
import UnityPy

GAME = sys.argv[1] if len(sys.argv) > 1 else r"F:\Games\Tarkov"
DATA = os.path.join(GAME, "EscapeFromTarkov_Data")
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "navmesh", "ai")

# tracker map key -> AI scene (from StreamingAssets/Windows/maps/*_preset.bundle)
MAPS = {
    "factory": "Factory_Rework/Factory_Rework_AI",
    "customs": "Custom/custom_AI",
    "woods": "Woods/woods_AI",
    "shoreline": "shorline/shoreline_AI",
    "interchange": "Shopping_Mall/Shopping_Mall_AI",
    "the-lab": "Laboratory/Laboratory_AI",
    "the-lab-dark": "Laboratory/Laboratory_dark_AI",
    "reserve": "Reserve_Base/Reserve_Base_AI",
    "lighthouse": "Lighthouse/Lighthouse_AI",
    "streets-of-tarkov": "City/City_AI",
    "ground-zero": "Sandbox/Sandbox_AI",
    "ground-zero-21": "Sandbox/Sandbox_AI_high",
    "the-labyrinth": "Labyrinth/Labyrinth_AI",
    "terminal": "Terminal/Terminal_AI",
    "icebreaker": "Icebreaker/Icebreaker_AI",
}

EXT = 0x8000


def scene_indices():
    env = UnityPy.load(os.path.join(DATA, "globalgamemanagers"))
    for o in env.objects:
        if o.type.name == "BuildSettings":
            scenes = o.read_typetree()["scenes"]
            out = {}
            for i, s in enumerate(scenes):  # some scenes are listed twice; the first one has the data
                out.setdefault(s.replace("Assets/Content/Locations/", "").replace(".unity", ""), i)
            return out
    raise SystemExit("BuildSettings not found")


def parse_tile(b):
    magic, ver, tx, tz, _agent, P, V, DM, DV, DT, BV = struct.unpack_from("<4s10i", b, 0)
    if magic != b"VAND" or ver != 16:
        raise ValueError(f"unknown tile format {magic} v{ver}")
    bmin = struct.unpack_from("<3f", b, 44)
    bmax = struct.unpack_from("<3f", b, 56)
    verts = np.frombuffer(b, dtype="<f4", count=V * 3, offset=72).reshape(V, 3)
    polys = []
    off = 72 + V * 12
    for i in range(P):
        vs = struct.unpack_from("<6H", b, off)
        ns = struct.unpack_from("<6H", b, off + 12)
        _flags, n, area = struct.unpack_from("<IBB", b, off + 24)
        polys.append((vs[:n], ns[:n], area))
        off += 32
    return {"t": (tx, tz), "bmin": bmin, "bmax": bmax, "verts": verts, "polys": polys}


def build(tiles):
    """Weld all tiles into one polygon mesh with portal links (internal edges and tile-border overlaps)."""
    vkey = {}
    verts = []

    def vid(p):
        k = (round(float(p[0]) * 200), round(float(p[1]) * 200), round(float(p[2]) * 200))
        i = vkey.get(k)
        if i is None:
            i = vkey[k] = len(verts)
            verts.append((float(p[0]), float(p[1]), float(p[2])))
        return i

    polys, areas = [], []
    base = []
    for t in tiles:
        base.append(len(polys))
        ids = [vid(p) for p in t["verts"]]
        for vs, ns, area in t["polys"]:
            polys.append([ids[v] for v in vs])
            areas.append(area)
    links = defaultdict(list)  # poly -> [(other, va, vb)]
    # Internal edges: neighbour = local poly index + 1.
    border = defaultdict(list)  # (axis, coordinate) -> [(poly, a, b)]
    for ti, t in enumerate(tiles):
        for pi, (vs, ns, area) in enumerate(t["polys"]):
            gp = base[ti] + pi
            n = len(vs)
            for k in range(n):
                a, b = polys[gp][k], polys[gp][(k + 1) % n]
                nb = ns[k]
                if nb == 0:
                    continue
                if not nb & EXT:
                    links[gp].append((base[ti] + nb - 1, a, b))
                    continue
                side = nb & 0xFF
                pa, pb = verts[a], verts[b]
                # side 0/4: +x/-x border (constant x), 2/6: +z/-z border (constant z)
                axis = 0 if side in (0, 4) else 2
                border[(axis, round(pa[axis] * 20))].append((gp, a, b))
    # Tile borders: edges on the same border line from both sides that overlap along it and are at a similar height.
    joined = 0
    for (axis, _c), edges in border.items():
        other = 2 if axis == 0 else 0
        spans = []
        for gp, a, b in edges:
            pa, pb = verts[a], verts[b]
            lo, hi = sorted((pa[other], pb[other]))
            spans.append((lo, hi, gp, a, b))
        spans.sort()
        for i, (lo, hi, gp, a, b) in enumerate(spans):
            for j in range(i + 1, len(spans)):
                lo2, hi2, gp2, a2, b2 = spans[j]
                if lo2 >= hi - 0.01:
                    break
                if gp2 == gp:
                    continue
                s, e = max(lo, lo2), min(hi, hi2)
                if e - s < 0.05:
                    continue
                y1 = lambda u, A=a, B=b: lerp_y(verts[A], verts[B], other, u)
                y2 = lambda u, A=a2, B=b2: lerp_y(verts[A], verts[B], other, u)
                if abs(y1(s) - y2(s)) > 0.6 or abs(y1(e) - y2(e)) > 0.6:
                    continue
                # Shared portal: the overlapping part, as two new (or welded) verts.
                fixed = verts[a][axis]
                ps = [0.0, 0.0, 0.0]; pe = [0.0, 0.0, 0.0]
                ps[axis] = pe[axis] = fixed
                ps[other], pe[other] = s, e
                ps[1] = (y1(s) + y2(s)) / 2
                pe[1] = (y1(e) + y2(e)) / 2
                va, vb = vid(ps), vid(pe)
                links[gp].append((gp2, va, vb))
                links[gp2].append((gp, va, vb))
                joined += 1
    return verts, polys, areas, links, joined


def lerp_y(pa, pb, axis, u):
    d = pb[axis] - pa[axis]
    if abs(d) < 1e-6:
        return (pa[1] + pb[1]) / 2
    t = (u - pa[axis]) / d
    return pa[1] + (pb[1] - pa[1]) * t


def write(path, verts, polys, areas, links):
    P = len(polys)
    pstart = np.zeros(P + 1, dtype="<u4")
    pidx = []
    for i, p in enumerate(polys):
        pidx.extend(p)
        pstart[i + 1] = len(pidx)
    lstart = np.zeros(P + 1, dtype="<u4")
    ldata = []
    for i in range(P):
        seen = set()
        for o, a, b in links.get(i, ()):
            if (o, a, b) in seen:
                continue
            seen.add((o, a, b))
            ldata.extend((o, a, b))
        lstart[i + 1] = len(ldata) // 3
    with open(path, "wb") as f:
        f.write(struct.pack("<4sIIIII", b"TNAV", 1, len(verts), P, len(pidx), len(ldata) // 3))
        f.write(np.asarray(verts, dtype="<f4").tobytes())
        f.write(pstart.tobytes())
        f.write(np.asarray(pidx, dtype="<u4").tobytes())
        f.write(np.asarray(areas, dtype="u1").tobytes())
        f.write(b"\0" * ((4 - P % 4) % 4))
        f.write(lstart.tobytes())
        f.write(np.asarray(ldata, dtype="<u4").tobytes())


def main():
    os.makedirs(OUT, exist_ok=True)
    idx = scene_indices()
    only = set(sys.argv[2:])
    meta = {}
    for key, scene in MAPS.items():
        if only and key not in only:
            continue
        t0 = time.time()
        n = idx.get(scene)
        if n is None:
            print(key, "scene not in build:", scene)
            continue
        src = os.path.join(DATA, f"sharedassets{n}.assets")
        env = UnityPy.load(src)
        tiles, names = [], []
        for o in env.objects:
            if o.type.name != "NavMeshData":
                continue
            d = o.read_typetree()
            names.append(d["m_Name"])
            for t in d["m_NavMeshTiles"]:
                tile = parse_tile(bytes(t["m_MeshData"]))
                if tile["polys"]:
                    tiles.append(tile)
        if not tiles:
            print(key, "no navmesh in", src)
            continue
        verts, polys, areas, links, joined = build(tiles)
        write(os.path.join(OUT, key + ".bin"), verts, polys, areas, links)
        v = np.asarray(verts)
        meta[key] = {"scene": scene, "navmeshes": names, "source": os.path.basename(src), "sourceTime": int(os.path.getmtime(src)), "polys": len(polys), "verts": len(verts),
                     "min": v.min(axis=0).round(1).tolist(), "max": v.max(axis=0).round(1).tolist()}
        print(f"{key}: {len(polys)} polys, {len(verts)} verts, {joined} tile-border portals, {time.time() - t0:.1f}s", flush=True)
    info_path = os.path.join(OUT, "index.json")
    old = json.load(open(info_path)) if os.path.exists(info_path) else {}
    old.update(meta)
    json.dump(old, open(info_path, "w"), indent=1)


if __name__ == "__main__":
    main()
