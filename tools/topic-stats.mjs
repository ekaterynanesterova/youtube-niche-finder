// Сколько реально набирают ролики по теме — распределение, а не рекорд.
//
// Рекорд темы ничего не обещает: один ролик на 872 тысячи может стоять рядом
// с тридцатью по двести просмотров. Вопрос «можно ли там собрать просмотры»
// отвечается долей роликов, взявших планку, у каналов нашего размера.
//
// Запуск: TOPICS="Пояс Койпера=kuiper|arrokoth;Титан=\btitan\b" node tools/topic-stats.mjs
import { readJson, paths, unpackVideos, unpackChannels, loadSeries } from '../src/store.js';

const spec = (process.env.TOPICS ?? '').split(';').map((s) => s.trim()).filter(Boolean)
  .map((s) => { const i = s.indexOf('='); return { name: s.slice(0, i), re: new RegExp(s.slice(i + 1), 'i') }; });
if (!spec.length) { console.error('Пусто в TOPICS'); process.exit(1); }

const V = unpackVideos(readJson(paths.videos, null));
const C = unpackChannels(readJson(paths.channels, null));
const CUR = readJson(paths.current, {});
const series = loadSeries();
const now = Date.now();

const nn = (x) => x == null ? '—' : Math.round(x).toLocaleString('ru-RU');
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) * p)] : null; };
const pct = (a, b) => b ? Math.round(100 * a / b) + '%' : '—';

// Просмотры на седьмой день — из дневных срезов.
function day7(v) {
  const p = Date.parse(v.publishedAt);
  let best = null, gap = Infinity;
  for (const s of series) {
    const g = Math.abs((Date.parse(s.date) - p) / 86400000 - 7);
    if (g < gap && s.videos[v.id]) { gap = g; best = s.videos[v.id][0]; }
  }
  return gap <= 1.5 ? best : null;
}

for (const t of spec) {
  const all = [];
  for (const v of Object.values(V)) {
    if (!t.re.test(v.title ?? '')) continue;
    if ((v.durationSec ?? 0) < 480) continue;
    const views = CUR[v.id]?.[0];
    if (!Number.isFinite(views)) continue;
    const ch = C[v.channelId] ?? {};
    all.push({ ...v, views, subs: ch.subscribers ?? null, ch: ch.title ?? '',
               age: (now - Date.parse(v.publishedAt)) / 86400000, d7: day7(v) });
  }
  // Ролику нужно время: свежий ролик ещё не набрал своё, и его «мало» — не приговор.
  const settled = all.filter((v) => v.age >= 30);
  const small = settled.filter((v) => v.subs != null && v.subs < 10000);
  const mid = settled.filter((v) => v.subs != null && v.subs >= 10000 && v.subs < 100000);
  const big = settled.filter((v) => v.subs != null && v.subs >= 100000);

  console.log('='.repeat(70));
  console.log(`${t.name}   (роликов длиннее 8 минут: ${all.length}, из них старше месяца: ${settled.length})`);
  console.log('');
  console.log('  размер канала      роликов  медиана   верх. четверть  верх. 10%   ≥10к   ≥100к');
  for (const [label, g] of [['до 10 тыс', small], ['10–100 тыс', mid], ['больше 100 тыс', big], ['все', settled]]) {
    const vs = g.map((v) => v.views);
    console.log(`  ${label.padEnd(18)} ${String(g.length).padStart(6)}  ${nn(q(vs, 0.5)).padStart(8)}  ${nn(q(vs, 0.75)).padStart(14)}  ${nn(q(vs, 0.9)).padStart(10)}`
      + `  ${pct(g.filter((v) => v.views >= 10000).length, g.length).padStart(5)}  ${pct(g.filter((v) => v.views >= 100000).length, g.length).padStart(6)}`);
  }
  const d7 = all.map((v) => v.d7).filter((x) => x != null);
  console.log('');
  console.log(`  на седьмой день: замеров ${d7.length}` + (d7.length ? `, медиана ${nn(q(d7, 0.5))}, верх. четверть ${nn(q(d7, 0.75))}` : ''));
  const recent = all.filter((v) => v.age <= 60);
  console.log(`  вышло за 60 дней: ${recent.length}` + (recent.length ? `, медиана сейчас ${nn(q(recent.map((v) => v.views), 0.5))}` : ''));
  console.log('');
  console.log('  ролики каналов меньше 100 тыс подписчиков, по просмотрам:');
  for (const v of [...small, ...mid].sort((a, b) => b.views - a.views).slice(0, 12)) {
    console.log(`    ${nn(v.views).padStart(10)}  ${nn(v.subs).padStart(8)} подп  ${String(Math.round(v.age)).padStart(4)} дн  ${Math.round(v.durationSec / 60)} мин  ${v.title.slice(0, 60)}`);
  }
  console.log('');
}
