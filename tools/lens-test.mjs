// Замер линзы: что мы теряем из-за слова «documentary» в каждом запросе.
//
// Повод. В выводах все темы называются «X documentary», и это не вывод из
// данных, а зашитое правило: toQuery() дописывает это слово к каждой
// автонайденной теме. Дальше оно само себя кормит — ищем документалки,
// находим документальные каналы, «узнаём», что documentary популярно,
// дописываем его к новым темам. Петля, из которой выхода нет.
//
// Слово попало туда не случайно: оно отсеивает влоги, реакции и шортсы,
// оставляя длинный формат без лица. Вопрос не «убрать или оставить», а
// «сколько оно стоит»: что приходит по голому запросу и насколько это
// другое.
//
// Замер прямой. Один и тот же предмет ищется двумя способами, результаты
// сравниваются по тому, что нам важно: длина ролика, размер канала, есть
// ли канал уже в базе, просмотры. Двенадцать поисков, 1200 юнитов.
//
// Запуск: node tools/lens-test.mjs   (нужен YOUTUBE_API_KEY)
import { YouTubeApi, parseDuration } from '../src/api.js';
import { Quota } from '../src/quota.js';
import { readJson, paths, unpackVideos, unpackChannels } from '../src/store.js';

const KEY = process.env.YOUTUBE_API_KEY;
if (!KEY) { console.error('Нет YOUTUBE_API_KEY'); process.exit(1); }

// Предметы берём подтверждённые: по ним в базе уже есть каналы и цифры,
// так что разницу будет с чем соотнести.
const SUBJECTS = ['deep sea', 'disaster', 'village life', 'dinosaur', 'ancient egypt', 'black hole'];
const VARIANTS = [
  { tag: 'documentary', make: (s) => `${s} documentary` },
  { tag: 'без слова', make: (s) => s },
];

const quota = new Quota(Number(process.env.UNIT_BUDGET ?? 1400));
const api = new YouTubeApi(KEY, quota);

const db = { videos: unpackVideos(readJson(paths.videos, null)),
             channels: unpackChannels(readJson(paths.channels, null)) };
const known = new Set(Object.keys(db.channels));

const nn = (x) => x == null ? '—' : Math.round(x).toLocaleString('ru-RU');
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

async function probe(query) {
  // Ровно те же параметры, что у настоящего сбора: videoDuration «long» и
  // порядок по просмотрам зашиты в api.search. Сравнение должно идти при
  // прочих равных, иначе разницу даст не слово, а настройки поиска.
  const res = await api.search({ q: query, maxResults: 50, relevanceLanguage: 'en' });
  const ids = (res.items ?? []).map((i) => i.id?.videoId).filter(Boolean);
  if (!ids.length) return null;

  const details = [];
  for (let i = 0; i < ids.length; i += 50) {
    const d = await api.videos(ids.slice(i, i + 50));
    details.push(...(d.items ?? []));
  }
  const rows = details.map((v) => ({
    title: v.snippet?.title ?? '',
    channelId: v.snippet?.channelId,
    channel: v.snippet?.channelTitle ?? '',
    sec: parseDuration(v.contentDetails?.duration ?? ''),
    views: Number(v.statistics?.viewCount ?? 0),
  }));
  const long = rows.filter((r) => r.sec >= 480);
  return {
    query,
    found: rows.length,
    longShare: rows.length ? long.length / rows.length : 0,
    medMin: med(rows.map((r) => r.sec)) / 60,
    medViews: med(rows.map((r) => r.views)),
    inBase: rows.filter((r) => known.has(r.channelId)).length,
    channels: new Set(rows.map((r) => r.channelId)).size,
    sample: rows.slice(0, 6),
  };
}

const out = [];
for (const subject of SUBJECTS) {
  for (const v of VARIANTS) {
    if (!quota.canAfford('search')) { console.log('Квота кончилась'); break; }
    try {
      const r = await probe(v.make(subject));
      if (r) out.push({ subject, tag: v.tag, ...r });
    } catch (e) { console.log(`  ${v.make(subject)}: ${e.message}`); }
  }
}

console.log('# Что даёт слово «documentary» в запросе');
console.log('');
console.log('Один предмет, два запроса. Пятьдесят первых результатов каждого.');
console.log('');
console.log('| Предмет | Запрос | Длиннее 8 мин | Типичная длина | Медиана просмотров | Разных каналов | Уже в базе |');
console.log('|---|---|---|---|---|---|---|');
for (const r of out) {
  console.log(`| ${r.subject} | ${r.tag} | ${Math.round(r.longShare * 100)}% `
    + `| ${r.medMin.toFixed(0)} мин | ${nn(r.medViews)} | ${r.channels} | ${r.inBase} |`);
}
console.log('');
console.log('## Что именно приходит');
console.log('');
for (const r of out) {
  console.log(`**${r.query}**`);
  for (const s of r.sample) {
    console.log(`- ${Math.round(s.sec / 60)} мин · ${nn(s.views)} · ${s.channel} — ${s.title.slice(0, 80)}`);
  }
  console.log('');
}
console.log(`Потрачено юнитов: ${quota.spent}`);
