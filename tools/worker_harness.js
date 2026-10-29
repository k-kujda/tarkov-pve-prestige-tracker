// Run nav-worker.js in Node (fetch/importScripts stubbed to the local files) to time route requests like the page does.
// Usage: node tools/worker_harness.js map nQuests spawnIndex
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { data } = require('./nav_util');
const ROOT = path.join(__dirname, '..');
const [key = 'lighthouse', nq = '8', si = '7'] = process.argv.slice(2);

const ctx = { console, Math, ArrayBuffer, Uint16Array, Float64Array, Float32Array, Uint32Array, Int32Array, Uint8Array, Map, Set, JSON, Promise, Error, Array, Object, Number, String, Infinity, isFinite };
ctx.self = ctx;
ctx.importScripts = f => vm.runInContext(fs.readFileSync(path.join(ROOT, f.replace(/^\//, '')), 'utf8'), ctx);
ctx.fetch = async url => {
  const u = new URL(url, 'http://x');
  const file = path.join(ROOT, 'navmesh', u.searchParams.get('map') + (u.searchParams.get('meta') ? '.json' : '.bin'));
  const buf = fs.readFileSync(file);
  return { ok: true, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), json: async () => JSON.parse(buf) };
};
let reply;
ctx.postMessage = msg => reply(msg);
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'nav-worker.js'), 'utf8'), ctx);
const call = (type, payload) => new Promise(res => { reply = res; ctx.onmessage({ data: { id: 1, type, ...payload } }); });

(async () => {
  const D = data();
  const quests = D.tasks.filter(t => t.objectives.some(o => !o.optional && (o.points || []).some(p => p.map === key)));
  const pick = [];
  for (let i = 0; i < quests.length && pick.length < +nq; i += Math.max(1, Math.floor(quests.length / +nq))) pick.push(quests[i]);
  const pts = [D.mapFeatures[key].spawns[+si]];
  for (const t of pick) for (const o of t.objectives) if (!o.optional) for (const p of (o.points || []).filter(p => p.map === key)) pts.push(p);
  for (const e of D.mapFeatures[key].extracts.filter(e => e.faction === 'pmc')) pts.push(e);
  console.log(`${key}: ${pts.length} points`);
  let t0 = Date.now();
  const L = await call('load', { map: key });
  console.log(`load ${Date.now() - t0} ms`, L.error || '');
  t0 = Date.now();
  const r = await call('matrix', { map: key, points: pts.map(p => ({ x: p.x, y: p.y, z: p.z })), keys: [], hazards: null, rows: [0, 1, 2, 3, 4] });
  console.log(`matrix 5 rows ${Date.now() - t0} ms`, r.error || '', `=> ~${((Date.now() - t0) / 5 * pts.length / 4 / 1000).toFixed(1)} s for all rows on 4 workers`);
})();

// Full request like the page: hazards + bounds, all rows, then paths through the points in order.
(async () => {
  await new Promise(r => setTimeout(r, 4000));
  const D = data(), f = D.mapFeatures[key];
  const zones = type => f.hazards.filter(h => h.type === type && h.outline && h.outline.length > 2).map(h => h.outline);
  const bd = D.mapDefs[key].bounds;
  const hazards = { mines: zones('minefield'), snipers: zones('sniper'), bounds: [Math.min(bd[0][0], bd[1][0]), Math.min(bd[0][1], bd[1][1]), Math.max(bd[0][0], bd[1][0]), Math.max(bd[0][1], bd[1][1])] };
  const quests = D.tasks.filter(t => t.objectives.some(o => !o.optional && (o.points || []).some(p => p.map === key)));
  const pick = [];
  for (let i = 0; i < quests.length && pick.length < +nq; i += Math.max(1, Math.floor(quests.length / +nq))) pick.push(quests[i]);
  const pts = [f.spawns[+si]];
  for (const t of pick) for (const o of t.objectives) if (!o.optional) for (const p of (o.points || []).filter(p => p.map === key)) pts.push(p);
  for (const e of f.extracts.filter(e => e.faction === 'pmc')) pts.push(e);
  let t0 = Date.now();
  const r = await call('matrix', { map: key, points: pts.map(p => ({ x: p.x, y: p.y, z: p.z })), keys: [], hazards });
  console.log(`full matrix ${pts.length}x${pts.length} with hazards: ${Date.now() - t0} ms ${r.error || ''}; unreachable entries ${[...r.dist].filter(v => !isFinite(v)).length}`);
  t0 = Date.now();
  const p = await call('paths', { map: key, points: pts.map(p => ({ x: p.x, y: p.y, z: p.z })), keys: [], hazards });
  console.log(`paths for ${pts.length - 1} legs: ${Date.now() - t0} ms ${p.error || ''}; null legs ${p.legs ? p.legs.filter(l => !l).length : '?'}`);
})();
