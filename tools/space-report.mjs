// Отчёт по космическим нишам для канала AFTERLIGHT.
//
// Отдельный файл, а не вкладка сайта: его читает другая сессия, которая
// собирает сценарии, и ей нужен один текст со всеми числами и оговорками.
// Запуск: node tools/space-report.mjs > docs/космос-afterlight.md
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const r = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const V = r('data/videos.json'), C = r('data/channels.json'), CUR = r('data/current.json');
const STATE = r('data/state.json');
const PAGE = JSON.parse(readFileSync(join(ROOT, 'index.html'), 'utf8')
  .match(/<script type="application\/json" id="payload">([\s\S]*?)<\/script>/)[1]);

const now = Date.now();
const nn = (x) => x == null ? '—' : Math.round(x).toLocaleString('ru-RU');
const L = [];
const w = (s = '') => L.push(s);

const HINT = /\b(space|cosmos|cosmic|universe|galaxy|galaxies|planet|planets|moon|solar system|star|stars|stellar|astronom|nasa|telescope|black hole|nebula|asteroid|comet|exoplanet|orbit|spacecraft|probe|rover|mars|jupiter|saturn|venus|mercury|uranus|neptune|pluto)\b/i;
const vids = [];
for (const v of Object.values(V)) {
  const views = CUR[v.id]?.[0];
  if (!Number.isFinite(views) || !HINT.test(v.title ?? '')) continue;
  const ch = C[v.channelId];
  vids.push({ ...v, views, subs: ch?.subscribers ?? null, chTitle: ch?.title ?? null,
              age: (now - Date.parse(v.publishedAt)) / 86400000 });
}
const yt = (v) => `[${(v.title ?? '').replace(/[|\[\]]/g, ' ')}](https://youtu.be/${v.id})`;
const noPipe = (s) => (s ?? '').replace(/\|/g, ' ');

w('# Космос и планетология: что показывают собранные данные');
w('');
w(`Собрано автоматически ${new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Berlin' })} по берлинскому времени. Пересобирается командой \`node tools/space-report.mjs > docs/космос-afterlight.md\`.`);
w('');
w('## 1. Что это за база');
w('');
w('Данные собирает ежедневный обход YouTube Data API v3 из этого же репозитория. Это не выгрузка чужой аналитики и не оценка сервисов вроде vidIQ: только то, что отдаёт официальный API, плюс разница между ежедневными срезами.');
w('');
w('| | |');
w('|---|---|');
w(`| Каналов в базе | ${nn(Object.keys(C).length)} |`);
w(`| Роликов в базе | ${nn(Object.keys(V).length)} |`);
w(`| Из них с космосом в заголовке | ${nn(vids.length)} |`);
w(`| Ежедневных срезов просмотров | ${nn(PAGE.snapshotDays ?? 0)} |`);
w(`| Прогонов сбора | ${nn((STATE.runs ?? []).length)} |`);
w('');
w('Что есть в записи ролика: заголовок, канал, дата публикации, длительность, объявленный язык, просмотры и их прирост между срезами. Что есть по каналу: дата регистрации, дата первой загрузки, подписчики, число роликов.');
w('');
w('**Чего в базе нет и не будет — это важнее списка того, что есть:**');
w('');
w('- **CTR — нет.** Его отдаёт только YouTube Analytics владельцу канала. По чужому ролику этой цифры для нас не существует в природе.');
w('- **Удержание — нет.** По той же причине.');
w('- **Обложки — нет.** Картинки не собираются и не анализируются.');
w('- **Содержимое ролика — нет.** Ни кадра, ни расшифровки. Всё, что ниже, выведено из заголовков, длительностей, дат и счётчиков.');
w('');
w('Отдельная оговорка про полноту: обход идёт по списку тем и по разделу Trending, а не сплошняком. «Роликов по теме N» ниже означает «столько нашли мы», а не «столько есть на YouTube».');
w('');

// --- 2. ниши ---
const SPACE = new Set(['Космос', 'Космос спокойный', 'Будущее']);
const rows = [];
for (const n of PAGE.niches) {
  if (!SPACE.has(n.group)) continue;
  const m = n.byMarket?.en;
  if (!m || !m.demandSample) continue;
  rows.push({ q: n.queries?.en ?? n.id, ru: n.ru, ...m });
}
rows.sort((a, b) => (b.demandOverBreakout ?? 0) - (a.demandOverBreakout ?? 0));

