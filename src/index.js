// Оркестратор одного прогона. Запускается вручную (workflow_dispatch) или по крону.
import { YouTubeApi } from './api.js';
import { Quota } from './quota.js';
import { discover, explore, backfillFirstUpload, survey, hydrate, snapshot } from './collect.js';
import { computeMetrics } from './metrics.js';
import { renderReport } from './report.js';
import { buildPayload, renderSite } from './site.js';
import { Translator } from './translate.js';
import { findTopics, promote } from './topics.js';
import {
  loadDb, saveDb, readJson, writeJson, writeCompactJson, writeText, paths,
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

// Журнал разведки завели позже, чем начали собирать. Тема, по которой в базе
// есть каналы, точно искалась хотя бы раз — проставляем это, чтобы очередь
// не считала её нетронутой и не гоняла по кругу заново.
{
  const stats = (db.state.seedStats ??= {});
  const withChannels = new Set();
  for (const c of Object.values(db.channels)) for (const sid of c.seeds ?? []) withChannels.add(sid);
  let patched = 0;
  for (const sid of withChannels) {
    if (!stats[sid]) { stats[sid] = { searches: 1, lastSearched: null, totalResults: null,
                                      channelsSeen: 0, newLastRun: null }; patched++; }
  }
  if (patched) console.log(`Журнал разведки восстановлен по базе для ${patched} тем`);
}

if (!metricsOnly) {
  const quota = new Quota(Number(process.env.UNIT_BUDGET) || thresholds.dailyUnitBudget);
  const api = new YouTubeApi(process.env.YOUTUBE_API_KEY, quota);
  const searchBudget = Number(process.env.SEARCH_BUDGET ?? thresholds.searchesPerRun);

  console.log(`Прогон ${date}. Бюджет ${quota.budget} юнитов, разведка ${searchBudget} запросов.`);

  const onlySeeds = (process.env.ONLY_SEEDS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (searchBudget > 0) await discover({ api, db, seeds, markets, thresholds, searchBudget, onlySeeds });
  // Trending не знает про наш список тем — только он и приводит незнакомое.
  if (!onlySeeds.length) await explore({ api, db, markets, thresholds });
  const pending = await survey({ api, db, thresholds });
  if (pending?.size) await hydrate({ api, db, pending, markets, thresholds });
  // Настоящий возраст важнее всего у тех, кто уже зарабатывает: именно их мы
  // объявляем новичками или стариками.
  const needAge = Object.values(db.channels)
    .filter((c) => c.uploadsPlaylistId && !c.firstUploadComplete)
    .sort((a, b) => (b.totalViews ?? 0) - (a.totalViews ?? 0))
    .map((c) => c.id);
  await backfillFirstUpload({ api, db, ids: needAge, unitBudget: thresholds.backfillUnitBudget ?? 1200 });

  const snap = await snapshot({ api, db, thresholds });

  if (Object.keys(snap).length) {
    writeCompactJson(paths.snapshot(date), { date, videos: snap });
  }
  // Опорный срез по ВСЕМ видео, включая старые. Он нужен для долговечности:
  // дневные снапшоты хранят только молодые ролики ради места, а прирост
  // старых иначе не измерить. Файл один и переписывается раз в неделю,
  // поэтому объём не растёт.
  const baseline = readJson(paths.baseline, null);
  const baselineAge = baseline?.date
    ? (Date.parse(date) - Date.parse(baseline.date)) / 86400000 : Infinity;
  if (baselineAge >= (thresholds.baselineRefreshDays ?? 7)) {
    writeCompactJson(paths.baseline, { date, views: Object.fromEntries(
      Object.entries(db.current).map(([id, s]) => [id, s[0]])) });
    console.log(`Опорный срез обновлён (прошлому было ${Math.round(baselineAge)} дн)`);
  }

  db.state.runs = [...(db.state.runs ?? []).slice(-29), { date, ...quota.summary() }];
  saveDb(db);
  console.log(`Квота: потрачено ${quota.spent} из ${quota.budget}`, quota.byEndpoint);
}

// Метрики считаем всегда — они дешёвые и не трогают API.
const snapshots = listSnapshots().slice(-90).map((f) => readJson(paths.snapshot(f.replace('.json', ''))));
const metrics = computeMetrics({ db, seeds, thresholds, snapshots,
                                baseline: readJson(paths.baseline, null) });
writeText(paths.report('latest.md'), renderReport(metrics, seeds));

// Страница собирается с вшитыми данными: без fetch ей нечего не догрузить.
const payload = buildPayload(metrics, seeds, thresholds);

// Названия видео переводим на русский. Переведённое живёт в кеше вечно,
// так что расход у бесплатного сервиса падает почти до нуля со второго дня.
const cache = readJson(paths.translations, {});
const translator = new Translator({ cache });

// Темы достаём из собственной базы: что реально снимают молодые каналы,
// которые пробились. Список тем перестаёт упираться в фантазию человека.
const known = seeds.flatMap((x) => [x.de, x.en]).filter(Boolean);

// Каналы, не покрытые ни одной нишей, — прямая улика того, чего мы не назвали.
const covered = new Set();
{
  const perPair = new Map();
  for (const v of metrics.videos) {
    for (const sid of v.seeds) {
      const k = v.channelId + '|' + sid;
      perPair.set(k, (perPair.get(k) ?? 0) + 1);
    }
  }
  for (const [k, n] of perPair) if (n >= 3) covered.add(k.split('|')[0]);
}
const uncovered = new Set(Object.values(metrics.channels)
  .filter((c) => c.started && !covered.has(c.id))
  .map((c) => c.id));
console.log(`Вне всех ниш зарабатывающих каналов: ${uncovered.size}`);

const candidates = [
  ...findTopics({ metrics, thresholds, knownQueries: known, lang: 'en', onlyChannels: uncovered }),
  ...findTopics({ metrics, thresholds, knownQueries: known, lang: 'en' }),
].filter((c, i, arr) => arr.findIndex((x) => x.phrase === c.phrase) === i);
// Список тем рос быстрее, чем мы успевали его обходить: девяносто девять тем
// из ста тридцати четырёх не искались ни разу. Новые пускаем только когда
// очередь непройденных короткая.
const untouched = seeds.filter((x) => !(db.state.seedStats?.[x.id]?.searches)).length;
const room = Math.max(0, (thresholds.topicQueueLimit ?? 25) - untouched);
const promoted = promote({
  candidates, seeds,
  limit: Math.min(thresholds.topicMaxPromotedPerRun ?? 5, room),
  lang: 'en',
});
if (!room) console.log(`Автопоиск тем на паузе: ${untouched} тем ещё не искались`);
for (const t of promoted) {
  t.ru = await translator.translate(t.en, 'en');
  seeds.push(t);
}
if (promoted.length) {
  const cfg = readJson(join(ROOT, 'config/seeds.json'));
  cfg.seeds = seeds;
  writeJson(join(ROOT, 'config/seeds.json'), cfg);
  console.log('Новые темы:', promoted.map((t) => t.en ?? t.de).join(' · '));
}
const pending = [];
for (const [, byLang] of Object.entries(payload.examples)) {
  for (const [lang, list] of Object.entries(byLang)) {
    for (const v of list) pending.push(Object.assign(v, { from: lang }));
  }
}
// Один и тот же ролик попадает в несколько ниш — переводим его один раз.
const seen = new Set();
await translator.translateAll(pending.filter((v) => !seen.has(v.title) && seen.add(v.title)));
for (const v of pending) {
  v.titleRu ??= translator.cached(v.title, v.from);
  delete v.from;
}
writeJson(paths.translations, cache);
console.log('Перевод:', JSON.stringify(translator.stats),
            translator.blocked ? (translator.stats.fetched ? '(дневной лимит сервиса исчерпан)' : '(сервис перевода недоступен)') : '');

payload.candidates = candidates
  .filter((c) => !promoted.some((t) => (t.en ?? t.de ?? '').startsWith(c.phrase)))
  .slice(0, 20);
payload.promoted = promoted.map((t) => ({ id: t.id, query: t.en ?? t.de, ru: t.ru, ...t.foundVia }));

writeText(join(ROOT, 'index.html'), renderSite(payload));

// В metrics.json кладём выводы, а не сырьё: массив всех видео весил 17 МБ
// и переписывался бы целиком каждый день. Сырьё и так лежит в data/.
writeJson(paths.metrics, {
  computedAt: metrics.computedAt,
  snapshotDays: metrics.snapshotDays,
  thresholds: metrics.thresholds,
  niches: metrics.niches,
  channelCount: Object.keys(metrics.channels).length,
  videoCount: metrics.videos.length,
});
console.log(`Готово. Каналов ${Object.keys(metrics.channels).length}, видео ${metrics.videos.length}, ниш ${Object.keys(metrics.niches).length}.`);
