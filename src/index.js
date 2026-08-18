// Оркестратор одного прогона. Запускается вручную (workflow_dispatch) или по крону.
import { YouTubeApi } from './api.js';
import { Quota } from './quota.js';
import { discover, survey, hydrate, snapshot } from './collect.js';
import { computeMetrics } from './metrics.js';
import { renderReport } from './report.js';
import {
  loadDb, saveDb, readJson, writeJson, writeText, paths,
  listSnapshots, today, ROOT,
} from './store.js';
import { join } from 'node:path';

const args = new Set(process.argv.slice(2));
const metricsOnly = args.has('--metrics-only');

const thresholds = readJson(join(ROOT, 'config/thresholds.json'));
const markets = readJson(join(ROOT, 'config/markets.json'));
const seeds = readJson(join(ROOT, 'config/seeds.json')).seeds;

const db = loadDb();
const date = today();

if (!metricsOnly) {
  const quota = new Quota(Number(process.env.UNIT_BUDGET) || thresholds.dailyUnitBudget);
  const api = new YouTubeApi(process.env.YOUTUBE_API_KEY, quota);
  const searchBudget = Number(process.env.SEARCH_BUDGET ?? thresholds.searchesPerRun);

  console.log(`Прогон ${date}. Бюджет ${quota.budget} юнитов, разведка ${searchBudget} запросов.`);

  if (searchBudget > 0) await discover({ api, db, seeds, markets, thresholds, searchBudget });
  const pending = await survey({ api, db, thresholds });
  if (pending?.size) await hydrate({ api, db, pending, markets, thresholds });
  const snap = await snapshot({ api, db });

  if (Object.keys(snap).length) {
    writeJson(paths.snapshot(date), { date, videos: snap });
  }
  db.state.runs = [...(db.state.runs ?? []).slice(-29), { date, ...quota.summary() }];
  saveDb(db);
  console.log(`Квота: потрачено ${quota.spent} из ${quota.budget}`, quota.byEndpoint);
}

// Метрики считаем всегда — они дешёвые и не трогают API.
const snapshots = listSnapshots().slice(-90).map((f) => readJson(paths.snapshot(f.replace('.json', ''))));
const metrics = computeMetrics({ db, seeds, thresholds, snapshots });
writeJson(paths.metrics, metrics);
writeText(paths.report('latest.md'), renderReport(metrics, seeds));
console.log(`Готово. Каналов ${Object.keys(metrics.channels).length}, видео ${metrics.videos.length}, ниш ${Object.keys(metrics.niches).length}.`);
