// Страница собирается на каждом прогоне с уже вшитыми данными.
// Никаких fetch: нечему падать, нечего кешировать, работает и с диска.
import { score } from './report.js';
import { buildVerdict, headline, marketStats } from './verdict.js';
import { buildArchetypes } from './archetypes.js';
import { isAdLimited, POLICY } from './topics.js';

const MARKET_LABEL = { de: 'Немецкий', en: 'Английский' };

// Время показываем по Берлину: смотрят страницу оттуда, а крон живёт в UTC.
function berlin(d) {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit',
  }).format(d);
}

function scheduleText() {
  const now = new Date();
  // Крон стоит на 07:30 UTC — сразу после обнуления квоты Google.
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 7, 30));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const sameDay = next.getUTCDate() === now.getUTCDate();
  return { updated: berlin(now), next: berlin(next), nextDay: sameDay ? 'сегодня' : 'завтра' };
}

function growthSinceLastRun(runs) {
  const last = runs.at(-1), prev = runs.at(-2);
  if (!last || !prev || last.channels == null || prev.channels == null) return null;
  return { channels: last.channels - prev.channels, videos: last.videos - prev.videos };
}

export function buildPayload(m, seeds, thresholds, db = {}, focus = null) {
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
    // Тема разрешена, но реклама в ней урезана — значит оценка дохода по
    // общей ставке для неё завышена. Пишем это рядом с цифрой, иначе
    // предупреждение живёт только в переписке и теряется.
    r.adLimited = isAdLimited(r.query, r.group) || isAdLimited(r.ru ?? '');
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
          // Знаменатель — настоящий каталог канала, а не то, сколько роликов
          // мы успели собрать. Иначе «3 из 323» у HISTORY читалось как
          // профильный канал, хотя роликов у него 12 305.
          inNiche: vs.length, videos: c.catalogCount ?? c.videoCount,
          partial: !!c.catalogPartial,
          dormant: c.dormantDays == null ? null : Math.round(c.dormantDays),
          clean: c.cleanStart,
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
    // Разброс по нишам для шкалы наверху: одно число на нишу.
    spread: verdict.map((r) => ({ id: r.id, q: r.query, fresh: r.freshTop ?? r.fresh }))
              .filter((r) => r.fresh > 0),
    adLimitedWhy: POLICY.adLimited?.why ?? null,
    focus,
    pending: verdict.pending ?? [],
    broad: verdict.broad ?? [],
    broadWhy: POLICY.topicShape?.why ?? null,
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
    // Пороги отдаём на страницу целиком: если переписывать их в текст руками,
    // они разойдутся с кодом при первой же правке конфига.
    thresholds,
    // Размер базы и прирост за сутки. Прирост показываем только когда в
    // журнале есть с чем сравнивать — выдумывать его нельзя.
    dbSize: { channels: Object.keys(db.channels ?? {}).length,
              videos: Object.keys(db.videos ?? {}).length },
    // Сколько из найденного вообще посчитано. Разведка приводит каналы быстрее,
    // чем дневной срез успевает снять с них цифры, и без этой строки страница
    // выдаёт часть базы за всю базу.
    covered: { channels: Object.keys(m.channels).length, videos: m.videos.length },
    growth: growthSinceLastRun(db.state?.runs ?? []),
    seedsDone: Object.values(db.state?.seedStats ?? {}).filter((x) => x.searches > 0).length,
    seedsTotal: seeds.length,
    // Полный список тем: что искали, сколько раз и что нашли. Без него
    // «73 из 134» — просто число, по которому не видно, чего не хватает.
    topics: seeds.map((sd) => {
      const st = db.state?.seedStats?.[sd.id] ?? {};
      const n = m.niches[sd.id];
      const de = n?.byMarket?.de, en = n?.byMarket?.en;
      const best = (en?.channels ?? 0) >= (de?.channels ?? 0) ? en : de;
      return {
        id: sd.id, group: sd.group, ru: sd.ru ?? null,
        query: sd.en ?? sd.de ?? sd.id,
        auto: sd.source === 'auto',
        searches: st.searches ?? 0,
        last: st.lastSearched ?? null,
        totalResults: st.totalResults ?? null,
        newLast: st.newLastRun ?? null,
        channels: best?.channels ?? 0,
        fresh: best?.freshViews ?? null,
        adLimited: isAdLimited(sd.en ?? sd.de ?? sd.id, sd.group),
        broad: !!m.niches[sd.id]?.broad,
      };
    }).sort((a, b) => a.searches - b.searches || b.channels - a.channels),
    schedule: scheduleText(),
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
<!-- Страница не для поиска. noindex работает только если краулеру дали её
     прочитать, поэтому robots.txt обход НЕ запрещает: запрет обхода помешал бы
     увидеть эту строку, и адрес всё равно мог бы попасть в выдачу — без
     содержимого, но попасть. -->
<meta name="robots" content="noindex, nofollow, noarchive, nosnippet, noimageindex, notranslate">
<meta name="googlebot" content="noindex, nofollow, noarchive, nosnippet, noimageindex">
<meta name="referrer" content="no-referrer">
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

header{position:relative;isolation:isolate;padding:16px 0 26px}
.sky{position:absolute;inset:-26px -20px 40px;z-index:-1;border-radius:0 0 26px 26px;overflow:hidden;
  background:radial-gradient(120% 130% at 18% -20%,#1d2b4a 0%,#141b28 42%,var(--bg) 78%)}
.sky::after{content:'';position:absolute;inset:0;opacity:.7;
  background-image:radial-gradient(1.4px 1.4px at 12% 28%,#cfe0ff 50%,transparent),
   radial-gradient(1.1px 1.1px at 34% 12%,#9fc0ff 50%,transparent),
   radial-gradient(1.6px 1.6px at 58% 34%,#e6eeff 50%,transparent),
   radial-gradient(1px 1px at 76% 16%,#8fb4ff 50%,transparent),
   radial-gradient(1.3px 1.3px at 88% 46%,#dbe7ff 50%,transparent),
   radial-gradient(1px 1px at 46% 62%,#9ec1ff 50%,transparent),
   radial-gradient(1.2px 1.2px at 22% 72%,#c8dcff 50%,transparent)}
@media (prefers-color-scheme: light){
  .sky{background:radial-gradient(120% 130% at 18% -20%,#e4ecfa 0%,#eef2f8 45%,var(--bg) 80%)}
  .sky::after{opacity:.25}
}
:root[data-theme="light"] .sky{background:radial-gradient(120% 130% at 18% -20%,#e4ecfa 0%,#eef2f8 45%,var(--bg) 80%)}

.brandrow{display:flex;justify-content:space-between;align-items:center;gap:16px;
  flex-wrap:wrap;margin-bottom:24px}
.brand{display:flex;align-items:center;gap:9px;color:var(--dim);font-size:12.5px;
  letter-spacing:.11em;text-transform:uppercase}
.brand svg{color:var(--ink);flex:none}
.live{display:inline-flex;align-items:center;gap:8px;color:var(--dim);font-size:12.5px}
.live i{width:7px;height:7px;border-radius:50%;background:var(--good);flex:none;
  box-shadow:0 0 0 4px color-mix(in srgb,var(--good) 20%,transparent)}
.kick{font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:var(--good);margin-bottom:7px}
h1{margin:0;font-size:clamp(28px,6vw,46px);letter-spacing:-.035em;line-height:1.02;
  background:linear-gradient(100deg,var(--ink) 25%,var(--brand) 92%);
  -webkit-background-clip:text;background-clip:text;color:transparent}
.heroru{color:var(--brand);font-size:17px;margin-top:8px}
.nums{display:flex;gap:clamp(18px,4vw,36px);flex-wrap:wrap;margin:26px 0 22px}
.nums b{display:block;font-size:clamp(26px,5vw,34px);letter-spacing:-.02em;
  font-variant-numeric:tabular-nums;line-height:1.1}
.nums span{display:block;color:var(--dim);font-size:12px;margin-top:5px;max-width:200px}
.base{display:flex;gap:20px;flex-wrap:wrap;padding-top:16px;
  border-top:1px solid var(--line);color:var(--dim);font-size:13px}
.base b{color:var(--ink);font-variant-numeric:tabular-nums}
.base button.stat{display:inline;font:inherit;color:var(--dim);background:none;border:0;
  padding:0;margin:0;cursor:pointer;border-radius:0;line-height:inherit;
  text-decoration:underline;text-decoration-style:dashed;text-underline-offset:4px;
  text-decoration-color:var(--line)}
.base button.stat:hover{text-decoration-color:var(--brand)}
.base button.stat b{display:inline}
.base button.stat:hover b{color:var(--brand)}
.base button.stat[aria-expanded="true"]{color:var(--ink);text-decoration-color:var(--brand)}
.base em{font-style:normal;color:var(--good);font-size:11.5px}

#scale{margin:22px 0 0}
.scaletitle{color:var(--dim);font-size:12.5px;margin-bottom:14px}
.scaleaxis{display:flex;justify-content:space-between;color:var(--dim);font-size:11px;margin-bottom:7px}
.scaletrack{position:relative;height:10px;border-radius:99px;
  background:linear-gradient(90deg,#2a3140,#3c4a63 55%,color-mix(in srgb,var(--good) 55%,#3c4a63))}
.scaledot{position:absolute;top:50%;transform:translate(-50%,-50%)}
.scaledot i{display:block;width:12px;height:12px;border-radius:50%;background:var(--brand);
  border:2.5px solid var(--bg)}
.scaledot.top i{width:19px;height:19px;background:var(--good);
  box-shadow:0 0 0 5px color-mix(in srgb,var(--good) 22%,transparent)}
.scalefoot{display:flex;justify-content:space-between;align-items:flex-start;
  margin-top:14px;gap:24px}
.scalefoot .lo{color:var(--dim);font-size:12.5px;max-width:260px}
.scalefoot .hi{text-align:right}
.scalefoot .hi b{display:block;font-size:15px}
.scalefoot .hi em{font-style:normal;color:var(--good);font-size:24px;
  font-variant-numeric:tabular-nums;letter-spacing:-.02em}

.stats{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}
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
#drill .drillhint{color:var(--dim);font-size:12.5px;margin:0 0 12px;max-width:70ch;white-space:normal}
#drill tr.untouched td{color:var(--dim);opacity:.75}
#drill tr.untouched td:first-child::before{content:'○ ';color:var(--mid)}
#drill .autotag{font-size:10px;text-transform:uppercase;letter-spacing:.06em;
  color:var(--brand);border:1px solid var(--line);border-radius:5px;padding:1px 5px}
#drill .adtag{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--mid);
  border:1px solid var(--mid);border-radius:5px;padding:1px 4px;margin-left:6px;vertical-align:1px}
#drill .broadtag{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--bad);
  border:1px solid var(--bad);border-radius:5px;padding:1px 4px;margin-left:6px;vertical-align:1px}
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
.limhint{margin:12px 0 4px}
.limgroup{margin-top:18px}
.limgroup h4{margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--brand)}
.limgroup table{border-collapse:collapse;width:100%;font-size:13.5px}
.limgroup td{padding:7px 0;border-top:1px solid var(--line);vertical-align:top;line-height:1.5}
.limgroup td:first-child{color:var(--ink);font-weight:600;white-space:nowrap;
  padding-right:16px;font-variant-numeric:tabular-nums;width:1%}
.limgroup td:last-child{color:var(--dim)}
.toplimits{color:var(--dim);font-size:12.5px;margin-top:10px}
.toplimits a{color:var(--brand);text-decoration:none;border-bottom:1px dashed var(--line)}
.chat p{margin:12px 0 0;line-height:1.55}
.chat code{background:var(--card);border:1px solid var(--line);border-radius:6px;
  padding:2px 6px;font-size:12.5px;word-break:break-all;color:var(--ink)}
.chat button{margin-top:12px;margin-right:8px;background:var(--card);color:var(--ink);
  border:1px solid var(--line);border-radius:9px;padding:9px 14px;font:inherit;
  font-size:13px;cursor:pointer}
.chat button:hover{border-color:var(--brand)}
.chat .said{color:var(--good)}
.warm{color:var(--mid);font-size:11px}
/* Гистограмма ступеней просмотров. Цвета проверены валидатором на тёмном фоне:
   полоса яркости, порог насыщенности, различимость при дальтонизме и контраст
   к подложке. Плюс подписи числом у каждой полосы — цвет не единственный
   носитель смысла. */
.histd{margin:14px 0 0;border-top:1px solid var(--line);padding-top:12px}
.histd > summary{cursor:pointer;list-style:none;font-size:12.5px;color:var(--dim)}
.histd > summary::-webkit-details-marker{display:none}
.histd > summary::after{content:' ▾'}
.histd[open] > summary::after{content:' ▴'}
.histd > summary:hover{color:var(--brand)}
.hist{margin:14px 0 4px}
.hist .lg{display:flex;gap:16px;align-items:center;margin-bottom:10px;
  font-size:12px;color:var(--dim)}
.hist .lg i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:6px;
  vertical-align:-1px;font-style:normal}
.hist .lg .a{background:#3b82f6}
.hist .lg .b{background:#16a34a}
.hrow{display:grid;grid-template-columns:132px 1fr;gap:12px;align-items:center;padding:5px 0}
.hrow > span{color:var(--dim);font-size:12.5px;text-align:right;font-variant-numeric:tabular-nums}
.htrack{display:flex;flex-direction:column;gap:2px;min-width:0}
.hbar{display:flex;align-items:center;gap:8px}
.hbar i{display:block;height:9px;border-radius:0 4px 4px 0;min-width:2px}
.hbar .a{background:#3b82f6}
.hbar .b{background:#16a34a}
.hbar b{font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--ink)}
.hbar em{font-size:12px;font-style:normal;color:var(--dim)}
.hnote{color:var(--dim);font-size:12.5px;line-height:1.5;margin:10px 0 0}
.example{margin:14px 0 0;padding:12px 14px;background:var(--card);border:1px solid var(--line);
  border-radius:12px;font-size:13.5px;line-height:1.5}
.example b{color:var(--good)}
.example a{color:var(--ink);text-decoration:none}
.example a:hover{color:var(--brand)}
.example span{color:var(--dim);font-size:12.5px}
.coh{margin:16px 0 0}
.coh h5{margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:.07em;color:var(--dim)}
.coh table{border-collapse:collapse;width:100%;font-size:13.5px}
.coh th{text-align:left;font-weight:600;color:var(--dim);font-size:11px;text-transform:uppercase;
  letter-spacing:.06em;padding:0 10px 7px 0;border-bottom:1px solid var(--line)}
.coh th:not(:first-child){text-align:right}
.coh td{padding:7px 10px 7px 0;border-top:1px solid var(--line)}
.coh td.n{text-align:right;font-variant-numeric:tabular-nums}
.coh tr.old td{color:var(--dim)}
.fnote{color:var(--dim);font-size:13.5px;line-height:1.55;max-width:78ch;margin:16px 0 0}
.fgrid{display:grid;gap:18px;margin-top:20px}
.fbox{background:var(--raise);border:1px solid var(--line);border-radius:14px;padding:16px 18px}
.fbox h4{margin:0 0 4px;font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:var(--brand)}
.fbox .sub{color:var(--dim);font-size:12.5px;margin:0 0 12px;line-height:1.5}
.fbox table{border-collapse:collapse;width:100%;font-size:13.5px}
.fbox th{text-align:left;font-weight:600;color:var(--dim);font-size:11px;text-transform:uppercase;
  letter-spacing:.06em;padding:0 10px 7px 0;border-bottom:1px solid var(--line)}
.fbox td{padding:8px 10px 8px 0;border-top:1px solid var(--line);vertical-align:top;line-height:1.45}
.fbox td.n{font-variant-numeric:tabular-nums;white-space:nowrap;text-align:right;padding-right:14px}
.fbox tr.y td:first-child{border-left:2px solid var(--good);padding-left:8px}
.fbox a{color:var(--ink);text-decoration:none}
.fbox a:hover{color:var(--brand)}
.up{color:var(--good);font-variant-numeric:tabular-nums;white-space:nowrap}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chips div{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:7px 11px;font-size:13px}
.chips b{font-weight:600}
.chips span{color:var(--dim);font-size:11.5px;margin-left:6px}
.chips .new{border-color:var(--good)}
.fhead{display:flex;flex-wrap:wrap;gap:16px;margin-top:14px}
.fhead div{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 14px}
.fhead b{display:block;font-size:19px;font-variant-numeric:tabular-nums}
.fhead span{color:var(--dim);font-size:11px;text-transform:uppercase;letter-spacing:.06em}
.adlim{margin:10px 0 0;padding:10px 12px;border:1px solid var(--mid);border-radius:10px;
  background:var(--card);color:var(--ink);font-size:13px;line-height:1.5}
.adlim b{color:var(--mid)}
.toplimits a:hover{border-bottom-color:var(--brand)}
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
    <div class="sky"></div>
    <div class="hin">
      <div class="brandrow">
        <div class="brand">
          <svg width="26" height="26" viewBox="0 0 64 64" fill="none" aria-hidden="true">
            <defs><linearGradient id="lens" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#4ade80"/><stop offset="1" stop-color="#60a5fa"/></linearGradient></defs>
            <circle cx="27" cy="27" r="16" stroke="url(#lens)" stroke-width="6"/>
            <path d="M40 40 L54 54" stroke="url(#lens)" stroke-width="8" stroke-linecap="round"/>
            <path d="M31 18h-3a5 5 0 0 0-5 5v14" stroke="currentColor" stroke-width="4.5" stroke-linecap="round"/>
            <path d="M19 27h11" stroke="currentColor" stroke-width="4.5" stroke-linecap="round"/></svg>
          <span>Niche Finder</span>
        </div>
        <div class="live" id="live"></div>
      </div>
      <div id="hero"></div>
      <div class="base" id="base"></div>
    </div>
  </header>

  <div id="scale"></div>
  <div id="banner"></div>
  <div id="drill" hidden></div>

  <div class="vtabs" id="view-tabs"></div>

  <section id="view-verdict"></section>

  <section id="view-focus" hidden></section>

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
    <details class="gloss" id="chat">
      <summary>Продолжить в другом чате</summary>
      <p>Вся эта статистика лежит одним файлом. Нажми кнопку, открой новый чат и вставь
      скопированное первым сообщением — разговор про темы роликов начнётся сразу с цифрами,
      ничего пересказывать не придётся. Файл перезаписывается на каждом прогоне,
      так что ссылка всегда ведёт на свежий срез.</p>
      <div class="chat">
        <p><code id="briefurl">https://raw.githubusercontent.com/ekaterynanesterova/youtube-niche-finder/main/docs/brief.md</code></p>
        <button id="copyprompt">Скопировать готовый запрос</button>
        <button id="copyurl">Скопировать только ссылку</button>
        <p id="copied" class="said"></p>
      </div>
    </details>

    <details class="gloss" id="limits">
      <summary>Пороги — какие числа за что отвечают</summary>
      <p class="limhint">Всё ниже подставляется из настроек сбора, а не переписано руками — эти числа всегда совпадают с тем, по которым реально считается страница.</p>
      <div id="limtables"></div>
    </details>

    <details class="gloss">
      <summary>Что означают цифры</summary>
      <dl>
        <dt>Брать первым</dt>
        <dd>Пометка на верхней карточке. Означает только одно: по собранным цифрам эта ниша выглядит лучше остальных <b>сегодня</b>. Это не рекомендация запускать канал не глядя — сначала надо открыть примеры и посмотреть, из чего сделаны ролики.</dd>

        <dt>Набирает ролик у канала без аудитории</dt>
        <dd>Первое число на карточке и самое честное, какое тут можно дать: <b>диапазон</b>, а не точка. Нижняя граница — четверть роликов набирает меньше, верхняя — десятая часть набирает больше. Между ними укладывается основная масса.
        <br><br>Считается по роликам возрастом от недели до двух месяцев на каналах моложе года с чистым стартом. Точку тут ставить нельзя: разброс внутри одной ниши доходит до двадцати пяти раз, и любое единственное число либо занижает, либо врёт в другую сторону.</dd>

        <dt>Сколько набирает ролик, по возрасту канала</dt>
        <dd>Таблица под гистограммой. «Моложе года» — слишком широкая полка, и она прячет главное. По всей базе:
        <br><br>канал 0–3 месяца — типичный свежий ролик 355 просмотров, верхние 10% берут 17 464, планку в 20 тысяч перешагивают 9% роликов;
        <br>3–6 месяцев — 796 / 21 816 / 11%;
        <br>6–12 месяцев — 1 962 / 52 282 / 17%;
        <br>старше года — 6 436 / 167 245 / 34%.
        <br><br>То есть между «канал создан вчера» и «каналу полгода» разница примерно впятеро, а до уровня старожилов — ещё втрое. Возраст канала значит много, и сваливать весь первый год в одну пометку «молодой» нельзя. Строка «старше года» в таблице дана серым: это не то, на что рассчитывать на старте, а потолок, до которого растут.</dd>

        <dt>Свежих роликов взяли 20 тысяч</dt>
        <dd>Главное число. Берём все ролики темы, вышедшие от недели до двух месяцев назад — <b>по всем каналам, а не только по молодым</b>, — и считаем, сколько из них перевалило за двадцать тысяч просмотров. Просмотры тут за всю жизнь ролика, а не за сутки.
        <br><br>Раньше здесь стояло одно усреднённое число, и оно врало по форме. Разброс внутри ниши доходит до двадцати пяти раз: в «dinosaur documentary» середина свежего ролика — 546 просмотров, при том что 55 роликов из 172 взяли двадцать тысяч, а 21 взял сто тысяч. Любое среднее такую картину прячет, и ниша с настоящим трафиком выглядела мёртвой.</dd>

        <dt>Гистограмма ступеней</dt>
        <dd>Раскладка тех же свежих роликов по ступеням просмотров. Синим — все каналы, зелёным — только те, что начинали с нуля и моложе года.
        <br><br>Читать её надо так. Синие полосы справа — есть ли в теме трафик вообще. Зелёные под ними — достаётся ли он тому, кто начинает без аудитории. Если зелёная полоса в верхних ступенях есть, значит новичок туда доходит; если её там нет совсем, трафик в теме держат старожилы.</dd>

        <dt>Лучшее у канала, начинавшего с нуля</dt>
        <dd>Не процент, а конкретный ролик — самый успешный свежий ролик канала с чистым стартом, со ссылкой. Рядом стоят возраст канала и число подписчиков: по ним видно, что результат не заслуга накопленной аудитории.
        <br><br>Это ответ на вопрос «а какой у меня потолок на старте» в той форме, в какой на него вообще можно ответить: показать живой пример, а не среднее по больнице.</dd>

        <dt>Лучший свежий ролик темы</dt>
        <dd>Потолок по всем каналам, включая крупные. Разрыв между ним и лучшим у новичка показывает, насколько тема держится на накопленной аудитории.</dd>

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

        <dt>Шкала наверху</dt>
        <dd>Левый и правый края — это минимум и максимум среди найденных ниш, а не заданные рамки. Шкала пересчитывается на каждом прогоне: появится ниша с полусотней тысяч — правый край станет полусотней тысяч, а нынешний лидер съедет к середине. Никакого зашитого потолка нет.
        <br><br>Шкала логарифмическая: иначе все ниши слиплись бы у левого края в одну точку.</dd>

        <dt>Ещё изучаем</dt>
        <dd>Темы, по которым сделано меньше трёх поисков или найдено меньше пятнадцати каналов. В рейтинг они не попадают намеренно: проценты по трём каналам выглядят убедительно и не значат ничего.</dd>

        <dt>Не тема</dt>
        <dd>Пометка в списке тем. Такой запрос называет формат и настроение, но не предмет: под «documentary to fall asleep to» одинаково подходят дождь, шум ветра, музыка для медитации и разбор космических миссий. Ниша из него собирается из чужих видео, а её цифры описывают не тему, а весь жанр «под что засыпают».
        <br><br>Такие темы не ранжируются и на них не тратится квота: сто юнитов за поиск, который приведёт случайные каналы всего жанра.
        <br><br>Именно так появился «спокойный космос»: запрос сводился к «fall»+«asleep», в нишу попадало всё для сна, а космос оказался там потому, что среди этого всего нашлось несколько сильных космических роликов. Канал-ориентир снимал спокойные научные факты, космос был у него третью каталога — тянул формат, а тему приписали задним числом.
        <br><br>Список слов, которые предметом не считаются, лежит в <b>config/policy.json</b>.</dd>

        <dt>Роликов с цифрами</dt>
        <dd>Разведка находит каналы быстрее, чем дневной срез успевает снять с них просмотры: поиск стоит 100 юнитов квоты, а срез — по юниту на каждые 50 роликов. Если здесь не 100%, часть найденного в статистику ещё не вошла и ниши считаются по остальному.
        <br><br>Раньше срез обходил базу с начала и обрывался на остатке бюджета — всегда в одном месте. Новые ролики дописываются в конец, поэтому именно свежие находки не получали цифр никогда. Теперь под срез откладывается доля квоты заранее, молодые ролики обходятся первыми, а старые — по кругу, чтобы за несколько прогонов дошла очередь до всех.</dd>

        <dt>Реклама урезана</dt>
        <dd>Пометка на нише и в списке тем. YouTube относит войну, конфликты и трагедии к «спорным темам и деликатным событиям»: рекламу там ставят не всю или не ставят вовсе. Тема при этом разрешена и каналы в ней зарабатывают — но общая ставка $5 за тысячу просмотров, по которой считается весь сайт, для таких ниш завышена. Читай доход по ним как верхнюю границу, а не как ожидание.
        <br><br>Инструмент не может измерить настоящую ставку: API её не отдаёт. Поэтому это пометка, а не поправочный коэффициент — придумывать множитель означало бы выдать догадку за расчёт.
        <br><br>Отдельно: немецкий рынок эти темы не ищет вовсе, они заведены только на английский. Список слов и причина лежат в <b>config/policy.json</b>.</dd>

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

        <dt>Язык канала</dt>
        <dd>Определяется по заголовкам роликов, а не по тому, что канал объявил о себе. Поле с языком заполняет владелец, и он ошибается: у канала Filmenic там стоит «английский», а ролики называются «Ek Galat Experiment Ne Bana Diya Khaufnaak Dinosaur». Такие каналы попадали в английские ниши и портили их цифры — один ролик Filmenic был лучшим в теме динозавров.
        <br><br>Считаются два признака: чужое письмо (деванагари, кириллица, арабица и прочие) и романизированный хинди с урду, где буквы латинские, а слова свои. Одиночный знак не в счёт — два немецких канала про засыпание разделяют заголовок корейской буквой «ㅣ» вместо палочки, и это украшение, а не язык.
        <br><br>Сорок каналов так вышли из английского и немецкого рынков, включая несколько крупных: Filmy Nest, Flick Explained, Razzu The Explainer.</dd>

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

// --- шапка ---
const lead = (P.verdict ?? [])[0];
document.getElementById('live').innerHTML = P.schedule
  ? '<i></i>обновлено в ' + P.schedule.updated + ' · следующий прогон ' + P.schedule.nextDay + ' в ' + P.schedule.next
  : '';

document.getElementById('hero').innerHTML = lead
  ? '<div class="kick">брать первым · ' + lead.market + ' рынок</div>'
    + '<h1>' + lead.query + '</h1>'
    + (lead.ru ? '<div class="heroru">' + lead.ru + '</div>' : '')
    + '<div class="nums">'
    + '<div><b>' + (lead.rangeLo == null ? '—' : num(lead.rangeLo) + ' – ' + num(lead.rangeHi))
      + '</b><span>набирает ролик у канала без аудитории</span></div>'
    + '<div><b>' + num(lead.demandOverWorking) + ' из ' + num(lead.demandSample)
      + '</b><span>свежих роликов взяли 20 тысяч</span></div>'
    + '<div><b>' + num(lead.freshBestNewcomer ? lead.freshBestNewcomer.views : lead.freshBest)
      + '</b><span>лучшее у канала, начинавшего с нуля</span></div>'
    + '</div>'
  : '<h1>Где дверь открыта</h1><div class="heroru">Данных пока мало — ни одна ниша не набрала достаточно.</div>';

const g = P.growth;
document.getElementById('base').innerHTML = [
  '<button class="stat act" data-k="channels"><b>' + num(P.dbSize.channels) + '</b> каналов'
    + (g && g.channels > 0 ? ' <em>+' + num(g.channels) + '</em>' : '') + ' ›</button>',
  '<button class="stat act" data-k="videos"><b>' + num(P.dbSize.videos) + '</b> роликов'
    + (g && g.videos > 0 ? ' <em>+' + num(g.videos) + '</em>' : '') + ' ›</button>',
  '<span><b>' + P.snapshotDays + '</b> ' + plural(P.snapshotDays, 'день', 'дня', 'дней').split(' ')[1] + ' накопления</span>',
  (P.covered && P.covered.videos < P.dbSize.videos
    ? '<span title="Найдено больше, чем успел снять дневной срез"><b>'
      + pct(P.covered.videos / P.dbSize.videos) + '</b> роликов с цифрами</span>'
    : ''),
  '<button class="stat act" data-k="topics"><b>' + P.seedsDone + '/' + P.seedsTotal + '</b> тем изучено ›</button>',
].join('');

// --- шкала разброса ---
// Список показывает числа по очереди, а отрыв лидера от остальных виден только
// когда все ниши стоят на одной оси.
const sp = (P.spread ?? []).filter((x) => x.fresh > 0);
if (sp.length >= 4) {
  const vals = sp.map((x) => x.fresh);
  const hi = Math.max(...vals), lo = Math.min(...vals);
  const at = (v) => {
    const a = Math.log10(Math.max(lo, 100)), b = Math.log10(hi);
    return b === a ? 50 : ((Math.log10(v) - a) / (b - a)) * 96 + 2;
  };
  const ticks = [lo, Math.sqrt(lo * hi), hi].map((v) => '<span>' + num(v) + '</span>');
  document.getElementById('scale').innerHTML =
    '<div class="scaletitle">Сколько собирает свежий ролик у канала без аудитории — все '
      + plural(sp.length, 'ниша', 'ниши', 'ниш') + ' на одной шкале</div>'
    + '<div class="scaleaxis">' + ticks.join('') + '</div>'
    + '<div class="scaletrack">'
    + sp.map((x, i) => '<div class="scaledot' + (x.fresh === hi ? ' top' : '') + '" style="left:'
        + at(x.fresh).toFixed(1) + '%" title="' + x.q + ' — ' + num(x.fresh) + '"><i></i></div>').join('')
    + '</div>'
    + '<div class="scalefoot"><div class="lo">Большинство ниш жмётся к левому краю: ролик новичка там тонет.</div>'
    + (lead ? '<div class="hi"><b>' + lead.query + '</b><em>' + num(lead.fresh) + '</em></div>' : '')
    + '</div>';
}

// --- списки за цифрами ---
// За числом должно быть видно, что за ним стоит: иначе «1803 канала» —
// просто украшение.
function drawList(kind) {
  const box = document.getElementById('drill');
  if (!kind) { box.innerHTML = ''; box.hidden = true; return; }
  box.hidden = false;
  if (kind === 'channels') {
    box.innerHTML = '<h4>Каналы — 300 самых заметных из ' + num(P.dbSize.channels) + '</h4>' +
      '<table><tr><th>Канал</th><th>Язык</th><th>$/мес</th><th>С первого видео</th><th>Видео</th><th>Подписчики</th></tr>' +
      (P.topChannels ?? []).map(c =>
        '<tr><td><a href="https://youtube.com/channel/' + c.id + '" target="_blank" rel="noopener">' +
        (c.title || '') + '</a></td><td>' + (c.lang || '—') + '</td><td>$' + num(c.usd) +
        '</td><td>' + (c.age == null ? '—'
          : num(c.age) + ' дн' + (c.exact ? '' : '?')
            + (c.reg != null && c.reg - c.age > 60 ? ' <span class="reg">рег. ' + num(c.reg) + '</span>' : ''))
        + '</td><td>' + num(c.videos) +
        '</td><td>' + (c.subs == null ? '—' : num(c.subs)) + '</td></tr>').join('') + '</table>';
  } else if (kind === 'topics') {
    const t = P.topics ?? [];
    const untouched = t.filter((x) => !x.searches).length;
    box.innerHTML = '<h4>Темы — ' + P.seedsDone + ' изучено, ' + untouched + ' ещё не искали</h4>' +
      '<p class="drillhint">Помеченные «не тема» из разведки исключены и квоту не тратят: их запрос называет формат и настроение, но не предмет. '
      + 'Разведка берёт первыми те темы, по которым поисков меньше всего — они наверху списка. ' +
      '«На YouTube» — оценка самого YouTube, сколько всего роликов подходит под запрос; она упирается в потолок в миллион.</p>' +
      '<table><tr><th>Тема</th><th>Поисков</th><th>Каналов<br>нашли</th><th>Новых<br>в последний раз</th>' +
      '<th>Свежий<br>ролик</th><th>На YouTube</th></tr>' +
      t.map(x =>
        '<tr class="' + (x.searches ? '' : 'untouched') + '">' +
        '<td>' + x.query + (x.ru ? ' <span class="reg">' + x.ru + '</span>' : '') +
          (x.auto ? ' <span class="autotag">авто</span>' : '') +
          (x.adLimited ? ' <span class="adtag">реклама урезана</span>' : '') +
          (x.broad ? ' <span class="broadtag">не тема</span>' : '') + '</td>' +
        '<td>' + (x.searches || '—') + '</td>' +
        '<td>' + (x.channels || '—') + '</td>' +
        '<td>' + (x.newLast == null ? '—' : x.newLast) + '</td>' +
        '<td>' + (x.fresh == null ? '—' : num(x.fresh)) + '</td>' +
        '<td>' + (x.totalResults == null ? '—' : num(x.totalResults)) + '</td></tr>').join('') + '</table>';
  } else {
    box.innerHTML = '<h4>Видео — 300 самых просматриваемых из ' + num(P.dbSize.videos) + '</h4>' +
      '<table><tr><th>Ролик</th><th>Канал</th><th>Просмотры</th><th>Длина</th><th>Возраст</th></tr>' +
      (P.topVideos ?? []).map(v =>
        '<tr><td><a href="https://youtu.be/' + v.id + '" target="_blank" rel="noopener">' +
        (v.title || '') + '</a></td><td>' + (v.channel || '') + '</td><td>' + num(v.views) +
        '</td><td>' + v.minutes + ' мин</td><td>' + num(v.age) + ' дн</td></tr>').join('') + '</table>';
  }
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

let openList = null;
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

// Гистограмма ступеней просмотров. Средним разброс в двадцать пять раз не
// передать: в динозаврах медиана свежего ролика 546, а 55 роликов из 172 взяли
// двадцать тысяч и 21 — сто тысяч. Показываем сразу и объём трафика в теме,
// и то, сколько его достаётся тем, кто начинает с нуля.
function histogram(rows, sample) {
  if (!rows || !rows.length) return '';
  const max = Math.max(...rows.map(r => r.all), 1);
  const w = (n) => Math.max(2, Math.round((n / max) * 100)) + '%';
  const over = rows.filter(r => r.lo >= 20000).reduce((n, r) => n + r.all, 0);
  // Свёрнута намеренно. Ответ она даёт предсказуемый — у старых каналов
  // больше, — и в развёрнутом виде занимает половину карточки ради вывода,
  // который и так известен. Нужна, когда хочется проверить именно форму:
  // где лежит масса и добирается ли туда новичок.
  return '<details class="histd"><summary>Разбивка по ступеням просмотров — '
    + num(over) + ' из ' + num(sample) + ' выше 20 тысяч</summary>'
    + '<div class="hist">'
    + '<div class="lg"><span><i class="a"></i>все каналы</span>'
    + '<span><i class="b"></i>каналы с нуля моложе года</span></div>'
    + rows.map(r =>
        '<div class="hrow"><span>' + r.label + '</span><div class="htrack">'
        + '<div class="hbar"><i class="a" style="width:' + w(r.all) + '"></i><b>' + r.all + '</b></div>'
        + '<div class="hbar"><i class="b" style="width:' + w(r.newcomer) + '"></i><em>'
        + r.newcomer + '</em></div>'
        + '</div></div>').join('')
    + '<p class="hnote">Свежие ролики темы — вышедшие от недели до двух месяцев назад, '
    + 'всего ' + num(sample) + '. Считаются штуки, а не проценты: '
    + 'по ним видно и сколько в теме трафика, и кому он достаётся.</p>'
    + '</div></details>';
}

// Возраст канала решает больше, чем кажется, и «моложе года» это прячет:
// по всей базе медиана свежего ролика у канала 0–3 месяцев — 355 просмотров,
// у 6–12 месяцев — 1 962, у старше года — 6 436. Разбивка отвечает на вопрос
// «чего ждать на третьем месяце, а чего на восьмом».
function cohortTable(rows) {
  if (!rows || !rows.some(r => r.median != null)) return '';
  return '<div class="coh"><h5>Сколько набирает свежий ролик, по возрасту канала</h5>'
    + '<table><tr><th>Возраст канала</th><th>Роликов</th><th>Типичный</th>'
    + '<th>Верхние 10%</th><th>Взяли 20 тысяч</th></tr>'
    + rows.map(r =>
        '<tr class="' + (r.lo >= 365 ? 'old' : '') + '"><td>' + r.label + '</td>'
        + '<td class="n">' + r.n + '</td>'
        + '<td class="n">' + (r.median == null ? '—' : num(r.median)) + '</td>'
        + '<td class="n">' + (r.top == null ? '—' : num(r.top)) + '</td>'
        + '<td class="n">' + (r.median == null ? '—' : r.over) + '</td></tr>').join('')
    + '</table><p class="hnote">Прочерк — роликов в когорте меньше восьми, '
    + 'считать по ним нечего. Строка «старше года» дана для сравнения: это потолок темы, '
    + 'до которого растут.</p></div>';
}

function newcomerExample(b) {
  if (!b) return '';
  return '<div class="example">Лучшее, что сделал новичок с нуля: '
    + '<a href="https://youtube.com/watch?v=' + b.id + '" target="_blank" rel="noopener">'
    + b.title + '</a><br><b>' + num(b.views) + ' просмотров</b> <span>· ролику ' + b.age + ' дн · '
    + b.minutes + ' мин · канал «' + (b.channel || '—') + '», ему ' + num(b.channelAge) + ' дн, '
    + num(b.subs) + ' подписчиков</span></div>';
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
    [r.rangeLo == null ? '—' : num(r.rangeLo) + ' – ' + num(r.rangeHi),
     'набирает ролик у канала без аудитории'],
    [num(r.demandOverWorking) + ' из ' + num(r.demandSample), 'свежих роликов взяли 20 тысяч'],
    [num(r.demandOverBreakout), 'из них взяли 100 тысяч'],
    [num(r.demandBest), 'лучший свежий ролик темы'],
    [(r.freshWinnersClean ?? 0) + ' из ' + (r.freshChannels ?? 0), 'каналов с нуля взяли 20 тысяч'],
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
      histogram(r.buckets, r.demandSample) +
      cohortTable(r.cohorts) +
      newcomerExample(r.freshBestNewcomer) +
      '<p><span class="lab">почему сейчас:</span> ' + r.why + '</p>' +
      '<p><span class="lab">риск:</span> ' + r.risk + '</p>' +
      (r.adLimited
        ? '<p class="adlim"><b>Реклама урезана.</b> ' + (P.adLimitedWhy ?? '') + '</p>'
        : '') +
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
              + '<td>' + (c.age == null ? '—' : num(c.age) + ' дн' + (c.exact ? '' : '?'))
                + (c.clean === false
                    ? '<br><span class="warm">аккаунт простоял ' + num(c.dormant) + ' дн</span>' : '')
                + '</td>'
              + '<td>' + c.inNiche + ' из ' + num(c.videos) + '</td>'
              + '<td>' + (c.fresh == null ? '—' : num(c.fresh)) + '</td>'
              + '<td>' + num(c.best) + '</td>'
              + '<td>$' + num(c.usd) + '</td>'
              + '<td>' + (c.subs == null ? '—' : num(c.subs)) + '</td></tr>').join('')
          + '</table><p class="hint">Зелёным — каналы моложе года. «Свежий ролик» — медиана '
          + 'по роликам возрастом от недели до двух месяцев. Пометка «аккаунт простоял» значит, '
          + 'что канал завели задолго до первого ролика: это перезапуск, а не новичок с нуля.</p></details>'
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

// --- вкладка фокусной ниши ---
// Здесь другой вопрос, чем на остальных вкладках. Там мы выбираем нишу, тут
// смотрим, что в своей происходит сегодня: суточный прирост, а не медианы.
function drawFocus() {
  const F = P.focus;
  const host = document.getElementById('view-focus');
  if (!F || !host) return;
  const yt = (id, t) => '<a href="https://youtube.com/watch?v=' + id + '" target="_blank" rel="noopener">' + t + '</a>';
  const ch = (id, t) => '<a href="https://youtube.com/channel/' + id + '" target="_blank" rel="noopener">' + (t || '—') + '</a>';
  const up = (n) => n == null ? '—' : '<span class="up">+' + num(n) + '</span>';

  const vidTable = (list, extra) =>
    '<table><tr><th>Ролик</th><th>Канал</th>' + (extra ? '<th>' + extra.head + '</th>' : '')
    + '<th>Возраст</th><th>Просмотров</th><th>За сутки</th></tr>'
    + list.map(r => '<tr class="' + (r.young ? 'y' : '') + '">'
      + '<td>' + yt(r.id, r.title) + (r.titleRu ? '<br><span class="reg">' + r.titleRu + '</span>' : '') + '</td>'
      + '<td>' + ch(r.channelId, r.channel) + (r.young ? '<br><span class="reg">моложе года</span>' : '') + '</td>'
      + (extra ? '<td class="n">' + extra.cell(r) + '</td>' : '')
      + '<td class="n">' + r.age + ' дн</td>'
      + '<td class="n">' + num(r.views) + '</td>'
      + '<td class="n">' + up(r.perDay) + '</td></tr>').join('')
    + '</table>';

  const box = (title, sub, body) =>
    '<div class="fbox"><h4>' + title + '</h4><p class="sub">' + sub + '</p>' + body + '</div>';

  host.innerHTML =
    '<p class="fnote">' + F.why + '</p>'
    + '<div class="fhead">'
      + '<div><b>' + num(F.videoCount) + '</b><span>роликов в теме</span></div>'
      + '<div><b>' + num(F.measured) + '</b><span>с суточным замером</span></div>'
      + '<div><b>' + num(F.channelCount) + '</b><span>каналов</span></div>'
      + '<div><b>' + F.topics.length + '</b><span>запросов в теме</span></div>'
    + '</div>'
    + '<div class="fgrid">'
    + (F.breaking.length ? box('Резко пошло',
        'Ролики, у которых суточный прирост за последний замер вырос в полтора раза и больше. Именно так выглядит новость, под которую все побежали снимать: смотреть надо в первую очередь сюда.',
        vidTable(F.breaking, { head: 'Ускорение', cell: r => '×' + r.accel.toFixed(1) })) : '')
    + (F.rising.length ? box('Набирает больше всех',
        'Просто самый большой прирост за сутки, без учёта ускорения. Что в теме смотрят прямо сейчас.',
        vidTable(F.rising)) : '')
    + (F.fresh.length ? box('Только вышло',
        'Ролики не старше двух недель. По ним видно, что конкуренты снимают сегодня — независимо от того, взлетело оно или нет.',
        vidTable(F.fresh)) : '')
    + (F.hot.length ? box('Формулировки в ходу',
        'Связки слов, доля которых среди свежих роликов выросла минимум в 1.8 раза против старых. Это не темы, а язык заголовков: чем сейчас цепляют. Рядом — сколько просмотров в сутки идёт на ролики с такой связкой.',
        '<div class="chips">' + F.hot.map(h =>
          '<div class="' + (h.lift == null ? 'new' : '') + '"><b>' + h.phrase + '</b>'
          + '<span>' + (h.lift == null ? 'ново' : '×' + h.lift.toFixed(1)) + ' · ' + h.videos + ' видео · +'
          + num(h.perDay) + '/сут</span></div>').join('') + '</div>') : '')
    + (F.channels.length ? box('Кто работает в теме',
        'Отсортировано по суточному приросту всех роликов канала внутри темы, а не по подписчикам. Зелёной чертой отмечены каналы моложе года.',
        '<table><tr><th>Канал</th><th>Роликов в теме</th><th>Свежих за месяц</th><th>Просмотров</th><th>За сутки</th><th>$/мес</th></tr>'
        + F.channels.map(c => '<tr class="' + (c.young ? 'y' : '') + '">'
          + '<td>' + ch(c.id, c.title) + (c.age != null ? '<br><span class="reg">' + c.age + ' дн</span>' : '') + '</td>'
          + '<td class="n">' + c.videos + (c.catalog ? ' из ' + num(c.catalog) : '') + '</td>'
          + '<td class="n">' + c.fresh + '</td>'
          + '<td class="n">' + num(c.views) + '</td>'
          + '<td class="n">' + up(c.perDay) + '</td>'
          + '<td class="n">$' + num(c.usd) + '</td></tr>').join('')
        + '</table>') : '')
    + box('Запросы, по которым собрана тема',
        'Разведка по ним идёт чаще, чем по остальным: фокусной нише отдана доля поисков в каждом прогоне.',
        '<div class="chips">' + F.topics.map(t =>
          '<div><b>' + t.query + '</b>' + (t.ru ? '<span>' + t.ru + '</span>' : '') + '</div>').join('') + '</div>')
    + '</div>';
}

const views = [['verdict', 'Вывод']]
  .concat(P.focus ? [['focus', P.focus.label]] : [])
  .concat([['arch', 'Архетипы каналов'], ['all', 'Все ниши']]);
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
drawFocus();
drawArch();
drawViews();
// --- пороги ---
// Значения берутся из тех же настроек, по которым считается страница:
// переписанные руками они бы разошлись с кодом на первой же правке.
(function limits() {
  const T = P.thresholds ?? {};
  const d = (n) => plural(n, 'день', 'дня', 'дней');
  const groups = [
    ['Канал', [
      [d(T.youngChannelDays), 'Столько канал считается <b>молодым</b>. Возраст берётся от первой загрузки, а не от регистрации: канал могли завести раньше и держать пустым.'],
      ['от $' + num(T.startingUsd) + '/мес', 'Столько канал должен приносить, чтобы считаться <b>поехавшим</b>. Требовать полной цели от двухмесячного канала бессмысленно — важно, что он уже что-то зарабатывает.'],
      ['от $' + num(T.targetMonthlyUsd) + '/мес', 'Полная <b>цель</b>. Канал, дошедший до неё, считается выросшим. При ставке $' + T.rpmUsd + ' за тысячу просмотров это ' + num(T.targetMonthlyUsd / T.rpmUsd * 1000) + ' просмотров в месяц.'],
      ['от ' + num(T.conveyorMinutesPerWeek / 60) + ' ч/нед', 'Столько готового видео в неделю — и канал считается <b>конвейером</b>. Это выше девяностого процентиля по базе: руками столько не сделать. Медиана для сравнения — около полутора часов в неделю.'],
      ['от ' + T.medianMinMatureVideos + ' роликов', 'Меньше — и медиана канала не считается вовсе: по двум-трём видео это не база, а случайность.'],
    ]],
    ['Ролик', [
      ['от ' + Math.round(T.minDurationSec / 60) + ' мин', 'Короче в базу не попадает вообще. Отсекает шортсы и нарезки.'],
      [T.freshMinAgeDays + '–' + T.freshMaxAgeDays + ' дней', 'Возраст <b>свежего ролика</b> — по таким считается главная цифра страницы. Первую неделю ролик ещё разгоняется, поэтому её не берём.'],
      ['старше ' + d(T.shelfAgeDays), 'Ролик считается <b>старым</b>. По ним смотрим, работает ли на канал то, что снято давно.'],
      ['от ' + num(T.workingViews), 'Просмотров — <b>рабочий уровень</b>. Планка, которую свежий ролик должен взять.'],
      ['от ' + num(T.breakoutViews), 'Просмотров — <b>прорыв</b>.'],
      ['старше ' + d(T.medianMinVideoAgeDays), 'Только такие ролики идут в медиану канала: свежие ещё не набрали и занижали бы её.'],
    ]],
    ['Ниша', [
      ['от ' + T.nicheMinChannels + ' каналов', 'Меньше — и ниша не ранжируется, а уходит в «Ещё изучаем». Проценты по трём каналам выглядят убедительно и не значат ничего.'],
      ['от ' + T.nicheMinVideosPerChannel + ' роликов', 'Столько роликов по теме должно быть у канала, чтобы он засчитался этой нише. Один случайный ролик каналом ниши не делает.'],
      ['от 2 новичков', 'Столько молодых каналов с доходом нужно, чтобы ниша попала в «Вывод». Один может быть чьей угодно удачей.'],
    ]],
    ['Сбор', [
      [T.searchesPerRun + ' поисков', 'За прогон. Каждый стоит 100 юнитов из ' + num(T.dailyUnitBudget) + ' дневных.'],
      [d(T.discoveryWindowDays), 'Окно разведки: ищем каналы по роликам не старше этого срока.'],
      ['до ' + T.topicMaxPromotedPerRun + ' тем', 'Столько новых тем автопоиск добавляет за прогон, и то лишь пока очередь непройденных короче ' + T.topicQueueLimit + '.'],
      ['раз в ' + d(T.baselineRefreshDays), 'Обновляется опорный срез по всем видео — по нему считается живой прирост.'],
    ]],
  ];
  const el = document.getElementById('limtables');
  if (!el) return;
  el.innerHTML = groups.map(([name, rows]) =>
    '<div class="limgroup"><h4>' + name + '</h4><table>'
    + rows.map(([v, t]) => '<tr><td>' + v + '</td><td>' + t + '</td></tr>').join('')
    + '</table></div>').join('');
})();

// Копирование запроса для другого чата. С планшета набирать длинную ссылку
// руками — гарантированная опечатка, поэтому кнопка, а не текст.
(function () {
  const url = 'https://raw.githubusercontent.com/ekaterynanesterova/youtube-niche-finder/main/docs/brief.md';
  const prompt = 'Прочитай целиком ' + url + ' — это свежий срез статистики по нишам YouTube, '
    + 'который я собираю автоматически. Дальше обсуждаем контент-план, опираясь на эти цифры '
    + 'и на перечисленные там ограничения.';
  const said = document.getElementById('copied');
  const put = (text, label) => {
    const done = () => { if (said) { said.textContent = label + ' скопирован'; setTimeout(() => (said.textContent = ''), 2500); } };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => {});
    else done();
  };
  const a = document.getElementById('copyprompt');
  const b = document.getElementById('copyurl');
  if (a) a.onclick = () => put(prompt, 'Запрос');
  if (b) b.onclick = () => put(url, 'Адрес');
})();

draw();
</script>
</body>
</html>
`;
}