w('## 2. Космические ниши с доказанным спросом');
w('');
w('«Свежие ролики» — все ролики темы возрастом от 7 до 60 дней, по всем каналам; просмотры считаются за всю жизнь ролика. «Коридор новичка» — от нижней до верхней четверти по роликам каналов моложе года, заведённых незадолго до первой загрузки: в него попадает половина таких роликов.');
w('');
w('| Ниша | Каналов | Свежих роликов | ≥20к | ≥100к | Лучший | Коридор новичка | Типичная длина |');
w('|---|---|---|---|---|---|---|---|');
for (const x of rows.slice(0, 14)) {
  w(`| **${x.q}**${x.ru ? `<br><sub>${x.ru}</sub>` : ''} | ${nn(x.channels)} | ${nn(x.demandSample)} | ${nn(x.demandOverWorking)} | ${nn(x.demandOverBreakout)} | ${nn(x.demandBest)} `
    + `| ${x.rangeLo == null ? '—' : nn(x.rangeLo) + ' – ' + nn(x.rangeHi)} | ${x.medianOutlierMinutes == null ? '—' : Math.round(x.medianOutlierMinutes) + ' мин'} |`);
}
w('');
w('Те же ниши по деньгам и по тому, сколько там станочных каналов:');
w('');
w('| Ниша | Зарабатывают сейчас | Из них темп держат | Медиана $/мес | Каналов по шаблону |');
w('|---|---|---|---|---|');
for (const x of rows.slice(0, 14)) {
  w(`| ${x.q} | ${x.liveEarners ?? '—'} | ${x.liveHolding ?? '—'} | ${x.medianLiveUsd == null ? '—' : '$' + nn(x.medianLiveUsd)} `
    + `| ${x.templateShare == null ? '—' : Math.round(x.templateShare * 100) + '% из ' + x.templateSample} |`);
}
w('');
w('«Зарабатывают сейчас» — по просмотрам, реально набранным за две недели между срезами, а не по накопленным за всё время. «Каналов по шаблону» — доля каналов, у которых заголовки сидят в одной рамке, хронометраж один и тот же, в названиях порядковые номера и поток больше четырёх роликов в неделю. С 2025 года YouTube снимает за такое монетизацию. **Ниша с высокой долей таких каналов для нас закрыта, какие бы там ни были просмотры.**');
w('');

w('### Достаётся ли это каналу без аудитории');
w('');
const small = vids.filter((v) => v.subs != null && v.subs < 50000 && v.age > 30 && v.age < 365);
const big100 = small.filter((v) => v.views >= 100000).sort((a, b) => b.views - a.views);
const ratios = vids.filter((v) => v.subs > 0).map((v) => v.views / v.subs).sort((a, b) => a - b);
w(`Из ${nn(small.length)} космических роликов, выпущенных за последний год каналами меньше 50 тысяч подписчиков, планку в 100 тысяч просмотров взяли ${nn(big100.length)} — это ${(100 * big100.length / small.length).toFixed(1)}%. Отношение просмотров к подписчикам по всей космической выборке: медиана ${ratios[Math.floor(ratios.length / 2)].toFixed(2)}. То есть типичный ролик собирает около пятой части числа подписчиков канала, и потому редкие выбросы здесь важнее медианы.`);
w('');
w('Двадцать самых крупных попаданий у маленьких каналов — это и есть образцы того, что имеет смысл разбирать:');
w('');
w('| Ролик | Канал | Подписчиков | Просмотров | Длина | Возраст |');
w('|---|---|---|---|---|---|');
for (const v of big100.slice(0, 20)) {
  w(`| ${yt(v)} | ${noPipe(v.chTitle)} | ${nn(v.subs)} | ${nn(v.views)} | ${Math.round(v.durationSec / 60)} мин | ${Math.round(v.age)} дн |`);
}
w('');

