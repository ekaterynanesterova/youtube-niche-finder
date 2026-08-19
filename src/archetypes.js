// Ниша — это не тема, а набор тем, которые ОДНИ И ТЕ ЖЕ каналы публикуют вместе.
// Спорить о том, «чёрные дыры — это ниша или тема», бессмысленно: достаточно
// посмотреть, кто что снимает рядом. Если каналы, делающие ролики про чёрные
// дыры, делают и про Джеймса Уэбба — это один канал. Если про космос для сна
// не снимает никто из них — это другой канал и другой зритель.

import { phrases } from './topics.js';

const jaccard = (a, b) => {
  let same = 0;
  for (const x of a) if (b.has(x)) same++;
  return same / (a.size + b.size - same);
};

// Чем канал занимается: связки, которые у него встречаются заметно чаще,
// чем в языке вообще. Просто частые слова так отсеиваются сами.
export function channelTopics(videos, df, corpusSize, take = 14) {
  const own = new Map();
  for (const v of videos) {
    for (const p of phrases(v.title, 2)) own.set(p, (own.get(p) ?? 0) + 1);
  }
  // Словарь должен быть общим. Связка, встречающаяся только у этого канала
  // (название рубрики, имя ведущего), уникальна по определению и склеить с
  // кем-то не даст. Слишком частая — наоборот, не различает.
  const floor = Math.max(10, corpusSize * 0.0004);
  const ceil = corpusSize * 0.06;

  const scored = [];
  for (const [p, n] of own) {
    if (n < 2) continue;
    const d = df.get(p) ?? 1;
    if (d < floor || d > ceil) continue;
    scored.push([p, (n / videos.length) / (d / corpusSize)]);
  }
  return new Set(scored.sort((a, b) => b[1] - a[1]).slice(0, take).map(([p]) => p));
}

export function buildArchetypes({ metrics, thresholds, lang = 'en', minChannels = 3, similarity = 0.05 }) {
  const vidsByChannel = new Map();
  const corpus = [];
  for (const v of metrics.videos) {
    if (metrics.channels[v.channelId]?.lang !== lang) continue;
    corpus.push(v);
    const arr = vidsByChannel.get(v.channelId) ?? [];
    arr.push(v);
    vidsByChannel.set(v.channelId, arr);
  }
  if (corpus.length < 200) return [];

  const df = new Map();
  for (const v of corpus) {
    for (const p of new Set(phrases(v.title, 2))) df.set(p, (df.get(p) ?? 0) + 1);
  }

  // Архетип строим только по тем, кто дошёл до денег: подражать надо им.
  const earners = [...vidsByChannel.entries()]
    .filter(([id, vids]) => metrics.channels[id]?.earning && vids.length >= 5)
    .map(([id, vids]) => ({
      id,
      ch: metrics.channels[id],
      topics: channelTopics(vids, df, corpus.length),
    }))
    .filter((c) => c.topics.size >= 3)
    .sort((a, b) => (b.ch.monthlyUsd ?? 0) - (a.ch.monthlyUsd ?? 0));

  // Жадная кластеризация: канал уходит в наиболее похожий кластер, если
  // пересечение тем достаточное. Иначе заводит свой.
  const clusters = [];
  for (const c of earners) {
    let best = null, bestSim = 0;
    for (const cl of clusters) {
      const sim = jaccard(c.topics, cl.topics);
      if (sim > bestSim) { bestSim = sim; best = cl; }
    }
    if (best && bestSim >= similarity) {
      best.members.push(c);
      for (const t of c.topics) best.counts.set(t, (best.counts.get(t) ?? 0) + 1);
      // Ядро кластера — темы, которые есть хотя бы у трети участников.
      best.topics = new Set([...best.counts.entries()]
        .filter(([, n]) => n >= Math.max(2, best.members.length / 3))
        .map(([t]) => t));
    } else {
      clusters.push({
        members: [c],
        topics: new Set(c.topics),
        counts: new Map([...c.topics].map((t) => [t, 1])),
      });
    }
  }

  return clusters
    .filter((cl) => cl.members.length >= minChannels)
    .map((cl) => {
      const money = cl.members.map((m) => m.ch.monthlyUsd).filter(Number.isFinite);
      const young = cl.members.filter((m) => m.ch.ageDays != null && m.ch.ageDays <= thresholds.youngChannelDays);
      return {
        channels: cl.members.length,
        young: young.length,
        fastestDays: young.reduce((min, m) => (min == null ? m.ch.ageDays : Math.min(min, m.ch.ageDays)), null),
        medianUsd: med(money),
        medianCatalog: med(cl.members.map((m) => m.ch.videoCount)),
        medianMinutesPerWeek: med(cl.members.map((m) => m.ch.minutesPerWeek)),
        // Темы ядра — то, что участники этого архетипа снимают все вместе.
        topics: [...cl.counts.entries()]
          .sort((a, b) => b[1] - a[1]).slice(0, 12)
          .map(([t, n]) => ({ topic: t, channels: n })),
        examples: cl.members.slice(0, 4).map((m) => ({
          title: m.ch.title, usd: Math.round(m.ch.monthlyUsd ?? 0),
          ageDays: m.ch.ageDays == null ? null : Math.round(m.ch.ageDays),
          videos: m.ch.videoCount,
        })),
      };
    })
    .sort((a, b) => (b.young - a.young) || ((b.medianUsd ?? 0) - (a.medianUsd ?? 0)));
}

function med(xs) {
  const a = xs.filter(Number.isFinite).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
