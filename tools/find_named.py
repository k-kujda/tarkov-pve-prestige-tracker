"""List colliders whose GameObject name matches a regex (any layer), with world bounds. Usage: python tools/find_named.py map regex"""
import os, re, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract_geometry as G
G.DATA = "F:/Games/Tarkov/EscapeFromTarkov_Data"
key, rx = sys.argv[1], re.compile(sys.argv[2], re.I)
by = G.scene_indices()
for sp in [s for s in G.preset_scenes(G.PRESETS[key]) if not s.endswith("_AI.unity")]:
    sc = G.Scene(os.path.join(G.DATA, f"level{by[sp]}"))
    for pid, o in sc.objs.items():
        if o.type.name not in ("MeshCollider", "BoxCollider"): continue
        c = sc.tt(pid); go = sc.tt(c["m_GameObject"]["m_PathID"])
        if not rx.search(go["m_Name"]): continue
        m, active = sc.matrix(sc.transform_of(go))
        if o.type.name == "BoxCollider": lv = G.BOX_V * G.v3(c["m_Size"]) + G.v3(c["m_Center"])
        else:
            try: r = G.mesh_tris(o.read().m_Mesh.deref(), {})
            except Exception: continue
            if not r: continue
            lv = r[0]
        wv = lv @ m[:3, :3].T + m[:3, 3]
        print(f"{go['m_Name'][:45]:45} layer={go['m_Layer']:2} active={int(active)} trig={int(bool(c.get('m_IsTrigger')))} lo={wv.min(0).round(1)} hi={wv.max(0).round(1)}")
