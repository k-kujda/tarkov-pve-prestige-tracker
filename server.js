'use strict';
// Local server for the tracker: serves index.html and turns the public json.tarkov.dev
// datasets (no CORS headers, ~20 MB raw) into one small, translated payload.
// No dependencies — run with `node server.js` (Node 18+).

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const gamelogs = require('./gamelogs');

const PORT = Number(process.env.PORT) || 4747;
const UPSTREAM = 'https://json.tarkov.dev';
// TarkovTracker serves the same quests with its community corrections applied: trader loyalty gates,
// story-chapter gates, counters for the server-side unlock variables, and removal of retired quests.
// It is not an official integration API, so it is optional — without it the raw data is used.
const CORRECTIONS = 'https://tarkovtracker.org/api/tarkov/tasks-core';
const STORY = 'https://tarkovtracker.org/api/tarkov/editions';
const WIKI_API = 'https://escapefromtarkov.fandom.com/api.php';
// tarkov.dev's open-source interactive map definitions (tiles/SVG + game-coordinate transforms).
const MAP_DEFS = 'https://raw.githubusercontent.com/the-hideout/tarkov-dev/main/src/data/maps.json';
const MODES = new Set(['pve', 'regular']);
const DATASETS = ['tasks', 'hideout', 'maps', 'traders', 'items'];
const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_VERSION = 14;
const TTL_MS = 6 * 60 * 60 * 1000;
const CURRENCIES = {
  '5449016a4bdc2d6f028b456f': 'RUB',
  '5696686a4bdc2da3298b456a': 'USD',
  '569668774bdc2da2298b4568': 'EUR',
};

async function getJson(url, withHeaders = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
    const body = await res.json();
    return withHeaders ? { body, headers: res.headers } : body;
  } finally {
    clearTimeout(timer);
  }
}

async function getCorrections(mode) {
  try {
    const { body, headers } = await getJson(`${CORRECTIONS}?gameMode=${mode}&lang=en`, true);
    if (!body.data || !Array.isArray(body.data.tasks) || !body.data.tasks.length) throw new Error('unexpected response shape');
    return { tasks: body.data.tasks, version: headers.get('x-overlay-version'), generated: headers.get('x-overlay-generated') };
  } catch (e) {
    console.warn(`Quest unlock corrections unavailable (${e.message}) — using raw data`);
    return null;
  }
}

// Storyline chapters (how to start each one, ordered steps, unlocks) from the same community source.
async function getStory(mode) {
  try {
    const body = await getJson(`${STORY}?gameMode=${mode}&lang=en`);
    const chapters = body.data && body.data.storyChapters;
    if (!Array.isArray(chapters)) throw new Error('unexpected response shape');
    return chapters.map(c => ({
      id: c.id, name: c.name, order: c.order, wikiLink: c.wikiLink || null, autoStart: !!c.autoStart,
      requires: (c.chapterRequirements || []).map(r => r.id),
      activation: c.activation && c.activation.summary ? c.activation.summary : null,
      description: c.description || null, notes: c.notes || null,
      objectives: Object.values(c.objectives || {}).sort((a, b) => a.order - b.order)
        .map(o => ({ id: o.id, description: o.description, optional: o.type === 'optional' })),
      mapUnlocks: (c.mapUnlocks || []).map(m => m.name),
      traderUnlocks: (c.traderUnlocks || []).map(t => t.name),
    })).sort((a, b) => a.order - b.order);
  } catch (e) {
    console.warn(`Story chapters unavailable (${e.message})`);
    return null;
  }
}

// The wiki infobox's "LL requirement" fills loyalty gates missing from both data sources (e.g. Green Corridor).
// Only that field is used: the wiki's prerequisite chains and level requirements are partly pre-1.x and
// contradict real in-game progress, so they are ignored.
// ---------- quest guide photos from the wiki ----------
// Gallery images (with captions and the guide section they sit in, which is the map for multi-map quests)
// from a quest's wiki page, with thumbnail URLs. Fetched on demand and cached for a day.
const WIKI_IMAGES_TTL_MS = 24 * 60 * 60 * 1000;
const wikiImageCache = new Map();

