"""Extract quest-related trigger zones and item-spawn points from every map's scenes.

For each map scene, walks every MonoBehaviour and picks up:
  - ExperienceTrigger, PlaceItemTrigger, QuestTrigger, ZoneTrigger, LocationTrigger
    and any other script whose raw bytes contain a 24-hex ObjectId.
  - LootItem / LootPoint GameObjects that carry a known quest-item templateId.

World-space bounding box is computed from the BoxCollider (trigger) on the same
GameObject; fall back to a 2 m sphere around the transform origin if none found.

Output:
  navmesh/zones/<map>.json      – [{id, script, name, strings, center, lo, hi, scene}, ...]

tools/build_quest_locations.js turns these into data/quest-locations.json (exact matches only: tarkov.dev's
zones already agree with the triggers of the same id).

Usage: python tools/extract_zones.py [game_dir] [map ...]
"""

import json
import math
import os
import struct
import sys
import time

import numpy as np
import UnityPy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import extract_geometry as G

GAME = sys.argv[1] if len(sys.argv) > 1 else r"F:\Games\Tarkov"
DATA = os.path.join(GAME, "EscapeFromTarkov_Data")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

OUT_ZONES = os.path.join(ROOT, "navmesh", "zones")

# Override G's DATA so helpers use the right path
G.DATA = DATA

# ---------------------------------------------------------------------------
# Script class lists
# ---------------------------------------------------------------------------

# Primary quest trigger scripts we always capture
TRIGGER_SCRIPTS = {
    "ExperienceTrigger",
    "PlaceItemTrigger",
    "QuestTrigger",
    "ZoneTrigger",
    "LocationTrigger",
    "QuestConditionTrigger",
    "ScavExperienceTrigger",
    "HandlerCompleteQuestCondition",
}

# LootItem-family – we keep only those whose raw bytes contain a quest templateId
LOOT_SCRIPTS = {"LootItem", "LootPoint", "StaticLootItemPoint"}

# Any class not in the above lists will be checked for a 24-hex id in raw bytes
# and included if found.
SCAN_FOR_ID_SCRIPTS = {
    "InteractiveObject", "AccessibleGate", "StationaryWeapon",
    "ObservationPoint", "SwitchInterface",
}

BOX_V = G.BOX_V


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def dump_strings(raw):
    """Return all plausible UTF-8 printable strings encoded as Pascal (int32-len) in raw bytes."""
    strings = []
    off = 0
    while off + 4 <= len(raw):
        n = struct.unpack_from("<i", raw, off)[0]
        if 0 < n <= 512 and off + 4 + n <= len(raw):
            s = raw[off + 4: off + 4 + n]
            try:
                text = s.decode("utf-8")
                if all(32 <= ord(c) < 127 for c in text) and len(text) >= 2:
                    strings.append(text)
                    off = (off + 4 + n + 3) & ~3
                    continue
            except Exception:
                pass
        off += 4
    return strings


def get_trigger_box(sc, gp, mat):
    """Return (center_world, lo_world, hi_world) from the first BoxCollider on GO gp.
    Falls back to a 2m sphere if no box found.
    """
    for pid, o in sc.objs.items():
        if o.type.name != "BoxCollider":
            continue
        try:
            c = sc.tt(pid)
            if c["m_GameObject"]["m_PathID"] != gp:
                continue
            size = G.v3(c["m_Size"])
            ctr = G.v3(c["m_Center"])
            wv = (BOX_V * size + ctr) @ mat[:3, :3].T + mat[:3, 3]
            world_ctr = (mat[:3, 3] + mat[:3, :3] @ ctr).round(3).tolist()
            return world_ctr, wv.min(0).round(3).tolist(), wv.max(0).round(3).tolist()
        except Exception:
            pass
    # fallback: 2 m sphere around transform origin
    pos = mat[:3, 3]
    lo = (pos - 1.0).round(3).tolist()
    hi = (pos + 1.0).round(3).tolist()
    return pos.round(3).tolist(), lo, hi


def load_quest_template_ids(cache_path):
    """Collect item templateIds referenced by findQuestItem / plantQuestItem / giveQuestItem objectives."""
    try:
        cache = json.load(open(cache_path, encoding="utf-8"))
        tasks = cache.get("data", {}).get("tasks", [])
    except Exception:
        return set()
    ids = set()
    for t in tasks:
        for o in t.get("objectives", []):
            tp = o.get("type", "")
            if tp in ("findQuestItem", "plantQuestItem", "giveQuestItem", "plantItem", "findItem"):
                item = o.get("item") or {}
                for key in ("id", "templateId", "normalizedName"):
                    val = item.get(key, "")
                    if val and G.is_hex_id(val):
                        ids.add(val)
    return ids


