#!/usr/bin/env bash
# Rebuild every map's walkable navmesh from the game files (run after a game update):
#   1. extract_geometry.py  - collision geometry + doors from the map scenes   (needs Python with UnityPy, numpy)
#   2. extract_navmesh.py   - the bots' own navmesh, kept for cross-checks     (navmesh/ai/)
#   3. build_navmesh.mjs    - Recast player navmesh with door areas             (needs npm recast-navigation)
#   4. add_links.mjs        - drop / climb / vault links checked with rays
#   5. check_navmesh.js     - report against tarkov.dev's spawns, extracts and quest spots
# Usage: PY=<python with UnityPy> RECAST_DIR=<dir with node_modules/recast-navigation> tools/build_all.sh [game dir] [map ...]
set -u
cd "$(dirname "$0")/.."
GAME="${1:-F:\\Games\\Tarkov}"; shift || true
PY="${PY:-python}"
MAPS="${*:-customs factory woods shoreline interchange the-lab reserve lighthouse streets-of-tarkov ground-zero the-labyrinth terminal icebreaker}"
mkdir -p navmesh/logs navmesh/ai
JOBS="${JOBS:-4}"

run_parallel() { # cmd-prefix maps...
  local prefix="$1"; shift
  local running=0
  for m in "$@"; do
    ( eval "$prefix $m" > "navmesh/logs/$STEP-$m.log" 2>&1; echo "  $STEP $m: $(tail -n 1 navmesh/logs/$STEP-$m.log)" ) &
    running=$((running + 1))
    if [ "$running" -ge "$JOBS" ]; then wait -n; running=$((running - 1)); fi
  done
  wait
}

echo "== geometry"; STEP=geom run_parallel "\"$PY\" tools/extract_geometry.py \"$GAME\"" $MAPS
echo "== AI navmesh"; "$PY" tools/extract_navmesh.py "$GAME" > navmesh/logs/ai.log 2>&1
echo "== recast"; STEP=build JOBS=3 run_parallel "node --max-old-space-size=14000 tools/build_navmesh.mjs" $MAPS
for m in $MAPS; do rm -f "navmesh/v2/$m.bin"; done
echo "== links"; STEP=links run_parallel "node --max-old-space-size=12000 tools/add_links.mjs" $MAPS
echo "== check"; node tools/check_navmesh.js > navmesh/logs/check.log 2>&1; grep -v '^  !' navmesh/logs/check.log
