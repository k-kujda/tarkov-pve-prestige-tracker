'use strict';
// Gunsmith: every ergonomics / vertical recoil a weapon can reach with the attachments that fit it.
//
// A weapon is a tree: it has slots, each slot takes one of a list of mods (or nothing, unless it's
// required), and mods have slots of their own. Ergonomics and recoil modifiers simply add up over
// everything installed, so instead of listing builds (often 10^30 and more) the solver works with the set
// of reachable (ergo, recoil %) pairs. A slot's set is the union of its options' sets; an item's set is
// its own stats plus one point from each of its slots. Points are bucketed (half an ergo point, half a
// percent of recoil).
//
// Some parts can't be installed together (a long handguard on a short barrel, two scopes on one rail).
// Each way of reaching a point carries a fingerprint: a bitmask of the conflict-prone parts it uses, and
// the mask of parts those conflict with. Two partial builds are only added together when their
// fingerprints don't clash, and a point keeps up to ALTERNATIVES ways with different fingerprints. So
// every point the solver returns has a real conflict-free build, rebuilt by following the recorded
// choices. (A point can only be missed when a bucket runs out of room for fingerprints.)
//
// Required parts (a quest's parts, "any suppressor") work the same way: each requirement is a group of
// parts and gets a bit, every way carries the bits its parts meet (has), and a point is one (ergo, recoil,
// has) bucket so builds with and without a required part don't compete for room. Only the points that
// meet every requirement are returned.

const MOD_TYPES = new Set(['ItemPropertiesWeaponMod', 'ItemPropertiesScope', 'ItemPropertiesMagazine', 'ItemPropertiesBarrel']);
const ERGO_STEP = 0.5;       // bucket size, ergonomics points
const RECOIL_STEP = 0.5;     // bucket size, percent of vertical recoil
const ALTERNATIVES = 6;      // ways (with different conflict fingerprints) kept per point
const MAX_DEPTH = 14;        // mods on mods on mods...
const MAX_NEEDS = 10;        // requirements per solve (a quest has up to 8 parts and a magazine)
const SUPPRESSOR = '550aa4cd4bdc2dd8348b456c';   // item category "Silencer"

const prettySlot = nameId => {
  const s = String(nameId || '').replace(/^mod_/, '').replace(/_\d+$/, '').replace(/_/g, ' ');
  return s.replace(/\breciever\b/, 'receiver').replace(/^./, c => c.toUpperCase());
};

// Compact catalogue of weapons and attachments from json.tarkov.dev items + the English dictionary.
function buildCatalog(itemsData, dict) {
  const items = itemsData.items;
  const all = Object.values(items);
  const name = it => dict[it.name] || it.normalizedName;
  const shortName = it => dict[it.shortName] || name(it);
  const catNames = Object.fromEntries(Object.values(itemsData.itemCategories || {}).map(c => [c.id, dict[c.name] || c.name || c.normalizedName]));
  const byCategory = new Map();
  for (const it of all) for (const c of it.categories || []) (byCategory.get(c) || byCategory.set(c, []).get(c)).push(it.id);
  const price = it => {
    const trader = (it.buyFor || []).filter(b => b.currency === 'RUB' || b.priceRUB).map(b => b.priceRUB || b.price);
    return it.avg24hPrice || it.lastLowPrice || (trader.length ? Math.min(...trader) : null);
  };
  const slotsOf = it => ((it.properties || {}).slots || []).map(s => {
    const f = s.filters || {};
    let allowed = [...(f.allowedItems || [])];
    for (const c of f.allowedCategories || []) allowed.push(...(byCategory.get(c) || []));
    const excluded = new Set([...(f.excludedItems || []), ...(f.excludedCategories || []).flatMap(c => byCategory.get(c) || [])]);
    allowed = [...new Set(allowed)].filter(id => !excluded.has(id));
    return { id: s.id, nameId: s.nameId, name: prettySlot(s.nameId), required: !!s.required, allowed };
  });
  const parts = {};
  for (const it of all) {
    const p = it.properties || {};
    if (!MOD_TYPES.has(p.propertiesType)) continue;
    parts[it.id] = {
      id: it.id, name: name(it), short: shortName(it), icon: it.iconLink, image: it.gridImageLink,
      ergo: Number(p.ergonomics) || 0, recoil: Number(it.recoilModifier) || 0,
      weight: it.weight || 0, price: price(it), conflicts: it.conflictingItems || [], slots: slotsOf(it),
      cats: it.categories || [], ...(p.capacity ? { capacity: p.capacity } : {}),
    };
  }
  const weapons = {};
  for (const it of all) {
    const p = it.properties || {};
    if (p.propertiesType !== 'ItemPropertiesWeapon' || !(p.slots || []).length) continue;
    const cls = (it.categories || []).map(c => catNames[c]).find(n => n && !/^(Weapon|Compound item|Item)$/i.test(n));
    weapons[it.id] = {
      id: it.id, name: name(it), short: shortName(it), icon: it.iconLink, image: it.image512pxLink || it.baseImageLink,
      cls: cls || 'Weapon', caliber: String(p.caliber || '').replace(/^Caliber/, ''),
      ergo: Number(p.ergonomics) || 0, recoilV: Number(p.recoilVertical) || 0, recoilH: Number(p.recoilHorizontal) || 0,
      weight: it.weight || 0, price: price(it), slots: slotsOf(it),
    };
  }
  return { weapons, parts, catNames };
}

