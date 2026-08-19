// Страница собирается на каждом прогоне с уже вшитыми данными.
// Никаких fetch: нечему падать, нечего кешировать, работает и с диска.
import { score } from './report.js';
import { buildVerdict, headline, marketStats } from './verdict.js';
import { buildArchetypes } from './archetypes.js';

const MARKET_LABEL = { de: 'Немецкий', en: 'Английский' };

export function buildPayload(m, seeds, thresholds) {
  const byId = Object.fromEntries(seeds.map((s) => [s.id, s]));

  // По пять живых примеров на нишу: цифры выбирают кандидатов, глаза решают.
  const examples = {};
  for (const lang of ['de', 'en']) {
    for (const v of m.videos) {
      const ch = m.channels[v.channelId];
      if (ch?.lang !== lang) continue;
      if (v.outlierRatio == null || v.outlierRatio < thresholds.outlierRatio) continue;
      if (v.views < thresholds.outlierMinViews) continue;
      if (v.channelAgeAtUploadDays == null || v.channelAgeAtUploadDays > thresholds.youngChannelDays) continue;
      for (const sid of v.seeds) {
        const bucket = ((examples[sid] ??= {})[lang] ??= []);
        bucket.push({
          id: v.id, title: v.title, channel: ch.title,
          views: v.views, ratio: v.outlierRatio,
          minutes: Math.round(v.durationSec / 60),
          channelAge: Math.round(v.channelAgeAtUploadDays),
          subs: ch.subscribers,
          // Состояние канала целиком: без него один ролик ни о чём не говорит.
          breakouts: ch.breakouts, working: ch.working, videos: ch.videoCount,
          chMedian: ch.medianViews, usd: ch.monthlyUsd, earning: ch.earning,
        });
      }
    }
  }
  for (const sid of Object.keys(examples)) {
    for (const lang of Object.keys(examples[sid])) {
      examples[sid][lang] = examples[sid][lang]
        .sort((a, b) => (b.earning - a.earning) || (b.usd - a.usd) || (b.views - a.views))
        .slice(0, 5);
    }
  }

  const withRu = Object.values(m.niches).map((n) => ({ ...n, ru: byId[n.id]?.ru ?? null }));
  const markets = marketStats(m.channels, thresholds);
  const verdict = buildVerdict({ niches: withRu, thresholds });

  const niches = Object.values(m.niches).map((n) => ({
    id: n.id, group: n.group, control: n.control,
    ru: byId[n.id]?.ru ?? null,
    query: byId[n.id]?.de ?? n.id,
    queries: n.queries,
    byMarket: n.byMarket,
    score: { de: score(n.byMarket.de), en: score(n.byMarket.en) },
  }));

  return {
    computedAt: m.computedAt,
    snapshotDays: m.snapshotDays,
    channelCount: Object.keys(m.channels).length,
    videoCount: m.videos.length,
    minChannels: 3,
    niches, examples, verdict, markets,
    // Архетип канала — набор тем, которые состоявшиеся каналы снимают вместе.
    archetypes: buildArchetypes({ metrics: m, thresholds, lang: 'en' }),
    headline: headline(verdict, markets),
    target: { usd: thresholds.targetMonthlyUsd, rpm: thresholds.rpmUsd },
    groups: [...new Set(seeds.map((s) => s.group))],
  };
}