// --- 3. провалы ---
const OBJ = {
  'Планета Девять': /\bplanet (nine|9|x)\b/i,
  'Межзвёздные объекты (ʻOumuamua, Borisov, 3I/ATLAS)': /\b(oumuamua|borisov|interstellar object|3i\/atlas)\b/i,
  'Нейтронные звёзды': /\bneutron star/i,
  'Perseverance': /\bperseverance\b/i,
  'Проксима Центавра': /\bproxima\b/i,
  'Титан (спутник Сатурна)': /\btitan\b(?!ic)/i,
  'New Horizons': /\bnew horizons\b/i,
  'Бенну (OSIRIS-REx)': /\bbennu\b/i,
  'Юнона (Juno)': /\bjuno\b/i,
  'Тритон': /\btriton\b/i,
  'Энцелад': /\benceladus\b/i,
  'Пояс Койпера': /\bkuiper\b/i,
  'Облако Оорта': /\boort\b/i,
  'Кассини': /\bcassini\b/i,
  'Бетельгейзе': /\bbetelgeuse\b/i,
  'Стрелец A*': /\bsagittarius a\b|\bsgr a\b/i,
  'Квазары': /\bquasar/i,
  'Тёмная энергия': /\bdark energy\b/i,
  'Церера': /\bceres\b/i,
  'TRAPPIST-1': /\btrappist\b/i,
  'Ганимед': /\bganymede\b/i,
  'Европа (спутник Юпитера)': /\beuropa\b/i,
  'Сверхновые': /\bsupernova/i,
  'Магнетары': /\bmagnetar/i,
  'Уран': /\buranus\b/i,
  'Меркурий': /\bmercury\b/i,
  'Нептун': /\bneptune\b/i,
  'Плутон': /\bpluto\b/i,
  'Хаббл': /\bhubble\b/i,
  'Конец Вселенной': /\b(heat death|end of the universe|big rip|big crunch)\b/i,
};
const gaps = [];
for (const [name, re] of Object.entries(OBJ)) {
  const all = vids.filter((v) => re.test(v.title ?? ''));
  if (all.length < 12) continue;
  const mature = all.filter((v) => v.age > 60);
  const recent = all.filter((v) => v.age <= 60);
  const bigHist = mature.filter((v) => v.views >= 100000);
  if (bigHist.length < 3) continue;
  gaps.push({ name, n: all.length, nRecent: recent.length, bigHist: bigHist.length,
              bigRecent: recent.filter((v) => v.views >= 100000).length,
              midRecent: recent.filter((v) => v.views >= 20000).length,
              best: bigHist.sort((a, b) => b.views - a.views)[0],
              smallBest: bigHist.filter((v) => v.subs != null && v.subs < 100000)
                                .sort((a, b) => b.views - a.views)[0] ?? null });
}
gaps.sort((a, b) => (a.bigRecent - b.bigRecent) || (b.bigHist - a.bigHist));

w('## 3. Спрос есть, свежих крупных роликов нет');
w('');
w('Для каждого объекта: сколько роликов о нём в базе, сколько из них когда-либо взяли сто тысяч, и сколько взяли сто и двадцать тысяч среди вышедших за последние 60 дней. Верх таблицы — темы, где история есть, а последние два месяца пустые.');
w('');
w('Две оговорки, и обе существенные:');
w('');
w('- **Пустой последний столбец не означает, что тема свободна.** Он означает, что в НАШЕЙ базе нет свежего крупного ролика. Обход идёт по спискам тем, а не сплошняком, и свежий хит мог просто не попасться. Перед постановкой в план любую строку отсюда надо открыть поиском на YouTube с фильтром «за месяц» и посмотреть глазами.');
w('- **Тишина бывает следствием, а не возможностью.** Об объекте могли перестать снимать потому, что не было новостей. Сильная сторона канала — конкретный объект плюс свежий повод, так что в такой теме повод придётся искать отдельно.');
w('');
w('| Объект | Роликов | ≥100к за всю историю | Вышло за 60 дней | Из них ≥20к | Из них ≥100к |');
w('|---|---|---|---|---|---|');
for (const g of gaps) {
  w(`| **${g.name}** | ${nn(g.n)} | ${g.bigHist} | ${g.nRecent} | ${g.midRecent} | ${g.bigRecent} |`);
}
w('');
w('Рекорд темы и — отдельно — лучшее, что по ней сделал канал меньше ста тысяч подписчиков. Вторая колонка полезнее первой: она показывает, берётся ли тема без накопленной аудитории.');
w('');
w('| Объект | Рекорд темы | Лучшее у канала меньше 100к подписчиков |');
w('|---|---|---|');
for (const g of gaps.filter((x) => x.bigRecent === 0).slice(0, 16)) {
  const s = g.smallBest;
  w(`| ${g.name} | ${yt(g.best)} — ${nn(g.best.views)} | `
    + (s ? `${yt(s)} — ${nn(s.views)}, канал «${noPipe(s.chTitle)}» с ${nn(s.subs)} подписчиков` : 'нет ни одного') + ' |');
}
w('');

