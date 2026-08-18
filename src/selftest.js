// Проверка счётной части на синтетических данных: ключ для этого не нужен.
import { computeMetrics } from './metrics.js';
import { renderReport, score } from './report.js';
import { Quota, BudgetExhausted } from './quota.js';
import { Translator } from './translate.js';
import { median, dominantLang, channelBaseline } from './metrics.js';

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
}

// --- синтетическая база ---
const now = '2026-08-18T00:00:00.000Z';
const day = (n) => new Date(Date.parse(now) - n * 86400000).toISOString();

const channels = {};
const videos = {};
const seeds = [{ id: 'open', group: 'Тест', de: 'offen', en: 'open' },
               { id: 'closed', group: 'Тест', de: 'zu', en: 'closed' }];

// Ниша «open»: молодые каналы дают выбросы — дверь открыта.
for (let c = 0; c < 4; c++) {
  const id = `young${c}`;
  channels[id] = { id, title: `Молодой ${c}`, seeds: ['open'], markets: ['de'],
                   firstUploadAt: day(200), firstUploadComplete: true, publishedAt: day(200), subscribers: 900 };
  for (let v = 0; v < 12; v++) {
    videos[`${id}v${v}`] = { id: `${id}v${v}`, channelId: id, title: `видео ${v}`,
      publishedAt: day(40 + v * 10), durationSec: 1500, views: 10000, likes: 400, comments: 40, lang: 'de' };
  }
  // один выброс — ×10 к медиане
  videos[`${id}hit`] = { id: `${id}hit`, channelId: id, title: `выброс ${c}`,
    publishedAt: day(20), durationSec: 1800, views: 100000, likes: 4000, comments: 300, lang: 'de' };
}

// Ниша «closed»: выбросы только у старых каналов — дверь закрыта.
for (let c = 0; c < 3; c++) {
  const id = `old${c}`;
  channels[id] = { id, title: `Старик ${c}`, seeds: ['closed'], markets: ['de'],
                   firstUploadAt: day(2000), firstUploadComplete: true, publishedAt: day(2000), subscribers: 1500000 };
  for (let v = 0; v < 12; v++) {
    videos[`${id}v${v}`] = { id: `${id}v${v}`, channelId: id, title: `видео ${v}`,
      publishedAt: day(40 + v * 10), durationSec: 1500, views: 50000, likes: 1500, comments: 120, lang: 'de' };
  }
  videos[`${id}hit`] = { id: `${id}hit`, channelId: id, title: `выброс старика ${c}`,
    publishedAt: day(20), durationSec: 1800, views: 500000, likes: 15000, comments: 900, lang: 'de' };
}

const thresholds = { minDurationSec: 480, medianMinVideoAgeDays: 30, velocityMaxVideoAgeDays: 60,
  snapshotMaxAgeDays: 150, medianMinMatureVideos: 5,
  outlierRatio: 3, outlierMinViews: 20000, youngChannelDays: 365,
  slopUploadsPerWeek: 5, slopChannelAgeDays: 180 };

const snapshots = [
  { date: day(7), videos: { young0hit: [70000] } },
  { date: day(0), videos: { young0hit: [100000] } },
];

const current = {};
for (const [id, v] of Object.entries(videos)) {
  current[id] = [v.views, v.likes, v.comments];
  delete v.views; delete v.likes; delete v.comments;
}

const m = computeMetrics({ db: { channels, videos, current }, seeds, thresholds, snapshots, now });

check('база канала — медиана зрелых видео', m.channels.young0.medianViews === 10000);
check('тощая база не даёт медианы',
  channelBaseline([{ publishedAt: day(100), views: 5 }, { publishedAt: day(90), views: 7 }],
                  thresholds, now).medianViews === null);
check('выброс посчитан как ×10', Math.round(m.videos.find((v) => v.id === 'young0hit').outlierRatio) === 10);
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
          medianOutlierViews: 500000, slopShare: 0, medianLikeRate: 0.04 }) === null);
check('скорость роста взята из снапшотов', Math.round(m.videos.find((v) => v.id === 'young0hit').velocity) === 4286);
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
    videos: { p1v: { id: 'p1v', channelId: 'p1', publishedAt: day(60), durationSec: 1500, lang: 'de' } },
    current: { p1v: [10000, 100, 10] },
  },
  seeds, thresholds, snapshots: [], now,
});
check('недолистанный архив не омолаживает канал',
  Math.round(partial.channels.p1.ageDays) === 3000);
check('основа возраста названа честно',
  partial.channels.p1.ageBasis === 'регистрация канала');

console.log(failed ? `\n${failed} проверок не прошло` : '\nВсе проверки прошли');
process.exit(failed ? 1 : 0);
