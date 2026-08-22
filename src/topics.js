// Поиск тем в собственной базе. Смысл: перестать выдумывать список тем и
// доставать его из того, что молодые прорвавшиеся каналы реально снимают.

import { daysBetween, readJson, ROOT } from './store.js';
import { join } from 'node:path';

// Служебные слова и форматная шелуха: они есть в каждом втором заголовке
// и темой не являются.
// Служебные слова — по языкам, а не одним списком. Общий список стоил дорого:
// немецкое «war» (был) выбрасывало английское «war» (война), «man» — «man»,
// «die» — «die». Запрос «world war 2 documentary» усыхал до одного слова
// «world», и в нишу про Вторую мировую попадало всё, где есть «world».
const STOP_DE = `
der die das den dem des ein eine einer eines einem und oder aber wie was wer wo
wann warum ist sind war waren wird werden hat haben hatte kann können muss
mit von für auf aus bei nach über unter vor zwischen durch gegen ohne um zum zur
im in am an als auch nur noch schon sehr mehr alle alles man sich nicht kein
ich du er sie es wir ihr dein mein sein ihre unser diese dieser dieses
doku dokumentation dokumentarfilm teil folge ganze ganzer ganzes hd video
stunde stunden minute minuten sekunden lang länger langer version deutsch
größte größten größer grösste beste besten neue neuen neues alte alten
schrieb sagte gibt geht macht kommt bleibt heißt zeigt
`.trim().split(/\s+/);

const STOP_EN = `
the a an of and or but how what who where when why is are was were will
this that these those with from for on out at by to in it its their our your
you we they he she i my his her not no all more most very just only
documentary film full episode part hd video watch
`.trim().split(/\s+/);

export const STOP_BY_LANG = { de: new Set(STOP_DE), en: new Set(STOP_EN) };

// Объединённый список остаётся для мест, где язык неизвестен. Пользоваться им
// там, где язык известен, нельзя — ровно из-за «war» и «man».
export const STOP = new Set([...STOP_DE, ...STOP_EN]);

export function stopWords(lang) {
  return STOP_BY_LANG[lang] ?? STOP;
}

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
export function findTopics({ metrics, thresholds, knownQueries = [], lang = 'de', onlyChannels = null }) {
  const known = new Set(knownQueries.map((q) => String(q).toLowerCase()));
  const minChannels = thresholds.topicMinChannels ?? 3;
  const minLift = thresholds.topicMinLift ?? 2.5;

  const sameLang = metrics.videos.filter((v) => metrics.channels[v.channelId]?.lang === lang
    && (!onlyChannels || onlyChannels.has(v.channelId)));
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

  // Знаменатель перевеса считаем одним проходом по корпусу. Раньше на каждого
  // кандидата корпус пересматривался целиком — сотни миллионов сравнений.
  const wanted = new Set(alive.map((e) => e.phrase));
  const df = new Map();
  for (const v of sameLang) {
    for (const p of new Set(phrases(v.title))) {
      if (wanted.has(p)) df.set(p, (df.get(p) ?? 0) + 1);
    }
  }

  const candidates = [];
  for (const e of alive) {
    if (known.has(e.phrase) || isBlocked(e.phrase, lang)) continue;
    const inAll = df.get(e.phrase) ?? 0;
    const lift = (e.videos / breakout.length) / Math.max(inAll / sameLang.length, 1e-9);
    if (!Number.isFinite(lift) || lift < minLift) continue;
    const words = e.phrase.split(' ').length;
    if (words === 1 && lift < (thresholds.topicSingleWordLift ?? 8)) continue;
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

// Правила по темам живут в config/policy.json, а не здесь: их правят по
// решению, а не по коду, и они должны быть на виду. Ограничений два и они
// разные. Первое — рынок, где тему не берём вовсе. Второе — пометка «реклама
// урезана»: тема разрешена, но оценка дохода по общей ставке для неё завышена,
// и об этом должно быть написано рядом с цифрой, а не в чьей-то памяти.
export const POLICY = readJson(join(ROOT, 'config/policy.json'), { blockedMarkets: {}, adLimited: {} });

// Слово ищем по границам, иначе «reich» поймает «erreicht», а «ss» — половину
// немецкого словаря.
function hits(phrase, words) {
  const t = ' ' + phrase.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + ' ';
  return (words ?? []).some((w) => t.includes(' ' + w.trim() + ' '));
}

export function isBlocked(phrase, lang) {
  const rule = POLICY.blockedMarkets?.[lang];
  return rule ? hits(phrase, rule.words) : false;
}

// Называет ли запрос ПРЕДМЕТ. Слова вроде «sleep», «relaxing», «stories»,
// «hours» задают настроение и формат, но не тему: под «documentary to fall
// asleep to» подходит дождь, ветер, музыка для медитации — что угодно.
// Ниша из такого запроса собирается из чужих видео, а её метрики описывают
// не тему, а весь жанр «под что засыпают».
//
// Отсюда и «спокойный космос»: канал-ориентир снимал спокойные научные факты,
// космос был у него третью роликов. Тянул формат, а тему приписали задним
// числом.
export function topicShape(keywords) {
  const mod = new Set(POLICY.topicShape?.modifiers ?? []);
  const subjects = (keywords ?? []).filter((w) => !mod.has(w));
  const modifiers = (keywords ?? []).filter((w) => mod.has(w));
  if (!keywords?.length) {
    return { subjects, modifiers, ok: false, reason: 'в запросе не осталось значимых слов' };
  }
  if (!subjects.length) {
    return { subjects, modifiers, ok: false,
             reason: 'запрос называет только формат и настроение (' + modifiers.join(', ')
                     + '), но не предмет — под него подходит что угодно' };
  }
  return { subjects, modifiers, ok: true, reason: null };
}

export function isAdLimited(phrase, group = null) {
  // Группа целиком: «pacific war» и «eastern front» под список слов не
  // подпадают, а ограничение по рекламе на них ровно то же.
  if (group && (POLICY.adLimited?.groups ?? []).includes(group)) return true;
  return hits(phrase, POLICY.adLimited?.words);
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
const FORMAT = { de: 'Doku', en: 'documentary' };

export function toQuery(phrase, lang = 'de') {
  return /doku|dokumentation|documentary/i.test(phrase)
    ? phrase : `${phrase} ${FORMAT[lang] ?? FORMAT.de}`;
}

// Автодобавление с потолком: за прогон приезжает не больше нескольких тем,
// иначе разведка расползётся и сожжёт квоту на случайных находках.
export function promote({ candidates, seeds, limit, lang = 'en', group = 'Найдено автоматом' }) {
  const ids = new Set(seeds.map((s) => s.id));
  const added = [];
  for (const c of candidates) {
    if (added.length >= limit) break;
    const id = slug(c.phrase);
    if (!id || ids.has(id)) continue;
    if (isBlocked(c.phrase, lang)) continue;
    // Обрывок заголовка темой не является. Автопоиск охотно приносил
    // «found something documentary» и «finish» — связка проходила по подъёму,
    // хотя предмета в ней нет.
    if (!topicShape(c.phrase.split(/\s+/)).ok) continue;
    ids.add(id);
    added.push({
      id, group,
      [lang]: toQuery(c.phrase, lang),
      ru: null,                      // подпись переведём отдельно
      source: 'auto',
      addedAt: new Date().toISOString().slice(0, 10),
      foundVia: { channels: c.channels, lift: c.lift, medianViews: c.medianViews },
    });
  }
  return added;
}