// Keys the wiki says spawn every raid: its "Key Location" section has a ===Map=== subsection per map,
// and the subsection text says "guaranteed" (e.g. "Guaranteed spawn every raid").
const wikiClean = t => t.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').replace(/<[^>]+>/g, ' ').replace(/'''?/g, '').replace(/\{\{[^}]*\}\}/g, '').replace(/\s+/g, ' ').trim();
const wikiSection = (wikitext, name) => (wikitext.match(new RegExp(`\\n==\\s*${name}\\s*==([\\s\\S]*?)(?=\\n==[^=]|$)`, 'i')) || [])[1] || '';
// A section's text lines without galleries and images, bullets stripped.
const wikiLines = sec => sec.split('\n').filter(l => l.trim() && !/^\s*(File:|Image:|<\/?gallery|<li|<\/li|\{\{|\[\[(Category|[a-z]{2}(-[a-z]+)?):)/i.test(l))
  .map(l => wikiClean(l.replace(/^\s*\*+\s*/, ''))).filter(Boolean);

function parseGuaranteedSpawns(wikitext) {
  const sec = (wikitext.match(/==\s*Key Locations?\s*==([\s\S]*?)(?=\n==[^=]|$)/i) || [])[1];
  if (!sec) return [];
  const clean = wikiClean;
  const parts = sec.split(/\n===\s*([^=]+?)\s*===/);
  const out = [];
  for (let i = 1; i < parts.length; i += 2) {
    const lines = parts[i + 1].split('\n').filter(l => !/^\s*(File:|Image:|<\/?gallery)/i.test(l));
    const line = lines.find(l => /guarant/i.test(l));
    if (line) out.push({ mapName: clean(parts[i]), note: clean(line.replace(/^\s*\*+\s*/, '')) });
  }
  return out;
}

// Every key's wiki page: guaranteed spawns, what it opens, what's behind the lock and which quests / story chapters use it.
async function getWikiKeyPages(keyNames) {
  const out = {};
  try {
    for (let i = 0; i < keyNames.length; i += 50) {
      const batch = keyNames.slice(i, i + 50);
      const body = await getJson(`${WIKI_API}?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&redirects=1&titles=${encodeURIComponent(batch.join('|'))}`);
      const back = {};
      for (const r of [...(body.query.normalized || []), ...(body.query.redirects || [])]) back[r.to] = back[r.from] || r.from;
      for (const p of body.query.pages || []) {
        const text = p.revisions && p.revisions[0].slots.main.content;
        if (!text) continue;
        const usage = (text.match(/\|\s*usage\s*=([^\n]*)/i) || [])[1];
        out[back[p.title] || p.title] = {
          title: p.title, spawns: parseGuaranteedSpawns(text), usage: usage ? wikiClean(usage) : '',
          lockLocation: wikiLines(wikiSection(text, 'Lock Locations?')).join(' '),
          behind: wikiLines(wikiSection(text, 'Behind the Lock')),
          quests: wikiLines(wikiSection(text, 'Quests')),
        };
      }
    }
    return out;
  } catch (e) {
    console.warn(`Wiki key pages unavailable (${e.message})`);
    return {};
  }
}

// Rough loot rating of a "Behind the Lock" list: safes, valuables and keycards weigh most; "Nothing" is 0.
const LOOT_WEIGHTS = [
  [/bank safe|\bsafe/i, 4], [/multiple (very )?rare/i, 8], [/valuables|very rare|graphics card|gpu|ledx|bitcoin|intelligence folder|keycard/i, 4],
  [/weapon (box|crate|case)|weapon spawn|weapons\b/i, 2], [/medcase|pc block|jacket|toolbox|filing cabinet|ammo (box|crate)|grenade (box|crate)|supply crate|medical crate|duffle bag|sports? bag|drawer|cash register|plastic suitcase|loose loot|currency|money|cache/i, 1],
];
function lootRating(lines) {
  let score = 0;
  for (const l of lines) {
    if (/^nothing\b/i.test(l)) continue;
    const n = Number((l.match(/^(\d+)\s*x/i) || [])[1]) || 1;
    const w = LOOT_WEIGHTS.find(([re]) => re.test(l));
    score += (w ? w[1] : 0.5) * Math.min(n, 4);
  }
  return Math.round(score * 10) / 10;
}

function parseGuideImages(wikitext) {
  const out = [];
  let section = null, inGallery = false;
  for (const raw of wikitext.split('\n')) {
    const line = raw.trim();
    const head = line.match(/^==+\s*(.+?)\s*==+$/);
    if (head) { section = head[1].replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').trim(); continue; }
    if (/<gallery/i.test(line)) { inGallery = true; continue; }
    if (/<\/gallery>/i.test(line)) { inGallery = false; continue; }
    if (inGallery) {
      const m = line.match(/^(?:File:|Image:)?([^|]+\.(?:png|jpe?g|gif|webp))\s*(?:\|(.*))?$/i);
      if (m) out.push({ file: m[1].trim(), caption: (m[2] || '').replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1').trim(), section });
      continue;
    }
    // Inline screenshots ([[File:x.png|thumb|caption]]); item icons use link= and are skipped.
    for (const m of line.matchAll(/\[\[(?:File|Image):([^|\]]+\.(?:png|jpe?g|webp))\|([^\]]*)\]\]/gi)) {
      if (/link=/i.test(m[2]) || !/thumb|frame/i.test(m[2])) continue;
      out.push({ file: m[1].trim(), caption: m[2].split('|').pop().trim(), section });
    }
  }
  return out;
}

async function questImages(title) {
  const cached = wikiImageCache.get(title);
  if (cached && Date.now() - cached.at < WIKI_IMAGES_TTL_MS) return cached.images;
  const page = await getJson(`${WIKI_API}?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json&formatversion=2&redirects=1`);
  const images = parseGuideImages((page.parse && page.parse.wikitext) || '');
  const files = [...new Set(images.map(i => i.file))];
  const thumbs = {};
  for (let i = 0; i < files.length; i += 50) {
    const batch = files.slice(i, i + 50).map(f => 'File:' + f);
    const info = await getJson(`${WIKI_API}?action=query&prop=imageinfo&iiprop=url&iiurlwidth=420&format=json&formatversion=2&titles=${encodeURIComponent(batch.join('|'))}`);
    const back = {};
    for (const n of (info.query && info.query.normalized) || []) back[n.to] = n.from;
    for (const p of (info.query && info.query.pages) || []) {
      const ii = p.imageinfo && p.imageinfo[0];
      if (ii) thumbs[(back[p.title] || p.title).replace(/^File:/, '')] = { thumb: ii.thumburl || ii.url, url: ii.descriptionurl || ii.url };
    }
  }
  const result = images.filter(i => thumbs[i.file]).map(i => ({ ...i, ...thumbs[i.file] }));
  wikiImageCache.set(title, { at: Date.now(), images: result });
  return result;
}

async function getWikiLoyalty(wikiLinks) {
  const titles = [...new Set(wikiLinks.map(l => decodeURIComponent((l || '').split('/wiki/')[1] || '').replace(/_/g, ' ')).filter(Boolean))];
  const result = {};
  try {
    for (let i = 0; i < titles.length; i += 50) {
      const batch = titles.slice(i, i + 50);
      const url = `${WIKI_API}?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&redirects=1&titles=${encodeURIComponent(batch.join('|'))}`;
      const body = await getJson(url);
      const back = {};
      for (const r of [...(body.query.normalized || []), ...(body.query.redirects || [])]) back[r.to] = back[r.from] || r.from;
      for (const p of body.query.pages || []) {
        const text = p.revisions && p.revisions[0].slots.main.content;
        const m = text && text.match(/\|\s*LL requirement\s*=\s*(\d+)/i);
        if (m) result[back[p.title] || p.title] = Number(m[1]);
      }
    }
    return result;
  } catch (e) {
    console.warn(`Wiki loyalty requirements unavailable (${e.message})`);
    return null;
  }
}

async function getMapDefs() {
  try {
    const groups = await getJson(MAP_DEFS);
    const out = {};
    for (const g of groups) {
      const m = (g.maps || []).find(x => x.projection === 'interactive');
      if (!m || !m.transform) continue;
      out[g.normalizedName] = {
        transform: m.transform, coordinateRotation: m.coordinateRotation || 0, bounds: m.bounds, svgBounds: m.svgBounds || null,
        tilePath: m.tilePath || null, svgPath: m.svgPath || null, svgLayer: m.svgLayer || null, tileSize: m.tileSize || 256, minZoom: m.minZoom || 1, maxZoom: m.maxZoom || 6,
        heightRange: m.heightRange || null,
        // Floors as height bands (e.g. Streets: 2nd floor = 10–15 m) and the SVG group that draws each one.
        // A floor can have several height bands, each limited to named building areas (e.g. Customs 2nd floor:
        // 2.7–6.5 m inside dorms, mechanic, scav checkpoint…). No areas = the band applies map-wide.
        layers: (m.layers || []).filter(l => l.svgLayer && l.extents && l.extents.length && l.extents[0].height)
          .map(l => ({
            name: l.name, svgLayer: l.svgLayer, height: l.extents[0].height,
            extents: l.extents.filter(e => e.height).map(e => ({
              height: e.height,
              areas: (e.bounds || []).filter(b => Array.isArray(b) && b.length >= 2)
                .map(b => ({ x1: b[0][0], z1: b[0][1], x2: b[1][0], z2: b[1][1], name: b[2] || null })),
            })),
          })),
        // Place / building names with their [x, z] position.
        labels: (m.labels || []).filter(l => Array.isArray(l.position)).map(l => ({ text: l.text, x: l.position[0], z: l.position[1], size: l.size || 100, rotation: l.rotation || 0 })),
      };
    }
    return out;
  } catch (e) {
    console.warn(`Map definitions unavailable (${e.message})`);
    return {};
  }
}

// Loot containers worth showing on a raid map (the rest are too numerous to be useful).
const VALUABLE_CONTAINERS = new Set(['safe', 'weapon-box', 'medcase', 'ground-cache', 'buried-barrel-cache', 'pc-block',
  'technical-supply-crate', 'medical-supply-crate', 'grenade-box', 'ration-supply-crate', 'wooden-ammo-box', 'toolbox', 'jacket']);

function buildMapFeatures(data, tr, item) {
  const r1 = v => Math.round(v * 10) / 10;
  const xz = p => ({ x: r1(p.x), z: r1(p.z), y: r1(p.y) });
  const out = {};
  for (const m of Object.values(data.maps || {})) {
    const f = {
      spawns: (m.spawns || []).filter(sp => sp.position && (sp.categories || []).includes('player') && (sp.sides || []).some(x => x === 'pmc' || x === 'all'))
        .map(sp => xz(sp.position)),
      extracts: (m.extracts || []).filter(e => e.position).map(e => ({ name: tr(e.name), faction: e.faction || 'shared', ...xz(e.position) })),
      transits: (m.transits || []).filter(t => t.position).map(t => ({ name: tr(t.description), ...xz(t.position) })),
      locks: (m.locks || []).filter(l => l.position && l.key).map(l => ({ key: item(l.key), lockType: l.lockType, needsPower: !!l.needsPower, ...xz(l.position) })),
      hazards: (m.hazards || []).filter(h => h.position).map(h => ({
        type: h.hazardType, name: tr(h.name), ...xz(h.position),
        outline: (h.outline || []).map(q => [r1(q.x), r1(q.z)]),
      })),
      bosses: (m.bosses || []).filter(b => !/^pmc/i.test(b.mob)).map(b => {
        const mob = data.mobs && data.mobs[b.mob];
        return {
          name: tr(mob ? mob.name : b.mob), chance: b.spawnChance,
          points: (b.spawnLocations || []).flatMap(l => (l.positions || []).map(p => ({ ...xz(p), zone: l.name, chance: l.chance }))),
        };
      }).filter(b => b.points.length),
      stationary: (m.stationaryWeapons || []).filter(w => w.position).map(w => {
        const sw = data.stationaryWeapons && data.stationaryWeapons[w.stationaryWeapon];
        return { name: sw ? tr(sw.shortName, tr(sw.name)) : 'Stationary weapon', ...xz(w.position) };
      }),
      loot: (m.lootContainers || []).filter(c => c.position).map(c => {
        const lc = data.lootContainers && data.lootContainers[c.lootContainer];
        return lc && VALUABLE_CONTAINERS.has(lc.normalizedName) ? { name: tr(lc.name), kind: lc.normalizedName, ...xz(c.position) } : null;
      }).filter(Boolean),
    };
    out[m.normalizedName] = f;
  }
  return out;
}

async function build(mode) {
  const raw = {};
  await Promise.all([
    ...DATASETS.map(async name => {
      const [base, en] = await Promise.all([getJson(`${UPSTREAM}/${mode}/${name}`), getJson(`${UPSTREAM}/${mode}/${name}_en`)]);
      raw[name] = { data: base.data, dict: en.data || {} };
    }),
    getCorrections(mode).then(c => { raw.corrections = c; }),
    getStory(mode).then(c => { raw.story = c; }),
    getMapDefs().then(m => { raw.mapDefs = m; }),
  ]);
  raw.wikiLoyalty = await getWikiLoyalty(Object.values(raw.tasks.data.tasks).map(t => t.wikiLink));
  // Wiki page title of every key and keycard, for guaranteed spawns and the key lookup.
  const dict = Object.assign({}, ...DATASETS.map(n => raw[n].dict));
  const keyTitle = it => decodeURIComponent((it.wikiLink || '').split('/wiki/')[1] || '').replace(/_/g, ' ') || dict[it.name];
  raw.keyNames = Object.fromEntries(Object.values(raw.items.data.items).filter(it => (it.types || []).includes('keys'))
    .map(it => [it.id, keyTitle(it)]).filter(([, n]) => n));
  raw.keyPages = await getWikiKeyPages([...new Set(Object.values(raw.keyNames))]);
  return normalize(raw);
}

function normalize(raw) {
  const dict = Object.assign({}, ...DATASETS.map(n => raw[n].dict));
  const tr = (key, fallback = key) => (key != null && dict[key]) || fallback;

  const T = raw.tasks.data;
  const itemsRaw = raw.items.data.items;
  const itemCategories = raw.items.data.itemCategories || {};
  // Weapon type(s) of a kill condition's weapon list, from each item's most specific category ("Assault rifle"), most common first.
  const weaponTypes = weaponIds => {
    const counts = new Map();
    for (const id of weaponIds) {
      const cat = itemsRaw[id] && itemsRaw[id].categories && itemCategories[itemsRaw[id].categories[0]];
      const name = cat ? tr(cat.name, cat.normalizedName) : 'Other';
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n }));
  };
  const mapsRaw = raw.maps.data.maps;
  const tradersRaw = raw.traders.data;
  const stationsRaw = raw.hideout.data;

  const itemCache = new Map();
  const item = id => {
    if (!itemCache.has(id)) {
      const it = itemsRaw[id] || T.questItems[id];
      itemCache.set(id, it
        ? { id, name: tr(it.name, id), shortName: tr(it.shortName, ''), iconLink: it.iconLink || null, image: it.gridImageLink || null }
        : { id, name: id, shortName: '', iconLink: null });
    }
    return itemCache.get(id);
  };
  const map = id => {
    const m = id && mapsRaw[id];
    return m ? { id, name: tr(m.name, m.normalizedName), normalizedName: m.normalizedName } : null;
  };
  const trader = id => {
    const t = id && tradersRaw[id];
    return t ? { id, name: tr(t.name, t.normalizedName), normalizedName: t.normalizedName } : { id, name: String(id), normalizedName: '' };
  };
  const station = id => ({ id, name: stationsRaw[id] ? tr(stationsRaw[id].name, stationsRaw[id].normalizedName) : String(id) });
  const taskName = id => (T.tasks[id] ? tr(T.tasks[id].name, id) : String(id));

  const objective = o => {
    const r = {
      id: o.id, type: o.type, description: tr(o.description, ''), optional: !!o.optional,
      maps: (o.maps || []).map(map).filter(Boolean), count: o.count == null ? null : o.count,
    };
    if (o.items) { r.items = o.items.map(item); r.foundInRaid = !!o.foundInRaid; }
    // Map positions for the raid planner: objective zones and possible quest-item spots.
    const round = v => Math.round(v * 10) / 10;
    const point = (mapId, p, kind) => { const m = map(mapId); return m && p ? { map: m.normalizedName, x: round(p.x), y: round(p.y), z: round(p.z), kind } : null; };
    const points = [
      ...(o.zones || []).map(z => {
        const p = point(z.map, z.position, 'zone');
        if (p && z.outline && z.outline.length > 2) p.outline = z.outline.map(q => [round(q.x), round(q.z)]);
        return p;
      }),
      ...(o.possibleLocations || []).flatMap(l => (l.positions || []).map(p => point(l.map, p, 'item'))),
    ].filter(Boolean);
    if (points.length) r.points = points;
    if (o.questItem) r.questItem = item(o.questItem);
    if (o.markerItem) r.markerItem = item(o.markerItem);
    if (o.targetNames && o.targetNames.length) r.targetNames = o.targetNames.map(x => tr(x));
    if (o.zones && o.type === 'shoot') r.zoneNames = [...new Set(o.zones.map(z => tr(z.name, '')).filter(Boolean))];
    if (o.bodyParts && o.bodyParts.length) r.bodyParts = o.bodyParts.map(x => tr(x));
    if (o.usingWeapon && o.usingWeapon.length) {
      r.usingWeapon = o.usingWeapon.map(item);
      r.weaponTypes = weaponTypes(o.usingWeapon);
    }
    // Kill conditions on attachments and gear: groups are alternatives ("any of these").
    const ids = list => [].concat(list).map(x => (typeof x === 'string' ? x : x && x.id)).filter(Boolean);
    if (o.usingWeaponMods && o.usingWeaponMods.length) r.usingWeaponMods = o.usingWeaponMods.map(g => ids(g).map(item));
    if (o.wearing && o.wearing.length) r.wearing = o.wearing.map(g => ids(g).map(item));
    if (o.notWearing && o.notWearing.length) r.notWearing = ids(o.notWearing).map(item);
    if (o.exitName) r.exitName = tr(o.exitName);
    if (o.useAny && o.useAny.length) r.useAny = o.useAny.map(item);
    if (o.type === 'skill') r.skillLevel = { name: tr(o.skill), level: o.level };
    if ((o.type === 'traderLevel' || o.type === 'traderStanding') && o.trader) {
      r.trader = trader(o.trader); r.level = o.level; r.value = o.value; r.compareMethod = o.compareMethod;
    }
    if (o.type === 'playerLevel') r.playerLevel = o.playerLevel;
    if (o.task) { r.task = { id: o.task, name: taskName(o.task) }; r.status = o.status; }
    if (o.requiredKeys && o.requiredKeys.length) r.requiredKeys = o.requiredKeys.map(group => [].concat(group).map(item));
    if (o.type === 'buildWeapon' && o.item) r.item = item(o.item);
    if (o.type === 'hideoutStation') { r.station = station(o.station); r.stationLevel = o.stationLevel; }
    return r;
  };

  const rewards = rw => {
    rw = rw || {};
    const money = {};
    for (const i of rw.items || []) if (CURRENCIES[i.item]) money[CURRENCIES[i.item]] = (money[CURRENCIES[i.item]] || 0) + i.count;
    return {
      money,
      items: (rw.items || []).map(i => ({ count: i.count, item: item(i.item) })),
      traderStanding: (rw.traderStanding || []).map(s => ({ trader: trader(s.trader), standing: s.standing })),
      offerUnlock: (rw.offerUnlock || []).map(o => ({ trader: trader(o.trader), level: o.level, item: item(o.item) })),
      skillLevelReward: (rw.skillLevelReward || []).map(s => ({ name: tr(s.skill || s.name), level: s.level })),
      traderUnlock: (rw.traderUnlock || []).map(u => trader(typeof u === 'string' ? u : (u.trader || u.id))),
    };
  };

  const otherRequirement = o => {
    if (o.type === 'globalVariable') {
      return {
        id: o.id, type: o.type, variableId: o.variableId, compareMethod: o.compareMethod || '>=', value: o.value == null ? 1 : o.value,
        counter: o.counter && Array.isArray(o.counter.taskIds) ? { taskIds: o.counter.taskIds } : null,
      };
    }
    if (o.type === 'storyObjective') return { id: o.id, type: o.type, storyChapter: o.storyChapter, objective: o.objective };
    return { id: o.id, type: o.type, traders: (o.traders || []).map(trader) };
  };

  const tasks = Object.values(T.tasks).map(t => ({
    id: t.id, name: tr(t.name, t.id), normalizedName: t.normalizedName,
    minPlayerLevel: t.minPlayerLevel || 1, experience: t.experience || 0,
    kappaRequired: !!t.kappaRequired, lightkeeperRequired: !!t.lightkeeperRequired,
    wikiLink: t.wikiLink || null, factionName: t.factionName || 'Any',
    trader: trader(t.trader), map: map(t.map),
    taskRequirements: (t.taskRequirements || []).map(r => ({ task: { id: r.task }, status: r.status })),
    traderRequirements: (t.traderRequirements || []).map(r => ({ trader: trader(r.trader), requirementType: r.requirementType, compareMethod: r.compareMethod, value: r.value })),
    // Server-side unlock gates (story/progress variables, trader dialogue) that the data can't resolve.
    otherRequirements: (t.otherRequirements || []).map(otherRequirement),
    neededKeys: (t.neededKeys || []).map(k => ({ map: map(k.map), keys: (k.keys || []).map(item) })),
    objectives: (t.objectives || []).map(objective),
    finishRewards: rewards(t.finishRewards),
  }));

  const describe = c => {
    switch (c.type) {
      case 'playerLevel': return `Reach level ${c.playerLevel}`;
      case 'skill': return `${c.skillLevel.name} skill level ${c.skillLevel.level}`;
      case 'hideoutStation': return `${c.station.name} level ${c.stationLevel}`;
      case 'taskStatus': return `Complete quest “${c.task.name}”`;
      case 'haveItem': return `Have ${Number(c.count).toLocaleString('en-US')} ${c.items && c.items[0] ? c.items[0].name : 'items'} in stash`;
      default: return c.description || c.type;
    }
  };
  const prestige = (T.prestige || []).map(p => ({
    id: p.id, prestigeLevel: p.prestigeLevel, name: tr(p.name, `Prestige ${p.prestigeLevel}`),
    conditions: p.conditions.map(c => { const o = objective(c); o.description = o.description || describe(o); return o; }),
  })).sort((a, b) => a.prestigeLevel - b.prestigeLevel);

  const hideoutStations = Object.values(stationsRaw).map(s => ({
    id: s.id, name: tr(s.name, s.normalizedName), normalizedName: s.normalizedName,
    levels: (s.levels || []).map(l => ({
      id: l.id, level: l.level, constructionTime: l.constructionTime || 0,
      itemRequirements: (l.itemRequirements || []).map(r => ({ count: r.count, item: item(r.item), foundInRaid: !!(r.attributes && r.attributes.foundInRaid) })),
      stationLevelRequirements: (l.stationLevelRequirements || []).map(r => ({ station: station(r.station), level: r.level })),
      traderRequirements: (l.traderRequirements || []).map(r => ({
        trader: trader(r.trader), requirementType: r.requirementType || 'level', compareMethod: r.compareMethod || '>=', value: r.value != null ? r.value : r.level,
      })),
      skillRequirements: (l.skillRequirements || []).map(r => ({ name: tr(r.skill || r.name), level: r.level })),
    })),
  })).filter(s => s.levels.length);

  // Apply the community corrections; quests missing from them have been retired from the game.
  const fixes = raw.corrections && new Map(raw.corrections.tasks.map(c => [c.id, c]));
  const finalTasks = !fixes ? tasks : tasks.filter(t => fixes.has(t.id)).map(t => {
    const c = fixes.get(t.id);
    return {
      ...t,
      minPlayerLevel: c.minPlayerLevel == null ? t.minPlayerLevel : c.minPlayerLevel || 1,
      factionName: c.factionName || t.factionName,
      taskRequirements: (c.taskRequirements || []).filter(r => r.task && r.task.id).map(r => ({ task: { id: r.task.id }, status: r.status })),
      traderRequirements: (c.normalizedTraderRequirements || []).filter(r => r.trader).map(r => ({
        trader: trader(r.trader.id), requirementType: r.requirementType, compareMethod: r.compareMethod || '>=', value: r.value,
      })),
      otherRequirements: (c.otherRequirements || []).map(otherRequirement),
    };
  });
  let wikiAdded = 0;
  if (raw.wikiLoyalty) {
    for (const t of finalTasks) {
      const title = decodeURIComponent((t.wikiLink || '').split('/wiki/')[1] || '').replace(/_/g, ' ');
      const ll = raw.wikiLoyalty[title];
      const own = t.traderRequirements.find(r => r.requirementType === 'level' && r.trader.id === t.trader.id);
      if (!ll || ll < 2 || (own && own.value >= ll)) continue;
      t.traderRequirements = t.traderRequirements.filter(r => r !== own)
        .concat({ trader: t.trader, requirementType: 'level', compareMethod: '>=', value: ll, source: 'wiki' });
      wikiAdded++;
    }
  }
  const corrections = raw.corrections ? { source: 'tarkovtracker.org', version: raw.corrections.version, generated: raw.corrections.generated, removed: tasks.length - finalTasks.length, wikiLoyalty: wikiAdded } : null;

  const usedTraders = new Set(tasks.map(t => t.trader.id));
  const traders = Object.values(tradersRaw).filter(t => usedTraders.has(t.id)).map(t => trader(t.id));
  const maps = Object.values(mapsRaw).map(m => map(m.id));
  const playerLevels = raw.items.data.playerLevels || [];

  const mapFeatures = buildMapFeatures(raw.maps.data, tr, item);
  // Guaranteed key spawns with positions: dedicated loose-loot spots on that map that only ever hold this key.
  const keySpawns = {};
  const mapByName = Object.fromEntries(Object.values(mapsRaw).map(m => [tr(m.name, m.normalizedName).toLowerCase(), m]));
  const pos = p => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 });
  // Keys that sit in a container made for them (e.g. the Machinery key's jacket in dorm room 205): a container type
  // placed once on the map whose id was created within the hour of the key's (ObjectIds start with a timestamp).
  const idTime = id => parseInt(String(id).slice(0, 8), 16);
  const ownContainer = (m, id) => {
    const count = new Map();
    for (const c of m.lootContainers || []) count.set(c.lootContainer, (count.get(c.lootContainer) || 0) + 1);
    const c = (m.lootContainers || []).find(x => count.get(x.lootContainer) === 1 && Math.abs(idTime(x.lootContainer) - idTime(id)) < 3600);
    return c ? [pos(c.position)] : [];
  };
  for (const [id, name] of Object.entries(raw.keyNames || {})) {
    const w = (raw.keyPages || {})[name];
    if (!w || !w.spawns.length) continue;
    keySpawns[id] = { wikiTitle: w.title, spawns: w.spawns.map(sp => {
      const m = mapByName[sp.mapName.toLowerCase()];
      const spots = m ? (m.lootLoose || []).filter(l => l.position && l.items.includes(id)) : [];
      const own = spots.filter(l => l.items.length === 1);
      let pts = (own.length ? own : spots.filter(l => l.items.length <= 3)).map(l => pos(l.position));
      if (!pts.length && m) pts = ownContainer(m, id);
      return { map: m ? m.normalizedName : null, mapName: sp.mapName, note: sp.note, points: pts };
    }).filter(sp => sp.map) };
  }

  // Key lookup: every key and keycard with flea price, the maps with its lock, and the wiki's lock / loot notes.
  const lockMaps = {};
  for (const m of Object.values(mapsRaw)) for (const l of m.locks || []) if (l.key) (lockMaps[l.key] = lockMaps[l.key] || new Set()).add(tr(m.name, m.normalizedName));
  const keys = Object.entries(raw.keyNames || {}).map(([id, title]) => {
    const it = itemsRaw[id], w = (raw.keyPages || {})[title] || null;
    const best = Math.max(0, ...(it.sellToTrader || []).map(s => s.priceRUB || 0));
    return {
      ...item(id), wikiLink: it.wikiLink || null, uses: (it.properties && it.properties.uses) || null,
      flea: it.avg24hPrice || it.lastLowPrice || 0, noFlea: (it.types || []).includes('noFlea'), traderPrice: best,
      lockMaps: [...(lockMaps[id] || [])], usage: w ? w.usage : '', lockLocation: w ? w.lockLocation : '',
      behind: w ? w.behind : [], lootScore: w ? lootRating(w.behind) : null, wikiQuests: w ? w.quests : [],
    };
  });
  return { tasks: finalTasks, corrections, storyChapters: raw.story || [], mapDefs: raw.mapDefs || {}, mapFeatures, keySpawns, keys, hideoutStations, traders, maps, prestige, playerLevels };
}

// ---------- cache ----------
const memory = new Map();
const inFlight = new Map();
const cacheFile = mode => path.join(CACHE_DIR, `${mode}-v${CACHE_VERSION}.json`);

function readCache(mode) {
  if (memory.has(mode)) return memory.get(mode);
  try {
    const entry = JSON.parse(fs.readFileSync(cacheFile(mode), 'utf8'));
    memory.set(mode, entry);
    return entry;
  } catch (e) {
    return null;
  }
}

async function getData(mode, force) {
  const cached = readCache(mode);
  if (cached && !force && Date.now() - cached.at < TTL_MS) return { entry: cached, status: 'cache' };
  if (!inFlight.has(mode)) {
    inFlight.set(mode, build(mode).then(data => {
      const entry = { at: Date.now(), data };
      memory.set(mode, entry);
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(cacheFile(mode), JSON.stringify(entry));
      return entry;
    }).finally(() => inFlight.delete(mode)));
  }
  try {
    return { entry: await inFlight.get(mode), status: 'fresh' };
  } catch (e) {
    if (cached) return { entry: cached, status: 'stale', warning: e.message };
    throw e;
  }
}

// ---------- http ----------
function send(req, res, code, type, body) {
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    headers['Content-Encoding'] = 'gzip';
    body = zlib.gzipSync(body);
  }
  res.writeHead(code, headers);
  res.end(body);
}

