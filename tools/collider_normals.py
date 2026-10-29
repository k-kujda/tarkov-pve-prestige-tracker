"""Triangle normal stats (walkable up-facing vs down-facing) of colliders matching a name, near a point.
Usage: python tools/collider_normals.py map name_substring x y z [r]"""
import os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract_geometry as G
G.DATA = "F:/Games/Tarkov/EscapeFromTarkov_Data"
key, name = sys.argv[1], sys.argv[2]
P = np.array(list(map(float, sys.argv[3:6]))); r = float(sys.argv[6]) if len(sys.argv) > 6 else 5
by = G.scene_indices()
for sp in [s for s in G.preset_scenes(G.PRESETS[key]) if not s.endswith("_AI.unity")]:
    sc = G.Scene(os.path.join(G.DATA, f"level{by[sp]}"))
    for pid, o in sc.objs.items():
        if o.type.name != "MeshCollider": continue
        c = sc.tt(pid); go = sc.tt(c["m_GameObject"]["m_PathID"])
        if name not in go["m_Name"]: continue
        m, active = sc.matrix(sc.transform_of(go))
        res = G.mesh_tris(o.read().m_Mesh.deref(), {})
        if not res: continue
        v, t = res
        wv = v @ m[:3, :3].T + m[:3, 3]
        if np.linalg.det(m[:3, :3]) < 0: t = t[:, [0, 2, 1]]
        if not (np.all(P >= wv.min(0) - r) and np.all(P <= wv.max(0) + r)): continue
        a, b, cc = wv[t[:, 0]], wv[t[:, 1]], wv[t[:, 2]]
        n = np.cross(b - a, cc - a); ln = np.linalg.norm(n, axis=1) + 1e-12; ny = n[:, 1] / ln
        area = ln / 2
        print(go["m_Name"], "tris", len(t), "det", round(float(np.linalg.det(m[:3, :3])), 3), "scale", np.round(np.linalg.norm(m[:3, :3], axis=0), 3),
              "area up(ny>0.64) %.1f down(ny<-0.64) %.1f steep %.1f" % (area[ny > 0.64].sum(), area[ny < -0.64].sum(), area[np.abs(ny) <= 0.64].sum()))
