"""Render navmesh/<map>.bin to a PNG (plan view, north up) for checking.
Colour = height, white lines = walls/edges, green dots = tarkov.dev spawns, yellow squares = extracts, red line = path.
Usage: python tools/render_navmesh.py map [--px 1400] [--box x0 z0 x1 z1] [--y y0 y1] [--reach] [--file other.bin]
       [--suffix _x] [--features key] [--path path.json]
--reach: only polys reachable from the spawns (hides roofs and other unreachable islands)."""
import argparse, json, os, struct
import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(file):
    b = open(file, "rb").read()
    _, ver, V, P, I, Lk = struct.unpack_from("<4sIIIII", b, 0)
    off = 24
    def take(dt, n):
        nonlocal off
        a = np.frombuffer(b, dtype=dt, count=n, offset=off); off += n * np.dtype(dt).itemsize; return a
    verts = take("<f4", V * 3).reshape(V, 3); ps = take("<u4", P + 1); pi = take("<u4", I); area = take("u1", P)
    off += (4 - P % 4) % 4
    ls = take("<u4", P + 1); links = take("<u4", Lk * 3).reshape(Lk, 3)
    return verts, ps, pi, area, ls, links


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("map"); ap.add_argument("--px", type=int, default=1400); ap.add_argument("--box", type=float, nargs=4)
    ap.add_argument("--y", type=float, nargs=2); ap.add_argument("--reach", action="store_true"); ap.add_argument("--file")
    ap.add_argument("--suffix", default=""); ap.add_argument("--mask"); ap.add_argument("--features"); ap.add_argument("--path")
    a = ap.parse_args()
    verts, ps, pi, area, ls, links = load(a.file or os.path.join(ROOT, "navmesh", a.map + ".bin"))
    P = len(ps) - 1
    cache = sorted((f for f in os.listdir(os.path.join(ROOT, "cache")) if f.startswith("pve-v")), key=lambda f: int(f[5:].split(".")[0]))[-1]
    data = json.load(open(os.path.join(ROOT, "cache", cache), encoding="utf8"))["data"]
    f = data["mapFeatures"].get(a.features or a.map, {})
    cy = np.array([verts[pi[ps[p]:ps[p + 1]], 1].mean() for p in range(P)])
    cx = np.array([verts[pi[ps[p]:ps[p + 1]], 0].mean() for p in range(P)])
    cz = np.array([verts[pi[ps[p]:ps[p + 1]], 2].mean() for p in range(P)])
    keep = np.ones(P, bool)
    if a.reach:
        # flood fill from the polys nearest to each spawn
        seen = np.zeros(P, bool); stack = []
        for sp in f.get("spawns", []):
            d = (cx - sp["x"]) ** 2 + (cz - sp["z"]) ** 2 + ((cy - sp["y"]) * 3) ** 2
            s = int(np.argmin(d))
            if not seen[s]: seen[s] = True; stack.append(s)
        while stack:
            p = stack.pop()
            for l in range(ls[p], ls[p + 1]):
                o = links[l, 0]
                if not seen[o]: seen[o] = True; stack.append(o)
        keep &= seen
    if a.mask: keep &= np.fromfile(a.mask, dtype=np.uint8)[:P].astype(bool)
    if a.y: keep &= (cy >= a.y[0]) & (cy <= a.y[1])
    if a.box: x0, z0, x1, z1 = a.box
    else:
        kv = verts[np.unique(np.concatenate([pi[ps[p]:ps[p + 1]] for p in np.nonzero(keep)[0]]))] if keep.any() else verts
        x0, z0, x1, z1 = kv[:, 0].min(), kv[:, 2].min(), kv[:, 0].max(), kv[:, 2].max()
    s = a.px / max(x1 - x0, z1 - z0)
    W, H = int((x1 - x0) * s) + 1, int((z1 - z0) * s) + 1
    img = Image.new("RGB", (W, H), (20, 20, 24)); d = ImageDraw.Draw(img)
    ys = cy[keep] if keep.any() else cy
    y0, y1 = np.percentile(ys, 1), np.percentile(ys, 99)
    T = lambda x, z: ((x - x0) * s, (z1 - z) * s)
    for p in np.nonzero(keep)[0][np.argsort(cy[keep])]:
        v = verts[pi[ps[p]:ps[p + 1]]]
        t = float(np.clip((cy[p] - y0) / max(1e-3, y1 - y0), 0, 1))
        col = (int(40 + 200 * t), int(120 + 60 * (1 - abs(t - .5) * 2)), int(240 - 200 * t))
        d.polygon([T(x, z) for x, _, z in v], fill=col)
    # walls: poly edges not shared with a linked poly
    for p in np.nonzero(keep)[0]:
        idx = pi[ps[p]:ps[p + 1]]; n = len(idx)
        nb = {(int(links[l, 1]), int(links[l, 2])) for l in range(ls[p], ls[p + 1])}
        nb |= {(b, a_) for a_, b in nb}
        for k in range(n):
            e = (int(idx[k]), int(idx[(k + 1) % n]))
            if e not in nb:
                (ax, _, az), (bx, _, bz) = verts[e[0]], verts[e[1]]
                d.line([T(ax, az), T(bx, bz)], fill=(235, 235, 235), width=1)
    meta_file = os.path.join(ROOT, "navmesh", a.map + ".json")
    if not a.file and os.path.exists(meta_file):
        for dr in json.load(open(meta_file))["doors"]:
            (X0, Z0), (X1, Z1) = T(dr["lo"][0], dr["hi"][2]), T(dr["hi"][0], dr["lo"][2])
            d.rectangle([X0, Z0, X1, Z1], outline=(255, 40, 40) if dr["state"] == 1 else (0, 230, 255), width=2)
    meta_file = os.path.join(ROOT, "navmesh", a.map + ".json")
    if not a.file and os.path.exists(meta_file):
        for dr in json.load(open(meta_file))["doors"]:
            (X0, Z0), (X1, Z1) = T(dr["lo"][0], dr["hi"][2]), T(dr["hi"][0], dr["lo"][2])
            d.rectangle([X0, Z0, X1, Z1], outline=(255, 40, 40) if dr["state"] == 1 else (0, 230, 255), width=2)
    for sp in f.get("spawns", []):
        X, Z = T(sp["x"], sp["z"]); d.ellipse([X - 4, Z - 4, X + 4, Z + 4], fill=(0, 255, 0), outline=(0, 0, 0))
    for e in f.get("extracts", []):
        X, Z = T(e["x"], e["z"]); d.rectangle([X - 5, Z - 5, X + 5, Z + 5], fill=(255, 220, 0), outline=(0, 0, 0))
    if a.path:
        cols = [(255, 30, 30), (255, 255, 255), (255, 0, 255), (255, 160, 0)]
        for i, pts in enumerate(json.load(open(a.path))):
            c = cols[i % len(cols)]
            d.line([T(p["x"], p["z"]) for p in pts], fill=c, width=3 if i % 2 == 0 else 2)
            X, Z = T(pts[0]["x"], pts[0]["z"]); d.ellipse([X - 6, Z - 6, X + 6, Z + 6], outline=c, width=3)
            X, Z = T(pts[-1]["x"], pts[-1]["z"]); d.rectangle([X - 5, Z - 5, X + 5, Z + 5], outline=c, width=3)
    out = os.path.join(ROOT, "navmesh", "render", a.map + a.suffix + ".png")
    os.makedirs(os.path.dirname(out), exist_ok=True); img.save(out); print(out, W, H)


main()
