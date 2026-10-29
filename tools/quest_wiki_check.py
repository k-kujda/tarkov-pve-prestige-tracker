"""List quests whose objective maps on the wiki differ from json.tarkov.dev.

After a game patch the wiki is usually updated within hours, json.tarkov.dev can
take days. This prints every quest whose wiki Objectives section names other maps
than tarkov.dev does, newest wiki edit first, with both objective texts side by
side, so real changes can go into data/quest-overrides.json (mark them verified
once checked in game). Many differences are noise: tarkov.dev attaches maps to
optional or hand-over objectives, and the wiki sometimes merges quest variants.

    python tools/quest_wiki_check.py [pve|regular]
"""

import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")
MODE = sys.argv[1] if len(sys.argv) > 1 else "pve"
WIKI_API = "https://escapefromtarkov.fandom.com/api.php"
OVERRIDES = Path(__file__).resolve().parent.parent / "data" / "quest-overrides.json"
# map variants the wiki links under one page
SAME_MAP = {"Night Factory": "Factory", "The Lab (Dark)": "The Lab", "Infected Lab": "The Lab",
            "Infected Factory": "Factory", "Ground Zero 21+": "Ground Zero", "The Labyrinth": "Labyrinth"}
IGNORED_MAPS = {"Ground Zero Tutorial"}


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (tarkov-tracker quest check)"})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.load(r)


def dataset(name):
    data = get(f"https://json.tarkov.dev/{MODE}/{name}")["data"]
    words = get(f"https://json.tarkov.dev/{MODE}/{name}_en")
    return data, words.get("data", words)


def wiki_pages(titles):
    pages = {}
    for i in range(0, len(titles), 50):
        q = urllib.parse.urlencode({"action": "query", "prop": "revisions", "rvprop": "timestamp|content",
                                    "rvslots": "main", "format": "json", "redirects": 1,
                                    "titles": "|".join(titles[i:i + 50])})
        d = get(f"{WIKI_API}?{q}")["query"]
        back = {r["to"]: r["from"] for r in d.get("redirects", []) + d.get("normalized", [])}
        for p in d["pages"].values():
            if "revisions" in p:
                rev = p["revisions"][0]
                title = back.get(back.get(p["title"], p["title"]), back.get(p["title"], p["title"]))
                pages[title] = {"ts": rev["timestamp"], "text": rev["slots"]["main"]["*"]}
        time.sleep(1)
    return pages


def plain(wikitext):
    s = re.sub(r"\[\[(?:[^\]|]*\|)?([^\]]+)\]\]", r"\1", wikitext)
    s = re.sub(r"'''?|<[^>]+>|\{\{[^}]*\}\}", "", s)
    return re.sub(r"\s+", " ", s).strip(" *")


def main():
    tasks, words = dataset("tasks")
    maps, map_words = dataset("maps")
    tasks = list(tasks["tasks"].values()) if isinstance(tasks["tasks"], dict) else tasks["tasks"]
    maps = list(maps["maps"].values()) if isinstance(maps["maps"], dict) else maps["maps"]
    map_name = {m["id"]: SAME_MAP.get(map_words.get(m["name"], m["name"]), map_words.get(m["name"], m["name"]))
                for m in maps}
    known_maps = set(map_name.values()) - IGNORED_MAPS
    title = {t["id"]: urllib.parse.unquote(t["wikiLink"].split("/wiki/")[-1]).replace("_", " ")
             for t in tasks if "/wiki/" in (t.get("wikiLink") or "")}
    pages = wiki_pages(sorted(set(title.values())))
    overridden = set(json.loads(OVERRIDES.read_text(encoding="utf-8"))) if OVERRIDES.exists() else set()

    rows = []
    for t in tasks:
        page = pages.get(title.get(t["id"], ""))
        section = page and re.search(r"==\s*Objectives\s*==(.*?)(?:\n==[^=]|\Z)", page["text"], re.S)
        if not section:
            continue
        linked = {SAME_MAP.get(x.split("|")[0].strip(), x.split("|")[0].strip())
                  for x in re.findall(r"\[\[([^\]]+)\]\]", section.group(1))}
        wiki_maps = linked & known_maps
        dev_maps = {map_name.get(m if isinstance(m, str) else m.get("id")) for o in t["objectives"]
                    for m in o.get("maps") or []} & known_maps
        if wiki_maps and dev_maps and wiki_maps != dev_maps:
            bullets = [plain(line) for line in section.group(1).splitlines() if line.strip().startswith("*")]
            dev_text = [words.get(o["description"], o["description"]) for o in t["objectives"]]
            fixed = any(o["id"] in overridden for o in t["objectives"])
            rows.append((page["ts"], words.get(t["name"], t["name"]), sorted(dev_maps), sorted(wiki_maps),
                         dev_text, bullets, fixed))

    rows.sort(key=lambda r: r[0], reverse=True)
    print(f"{len(rows)} quests ({MODE}) where the wiki names other maps than json.tarkov.dev:\n")
    for ts, name, dev, wiki, dev_text, bullets, fixed in rows:
        print(f"### {name}  (wiki edited {ts[:10]}){'  [override in data/quest-overrides.json]' if fixed else ''}")
        print(f"  tarkov.dev maps: {', '.join(dev)}")
        print(f"  wiki maps:       {', '.join(wiki)}")
        print(f"  tarkov.dev: {' | '.join(dev_text)}")
        print(f"  wiki:       {' | '.join(bullets)}\n")


if __name__ == "__main__":
    main()
