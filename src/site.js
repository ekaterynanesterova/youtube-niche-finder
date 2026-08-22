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
      if (v.views < thresholds.workingViews) continue;
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
          chMedian: ch.medianViews, usd: ch.monthlyUsd, earning: ch.started,
        });
      }
    }
  }
  for (const sid of Object.keys(examples)) {
    for (const lang of Object.keys(examples[sid])) {
      // По одному ролику на канал: иначе список показывает один канал пять раз
      // и создаёт впечатление, что больше в нише никого нет.
      const seenCh = new Set();
      examples[sid][lang] = examples[sid][lang]
        .sort((a, b) => (b.earning - a.earning) || (b.usd - a.usd) || (b.views - a.views))
        .filter((v) => !seenCh.has(v.channel) && seenCh.add(v.channel))
        .slice(0, 6);
    }
  }

  const withRu = Object.values(m.niches).map((n) => ({ ...n, ru: byId[n.id]?.ru ?? null }));
  const markets = marketStats(m.channels, thresholds);
  const verdict = buildVerdict({ niches: withRu, thresholds });

  // Кто уже работает в нише. Без этого списка «брать первым» — совет вслепую:
  // не видно ни числа конкурентов, ни того, насколько они крупные.
  const med = (xs) => {
    const a = xs.filter(Number.isFinite).sort((p, q) => p - q);
    return a.length ? a[a.length >> 1] : null;
  };
  for (const r of verdict) {
    const vids = m.videos.filter((v) => v.seeds.includes(r.id) && m.channels[v.channelId]?.lang === r.lang);
    const per = new Map();
    for (const v of vids) (per.get(v.channelId) ?? per.set(v.channelId, []).get(v.channelId)).push(v);
    r.rivals = [...per.entries()]
      .filter(([, vs]) => vs.length >= (thresholds.nicheMinVideosPerChannel ?? 3))
      .map(([id, vs]) => {
        const c = m.channels[id];
        const fresh = vs.filter((v) => v.ageDays >= 7 && v.ageDays <= 60);
        return {
          id, title: c.title, subs: c.subscribers,
          age: c.ageDays == null ? null : Math.round(c.ageDays),
          exact: !!c.firstUploadComplete,
          inNiche: vs.length, videos: c.videoCount,
          usd: Math.round(c.monthlyUsd ?? 0),
          fresh: fresh.length >= 2 ? med(fresh.map((v) => v.views)) : null,
          best: Math.max(...vs.map((v) => v.views)),
          young: c.ageDays != null && c.ageDays <= thresholds.youngChannelDays,
        };
      })
      .sort((a, b) => b.usd - a.usd)
      .slice(0, 14);
  }

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
    gainWindowDays: m.gainWindowDays,
    channelCount: Object.keys(m.channels).length,
    videoCount: m.videos.length,
    minChannels: 3,
    niches, examples, verdict, markets,
    pending: verdict.pending ?? [],
    // Списки для раскрытия по клику: посмотреть глазами, что вообще собрано.
    topChannels: Object.values(m.channels)
      .filter((c) => c.title)
      .sort((a, b) => (b.monthlyUsd ?? 0) - (a.monthlyUsd ?? 0))
      .slice(0, 300)
      .map((c) => ({ id: c.id, title: c.title, lang: c.lang, usd: Math.round(c.monthlyUsd ?? 0),
                     age: c.ageDays == null ? null : Math.round(c.ageDays),
                     reg: c.registeredDays == null ? null : Math.round(c.registeredDays),
                     exact: !!c.firstUploadComplete,
                     videos: c.videoCount, subs: c.subscribers })),
    topVideos: m.videos
      .sort((a, b) => b.views - a.views)
      .slice(0, 300)
      .map((v) => ({ id: v.id, title: v.title, views: v.views,
                     minutes: Math.round(v.durationSec / 60),
                     age: Math.round(v.ageDays),
                     channel: m.channels[v.channelId]?.title ?? null })),
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
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%234ade80'/%3E%3Cstop offset='1' stop-color='%2360a5fa'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='64' height='64' rx='15' fill='%230d1014'/%3E%3Ccircle cx='27' cy='27' r='16' fill='none' stroke='url(%23g)' stroke-width='5'/%3E%3Cpath d='M40 40 L54 54' stroke='url(%23g)' stroke-width='7' stroke-linecap='round'/%3E%3Cpath d='M31 18h-3a5 5 0 0 0-5 5v14' fill='none' stroke='%23e8ecf2' stroke-width='4.5' stroke-linecap='round'/%3E%3Cpath d='M19 27h11' stroke='%23e8ecf2' stroke-width='4.5' stroke-linecap='round'/%3E%3C/svg%3E">
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
button.stat{font:inherit;text-align:left;cursor:pointer;color:inherit}
button.stat:hover{border-color:var(--brand)}
button.stat[aria-expanded="true"]{border-color:var(--brand);
  background:color-mix(in srgb,var(--brand) 12%,var(--raise))}