// Bucket key: ergo and recoil buckets, then the requirement bits met (exact: well under 2^53).
const keyOf = (e, r, has) => ((Math.round(e / ERGO_STEP) + 4000) * 100000 + (Math.round(r / RECOIL_STEP) + 50000)) * (1 << MAX_NEEDS) + has;

// A way of reaching a point: its exact stats (e, r), how it was made (keys and way indices in the sets
// it came from), its fingerprint (fp: conflict-prone parts used) and the parts it rules out (no), both
// BigInt bitmasks. A point is a bucket of ways; its first way stands for it.
function addWay(set, way) {
  const k = keyOf(way.e, way.r, way.has);
  const p = set.get(k);
  if (!p) { set.set(k, { ways: [way] }); return; }
  if (p.ways.length >= ALTERNATIVES) return;
  for (const w of p.ways) if (w.fp === way.fp) return;
  p.ways.push(way);
}

// Every point of A plus every point of B, through ways whose parts don't conflict.
function sum(a, b) {
  const out = new Map();
  for (const [ka, pa] of a) {
    for (const [kb, pb] of b) {
      const has = pa.ways[0].has | pb.ways[0].has;
      const head = out.get(keyOf(pa.ways[0].e + pb.ways[0].e, pa.ways[0].r + pb.ways[0].r, has));
      if (head && head.ways.length >= ALTERNATIVES) continue;
      for (let i = 0; i < pa.ways.length; i++) {
        const wa = pa.ways[i];
        for (let j = 0; j < pb.ways.length; j++) {
          const wb = pb.ways[j];
          if ((wa.fp & wb.no) || (wb.fp & wa.no)) continue;
          addWay(out, { e: wa.e + wb.e, r: wa.r + wb.r, has, a: ka, ai: i, b: kb, bi: j, fp: wa.fp | wb.fp, no: wa.no | wb.no });
        }
      }
    }
  }
  return out;
}

// Every part that fits the weapon, or fits a part that does.
function reachable(catalog, weapon) {
  const reach = new Set();
  const walk = (slots, depth) => {
    if (depth > MAX_DEPTH) return;
    for (const s of slots) for (const id of s.allowed) {
      const part = catalog.parts[id];
      if (part && !reach.has(id)) { reach.add(id); walk(part.slots, depth + 1); }
    }
  };
  walk(weapon.slots, 0);
  return reach;
}

