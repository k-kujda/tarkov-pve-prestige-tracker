"""Large non-trigger box colliders on player-blocking layers, with the scripts on their GameObject (logic volumes
that would wrongly block the navmesh). Usage: python tools/big_boxes.py map [min_volume]"""
import os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract_geometry as G
G.DATA = "F:/Games/Tarkov/EscapeFromTarkov_Data"
key = sys.argv[1]; vmin = float(sys.argv[2]) if len(sys.argv) > 2 else 150
by = G.scene_indices()
for sp in [s for s in G.preset_scenes(G.PRESETS[key]) if not s.endswith("_AI.unity")]:
    sc = G.Scene(os.path.join(G.DATA, f"level{by[sp]}"))
    for pid, o in sc.objs.items():
        if o.type.name != "BoxCollider": continue
        c = sc.tt(pid)
        if c.get("m_IsTrigger") or not c.get("m_Enabled", 1): continue
        go = sc.tt(c["m_GameObject"]["m_PathID"])
        if go["m_Layer"] not in G.WALK_LAYERS: continue
        tid = sc.transform_of(go); m, active = sc.matrix(tid)
        if not active: continue
        size = np.abs(m[:3, :3]) @ G.v3(c["m_Size"])
        if size.prod() < vmin: continue
        classes = []
        for comp in go["m_Component"]:
            co = sc.objs.get(comp["component"]["m_PathID"])
            if co and co.type.name == "MonoBehaviour":
                try: classes.append(co.read(check_read=False).m_Script.read().m_ClassName)
                except Exception: classes.append("?")
        print(f"{os.path.basename(sp)[:28]:28} layer={go['m_Layer']:2} {go['m_Name'][:38]:38} size={size.round(1)} scripts={classes}")