#drill{margin-top:14px;background:var(--card);border:1px solid var(--line);
  border-radius:var(--r);padding:14px;max-height:60vh;overflow:auto}
#drill h4{margin:0 0 10px;font-size:13px;text-transform:uppercase;
  letter-spacing:.07em;color:var(--dim)}
#drill table{border-collapse:collapse;width:100%;font-size:13px}
#drill th{text-align:left;color:var(--dim);font-weight:600;font-size:11px;
  text-transform:uppercase;letter-spacing:.05em;padding:6px 8px;
  position:sticky;top:0;background:var(--card)}
#drill td{padding:6px 8px;border-top:1px solid var(--line);
  font-variant-numeric:tabular-nums}
#drill td:first-child{max-width:340px}
#drill a{color:inherit;text-decoration:none}
#drill a:hover{color:var(--brand)}
#drill .reg{color:var(--dim);font-size:11px}
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
.pend{margin-top:26px;border-top:1px solid var(--line);padding-top:16px}
.pend h3{font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim);margin:0 0 6px}
.pend .hint{color:var(--dim);font-size:13px;max-width:64ch;margin:0 0 12px}
.rivals{margin-top:12px;border-top:1px solid var(--line);padding-top:11px}
.rivals > summary{cursor:pointer;list-style:none;font-size:13px;color:var(--brand)}
.rivals > summary::-webkit-details-marker{display:none}
.rivals > summary::after{content:' ▾'}
.rivals[open] > summary::after{content:' ▴'}
.rivals table{border-collapse:collapse;width:100%;font-size:12.5px;margin-top:10px;
  display:block;overflow-x:auto;white-space:nowrap}
.rivals th{text-align:left;color:var(--dim);font-weight:600;font-size:10.5px;
  text-transform:uppercase;letter-spacing:.05em;padding:5px 9px 5px 0;vertical-align:bottom}
.rivals td{padding:5px 9px 5px 0;border-top:1px solid var(--line);font-variant-numeric:tabular-nums}
.rivals tr.y td{color:var(--good)}
.rivals a{color:inherit;text-decoration:none}
.rivals a:hover{text-decoration:underline}
.rivals .hint{color:var(--dim);font-size:12px;margin:9px 0 0;white-space:normal}
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
footer{color:var(--dim);font-size:13.5px;margin-top:34px;max-width:70ch}
.gloss{border-top:1px solid var(--line);padding:14px 0}
.gloss > summary{cursor:pointer;list-style:none;font-size:12px;color:var(--dim);
  text-transform:uppercase;letter-spacing:.07em;font-weight:600}