export function renderSite(payload) {
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>Ниши · Niche Finder</title>
<style>
:root{
  --bg:#0d1014; --raise:#151a21; --card:#171d26; --line:#232b37;
  --ink:#e8ecf2; --dim:#8792a6;
  --good:#4ade80; --mid:#fbbf24; --bad:#f87171; --brand:#60a5fa;
  --r:14px;
}
@media (prefers-color-scheme: light){
  :root{ --bg:#f7f8fa; --raise:#fff; --card:#fff; --line:#e4e8ee;
         --ink:#101319; --dim:#5d6675; --good:#16a34a; --mid:#b45309;
         --bad:#dc2626; --brand:#2563eb; }
}
*{box-sizing:border-box}
html,body{margin:0}
body{background:var(--bg);color:var(--ink);
  font:15px/1.55 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
  -webkit-font-smoothing:antialiased;padding-bottom:64px}
.shell{max-width:1080px;margin:0 auto;padding:0 16px}

header{padding:28px 0 18px}
h1{margin:0;font-size:26px;letter-spacing:-.02em}
.lede{color:var(--dim);font-size:14px;margin-top:6px}
.stats{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.stat{background:var(--raise);border:1px solid var(--line);border-radius:10px;
  padding:8px 12px;min-width:96px}
.stat b{display:block;font-size:18px;font-variant-numeric:tabular-nums}
.stat span{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em}

.banner{margin:16px 0 0;padding:12px 14px;border-radius:var(--r);
  background:color-mix(in srgb,var(--mid) 12%,var(--raise));
  border:1px solid color-mix(in srgb,var(--mid) 34%,var(--line));font-size:13.5px}
.banner b{color:var(--mid)}

/* верхние вкладки и карточки вывода */
.vtabs{display:flex;gap:8px;padding:18px 0 4px}
.vtabs button{font:inherit;font-size:14.5px;padding:8px 16px;border-radius:999px;
  border:1px solid var(--line);background:var(--raise);color:var(--dim);cursor:pointer}
.vtabs button[aria-selected="true"]{background:color-mix(in srgb,var(--brand) 16%,var(--raise));
  border-color:var(--brand);color:var(--ink)}
.head-note{background:var(--raise);border:1px solid var(--line);border-radius:var(--r);
  padding:15px 17px;margin:14px 0 18px;font-size:15px;line-height:1.55}
.pick{background:var(--card);border:1px solid var(--line);border-radius:var(--r);
  padding:17px;margin-bottom:12px}
.pick.first{border-color:var(--good);box-shadow:0 0 0 1px color-mix(in srgb,var(--good) 30%,transparent)}
.pick .rk{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
.pick.first .rk{color:var(--good)}
.pick h4{margin:5px 0 2px;font-size:18px;letter-spacing:-.01em}
.pick h4 em{font-style:normal;color:var(--brand);font-weight:500;font-size:15px}
.pick .mk{color:var(--dim);font-size:12.5px;margin-bottom:14px}
.money{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px}
.money div{background:var(--raise);border:1px solid var(--line);border-radius:10px;
  padding:9px 13px;min-width:112px}
.money div b{display:block;font-size:19px;font-variant-numeric:tabular-nums;line-height:1.2}
.money div span{display:block;color:var(--dim);font-size:10.5px;margin-top:3px;
  text-transform:uppercase;letter-spacing:.06em}
.pick p{margin:0 0 7px;font-size:13.5px;line-height:1.5}
.pick p:last-child{margin-bottom:0}
.pick .lab{color:var(--dim)}
.disclaim{color:var(--dim);font-size:13px;max-width:64ch;margin-top:16px}
.arch{background:var(--card);border:1px solid var(--line);border-radius:var(--r);
  padding:17px;margin-bottom:12px}
.arch.hot{border-color:var(--good)}
.arch h4{margin:0 0 3px;font-size:16px}
.arch .sub{color:var(--dim);font-size:12.5px;margin-bottom:13px}
.tops{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 12px}
.tops span{background:var(--raise);border:1px solid var(--line);border-radius:8px;
  padding:4px 9px;font-size:12.5px}
.chans{font-size:13px;line-height:1.7}
.chans b{font-weight:600}
.chans .u{color:var(--good);font-variant-numeric:tabular-nums}
.panel{position:sticky;top:0;z-index:5;background:var(--bg);
  padding:14px 0 10px;border-bottom:1px solid var(--line);margin-top:18px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
.row:last-child{margin-bottom:0}
.lbl{color:var(--dim);font-size:11px;text-transform:uppercase;
  letter-spacing:.07em;min-width:74px}
button.chip{font:inherit;font-size:13px;padding:5px 11px;border-radius:999px;
  border:1px solid var(--line);background:var(--raise);color:var(--dim);cursor:pointer}
button.chip:hover{color:var(--ink)}
button.chip[data-on="1"]{background:color-mix(in srgb,var(--brand) 16%,var(--raise));
  border-color:var(--brand);color:var(--ink)}

.count{color:var(--dim);font-size:13px;margin:16px 0 10px}

.niche{background:var(--card);border:1px solid var(--line);border-radius:var(--r);
  margin-bottom:10px;overflow:hidden}
.niche > summary{list-style:none;cursor:pointer;padding:14px 16px;
  display:grid;gap:12px;grid-template-columns:1fr auto;align-items:center}
.niche > summary::-webkit-details-marker{display:none}
.niche[open]{border-color:color-mix(in srgb,var(--brand) 40%,var(--line))}
.nm{font-size:16px;font-weight:600;letter-spacing:-.01em}
.ru{color:var(--brand);font-weight:500;font-size:14.5px;white-space:nowrap}
@media (max-width:520px){ .ru{display:block;white-space:normal;margin-left:22px} }
.q{color:var(--dim);font-size:12.5px;margin-top:2px}
.rank{color:var(--dim);font-variant-numeric:tabular-nums;font-size:13px;margin-right:8px}

.meter{display:flex;align-items:center;gap:10px;min-width:150px}
.track{flex:1;height:8px;border-radius:99px;background:var(--line);overflow:hidden}
.fill{height:100%;border-radius:99px}
.pv{font-variant-numeric:tabular-nums;font-weight:600;font-size:15px;min-width:52px;text-align:right}
.pl{color:var(--dim);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;text-align:right;margin-top:1px}

.chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 16px 14px}
.k{background:var(--raise);border:1px solid var(--line);border-radius:8px;
  padding:5px 9px;font-size:12.5px;color:var(--dim)}
.k b{color:var(--ink);font-variant-numeric:tabular-nums;font-weight:600}

.detail{border-top:1px solid var(--line);padding:14px 16px;background:var(--raise)}
.detail h4{margin:0 0 8px;font-size:12px;text-transform:uppercase;
  letter-spacing:.07em;color:var(--dim);font-weight:600}
.vid{display:block;padding:9px 0;border-bottom:1px solid var(--line);
  color:inherit;text-decoration:none}
.vid:last-child{border-bottom:0}
.vid:hover .vt{color:var(--brand)}
.vt{font-size:14px;line-height:1.4}
.vru{font-size:13.5px;line-height:1.4;color:var(--brand);margin-top:2px}
.vm{color:var(--dim);font-size:12px;margin-top:3px;font-variant-numeric:tabular-nums}
.vm.good{color:var(--good)}
.vm.warnt{color:var(--bad)}
.empty{color:var(--dim);font-size:13.5px;padding:28px 16px;text-align:center;
  background:var(--card);border:1px dashed var(--line);border-radius:var(--r)}

#found{margin-top:26px}
#found h3{font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);margin:0 0 4px}
#found .hint{color:var(--dim);font-size:13px;margin:0 0 12px;max-width:64ch}
.cand{display:flex;flex-wrap:wrap;gap:8px}
.cand div{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:8px 11px;font-size:13.5px}
.cand b{font-weight:600}
.cand span{color:var(--dim);font-size:12px;margin-left:6px}
.cand .new{border-color:var(--good)}
footer{color:var(--dim);font-size:13.5px;margin-top:34px;max-width:64ch}
footer h3{color:var(--ink);font-size:13px;text-transform:uppercase;
  letter-spacing:.07em;margin:22px 0 8px}
footer p{margin:0 0 10px}
footer b{color:var(--ink)}
.bands{list-style:none;padding:0;margin:0 0 10px}
.bands li{margin-bottom:7px;padding-left:18px;position:relative}
.dot{position:absolute;left:0;top:7px;width:9px;height:9px;border-radius:50%}
</style>
</head>
<body>
<div class="shell">
  <header>
    <h1>Где дверь открыта</h1>
    <div class="lede" id="lede"></div>
    <div class="stats" id="stats"></div>
    <div id="banner"></div>
  </header>

  <div class="vtabs" id="view-tabs"></div>

  <section id="view-verdict"></section>

  <section id="view-arch" hidden></section>

  <section id="view-all" hidden>
  <div class="panel">
    <div class="row"><span class="lbl">Рынок</span><span id="f-market"></span></div>
    <div class="row"><span class="lbl">Тема</span><span id="f-group"></span></div>
    <div class="row"><span class="lbl">Длина</span><span id="f-len"></span></div>
    <div class="row"><span class="lbl">Поток</span><span id="f-slop"></span></div>
    <div class="row"><span class="lbl">Сортировка</span><span id="f-sort"></span></div>
  </div>

  <div class="count" id="count"></div>
  <div id="list"></div>
  <div id="found"></div>
  </section>

  <footer>
    <h3>Что означают цифры</h3>
    <p><b>Проницаемость</b> — какая доля каналов с выбросами была моложе года в момент выстрела. Считается так: берём все каналы, у которых в этой нише случился выброс, и смотрим, скольким из них не было года. 5 из 7 = 71%.</p>
    <ul class="bands">
      <li><span class="dot" style="background:var(--good)"></span><b>60% и выше</b> — дверь открыта. Алгоритм раздаёт трафик формату, а не накопленной аудитории. Новый канал имеет реальный шанс.</li>
      <li><span class="dot" style="background:var(--mid)"></span><b>35–60%</b> — смешанно. Новички пробиваются, но конкурируют со старожилами. Нужен заметно лучший продукт.</li>
      <li><span class="dot" style="background:var(--bad)"></span><b>ниже 35%</b> — дверь закрыта. Выбросы достаются тем, у кого уже есть аудитория. Заходить туда с нуля — тратить время.</li>
    </ul>
    <p>Само по себе высокое число ещё ничего не решает: смотри рядом на <b>число пробившихся каналов</b>.</p>
    <p><b>Пробилось</b> — сколько <i>разных</i> каналов ниши выходят на денежную цель. Канал засчитывается, только если его свежие ролики за последние три месяца дают в среднем нужный объём просмотров. Одно залетевшее видео каналом не засчитывается: YouTube на старте раздаёт показы всем, и один ролик может выстрелить у кого угодно.</p>
    <p><b>Не дотягивают</b> — доля каналов, у которых попадания есть, а до цели далеко. Двадцать тысяч на ролике выглядят прилично ровно до тех пор, пока не посчитаешь в деньгах.</p>
    <p><b>Долговечность</b> — работает ли на тебя старое видео. Считается так: ролики старше полугода составляют, скажем, 17% каталога — а сколько просмотров они приносят? Если 55%, то есть в три раза больше своей доли, тема живёт годами и место в ней можно занять. Если меньше своей доли — ниша окажется беговой дорожкой: перестал выпускать, доход исчез.</p>
    <p><b>Типичный доход</b> — сколько в месяц приносит средний состоявшийся канал ниши. Оценка грубая: RPM зависит от тематики, сезона и аудитории, и точной цифры API не даёт.</p>
    <p><b>Длина</b> — сколько минут длится типовое выстрелившее видео. Это прямая цена входа: чтобы проверить нишу, нужно залить около десяти роликов.</p>
    <p><b>Конвейер</b> — доля каналов, выпускающих больше трёх часов готового видео в неделю. Это мера потока, а не качества: инструмент не видит, что внутри ролика, и не может отличить рукодельную работу от штамповки.</p>
    <p>Читать это число надо в обе стороны. Высокий конвейер значит, что конкурировать придётся объёмом — но он же доказывает, что формат <b>поставлен на поток и, значит, автоматизируется</b>. Хорошо это или плохо, зависит от того, что ты собираешься строить. Поэтому в рейтинг это число не входит — оно рядом, отдельной цифрой.</p>
    <h3>Чего эти цифры не знают</h3>
    <p><b>Они не видят содержимое ролика.</b> Ни картинку, ни монтаж, ни то, сделано это руками или нагенерировано. Всё, что здесь есть, — заголовки, длительность, даты и счётчики.</p>
    <p>Поэтому последнее слово всегда за глазами: открыть примеры внутри ниши и посмотреть, что там на самом деле.</p>
  </footer>
</div>

<script type="application/json" id="payload">${json}</script>
<script>
const P = JSON.parse(document.getElementById('payload').textContent);

const num = n => n == null ? '—' : Math.round(n).toLocaleString('ru-RU');
const pct = n => n == null ? '—' : Math.round(n * 100) + '%';
const tone = v => v == null ? 'var(--dim)' : v >= .6 ? 'var(--good)' : v >= .35 ? 'var(--mid)' : 'var(--bad)';
const plural = (n, a, b, c) => {
  const m = n % 100, k = n % 10;
  return n + ' ' + (m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c);
};

const S = {
  market: 'de',
  groups: new Set(),
  maxLen: 0,          // 0 = без ограничения
  maxSlop: 1,
  sort: 'permeability',
};

const LEN = [[0,'любая'],[20,'до 20 мин'],[35,'до 35 мин'],[50,'до 50 мин']];
const SLOP = [[1,'любой'],[0.7,'до 70%'],[0.4,'до 40%'],[0.15,'до 15%']];
const SORT = [['permeability','по проницаемости'],['score','по перспективе'],
              ['youngOutlierChannels','по числу каналов'],['medianOutlierViews','по просмотрам'],
              ['medianOutlierMinutes','по длине']];

function chips(host, items, isOn, onPick) {
  host.innerHTML = '';
  for (const [val, label] of items) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = label;
    b.dataset.on = isOn(val) ? '1' : '0';
    b.onclick = () => { onPick(val); draw(); };
    host.append(b);
  }
}

function rows() {
  return P.niches
    .map(n => ({ ...n, m: n.byMarket[S.market], sc: n.score[S.market] }))
    // Порог достоверности: ниша с одним-двумя каналами ничего не доказывает.
    .filter(r => r.m.outlierChannels >= P.minChannels)
    .filter(r => !S.groups.size || S.groups.has(r.group))
    .filter(r => !S.maxLen || (r.m.medianOutlierMinutes ?? 1e9) <= S.maxLen)
    .filter(r => (r.m.conveyorShare ?? 0) <= S.maxSlop)
    .sort((a, b) => {
      if (S.sort === 'score') return (b.sc ?? -1) - (a.sc ?? -1);
      if (S.sort === 'medianOutlierMinutes')
        return (a.m.medianOutlierMinutes ?? 1e9) - (b.m.medianOutlierMinutes ?? 1e9);
      return (b.m[S.sort] ?? -1) - (a.m[S.sort] ?? -1);
    });
}

function card(r, i) {
  const m = r.m;
  const ex = (P.examples[r.id] ?? {})[S.market] ?? [];
  const q = r.queries[S.market] ?? r.id;

  return \`<details class="niche">
    <summary>
      <div>
        <div class="nm"><span class="rank">\${i + 1}</span>\${q}\${r.ru ? \` <span class="ru">\${r.ru}</span>\` : ''}</div>
        <div class="q">\${r.group}\${r.control ? ' · опорная тема' : ''}</div>
      </div>
      <div class="meter">
        <div class="track"><div class="fill" style="width:\${Math.round((m.permeability ?? 0) * 100)}%;background:\${tone(m.permeability)}"></div></div>
        <div>
          <div class="pv" style="color:\${tone(m.permeability)}">\${pct(m.permeability)}</div>
          <div class="pl">новичков</div>
        </div>
      </div>
    </summary>
    <div class="chips">
      <span class="k">пробилось <b>\${m.youngOutlierChannels}</b> из \${m.outlierChannels}</span>
      <span class="k">медиана выброса <b>\${num(m.medianOutlierViews)}</b></span>
      <span class="k">длина <b>\${m.medianOutlierMinutes == null ? '—' : Math.round(m.medianOutlierMinutes)}</b> мин</span>
      <span class="k">типичный доход <b>\${m.medianMonthlyUsd == null ? '—' : '$' + num(m.medianMonthlyUsd)}</b>/мес</span>
      <span class="k">не дотягивают <b>\${pct(m.lotteryShare)}</b></span>
      <span class="k">конвейер <b>\${pct(m.conveyorShare)}</b></span>
      <span class="k">лайки <b>\${m.medianLikeRate == null ? '—' : (m.medianLikeRate * 100).toFixed(1) + '%'}</b></span>
      <span class="k">каналов <b>\${m.channels}</b></span>
    </div>
    <div class="detail">
      <h4>Кто пробился — открой и посмотри глазами</h4>
      \${ex.length ? ex.map(v => \`<a class="vid" href="https://youtu.be/\${v.id}" target="_blank" rel="noopener">
        <div class="vt">\${v.title ?? ''}</div>
        \${v.titleRu ? \`<div class="vru">\${v.titleRu}</div>\` : ''}
        <div class="vm">\${v.channel ?? ''} · \${num(v.views)} просмотров · \${v.minutes} мин · каналу было \${plural(v.channelAge, 'день', 'дня', 'дней')}</div>
        <div class="vm \${v.earning ? 'good' : 'warnt'}">\${v.earning
          ? 'канал зарабатывает ≈ $' + num(v.usd) + '/мес · ' + v.breakouts + ' видео выше 100 тыс. из ' + v.videos
          : 'не выходит на цель: ≈ $' + num(v.usd) + '/мес · медиана канала ' + num(v.chMedian)}</div>
      </a>\`).join('') : '<div class="vm">Примеров пока нет — нужны прогоны.</div>'}
    </div>
  </details>\`;
}

function draw() {
  chips(document.getElementById('f-market'),
    [['de','Немецкий'],['en','Английский']],
    v => S.market === v, v => S.market = v);

  chips(document.getElementById('f-group'),
    P.groups.map(g => [g, g]),
    v => S.groups.has(v),
    v => S.groups.has(v) ? S.groups.delete(v) : S.groups.add(v));

  chips(document.getElementById('f-len'), LEN, v => S.maxLen === v, v => S.maxLen = v);
  chips(document.getElementById('f-slop'), SLOP, v => S.maxSlop === v, v => S.maxSlop = v);
  chips(document.getElementById('f-sort'), SORT, v => S.sort === v, v => S.sort = v);

  const rs = rows();
  document.getElementById('count').textContent =
    rs.length
      ? plural(rs.length, 'ниша', 'ниши', 'ниш') + ' проходит фильтры · '
        + 'полоска — доля каналов моложе года среди тех, кто пробился'
      : '';
  let html;
  try {
    html = rs.length ? rs.map(card).join('') : '';
  } catch (e) {
    document.getElementById('list').innerHTML =
      '<div class="empty">Страница сломалась при отрисовке: ' + e.message + '</div>';
    throw e;
  }
  document.getElementById('list').innerHTML = html
    || '<div class="empty">Под эти условия ничего не подошло. Ослабь фильтры — или данных пока просто мало.</div>';
}

document.getElementById('lede').textContent =
  'Срез ' + P.computedAt.slice(0, 10) + '. Ниша показывается, только если в ней пробились минимум ' +
  P.minChannels + ' разных молодых канала.';

document.getElementById('stats').innerHTML = [
  [P.channelCount.toLocaleString('ru-RU'), 'каналов'],
  [P.videoCount.toLocaleString('ru-RU'), 'видео'],
  [P.snapshotDays, 'дней сбора'],
].map(([v, l]) => \`<div class="stat"><b>\${v}</b><span>\${l}</span></div>\`).join('');

if (P.snapshotDays < 21) {
  document.getElementById('banner').innerHTML =
    '<div class="banner"><b>Данные ещё копятся.</b> Накоплено ' +
    plural(P.snapshotDays, 'день', 'дня', 'дней') +
    '. Скорость роста пока считается как «просмотры ÷ возраст» — грубая прикидка. ' +
    'Через неделю картина станет осмысленной, через три появится настоящая кривая роста.</div>';
}

// Что нашлось в собственной базе — отдельно от рейтинга: это ещё не ниши,
// а связки слов, которые непропорционально часто попадаются у прорвавшихся.
const found = document.getElementById('found');
const cand = P.candidates ?? [], prom = P.promoted ?? [];
if (cand.length || prom.length) {
  const chip = (q, ru, ch, lift, isNew) =>
    '<div class="' + (isNew ? 'new' : '') + '"><b>' + q + '</b>'
    + (ru ? ' — ' + ru : '')
    + '<span>' + ch + ' кан · ×' + lift + '</span></div>';
  found.innerHTML =
    '<h3>Найдено в данных</h3>' +
    '<p class="hint">Связки слов, которые у пробившихся молодых каналов встречаются кратно чаще, чем в базе вообще. ×5 значит «в пять раз чаще обычного». Зелёные уже поехали в разведку и станут нишами через пару прогонов.</p>' +
    '<div class="cand">' +
    prom.map(t => chip(t.query, t.ru, t.channels, t.lift, true)).join('') +
    cand.map(c => chip(c.phrase, null, c.channels, c.lift, false)).join('') +
    '</div>';
}

// --- вкладка «Вывод» ---
function drawVerdict() {
  const V = P.verdict ?? [];
  const host = document.getElementById('view-verdict');
  if (!V.length) {
    host.innerHTML = '<div class="head-note">' + (P.headline ?? '') + '</div>';
    return;
  }
  const money = (r) => [
    ['$' + num(r.usd) + '/мес', 'типичный доход'],
    [r.young + ' из ' + r.total, 'молодых дошли'],
    [r.fastestMonths == null ? '—' : Math.round(r.fastestMonths) + ' мес', 'самый быстрый'],
    [r.effort ? r.effort.hoursPerWeek + ' ч/нед' : '—', 'темп лидеров'],
    [r.catalog == null ? '—' : Math.round(r.catalog) + ' видео', 'каталог лидера'],
    [r.shelf == null ? '—' : '×' + r.shelf.toFixed(1), 'долговечность'],
  ].map(([v, l]) => '<div><b>' + v + '</b><span>' + l + '</span></div>').join('');

  host.innerHTML =
    '<div class="head-note">' + (P.headline ?? '') + '</div>' +
    V.slice(0, 6).map((r, i) =>
      '<div class="pick' + (i === 0 ? ' first' : '') + '">' +
      '<div class="rk">' + (i === 0 ? 'брать первым' : '№' + (i + 1)) + '</div>' +
      '<h4>' + r.query + (r.ru ? ' <em>' + r.ru + '</em>' : '') + '</h4>' +
      '<div class="mk">' + r.market + ' рынок · ' + r.group + '</div>' +
      '<div class="money">' + money(r) + '</div>' +
      '<p><span class="lab">почему сейчас:</span> ' + r.why + '</p>' +
      '<p><span class="lab">риск:</span> ' + r.risk + '</p>' +
      (r.shelf != null
        ? '<p><span class="lab">долговечность:</span> ролики старше полугода собирают в '
          + r.shelf.toFixed(1) + ' раза больше, чем можно было бы ждать по их числу'
          + (r.shelfLive ? ' — посчитано по живому приросту за дни наблюдения.' : ' — оценка по накопленным просмотрам, точная появится через неделю сбора.') + '</p>'
        : '') +
      (r.catalogMax
        ? '<p><span class="lab">хватит ли тем:</span> у дошедших каналов в среднем '
          + Math.round(r.catalog) + ' роликов по этой теме, у самого крупного — ' + r.catalogMax + '.</p>'
        : '') +
      (r.effort && r.effort.hoursPerMonth
        ? '<p><span class="lab">объём:</span> дошедшие каналы выпускают около '
          + plural(r.effort.hoursPerMonth, 'часа', 'часов', 'часов') + ' готового видео в месяц'
          + (r.effort.minutes ? ', типовой ролик — ' + r.effort.minutes + ' мин' : '') + '.</p>'
        : '') +
      '</div>').join('') +
    '<p class="disclaim">Цель — $' +
      P.target.usd + ' в месяц при RPM $' + P.target.rpm +
      '. RPM зависит от тематики и аудитории, точной цифры API не даёт, так что доход здесь — оценка порядка, а не обещание.</p>';
}

// --- вкладка «Архетипы каналов» ---
function drawArch() {
  const A = P.archetypes ?? [];
  const host = document.getElementById('view-arch');
  if (!A.length) {
    host.innerHTML = '<div class="head-note">Пока не набралось групп каналов, снимающих одно и то же. Нужны прогоны.</div>';
    return;
  }
  host.innerHTML =
    '<div class="head-note">Ниша — это не тема, а <b>набор тем, которые одни и те же каналы снимают вместе</b>. ' +
    'Спорить, «чёрные дыры — ниша или тема», незачем: видно, кто что публикует рядом. ' +
    'Ниже — группы каналов, вышедших на цель, и темы, которые у них общие. Это готовая рамка для канала.</div>' +
    A.map(a => {
      const hot = a.young >= 3;
      return '<div class="arch' + (hot ? ' hot' : '') + '">' +
        '<h4>' + a.topics.slice(0, 3).map(t => t.topic).join(' · ') + '</h4>' +
        '<div class="sub">' + plural(a.channels, 'канал', 'канала', 'каналов') +
          ', из них моложе года — ' + a.young +
          (a.fastestDays != null ? ' · самый быстрый дошёл за ' + Math.round(a.fastestDays / 30.4) + ' мес' : '') +
        '</div>' +
        '<div class="money">' +
          '<div><b>$' + num(a.medianUsd) + '/мес</b><span>типичный доход</span></div>' +
          '<div><b>' + Math.round(a.medianCatalog ?? 0) + '</b><span>роликов в каталоге</span></div>' +
          '<div><b>' + (Math.round((a.medianMinutesPerWeek ?? 0) / 6) / 10) + ' ч/нед</b><span>темп</span></div>' +
        '</div>' +
        '<div class="tops">' + a.topics.slice(0, 12).map(t =>
          '<span>' + t.topic + '</span>').join('') + '</div>' +
        '<div class="chans">' + a.examples.map(e =>
          '<b>' + e.title + '</b> <span class="u">$' + num(e.usd) + '/мес</span>' +
          (e.ageDays != null ? ' · ' + plural(e.ageDays, 'день', 'дня', 'дней') : '') +
          ' · ' + e.videos + ' видео').join('<br>') + '</div>' +
      '</div>';
    }).join('');
}

const views = [['verdict', 'Вывод'], ['arch', 'Архетипы каналов'], ['all', 'Все ниши']];
let view = 'verdict';
function drawViews() {
  document.getElementById('view-tabs').innerHTML = views.map(([k, t]) =>
    '<button data-v="' + k + '" aria-selected="' + (k === view) + '">' + t + '</button>').join('');
  document.querySelectorAll('#view-tabs button').forEach(b => b.onclick = () => {
    view = b.dataset.v;
    show();
    drawViews();
  });
  show();
}
function show() {
  for (const [k] of views) document.getElementById('view-' + k).hidden = view !== k;
}

drawVerdict();
drawArch();
drawViews();
draw();
</script>
</body>
</html>
`;
}
