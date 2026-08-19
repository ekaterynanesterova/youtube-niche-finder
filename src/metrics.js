// Метрики. Всё считается из накопленных данных, ничего не предсказывается.
import { daysBetween } from './store.js';

// Возраст канала. Полный архив даёт настоящую дату первой загрузки; когда
// архив не долистан, берём дату регистрации — она может только состарить канал,
// а это безопасная сторона ошибки.
const ageDays_ = (at, now) => daysBetween(at, now);

function ageDays(ch, now) {
  const basis = ch.firstUploadComplete ? ch.firstUploadAt : ch.publishedAt;
  return basis ? daysBetween(basis, now) : null;
}

// Смысл ниши — деньги, а не проценты. Цель задана в долларах в месяц;
// из неё и RPM получается порог просмотров, и уже он решает, состоялся канал
// или нет. Кратность к медиане тут бесполезна: у мёртвого канала она
// огромная именно потому, что медиана мёртвая.
export function targetMonthlyViews(thresholds) {
  return (thresholds.targetMonthlyUsd / thresholds.rpmUsd) * 1000;
}

export function hitProfile(videos, thresholds, now) {
  const breakouts = videos.filter((v) => v.views >= thresholds.breakoutViews).length;
  const working = videos.filter((v) => v.views >= thresholds.workingViews).length;

  // Что канал приносит СЕЙЧАС: просмотры свежих роликов, а не заслуги
  // многолетней давности. Три месяца — достаточно, чтобы сгладить всплеск.
  const fresh = videos.filter((v) => daysBetween(v.publishedAt, now) <= 90);
  const monthlyViews = fresh.reduce((sum, v) => sum + (v.views ?? 0), 0) / 3;
  const target = targetMonthlyViews(thresholds);

  return {
    breakouts, working,
    workingRate: videos.length ? working / videos.length : 0,
    monthlyViews,
    monthlyUsd: (monthlyViews / 1000) * thresholds.rpmUsd,
    // Канал состоялся, если на свежем контенте выходит на цель.
    earning: monthlyViews >= target,
    // Попадания есть, а денег нет: разовое везение или слишком мелкий масштаб.
    lottery: working >= 1 && monthlyViews < target,
    bestViews: videos.reduce((m, v) => Math.max(m, v.views ?? 0), 0),
  };
}

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
  // Медиана по двум-трём видео — это не база, а случайность: любой ролик
  // рядом с ней выглядит выбросом. Такому каналу ratio не считаем вовсе.
  const enough = mature.length >= (thresholds.medianMinMatureVideos ?? 5);
  return {
    medianViews: enough ? median(mature.map((v) => v.views)) : null,
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

// Параметр relevanceLanguage в search.list — подсказка, а не фильтр: по немецкому
// запросу приезжают National Geographic и KBS. Язык канала определяем по его же
// видео; запрос говорит только о теме.
export function dominantLang(videos, fallbackMarkets = []) {
  const counts = {};
  for (const v of videos) {
    const base = (v.lang ?? '').split('-')[0];
    if (base) counts[base] = (counts[base] ?? 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (top) return top[0];
  // Язык не объявлен вообще — тогда доверяем рынку, если он единственный.
  return fallbackMarkets.length === 1 ? fallbackMarkets[0] : null;
}

export function computeMetrics({ db, seeds, thresholds, snapshots = [], now = new Date().toISOString() }) {
  const byChannel = {};
  for (const v of Object.values(db.videos)) {
    const [views, likes, comments] = db.current?.[v.id] ?? [];
    if (!v.channelId || !Number.isFinite(views)) continue;
    (byChannel[v.channelId] ??= []).push({ ...v, views, likes, comments });
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
      // Дате первой загрузки верим только если долистали архив до конца.
      // Иначе она врёт в опасную сторону — канал кажется моложе, чем он есть,
      // и ниша выглядит проницаемой там, где сидят старожилы.
      firstUploadAt: ch.firstUploadComplete ? ch.firstUploadAt : null,
      firstUploadComplete: !!ch.firstUploadComplete,
      ageBasis: ch.firstUploadComplete ? 'первая загрузка' : 'регистрация канала',
      ageDays: ageDays(ch, now),
      medianViews, matureCount,
      ...hitProfile(vids, thresholds, now),
      lang: dominantLang(vids, ch.markets ?? []),
      videoCount: vids.length,
      uploadsPerWeek: uploadsPerWeek(vids, now),
      minutesPerWeek: uploadsPerWeek(vids, now) * ((median(vids.map((v) => v.durationSec)) ?? 0) / 60),
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
        channelAgeAtUploadDays: c.ageDays == null ? null : c.ageDays - ageDays_(v.publishedAt, now),
        proxyVelocity,
        velocity: realVelocity(v.id, snapshots),
        likeRate: eng.like, commentRate: eng.comment,
        seeds: c.seeds,
      });
    }
  }

  // --- уровень ниши ---
  // Считаем по каждому языку отдельно. Смешивать нельзя: немецкий выброс и
  // английский живут в разных выдачах и конкурируют с разными каналами.
  const niches = {};
  for (const seed of seeds) {
    const seedVideos = videos.filter((v) => v.seeds.includes(seed.id));
    const byLang = {};
    for (const lang of ['de', 'en']) {
      byLang[lang] = nicheStats(seedVideos.filter((v) => channels[v.channelId]?.lang === lang),
                                channels, thresholds);
    }
    niches[seed.id] = {
      id: seed.id, group: seed.group, control: !!seed.control,
      queries: { de: seed.de ?? null, en: seed.en ?? null },
      // Основной рынок — немецкий. Рейтинг строится по нему.
      ...byLang.de,
      byMarket: byLang,
      confidence: confidence(byLang.de.videos, byLang.de.outlierChannels, snapshots.length),
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

function nicheStats(seedVideos, channels, thresholds) {
  const seedChannels = [...new Set(seedVideos.map((v) => v.channelId))].map((id) => channels[id]);

  const outliers = seedVideos.filter((v) =>
    v.outlierRatio != null && v.outlierRatio >= thresholds.outlierRatio && v.views >= thresholds.outlierMinViews);

  // Проницаемость считаем только по каналам, которые попадают повторно.
  // Канал с одним выстрелом на двести роликов ничего не доказывает — ни про
  // себя, ни тем более про нишу.
  const outlierChannels = seedChannels.filter((c) => c.earning).map((c) => c.id);
  const youngOutlierChannels = outlierChannels.filter((id) =>
    channels[id]?.ageDays != null && channels[id].ageDays <= thresholds.youngChannelDays);
  const lotteryChannels = seedChannels.filter((c) => c.lottery);

  // Сколько готового хронометража ниша выпускает в неделю. Это мера потока,
  // а не качества: высокий поток значит, что формат поставлен на конвейер —
  // и это читается в обе стороны. Конкурировать объёмом придётся, но сам
  // факт конвейера доказывает, что формат автоматизируется. Что из этого
  // важнее, решает человек, а не скрипт.
  const conveyorChannels = seedChannels.filter((c) => c.minutesPerWeek >= thresholds.conveyorMinutesPerWeek);

  const outlierDuration = median(outliers.map((v) => v.durationSec));

  return {
    channels: seedChannels.length,
    videos: seedVideos.length,
    outliers: outliers.length,
    outlierChannels: outlierChannels.length,
    // Сколько РАЗНЫХ молодых каналов пробилось. Один везунчик ничего не доказывает:
    // канал бывает «проклятым» независимо от ниши, и наоборот. Повторяемость на
    // нескольких каналах — единственное, что отличает открытую дверь от случайности.
    youngOutlierChannels: youngOutlierChannels.length,
    // Главная метрика: доля выбросов, приходящаяся на молодые каналы.
    permeability: share(youngOutlierChannels.length, outlierChannels.length),
    medianViews: median(seedVideos.map((v) => v.views)),
    medianOutlierViews: median(outliers.map((v) => v.views)),
    // Во что обойдётся вход: сколько минут длится типовой выброс.
    medianOutlierMinutes: outlierDuration == null ? null : outlierDuration / 60,
    medianUploadsPerWeek: median(seedChannels.map((c) => c.uploadsPerWeek)),
    medianLikeRate: median(seedVideos.map((v) => v.likeRate).filter((x) => x != null)),
    medianCommentRate: median(seedVideos.map((v) => v.commentRate).filter((x) => x != null)),
    // Доля каналов, работающих на потоке.
    conveyorShare: share(conveyorChannels.length, seedChannels.length),
    // Сколько каналов держатся на единственном выстреле. Высокая доля значит,
    // что ниша выдаёт разовые везения, а не устойчивый заход.
    lotteryShare: share(lotteryChannels.length, lotteryChannels.length + outlierChannels.length),
    medianWorkingRate: median(seedChannels.filter((c) => c.working > 0).map((c) => c.workingRate)),
    // Сколько денег приносит типичный состоявшийся канал ниши.
    medianMonthlyUsd: median(seedChannels.filter((c) => c.earning).map((c) => c.monthlyUsd)),
    medianYoungMonthlyUsd: median(seedChannels
      .filter((c) => c.earning && c.ageDays != null && c.ageDays <= thresholds.youngChannelDays)
      .map((c) => c.monthlyUsd)),
  };
}

// Честная оценка того, насколько цифрам можно верить в этот день.
function confidence(videoCount, outlierChannelCount, snapshotDays) {
  if (videoCount < 30 || outlierChannelCount < 3) return 'нет данных';
  if (snapshotDays < 7) return 'низкая — прокси-скорость, кривой роста ещё нет';
  if (snapshotDays < 21) return 'средняя — кривая роста только формируется';
  return 'рабочая';
}
