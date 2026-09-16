// Оркестратор одного прогона. Запускается вручную (workflow_dispatch) или по крону.
import { YouTubeApi } from './api.js';
import { Quota } from './quota.js';
import { discover, explore, backfillFirstUpload, survey, hydrate, snapshot } from './collect.js';
import { computeMetrics, seedIndex, wordFrequency } from './metrics.js';
import { renderReport } from './report.js';
import { buildPayload, renderSite } from './site.js';
import { renderBrief } from './brief.js';
import { buildFocus } from './focus.js';
import { Translator } from './translate.js';
import { findTopics, promote } from './topics.js';
import {
  loadDb, saveDb, readJson, writeJson, writePlainJson, writeText, paths,
  loadSeries, saveSeries, loadBases, saveBases, latestBase, today, ROOT, daysBetween,
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
  const onlySeeds = (process.env.ONLY_SEEDS ?? '').split(',').map((x) => x.trim()).filter(Boolean);

  // Снапшот идёт последним, но платит первым. Без брони его съедала разведка:
  // она тратит по 100 юнитов за запрос и всегда успевала раньше. Откладываем
  // столько, сколько стоит обойти молодые ролики целиком плюс кусок хвоста.
  const nowIso = new Date().toISOString();
  const youngVideos = Object.values(db.videos)
    .filter((v) => v.publishedAt && daysBetween(v.publishedAt, nowIso) <= thresholds.snapshotMaxAgeDays).length;
  const snapshotReserve = Math.min(
    Math.ceil(Object.keys(db.videos).length / 50),
    Math.ceil(youngVideos / 50) + (thresholds.snapshotTailUnits ?? 400));
  quota.reserve(snapshotReserve);

  console.log(`Прогон ${date}. Бюджет ${quota.budget} юнитов, разведка ${searchBudget} запросов, `
              + `броня снапшота ${snapshotReserve} (молодых видео ${youngVideos}).`);

  try {
    if (searchBudget > 0) await discover({ api, db, seeds, markets, thresholds, searchBudget, onlySeeds,
                                           focus: readJson(join(ROOT, 'config/focus.json'), null) });

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
      // Ряд наблюдений лежит одним файлом, а не файлом в день: раньше в каждом
      // суточном файле заново повторялись идентификаторы всех роликов.
      const series = loadSeries().filter((s) => s.date !== date);
      saveSeries([...series, { date, videos: snap }]);
    }

    // Опорный срез по ВСЕМ видео, включая старые. Он нужен для долговечности:
    // дневные снапшоты хранят только молодые ролики ради места, а прирост
    // старых иначе не измерить. Файл один и переписывается раз в неделю,
    // поэтому объём не растёт.
    const bases = loadBases();
    const baseline = latestBase(bases);
    const baselineAge = baseline?.date
      ? (Date.parse(date) - Date.parse(baseline.date)) / 86400000 : Infinity;
    if (baselineAge >= (thresholds.baselineRefreshDays ?? 7)) {
      // Новый опорный ДОБАВЛЯЕТСЯ к прошлым, а не затирает их. Раньше затирал,
      // и три недельных среза уцелели только в истории репозитория.
      saveBases([...bases.filter((b) => b.date !== date),
                 { date, videos: Object.fromEntries(
                   Object.entries(db.current).map(([id, s]) => [id, [s[0]]])) }]);
      console.log(`Опорный срез добавлен (прошлому было ${Math.round(baselineAge)} дн, всего срезов ${bases.length + 1})`);
    }
  } finally {
    // Что успели собрать — сохраняем, даже если прогон упал на полпути.
    // Иначе одна ошибка стоит суток квоты: юниты потрачены, данных нет.
    db.state.runs = [...(db.state.runs ?? []).slice(-29), {
      date, ...quota.summary(),
      channels: Object.keys(db.channels).length,
      videos: Object.keys(db.videos).length,
    }];
    saveDb(db);
    console.log(`Квота: потрачено ${quota.spent} из ${quota.budget}`, quota.byEndpoint);
  }
}

