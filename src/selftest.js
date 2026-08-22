// Проверка счётной части на синтетических данных: ключ для этого не нужен.
import { computeMetrics } from './metrics.js';
import { renderReport, score } from './report.js';
import { Quota, BudgetExhausted } from './quota.js';
import { Translator } from './translate.js';
import { explore, snapshot } from './collect.js';
import { isBlocked, isAdLimited, promote, stopWords, topicShape, phrases } from './topics.js';
import { queryKeywords, seedIndex, videoNiches, wordFrequency, nounEvidence } from './metrics.js';
import { Quota as Q2 } from './quota.js';
import { renderBrief } from './brief.js';
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
  channels[id] = { id, title: `Молодой ${c}`, seeds: ['open'], markets: ['de'],
                   firstUploadAt: day(200), firstUploadComplete: true, publishedAt: day(200), subscribers: 900 };
  for (let v = 0; v < 12; v++) {
    videos[`${id}v${v}`] = { id: `${id}v${v}`, channelId: id, title: `offen видео ${v}`,
      publishedAt: day(40 + v * 10), durationSec: 1500, views: 150000, likes: 6000, comments: 600, lang: 'de' };
  }
  // один выброс — ×10 к медиане
  videos[`${id}hit`] = { id: `${id}hit`, channelId: id, title: `offen выброс ${c}`,
    publishedAt: day(20), durationSec: 1800, views: 1500000, likes: 60000, comments: 4500, lang: 'de' };
}

// Ниша «closed»: выбросы только у старых каналов — дверь закрыта.
for (let c = 0; c < 3; c++) {
  const id = `old${c}`;
  channels[id] = { id, title: `Старик ${c}`, seeds: ['closed'], markets: ['de'],
                   firstUploadAt: day(2000), firstUploadComplete: true, publishedAt: day(2000), subscribers: 1500000 };
  for (let v = 0; v < 12; v++) {
    videos[`${id}v${v}`] = { id: `${id}v${v}`, channelId: id, title: `gesperrt видео ${v}`,
      publishedAt: day(40 + v * 10), durationSec: 1500, views: 250000, likes: 7500, comments: 600, lang: 'de' };
  }
  videos[`${id}hit`] = { id: `${id}hit`, channelId: id, title: `gesperrt выброс старика ${c}`,
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

console.log(failed ? `\n${failed} проверок не прошло` : '\nВсе проверки прошли');
process.exit(failed ? 1 : 0);
