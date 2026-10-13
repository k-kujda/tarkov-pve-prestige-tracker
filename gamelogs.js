'use strict';
// Reads quest progress from Escape from Tarkov's own log files (read-only).
// The game logs every quest start / fail / finish as a chat notification in push-notifications_*.log,
// and the session mode (Pve / Regular) in application_*.log — the same data TarkovMonitor uses.
// Only quest ids and timestamps are extracted; nothing else from the logs leaves this module.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MODE_NAMES = { pve: 'Pve', regular: 'Regular' };
const STATUS_BY_TYPE = { 10: 'active', 11: 'failed', 12: 'done' };
// A prestige or wipe shows up as many already-finished quests being started again in a short window.
const RESET_MIN_RESTARTS = 5;
const RESET_WINDOW_MS = 30 * 60 * 1000;

const STEAM_APP_ID = '3932890';

function regValue(key, name) {
  try {
    const out = execFileSync('reg', ['query', key, '/v', name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(new RegExp(`${name}\\s+REG_(?:EXPAND_)?SZ\\s+(.+)`));
    return m ? m[1].trim() : null;
  } catch (e) {
    return null; // key or value not present
  }
}

// Tarkov folders inside a Steam install: every library from libraryfolders.vdf that has the app manifest.
function steamInstalls(root) {
  const libraries = new Set([root]);
  try {
    const vdf = fs.readFileSync(path.join(root, 'steamapps', 'libraryfolders.vdf'), 'utf8');
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/gi)) libraries.add(path.normalize(m[1].replace(/\\\\/g, '\\')));
  } catch (e) { /* no library file */ }
  const out = [];
  for (const lib of libraries) {
    try {
      const acf = fs.readFileSync(path.join(lib, 'steamapps', `appmanifest_${STEAM_APP_ID}.acf`), 'utf8');
      const dir = (acf.match(/"installdir"\s+"([^"]+)"/i) || [])[1];
      if (dir) out.push(path.join(lib, 'steamapps', 'common', dir));
    } catch (e) { /* not installed in this library */ }
  }
  return out;
}

// Game install folders: launcher / Steam uninstall entries, then Steam libraries, then default folders on every drive.
function installCandidates() {
  const installs = [];
  if (process.platform !== 'win32') return installs;
  for (const hive of ['HKCU', 'HKLM']) {
    for (const node of ['SOFTWARE\\WOW6432Node', 'SOFTWARE']) {
      for (const app of ['EscapeFromTarkov', `Steam App ${STEAM_APP_ID}`]) {
        const loc = regValue(`${hive}\\${node}\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${app}`, 'InstallLocation');
        if (loc) installs.push(loc);
      }
    }
  }
  const steamRoots = new Set();
  for (const [key, name] of [['HKCU\\SOFTWARE\\Valve\\Steam', 'SteamPath'], ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'], ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath']]) {
    const p = regValue(key, name);
    if (p) steamRoots.add(path.normalize(p));
  }
  for (const root of steamRoots) installs.push(...steamInstalls(root));
  for (const drive of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    for (const dir of ['Battlestate Games\\EFT', 'Battlestate Games\\Escape from Tarkov', 'Games\\Battlestate Games\\EFT']) installs.push(`${drive}:\\${dir}`);
  }
  return installs;
}

const newestLogFolder = logsPath => {
  try {
    return Math.max(0, ...fs.readdirSync(logsPath).filter(n => n.startsWith('log_')).map(folderTime));
  } catch (e) {
    return -1;
  }
};

let foundLogs = { at: 0, path: null };
const FIND_CACHE_MS = 10 * 60 * 1000;

function findLogsFolder() {
  if (process.env.TARKOV_LOGS) return process.env.TARKOV_LOGS;
  if (foundLogs.path && Date.now() - foundLogs.at < FIND_CACHE_MS) return foundLogs.path;
  const found = [...new Set(installCandidates().flatMap(dir => [path.join(dir, 'Logs'), path.join(dir, 'build', 'Logs')]))]
    .filter(p => fs.existsSync(p));
  // Several installs (old launcher copy + Steam, say): use the one that was played most recently.
  found.sort((a, b) => newestLogFolder(b) - newestLogFolder(a));
  foundLogs = { at: Date.now(), path: found[0] || null };
  return foundLogs.path;
}

