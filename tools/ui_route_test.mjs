// End-to-end check of the raid planner in a real browser (headless Edge/Chrome via puppeteer-core): sets up a raid on
// a map with several quests, waits for the walking route, saves a screenshot and prints the route panel.
// Usage: PUPPETEER_DIR=<dir with puppeteer-core> node tools/ui_route_test.mjs <map> [nQuests] [spawnIndex] [floor]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(process.env.PUPPETEER_DIR || ROOT, 'x.js'));
const puppeteer = require('puppeteer-core');
const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const opt = n => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : undefined; };
const [map = 'customs', nq = '5', si = '0'] = args;
const floor = opt('floor'), step = opt('step'), zoom = opt('zoom'), questIds = opt('quests'), extract = opt('extract'), center = opt('center');
const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(f => fs.existsSync(f));
const cacheFile = fs.readdirSync(path.join(ROOT, 'cache')).filter(f => /^pve-v\d+\.json$/.test(f)).sort((a, b) => parseInt(b.slice(5)) - parseInt(a.slice(5)))[0];
const D = JSON.parse(fs.readFileSync(path.join(ROOT, 'cache', cacheFile), 'utf8')).data;
// Quests with fixed objective spots on this map, spread over the map.
const quests = D.tasks.filter(t => t.objectives.some(o => !o.optional && (o.points || []).some(p => p.map === map)));
const pick = [];
for (let i = 0; i < quests.length && pick.length < +nq; i += Math.max(1, Math.floor(quests.length / +nq))) pick.push(quests[i].id);
if (questIds) pick.splice(0, pick.length, ...questIds.split(','));
const sp = D.mapFeatures[map].spawns[+si];
const state = {
  level: 40, faction: 'USEC', mode: 'pve', focus: 'all', prestige: 0, tasks: {}, objs: {}, have: {},
  raid: { map, quests: pick, startedAt: new Date().toISOString(), spawn: { x: sp.x, y: sp.y, z: sp.z }, extract: extract || 'auto' },
  ui: { sideOpen: false, tab: 'raid', setupStep: 99, mapLayers: {} },
};
const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--window-size=1600,1100'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1100 });
  page.on('console', m => { if (/error|warn|fail/i.test(m.type() + m.text()) && !/Tracking Prevention/.test(m.text())) console.log('[page]', m.type(), m.text()); });
  page.on('response', r => { if (r.status() >= 400) console.log('[http]', r.status(), r.url().slice(0, 160)); });
  page.on('workercreated', w => console.log('[worker created]'));
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto('http://127.0.0.1:4747/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(s => localStorage.setItem('tpt-state-v1', JSON.stringify(s)), state);
  await page.goto('http://127.0.0.1:4747/', { waitUntil: 'domcontentloaded', timeout: 120000 });
  const t0 = Date.now();
  await page.waitForFunction(() => /m walking ·/.test(document.body.innerText), { timeout: 180000, polling: 500 }).catch(() => console.log('walking route did not appear'));
  console.log(`walking route after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (step !== undefined) {
    await page.evaluate(i => { const el = document.querySelector(`.route-step[data-id="${i}"]`); if (el) el.click(); }, step);
    await new Promise(r => setTimeout(r, 1500));
  }
  if (center) { await page.waitForFunction(() => typeof raidMap !== "undefined" && raidMap, { timeout: 60000 }); await page.evaluate(c => { const [x, z, zz] = c.split(',').map(Number); raidMap.setView([z, x], zz); }, center); await new Promise(r => setTimeout(r, 2000)); }
  if (floor) {
    await page.evaluate(f => { const b = [...document.querySelectorAll('.floor-ctl button')].find(x => x.textContent.trim() === f || x.dataset.floor === f); if (b) b.click(); }, floor);
    await new Promise(r => setTimeout(r, 1500));
  }
  await new Promise(r => setTimeout(r, 2500)); // tiles
  const out = path.join(ROOT, 'navmesh', 'render', `ui-${map}${step !== undefined ? '-s' + step : ''}${floor ? '-' + floor.replace(/[^a-z0-9]+/gi, '_') : ''}.png`);
  const el = await page.$('#raidMapBox');
  if (el) await el.screenshot({ path: out }); else await page.screenshot({ path: out });
  const panel = await page.evaluate(() => { const h = [...document.querySelectorAll('.sec h4')].find(x => x.textContent === 'Route'); return h ? h.parentElement.innerText : '(no route panel)'; });
  console.log(panel.slice(0, 2500));
  console.log('screenshot', out);
} finally {
  await browser.close();
}