// Requirements as sent by the browser: a part id, "cat:<category id>" for any part of a category, or
// "mag:<n>" for a magazine of at least n rounds. Each gets the parts of this weapon's tree that meet it
// (none: no build can).
function parseNeeds(catalog, weapon, needs) {
  const reach = [...reachable(catalog, weapon)];
  return [...new Set(needs || [])].slice(0, MAX_NEEDS).map(token => {
    const [kind, arg] = token.includes(':') ? token.split(':') : ['part', token];
    if (kind === 'cat') return { token, cat: arg, name: catalog.catNames[arg] || arg, parts: reach.filter(id => catalog.parts[id].cats.includes(arg)) };
    if (kind === 'mag') return { token, mag: Number(arg), name: `Magazine of ${arg}+ rounds`, parts: reach.filter(id => (catalog.parts[id].capacity || 0) >= Number(arg)) };
    return { token, name: (catalog.parts[token] || {}).name || token, parts: reach.includes(token) ? [token] : [] };
  });
}

// Pruning for requirements. can: the bits a slot's or part's subtree can still meet. must: the bits it
// dominates, i.e. every part meeting that requirement sits below it however it's mounted, so a way of
// it without the bit can never be completed (and if it isn't installed at all, nothing meets the bit
// either). Both hold in every place a part or slot is used, so pruning its memoised set is safe.
function needBits(catalog, weapon, meets, all) {
  const kids = new Map();            // node -> child nodes; nodes are 'w', 's<slot id>', 'p<part id>'
  const partNode = id => 'p' + id;
  const addPart = id => {
    const n = partNode(id);
    if (kids.has(n)) return;
    kids.set(n, catalog.parts[id].slots.map(s => 's' + s.id));
    for (const s of catalog.parts[id].slots) addSlot(s);
  };
  const addSlot = s => {
    const ids = s.allowed.filter(id => catalog.parts[id]);
    kids.set('s' + s.id, ids.map(partNode));
    for (const id of ids) addPart(id);
  };
  kids.set('w', weapon.slots.map(s => 's' + s.id));
  for (const s of weapon.slots) addSlot(s);
  const parents = new Map([...kids.keys()].map(n => [n, []]));
  for (const [n, cs] of kids) for (const c of cs) parents.get(c).push(n);
  // Dominators (iterative; null = every node), then can as a fixed point (mods can nest in cycles).
  const dom = new Map([...kids.keys()].map(n => [n, null]));
  dom.set('w', new Set(['w']));
  for (let changed = true; changed;) {
    changed = false;
    for (const n of kids.keys()) {
      if (n === 'w') continue;
      let d = null;
      for (const p of parents.get(n)) {
        const dp = dom.get(p);
        if (!dp) continue;
        d = d ? new Set([...d].filter(x => dp.has(x))) : new Set(dp);
      }
      if (!d) continue;
      d.add(n);
      const old = dom.get(n);
      if (!old || old.size !== d.size) { dom.set(n, d); changed = true; }
    }
  }
  const can = new Map([...kids.keys()].map(n => [n, n[0] === 'p' ? meets.get(n.slice(1)) || 0 : 0]));
  for (let changed = true; changed;) {
    changed = false;
    for (const [n, cs] of kids) {
      let b = can.get(n);
      for (const c of cs) b |= can.get(c);
      if (b !== can.get(n)) { can.set(n, b); changed = true; }
    }
  }
  const must = new Map();
  for (const [id, bits] of meets) {
    for (let i = 0; 1 << i <= bits; i++) {
      if (!(bits & (1 << i))) continue;
      must.set('need' + i, [...(must.get('need' + i) || []), partNode(id)]);
    }
  }
  const mustOf = new Map();
  for (const [k, nodes] of must) {
    const bit = 1 << Number(k.slice(4));
    let common = null;
    for (const n of nodes) {
      const d = dom.get(n) || new Set();
      common = common ? new Set([...common].filter(x => d.has(x))) : new Set(d);
    }
    for (const n of common || []) mustOf.set(n, (mustOf.get(n) || 0) | bit);
  }
  // Pushed down the tree: a part must meet what every slot it can sit in must, and a slot must meet what its
  // part must but the part itself doesn't and no other slot of the part can.
  mustOf.set('w', all);
  const meetsOf = n => (n[0] === 'p' ? meets.get(n.slice(1)) || 0 : 0);
  for (let changed = true; changed;) {
    changed = false;
    for (const [n, cs] of kids) {
      let m = mustOf.get(n) || 0;
      if (n[0] === 'p') {
        const ps = parents.get(n);
        if (ps.length) m |= ps.reduce((b, p) => b & (mustOf.get(p) || 0), ~0);
      }
      if (m !== (mustOf.get(n) || 0)) { mustOf.set(n, m); changed = true; }
      const left = m & ~meetsOf(n);
      if (n[0] === 's' || !left) continue;
      for (const c of cs) {
        let only = left & can.get(c);
        for (const o of cs) if (o !== c) only &= ~can.get(o);
        const mc = (mustOf.get(c) || 0) | only;
        if (mc !== (mustOf.get(c) || 0)) { mustOf.set(c, mc); changed = true; }
      }
    }
  }
  return { can: n => can.get(n) || 0, must: n => mustOf.get(n) || 0 };
}