const folderTime = name => {
  const m = name.match(/log_(\d+)\.(\d+)\.(\d+)_(\d+)-(\d+)-(\d+)/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : 0;
};

const parsedFolders = new Map(); // folder -> { signature, modes, events }

function parseFolder(dir) {
  const files = fs.readdirSync(dir);
  const relevant = files.filter(n => /(application|notifications)(_\d+)?\.log$/.test(n));
  const signature = relevant.map(n => `${n}:${fs.statSync(path.join(dir, n)).size}`).join('|');
  const cached = parsedFolders.get(dir);
  if (cached && cached.signature === signature) return cached;

  const read = re => relevant.filter(n => re.test(n)).map(n => fs.readFileSync(path.join(dir, n), 'utf8')).join('\n');
  const modes = [...read(/application(_\d+)?\.log$/).matchAll(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\|[^\n]*?Session mode: (\w+)/gm)]
    .map(m => ({ at: m[1], mode: m[2] }));
  const events = [];
  for (const m of read(/notifications(_\d+)?\.log$/).matchAll(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3})\|[^\n]*\n(\{[\s\S]+?^\})/gm)) {
    // Cheap pre-filter before JSON.parse: quest status messages are types 10-12.
    if (!/"type": 1[012],/.test(m[2])) continue;
    let msg;
    try { msg = (JSON.parse(m[2]).message) || {}; } catch (e) { continue; }
    if (!STATUS_BY_TYPE[msg.type] || typeof msg.templateId !== 'string') continue;
    const questId = msg.templateId.split(' ')[0];
    const mode = (modes.filter(x => x.at <= m[1]).pop() || modes[0] || {}).mode || null;
    events.push({ at: m[1], questId, status: STATUS_BY_TYPE[msg.type], mode });
  }
  const entry = { signature, events };
  parsedFolders.set(dir, entry);
  return entry;
}

function readProgress(mode) {
  const logsPath = findLogsFolder();
  if (!logsPath) throw new Error('Could not find the Escape from Tarkov Logs folder. Set the TARKOV_LOGS environment variable to its path.');
  const folders = fs.readdirSync(logsPath).filter(n => n.startsWith('log_')).sort((a, b) => folderTime(a) - folderTime(b));
  const wanted = MODE_NAMES[mode] || 'Pve';
  const events = folders.flatMap(f => parseFolder(path.join(logsPath, f)).events).filter(e => e.mode === wanted);
  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  // Find resets (prestige / wipe) and keep only the current run.
  const resets = [];
  let finished = new Set();
  let restarts = [];
  for (const e of events) {
    if (e.status === 'done') finished.add(e.questId);
    if (e.status !== 'active' || !finished.has(e.questId)) continue;
    const t = Date.parse(e.at.replace(' ', 'T'));
    restarts = restarts.filter(r => t - r < RESET_WINDOW_MS).concat(t);
    if (restarts.length >= RESET_MIN_RESTARTS) {
      const start = events.find(x => Date.parse(x.at.replace(' ', 'T')) >= restarts[0] && x.status === 'active' && finished.has(x.questId));
      resets.push(start.at);
      finished = new Set();
      restarts = [];
    }
  }
  const since = resets.length ? resets[resets.length - 1] : null;
  const quests = {};
  for (const e of events) if (!since || e.at >= since) quests[e.questId] = e.status;

  return {
    logsPath, mode: wanted, folders: folders.length, events: events.length,
    firstEventAt: events.length ? events[0].at : null, lastEventAt: events.length ? events[events.length - 1].at : null,
    resets, since, quests,
  };
}

module.exports = { readProgress, findLogsFolder, steamInstalls };
