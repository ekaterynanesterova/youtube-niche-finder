// Три слоя сбора: разведка (дорого), опрос (дёшево), накопление (даром).
import { parseDuration, QuotaExceeded } from './api.js';
import { BudgetExhausted } from './quota.js';
import { daysBetween } from './store.js';

const log = (...a) => console.log(...a);

// Ошибки бюджета и квоты не валят прогон: собранное должно сохраниться.
// Слои, помеченные optional, не валят его вообще ничем — они улучшают
// результат, но без них сбор осмысленный. Обязательные слои по-прежнему
// падают громко: молча терять данные хуже, чем упасть.
async function tolerant(label, fn, { optional = false } = {}) {
  try { return await fn(); }
  catch (e) {
    if (e instanceof BudgetExhausted || e instanceof QuotaExceeded) {
      log(`  ⚠ ${label}: ${e.message} — останавливаю этот слой, собранное сохраняю`);
      return null;
    }
    if (optional) {
      log(`  ⚠ ${label} пропущен: ${e.message}`);
      return null;
    }
    throw e;
  }
}

// Слой 1. Ищем каналы, а не видео. Сиды прокручиваются по кругу между прогонами.
export async function discover({ api, db, seeds, markets, thresholds, searchBudget, onlySeeds }) {
  // Прицельный прогон: новую тему хочется проверить сразу, а не когда до неё
  // доедет курсор. Общую очередь при этом не сбиваем.
  if (onlySeeds?.length) {
    seeds = seeds.filter((s) => onlySeeds.includes(s.id));
    if (!seeds.length) { log('Ни одна из запрошенных тем не найдена в конфиге'); return; }
    log(`Прицельная разведка: ${seeds.map((s) => s.id).join(', ')}`);
  }

  const after = new Date(Date.now() - thresholds.discoveryWindowDays * 86400000).toISOString();
  const stats = (db.state.seedStats ??= {});
  const statOf = (id) => (stats[id] ??= { searches: 0, lastSearched: null, totalResults: null,
                                          channelsSeen: 0, newLastRun: null });

  // Очередь по нужде, а не по кругу. Тема, которую не искали ни разу, знает о
  // себе ноль — она важнее той, по которой уже есть сотня каналов. Ротация
  // по кругу оставляла нетронутыми три четверти списка.
  const queue = (pool) => pool.slice().sort((a, b) => {
    const A = statOf(a.id), B = statOf(b.id);
    if (A.searches !== B.searches) return A.searches - B.searches;
    return String(A.lastSearched ?? '').localeCompare(String(B.lastSearched ?? ''));
  });

  const plan = [];
  for (const [code, market] of Object.entries(markets)) {
    const pool = market.role === 'control' ? seeds.filter((s) => s.control) : seeds;
    const ordered = queue(pool).filter((s) => s[code]);
    if (!ordered.length) continue;
    const n = Math.max(0, Math.round(searchBudget * market.searchShare));
    for (let i = 0; i < n; i++) plan.push({ seed: ordered[i % ordered.length], code, market });
  }

  let found = 0, fresh = 0;
  await tolerant('разведка', async () => {
    for (const { seed, code, market } of plan) {
      const res = await api.search({
        q: seed[code], publishedAfter: after,
        regionCode: market.regionCode, relevanceLanguage: market.relevanceLanguage,
      });
      const st = statOf(seed.id);
      st.searches++;
      st.lastSearched = new Date().toISOString().slice(0, 10);
      // Сколько роликов вообще подходит под запрос — оценка YouTube. Приходит
      // бесплатно с каждым поиском и это единственная прямая мера того,
      // насколько тема велика на самом деле, а не в нашей базе.
      if (Number.isFinite(res.pageInfo?.totalResults)) st.totalResults = res.pageInfo.totalResults;

      let brandNew = 0;
      for (const item of res.items ?? []) {
        const id = item.snippet?.channelId;
        if (!id) continue;
        found++;
        const known = !!db.channels[id];
        const ch = db.channels[id] ?? (db.channels[id] = {
          id, seeds: [], markets: [], firstSeen: new Date().toISOString(), surveyed: null,
        });
        if (!known) brandNew++;
        if (!ch.seeds.includes(seed.id)) ch.seeds.push(seed.id);
        if (!ch.markets.includes(code)) ch.markets.push(code);
        if (!ch.surveyed) fresh++;
      }
      // Сколько поиск принёс НЕЗНАКОМЫХ каналов. Пока приносит — тема большая;
      // как только начинает возвращать одних и тех же, она исчерпана.
      st.newLastRun = brandNew;
      st.channelsSeen += res.items?.length ?? 0;
      log(`  [${code}] «${seed[code]}» → ${res.items?.length ?? 0} видео, новых каналов ${brandNew}` +
          (st.totalResults != null ? `, всего по теме ~${st.totalResults}` : ''));
    }
  });

  const untouched = seeds.filter((s) => !stats[s.id]?.searches).length;
  log(`Разведка: ${plan.length} запросов, ${found} попаданий, каналов ${Object.keys(db.channels).length}` +
      ` (новых к опросу ${fresh}); тем ещё не тронуто: ${untouched}`);
}

