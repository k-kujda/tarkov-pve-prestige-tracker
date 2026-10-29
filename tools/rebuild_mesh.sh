#!/usr/bin/env bash
# Recast + links + check only (geometry already extracted): after changing build_navmesh.mjs / add_links.mjs.
set -u
cd "$(dirname "$0")/.."
MAPS="${*:-customs factory woods shoreline interchange the-lab reserve lighthouse streets-of-tarkov ground-zero the-labyrinth terminal icebreaker}"
JOBS="${JOBS:-3}"
run() { node --max-old-space-size=14000 tools/build_navmesh.mjs "$1" > "navmesh/logs/build-$1.log" 2>&1 && rm -f "navmesh/v2/$1.bin" && node --max-old-space-size=12000 tools/add_links.mjs "$1" >> "navmesh/logs/build-$1.log" 2>&1; echo "  $1: $(tail -n 1 navmesh/logs/build-$1.log)"; }
n=0; for m in $MAPS; do run "$m" & n=$((n + 1)); if [ "$n" -ge "$JOBS" ]; then wait -n; n=$((n - 1)); fi; done; wait
node tools/check_navmesh.js > navmesh/logs/check.log 2>&1; grep -v '^  !' navmesh/logs/check.log
