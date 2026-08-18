// Метрики. Всё считается из накопленных данных, ничего не предсказывается.
import { daysBetween } from './store.js';

export function median(xs) {
  const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const share = (n, total) => (total ? n / total : null);

// Медиана канала — по видео старше 30 дней: свежие ещё не набрали
// и занижали бы базу, раздувая каждый ratio.
export function channelBaseline(videos, thresholds, now) {
  const mature = videos.filter((v) => daysBetween(v.publishedAt, now) >= thresholds.medianMinVideoAgeDays);
  return {
    medianViews: median(mature.map((v) => v.views)),
    matureCount: mature.length,
  };
}

// Частота публикаций: сколько видео в неделю тянет канал за последние 90 дней.
export function uploadsPerWeek(videos, now, windowDays = 90) {
  const recent = videos.filter((v) => daysBetween(v.publishedAt, now) <= windowDays);
  return (recent.length / windowDays) * 7;
}

// Живая аудитория лайкает и комментирует. Конвейерный AI-контент собирает
// просмотры, но не реакцию — это и есть сигнал мусорности.
export function engagement(v) {
  if (!v.views) return { like: null, comment: null };
  return {
    like: v.likes == null ? null : v.likes / v.views,
    comment: v.comments == null ? null : v.comments / v.views,
  };
}

export function computeMetrics({ db, seeds, thresholds, snapshots = [], now = new Date().toISOString() }) {
  const byChannel = {};
  for (const v of Object.values(db.videos)) {
    if (!v.channelId || !Number.isFinite(v.views)) continue;
    (byChannel[v.channelId] ??= []).push(v);
  }

  // --- уровень канала ---
  const channels = {};
  for (const [cid, vids] of Object.entries(byChannel)) {
    const ch = db.channels[cid] ?? { id: cid };
    const { medianViews, matureCount } = channelBaseline(vids, thresholds, now);
    channels[cid] = {
      id: cid,
      title: ch.title ?? null,
      seeds: ch.seeds ?? [],
      markets: ch.markets ?? [],
      subscribers: ch.subscribers ?? null,
      firstUploadAt: ch.firstUploadAt ?? ch.publishedAt ?? null,
      firstUploadComplete: !!ch.firstUploadComplete,
      ageDays: ch.firstUploadAt ? daysBetween(ch.firstUploadAt, now) : null,
      medianViews, matureCount,
      videoCount: vids.length,
      uploadsPerWeek: uploadsPerWeek(vids, now),
    };
  }

  // --- уровень видео ---
  const videos = [];
  for (const [cid, vids] of Object.entries(byChannel)) {
    const c = channels[cid];
    for (const v of vids) {
      const ageDays = daysBetween(v.publishedAt, now);
      const eng = engagement(v);
      // Прокси-скорость: пока не накопилась настоящая кривая, делим просмотры на возраст.
      const proxyVelocity = ageDays <= thresholds.velocityMaxVideoAgeDays && ageDays > 0
        ? v.views / ageDays : null;
      videos.push({
        id: v.id, channelId: cid, title: v.title, publishedAt: v.publishedAt,
        durationSec: v.durationSec, views: v.views, ageDays,
        outlierRatio: c.medianViews ? v.views / c.medianViews : null,
        channelAgeAtUploadDays: c.firstUploadAt ? daysBetween(c.firstUploadAt, v.publishedAt) : null,
        proxyVelocity,
        velocity: realVelocity(v.id, snapshots),
        likeRate: eng.like, commentRate: eng.comment,
        seeds: c.seeds,
      });
    }
  }

  // --- уровень ниши ---
  const niches = {};
  for (const seed of seeds) {
    const seedVideos = videos.filter((v) => v.seeds.includes(seed.id));
    const seedChannels = [...new Set(seedVideos.map((v) => v.channelId))].map((id) => channels[id]);

    const outliers = seedVideos.filter((v) =>
      v.outlierRatio != null && v.outlierRatio >= thresholds.outlierRatio && v.views >= thresholds.outlierMinViews);

    // Схлопываем по каналу: один везунчик не должен давать нише пять очков.
    const outlierChannels = [...new Set(outliers.map((v) => v.channelId))];
    const youngOutlierChannels = outlierChannels.filter((id) => {
      const first = outliers.find((v) => v.channelId === id);
      return first?.channelAgeAtUploadDays != null && first.channelAgeAtUploadDays <= thresholds.youngChannelDays;
    });

    const slopChannels = seedChannels.filter((c) =>
      c.uploadsPerWeek >= thresholds.slopUploadsPerWeek &&
      c.ageDays != null && c.ageDays <= thresholds.slopChannelAgeDays);

    niches[seed.id] = {
      id: seed.id, group: seed.group, queries: { de: seed.de ?? null, en: seed.en ?? null },
      channels: seedChannels.length,
      videos: seedVideos.length,
      outliers: outliers.length,
      outlierChannels: outlierChannels.length,
      // Главная метрика: доля выбросов, приходящаяся на молодые каналы.
      permeability: share(youngOutlierChannels.length, outlierChannels.length),
      medianViews: median(seedVideos.map((v) => v.views)),
      medianOutlierViews: median(outliers.map((v) => v.views)),
      medianUploadsPerWeek: median(seedChannels.map((c) => c.uploadsPerWeek)),
      medianLikeRate: median(seedVideos.map((v) => v.likeRate).filter((x) => x != null)),
      medianCommentRate: median(seedVideos.map((v) => v.commentRate).filter((x) => x != null)),
      // Индекс мусорности: доля молодых каналов-конвейеров в нише.
      slopShare: share(slopChannels.length, seedChannels.length),
      byMarket: marketSplit(seedVideos, seedChannels, channels, outlierChannels, thresholds),
      confidence: confidence(seedVideos.length, outlierChannels.length, snapshots.length),
    };
  }

  return { computedAt: now, thresholds, channels, videos, niches,
           snapshotDays: snapshots.length };
}

// Настоящая скорость роста — только когда накопились снапшоты.
function realVelocity(videoId, snapshots) {
  const points = snapshots
    .map((s) => ({ date: s.date, views: s.videos?.[videoId]?.[0] }))
    .filter((p) => Number.isFinite(p.views));
  if (points.length < 2) return null;
  const a = points[0], b = points[points.length - 1];
  const days = daysBetween(a.date, b.date);
  return days > 0 ? (b.views - a.views) / days : null;
}

function marketSplit(seedVideos, seedChannels, channels, outlierChannels, thresholds) {
  const out = {};
  for (const code of ['de', 'en']) {
    const chans = seedChannels.filter((c) => c.markets?.includes(code));
    const ids = new Set(chans.map((c) => c.id));
    const vids = seedVideos.filter((v) => ids.has(v.channelId));
    const outs = outlierChannels.filter((id) => ids.has(id));
    const young = outs.filter((id) => (channels[id]?.ageDays ?? Infinity) <= thresholds.youngChannelDays);
    out[code] = {
      channels: chans.length, videos: vids.length,
      medianViews: median(vids.map((v) => v.views)),
      outlierChannels: outs.length,
      permeability: share(young.length, outs.length),
    };
  }
  return out;
}

// Честная оценка того, насколько цифрам можно верить в этот день.
function confidence(videoCount, outlierChannelCount, snapshotDays) {
  if (videoCount < 30 || outlierChannelCount < 3) return 'нет данных';
  if (snapshotDays < 7) return 'низкая — прокси-скорость, кривой роста ещё нет';
  if (snapshotDays < 21) return 'средняя — кривая роста только формируется';
  return 'рабочая';
}