// Слой 1б. Разведка вслепую. Разведка по своим запросам приводит только те
// каналы, темы которых мы уже назвали, — система варится в себе. Trending
// ломает круг: он не знает про наш список тем.
export async function explore({ api, db, markets, thresholds }) {
  const cats = thresholds.trendingCategories ?? ['27', '28'];
  let fresh = 0, seen = 0, skipped = 0;
  await tolerant('trending', async () => {
    for (const market of Object.values(markets)) {
      for (const cat of cats) {
        // Чарт mostPopular существует не для всех пар «страна + категория»:
        // на отсутствующую YouTube отвечает 404, и это нормальный ответ,
        // а не поломка.
        let res;
        try {
          res = await api.trending({ regionCode: market.regionCode, videoCategoryId: cat });
        } catch (e) {
          if (/404|not found/i.test(e.message)) {
            skipped++;
            log(`  Trending ${market.regionCode}/${cat}: чарта нет, пропускаю`);
            continue;
          }
          throw e;
        }
        for (const v of res.items ?? []) {
          const id = v.snippet?.channelId;
          if (!id) continue;
          seen++;
          const ch = db.channels[id] ?? (db.channels[id] = {
            id, seeds: [], markets: [], firstSeen: new Date().toISOString(), surveyed: null,
          });
          ch.viaTrending = true;
          if (!ch.surveyed) fresh++;
        }
      }
    }
  }, { optional: true });
  log(`Trending: ${seen} попаданий, новых каналов ${fresh}` +
      (skipped ? `, чартов без данных ${skipped}` : ''));
}

// Слой 2в. Достаём настоящую дату первой загрузки. Пока архив не долистан,
// возраст берётся от регистрации — а канал мог годами лежать пустым и начать
// полгода назад. Долистываем тех, кто важен, и по чуть-чуть за прогон.
export async function backfillFirstUpload({ api, db, ids, unitBudget }) {
  let done = 0;
  const spentAtStart = api.quota.spent;
  await tolerant('дата первой загрузки', async () => {
    for (const id of ids) {
      if (api.quota.spent - spentAtStart >= unitBudget) break;
      const ch = db.channels[id];
      if (!ch?.uploadsPlaylistId || ch.firstUploadComplete) continue;
      let token, oldest = ch.firstUploadAt ?? null;
      for (;;) {
        if (!api.quota.canAfford('playlistItems')) return;
        const res = await api.playlistItems(ch.uploadsPlaylistId, token);
        for (const it of res.items ?? []) {
          const at = it.contentDetails?.videoPublishedAt;
          if (at && (!oldest || at < oldest)) oldest = at;
        }
        token = res.nextPageToken;
        if (!token) { ch.firstUploadComplete = true; done++; break; }
      }
      ch.firstUploadAt = oldest;
    }
  });
  log(`Дата первой загрузки уточнена у ${done} каналов`);
}

