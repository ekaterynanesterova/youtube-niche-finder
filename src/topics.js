// Поиск тем в собственной базе. Смысл: перестать выдумывать список тем и
// доставать его из того, что молодые прорвавшиеся каналы реально снимают.

import { daysBetween } from './store.js';

// Служебные слова и форматная шелуха: они есть в каждом втором заголовке
// и темой не являются.
const STOP = new Set(`
der die das den dem des ein eine einer eines einem und oder aber wie was wer wo
wann warum ist sind war waren wird werden hat haben hatte kann können muss
mit von für auf aus bei nach über unter vor zwischen durch gegen ohne um zum zur
im in am an als auch nur noch schon sehr mehr alle alles man sich nicht kein
ich du er sie es wir ihr dein mein sein ihre unser diese dieser dieses
doku dokumentation dokumentarfilm teil folge ganze ganzer ganzes hd video
stunde stunden minute minuten sekunden lang länger langer version deutsch
größte größten größer grösste beste besten neue neuen neues alte alten
schrieb sagte gibt geht macht kommt bleibt heißt zeigt
the a an of and or but how what who where when why is are was were will
this that these those with from for on out at by to in it its their our your
you we they he she i my his her not no all more most very just only
documentary film full episode part hd video watch
`.trim().split(/\s+/));

const norm = (w) => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

// Заголовок → связки из 1–3 слов. Тема почти всегда именно связка:
// «schwarzes Loch», «Tiefsee Lebewesen».
export function tokens(title) {
  return String(title ?? '')
    .split(/[\s|·—–\-:,.!?()\[\]"'„“»«/]+/u)
    .map(norm)
    .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
}

export function phrases(title, maxLen = 3) {
  const words = tokens(title);
  const out = new Set();
  for (let n = 1; n <= maxLen; n++) {
    for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(' '));
  }
  return [...out];
}

// Кандидаты в темы. Частота сама по себе бесполезна: чаще всего встречаются
// просто частые слова — «Welt», «Leben», «Zeit». Поэтому меряем не частоту, а
// перевес: во сколько раз связка чаще у прорвавшихся видео, чем во всей базе.
// У пустого слова перевес около единицы, у настоящей темы — заметно больше.
export function findTopics({ metrics, thresholds, knownQueries = [], lang = 'de' }) {
  const known = new Set(knownQueries.map((q) => String(q).toLowerCase()));
  const minChannels = thresholds.topicMinChannels ?? 3;
  const minLift = thresholds.topicMinLift ?? 2.5;

  const sameLang = metrics.videos.filter((v) => metrics.channels[v.channelId]?.lang === lang);
  if (!sameLang.length) return [];

  const breakout = sameLang.filter((v) =>
    v.outlierRatio != null && v.outlierRatio >= thresholds.outlierRatio &&
    v.views >= thresholds.outlierMinViews &&
    // Именно молодые: нас интересует, что залетает без опоры на аудиторию.
    v.channelAgeAtUploadDays != null && v.channelAgeAtUploadDays <= thresholds.youngChannelDays);
  if (breakout.length < 10) return [];

  const stat = new Map();
  for (const v of breakout) {
    for (const p of phrases(v.title)) {
      const e = stat.get(p) ?? { phrase: p, channels: new Set(), videos: 0, views: [], ages: [] };
      e.channels.add(v.channelId);
      e.videos++;
      e.views.push(v.views);
      e.ages.push(v.channelAgeAtUploadDays);
      stat.set(p, e);
    }
  }

  // Знаменатель перевеса: как часто связка встречается вообще, а не только
  // у выстреливших. Считаем только для отобранных связок — иначе это
  // миллионы записей ради чисел, которые не понадобятся.
  const alive = [...stat.values()].filter((e) => e.channels.size >= minChannels);
  const corpusJoined = sameLang.map((v) => ' ' + tokens(v.title).join(' ') + ' ');

  const candidates = [];
  for (const e of alive) {
    if (known.has(e.phrase)) continue;
    const needle = ' ' + e.phrase + ' ';
    let inAll = 0;
    for (const t of corpusJoined) if (t.includes(needle)) inAll++;
    const lift = (e.videos / breakout.length) / Math.max(inAll / sameLang.length, 1e-9);
    if (!Number.isFinite(lift) || lift < minLift) continue;
    candidates.push({
      phrase: e.phrase,
      channels: e.channels.size,
      videos: e.videos,
      inCorpus: inAll,
      lift: Math.round(lift * 10) / 10,
      medianViews: median(e.views),
      medianChannelAge: Math.round(median(e.ages)),
      words: e.phrase.split(' ').length,
    });
  }

  // Отбрасываем связки, целиком поглощённые более длинной с тем же охватом:
  // «Loch» рядом с «schwarzes Loch» — это одно и то же, только хуже.
  let kept = candidates.filter((c) => !candidates.some((o) =>
    o !== c && o.channels >= c.channels && o.phrase.includes(c.phrase) && o.words > c.words));

  // Deutschland и Deutschlands — одно слово в двух формах. Оставляем сильнейшую.
  const byStem = new Map();
  for (const c of kept) {
    const stem = c.phrase.replace(/(s|n|en|es)$/u, '');
    const prev = byStem.get(stem);
    if (!prev || c.channels > prev.channels || (c.channels === prev.channels && c.lift > prev.lift)) {
      byStem.set(stem, c);
    }
  }
  kept = [...byStem.values()];

  return kept
    // Три канала с перевесом ×22 — находка ценнее десяти с перевесом ×3.
    .sort((a, b) => b.channels * Math.log2(b.lift) - a.channels * Math.log2(a.lift))
    .slice(0, thresholds.topicMaxCandidates ?? 40);
}

function median(xs) {
  const a = xs.filter(Number.isFinite).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const UML = { 'ä': 'ae', 'ö': 'oe', 'ü': 'ue', 'ß': 'ss' };

export function slug(phrase) {
  return phrase.toLowerCase()
    .replace(/[äöüß]/g, (c) => UML[c])
    .normalize('NFD').replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
}

// Поисковый запрос из связки. Голое слово ищется слишком широко, поэтому
// добавляем формат — так же, как выглядят темы, заданные руками.
export function toQuery(phrase) {
  return /doku|dokumentation/i.test(phrase) ? phrase : `${phrase} Doku`;
}

// Автодобавление с потолком: за прогон приезжает не больше нескольких тем,
// иначе разведка расползётся и сожжёт квоту на случайных находках.
export function promote({ candidates, seeds, limit, group = 'Найдено автоматом' }) {
  const ids = new Set(seeds.map((s) => s.id));
  const added = [];
  for (const c of candidates) {
    if (added.length >= limit) break;
    const id = slug(c.phrase);
    if (!id || ids.has(id)) continue;
    ids.add(id);
    added.push({
      id, group,
      de: toQuery(c.phrase),
      ru: null,                      // подпись переведём отдельно
      source: 'auto',
      addedAt: new Date().toISOString().slice(0, 10),
      foundVia: { channels: c.channels, lift: c.lift, medianViews: c.medianViews },
    });
  }
  return added;
}
