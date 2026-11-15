// Разбор канала целиком: кто это, как часто выходит, что заходит.
//
// Нужен для разговора «смотри, какой интересный канал». Один ролик по ссылке
// говорит мало; канал говорит, повторяется ли успех, или это один выстрел
// на фоне тишины. Плюс то, ради чего канал вообще стоит смотреть: сколько
// ему лет, сколько роликов до первого выстрела и какой длины ролики заходят.
//
// Запуск: LOOK_VIDEOS=@handle node tools/look.mjs (look.mjs передаёт сюда)
//      или LOOK_CHANNEL=@handle node tools/channel.mjs
import { YouTubeApi, parseDuration } from '../src/api.js';
import { Quota } from '../src/quota.js';
import { conveyorProfile } from '../src/metrics.js';

const nn = (x) => x == null ? '—' : Math.round(x).toLocaleString('ru-RU');
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) * p)] : null; };
const days = (iso) => (Date.now() - Date.parse(iso)) / 86400000;

export async function lookChannel(ref, { key = process.env.YOUTUBE_API_KEY, maxPages = 6 } = {}) {
  const quota = new Quota(Number(process.env.UNIT_BUDGET ?? 300));
  const api = new YouTubeApi(key, quota);
  const handle = ref.trim().replace(/^https?:\/\/(www\.)?youtube\.com\//, '').replace(/\/.*$/, '');
  const params = { part: 'snippet,statistics,contentDetails' };
  if (/^UC[\w-]{20,}$/.test(handle)) params.id = handle;
  else params.forHandle = handle.startsWith('@') ? handle : '@' + handle;
  const ch = (await api.call('channels', params)).items?.[0];
  if (!ch) { console.log(`Канал ${handle} не найден`); return; }

  // Весь каталог, до трёхсот роликов: этого хватает, чтобы увидеть путь
  // канала от первого ролика, и стоит единицы юнитов.
  const ids = [];
  let token;
  for (let p = 0; p < maxPages; p++) {
    const page = await api.playlistItems(ch.contentDetails.relatedPlaylists.uploads, token);
    ids.push(...(page.items ?? []).map((i) => i.contentDetails?.videoId).filter(Boolean));
    token = page.nextPageToken;
    if (!token) break;
  }
  const vids = [];
  for (let i = 0; i < ids.length; i += 50) {
    for (const v of (await api.videos(ids.slice(i, i + 50))).items ?? []) {
      vids.push({
        id: v.id, title: v.snippet?.title ?? '', publishedAt: v.snippet?.publishedAt,
        sec: parseDuration(v.contentDetails?.duration ?? ''),
        views: Number(v.statistics?.viewCount ?? 0),
        likes: Number(v.statistics?.likeCount ?? 0),
        comments: Number(v.statistics?.commentCount ?? 0),
      });
    }
  }
  vids.sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt));
  const long = vids.filter((v) => v.sec > 180);
  const shorts = vids.filter((v) => v.sec <= 180);
  const mature = long.filter((v) => days(v.publishedAt) > 30);
  const first = vids[0];

  console.log('='.repeat(72));
  console.log(`${ch.snippet?.title}   https://youtube.com/${handle.startsWith('UC') ? 'channel/' + handle : handle}`);
  console.log(`  подписчиков   ${nn(Number(ch.statistics?.subscriberCount))}`);
  console.log(`  просмотров    ${nn(Number(ch.statistics?.viewCount))}`);
  console.log(`  роликов       ${nn(Number(ch.statistics?.videoCount))} (в разборе ${vids.length}: длинных ${long.length}, коротких ${shorts.length})`);
  console.log(`  канал создан  ${(ch.snippet?.publishedAt ?? '').slice(0, 10)}`);
  console.log(`  первый ролик  ${first ? first.publishedAt.slice(0, 10) + ` (${Math.round(days(first.publishedAt))} дн назад)` : '—'}`);
  console.log(`  страна        ${ch.snippet?.country ?? '—'}   язык ${ch.snippet?.defaultLanguage ?? '—'}`);
  console.log(`  описание      ${(ch.snippet?.description ?? '').replace(/\s+/g, ' ').slice(0, 300)}`);
  console.log('');

  if (long.length) {
    const vs = mature.map((v) => v.views);
    const mins = long.map((v) => v.sec / 60);
    const span = days(long[0].publishedAt) - days(long[long.length - 1].publishedAt);
    console.log('  длинные ролики (старше месяца для просмотров):');
    console.log(`    обычный ${nn(q(vs, 0.5))}   верх. четверть ${nn(q(vs, 0.75))}   лучший ${nn(Math.max(0, ...vs))}`);
    console.log(`    взяли 10 тыс ${vs.filter((x) => x >= 10000).length} из ${vs.length},  100 тыс ${vs.filter((x) => x >= 100000).length}`);
    console.log(`    длина: обычная ${Math.round(q(mins, 0.5))} мин, от ${Math.round(Math.min(...mins))} до ${Math.round(Math.max(...mins))}`);
    console.log(`    темп: ${(long.length / Math.max(span / 7, 1)).toFixed(1)} роликов в неделю`);
    const sum = long.reduce((s, v) => s + v.views, 0);
    const top3 = [...long].sort((a, b) => b.views - a.views).slice(0, 3).reduce((s, v) => s + v.views, 0);
    console.log(`    три лучших ролика дают ${sum ? Math.round(100 * top3 / sum) : 0}% всех просмотров длинных`);
    const firstHit = long.findIndex((v) => v.views >= 10000);
    console.log(`    первый ролик на 10 тыс: ${firstHit < 0 ? 'нет' : `№${firstHit + 1}, через ${Math.round(days(long[0].publishedAt) - days(long[firstHit].publishedAt))} дн после старта`}`);
    const conv = conveyorProfile(long.map((v) => ({ title: v.title, publishedAt: v.publishedAt, durationSec: v.sec, views: v.views })),
                                 { templateMinVideos: 8, templateScoreFlag: 4 });
    if (conv.templateScore != null) {
      console.log(`    станок ${conv.templateScore} из 10${conv.templated ? '  ← ШАБЛОННЫЙ' : ''}`
        + ` (рамка заголовка ${Math.round(conv.templateFrame * 100)}%, один хронометраж ${Math.round((conv.durationUniform ?? 0) * 100)}%)`);
    }
    console.log('');
  }

  // Каждый ролик по порядку выхода: так виден путь канала, а не только итог.
  console.log('  все ролики по порядку выхода:');
  console.log('      №   вышел       дн   мин   просмотров  в день   лайк%  название');
  vids.forEach((v, i) => {
    const d = Math.max(days(v.publishedAt), 1);
    console.log(`    ${String(i + 1).padStart(3)}  ${v.publishedAt.slice(0, 10)}  ${String(Math.round(d)).padStart(4)}  ${String(Math.round(v.sec / 60)).padStart(4)}  `
      + `${nn(v.views).padStart(11)}  ${nn(v.views / d).padStart(6)}  ${(v.views ? 100 * v.likes / v.views : 0).toFixed(1).padStart(5)}  `
      + `${v.title.slice(0, 80)}  https://youtu.be/${v.id}`);
  });
  console.log('');
  console.log(`Потрачено юнитов: ${quota.spent}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ref = process.env.LOOK_CHANNEL;
  if (!ref) { console.error('Пусто в LOOK_CHANNEL'); process.exit(1); }
  if (!process.env.YOUTUBE_API_KEY) { console.error('Нет YOUTUBE_API_KEY'); process.exit(1); }
  await lookChannel(ref);
}
