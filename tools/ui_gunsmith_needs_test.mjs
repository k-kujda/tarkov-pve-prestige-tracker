// End-to-end check of the Gunsmith tab's requirements in a real browser (headless Edge/Chrome via puppeteer-core):
// picks a Gunsmith quest (weapon, required parts and limits), checks the "Meets quest" build passes the limits and
// outlines every required part, then clears it, ticks Suppressed and adds a part through the part search.
// Usage: PUPPETEER_DIR=<dir with puppeteer-core> node tools/ui_gunsmith_needs_test.mjs ["quest name"] [--port 4747]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(process.env.PUPPETEER_DIR || ROOT, 'x.js'));
const puppeteer = require('puppeteer-core');
const opt = n => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : undefined; };
const questName = process.argv.slice(2).find(a => !a.startsWith('--') && !/^\d+$/.test(a)) || 'Gunsmith - HK MP5';
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
  page.on('response', r => { if (r.status() >= 400) console.log('[http]', r.status(), r.url().slice(0, 160)); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('tpt-state-v1', JSON.stringify({ level: 40, faction: 'USEC', mode: 'pve', focus: 'all', prestige: 0, ui: { sideOpen: false, tab: 'next', setupStep: 99 } })));
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('#tabs button[data-tab="gunsmith"]');
  await page.click('#tabs button[data-tab="gunsmith"]');
  await page.waitForSelector('.gs-weapon', { timeout: 120000 });
  // Any weapon first, so the requirements panel (with the quest picker) is shown
  await page.click('.gs-weapon');
  await page.waitForSelector('#gsQuest', { timeout: 60000 });
  const solved = () => page.waitForFunction(() => GS.sol && GS.sol.solveKey === gsSolveKey() && GS.solving == null && (!GS.sol.points.length || (GS.build && GS.building == null)),
    { timeout: 180000, polling: 250 });

  // 1. A Gunsmith quest: weapon, required parts and limits
  const value = await page.$$eval('#gsQuest option', (os, name) => (os.find(o => o.textContent.includes(name)) || {}).value, questName);
  check(!!value, `quest "${questName}" is in the picker`);
  await page.select('#gsQuest', value);
  await solved();
  const q = await page.evaluate(() => {
    const lim = gsQuestLimits(GS.sol.weapon);
    return {
      weapon: GS.sol.weapon.name, needs: S.ui.gsNeeds, solvedNeeds: GS.sol.needs.map(n => `${n.name} (${n.parts})`), points: GS.sol.points.length,
      meets: GS.sol.points.filter(p => gsMeets(lim, p)).length, picked: S.ui.gsKey === (gsQuestPick(GS.sol, lim) || [])[2],
      checks: [...document.querySelectorAll('.gs-checks .badge')].map(b => b.textContent.trim()),
      outlined: document.querySelectorAll('.gs-slot.need').length, chips: document.querySelectorAll('.gs-needs .chip.on').length,
    };
  });
  console.log(JSON.stringify(q, null, 1));
  check(q.points > 0 && q.meets > 0, `${q.weapon}: ${q.points} builds, ${q.meets} meet the limits`);
  check(q.picked, 'the "Meets quest" build is selected');
  check(q.chips === q.needs.length, `${q.chips} requirement chips`);
  check(q.outlined >= q.needs.length, `${q.outlined} required parts outlined`);
  check(q.checks.length > 0 && q.checks.every(c => c.endsWith('✓')), `limit checks: ${q.checks.join(' | ')}`);
  await (await page.$('.gs-plot-wrap')).screenshot({ path: path.join(outDir, 'gunsmith-quest-plot.png') });
  await (await page.$('.gs-build')).screenshot({ path: path.join(outDir, 'gunsmith-quest-build.png') });

  // 2. Clear, then Suppressed only
  await page.click('[data-act="gsNeedClear"]');
  await solved();
  const all = await page.evaluate(() => GS.sol.points.length);
  await page.click('#gsSuppressed');
  await solved();
  const sup = await page.evaluate(() => ({ points: GS.sol.points.length, needs: GS.sol.needs.map(n => n.name), outlined: document.querySelectorAll('.gs-slot.need .gs-item').length }));
  check(sup.points > 0 && sup.points <= all && sup.needs[0] === 'Silencer' && sup.outlined === 1, `suppressed: ${sup.points} of ${all} builds, ${sup.outlined} suppressor outlined`);

  // 3. A part through the search: the first non-suppressor part that fits
  const part = await page.evaluate(() => GS.parts.find(p => !p.suppressor && p.ergo > 0));
  await page.type('#gsPartSearch', part.name.slice(0, 14));
  await page.waitForSelector(`.gs-part[data-id="${part.id}"]`, { timeout: 10000 });
  check(await page.evaluate(() => document.activeElement && document.activeElement.id === 'gsPartSearch'), 'the part search keeps focus while typing');
  await page.click(`.gs-part[data-id="${part.id}"]`);
  await solved();
  const withPart = await page.evaluate(id => ({ needs: S.ui.gsNeeds.length, points: GS.sol.points.length, has: !!document.querySelector(`.gs-slot.need`) && JSON.stringify(GS.build).includes(id) }), part.id);
  check(withPart.needs === 2 && withPart.has, `required "${part.name}" + suppressor: ${withPart.points} builds, the build has it`);
  await page.screenshot({ path: path.join(outDir, 'gunsmith-needs-page.png'), fullPage: true });
  console.log('screenshots in', outDir);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