// Метрики считаем всегда — они дешёвые и не трогают API.
const snapshots = loadSeries().slice(-90);
const primaryLang = Object.entries(markets).find(([, m]) => m.role === 'primary')?.[0] ?? 'en';
const metrics = computeMetrics({ db, seeds, thresholds, snapshots, primaryLang,
                                baseline: latestBase(loadBases()) });
writeText(paths.report('latest.md'), renderReport(metrics, seeds));

// Страница собирается с вшитыми данными: без fetch ей нечего не догрузить.
// Фокусная ниша — та, которую снимаем сами. Её отчёт строится по суточному
// приросту, а не по медианам: новость живёт день.
const focusCfg = readJson(join(ROOT, 'config/focus.json'), null);
const focus = focusCfg ? buildFocus({ metrics, snapshots, seeds, focus: focusCfg }) : null;
const payload = buildPayload(metrics, seeds, thresholds, db, focus);

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
//
// Считать надо только те темы, до которых разведка может дотянуться. Сорок тем
// имеют запрос лишь на контрольном рынке, а он ищет только опорные — они не
// будут найдены никогда. Попадая в счёт непройденных, они держали очередь
// выше лимита и автопоиск стоял на паузе больше недели, хотя реальная очередь
// давно пуста.
const untouched = seeds.filter((x) => {
  if (!metrics.niches[x.id]?.reachable || metrics.niches[x.id]?.broad) return false;
  return !(db.state.seedStats?.[x.id]?.searches);
}).length;
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
  writePlainJson(join(ROOT, 'config/seeds.json'), cfg);
  console.log('Новые темы:', promoted.map((t) => t.en ?? t.de).join(' · '));
}
const pending = [];
for (const [, byLang] of Object.entries(payload.examples)) {
  for (const [lang, list] of Object.entries(byLang)) {
    for (const v of list) pending.push(Object.assign(v, { from: lang }));
  }
}
// Заголовки фокусной ниши переводим тоже: по ней смотрят каждый день, и
// читать её на английском — лишнее трение.
if (focus) {
  for (const list of [focus.rising, focus.breaking, focus.fresh]) {
    for (const v of list) pending.push(Object.assign(v, { from: focus.lang }));
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

// Две темы с одним набором якорей — это одна тема, показанная дважды: списки
// видео под ними совпадают дословно, а в отчёте они выглядят независимыми
// подтверждениями друг друга. Молча такое пропускать нельзя.
{
  const idx = seedIndex(seeds, ['de', 'en'], wordFrequency(Object.values(db.videos), metrics.channels));
  const clash = [];
  for (const lang of ['de', 'en']) {
    const seen = new Map();
    for (const s of idx[lang]) {
      const key = s.anchors.slice().sort().join(' ');
      if (seen.has(key)) clash.push(`${lang}: ${seen.get(key)} = ${s.id} (${key})`);
      else seen.set(key, s.id);
    }
  }
  if (clash.length) console.log('⚠ Темы с одинаковыми якорями:', clash.join(' · '));
}

writeText(join(ROOT, 'index.html'), renderSite(payload));
// Тот же вывод одним markdown-файлом: сайт читается глазами, а бриф нужен,
// чтобы отдать статистику в другой чат целиком, одной ссылкой.
writeText(join(ROOT, 'docs/brief.md'), renderBrief(payload));

// metrics.json больше не пишется. Он собирался «чтобы был», и его не читал
// никто: ни сайт (у него данные вшиты внутрь страницы), ни бриф, ни отчёт по
// космосу, ни сам сбор. А после переезда базы из git его и забрать стало
// неоткуда — data/ наружу не публикуется. Всё, что в нём лежало, целиком
// есть в index.html и docs/brief.md.
console.log(`Готово. Каналов ${Object.keys(metrics.channels).length}, видео ${metrics.videos.length}, ниш ${Object.keys(metrics.niches).length}.`);
