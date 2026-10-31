"""Extract the collision geometry a player walks on / is blocked by, for building a player navmesh with Recast.

For every scene a map loads (its StreamingAssets/Windows/maps/*_preset.bundle), keep active, enabled, non-trigger
colliders on the layers the Player layer collides with in the physics matrix (Default, Terrain, LowPolyCollider,
LevelBorder; doors are written separately so routes can pass through them), in world space.

Output: navmesh/geom/<map>.bin = "TGEO", 1, nVerts, nTris, f32 verts[3n], u32 tris[3t]
        navmesh/geom/<map>.doors.json = interactive doors (id, key id, state 1 locked/2 shut/4 open, bounds); their
        colliders are left out of the geometry, door-layer colliders that aren't interactive doors are kept as walls.
Usage: python tools/extract_geometry.py [game dir] [map ...]
"""
import json
import math
import os
import re
import struct
import sys
import time

import numpy as np
import UnityPy

GAME = sys.argv[1] if len(sys.argv) > 1 else r"F:\Games\Tarkov"
DATA = os.path.join(GAME, "EscapeFromTarkov_Data")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "navmesh", "geom")

PRESETS = {
    "factory": "factory_day_preset", "customs": "customs_preset", "woods": "woods_preset", "shoreline": "shoreline_preset",
    "interchange": "shopping_mall", "the-lab": "laboratory_preset", "reserve": "rezerv_base_preset",
    "lighthouse": "lighthouse_preset", "streets-of-tarkov": "city_preset", "ground-zero": "sandbox_preset",
    "the-labyrinth": "labyrinth_preset", "terminal": "terminal_preset", "icebreaker": "icebreaker",
}

WALK_LAYERS = {0, 11, 18, 29}   # Default, Terrain, LowPolyCollider, LevelBorder
DOOR_LAYER = 9                  # DoorLowPolyCollider
WATER_LAYER = 4                 # Water: the bullet-impact surfaces of seas, lakes and rivers (not solid for players)
WATER_ONLY = os.environ.get("WATER_ONLY") == "1"  # just refresh navmesh/geom/<map>.water.bin


def scene_indices():
    # UnityPy.load returns an empty environment for a missing file, so check first.
    if not os.path.isfile(os.path.join(DATA, "globalgamemanagers")):
        raise SystemExit(f"Tarkov game files not found: {DATA} has no globalgamemanagers")
    env = UnityPy.load(os.path.join(DATA, "globalgamemanagers"))
    for o in env.objects:
        if o.type.name == "BuildSettings":
            out = {}
            for i, s in enumerate(o.read_typetree()["scenes"]):
                out.setdefault(s, i)
            return out
    raise SystemExit("BuildSettings not found")


def preset_scenes(name):
    bundle = os.path.join(DATA, "StreamingAssets", "Windows", "maps", name + ".bundle")
    if not os.path.isfile(bundle):
        raise SystemExit(f"map bundle not found: {bundle}")
    env = UnityPy.load(bundle)
    scenes = []
    for o in env.objects:
        if o.type.name != "MonoBehaviour":
            continue
        try:
            d = o.read_typetree()
        except Exception:
            continue
        for k in d.get("_scenesResourceKeys", []):
            if k["path"] not in scenes:
                scenes.append(k["path"])
    return scenes


def quat_mat(q):
    x, y, z, w = q["x"], q["y"], q["z"], q["w"]
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def v3(d):
    return np.array([d["x"], d["y"], d["z"]], dtype=np.float64)


BOX_V = np.array([[x, y, z] for x in (-.5, .5) for y in (-.5, .5) for z in (-.5, .5)])
BOX_T = np.array([[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1], [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]])


