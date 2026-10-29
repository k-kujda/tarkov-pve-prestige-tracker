// Load a map's navmesh + door metadata for command-line checks.
const fs = require('fs');
const path = require('path');
const N = require('../nav');
const ROOT = path.join(__dirname, '..');
function load(key, { lockedClosed = true } = {}) {
  const m = N.parse(fs.readFileSync(path.join(ROOT, 'navmesh', key + '.bin')));
  const metaFile = path.join(ROOT, 'navmesh', key + '.json');
  m.meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : { doors: [] };
  if (lockedClosed && m.door) N.setBlockedDoors(m, Uint8Array.from(m.meta.doors, d => (d.state === 1 ? 1 : 0)));
  return m;
}
function data() {
  const dir = path.join(ROOT, 'cache');
  const f = fs.readdirSync(dir).filter(f => /^pve-v\d+\.json$/.test(f)).sort((a, b) => parseInt(b.slice(5)) - parseInt(a.slice(5)))[0];
  return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).data;
}
module.exports = { N, load, data, ROOT };
