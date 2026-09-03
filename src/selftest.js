// Проверка счётной части на синтетических данных: ключ для этого не нужен.
import { computeMetrics } from './metrics.js';
import { renderReport, score } from './report.js';
import { Quota, BudgetExhausted } from './quota.js';
import { Translator } from './translate.js';
import { explore, snapshot, survey, isMissing } from './collect.js';
import { isBlocked, isAdLimited, promote, stopWords, topicShape, phrases } from './topics.js';
import { queryKeywords, seedIndex, videoNiches, wordFrequency, nounEvidence, quantile, titleLanguage } from './metrics.js';
import { Quota as Q2 } from './quota.js';
import { renderBrief } from './brief.js';
import { buildFocus } from './focus.js';
import { readJson, ROOT } from './store.js';
import { join } from 'node:path';
import { median, dominantLang, channelBaseline, targetMonthlyViews } from './metrics.js';

let failed = 0;
const check = (name, cond) => {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${name}`);
  if (!cond) failed++;
};

// --- квота ---
const q = new Quota(250);
q.spend('search'); q.spend('search');
check('квота считает 2 поиска как 200 юнитов', q.spent === 200);
check('на третий поиск денег нет', !q.canAfford('search'));
check('на videos.list ещё хватает', q.canAfford('videos'));
try { q.spend('search'); check('перерасход кидает BudgetExhausted', false); }
catch (e) { check('перерасход кидает BudgetExhausted', e instanceof BudgetExhausted); }

check('медиана чётной длины', median([1, 2, 3, 4]) === 2.5);
check('медиана игнорирует пустые', median([]) === null);
check('язык канала — по большинству видео', dominantLang([{lang:'en-US'},{lang:'en'},{lang:'de'}]) === 'en');
check('язык не выводится из двух рынков', dominantLang([{}], ['de','en']) === null);

// --- правила по темам ---
// Ограничение теперь по рынку, а не общее: на немецком темы Третьего рейха не
// ищутся, на английском ищутся и помечаются как урезанные по рекламе.
check('военная тематика не идёт в немецкую разведку',
  isBlocked('hitler Doku', 'de') && isBlocked('drittes reich', 'de') && isBlocked('weltkrieg', 'de'));
check('на английском та же тема разрешена',
  !isBlocked('hitler documentary', 'en') && !isBlocked('world war 2 documentary', 'en'));
check('слово ловится по границе, а не по подстроке',
  !isBlocked('erreicht Doku', 'de') && !isAdLimited('warsaw architecture'));
check('обычные темы никуда не попадают',
  !isBlocked('dinosaur documentary', 'de') && !isAdLimited('dinosaur documentary'));
check('военная тематика помечена как урезанная по рекламе',
  isAdLimited('world war 2 documentary') && isAdLimited('hitler documentary') && isAdLimited('ww2 aircraft'));
check('запрещённое для рынка не попадает в разведку даже первым кандидатом',
  promote({ candidates: [{ phrase: 'hitler bunker', channels: 9, lift: 30 },
                         { phrase: 'tiefsee', channels: 4, lift: 5 }],
            seeds: [], limit: 2, lang: 'de' })
    .every((t) => !t.de.includes('hitler')));

// --- разведка вслепую ---
// Чарт mostPopular существует не для всех пар «страна + категория». 404 на
// отсутствующий чарт уронил ночной прогон целиком — это не должно повториться.
{
  const q = { spend() {}, canAfford: () => true };
  const db = { channels: {}, state: {} };
  const markets = { en: { regionCode: 'US' }, de: { regionCode: 'DE' } };
  const api = { quota: q, async trending({ videoCategoryId }) {
    if (videoCategoryId === '27') throw new Error('videos 404: Requested entity was not found.');
    return { items: [{ snippet: { channelId: 'ch' + videoCategoryId } }] };
  } };
  await explore({ api, db, markets, thresholds: { trendingCategories: ['27', '28'] } });
  check('отсутствующий чарт не роняет разведку', Object.keys(db.channels).length === 1);
  check('канал из trending заведён правильно',
    db.channels.ch28?.id === 'ch28' && Array.isArray(db.channels.ch28.seeds));

  const broken = { quota: q, async trending() { throw new Error('внезапная поломка'); } };
  const db2 = { channels: {}, state: {} };
  await explore({ api: broken, db: db2, markets, thresholds: { trendingCategories: ['28'] } });
  check('непредвиденная ошибка в необязательном слое не роняет прогон', true);
}

// --- переводчик ---
const fakeFetch = (body, ok = true) => async () => ({ ok, json: async () => body });
const okBody = { responseData: { translatedText: 'перевод' } };

{
  const t = new Translator({ fetchImpl: fakeFetch(okBody) });
  check('перевод возвращается', await t.translate('Sonnensystem', 'de') === 'перевод');
  check('второй раз берётся из кеша', await t.translate('Sonnensystem', 'de') === 'перевод');
  check('сеть дёрнута ровно один раз', t.stats.fetched === 1 && t.stats.hit === 1);
}
{
  // Предупреждение сервиса о лимите не должно осесть в кеше навсегда.
  const t = new Translator({ fetchImpl: fakeFetch({ responseData: { translatedText:
    'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY' } }) });
  check('предупреждение о лимите не выдаётся за перевод', await t.translate('Test', 'de') === null);
  check('после лимита сервис больше не дёргается', t.blocked === true);
  check('мусор не попал в кеш', Object.keys(t.cache).length === 0);
}
{
  const t = new Translator({ fetchImpl: fakeFetch(okBody), charBudget: 5 });
  check('длинное название не переводится сверх бюджета',
    await t.translate('очень длинное название ролика', 'de') === null);
  check('пропуск по бюджету посчитан', t.stats.skipped === 1);
}
{
  const t = new Translator({ fetchImpl: async () => { throw new Error('сеть недоступна'); } });
  check('падение сети не роняет прогон', await t.translate('Test', 'de') === null);
  check('падение сети посчитано как неудача', t.stats.failed === 1);
{
  // Пять неудач подряд — сервис лежит, дальше стучаться бессмысленно.
  const dead = new Translator({ fetchImpl: async () => { throw new Error('нет сети'); } });
  for (let i = 0; i < 5; i++) await dead.translate('текст' + i, 'de');
  check('после пяти неудач подряд переводчик отключается', dead.blocked === true);
  const before = dead.stats.failed;
  await dead.translate('ещё', 'de');
  check('отключённый переводчик больше не ходит в сеть', dead.stats.failed === before);
}
}

// --- синтетическая база ---
const now = '2026-08-18T00:00:00.000Z';
const day = (n) => new Date(Date.parse(now) - n * 86400000).toISOString();

const channels = {};
const videos = {};
const seeds = [{ id: 'open', group: 'Тест', de: 'offen', en: 'open' },
               { id: 'closed', group: 'Тест', de: 'gesperrt', en: 'closed' }];

// Ниша «open»: молодые каналы дают выбросы — дверь открыта.
for (let c = 0; c < 4; c++) {
  const id = `young${c}`;
  channels[id] = { id, title: `Jung ${c}`, seeds: ['open'], markets: ['de'],
                   firstUploadAt: day(200), firstUploadComplete: true, publishedAt: day(200), subscribers: 900 };
  for (let v = 0; v < 12; v++) {
    videos[`${id}v${v}`] = { id: `${id}v${v}`, channelId: id, title: `offen Folge ${v}`,
      publishedAt: day(40 + v * 10), durationSec: 1500, views: 150000, likes: 6000, comments: 600, lang: 'de' };
  }
  // один выброс — ×10 к медиане
  videos[`${id}hit`] = { id: `${id}hit`, channelId: id, title: `offen Treffer ${c}`,
    publishedAt: day(20), durationSec: 1800, views: 1500000, likes: 60000, comments: 4500, lang: 'de' };
}

// Ниша «closed»: выбросы только у старых каналов — дверь закрыта.
for (let c = 0; c < 3; c++) {
  const id = `old${c}`;
  channels[id] = { id, title: `Alt ${c}`, seeds: ['closed'], markets: ['de'],
                   firstUploadAt: day(2000), firstUploadComplete: true, publishedAt: day(2000), subscribers: 1500000 };
  for (let v = 0; v < 12; v++) {
    videos[`${id}v${v}`] = { id: `${id}v${v}`, channelId: id, title: `gesperrt Folge ${v}`,
      publishedAt: day(40 + v * 10), durationSec: 1500, views: 250000, likes: 7500, comments: 600, lang: 'de' };
  }
  videos[`${id}hit`] = { id: `${id}hit`, channelId: id, title: `gesperrt Treffer alt ${c}`,
    publishedAt: day(20), durationSec: 1800, views: 2500000, likes: 75000, comments: 4500, lang: 'de' };
}

const thresholds = { minDurationSec: 480, medianMinVideoAgeDays: 30, velocityMaxVideoAgeDays: 60,
  snapshotMaxAgeDays: 150, medianMinMatureVideos: 5,
  targetMonthlyUsd: 2000, rpmUsd: 5, breakoutViews: 100000, workingViews: 20000,
  outlierRatio: 3, outlierMinViews: 20000, youngChannelDays: 365,
  conveyorMinutesPerWeek: 180 };

const snapshots = [
  { date: day(7), videos: { young0hit: [1000000] } },
  { date: day(0), videos: { young0hit: [1500000] } },
];

const current = {};
for (const [id, v] of Object.entries(videos)) {
  current[id] = [v.views, v.likes, v.comments];
  delete v.views; delete v.likes; delete v.comments;
}

const m = computeMetrics({ db: { channels, videos, current }, seeds, thresholds, snapshots, now, primaryLang: 'de' });

check('база канала — медиана зрелых видео', m.channels.young0.medianViews === 150000);
check('тощая база не даёт медианы',
  channelBaseline([{ publishedAt: day(100), views: 5 }, { publishedAt: day(90), views: 7 }],
                  thresholds, now).medianViews === null);
check('выброс посчитан как ×10', Math.round(m.videos.find((v) => v.id === 'young0hit').outlierRatio) === 10);
check('доход канала оценён в деньгах', m.channels.young0.monthlyUsd > 2000);
check('канал признан состоявшимся', m.channels.young0.earning === true);
check('ниша open полностью проницаема', m.niches.open.permeability === 1);
check('ниша closed непроницаема', m.niches.closed.permeability === 0);
check('выбросы схлопнуты по каналам', m.niches.open.outlierChannels === 4);
check('молодых каналов пробилось 4', m.niches.open.youngOutlierChannels === 4);
check('у старой ниши молодых нет', m.niches.closed.youngOutlierChannels === 0);
check('длина выброса измерена', m.niches.open.medianOutlierMinutes === 30);
// Ниша, где пробился один-единственный канал, в рейтинг попадать не должна:
// это может быть везение конкретного канала, а не открытая дверь.
check('одиночный выброс не считается нишей',
  score({ permeability: 1, outlierChannels: 1, youngOutlierChannels: 1,
          medianOutlierViews: 500000, conveyorShare: 0, medianLikeRate: 0.04 }) === null);
check('скорость роста взята из снапшотов', m.videos.find((v) => v.id === 'young0hit').velocity != null);
check('open ранжируется выше closed', score(m.niches.open) > score(m.niches.closed));
check('доверие честно занижено при 2 снапшотах', /низкая/.test(m.niches.open.confidence));

// Возраст канала на момент выстрела: 200 дней жизни минус 20 дней назад = 180.
check('возраст канала на момент выстрела',
  Math.round(m.videos.find((v) => v.id === 'young0hit').channelAgeAtUploadDays) === 180);

const md = renderReport(m, seeds);
check('отчёт содержит рейтинг', md.includes('## Рейтинг'));
check('отчёт содержит сравнение рынков', md.includes('Немецкий против английского'));
check('отчёт ставит open первым', md.indexOf('**open**') < md.indexOf('**closed**'));

// Недолистанный архив: возраст обязан падать обратно на дату регистрации,
// иначе канал притворится молодым и раздует проницаемость ниши.
const partial = computeMetrics({
  db: {
    channels: { p1: { id: 'p1', seeds: ['open'], markets: ['de'],
                      firstUploadAt: day(30), firstUploadComplete: false, publishedAt: day(3000) } },
    videos: { p1v: { id: 'p1v', channelId: 'p1', title: 'offen p1', publishedAt: day(60), durationSec: 1500, lang: 'de' } },
    current: { p1v: [10000, 100, 10] },
  },
  seeds, thresholds, snapshots: [], now, primaryLang: 'de',
});
check('недолистанный архив не омолаживает канал',
  Math.round(partial.channels.p1.ageDays) === 3000);
check('основа возраста названа честно',
  partial.channels.p1.ageBasis === 'регистрация канала');

// Конвейер: канал, выпускающий больше трёх часов готового видео в неделю.
// Возраст тут ни при чём — важен физически невозможный объём.
const conveyor = { publishedAt: day(400), firstUploadComplete: false, seeds: ['open'], markets: ['de'] };
const cv = {}, ccur = {};
for (let i = 0; i < 60; i++) {            // 60 роликов по два часа за 90 дней
  cv['c' + i] = { id: 'c' + i, channelId: 'c1', title: 'offen c' + i, publishedAt: day(i + 5), durationSec: 7200, lang: 'de' };
  ccur['c' + i] = [30000, 200, 10];
}
const conv = computeMetrics({ db: { channels: { c1: { id: 'c1', ...conveyor } }, videos: cv, current: ccur },
  primaryLang: 'de',
                              seeds, thresholds, snapshots: [], now });
// Лотерейный канал: двести роликов, один выстрел. Он не должен считаться
// пробившимся — иначе ниша выглядит открытой из-за чужого везения.
const lot = computeMetrics({
  db: {
    channels: { L: { id: 'L', seeds: ['open'], markets: ['de'],
                     firstUploadAt: day(200), firstUploadComplete: true, publishedAt: day(200) } },
    videos: Object.fromEntries(Array.from({ length: 40 }, (_, i) =>
      ['L' + i, { id: 'L' + i, channelId: 'L', title: 'offen L' + i, publishedAt: day(40 + i), durationSec: 1500, lang: 'de' }])),
    current: Object.fromEntries(Array.from({ length: 40 }, (_, i) => ['L' + i, [i === 0 ? 90000 : 900, 10, 1]])),
  },
  seeds, thresholds, snapshots: [], now, primaryLang: 'de',
});
check('видео без темы в заголовке в нишу не попадает',
  lot.videos.every((v) => v.seeds.includes('open')));
check('одиночный выстрел не выводит канал на цель', lot.channels.L.earning === false);
check('такой канал помечен как недотягивающий', lot.channels.L.lottery === true);
check('ниша из лотерейных каналов не проницаема', lot.niches.open.permeability === null);
check('доля недотягивающих посчитана', lot.niches.open.lotteryShare === 1);
check('цель в просмотрах выведена из денег', targetMonthlyViews(thresholds) === 400000);

check('конвейер пойман по объёму хронометража', conv.niches.open.conveyorShare === 1);
check('минуты в неделю посчитаны', Math.round(conv.channels.c1.minutesPerWeek) === 560);

// --- бриф для другого чата ---
// Бриф собирается из payload сайта, где часть полей — объекты. Один такой
// в шаблоне даёт [object Object] и незаметно уезжает в файл, который читает
// другой чат. Проверяем, что текст остаётся текстом.
const brief = renderBrief({
  computedAt: now,
  snapshotDays: 5,
  dbSize: { channels: 12, videos: 340 },
  seedsDone: 7, seedsTotal: 9,
  // Пороги берём настоящие: бриф расшифровывает по ним метрики, и на
  // урезанном наборе проверка «нет пустых подстановок» ловила бы фикстуру,
  // а не код.
  thresholds: readJson(join(ROOT, 'config/thresholds.json')),
  headline: 'Заголовок',
  markets: { de: { channels: 5, young: 4, youngEarning: 1, youngRate: 0.25 },
             en: { channels: 7, young: 6, youngEarning: 3, youngRate: 0.5 } },
  verdict: [{
    id: 'open', lang: 'en', market: 'английский', query: 'open documentary', ru: 'открытая тема',
    fresh: 24805, freshOver20k: 0.62, young: 5, usd: 777, nicheChannels: 16, minutes: 42,
    why: 'почему', risk: 'риск',
    effort: { hoursPerWeek: 5.5, hoursPerMonth: 24, minutes: 42 },
    rivals: [{ title: 'Канал', age: 114, exact: true, subs: 18600, usd: 1969, fresh: 32443,
               inNiche: 32, videos: 49, young: true }],
  }],
  examples: { open: { en: [{ title: 'Title', titleRu: 'Заголовок', views: 73506, minutes: 30,
                             channel: 'Канал', channelAge: 74, earning: true, usd: 1969 }] } },
  archetypes: [{ channels: 4, young: 3, fastestDays: 91, medianUsd: 7685, medianCatalog: 63,
                 medianMinutesPerWeek: 102, topics: [{ topic: 'ancient', channels: 4 }],
                 examples: [{ title: 'Mack' }] }],
  pending: [{ query: 'whales documentary', ru: null, lang: 'en', channels: 4, fresh: 32852 }],
});
check('бриф не содержит невыведенных объектов', !brief.includes('[object'));
// Ниша под урезанной рекламой должна нести предупреждение рядом с цифрой
// дохода — иначе оценка по общей ставке читается как обещание.
const briefWar = renderBrief({
  computedAt: now, snapshotDays: 5, dbSize: { channels: 12, videos: 340 },
  seedsDone: 7, seedsTotal: 9, thresholds: readJson(join(ROOT, 'config/thresholds.json')),
  headline: 'Заголовок', markets: {}, examples: {}, archetypes: [], pending: [],
  adLimitedWhy: 'Реклама там ограничена.',
  verdict: [{ id: 'ww2-doku', lang: 'en', market: 'английский', query: 'world war 2 documentary',
              ru: 'Вторая мировая', adLimited: true, fresh: 9000, freshOver20k: 0.2, young: 3,
              usd: 900, nicheChannels: 20, minutes: 40, why: 'почему', risk: 'риск', rivals: [] }],
});
check('ниша с урезанной рекламой предупреждает об этом',
  briefWar.includes('Реклама урезана') && briefWar.includes('завышен'));
check('бриф не содержит пустых подстановок', !brief.includes('undefined') && !brief.includes('NaN'));
check('в брифе есть правила по темам', brief.includes('только на английском') && brief.includes('§86a'));
check('в брифе есть таблица конкурентов', brief.includes('Канал') && brief.includes('32 из 49'));
check('трудозатраты выведены текстом', brief.includes('5.5 ч готового видео в неделю'));
check('в брифе стоит ссылка на свежий срез', brief.includes('docs/brief.md'));

// --- разбор запроса в ключевые слова ---
// Общий список служебных слов съедал содержательные: немецкое «war» (был)
// убивало английское «war» (война), и от «world war 2 documentary» оставалось
// одно «world».
check('английское war переживает разбор', queryKeywords('world war 2 documentary', 'en').includes('war'));
check('немецкое war отсеивается как служебное', !queryKeywords('war Doku', 'de').length);
check('формат вычищается', !queryKeywords('antarctica documentary', 'en').includes('documentary'));
check('голая цифра не становится словом', !queryKeywords('world war 2', 'en').includes('2'));
check('списки служебных слов разные', stopWords('en').has('the') && !stopWords('en').has('war')
      && stopWords('de').has('war'));

// --- привязка видео к теме ---
// Проверка подстрокой засчитывала «world» внутри «underworld».
{
  const idx = seedIndex([{ id: 'ww2', en: 'world war 2 documentary' },
                         { id: 'dino', en: 'dinosaur documentary' }], ['en'], {});
  const hit = (t) => videoNiches(t.toLowerCase(), idx, 'en');
  check('тема ловится, когда слова запроса на месте', hit('The Last Days of World War II').includes('ww2'));
  check('множественное число не мешает', hit('Giant Dinosaurs Explained').includes('dino'));
  check('якорь внутри чужого слова не считается',
    !hit('Vyacheslav Ivankov, King of the Russian Underworld').includes('ww2'));
  check('одного слова из запроса мало',
    !hit('Animals Of The World 4K - Scenic Wildlife Film').includes('ww2'));
}

// --- выбор якорей ---
// Частоты приходили из db.channels, где языка нет вовсе: обе карты выходили
// пустыми, и «два самых редких слова» вырождалось в «первые два». Разные темы
// про засыпание получали одни якоря и один список видео на всех.
{
  const chans = { c1: { lang: 'en' } };
  const wf = wordFrequency([{ channelId: 'c1', title: 'sleep sleep sleep story' }], chans);
  check('частоты слов считаются, когда язык канала известен', wf.en.size > 0);
  check('частоты пусты, когда языка нет', wordFrequency([{ channelId: 'c1', title: 'x yyy' }], { c1: {} }).en.size === 0);
  const idx = seedIndex([{ id: 'a', en: 'documentary to fall asleep to' },
                         { id: 'b', en: 'sleep stories for adults' }], ['en'], {});
  const same = JSON.stringify(idx.en[0].anchors) === JSON.stringify(idx.en[1].anchors);
  check('разные темы не получают одинаковые якоря', !same);
  check('в якоря идут все значимые слова запроса',
    idx.en[1].anchors.length === queryKeywords('sleep stories for adults', 'en').length);
}

// --- броня квоты ---
// Разведка тратит по 100 юнитов и раньше съедала бюджет до снапшота: срез
// обрывался на 72 000 видео из 95 000, и всё найденное за день оставалось
// без цифр.
{
  const q = new Q2(300);
  q.reserve(250);
  check('до брони обычный слой не дотягивается', q.canAfford('search') === false);
  check('броня доступна тому, кто её просил', q.canAfford('search', { useReserve: true }) === true);
  q.spend('search', { useReserve: true });
  check('трата из брони списывается с общего счёта', q.spent === 100);
  check('остаток без брони считается честно', q.remaining() === -50);
  check('остаток с бронёй показывает, сколько ещё можно снять',
        q.remaining({ useReserve: true }) === 200);
  let threw = false;
  try { new Q2(100).reserve(90), (() => { const z = new Q2(100); z.reserve(90); z.spend('search'); })(); }
  catch (e) { threw = e instanceof BudgetExhausted; }
  check('попытка залезть в броню кидает BudgetExhausted', threw);
}

// --- порядок обхода в снапшоте ---
// Срез шёл по базе с начала и обрывался на остатке бюджета всегда в одном и
// том же месте. Новые видео дописываются в конец — и не получали цифр никогда.
{
  const mk = (id, ageDays) => [id, { id, channelId: 'c', title: id,
    publishedAt: new Date(Date.parse(now) - ageDays * 86400000).toISOString(), durationSec: 900 }];
  const vids = Object.fromEntries([
    ...Array.from({ length: 60 }, (_, i) => mk('old' + i, 400)),
    ...Array.from({ length: 40 }, (_, i) => mk('new' + i, 10)),
  ]);
  const asked = [];
  const q = new Q2(1);                      // хватает ровно на один вызов: 50 роликов из 100
  const api = { quota: q, videos: async (ids, opts) => {
    asked.push(...ids);
    q.spend('videos', opts);                // api.call тратит юнит сам
    return { items: ids.map((id) => ({ id, statistics: { viewCount: '100' } })) };
  } };
  const dbs = { videos: vids, current: {}, state: {} };
  const hist = await snapshot({ api, db: dbs, thresholds: { snapshotMaxAgeDays: 150 } });
  check('молодые ролики обходятся первыми', asked.slice(0, 40).every((id) => id.startsWith('new')));
  check('за один вызов ушло ровно 50 роликов', asked.length === 50);
  check('в историю попали только молодые', Object.keys(hist).every((id) => id.startsWith('new')));
  check('старые тоже обходятся, но после молодых', asked.some((id) => id.startsWith('old')));
  check('курсор по старым сдвинулся', (dbs.state.snapshotCursor ?? 0) > 0);

  // Второй прогон должен продолжить с того места, где кончился первый.
  const asked2 = [];
  const q2 = new Q2(1);
  const api2 = { quota: q2, videos: async (ids, opts) => {
    asked2.push(...ids); q2.spend('videos', opts);
    return { items: ids.map((id) => ({ id, statistics: { viewCount: '100' } })) };
  } };
  await snapshot({ api: api2, db: dbs, thresholds: { snapshotMaxAgeDays: 150 } });
  const oldFirst = asked.filter((id) => id.startsWith('old'));
  const oldSecond = asked2.filter((id) => id.startsWith('old'));
  check('второй прогон берёт другие старые ролики',
    oldSecond.length > 0 && oldSecond.some((id) => !oldFirst.includes(id)));
}

// --- запрос обязан называть предмет ---
// «documentary to fall asleep to» описывает настроение, а не тему: под него
// подходит дождь, ветер и музыка для медитации. Метрики такой ниши описывают
// весь жанр, а не тему, и квоту на неё тратить незачем.
{
  const shape = (q, l) => topicShape(queryKeywords(q, l));
  check('запрос из одного настроения темой не считается',
    !shape('documentary to fall asleep to', 'en').ok);
  check('аудитория предметом не является', !shape('sleep stories for adults', 'en').ok);
  check('обрывок заголовка предметом не является',
    !shape('found something documentary', 'en').ok && !shape('finish documentary', 'en').ok);
  check('предмет с настроением — это тема', shape('space to fall asleep to', 'en').ok);
  check('предмет выделен из настроения',
    shape('space to fall asleep to', 'en').subjects.join() === 'space');
  check('обычная тема проходит', shape('antarctica documentary', 'en').ok
        && shape('dinosaur documentary', 'en').ok);
  check('немецкая тема с настроением проходит', shape('Weltraum zum Einschlafen', 'de').ok);
  check('у широкого запроса есть объяснение', typeof shape('finish documentary', 'en').reason === 'string');
  check('автопоиск не берёт запрос без предмета',
    promote({ candidates: [{ phrase: 'found something', channels: 9, lift: 30 },
                           { phrase: 'ancient egypt', channels: 4, lift: 5 }],
              seeds: [], limit: 2, lang: 'en' })
      .every((t) => !t.en.includes('found something')));
}

// --- немецкое слово: существительное или нет ---
// Списком слов немецкий мусор не переберёшь. Зато существительные пишутся
// с большой буквы, и корпус это показывает: Einsatz, Giganten, Weltraum —
// 100% заглавных; gebaut, spannende, grausamste — 13–20%.
{
  const titles = [];
  for (let i = 0; i < 12; i++) {
    titles.push({ title: 'Wie der Einsatz der Maschinen gebaut wurde' });
    titles.push({ title: 'Der grosse Einsatz und die spannende Geschichte' });
  }
  const ev = nounEvidence(titles);
  const share = (w) => (ev.cap.get(w) ?? 0) / (ev.tot.get(w) ?? 1);
  check('существительное распознано по регистру', share('einsatz') > 0.9 && share('maschinen') > 0.9);
  check('глагол и прилагательное — нет', share('gebaut') < 0.2 && share('spannende') < 0.2);
  check('запрос без существительного отсеивается',
    !topicShape(['gebaut'], { lang: 'de', nouns: ev }).ok);
  check('запрос с существительным проходит',
    topicShape(['einsatz'], { lang: 'de', nouns: ev }).ok);
  // «wurde» в фикстуре стоит со строчной, но правило регистра — только для
  // немецкого: в английском Title Case заглавные ни о чём не говорят.
  check('немецкое правило ловит и слово вне списка',
    !topicShape(['wurde'], { lang: 'de', nouns: ev }).ok);
  check('английский этим правилом не судим',
    topicShape(['wurde'], { lang: 'en', nouns: ev }).ok);
  check('слово без набранной статистики не судим',
    topicShape(['zeppelin'], { lang: 'de', nouns: ev }).ok);
}

// --- связка только из соседних слов ---
// Служебные слова схлопывались, и связка перепрыгивала через них: из
// «Most Beautiful Place on Earth» получалось «place earth» — обрывок шаблона
// с высоким подъёмом, уезжавший в разведку как тема.
{
  const p1 = phrases('Most Beautiful Place on Earth');
  check('связка через служебное слово не собирается', !p1.includes('place earth'));
  check('соседние слова связкой остаются', p1.includes('beautiful place'));
  const p2 = phrases('The Great White Shark Hunt');
  check('длинная связка из соседних слов цела', p2.includes('great white shark'));
  check('одиночные слова остаются', p2.includes('shark'));
}

// --- фокусная ниша ---
// Вопрос по своей нише другой, чем по чужим: не «куда идти», а «что сейчас
// происходит». Значит суточный прирост и ускорение, а не медианы за три месяца.
{
  const day = (n) => new Date(Date.parse(now) - n * 86400000).toISOString();
  const chan = { c1: { id: 'c1', title: 'Космо', lang: 'en', ageDays: 100, monthlyUsd: 900,
                       subscribers: 1000, catalogCount: 40 } };
  const mk = (id, t, views, age) => ({ id, channelId: 'c1', title: t, views, ageDays: age,
                                       durationSec: 1800, seeds: ['sp'], publishedAt: day(age) });
  const metrics = {
    thresholds: { youngChannelDays: 365 },
    channels: chan,
    videos: [mk('v1', 'Nebula collapse explained', 10000, 10),
             mk('v2', 'Ancient star map found', 5000, 200)],
  };
  // Три среза: у v1 прирост вчера 100, сегодня 900 — это ускорение в девять раз.
  const snapshots = [
    { date: day(2), videos: { v1: [9000], v2: [4900] } },
    { date: day(1), videos: { v1: [9100], v2: [4950] } },
    { date: day(0), videos: { v1: [10000], v2: [5000] } },
  ];
  const f = buildFocus({
    metrics, snapshots,
    seeds: [{ id: 'sp', group: 'Космос', en: 'space documentary', ru: 'космос' }],
    focus: { id: 'space', label: 'Космос', groups: ['Космос'], lang: 'en',
             breakingMinPerDay: 100, listSize: 10, freshDays: 14 },
  });
  check('фокус собирает ролики своей группы', f.videoCount === 2);
  check('суточный прирост считается по последним двум срезам',
    Math.round(f.rising[0].perDay) === 900);
  check('ускорение считается против предыдущего отрезка',
    f.rising[0].accel === 9);
  check('в «резко пошло» попадает ускорившийся ролик',
    f.breaking.length === 1 && f.breaking[0].id === 'v1');
  check('ролик с малым приростом в «резко пошло» не идёт',
    !f.breaking.some((r) => r.id === 'v2'));
  check('в «только вышло» только свежие', f.fresh.every((r) => r.age <= 14));
  check('старый ролик в свежие не попал', !f.fresh.some((r) => r.id === 'v2'));
  check('канал сведён по роликам темы',
    f.channels.length === 1 && f.channels[0].videos === 2);
  check('без настроенных групп фокуса нет', buildFocus({ metrics, snapshots, seeds: [], focus: {} }) === null);
}

// --- бриф не ломает таблицы чужими заголовками ---
// «Space Odyssey | Discovery Channel» добавляет столбцы в markdown-таблицу.
{
  const b = renderBrief({
    computedAt: now, snapshotDays: 5, dbSize: { channels: 1, videos: 1 },
    seedsDone: 1, seedsTotal: 1, thresholds: readJson(join(ROOT, 'config/thresholds.json')),
    headline: '', markets: {}, examples: {}, archetypes: [], pending: [], verdict: [],
    focus: { label: 'Космос', why: 'зачем', videoCount: 1, measured: 1, channelCount: 1,
             topics: [], hot: [], channels: [], fresh: [], rising: [],
             breaking: [{ id: 'v1', title: 'A | B | C', titleRu: null, channel: 'D | E',
                          young: false, age: 3, views: 10, perDay: 5, accel: 2 }] },
  });
  const line = b.split('\n').find((l) => l.includes('A \\| B'));
  check('вертикальная черта в заголовке экранирована', !!line);
  check('в строке таблицы ровно столько столбцов, сколько в шапке',
    !!line && (line.match(/(?<!\\)\|/g) || []).length === 7);
}

// --- верх распределения, а не только середина ---
// Медиана на степенном распределении описывает поток однотипных роликов, а не
// то, чего можно добиться: в «antarctica» верхний свежий ролик собрал 566 558,
// нижний 7, медиана 2 462. Считаем и верхнюю четверть, и потолок, и — главное —
// повторяемость по РАЗНЫМ каналам.
{
  check('квантиль на краях', quantile([1, 2, 3, 4, 5], 0) === 1 && quantile([1, 2, 3, 4, 5], 1) === 5);
  check('верхняя четверть считается с интерполяцией', quantile([1, 2, 3, 4, 5], 0.75) === 4);
  check('медиана и квантиль сходятся', quantile([1, 2, 3, 4, 5], 0.5) === 3);
  check('пустой массив не ломает', quantile([], 0.5) === null);

  const day = (n) => new Date(Date.parse(now) - n * 86400000).toISOString();
  // 24 свежих ролика: 16 слабых у одного конвейера и 8 сильных у восьми разных
  // новичков. Медиана обязана остаться низкой, верхняя четверть — подняться,
  // а повторяемость считаться по каналам: 8 из 9, а не 8 из 24.
  const channels = { farm: { id: 'farm', seeds: ['open'], markets: ['de'],
                             firstUploadAt: day(100), firstUploadComplete: true, publishedAt: day(100) } };
  const videos = {}, current = {};
  for (let i = 0; i < 16; i++) {
    videos['f' + i] = { id: 'f' + i, channelId: 'farm', title: 'offen f' + i,
                        publishedAt: day(20 + i), durationSec: 1500, lang: 'de' };
    current['f' + i] = [300, 1, 1];
  }
  for (let i = 0; i < 8; i++) {
    const cid = 'good' + i;
    channels[cid] = { id: cid, seeds: ['open'], markets: ['de'], firstUploadAt: day(120),
                      firstUploadComplete: true, publishedAt: day(120) };
    videos['g' + i] = { id: 'g' + i, channelId: cid, title: 'offen g' + i,
                        publishedAt: day(30), durationSec: 1500, lang: 'de' };
    current['g' + i] = [90000, 100, 10];
  }
  const mm = computeMetrics({ db: { channels, videos, current }, seeds, thresholds,
                              snapshots: [], now, primaryLang: 'de' });
  const st = mm.niches.open.byMarket.de;
  check('медиана прижата конвейером', st.freshViews === 300);
  check('верхняя четверть видит сильные ролики', st.freshTop === 90000);
  check('потолок ниши — лучший ролик', st.freshBest === 90000);
  check('каналов в выборке посчитано девять', st.freshChannels === 9);
  check('планку взяли восемь РАЗНЫХ каналов, а не восемь роликов из 24',
    st.freshWinners === 8);
  check('доля по роликам заметно ниже доли по каналам',
    st.freshOverWorking < st.freshWinners / st.freshChannels);
}

// --- старый канал под видом нового ---
// «Моложе года» меряется от первой загрузки. Аккаунт, заведённый двенадцать лет
// назад и оживший полгода назад, проходит как новичок — хотя у него мог
// остаться прежний зритель. Такие не должны идти в доказательство
// «сюда пускают новичка».
{
  const day = (n) => new Date(Date.parse(now) - n * 86400000).toISOString();
  const chan = (id, first, reg, complete = true) => ({
    id, seeds: ['open'], markets: ['de'],
    firstUploadAt: day(first), firstUploadComplete: complete, publishedAt: day(reg),
  });
  const channels = {
    fresh: chan('fresh', 100, 110),      // завели и сразу начали
    warm: chan('warm', 100, 4000),       // аккаунт простоял одиннадцать лет
    unknown: chan('unknown', 100, 4000, false), // архив не долистан
  };
  const videos = {}, current = {};
  for (const id of ['fresh', 'warm', 'unknown']) {
    for (let i = 0; i < 12; i++) {
      videos[id + i] = { id: id + i, channelId: id, title: 'offen ' + id + i,
                         publishedAt: day(20 + i), durationSec: 1500, lang: 'de' };
      current[id + i] = [90000, 100, 10];
    }
  }
  const mm = computeMetrics({ db: { channels, videos, current }, seeds, thresholds,
                              snapshots: [], now, primaryLang: 'de' });
  check('канал, заведённый перед стартом, — чистый старт',
    mm.channels.fresh.cleanStart === true && mm.channels.fresh.dormantDays < 30);
  check('оживший старый аккаунт помечен перезапуском',
    mm.channels.warm.cleanStart === false && Math.round(mm.channels.warm.dormantDays) === 3900);
  check('оба канала с долистанным архивом считаются молодыми',
    mm.channels.fresh.ageDays <= thresholds.youngChannelDays
    && mm.channels.warm.ageDays <= thresholds.youngChannelDays);
  // Архив не долистан — возраст берётся от регистрации, и канал уходит
  // в старые. Это безопасная сторона ошибки: лучше не засчитать новичка,
  // чем выдать старожила за новичка.
  check('без долистанного архива канал молодым не считается',
    mm.channels.unknown.ageDays > thresholds.youngChannelDays);
  check('без долистанного архива о простое не судим',
    mm.channels.unknown.cleanStart === null && mm.channels.unknown.dormantDays === null);
  const st = mm.niches.open.byMarket.de;
  check('планку взяли оба молодых канала', st.freshWinners === 2);
  check('в доказательство идут только чистые старты', st.freshWinnersClean === 1);
  check('молодые с доходом тоже разделены',
    st.youngOutlierChannels === 2 && st.youngCleanChannels === 1);
}

// --- спрос темы считается по ВСЕМ каналам, а не только по молодым ---
// Одно усреднённое число врало по форме: разброс внутри ниши доходит до
// двадцати пяти раз, и ниша с настоящим трафиком выглядела мёртвой.
{
  const day = (n) => new Date(Date.parse(now) - n * 86400000).toISOString();
  const channels = {
    big: { id: 'big', seeds: ['open'], markets: ['de'], firstUploadAt: day(3000),
           firstUploadComplete: true, publishedAt: day(3000) },
    small: { id: 'small', seeds: ['open'], markets: ['de'], firstUploadAt: day(100),
             firstUploadComplete: true, publishedAt: day(105) },
  };
  const videos = {}, current = {};
  // Старый канал: 10 роликов по 200 000. Новичок: 9 по 100 и один на 150 000.
  for (let i = 0; i < 10; i++) {
    videos['B' + i] = { id: 'B' + i, channelId: 'big', title: 'offen B' + i,
                        publishedAt: day(20 + i), durationSec: 1500, lang: 'de' };
    current['B' + i] = [200000, 100, 10];
    videos['S' + i] = { id: 'S' + i, channelId: 'small', title: 'offen S' + i,
                        publishedAt: day(20 + i), durationSec: 1500, lang: 'de' };
    current['S' + i] = [i === 0 ? 150000 : 100, 10, 1];
  }
  const mm = computeMetrics({ db: { channels, videos, current }, seeds, thresholds,
                              snapshots: [], now, primaryLang: 'de' });
  const st = mm.niches.open.byMarket.de;
  check('спрос считается по всем каналам', st.demandSample === 20);
  check('штуки, а не проценты', st.demandOverWorking === 11 && st.demandOverBreakout === 11);
  check('потолок темы — по всем каналам', st.demandBest === 200000);
  check('ступени покрывают всю выборку',
    st.buckets.reduce((n, b) => n + b.all, 0) === 20);
  check('в ступенях отдельно видны новички',
    st.buckets.find((b) => b.lo === 100000).newcomer === 1
    && st.buckets.find((b) => b.lo === 0).newcomer === 9);
  check('старый канал в счёт новичков не идёт',
    st.buckets.reduce((n, b) => n + b.newcomer, 0) === 10);
  const b = st.freshBestNewcomer;
  check('живой пример — лучший ролик новичка, а не старого канала',
    b && b.views === 150000 && b.channelId === 'small');
  check('в примере есть возраст канала и подписчики',
    b.channelAge != null && 'subs' in b);
}

// --- диапазон и возрастные когорты ---
// «Моложе года» прячет пятикратную разницу между «создан вчера» и «полгода»,
// а одна точка вместо диапазона врёт на степенном распределении.
{
  const day = (n) => new Date(Date.parse(now) - n * 86400000).toISOString();
  const mk = (id, age) => ({ id, seeds: ['open'], markets: ['de'], firstUploadAt: day(age),
                             firstUploadComplete: true, publishedAt: day(age + 5) });
  const channels = { a: mk('a', 40), b: mk('b', 200), c: mk('c', 2000) };
  const videos = {}, current = {};
  for (const [cid, views] of [['a', 500], ['b', 5000], ['c', 50000]]) {
    for (let i = 0; i < 12; i++) {
      videos[cid + i] = { id: cid + i, channelId: cid, title: 'offen ' + cid + i,
                          publishedAt: day(20 + i), durationSec: 1500, lang: 'de' };
      current[cid + i] = [views * (i < 3 ? 60 : 1), 10, 1];
    }
  }
  const mm = computeMetrics({ db: { channels, videos, current }, seeds, thresholds,
                              snapshots: [], now, primaryLang: 'de' });
  const st = mm.niches.open.byMarket.de;
  const co = Object.fromEntries(st.cohorts.map((c) => [c.label, c]));
  check('когорты разложены по возрасту канала',
    co['канал 0–3 мес'].n === 12 && co['канал 6–12 мес'].n === 12 && co['старше года'].n === 12);
  check('типичный ролик растёт с возрастом канала',
    co['канал 0–3 мес'].median < co['канал 6–12 мес'].median
    && co['канал 6–12 мес'].median < co['старше года'].median);
  check('пустая когорта молчит, а не выдумывает',
    co['канал 3–6 мес'].n === 0 && co['канал 3–6 мес'].median === null);
  check('верхние 10% видят выстреливший ролик', co['канал 0–3 мес'].top > co['канал 0–3 мес'].median);
  // Диапазон строится только по молодым с чистым стартом: канал c старше года.
  check('диапазон — это два числа, а не одно',
    st.rangeLo != null && st.rangeHi != null && st.rangeHi > st.rangeLo);
  check('в диапазон идут только молодые каналы', st.rangeN === 24);
  check('нижняя граница ниже верхней десятой доли', st.rangeLo < st.rangeHi);
}

// --- исчезнувший канал не должен ронять прогон ---
// Канал могли удалить или закрыть между разведкой и опросом: его плейлист
// загрузок отдаёт 404. Прогоны 25 и 28 августа умерли ровно на этом, потратив
// по четыре тысячи юнитов.
{
  check('404 распознаётся как пропавший ресурс',
    isMissing(new Error('playlistItems 404: not found')));
  check('прочие ошибки пропавшими не считаются',
    !isMissing(new Error('playlistItems 500: server error')) && !isMissing(new Error('сеть')));

  const db = {
    channels: {
      dead: { id: 'dead', uploadsPlaylistId: 'UUdead', videoCount: 10 },
      live: { id: 'live', uploadsPlaylistId: 'UUlive', videoCount: 10 },
    },
    videos: {}, current: {}, state: {},
  };
  const q = new Q2(500);
  const api = {
    quota: q,
    channels: async () => { q.spend('channels'); return { items: [] }; },
    playlistItems: async (pid) => {
      q.spend('playlistItems');
      if (pid === 'UUdead') throw new Error('playlistItems 404: The playlist cannot be found.');
      return { items: [{ contentDetails: { videoId: 'v1', videoPublishedAt: now } }] };
    },
  };
  let threw = null;
  const pending = await survey({ api, db, thresholds: { maxChannelsSurveyedPerRun: 10,
    maxUploadPagesNewChannel: 10, medianSamplePages: 2 } })
    .catch((e) => { threw = e; return null; });
  check('прогон переживает исчезнувший канал', threw === null);
  check('живой канал всё равно опрошен', pending && pending.has('v1'));
  check('исчезнувший помечен датой', typeof db.channels.dead.gone === 'string');
  check('к исчезнувшему больше не ходим', db.channels.dead.uploadsPlaylistId === null);
  check('данные живого канала не пострадали', db.channels.live.firstUploadComplete === true);
}

// --- язык канала по заголовкам, а не по объявленному полю ---
// defaultAudioLanguage заполняет владелец канала и ошибается: у Filmenic там
// стоит «en», а ролики называются «Ek Galat Experiment Ne Bana Diya Khaufnaak
// Dinosaur». Такой канал попадал в английские ниши и портил их цифры.
{
  const t = (...a) => a.map((x) => ({ title: x }));
  check('чужое письмо распознано', titleLanguage(t(
    'अंतरिक्ष की कहानी', 'ब्रह्मांड का रहस्य', 'पृथ्वी और चंद्रमा')) === 'hi');
  check('романизированный хинди распознан', titleLanguage(t(
    'Ek Galat Experiment Ne Bana Diya Khaufnaak Dinosaur',
    'Ye Movie Kya Hai Aur Kaise Bani',
    'Iska Raaz Kya Hai Jo Kisi Ne Nahi Dekha')) === 'hi');
  check('английский вердикта не получает', titleLanguage(t(
    'The Terrifying Scale of the Oort Cloud',
    'What Will Fail First on a 100-Year Starship',
    'How the Solar System Formed')) === null);
  check('немецкий вердикта не получает', titleLanguage(t(
    'Die größten Rätsel des Weltalls', 'Wie das Universum entstand',
    'Was war vor dem Urknall')) === null);
  // Два немецких канала про засыпание разделяют заголовок корейской буквой «ㅣ».
  // Одиночный знак — украшение, а не язык.
  check('одиночный знак чужого письма не считается языком', titleLanguage(t(
    'Gemütlich einschlafenㅣDas Tal der Drachenhirten',
    'In wenigen Minuten einschlafenㅣDas verborgene Gewächshaus',
    'Gemütliche EinschlafgeschichteㅣDie Pilzzüchterin')) === null);
  check('одного маркера хинди мало', titleLanguage(t(
    'The Sea Ka Mystery', 'Deep Ocean Explained', 'What Lives Below')) === null);
  check('на двух заголовках вердикт не выносим',
    titleLanguage(t('अंतरिक्ष की कहानी', 'ब्रह्मांड का रहस्य')) === null);

  // Канал с чужим языком должен выпасть из обоих рынков целиком.
  const day = (n) => new Date(Date.parse(now) - n * 86400000).toISOString();
  const channels = { hi: { id: 'hi', seeds: ['open'], markets: ['de'], firstUploadAt: day(100),
                           firstUploadComplete: true, publishedAt: day(105) } };
  const videos = {}, current = {};
  for (let i = 0; i < 12; i++) {
    videos['h' + i] = { id: 'h' + i, channelId: 'hi', durationSec: 1500, lang: 'de',
                        publishedAt: day(20 + i),
                        title: 'offen Kya Hai Aur Kaise Bana ' + i };
    current['h' + i] = [90000, 100, 10];
  }
  const mm = computeMetrics({ db: { channels, videos, current }, seeds, thresholds,
                              snapshots: [], now, primaryLang: 'de' });
  check('язык из заголовков перебивает объявленный', mm.channels.hi.lang === 'hi');
  check('чужой канал не попадает в немецкую нишу', mm.niches.open.byMarket.de.channels === 0);
  check('и в английскую тоже', mm.niches.open.byMarket.en.channels === 0);
}

console.log(failed ? `\n${failed} проверок не прошло` : '\nВсе проверки прошли');
process.exit(failed ? 1 : 0);
