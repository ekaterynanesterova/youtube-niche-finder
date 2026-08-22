// Проверка счётной части на синтетических данных: ключ для этого не нужен.
import { computeMetrics } from './metrics.js';
import { renderReport, score } from './report.js';
import { Quota, BudgetExhausted } from './quota.js';
import { Translator } from './translate.js';
import { explore } from './collect.js';
import { isBanned, promote } from './topics.js';
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

// --- запрещённые темы ---
// Автопоиск про договорённости не знает и уже притащил «hitler Doku».
check('военная тематика отсекается', isBanned('hitler Doku') && isBanned('weltkrieg') && isBanned('world war two'));
check('обычные темы проходят', !isBanned('dinosaur documentary') && !isBanned('architektur'));
check('запрещённое не попадает в разведку даже первым кандидатом',
  promote({ candidates: [{ phrase: 'hitler bunker', channels: 9, lift: 30 },
                         { phrase: 'deep ocean', channels: 4, lift: 5 }],
            seeds: [], limit: 2, lang: 'en' })
    .every((t) => !t.en.includes('hitler')));

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

const m = computeMetrics({ db: { channels, videos, current }, seeds, thresholds, snapshots, now });

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
  seeds, thresholds, snapshots: [], now,
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
  seeds, thresholds, snapshots: [], now,
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
check('бриф не содержит пустых подстановок', !brief.includes('undefined') && !brief.includes('NaN'));
check('в брифе есть ограничения по контенту', brief.includes('Гитлер'));
check('в брифе есть таблица конкурентов', brief.includes('Канал') && brief.includes('32 из 49'));
check('трудозатраты выведены текстом', brief.includes('5.5 ч готового видео в неделю'));
check('в брифе стоит ссылка на свежий срез', brief.includes('docs/brief.md'));

console.log(failed ? `\n${failed} проверок не прошло` : '\nВсе проверки прошли');
process.exit(failed ? 1 : 0);