# ---------------------------------------------------------------------------
# Per-scene extraction
# ---------------------------------------------------------------------------

def extract_scene_zones(sc, scene_name, quest_tpl_ids):
    """Return list of zone dicts for one scene."""
    results = []

    for pid, o in sc.objs.items():
        if o.type.name != "MonoBehaviour":
            continue

        try:
            mb = o.read(check_read=False)
            cls = mb.m_Script.read().m_ClassName
        except Exception:
            continue

        in_trigger = cls in TRIGGER_SCRIPTS
        in_loot = cls in LOOT_SCRIPTS
        in_scan = cls in SCAN_FOR_ID_SCRIPTS

        if not (in_trigger or in_loot or in_scan):
            continue

        try:
            gp = mb.m_GameObject.path_id
            go = sc.tt(gp)
            go_name = go.get("m_Name", "")
        except Exception:
            continue

        tid_go = sc.transform_of(go)
        if tid_go is None:
            continue
        try:
            mat, active = sc.matrix(tid_go)
        except Exception:
            continue

        raw = o.get_raw_data()
        strings = dump_strings(raw)

        # Find the zone id: first 24-hex string, then the GO name
        zone_id = next((s for s in strings if G.is_hex_id(s)), "")
        if not zone_id:
            # Use the GO name if it looks like a zone id (alphanumeric+underscore+dash, >= 4 chars)
            if len(go_name) >= 4:
                zone_id = go_name.split(" (")[0]  # strip Unity " (n)" suffixes

        # For loot scripts, only keep if a quest templateId appears in strings
        if in_loot:
            if not any(s in quest_tpl_ids for s in strings):
                continue

        center, lo, hi = get_trigger_box(sc, gp, mat)

        results.append({
            "id": zone_id,
            "script": cls,
            "name": go_name,
            "strings": strings,
            "center": center,
            "lo": lo,
            "hi": hi,
            "scene": scene_name,
        })

    return results


# ---------------------------------------------------------------------------
# Per-map extraction
# ---------------------------------------------------------------------------

def extract_map(key, by_path, quest_tpl_ids):
    scenes = [s for s in G.preset_scenes(G.PRESETS[key]) if not s.endswith("_AI.unity")]
    all_zones = []
    t0_map = time.time()
    for sp in scenes:
        idx = by_path.get(sp)
        if idx is None:
            print(f"  missing scene {sp}", flush=True)
            continue
        t0 = time.time()
        sc = G.Scene(os.path.join(DATA, f"level{idx}"))
        zones = extract_scene_zones(sc, os.path.basename(sp), quest_tpl_ids)
        all_zones.extend(zones)
        print(f"  {os.path.basename(sp)} (level{idx}): {len(zones)} zones, {time.time()-t0:.1f}s", flush=True)
    print(f"{key}: {len(all_zones)} total zones, {time.time()-t0_map:.1f}s", flush=True)
    return all_zones


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    G.DATA = DATA  # ensure helpers point to the right game dir

    by_path = G.scene_indices()
    keys = sys.argv[2:] or list(G.PRESETS)
    cache = sorted((f for f in os.listdir(os.path.join(ROOT, "cache")) if f.startswith("pve-v")), key=lambda f: int(f[5:-5]))
    cache_path = os.path.join(ROOT, "cache", cache[-1]) if cache else ""

    quest_tpl_ids = load_quest_template_ids(cache_path)
    print(f"Quest template IDs loaded: {len(quest_tpl_ids)}", flush=True)

    os.makedirs(OUT_ZONES, exist_ok=True)

    all_map_zones = []

    for key in keys:
        print(f"\n--- {key} ---", flush=True)
        zones = extract_map(key, by_path, quest_tpl_ids)

        # Tag each zone with its map key for matching
        for z in zones:
            z["_map"] = key

        # Write per-map file (strip internal _map tag)
        out_path = os.path.join(OUT_ZONES, f"{key}.json")
        clean = [{k: v for k, v in z.items() if k != "_map"} for z in zones]
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(clean, f, indent=2)
        print(f"  -> {out_path} ({len(zones)} entries)", flush=True)

        all_map_zones.extend(zones)

    print(f"\nTotal zones across all maps: {len(all_map_zones)}", flush=True)


if __name__ == "__main__":
    main()