.gloss > summary::-webkit-details-marker{display:none}
.gloss > summary::after{content:' ▾'}
.gloss[open] > summary::after{content:' ▴'}
.gloss dl{margin:14px 0 0}
.gloss dt{color:var(--ink);font-weight:600;font-size:13.5px;margin-top:14px}
.gloss dd{margin:3px 0 0;line-height:1.55}
.gloss p{margin:12px 0 0;line-height:1.55}
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
    <div id="drill" hidden></div>
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
    <details class="gloss">
      <summary>Что означают цифры</summary>
      <dl>
        <dt>Брать первым</dt>
        <dd>Пометка на верхней карточке. Означает только одно: по собранным цифрам эта ниша выглядит лучше остальных <b>сегодня</b>. Это не рекомендация запускать канал не глядя — сначала надо открыть примеры и посмотреть, из чего сделаны ролики.</dd>

        <dt>Собирает свежий ролик у новичка</dt>
        <dd>Главное число на странице. Берём ролики, вышедшие от недели до двух месяцев назад <b>на каналах моложе года</b>, и смотрим, сколько просмотров собрал типичный. Это ответ на вопрос «а что получу я, когда выложу видео завтра».
        <br><br>Первую неделю ролик ещё разгоняется, поэтому свежее недели не берём.</dd>

        <dt>Свежих берут 20 тысяч и выше / 100 тысяч и выше</dt>
        <dd>Насколько это повторяемо. Медиана может быть приличной, а половина роликов при этом уходит в пустоту. Если из свежих роликов планку берут 50%, ниша принимает новичков; если 5% — там выстреливают единицы, а остальные работают впустую.</dd>

        <dt>Новичков уже зарабатывают</dt>
        <dd>Сколько каналов моложе года приносят хоть сколько-нибудь заметные деньги. Судить двухмесячный канал целью в $2000 бессмысленно — у него десять роликов. Важно другое: формат сработал у новичка, значит сработает и у тебя.</dd>

        <dt>В месяц у среднего новичка</dt>
        <dd>Сколько зарабатывает такой канал-новичок — не лучший и не худший, а ровно посередине. Это то, на что реально рассчитывать в первые месяцы.</dd>

        <dt>Выросли до $2000+</dt>
        <dd>Сколько каналов ниши, любого возраста, дошли до полной цели. Показывает потолок: до чего вообще можно дорасти в этой теме.</dd>

        <dt>Быстрее всех дошёл за</dt>
        <dd>Сколько месяцев понадобилось самому шустрому новичку. Ответ на вопрос «сколько ждать».</dd>

        <dt>Выпускают лидеры</dt>
        <dd>Сколько часов готового видео в неделю держат те, кто дошёл. Это цена входа по времени, измеренная, а не придуманная.</dd>

        <dt>Роликов у лидера</dt>
        <dd>Сколько видео по этой теме держит типичный дошедший канал. Отвечает на вопрос «а что я буду снимать после десятого ролика».</dd>

        <dt>Старым роликам достаётся / их доля</dt>
        <dd>Работает ли на тебя видео, снятое полгода назад — самый важный вопрос, если ты хочешь занять место, а не бежать без остановки.
        <br><br>Считается так. Берём все ролики ниши и делим на свежие и старше полугода. Смотрим два числа: какую долю каталога составляют старые и какая доля <b>новых просмотров за последние сутки</b> им досталась.
        <br><br>Пример из живых данных. В нише «space documentary» 2 403 ролика, из них 1 329 старше полугода — это <b>55% каталога</b>. А новых просмотров им досталось <b>28%</b>. Вдвое меньше, чем следовало бы по их числу: зритель смотрит свежее, старое лежит мёртвым грузом.
        <br><br>Для сравнения «antarctica»: старых 32% каталога, а свежих просмотров им идёт 45% — <b>больше</b> своей доли. Там ролик, снятый год назад, продолжает приносить просмотры.
        <br><br>Первое число больше второго — хорошо, место можно занять. Меньше — беговая дорожка: перестала выпускать, доход исчез. Считается по приросту между срезами, поэтому в первые дни цифра шумит.</dd>

        <dt>Конвейер</dt>
        <dd>Доля каналов, выпускающих больше трёх часов готового видео в неделю. Это мера потока, а не качества: инструмент не видит, что внутри ролика. Высокий конвейер значит, что конкурировать придётся объёмом — но он же доказывает, что формат ставится на поток.</dd>

        <dt>Роликов по теме на YouTube</dt>
        <dd>Оценка самого YouTube: сколько всего роликов подходит под запрос. Приходит вместе с результатами поиска и это единственная прямая мера того, насколько тема велика <b>на самом деле</b>, а не в нашей базе.
        <br><br>Важно не путать её с числом каналов в таблице конкурентов: там показано, сколько нашли <b>мы</b>. Если по теме сделан один поиск, найдётся горстка каналов — и это ничего не говорит о YouTube.</dd>

        <dt>Ещё изучаем</dt>
        <dd>Темы, по которым сделано меньше трёх поисков или найдено меньше пятнадцати каналов. В рейтинг они не попадают намеренно: проценты по трём каналам выглядят убедительно и не значат ничего.</dd>

        <dt>Риск</dt>
        <dd>Строка под каждой нишей. Собирается из цифр автоматически, а не пишется вручную. Разбирает четыре вещи: собирает ли свежий ролик хоть что-то, насколько тонкая выборка (мало каналов или мало свежих роликов — красивые проценты по ним ничего не значат), не работает ли ниша на потоке и не слишком ли тяжёлый там типовой ролик.</dd>

        <dt>Не дотягивают</dt>
        <dd>Доля каналов, у которых попадания есть, а денег почти нет. YouTube на старте раздаёт показы всем, и один залетевший ролик может случиться у кого угодно.</dd>

        <dt>Таблица конкурентов</dt>
        <dd>Раскрывается под каждой нишей по строке «N каналов уже в этой теме». Показывает, с кем придётся делить зрителя.
        <br><br><b>Зелёным подсвечены каналы моложе года</b> — смотреть надо именно на них. Если зелёных нет вообще, значит в теме сидят одни старожилы и новичка туда не пускают.
        <br><br><b>Роликов по теме</b> — сколько у канала видео именно по этой теме из всего его каталога. «16 из 85» значит, что канал занимается темой всерьёз и это настоящий конкурент. «3 из 336» — что он забежал сюда случайно и конкурентом не является.
        <br><br><b>Свежий ролик</b> — сколько собрал типичный ролик этого канала возрастом от недели до двух месяцев. Прочерк значит, что таких роликов у него меньше двух: канал в этой теме сейчас не работает.
        <br><br><b>Лучший</b> — самый успешный ролик канала по этой теме за всё время. Большой разрыв между «лучшим» и «свежим» означает, что канал живёт на старом успехе.</dd>

        <dt>Возраст канала</dt>
        <dd>Считается от первой загрузки, а не от регистрации: канал могли завести годами раньше и держать пустым. Если даты сильно расходятся, рядом стоит «рег.» — это и есть тот самый прогретый аккаунт. Вопросительный знак значит, что архив ещё не долистан до конца.</dd>

        <dt>Деньги</dt>
        <dd>Оценка по единой ставке $5 за тысячу просмотров. Настоящая ставка отличается по темам в разы, и API её не отдаёт — так что это порядок величины, чтобы понимать масштаб, а не обещание дохода.</dd>
      </dl>
    </details>

    <details class="gloss">
      <summary>Как это считается</summary>
      <p>Инструмент ищет не темы, а <b>каналы, которые пробились недавно</b>. Каждый день он обходит YouTube по списку тем, добирает каналы из Trending — чтобы не вариться в одном и том же — и записывает просмотры всех найденных роликов. Разница между вчерашним и сегодняшним срезом и есть рост, которого API не отдаёт.</p>
      <p>Видео попадает в нишу по своему заголовку, а не по запросу, которым нашли канал. Канал засчитывается нише, только если таких роликов у него хотя бы три.</p>
      <p><b>Он не видит содержимое ролика</b> — ни картинку, ни монтаж, ни то, сделано это руками или нагенерировано. Только заголовки, длительность, даты и счётчики. Последнее слово всегда за глазами: открыть примеры и посмотреть.</p>
    </details>
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
          ? 'канал уже зарабатывает ≈ $' + num(v.usd) + '/мес · ' + v.breakouts + ' видео выше 100 тыс. из ' + v.videos
          : 'пока почти ничего: ≈ $' + num(v.usd) + '/мес · медиана канала ' + num(v.chMedian)}</div>
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