// Navmesh files are several MB: gzip each once and keep it until the file changes.
const NAV_DIR = path.join(__dirname, 'navmesh');
const gzCache = new Map();
function sendCached(req, res, file, type) {
  const mtime = fs.statSync(file).mtimeMs;
  let c = gzCache.get(file);
  if (!c || c.mtime !== mtime) {
    const raw = fs.readFileSync(file);
    c = { mtime, raw, gz: zlib.gzipSync(raw, { level: 6 }) };
    gzCache.set(file, c);
  }
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
  res.end(gz ? c.gz : c.raw);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(req, res, 200, 'text/html; charset=utf-8', fs.readFileSync(path.join(__dirname, 'index.html')));
    }
    if (url.pathname === '/nav.js' || url.pathname === '/nav-worker.js') {
      return send(req, res, 200, 'text/javascript; charset=utf-8', fs.readFileSync(path.join(__dirname, url.pathname.slice(1))));
    }
    if (url.pathname === '/api/navmesh') {
      // Walkable mesh of a map (built from the game files by tools/), or its door list with ?meta=1.
      const map = url.searchParams.get('map') || '';
      if (!/^[a-z0-9-]+$/.test(map)) return send(req, res, 400, 'text/plain', 'bad map');
      const meta = url.searchParams.get('meta') === '1';
      const file = path.join(NAV_DIR, map + (meta ? '.json' : '.bin'));
      if (!fs.existsSync(file)) return send(req, res, 404, 'text/plain', 'no navmesh for ' + map);
      return sendCached(req, res, file, meta ? 'application/json' : 'application/octet-stream');
    }
    if (url.pathname === '/api/data') {
      const mode = MODES.has(url.searchParams.get('mode')) ? url.searchParams.get('mode') : 'pve';
      const { entry, status, warning } = await getData(mode, url.searchParams.get('refresh') === '1');
      console.log(`[${new Date().toLocaleTimeString()}] data ${mode}: ${status}${warning ? ` (${warning})` : ''}`);
      return send(req, res, 200, 'application/json', JSON.stringify({ at: entry.at, status, warning, ...entry.data }));
    }
    if (url.pathname === '/api/quest-images') {
      // Only wiki page titles are accepted (the server builds the wiki URL itself).
      const title = (url.searchParams.get('title') || '').slice(0, 200);
      if (!title || /[<>{}\[\]|#]/.test(title)) return send(req, res, 400, 'application/json', JSON.stringify({ error: 'bad title' }));
      return send(req, res, 200, 'application/json', JSON.stringify({ title, images: await questImages(title) }));
    }
    if (url.pathname === '/api/game-progress') {
      const mode = MODES.has(url.searchParams.get('mode')) ? url.searchParams.get('mode') : 'pve';
      const progress = gamelogs.readProgress(mode);
      console.log(`[${new Date().toLocaleTimeString()}] game logs ${mode}: ${Object.keys(progress.quests).length} quests in current run (since ${progress.since || 'start'})`);
      return send(req, res, 200, 'application/json', JSON.stringify(progress));
    }
    send(req, res, 404, 'text/plain', 'Not found');
  } catch (e) {
    console.error(e);
    send(req, res, 502, 'application/json', JSON.stringify({ error: e.message }));
  }
});

if (require.main === module) server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Tarkov tracker running at ${url}  (Ctrl+C to stop)`);
  if (process.argv.includes('--open') && process.platform === 'win32') {
    require('child_process').spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
});

module.exports = { normalize, build };