def ico(n_lat=6, n_lon=10):
    vs, ts = [], []
    for i in range(n_lat + 1):
        th = math.pi * i / n_lat
        for j in range(n_lon):
            ph = 2 * math.pi * j / n_lon
            vs.append([math.sin(th) * math.cos(ph), math.cos(th), math.sin(th) * math.sin(ph)])
    for i in range(n_lat):
        for j in range(n_lon):
            a, b = i * n_lon + j, i * n_lon + (j + 1) % n_lon
            c, d = a + n_lon, b + n_lon
            ts += [[a, c, b], [b, c, d]]
    return np.array(vs), np.array(ts)


SPH_V, SPH_T = ico()


class Scene:
    def __init__(self, path):
        self.env = UnityPy.load(path)
        self.objs = {}
        for o in self.env.objects:
            self.objs[o.path_id] = o
        self.cache = {}
        self.world = {}

    def tt(self, pid):
        if pid not in self.cache:
            self.cache[pid] = self.objs[pid].read_typetree()
        return self.cache[pid]

    def transform_of(self, go):
        for c in go["m_Component"]:
            p = c["component"]
            if p["m_FileID"] == 0 and p["m_PathID"] in self.objs and self.objs[p["m_PathID"]].type.name in ("Transform", "RectTransform"):
                return p["m_PathID"]
        return None

    def matrix(self, tid):
        """World matrix (4x4) and activeInHierarchy for a Transform path id."""
        if tid in self.world:
            return self.world[tid]
        t = self.tt(tid)
        go = self.tt(t["m_GameObject"]["m_PathID"])
        local = np.eye(4)
        local[:3, :3] = quat_mat(t["m_LocalRotation"]) * v3(t["m_LocalScale"])
        local[:3, 3] = v3(t["m_LocalPosition"])
        active = bool(go["m_IsActive"])
        f = t["m_Father"]
        if f["m_PathID"] and f["m_FileID"] == 0 and f["m_PathID"] in self.objs:
            pm, pa = self.matrix(f["m_PathID"])
            res = (pm @ local, pa and active)
        else:
            res = (local, active)
        self.world[tid] = res
        return res


DOOR_CLASSES = {"Door", "KeycardDoor", "BrokenDoor"}


def read_str(raw, off):
    n = struct.unpack_from("<i", raw, off)[0]
    if n < 0 or n > 200 or off + 4 + n > len(raw):
        return None, off
    s = raw[off + 4:off + 4 + n]
    if not all(32 <= c < 127 for c in s):
        return None, off
    return s.decode(), (off + 4 + n + 3) & ~3


def is_hex_id(s):
    return len(s) == 24 and all(c in "0123456789abcdef" for c in s)


def parse_door(raw):
    """Door fields from raw MonoBehaviour bytes (no type trees in this IL2CPP build): after the name come a few
    ints, the KeyId string (empty or a 24-hex item id), 3 ints, the Id string, and the DoorState 23 ints after it
    (1 locked, 2 shut, 4 open)."""
    _, off = read_str(raw, 28)
    strings, o = [], off
    while o + 4 <= len(raw) and len(strings) < 6:
        st, o2 = read_str(raw, o)
        if st is not None and st and o2 > o + 4:
            strings.append((o, st, o2)); o = o2
        else:
            o += 4
    key = next((st for _, st, _ in strings if is_hex_id(st)), "")
    ido = next(((a, st, e) for a, st, e in strings if not is_hex_id(st)), None)
    if not ido:
        return None
    state = struct.unpack_from("<i", raw, ido[2] + 23 * 4)[0] if ido[2] + 24 * 4 <= len(raw) else None
    return {"id": ido[1], "key": key, "state": state}


