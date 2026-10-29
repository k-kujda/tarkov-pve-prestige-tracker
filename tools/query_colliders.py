"""List every collider (any layer, incl. inactive/trigger) whose world bounds come near a point.
Usage: python tools/query_colliders.py map x y z [radius]"""
import os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract_geometry as G
G.DATA = "F:/Games/Tarkov/EscapeFromTarkov_Data"

key, x, y, z = sys.argv[1], *map(float, sys.argv[2:5])
r = float(sys.argv[5]) if len(sys.argv) > 5 else 3
P = np.array([x, y, z])
by = G.scene_indices()
TAG = {i: n for i, n in enumerate(["Default","TransparentFX","IgnoreRaycast","","Water","UI","","","Player","DoorLowPoly","PlayerCollisionTest","Terrain","HighPoly","Triggers","DisablerCulling","Loot","HitCollider","PlayerRenderers","LowPoly","WeaponPreview","Shells","CullingMask","Interactive","Deadbody","RainDrops","Menu","Foliage","Spirit","Sky","LevelBorder","TransparentCollider","Grass"])}
for sp in [s for s in G.preset_scenes(G.PRESETS[key]) if not s.endswith("_AI.unity")]:
    sc = G.Scene(os.path.join(G.DATA, f"level{by[sp]}"))
    for pid, o in sc.objs.items():
        tn = o.type.name
        if tn not in ("MeshCollider", "BoxCollider", "SphereCollider", "CapsuleCollider"): continue
        c = sc.tt(pid); go = sc.tt(c["m_GameObject"]["m_PathID"]); tid = sc.transform_of(go)
        if tid is None: continue
        m, active = sc.matrix(tid)
        if tn == "BoxCollider": lv = G.BOX_V * G.v3(c["m_Size"]) + G.v3(c["m_Center"])
        elif tn == "MeshCollider":
            try: mo = o.read().m_Mesh.deref(); res = G.mesh_tris(mo, {})
            except Exception: continue
            if not res: continue
            lv = res[0]
        else: lv = G.SPH_V * c.get("m_Radius", 0.5) + G.v3(c["m_Center"])
        if not len(lv): continue
        wv = lv @ m[:3, :3].T + m[:3, 3]
        lo, hi = wv.min(0), wv.max(0)
        if np.all(P >= lo - r) and np.all(P <= hi + r):
            print(f"{os.path.basename(sp)[:30]:30} {tn:14} layer={TAG.get(go['m_Layer'], go['m_Layer']):12} active={int(active)} en={int(c.get('m_Enabled',1))} trig={int(bool(c.get('m_IsTrigger')))} {go['m_Name'][:40]:40} lo={lo.round(1)} hi={hi.round(1)}")
