// Local meetings library — each processed meeting (summary, decisions, action
// items, transcript) is persisted to a JSON file in the per-user app-data dir.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const FILE = () => path.join(app.getPath('userData'), 'meetings.json');

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE(), 'utf8'));
  } catch {
    return [];
  }
}

function persist(list) {
  fs.writeFileSync(FILE(), JSON.stringify(list, null, 2), 'utf8');
}

function list() {
  return load();
}

function add(meeting) {
  const all = load();
  all.unshift(meeting); // newest first
  persist(all);
  return meeting;
}

function update(id, patch) {
  const all = load();
  const i = all.findIndex((m) => m.id === id);
  if (i === -1) return null;
  all[i] = { ...all[i], ...patch };
  persist(all);
  return all[i];
}

function remove(id) {
  persist(load().filter((m) => m.id !== id));
}

module.exports = { list, add, update, remove };