def scene_doors(sc, doors, scene_name):
    """Collect the scene's interactive doors into `doors`; returns the GameObjects of their door colliders."""
    children = {}
    for pid, o in sc.objs.items():
        if o.type.name == "Transform":
            children.setdefault(sc.tt(pid)["m_Father"]["m_PathID"], []).append(pid)
    owned = set()
    for pid, o in sc.objs.items():
        if o.type.name != "MonoBehaviour":
            continue
        try:
            mb = o.read(check_read=False)
            cls = mb.m_Script.read().m_ClassName
        except Exception:
            continue
        if cls not in DOOR_CLASSES:
            continue
        go = sc.tt(mb.m_GameObject.path_id)
        tid = sc.transform_of(go)
        if tid is None:
            continue
        m, active = sc.matrix(tid)
        d = parse_door(o.get_raw_data()) if cls != "BrokenDoor" else {"id": "", "key": "", "state": 4}
        if not d:
            continue
        # The door's colliders: every collider in the door's own hierarchy (the moving leaf, whatever its layer:
        # Icebreaker's are on LowPolyCollider), plus DoorLowPoly colliders elsewhere under the door's parent.
        # Frames stay solid.
        lo, hi = np.full(3, np.inf), np.full(3, -np.inf)
        own = set()
        stack = [tid]
        while stack:
            t = stack.pop(); own.add(t); stack += children.get(t, [])
        par = sc.tt(tid)["m_Father"]["m_PathID"]
        stack = [par if par in sc.objs else tid]
        while stack:
            t = stack.pop()
            stack += children.get(t, [])
            gpid = sc.tt(t)["m_GameObject"]["m_PathID"]
            g = sc.tt(gpid)
            if g["m_Layer"] != DOOR_LAYER and t not in own:
                continue
            if g["m_Layer"] not in WALK_LAYERS and g["m_Layer"] != DOOR_LAYER:
                continue
            for c in g["m_Component"]:
                co = sc.objs.get(c["component"]["m_PathID"])
                if not co or not co.type.name.endswith("Collider") or co.type.name == "TerrainCollider":
                    continue
                cc0 = sc.tt(co.path_id)
                if cc0.get("m_IsTrigger") or not cc0.get("m_Enabled", 1):
                    continue
                owned.add(gpid)
                cm, _ = sc.matrix(t)
                if co.type.name == "MeshCollider":
                    try:
                        r = mesh_tris(co.read().m_Mesh.deref(), {})
                    except Exception:
                        r = None
                    if not r:
                        continue
                    lv = r[0]
                elif co.type.name == "BoxCollider":
                    cc = sc.tt(co.path_id)
                    lv = BOX_V * v3(cc["m_Size"]) + v3(cc["m_Center"])
                else:
                    continue
                wv = lv @ cm[:3, :3].T + cm[:3, 3]
                lo, hi = np.minimum(lo, wv.min(0)), np.maximum(hi, wv.max(0))
        if not np.isfinite(lo).all():
            continue
        d.update({"class": cls, "name": go["m_Name"], "scene": scene_name, "active": bool(active),
                  "pos": m[:3, 3].round(2).tolist(), "lo": lo.round(2).tolist(), "hi": hi.round(2).tolist()})
        doors.append(d)
    return owned


# Logic volumes stored as solid colliders on the Default layer (the game makes them triggers at runtime): extraction
# zones are huge boxes (Lighthouse's EXFIL_FREE4ALL is 155 x 49 x 143 m) that would wall off whole areas.
LOGIC_SCRIPTS = ("ExfiltrationPoint", "ScavExfiltrationPoint", "SharedExfiltrationPoint", "SecretExfiltrationPoint",
                 "ExperienceTrigger", "PlaceItemTrigger", "StencilShadow")


def logic_volumes(sc):
    out = set()
    for pid, o in sc.objs.items():
        if o.type.name != "MonoBehaviour":
            continue
        try:
            mb = o.read(check_read=False)
            if mb.m_Script.read().m_ClassName in LOGIC_SCRIPTS:
                out.add(mb.m_GameObject.path_id)
        except Exception:
            continue
    return out


