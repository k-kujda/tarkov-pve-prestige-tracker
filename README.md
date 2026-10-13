<div align="center">

# 🎯 Tarkov PvE Prestige Tracker

**Quests, hideout and raid planning for Escape from Tarkov PvE, built to get you through prestiges as fast as possible.**

![Platform](https://img.shields.io/badge/platform-Windows-0078D6?style=flat-square&logo=windows)
![Node](https://img.shields.io/badge/node-18%2B-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-none-c7b07a?style=flat-square)
![Game](https://img.shields.io/badge/Escape%20from%20Tarkov-1.2%20PvE-1c1b18?style=flat-square)

<img src="docs/raid-route.jpg" alt="Raid in progress: Customs map with numbered route, extracts and bosses" width="100%">

</div>

---

## ✨ Features

| | |
|---|---|
| 🧭 **Next up** | Only the quests you can do *right now* (prerequisites, level, trader loyalty, story progress), ordered for the fastest prestige: the required quest chain first, otherwise by XP. |
| 🔄 **Sync from game** | Reads quest start/finish/fail events straight from Tarkov's own log files (read-only) and keeps the tracker in step every minute. Detects prestige and wipe resets automatically. |
| 🗺️ **Raid planner** | Ranks every map by the quests you can finish there, then runs a live map with objective zones, extracts, transits, minefields, bosses, locked doors and loot. |
| 🛣️ **Route planning** | Click where you spawned and get the shortest route through your objectives to the best extract. Exact for typical raids, and it avoids minefields. |
| 🔑 **Keys & items** | A sidebar of everything your accepted quests need (FIR flags, counts, keys), and key checks next to each quest in the planner. |
| 👥 **Squad sync** | Friends share their progress via `share-progress.bat` or their raw log files, so you can plan raids around everyone's quests. |
| 🏆 **Prestige, hideout & story** | Prestige checklists, the hideout levels you need (with prerequisites), and every storyline chapter with how to start it. |

## 📸 Screenshots

<table>
<tr>
<td width="50%"><img src="docs/next-up.png" alt="Next up tab"><p align="center"><b>Next up</b>: what to do now, with the accepted-quest items sidebar</p></td>
<td width="50%"><img src="docs/raid-planner.png" alt="Raid planner"><p align="center"><b>Raid planner</b>: best maps right now</p></td>
</tr>
<tr>
<td width="50%"><img src="docs/story.png" alt="Story tab"><p align="center"><b>Story</b>: chapters, how to start them, step checklists</p></td>
<td width="50%"><img src="docs/raid-route.jpg" alt="Raid route"><p align="center"><b>Raid in progress</b>: planned route and map layers</p></td>
</tr>
</table>

## 🚀 Quick start

1. Install [Node.js](https://nodejs.org) 18 or newer. No npm packages are needed.
2. Download this repo (**Code → Download ZIP**) and unzip it anywhere.
3. Double-click **`start-tracker.bat`**. The tracker opens at <http://localhost:4747>.
4. Set your **level**, **faction** and **trader loyalty levels / reputation**. Then press **Sync from game**, or let it sync on its own.

> [!TIP]
> Your progress lives in your browser's local storage. Use **Export** now and then to keep a backup file.

Prefer a terminal? `node server.js --open`

## 🔄 How game sync works

Tarkov writes every quest event to its logs:

```
<Tarkov>\Logs\log_YYYY.MM.DD_HH-MM-SS_<version>\
    … push-notifications_000.log   ← quest started / failed / finished
    … application_000.log          ← PvE or PvP session
```

The tracker only **reads** these files on your PC, and only quest IDs and timestamps are used. Nothing touches the game, its memory or its network traffic. The game folder is found automatically for BSG launcher and Steam installs (including extra Steam libraries), or a `Battlestate Games` folder on any drive. If yours isn't found, set the `TARKOV_LOGS` environment variable to your `Logs` folder.

## 👥 Raiding with friends

Send friends **`share-progress.bat`** (also downloadable from the Raid planner tab). They double-click it, and it copies a sync code to their clipboard for them to paste to you. They need nothing installed.

No batch files? They can zip their `push-notifications` and `application` logs instead (Explorer search in the `Logs` folder → select all → *Send to → Compressed folder*), and you drop the zip into the Squad panel.

## ⚠️ Good to know

- **Unlock data isn't perfect.** Tarkov 1.x unlocks many quests through server-side story and progress flags. The tracker combines several community sources and your own logs. For anything the data gets wrong, use **hide** on a quest; it reappears by itself once the game shows you accepted it.
- **Routes are straight lines.** There's no public walkable-path data, so walls, fences and floors aren't accounted for. Read the route as the best *order*, not turn-by-turn directions.
- **Your stash isn't visible.** Item and key counts are entered by you.

## 🙏 Data sources & credits

- [**tarkov.dev**](https://tarkov.dev) / [the-hideout](https://github.com/the-hideout): quest, hideout, map and item data ([json.tarkov.dev](https://json.tarkov.dev)), plus the interactive map definitions and tiles.
- [**TarkovTracker**](https://tarkovtracker.org): community corrections for quest unlocks and storyline chapters (unofficial internal feed, used optionally).
- [**Escape from Tarkov Wiki**](https://escapefromtarkov.fandom.com): loyalty-level requirements missing from the other sources.
- [**TarkovMonitor**](https://github.com/the-hideout/TarkovMonitor): the approach for reading quest events from game logs.
- [**Leaflet**](https://leafletjs.com): the map engine.

## 🗂️ Project layout

| File | Purpose |
|---|---|
| `index.html` | The whole tracker UI (single page, vanilla JS) |
| `server.js` | Local server: serves the page and builds the combined game data (cached 6 h) |
| `gamelogs.js` | Reads quest progress from the game's log files |
| `share-progress.bat` | For friends: copies their quest progress as a sync code |
| `start-tracker.bat` | Starts the server and opens your browser |

---

<div align="center"><sub>Unofficial fan project. Not affiliated with or endorsed by Battlestate Games. Escape from Tarkov is a trademark of Battlestate Games.</sub></div>
