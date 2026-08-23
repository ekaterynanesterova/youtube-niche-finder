// Фокусная ниша — та, которую снимаем сами. Отличие от остальных в вопросе:
// по чужим нишам мы выбираем, куда идти, а по своей смотрим, что происходит
// сегодня. Поэтому здесь не медианы за три месяца, а суточный прирост: вышла
// новость — про неё за день снимают все, и узнать об этом надо в тот же день,
// а не в следующем срезе метрик.

import { phrases } from './topics.js';

// Ряд замеров по одному ролику. Дневные срезы хранят только молодые ролики —
// именно они и интересны.
function series(id, snapshots) {
  const out = [];
  for (const s of snapshots) {
    const v = s.videos?.[id]?.[0];
    if (Number.isFinite(v)) out.push({ date: s.date, views: v });
  }
  return out;
}

function perDayBetween(a, b) {
  const days = (Date.parse(b.date) - Date.parse(a.date)) / 86400000;
  return days > 0 ? (b.views - a.views) / days : null;
}

export function buildFocus({ metrics, snapshots, seeds, focus }) {
  if (!focus?.groups?.length) return null;
  const lang = focus.lang ?? 'en';
  const seedIds = new Set(seeds.filter((s) => focus.groups.includes(s.group)).map((s) => s.id));
  const byId = Object.fromEntries(seeds.map((s) => [s.id, s]));
  const vids = metrics.videos.filter((v) =>
    v.seeds.some((x) => seedIds.has(x)) && metrics.channels[v.channelId]?.lang === lang);

  const rows = [];
  for (const v of vids) {
    const s = series(v.id, snapshots);
    const last = s.length >= 2 ? perDayBetween(s[s.length - 2], s[s.length - 1]) : null;
    // Ускорение: сравниваем последний отрезок с предыдущим. Ролик, который
    // вчера брал тысячу в сутки, а сегодня десять тысяч, — это и есть «пошло».
    const prev = s.length >= 3 ? perDayBetween(s[s.length - 3], s[s.length - 2]) : null;
    rows.push({
      id: v.id, title: v.title, titleRu: null,
      channelId: v.channelId,
      channel: metrics.channels[v.channelId]?.title ?? null,
      channelAge: metrics.channels[v.channelId]?.ageDays == null
        ? null : Math.round(metrics.channels[v.channelId].ageDays),
      young: metrics.channels[v.channelId]?.ageDays != null
        && metrics.channels[v.channelId].ageDays <= metrics.thresholds.youngChannelDays,
      views: v.views,
      age: Math.round(v.ageDays),
      minutes: Math.round(v.durationSec / 60),
      perDay: last,
      prevPerDay: prev,
      // Во сколько раз ускорился. Нулевую вчерашнюю базу не делим.
      accel: last != null && prev != null && prev >= 50 ? last / prev : null,
      seeds: v.seeds.filter((x) => seedIds.has(x)),
      topics: v.seeds.filter((x) => seedIds.has(x)).map((x) => byId[x]?.ru ?? byId[x]?.[lang] ?? x),
    });
  }

  const size = focus.listSize ?? 20;
  const measured = rows.filter((r) => r.perDay != null);

  // Что смотрят прямо сейчас — по абсолютному суточному приросту.
  const rising = measured.slice().sort((a, b) => b.perDay - a.perDay).slice(0, size);

  // Что именно ускорилось. Порог по приросту нужен, чтобы ролик с трёх
  // просмотров до тридцати не изображал взрывной рост.
  const breaking = measured
    .filter((r) => r.accel != null && r.accel >= 1.5 && r.perDay >= (focus.breakingMinPerDay ?? 300))
    .sort((a, b) => b.accel - a.accel).slice(0, size);

  // Только что вышло: по этим роликам видно, что снимают конкуренты сегодня.
  const fresh = rows
    .filter((r) => r.age <= (focus.freshDays ?? 14))
    .sort((a, b) => b.views / Math.max(a.age, 1) - a.views / Math.max(b.age, 1))
    .sort((a, b) => (b.perDay ?? 0) - (a.perDay ?? 0))
    .slice(0, size);

  // Кто работает в нише. Считаем по роликам, попавшим в тему, а не по всему
  // каталогу канала.
  const perCh = new Map();
  for (const r of rows) {
    const c = perCh.get(r.channelId) ?? { id: r.channelId, title: r.channel, videos: 0, views: 0,
                                          perDay: 0, fresh: 0, young: r.young, age: r.channelAge };
    c.videos++; c.views += r.views ?? 0; c.perDay += r.perDay ?? 0;
    if (r.age <= 30) c.fresh++;
    perCh.set(r.channelId, c);
  }
  const channels = [...perCh.values()]
    .filter((c) => c.videos >= 2)
    .sort((a, b) => b.perDay - a.perDay)
    .slice(0, 25)
    .map((c) => ({ ...c, usd: Math.round(metrics.channels[c.id]?.monthlyUsd ?? 0),
                   subs: metrics.channels[c.id]?.subscribers ?? null,
                   catalog: metrics.channels[c.id]?.catalogCount ?? null }));

  // Какие формулировки пошли в ход. Сравниваем долю связки среди свежих роликов
  // с её долей среди старых: важна не частота, а то, что она выросла.
  const win = focus.risingWindowDays ?? 45;
  const recent = rows.filter((r) => r.age <= win);
  const older = rows.filter((r) => r.age > win);
  const count = (list) => {
    const m = new Map();
    for (const r of list) for (const p of new Set(phrases(r.title, 2))) m.set(p, (m.get(p) ?? 0) + 1);
    return m;
  };
  const rc = count(recent), oc = count(older);
  const hot = [...rc.entries()]
    .filter(([, n]) => n >= 3)
    .map(([p, n]) => {
      const wasShare = older.length ? (oc.get(p) ?? 0) / older.length : 0;
      const nowShare = recent.length ? n / recent.length : 0;
      const gain = recent.filter((r) => r.title.toLowerCase().includes(p)).reduce((s, r) => s + (r.perDay ?? 0), 0);
      // Раньше здесь стояла Infinity для связки, которой в старых роликах нет
      // вовсе. JSON.stringify превращает Infinity в null, на странице
      // isFinite(null) — истина, и вёрстка падала на null.toFixed(). Связку
      // без прошлого отмечаем честным null.
      return { phrase: p, videos: n, nowShare, wasShare,
               lift: wasShare > 0 ? nowShare / wasShare : null, perDay: gain };
    })
    .filter((x) => x.lift == null || x.lift >= 1.8)
    .sort((a, b) => b.perDay - a.perDay)
    .slice(0, 14);

  return {
    id: focus.id, label: focus.label, why: focus.why, lang,
    seedIds: [...seedIds],
    topics: [...seedIds].map((id) => ({ id, query: byId[id]?.[lang] ?? id, ru: byId[id]?.ru ?? null })),
    videoCount: rows.length, measured: measured.length, channelCount: perCh.size,
    rising, breaking, fresh, channels, hot,
  };
}
