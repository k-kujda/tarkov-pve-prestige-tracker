"""Which MonoBehaviour classes sit on GameObjects with solid (non-trigger) colliders on player layers, per map,
with how many such colliders and their largest size. Usage: python tools/collider_scripts.py map..."""
import os, sys, collections
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract_geometry as G
G.DATA = "F:/Games/Tarkov/EscapeFromTarkov_Data"
by = G.scene_indices()
for key in sys.argv[1:]:
    stat = collections.defaultdict(lambda: [0, 0.0, ""])
    for sp in [s for s in G.preset_scenes(G.PRESETS[key]) if not s.endswith("_AI.unity")]:
        if sp not in by: continue
        sc = G.Scene(os.path.join(G.DATA, f"level{by[sp]}"))
        for pid, o in sc.objs.items():
            if not o.type.name.endswith("Collider") or o.type.name == "TerrainCollider": continue
            c = sc.tt(pid)
            if c.get("m_IsTrigger") or not c.get("m_Enabled", 1): continue
            go = sc.tt(c["m_GameObject"]["m_PathID"])
            if go["m_Layer"] not in G.WALK_LAYERS: continue
            m, active = sc.matrix(sc.transform_of(go))
            if not active: continue
            size = float(np.prod(np.abs(m[:3, :3]) @ G.v3(c["m_Size"]))) if o.type.name == "BoxCollider" else 0
            for comp in go["m_Component"]:
                co = sc.objs.get(comp["component"]["m_PathID"])
                if co and co.type.name == "MonoBehaviour":
                    try: cls = co.read(check_read=False).m_Script.read().m_ClassName
                    except Exception: continue
                    s = stat[cls]; s[0] += 1
                    if size > s[1]: s[1], s[2] = size, go["m_Name"]
    print("==", key)
    for cls, (n, v, name) in sorted(stat.items(), key=lambda kv: -kv[1][1]):
        print(f"  {cls:40} {n:6} colliders  largest box {v:10.0f} m3  ({name})")
