// Проверка счётной части на синтетических данных: ключ для этого не нужен.
import { computeMetrics } from './metrics.js';
import { renderReport, score } from './report.js';
import { Quota, BudgetExhausted } from './quota.js';
import { median } from './metrics.js';

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
                   firstUploadAt: day(200), firstUploadComplete: true, subscribers: 900 };
  for (let v = 0; v < 12; v++) {
    videos[`${id}v${v}`] = { id: `${id}v${v}`, channelId: id, title: `видео ${v}`,
      publishedAt: day(40 + v * 10), durationSec: 1500, views: 10000, likes: 400, comments: 40 };
  }
  // один выброс — ×10 к медиане
  videos[`${id}hit`] = { id: `${id}hit`, channelId: id, title: `выброс ${c}`,
    publishedAt: day(20), durationSec: 1800, views: 100000, likes: 4000, comments: 300 };
}

// Ниша «closed»: выбросы только у старых каналов — дверь закрыта.
for (let c = 0; c < 3; c++) {
  const id = `old${c}`;
  channels[id] = { id, title: `Старик ${c}`, seeds: ['closed'], markets: ['de'],
                   firstUploadAt: day(2000), firstUploadComplete: true, subscribers: 1500000 };
  for (let v = 0; v < 12; v++) {
    videos[`${id}v${v}`] = { id: `${id}v${v}`, channelId: id, title: `видео ${v}`,
      publishedAt: day(40 + v * 10), durationSec: 1500, views: 50000, likes: 1500, comments: 120 };
  }
  videos[`${id}hit`] = { id: `${id}hit`, channelId: id, title: `выброс старика ${c}`,
    publishedAt: day(20), durationSec: 1800, views: 500000, likes: 15000, comments: 900 };
}

const thresholds = { minDurationSec: 480, medianMinVideoAgeDays: 30, velocityMaxVideoAgeDays: 60,
  outlierRatio: 3, outlierMinViews: 20000, youngChannelDays: 365,
  slopUploadsPerWeek: 5, slopChannelAgeDays: 180 };

const snapshots = [
  { date: day(7), videos: { young0hit: [70000] } },
  { date: day(0), videos: { young0hit: [100000] } },
];

const m = computeMetrics({ db: { channels, videos }, seeds, thresholds, snapshots, now });

check('база канала — медиана зрелых видео', m.channels.young0.medianViews === 10000);
check('выброс посчитан как ×10', Math.round(m.videos.find((v) => v.id === 'young0hit').outlierRatio) === 10);
check('ниша open полностью проницаема', m.niches.open.permeability === 1);
check('ниша closed непроницаема', m.niches.closed.permeability === 0);
check('выбросы схлопнуты по каналам', m.niches.open.outlierChannels === 4);
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

console.log(failed ? `\n${failed} проверок не прошло` : '\nВсе проверки прошли');
process.exit(failed ? 1 : 0);