// Ways that lack a bit in need (the bits that can't be met anywhere else any more).
const prune = (set, need) => {
  if (!need) return set;
  const out = new Map();
  for (const [k, p] of set) if ((p.ways[0].has & need) === need) out.set(k, p);
  return out;
};

// Parts that conflict with another part that fits the same weapon get a bit each.
function conflictBits(catalog, weapon) {
  const reach = reachable(catalog, weapon);
  const bit = new Map();
  for (const id of reach) for (const c of catalog.parts[id].conflicts) {
    if (!reach.has(c)) continue;
    if (!bit.has(id)) bit.set(id, 1n << BigInt(bit.size));
    if (!bit.has(c)) bit.set(c, 1n << BigInt(bit.size));
  }
  const no = new Map();
  const rule = (x, y) => no.set(x, (no.get(x) || 0n) | bit.get(y));
  for (const id of bit.keys()) for (const c of catalog.parts[id].conflicts) if (bit.has(c)) { rule(id, c); rule(c, id); }
  return { bit, no };
}

function solve(catalog, weaponId, needTokens) {
  const weapon = catalog.weapons[weaponId];
  if (!weapon) throw new Error('unknown weapon');
  const started = Date.now();
  const { bit, no } = conflictBits(catalog, weapon);
  const needs = parseNeeds(catalog, weapon, needTokens);
  const meets = new Map();     // part id -> requirement bits it meets
  needs.forEach((n, i) => { for (const id of n.parts) meets.set(id, (meets.get(id) || 0) | (1 << i)); });
  const all = (1 << needs.length) - 1;
  const nb = needs.length ? needBits(catalog, weapon, meets, all) : { can: () => 0, must: () => 0 };
  const items = new Map();     // item id -> { part, stages: [set after 0..n of its slots], count }
  const slots = new Map();     // slot id -> { set, count }
  const busy = new Set();

  function itemSet(part, depth) {
    if (items.has(part.id)) return items.get(part.id);
    let set = new Map();
    addWay(set, { e: part.ergo || 0, r: part.recoil || 0, has: meets.get(part.id) || 0, fp: bit.get(part.id) || 0n, no: no.get(part.id) || 0n });
    const stages = [set];
    let count = 1n;
    busy.add(part.id);
    // Bits only this part's subtree can meet: once its remaining slots can't meet one, drop the ways without it.
    const node = depth === 0 ? 'w' : 'p' + part.id;
    const must = depth === 0 ? all : nb.must(node);
    const rest = part.slots.map((_, j) => part.slots.slice(j + 1).reduce((b, s) => b | nb.can('s' + s.id), 0));
    for (let j = 0; j < part.slots.length; j++) {
      const s = slotSet(part.slots[j], depth + 1);
      set = prune(sum(set, s.set), must & ~rest[j]);
      stages.push(set);
      count *= s.count;
    }
    busy.delete(part.id);
    const entry = { part, stages, count };
    items.set(part.id, entry);
    return entry;
  }

  function slotSet(slot, depth) {
    if (slots.has(slot.id)) return slots.get(slot.id);
    const set = new Map();
    let count = 0n;
    const options = depth > MAX_DEPTH ? [] : slot.allowed.map(id => catalog.parts[id]).filter(p => p && !busy.has(p.id));
    if (!slot.required || !options.length) { addWay(set, { e: 0, r: 0, has: 0, item: null, fp: 0n, no: 0n }); count += 1n; }
    for (const part of options) {
      const it = itemSet(part, depth);
      count += it.count;
      for (const [k, p] of it.stages[it.stages.length - 1]) {
        p.ways.forEach((w, i) => addWay(set, { e: w.e, r: w.r, has: w.has, item: part.id, k, i, fp: w.fp, no: w.no }));
      }
    }
    const entry = { set: prune(set, nb.must('s' + slot.id)), count };
    slots.set(slot.id, entry);
    return entry;
  }

  const root = itemSet({ ...weapon, ergo: 0, recoil: 0 }, 0);
  const final = prune(root.stages[root.stages.length - 1], all);
  const points = [];
  for (const [k, p] of final) {
    const w = p.ways[0];
    points.push([+(weapon.ergo + w.e).toFixed(1), Math.round(weapon.recoilV * (1 + w.r / 100)), k]);
  }
  return { weaponId, weapon, needs, items, slots, final, points, combinations: root.count, conflictParts: bit.size, ms: Date.now() - started };
}

