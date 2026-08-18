// База данных — это сам репозиторий. Читаем/пишем JSON, коммитит Action.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = join(ROOT, 'data');
export const SNAPSHOTS = join(DATA, 'snapshots');
export const REPORTS = join(ROOT, 'reports');

export function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw new Error(`Битый JSON в ${path}: ${e.message}`); }
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

export function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export const paths = {
  channels: join(DATA, 'channels.json'),
  videos: join(DATA, 'videos.json'),
  state: join(DATA, 'state.json'),
  metrics: join(DATA, 'metrics.json'),
  snapshot: (date) => join(SNAPSHOTS, `${date}.json`),
  report: (name) => join(REPORTS, name),
};

export function listSnapshots() {
  if (!existsSync(SNAPSHOTS)) return [];
  return readdirSync(SNAPSHOTS).filter((f) => f.endsWith('.json')).sort();
}

export function loadDb() {
  return {
    channels: readJson(paths.channels, {}),
    videos: readJson(paths.videos, {}),
    state: readJson(paths.state, { seedCursor: 0, runs: [] }),
  };
}

export function saveDb(db) {
  writeJson(paths.channels, db.channels);
  writeJson(paths.videos, db.videos);
  writeJson(paths.state, db.state);
}

export const today = () => new Date().toISOString().slice(0, 10);
export const daysBetween = (a, b) => (new Date(b) - new Date(a)) / 86400000;
