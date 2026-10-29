// End-to-end check of the Gunsmith tab in a real browser (headless Edge/Chrome via puppeteer-core): searches a
// weapon, picks it, waits for the solver, clicks a point on the best-trade-off line, waits for the build screen,
// saves screenshots and prints the build's stats.
// Usage: PUPPETEER_DIR=<dir with puppeteer-core> node tools/ui_gunsmith_test.mjs [search] [--port 4747] [--front 0..1]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(process.env.PUPPETEER_DIR || ROOT, 'x.js'));
const puppeteer = require('puppeteer-core');
const opt = n => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : undefined; };
const search = process.argv.slice(2).find(a => !a.startsWith('--') && !/^\d/.test(a)) || 'M4A1';
const port = opt('port') || '4747';
const front = Number(opt('front') || '0.5');   // where on the best-trade-off line to click (0 = least recoil)
const exe = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(f => fs.existsSync(f));
const outDir = path.join(ROOT, 'cache', 'ui-test');
fs.mkdirSync(outDir, { recursive: true });
const url = `http://127.0.0.1:${port}/`;

const browser = await puppeteer.launch({ executablePath: exe, headless: 'new', args: ['--window-size=1500,1000'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1000 });
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  page.on('response', r => { if (r.status() >= 400) console.log('[http]', r.status(), r.url().slice(0, 160)); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('tpt-state-v1', JSON.stringify({ level: 40, faction: 'USEC', mode: 'pve', focus: 'all', prestige: 0, ui: { sideOpen: false, tab: 'next', setupStep: 99 } })));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('#tabs button[data-tab="gunsmith"]');
  await page.click('#tabs button[data-tab="gunsmith"]');
  await page.waitForSelector('.gs-weapon', { timeout: 120000 });
  await page.type('#search', search);
  await page.waitForFunction(() => document.querySelectorAll('.gs-weapon').length > 0);
  const name = await page.$eval('.gs-weapon', el => el.getAttribute('title'));
  console.log('picking', name);
  await page.click('.gs-weapon');
  const t0 = Date.now();
  await page.waitForFunction(() => typeof GS !== "undefined" && GS.sol && document.getElementById('gsPlot'), { timeout: 180000, polling: 250 });
  console.log(`solved in ${((Date.now() - t0) / 1000).toFixed(1)} s:`, await page.evaluate(() => `${GS.sol.points.length} points, ${GS.sol.front.length} on the best-trade-off line, ergo ${GS.sol.range.e0}..${GS.sol.range.e1}, recoil ${GS.sol.range.r0}..${GS.sol.range.r1}`));
  await page.waitForSelector('.gs-tree', { timeout: 60000 });
  // Click a point on the line with a real mouse click on the canvas.
  const target = await page.evaluate(f => {
    const p = GS.sol.front[Math.round(f * (GS.sol.front.length - 1))];
    const r = document.getElementById('gsPlot').getBoundingClientRect();
    const [x, y] = GS.toPixel(p);
    return { x: r.left + x, y: r.top + y, p };
  }, front);
  await page.mouse.move(target.x, target.y);
  await new Promise(r => setTimeout(r, 300));
  const plot = await page.$('.gs-plot-wrap');
  await plot.screenshot({ path: path.join(outDir, 'gunsmith-plot.png') });
  await page.mouse.click(target.x, target.y);
  await page.waitForFunction(k => GS.build && S.ui.gsKey === k && GS.building == null, { timeout: 60000 }, target.p[2]);
  await new Promise(r => setTimeout(r, 800)); // images
  const build = await page.$('.gs-build');
  await build.screenshot({ path: path.join(outDir, 'gunsmith-build.png') });
  await page.screenshot({ path: path.join(outDir, 'gunsmith-page.png'), fullPage: true });
  const stats = await page.evaluate(() => ({ totals: GS.build.totals, parts: document.querySelectorAll('.gs-slot:not(.empty)').length }));
  console.log('clicked point', target.p.slice(0, 2), '-> build', JSON.stringify(stats));
  if (stats.totals.ergo !== target.p[0] || stats.totals.recoilV !== target.p[1]) console.log('MISMATCH between plotted point and build');
  console.log('screenshots in', outDir);
} finally {
  await browser.close();
}