// The build behind a point: follow the recorded ways back down the tree.
function rebuild(sol, key) {
  function item(id, k, i) {
    const it = sol.items.get(id);
    const children = new Array(it.part.slots.length);
    for (let s = it.part.slots.length; s >= 1; s--) {
      const way = it.stages[s].get(k).ways[i];
      children[s - 1] = slot(it.part.slots[s - 1], way.b, way.bi);
      k = way.a; i = way.ai;
    }
    return children;
  }
  function slot(sl, k, i) {
    const way = sol.slots.get(sl.id).set.get(k).ways[i];
    return { slot: sl, item: way.item, children: way.item ? item(way.item, way.k, way.i) : [] };
  }
  return sol.final.has(key) ? item(sol.weaponId, key, 0) : null;
}

// The build for a point, as sent to the browser: the slot tree with item details and the totals.
function describe(catalog, sol, key) {
  const tree = rebuild(sol, key);
  if (!tree) return null;
  const w = sol.weapon;
  let ergo = w.ergo, recoil = 0, weight = w.weight, price = w.price || 0, magazine = 0;
  const needed = new Set(sol.needs.flatMap(n => n.parts));
  const node = n => {
    const part = n.item && catalog.parts[n.item];
    if (part) { ergo += part.ergo; recoil += part.recoil; weight += part.weight; price += part.price || 0; magazine = Math.max(magazine, part.capacity || 0); }
    return {
      slot: n.slot.name, slotId: n.slot.nameId, required: n.slot.required,
      item: part ? { id: part.id, name: part.name, short: part.short, icon: part.icon, image: part.image, ergo: part.ergo, recoil: part.recoil, price: part.price, needed: needed.has(part.id) } : null,
      children: n.children.map(node),
    };
  };
  const slots = tree.map(node);
  return {
    weapon: { id: w.id, name: w.name, short: w.short, image: w.image, icon: w.icon, ergo: w.ergo, recoilV: w.recoilV, recoilH: w.recoilH },
    slots,
    totals: {
      ergo: +ergo.toFixed(1), recoilPct: +recoil.toFixed(1),
      recoilV: Math.round(w.recoilV * (1 + recoil / 100)), recoilH: Math.round(w.recoilH * (1 + recoil / 100)),
      weight: +weight.toFixed(2), price: Math.round(price), magazine,
    },
  };
}

// Total weight of the build behind a point (quests limit it, and it isn't one of the solved dimensions).
function weightOf(catalog, sol, key) {
  let kg = sol.weapon.weight;
  const walk = ns => ns.forEach(n => { if (n.item) { kg += catalog.parts[n.item].weight; walk(n.children); } });
  walk(rebuild(sol, key));
  return +kg.toFixed(2);
}

