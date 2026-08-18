// Страница собирается на каждом прогоне с уже вшитыми данными.
// Никаких fetch: нечему падать, нечего кешировать, работает и с диска.
import { score } from './report.js';

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
        });
      }
    }
  }
  for (const sid of Object.keys(examples)) {
    for (const lang of Object.keys(examples[sid])) {
      examples[sid][lang] = examples[sid][lang]
        .sort((a, b) => b.ratio - a.ratio).slice(0, 5);
    }
  }

  const niches = Object.values(m.niches).map((n) => ({
    id: n.id, group: n.group, control: n.control,
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
    niches, examples,
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
.q{color:var(--dim);font-size:12.5px;margin-top:2px}
.rank{color:var(--dim);font-variant-numeric:tabular-nums;font-size:13px;margin-right:8px}

.meter{display:flex;align-items:center;gap:10px;min-width:150px}
.track{flex:1;height:8px;border-radius:99px;background:var(--line);overflow:hidden}
.fill{height:100%;border-radius:99px}
.pv{font-variant-numeric:tabular-nums;font-weight:600;font-size:15px;min-width:44px;text-align:right}

.chips{display:flex;flex-wrap:wrap;gap:6px;padding:0 16px 14px}
.k{background:var(--raise);border:1px solid var(--line);border-radius:8px;
  padding:5px 9px;font-size:12.5px;color:var(--dim)}
.k b{color:var(--ink);font-variant-numeric:tabular-nums;font-weight:600}
.k.warn b{color:var(--bad)}

.detail{border-top:1px solid var(--line);padding:14px 16px;background:var(--raise)}
.detail h4{margin:0 0 8px;font-size:12px;text-transform:uppercase;
  letter-spacing:.07em;color:var(--dim);font-weight:600}
.vid{display:block;padding:9px 0;border-bottom:1px solid var(--line);
  color:inherit;text-decoration:none}
.vid:last-child{border-bottom:0}
.vid:hover .vt{color:var(--brand)}
.vt{font-size:14px;line-height:1.4}
.vm{color:var(--dim);font-size:12px;margin-top:3px;font-variant-numeric:tabular-nums}
.empty{color:var(--dim);font-size:13.5px;padding:28px 16px;text-align:center;
  background:var(--card);border:1px dashed var(--line);border-radius:var(--r)}

footer{color:var(--dim);font-size:13.5px;margin-top:34px;max-width:64ch}
footer h3{color:var(--ink);font-size:13px;text-transform:uppercase;
  letter-spacing:.07em;margin:22px 0 8px}
footer p{margin:0 0 10px}
footer b{color:var(--ink)}
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

  <div class="panel">
    <div class="row"><span class="lbl">Рынок</span><span id="f-market"></span></div>
    <div class="row"><span class="lbl">Тема</span><span id="f-group"></span></div>
    <div class="row"><span class="lbl">Длина</span><span id="f-len"></span></div>
    <div class="row"><span class="lbl">Мусор</span><span id="f-slop"></span></div>
    <div class="row"><span class="lbl">Сортировка</span><span id="f-sort"></span></div>
  </div>

  <div class="count" id="count"></div>
  <div id="list"></div>

  <footer>
    <h3>Что означают цифры</h3>
    <p><b>Проницаемость</b> — какая доля каналов с выбросами была моложе года в момент выстрела. Высокая означает, что алгоритм раздаёт трафик формату, а не накопленной аудитории. Низкая — сидят старожилы, новичку не пробиться.</p>
    <p><b>Пробилось</b> — сколько <i>разных</i> молодых каналов дали выброс. Смотреть надо именно сюда. Канал бывает мёртвым сам по себе: те же самые видео на другом канале собирают просмотры. Один выброс — это про везение одного канала, а не про нишу. Ниже трёх разных каналов ниша вообще не показывается.</p>
    <p><b>Длина</b> — сколько минут длится типовое выстрелившее видео. Это прямая цена входа: чтобы проверить нишу, нужно залить около десяти роликов.</p>
    <p><b>Мусор</b> — доля молодых каналов-конвейеров, выпускающих от пяти видео в неделю. Высокая означает, что нишу заливают штампованным потоком. YouTube такое давит, и попасть под общую метлу проще, чем выделиться.</p>
    <h3>Чего эти цифры не знают</h3>
    <p>Они не предсказывают будущее и не понимают, снимешь ли ты такое за день. Они показывают, где дверь открыта <b>сейчас</b>. Дальше — открыть примеры внутри ниши и посмотреть глазами.</p>
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
const SLOP = [[1,'любой'],[0.3,'до 30%'],[0.15,'до 15%'],[0.001,'без мусора']];
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
    .filter(r => (r.m.slopShare ?? 0) <= S.maxSlop)
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
  const slopWarn = (m.slopShare ?? 0) > .3 ? ' warn' : '';

  return \`<details class="niche">
    <summary>
      <div>
        <div class="nm"><span class="rank">\${i + 1}</span>\${q}</div>
        <div class="q">\${r.group}\${r.control ? ' · опорная тема' : ''}</div>
      </div>
      <div class="meter">
        <div class="track"><div class="fill" style="width:\${Math.round((m.permeability ?? 0) * 100)}%;background:\${tone(m.permeability)}"></div></div>
        <div class="pv" style="color:\${tone(m.permeability)}">\${pct(m.permeability)}</div>
      </div>
    </summary>
    <div class="chips">
      <span class="k">пробилось <b>\${m.youngOutlierChannels}</b> из \${m.outlierChannels}</span>
      <span class="k">медиана выброса <b>\${num(m.medianOutlierViews)}</b></span>
      <span class="k">длина <b>\${m.medianOutlierMinutes == null ? '—' : Math.round(m.medianOutlierMinutes)}</b> мин</span>
      <span class="k\${slopWarn}">мусор <b>\${pct(m.slopShare)}</b></span>
      <span class="k">лайки <b>\${m.medianLikeRate == null ? '—' : (m.medianLikeRate * 100).toFixed(1) + '%'}</b></span>
      <span class="k">каналов <b>\${m.channels}</b></span>
    </div>
    <div class="detail">
      <h4>Кто пробился — открой и посмотри глазами</h4>
      \${ex.length ? ex.map(v => \`<a class="vid" href="https://youtu.be/\${v.id}" target="_blank" rel="noopener">
        <div class="vt">\${v.title ?? ''}</div>
        <div class="vm">\${v.channel ?? ''} · \${num(v.views)} просмотров · ×\${v.ratio.toFixed(1)} к медиане канала · \${v.minutes} мин · каналу было \${plural(v.channelAge, 'день', 'дня', 'дней')}</div>
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
    rs.length ? plural(rs.length, 'ниша', 'ниши', 'ниш') + ' проходит фильтры'
              : '';
  document.getElementById('list').innerHTML = rs.length
    ? rs.map(card).join('')
    : '<div class="empty">Под эти условия ничего не подошло. Ослабь фильтры — или данных пока просто мало.</div>';
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

draw();
</script>
</body>
</html>
`;
}
