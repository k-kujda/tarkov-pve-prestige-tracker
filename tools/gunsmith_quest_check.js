// Solves every Gunsmith quest build (buildWeapon objectives: weapon, required parts and categories) and checks
// each returned build: it has every required part, no two of its parts conflict, and its stats match the point.
// Also reports whether the quest's ergonomics / recoil sum limits are reachable, and the best build's weight.
// Usage: node tools/gunsmith_quest_check.js [pve|regular] [quest name filter]
const G = require('../gunsmith');
const { getData } = require('../server');

const mode = process.argv[2] === 'regular' ? 'regular' : 'pve';
const filter = (process.argv[3] || '').toLowerCase();
const fetchJson = url => fetch(url).then(r => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); });

(async () => {
  const [items, en, { entry }] = await Promise.all([
    fetchJson(`https://json.tarkov.dev/${mode}/items`), fetchJson(`https://json.tarkov.dev/${mode}/items_en`), getData(mode),
  ]);
  const catalog = G.buildCatalog(items.data, en.data || {});
  let bad = 0;
  for (const t of entry.data.tasks) for (const o of t.objectives) {
    if (o.type !== 'buildWeapon' || (filter && !t.name.toLowerCase().includes(filter))) continue;
    const weapon = catalog.weapons[o.item.id];
    if (!weapon) { console.log(`${t.name}: ${o.item.name} isn't in the catalogue`); continue; }
    const limit = Object.fromEntries(o.buildAttributes.map(a => [a.name, a]));
    const needs = [...o.containsAll.map(i => i.id), ...o.containsCategory.map(c => 'cat:' + c.id)];
    if (limit.magazineCapacity && limit.magazineCapacity.compareMethod === '>=') needs.push('mag:' + limit.magazineCapacity.value);
    const sol = G.solve(catalog, weapon.id, needs);
    const sumOf = recoilV => recoilV * (weapon.recoilV + weapon.recoilH) / weapon.recoilV;
    let ok = 0, best = null, wrong = 0;
    for (const [e, r, key] of sol.points) {
      const b = G.describe(catalog, sol, key);
      const used = [];
      const walk = ns => ns.forEach(n => { if (n.item) { used.push(n.item.id); walk(n.children); } });
      walk(b.slots);
      const set = new Set(used);
      const missing = sol.needs.filter(n => !n.parts.some(id => set.has(id)));
      const clash = used.filter(id => catalog.parts[id].conflicts.some(c => c !== id && set.has(c)));
      const twice = used.filter((id, i) => used.indexOf(id) !== i && catalog.parts[id].conflicts.includes(id));
      if (missing.length || clash.length || twice.length || Math.abs(b.totals.ergo - e) >= 1 || Math.abs(b.totals.recoilV - r) > 1) {
        if (wrong++ < 3) console.log('  BAD build', e, r, { missing: missing.map(n => n.name), clash, twice });
        continue;
      }
      const meets = (!limit.ergonomics || e >= limit.ergonomics.value) && (!limit.recoil || sumOf(r) <= limit.recoil.value)
        && (!limit.magazineCapacity || limit.magazineCapacity.compareMethod !== '<=' || b.totals.magazine <= limit.magazineCapacity.value);
      if (meets) { ok++; if (!best || b.totals.weight < best.totals.weight) best = b; }
    }
    bad += wrong;
    const lim = ['ergonomics', 'recoil', 'weight', 'magazineCapacity'].filter(k => limit[k]).map(k => `${k} ${limit[k].compareMethod} ${limit[k].value}`).join(', ');
    console.log(`${t.name} (${weapon.short}, ${sol.needs.length} required): ${sol.points.length} points in ${sol.ms} ms, ${wrong} bad; ${ok} meet ${lim || 'no limits'}` +
      (best ? `; lightest ${best.totals.weight} kg, magazine ${best.totals.magazine}` : ''));
  }
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
