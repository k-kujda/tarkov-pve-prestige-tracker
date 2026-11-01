// End-to-end check of the Gunsmith tab's Flashlight / Laser toggles, magazine size and part exclusions in a real
// browser (headless Edge/Chrome via puppeteer-core): ticks Flashlight + Laser, picks a magazine size, excludes a
// part from the build (✕) and one from the part search, checks the builds and the saved list, then restores all.
// Usage: PUPPETEER_DIR=<dir with puppeteer-core> node tools/ui_gunsmith_exclude_test.mjs [weapon search] [--port 4747]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(process.env.PUPPETEER_DIR || ROOT, 'x.js'));
const puppeteer = require('puppeteer-core');
const opt = n => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : undefined; };
const search = process.argv.slice(2).find(a => !a.startsWith('--') && !/^\d+$/.test(a)) || 'MP5';
const port = opt('port') || '4747';
const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(f => fs.existsSync(f));
const outDir = path.join(ROOT, 'cache', 'ui-test');
fs.mkdirSync(outDir, { recursive: true });
const url = `http://127.0.0.1:${port}/`;
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--window-size=1500,1000'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1000 });
  page.on('pageerror', e => { console.log('[pageerror]', e.message); failed++; });
  page.on('response', r => { if (r.status() >= 400 && !r.url().endsWith('favicon.ico')) console.log('[http]', r.status(), r.url().slice(0, 160)); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('tpt-state-v1', JSON.stringify({ level: 40, faction: 'USEC', mode: 'pve', focus: 'all', prestige: 0, ui: { sideOpen: false, tab: 'next', setupStep: 99 } })));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('#tabs button[data-tab="gunsmith"]');
  await page.click('#tabs button[data-tab="gunsmith"]');
  await page.waitForSelector('.gs-weapon', { timeout: 120000 });
  await page.type('#search', search);
  await page.waitForFunction(() => document.querySelectorAll('.gs-weapon').length > 0);
  await page.click('.gs-weapon');
  const solved = () => page.waitForFunction(() => GS.sol && GS.sol.solveKey === gsSolveKey() && GS.solving == null && GS.parts && (!GS.sol.points.length || (GS.build && GS.building == null)),
    { timeout: 240000, polling: 250 });
  await solved();
  // The parts of the shown build, with their flags from the parts list
  const buildParts = () => page.evaluate(() => {
    const out = [];
    const walk = ns => ns.forEach(n => { if (n.item) { out.push({ ...GS.parts.find(p => p.id === n.item.id), id: n.item.id }); walk(n.children); } });
    walk(GS.build.slots);
    return out;
  });
  const name = await page.evaluate(() => GS.sol.weapon.name);
  const all = await page.evaluate(() => GS.sol.points.length);
  console.log(name, all, 'builds');

  // 1. Flashlight + laser
  await page.click('#gsLight');
  await solved();
  await page.click('#gsLaser');
  await solved();
  let parts = await buildParts();
  const ll = await page.evaluate(() => ({ points: GS.sol.points.length, needs: GS.sol.needs.map(n => n.name) }));
  check(parts.some(p => p.light) && parts.some(p => p.laser), `flashlight + laser: ${ll.points} builds; this one has ${parts.filter(p => p.light || p.laser).map(p => p.name).join(' + ')}`);

  // 2. Magazine size: the smallest size that isn't the build's current one
  const sizes = await page.$$eval('#gsMag option', os => os.map(o => o.value).filter(Boolean));
  const size = sizes[0];
  await page.select('#gsMag', size);
  await solved();
  const mag = await page.evaluate(() => GS.build.totals.magazine);
  check(sizes.length > 0 && mag === Number(size.slice(4)), `magazine sizes ${sizes.map(s => s.slice(4)).join('/')}; picked ${size.slice(4)}, build has ${mag}`);

  // 3. Exclude the build's light (✕ on its slot, shown on hover)
  parts = await buildParts();
  const light = parts.find(p => p.light);
  const slot = await page.$(`.gs-slot .gs-x[data-id="${light.id}"]`);
  await page.hover(`.gs-slot:has(.gs-x[data-id="${light.id}"])`);
  await slot.click();
  await solved();
  parts = await buildParts();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('tpt-state-v1')).gsExcluded);
  const chip = await page.$(`.chip.ex[data-id="${light.id}"]`);
  const after = await page.evaluate(() => GS.sol.points.length);
  check(!parts.some(p => p.id === light.id) && parts.some(p => p.light) && saved.includes(light.id) && !!chip,
    `excluded ${light.name}: ${after} builds, now ${parts.filter(p => p.light).map(p => p.name).join(', ')}, saved and listed`);

  // 4. Exclude from the part search (its Exclude button, not the row's "require")
  const other = await page.evaluate(id => GS.parts.find(p => p.light && p.id !== id && !JSON.parse(localStorage.getItem('tpt-state-v1')).gsExcluded.includes(p.id)), light.id);
  if (other) {
    await page.type('#gsPartSearch', other.name.slice(0, 12));
    await page.waitForSelector(`.gs-part [data-act="gsExclude"][data-id="${other.id}"]`, { timeout: 10000 });
    await page.click(`.gs-part [data-act="gsExclude"][data-id="${other.id}"]`);
    await solved();
    const st = await page.evaluate(id => ({ ex: S.gsExcluded.includes(id), needed: S.ui.gsNeeds.includes(id) }), other.id);
    check(st.ex && !st.needed, `Exclude in the part search excluded ${other.name} (and didn't require it)`);
  }
  await page.screenshot({ path: path.join(outDir, 'gunsmith-exclude-page.png'), fullPage: true });

  // 5. Restore all
  await page.click('[data-act="gsUnexcludeAll"]');
  await solved();
  const restored = await page.evaluate(() => ({ ex: S.gsExcluded.length, chips: document.querySelectorAll('.chip.ex').length, points: GS.sol.points.length }));
  check(restored.ex === 0 && restored.chips === 0, `restore all: ${restored.points} builds, nothing excluded`);
  console.log('screenshots in', outDir);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