def mesh_tris(mesh_obj, cache):
    key = (mesh_obj.assets_file.name, mesh_obj.path_id)
    if key in cache:
        return cache[key]
    from UnityPy.helpers.MeshHelper import MeshHandler
    try:
        mesh = mesh_obj.read()
        h = MeshHandler(mesh)
        h.process()
        v = np.asarray(h.m_Vertices, dtype=np.float64).reshape(-1, 3)
        tris = [t for sub in h.get_triangles() for t in sub]
        t = np.asarray(tris, dtype=np.int64).reshape(-1, 3) if tris else np.zeros((0, 3), dtype=np.int64)
        res = (v, t)
    except Exception as e:
        print("   mesh read failed:", e)
        res = None
    cache[key] = res
    return res


def terrain_tris(td, m):
    hm = td["m_Heightmap"]
    res = hm["m_Resolution"]
    heights = np.asarray(hm["m_Heights"], dtype=np.float64).reshape(res, res) / 32766.0
    sc = v3(hm["m_Scale"])  # (size.x / (res - 1), size.y, size.z / (res - 1))
    holes = None
    if hm.get("m_EnableHolesTextureCompression") is not None or hm.get("m_Holes"):
        hb = hm.get("m_Holes") or []
        if len(hb) == (res - 1) * (res - 1):
            holes = np.asarray(hb, dtype=np.uint8).reshape(res - 1, res - 1) == 0
    # heights[z][x]
    zs, xs = np.mgrid[0:res, 0:res]
    local = np.stack([xs * sc[0], heights * sc[1], zs * sc[2]], axis=-1).reshape(-1, 3)
    world = local @ m[:3, :3].T + m[:3, 3]
    i = np.arange(res - 1)
    a = (i[:, None] * res + i[None, :])  # z, x
    keep = np.ones((res - 1, res - 1), bool) if holes is None else ~holes
    a = a[keep]
    b, c, d = a + 1, a + res, a + res + 1
    tris = np.concatenate([np.stack([a, c, b], 1), np.stack([b, c, d], 1)])
    return world, tris