// What the browser gets for a solved weapon: every reachable point as [ergo, vertical recoil, key, weight kg].
function summary(catalog, sol) {
  const w = sol.weapon;
  return {
    weapon: { id: w.id, name: w.name, short: w.short, image: w.image, icon: w.icon, cls: w.cls, caliber: w.caliber, ergo: w.ergo, recoilV: w.recoilV, recoilH: w.recoilH },
    points: sol.points.map(p => [...p, weightOf(catalog, sol, p[2])]), combinations: String(sol.combinations), conflictParts: sol.conflictParts, ms: sol.ms,
    ergoStep: ERGO_STEP, recoilStep: RECOIL_STEP,
    needs: sol.needs.map(n => ({ token: n.token, cat: n.cat, mag: n.mag, name: n.name, parts: n.parts.length })),
  };
}

// The parts that fit a weapon, for picking required ones in the browser (no solving needed).
function partsFor(catalog, weaponId) {
  const weapon = catalog.weapons[weaponId];
  if (!weapon) throw new Error('unknown weapon');
  const parts = [...reachable(catalog, weapon)].map(id => catalog.parts[id])
    .map(p => ({ id: p.id, name: p.name, short: p.short, icon: p.icon, ergo: p.ergo, recoil: p.recoil, suppressor: p.cats.includes(SUPPRESSOR) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { weapon: weaponId, parts, suppressor: SUPPRESSOR };
}

// ---------- solving runs in a worker thread so the server stays responsive ----------
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const KEEP_SOLVED = 4;

if (!isMainThread && workerData && workerData.gunsmithWorker) {
  const fs = require('fs');
  const catalogs = new Map();   // catalogue file -> { mtime, catalog }
  const solved = new Map();     // file|weapon -> solution, most recent last
  const catalogOf = file => {
    const mtime = fs.statSync(file).mtimeMs;
    const c = catalogs.get(file);
    if (c && c.mtime === mtime) return c.catalog;
    for (const k of [...solved.keys()]) if (k.startsWith(file + '|')) solved.delete(k);
    const catalog = JSON.parse(fs.readFileSync(file, 'utf8')).catalog;
    catalogs.set(file, { mtime, catalog });
    return catalog;
  };
  const solutionOf = (file, catalog, weapon, needs) => {
    const k = file + '|' + weapon + '|' + needs.join(',');
    let sol = solved.get(k);
    if (sol) solved.delete(k);
    else sol = solve(catalog, weapon, needs);
    solved.set(k, sol);
    while (solved.size > KEEP_SOLVED) solved.delete(solved.keys().next().value);
    return sol;
  };
  parentPort.on('message', ({ id, op, file, weapon, key, needs = [] }) => {
    try {
      const catalog = catalogOf(file);
      if (op === 'parts') { parentPort.postMessage({ id, result: partsFor(catalog, weapon) }); return; }
      const sol = solutionOf(file, catalog, weapon, needs);
      parentPort.postMessage({ id, result: op === 'solve' ? summary(catalog, sol) : describe(catalog, sol, Number(key)) });
    } catch (e) {
      parentPort.postMessage({ id, error: e.message });
    }
  });
}

let worker = null;
let nextJob = 0;
const jobs = new Map();
// Run { op: 'solve' | 'build' | 'parts', file, weapon, key, needs } in the worker; resolves with its result.
function inWorker(msg) {
  if (!worker) {
    worker = new Worker(__filename, { workerData: { gunsmithWorker: true } });
    worker.on('message', ({ id, result, error }) => {
      const job = jobs.get(id);
      jobs.delete(id);
      if (job) error ? job.reject(new Error(error)) : job.resolve(result);
    });
    const fail = e => {
      for (const job of jobs.values()) job.reject(e instanceof Error ? e : new Error('gunsmith worker stopped'));
      jobs.clear();
      worker = null;
    };
    worker.on('error', fail);
    worker.on('exit', fail);
    worker.unref();
  }
  return new Promise((resolve, reject) => {
    const id = ++nextJob;
    jobs.set(id, { resolve, reject });
    worker.postMessage({ id, ...msg });
  });
}

module.exports = { buildCatalog, solve, describe, summary, partsFor, inWorker, ERGO_STEP, RECOIL_STEP, SUPPRESSOR, MAX_NEEDS };
