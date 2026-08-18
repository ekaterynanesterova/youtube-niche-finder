// Три слоя сбора: разведка (дорого), опрос (дёшево), накопление (даром).
import { parseDuration, QuotaExceeded } from './api.js';
import { BudgetExhausted } from './quota.js';

const log = (...a) => console.log(...a);

// Ошибки бюджета/квоты не валят прогон: то, что уже собрано, должно сохраниться.
async function tolerant(label, fn) {
  try { return await fn(); }
  catch (e) {
    if (e instanceof BudgetExhausted || e instanceof QuotaExceeded) {
      log(`  ⚠ ${label}: ${e.message} — останавливаю этот слой, собранное сохраняю`);
      return null;
    }
    throw e;
  }
}

// Слой 1. Ищем каналы, а не видео. Сиды прокручиваются по кругу между прогонами.
export async function discover({ api, db, seeds, markets, thresholds, searchBudget }) {
  const after = new Date(Date.now() - thresholds.discoveryWindowDays * 86400000).toISOString();
  const plan = [];
  for (const [code, market] of Object.entries(markets)) {
    const n = Math.max(0, Math.round(searchBudget * market.searchShare));
    for (let i = 0; i < n; i++) {
      const seed = seeds[(db.state.seedCursor + i) % seeds.length];
      if (seed[code]) plan.push({ seed, code, market });
    }
  }
  db.state.seedCursor = (db.state.seedCursor + Math.max(1, Math.round(searchBudget / 2))) % seeds.length;

  let found = 0, fresh = 0;
  await tolerant('разведка', async () => {
    for (const { seed, code, market } of plan) {
      const res = await api.search({
        q: seed[code], publishedAfter: after,
        regionCode: market.regionCode, relevanceLanguage: market.relevanceLanguage,
      });
      for (const item of res.items ?? []) {
        const id = item.snippet?.channelId;
        if (!id) continue;
        found++;
        const ch = db.channels[id] ?? (db.channels[id] = {
          id, seeds: [], markets: [], firstSeen: new Date().toISOString(), surveyed: null,
        });
        if (!ch.seeds.includes(seed.id)) ch.seeds.push(seed.id);
        if (!ch.markets.includes(code)) ch.markets.push(code);
        if (!ch.surveyed) fresh++;
      }
      log(`  [${code}] «${seed[code]}» → ${res.items?.length ?? 0} видео`);
    }
  });
  log(`Разведка: ${plan.length} запросов, ${found} попаданий, каналов в базе ${Object.keys(db.channels).length} (новых к опросу ${fresh})`);
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
      const maxPages = ch.surveyed ? 1 : thresholds.maxUploadPagesNewChannel;
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
export async function snapshot({ api, db }) {
  const ids = Object.keys(db.videos);
  const snap = {};
  await tolerant('снапшот', async () => {
    for (let i = 0; i < ids.length; i += 50) {
      const res = await api.videos(ids.slice(i, i + 50));
      for (const v of res.items ?? []) {
        const views = Number(v.statistics?.viewCount ?? 0);
        const likes = v.statistics?.likeCount == null ? null : Number(v.statistics.likeCount);
        const comments = v.statistics?.commentCount == null ? null : Number(v.statistics.commentCount);
        snap[v.id] = [views, likes, comments];
        Object.assign(db.videos[v.id], { views, likes, comments, updatedAt: new Date().toISOString() });
      }
    }
  });
  log(`Снапшот: ${Object.keys(snap).length} видео`);
  return snap;
}