// --- 4. заголовки ---
const pool = vids.filter((v) => v.subs != null && v.subs < 50000 && v.age > 30 && v.durationSec >= 480);
const baseHit = pool.filter((v) => v.views >= 100000).length;
const PAT = {
  '«Full Documentary» в заголовке': /\bfull documentary\b/i,
  '«4K» / «8K»': /\b[48]k\b/i,
  'Год в заголовке (2024–2029)': /\b20(2[4-9])\b/,
  'Число в начале («10 things…»)': /^\d+\s/,
  'Слово капсом': /\b[A-Z]{4,}\b/,
  'Название объекта первым словом': /^(pluto|mars|jupiter|saturn|venus|uranus|neptune|titan|europa|enceladus|triton)\b/i,
  'Составной заголовок (тире или двоеточие)': /[—–:|]/,
  '«Just / Finally / Scientists just…»': /\b(just (found|discovered|revealed)|finally|scientists (just|finally))\b/i,
  '«Terrifying / Scary / Disturbing»': /\b(terrifying|scary|disturbing|horrifying|nightmare)\b/i,
  '«Mystery / Unsolved / We don’t know»': /\b(we (still )?don.t know|mystery|mysteries|unsolved|unexplained)\b/i,
  '«What / Why / How» в начале': /^(what|why|how)\b/i,
  'NASA в заголовке': /\bnasa\b/i,
  'Вопросительный знак': /\?/,
  '«What if…»': /^what if\b/i,
};
w('## 4. Заголовки');
w('');
w('**Данных по CTR нет ни по одному чужому ролику — эту цифру YouTube отдаёт только владельцу канала.** Ниже не CTR, а корреляция приёма в заголовке с тем, взял ли ролик сто тысяч просмотров. Причинности здесь нет: «Full Documentary» не делает ролик успешным, так подписывают полнометражные работы, в которые вложились. Читать это надо как «какие заголовки стоят на удачных роликах», а не «какие заголовки делают ролик удачным».');
w('');
w(`Выборка: ${nn(pool.length)} космических роликов длиннее восьми минут у каналов меньше 50 тысяч подписчиков, ролику больше 30 дней. Сто тысяч взяли ${baseHit} из них — базовая доля ${(100 * baseHit / pool.length).toFixed(1)}%.`);
w('');
w('| Приём | Роликов | Из них ≥100к | Доля | К базовой |');
w('|---|---|---|---|---|');
const pr = [];
for (const [name, re] of Object.entries(PAT)) {
  const s = pool.filter((v) => re.test(v.title ?? ''));
  if (s.length < 40) continue;
  const h = s.filter((v) => v.views >= 100000).length;
  pr.push([name, s.length, h, h / s.length, (h / s.length) / (baseHit / pool.length)]);
}
pr.sort((a, b) => b[4] - a[4]);
for (const p of pr) w(`| ${p[0]} | ${nn(p[1])} | ${p[2]} | ${(100 * p[3]).toFixed(1)}% | ×${p[4].toFixed(2)} |`);
w('');
w('Что здесь действительно стоит внимания: **вопросительный знак и «What if…» стоят на роликах, которые собирают заметно хуже базы** — вдвое и втрое. Открытый вопрос в заголовке не обещает зрителю ответа, а космос смотрят за ответ. Обратная сторона той же монеты — «Mystery / Unsolved» тоже ниже базы: тайна без разгадки не продаёт. Это согласуется с честным «вот чего мы не знаем» внутри ролика, но против такой формулировки В ЗАГОЛОВКЕ.');
w('');
w('**Обложки не собираются вовсе, данных по ним нет никаких.**');
w('');

// --- 5. длина ---
w('## 5. Длина ролика');
w('');
w('Удержания у нас нет, поэтому вопрос «какая длина держит зрителя» данными не закрывается. Закрывается другой: какая длина стоит на роликах, которые собрали.');
w('');
w('| Длина | Роликов | Медиана просмотров | Верхние 10% | Взяли 100к |');
w('|---|---|---|---|---|');
for (const [lo, hi] of [[8, 20], [20, 35], [35, 60], [60, 90], [90, 180], [180, 1e9]]) {
  const s = pool.filter((v) => v.durationSec / 60 >= lo && v.durationSec / 60 < hi)
                .map((v) => v.views).sort((a, b) => a - b);
  if (s.length < 15) continue;
  const q = (p) => s[Math.floor(s.length * p)];
  w(`| ${lo}–${hi > 1e8 ? '∞' : hi} мин | ${nn(s.length)} | ${nn(q(0.5))} | ${nn(q(0.9))} | ${s.filter((x) => x >= 100000).length} |`);
}
w('');
w('Коротко: 35–60 минут — единственная полка, где медиана, верхняя десятая процентиль и число стотысячников одновременно выше соседних. Всё, что длиннее полутора часов, — в основном фоновые и сонные ролики, и медиана там падает. Тридцатитрёхминутный ролик попадает в полку 20–35, которая по верхнему хвосту слабее.');
w('');
w('---');
w('');
w('## Чего в этом отчёте нет');
w('');
w('- CTR и удержание — таких данных не существует, см. раздел 1.');
w('- Обложки — не собираются.');
w('- Немецкий рынок — здесь только английский.');
w('- Оценка того, насколько тема «сделана хорошо». Инструмент не видел ни одного кадра.');
w('');
w('Деньги везде считаются по ставке $5 за тысячу просмотров: настоящая ставка отличается по темам в разы, и API её не отдаёт. Это порядок величины, а не обещание.');

process.stdout.write(L.join('\n') + '\n');