def extract(key, scenes_by_path, only_scene=None):
    scenes = [s for s in preset_scenes(PRESETS[key]) if not s.endswith("_AI.unity")]
    verts, tris, doors = [], [], []
    wverts, wtris, wnv = [], [], 0
    nv = 0
    mcache = {}
    stats = {}
    for sp in scenes:
        idx = scenes_by_path.get(sp)
        if idx is None:
            print("  missing scene", sp)
            continue
        t0 = time.time()
        sc = Scene(os.path.join(DATA, f"level{idx}"))
        n0 = len(tris)
        cnt = 0
        owned = set() if WATER_ONLY else scene_doors(sc, doors, os.path.basename(sp)) | logic_volumes(sc)
        for pid, o in sc.objs.items():
            tn = o.type.name
            if tn not in ("MeshCollider", "BoxCollider", "SphereCollider", "CapsuleCollider", "TerrainCollider"):
                continue
            try:
                c = sc.tt(pid)
            except Exception as e:
                continue
            gp = c["m_GameObject"]["m_PathID"]
            go = sc.tt(gp)
            layer = go["m_Layer"]
            water = layer == WATER_LAYER
            if not c.get("m_Enabled", 1) or (c.get("m_IsTrigger") and not water):
                continue
            if WATER_ONLY and not water:
                continue
            if layer not in WALK_LAYERS and layer != DOOR_LAYER and not water:
                continue
            tid = sc.transform_of(go)
            if tid is None:
                continue
            m, active = sc.matrix(tid)
            if not active:
                continue
            if gp in owned:
                continue  # an interactive door: left open, its volume is marked on the navmesh instead
            if tn == "MeshCollider":
                ref = c["m_Mesh"]
                if not ref["m_PathID"]:
                    continue
                try:
                    mo = o.read().m_Mesh.deref()
                except Exception:
                    try:
                        mo = o.read().m_Mesh
                        mo = mo.deref() if hasattr(mo, "deref") else None
                    except Exception:
                        mo = None
                if mo is None:
                    continue
                r = mesh_tris(mo, mcache)
                if not r or not len(r[1]):
                    continue
                lv, lt = r
            elif tn == "BoxCollider":
                lv = BOX_V * v3(c["m_Size"]) + v3(c["m_Center"])
                lt = BOX_T
            elif tn == "SphereCollider":
                lv = SPH_V * c["m_Radius"] + v3(c["m_Center"])
                lt = SPH_T
            elif tn == "CapsuleCollider":
                r_, h_ = c["m_Radius"], c["m_Height"]
                ax = c["m_Direction"]
                lv = SPH_V * r_
                half = max(0.0, h_ / 2 - r_)
                lv = lv.copy()
                lv[:, ax] += np.where(lv[:, ax] >= 0, half, -half) if ax != 1 else np.where(lv[:, 1] >= 0, half, -half)
                lv = lv + v3(c["m_Center"])
                lt = SPH_T
            else:  # TerrainCollider
                try:
                    td = c["m_TerrainData"]
                    tdo = o.read().m_TerrainData.deref()
                    tdd = tdo.read_typetree()
                except Exception as e:
                    print("   terrain read failed:", e)
                    continue
                wv, lt = terrain_tris(tdd, m)
                verts.append(wv.astype(np.float32)); tris.append(lt + nv); nv += len(wv); cnt += 1
                stats["terrain"] = stats.get("terrain", 0) + 1
                continue
            wv = lv @ m[:3, :3].T + m[:3, 3]
            # mirrored transforms flip winding; Recast uses the triangle normal, so keep it pointing up for floors
            if np.linalg.det(m[:3, :3]) < 0:
                lt = lt[:, [0, 2, 1]]
            if water:
                wverts.append(wv.astype(np.float32)); wtris.append(lt + wnv); wnv += len(wv)
                continue
            verts.append(wv.astype(np.float32)); tris.append(lt + nv); nv += len(wv); cnt += 1
            stats[tn] = stats.get(tn, 0) + 1
        print(f"  {os.path.basename(sp)} (level{idx}): {cnt} colliders, {sum(len(t) for t in tris[n0:])} tris, {time.time() - t0:.1f}s", flush=True)
    os.makedirs(OUT, exist_ok=True)
    def write_geo(path, vs, ts):
        V = np.concatenate(vs) if vs else np.zeros((0, 3), np.float32)
        T = np.concatenate(ts).astype(np.uint32) if ts else np.zeros((0, 3), np.uint32)
        with open(path, "wb") as f:
            f.write(struct.pack("<4sIII", b"TGEO", 1, len(V), len(T)))
            f.write(V.astype("<f4").tobytes())
            f.write(T.astype("<u4").tobytes())
        return V, T
    WV, WT = write_geo(os.path.join(OUT, key + ".water.bin"), wverts, wtris)
    print(f"{key}: {len(WT)} water tris", flush=True)
    if WATER_ONLY:
        return
    V = np.concatenate(verts) if verts else np.zeros((0, 3), np.float32)
    T = np.concatenate(tris).astype(np.uint32) if tris else np.zeros((0, 3), np.uint32)
    with open(os.path.join(OUT, key + ".bin"), "wb") as f:
        f.write(struct.pack("<4sIII", b"TGEO", 1, len(V), len(T)))
        f.write(V.astype("<f4").tobytes())
        f.write(T.astype("<u4").tobytes())
    json.dump(doors, open(os.path.join(OUT, key + ".doors.json"), "w"))
    print(f"{key}: {len(V)} verts, {len(T)} tris, {len(doors)} doors, {stats}", flush=True)


def main():
    by_path = scene_indices()
    keys = sys.argv[2:] or list(PRESETS)
    for k in keys:
        print(k, flush=True)
        extract(k, by_path)


if __name__ == "__main__":
    main()