// Плашки — кнопки: за цифрой должно быть видно, что за ней стоит.
function drawList(kind) {
  const box = document.getElementById('drill');
  if (!kind) { box.innerHTML = ''; box.hidden = true; return; }
  box.hidden = false;
  if (kind === 'channels') {
    box.innerHTML = '<h4>Каналы — 300 самых заметных из ' + P.channelCount + '</h4>' +
      '<table><tr><th>Канал</th><th>Язык</th><th>$/мес</th><th>С первого видео</th><th>Видео</th><th>Подписчики</th></tr>' +
      (P.topChannels ?? []).map(c =>
        '<tr><td><a href="https://youtube.com/channel/' + c.id + '" target="_blank" rel="noopener">' +
        (c.title || '') + '</a></td><td>' + (c.lang || '—') + '</td><td>$' + num(c.usd) +
        '</td><td>' + (c.age == null ? '—'
          : num(c.age) + ' дн' + (c.exact ? '' : '?')
            + (c.reg != null && c.reg - c.age > 60 ? ' <span class="reg">рег. ' + num(c.reg) + '</span>' : ''))
        + '</td><td>' + num(c.videos) +
        '</td><td>' + (c.subs == null ? '—' : num(c.subs)) + '</td></tr>').join('') + '</table>';
  } else {
    box.innerHTML = '<h4>Видео — 300 самых просматриваемых из ' + P.videoCount.toLocaleString('ru-RU') + '</h4>' +
      '<table><tr><th>Ролик</th><th>Канал</th><th>Просмотры</th><th>Длина</th><th>С первого видео</th></tr>' +
      (P.topVideos ?? []).map(v =>
        '<tr><td><a href="https://youtu.be/' + v.id + '" target="_blank" rel="noopener">' +
        (v.title || '') + '</a></td><td>' + (v.channel || '') + '</td><td>' + num(v.views) +
        '</td><td>' + v.minutes + ' мин</td><td>' + num(v.age) + ' дн</td></tr>').join('') + '</table>';
  }
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

let openList = null;
document.getElementById('stats').innerHTML = [
  [P.channelCount.toLocaleString('ru-RU'), 'каналов'],
  [P.videoCount.toLocaleString('ru-RU'), 'видео'],
  [P.snapshotDays, 'дней сбора'],
].map(([v, l], i) => (i < 2
    ? \`<button class="stat act" data-k="\${i === 0 ? 'channels' : 'videos'}"><b>\${v}</b><span>\${l} ›</span></button>\`
    : \`<div class="stat"><b>\${v}</b><span>\${l}</span></div>\`)).join('');

document.querySelectorAll('.stat.act').forEach(b => b.onclick = () => {
  openList = openList === b.dataset.k ? null : b.dataset.k;
  drawList(openList);
  document.querySelectorAll('.stat.act').forEach(x =>
    x.setAttribute('aria-expanded', x.dataset.k === openList));
});

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
    [num(r.fresh), 'собирает свежий ролик у новичка'],
    [pct(r.freshOver20k), 'свежих берут 20 тысяч и выше'],
    [pct(r.freshOver100k), 'свежих берут 100 тысяч и выше'],
    [r.young + '', 'новичков уже зарабатывают'],
    ['$' + num(r.usd), 'в месяц у среднего новичка'],
    [r.mature ? r.mature + '' : '—', 'выросли до $2000+'],

    [r.fastestMonths == null ? '—' : Math.round(r.fastestMonths) + ' мес', 'быстрее всех дошёл за'],
    [r.effort ? r.effort.hoursPerWeek + ' ч/нед' : '—', 'выпускают лидеры'],
    [r.catalog == null ? '—' : Math.round(r.catalog) + '', 'роликов у лидера'],
    [r.shelfShare == null ? '—' : pct(r.shelfShare) + ' / ' + pct(r.shelfOldShare),
     'старым роликам достаётся / их доля'],
    [r.totalResults == null ? '—' : num(r.totalResults), 'роликов по теме на YouTube'],
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
      (r.shelf != null && r.shelfOldShare != null
        ? '<p><span class="lab">старые ролики:</span> видео старше полугода — это '
          + pct(r.shelfOldShare) + ' всех роликов ниши, а достаётся им '
          + pct(r.shelfShare) + (r.shelfLive ? ' свежих просмотров' : ' всех накопленных просмотров')
          + '. ' + (r.shelf >= 1.3
              ? 'То есть заметно больше, чем следовало бы по их числу — старое видео здесь продолжает работать.'
              : r.shelf >= 0.9
                ? 'Примерно столько, сколько следовало бы по их числу.'
                : 'То есть меньше, чем следовало бы по их числу — старое видео здесь почти не смотрят.')
          + (r.shelfLive
              ? ' Считано по живому приросту за ' + plural(P.gainWindowDays || 1, 'день', 'дня', 'дней') +
                ((P.gainWindowDays || 1) < 7 ? ', окно ещё короткое.' : '.')
              : ' Пока это оценка по накопленным просмотрам, точная появится через неделю сбора.')
          + '</p>'
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
      (r.rivals && r.rivals.length
        ? '<details class="rivals"><summary>' + plural(r.rivals.length, 'канал', 'канала', 'каналов')
          + ' уже в этой теме — посмотреть конкуренцию</summary>'
          + '<table><tr><th>Канал</th><th>С первого видео</th><th>Роликов<br>по теме</th>'
          + '<th>Свежий<br>ролик</th><th>Лучший</th><th>$/мес</th><th>Подписчики</th></tr>'
          + r.rivals.map(c =>
              '<tr class="' + (c.young ? 'y' : '') + '">'
              + '<td><a href="https://youtube.com/channel/' + c.id + '" target="_blank" rel="noopener">'
              + (c.title || '') + '</a></td>'
              + '<td>' + (c.age == null ? '—' : num(c.age) + ' дн' + (c.exact ? '' : '?')) + '</td>'
              + '<td>' + c.inNiche + ' из ' + num(c.videos) + '</td>'
              + '<td>' + (c.fresh == null ? '—' : num(c.fresh)) + '</td>'
              + '<td>' + num(c.best) + '</td>'
              + '<td>$' + num(c.usd) + '</td>'
              + '<td>' + (c.subs == null ? '—' : num(c.subs)) + '</td></tr>').join('')
          + '</table><p class="hint">Зелёным — каналы моложе года. «Свежий ролик» — медиана '
          + 'по роликам возрастом от недели до двух месяцев.</p></details>'
        : '') +
      '</div>').join('') +
    ((P.pending ?? []).length
      ? '<div class="pend"><h3>Ещё изучаем</h3>'
        + '<p class="hint">По этим темам сделано меньше трёх поисков или найдено меньше пятнадцати каналов. '
        + 'Судить по ним рано: маленькое число каналов здесь означает не «на YouTube их мало», '
        + 'а «мы ещё не искали».</p><div class="cand">'
        + P.pending.slice(0, 24).map(c =>
            '<div><b>' + c.query + '</b>' + (c.ru ? ' — ' + c.ru : '')
            + '<span>' + c.searches + ' поиск' + (c.searches === 1 ? '' : 'а')
            + ' · ' + c.channels + ' каналов'
            + (c.totalResults != null ? ' · на YouTube ~' + num(c.totalResults) : '') + '</span></div>').join('')
        + '</div></div>'
      : '') +
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