// Слой 2. Опрашиваем известные каналы: метаданные + список загрузок.
export async function survey({ api, db, thresholds }) {
  const ids = Object.keys(db.channels);
  // Сначала те, кого ещё ни разу не опрашивали, потом самые давние.
  ids.sort((a, b) => (db.channels[a].surveyed ?? '') .localeCompare(db.channels[b].surveyed ?? ''));
  const batch = ids.slice(0, thresholds.maxChannelsSurveyedPerRun);

  await tolerant('опрос каналов', async () => {
    for (let i = 0; i < batch.length; i += 50) {
      const res = await api.channels(batch.slice(i, i + 50));
      for (const c of res.items ?? []) {
        const ch = db.channels[c.id];
        if (!ch) continue;
        ch.title = c.snippet?.title;
        ch.publishedAt = c.snippet?.publishedAt;
        ch.country = c.snippet?.country ?? null;
        ch.uploadsPlaylistId = c.contentDetails?.relatedPlaylists?.uploads ?? null;
        ch.subscribers = c.statistics?.hiddenSubscriberCount ? null : Number(c.statistics?.subscriberCount ?? 0);
        ch.videoCount = Number(c.statistics?.videoCount ?? 0);
        ch.totalViews = Number(c.statistics?.viewCount ?? 0);
      }
    }
  });

  const pending = new Set();
  await tolerant('список загрузок', async () => {
    for (const id of batch) {
      const ch = db.channels[id];
      if (!ch?.uploadsPlaylistId) continue;
      // Новый канал листаем до конца — нужна дата первой загрузки.
      // Известный — только первую страницу, свежее там всё равно нет.
      // У каналов с огромным архивом до конца не дойти: берём столько, сколько
      // нужно для медианы, а возраст возьмём из даты регистрации.
      const reachable = ch.videoCount <= thresholds.maxUploadPagesNewChannel * 50;
      const maxPages = ch.surveyed ? 1
        : (reachable ? thresholds.maxUploadPagesNewChannel : thresholds.medianSamplePages);
      let token, pages = 0, oldest = ch.firstUploadAt ?? null;
      while (pages < maxPages) {
        if (!api.quota.canAfford('playlistItems')) break;
        const res = await api.playlistItems(ch.uploadsPlaylistId, token);
        for (const it of res.items ?? []) {
          const vid = it.contentDetails?.videoId;
          const at = it.contentDetails?.videoPublishedAt;
          if (!vid) continue;
          if (at && (!oldest || at < oldest)) oldest = at;
          if (!db.videos[vid] || !db.videos[vid].durationSec) pending.add(vid);
        }
        pages++;
        token = res.nextPageToken;
        if (!token) { ch.firstUploadComplete = true; break; }
      }
      ch.firstUploadAt = oldest;
      ch.surveyed = new Date().toISOString();
    }
  });

  log(`Опрос: ${batch.length} каналов, ${pending.size} видео к дозагрузке`);
  return pending;
}

// Слой 2б. Метаданные видео. Здесь же отсекаем шортсы и чужой язык.
export async function hydrate({ api, db, pending, markets, thresholds }) {
  const audio = new Set(Object.values(markets).flatMap((m) => m.audioLanguages));
  const ids = [...pending];
  let kept = 0, dropped = 0;

  await tolerant('метаданные видео', async () => {
    for (let i = 0; i < ids.length; i += 50) {
      const res = await api.videos(ids.slice(i, i + 50));
      for (const v of res.items ?? []) {
        const durationSec = parseDuration(v.contentDetails?.duration);
        const lang = v.snippet?.defaultAudioLanguage ?? v.snippet?.defaultLanguage ?? null;
        // Порог длительности — единственный способ гарантированно убрать шортсы и нарезки.
        if (durationSec < thresholds.minDurationSec) { dropped++; continue; }
        // Язык знаем не всегда; когда знаем и он чужой — выбрасываем.
        if (lang && !audio.has(lang) && !audio.has(lang.split('-')[0])) { dropped++; continue; }
        db.videos[v.id] = {
          ...db.videos[v.id],
          id: v.id,
          channelId: v.snippet?.channelId,
          title: v.snippet?.title,
          publishedAt: v.snippet?.publishedAt,
          durationSec,
          lang,
          firstSeen: db.videos[v.id]?.firstSeen ?? new Date().toISOString(),
        };
        kept++;
      }
    }
  });
  log(`Метаданные: оставлено ${kept}, отброшено ${dropped} (шортсы, короткие, чужой язык)`);
}

// Слой 3. Дневной срез. Ради него всё и затевалось: истории просмотров API не отдаёт.
export async function snapshot({ api, db, thresholds }) {
  const ids = Object.keys(db.videos);
  let n = 0;
  await tolerant('снапшот', async () => {
    for (let i = 0; i < ids.length; i += 50) {
      const res = await api.videos(ids.slice(i, i + 50));
      for (const v of res.items ?? []) {
        db.current[v.id] = [
          Number(v.statistics?.viewCount ?? 0),
          v.statistics?.likeCount == null ? null : Number(v.statistics.likeCount),
          v.statistics?.commentCount == null ? null : Number(v.statistics.commentCount),
        ];
        n++;
      }
    }
  });

  // В историю кладём только молодые видео: у старых кривая уже легла в полку,
  // а хранить её каждый день — это сотни мегабайт в год ради нулевого прироста.
  const history = {};
  for (const [id, stats] of Object.entries(db.current)) {
    const v = db.videos[id];
    if (v && daysBetween(v.publishedAt, new Date().toISOString()) <= thresholds.snapshotMaxAgeDays) {
      history[id] = stats;
    }
  }
  log(`Снапшот: обновлено ${n} видео, в историю записано ${Object.keys(history).length}`);
  return history;
}
