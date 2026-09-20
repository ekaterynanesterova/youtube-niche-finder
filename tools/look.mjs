// Разбор конкретных роликов: что это, чей канал, как зашло.
//
// Нужен для разговора «вот такой контент, как тебе?». Ролик по ссылке
// сам по себе ничего не говорит: два миллиона просмотров у канала с
// пятью миллионами подписчиков и два миллиона у канала с тысячей — это
// разные новости. Здесь всё сводится вместе: ролик, канал, его норма,
// и во сколько раз этот ролик её обошёл.
//
// Запуск: LOOK_VIDEOS=id1,id2 node tools/look.mjs
import { YouTubeApi, parseDuration } from '../src/api.js';
import { Quota } from '../src/quota.js';
import { readJson, paths, unpackVideos, unpackChannels } from '../src/store.js';
import { conveyorProfile } from '../src/metrics.js';

const KEY = process.env.YOUTUBE_API_KEY;
if (!KEY) { console.error('Нет YOUTUBE_API_KEY'); process.exit(1); }

const ids = (process.env.LOOK_VIDEOS ?? '').split(/[,\s]+/).filter(Boolean);
if (!ids.length) { console.error('Пусто в LOOK_VIDEOS'); process.exit(1); }

const quota = new Quota(Number(process.env.UNIT_BUDGET ?? 200));
const api = new YouTubeApi(KEY, quota);
const db = { videos: unpackVideos(readJson(paths.videos, null)),
             channels: unpackChannels(readJson(paths.channels, null)) };

const nn = (x) => x == null ? '—' : Math.round(x).toLocaleString('ru-RU');
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };

const vids = (await api.videos(ids)).items ?? [];
const chanIds = [...new Set(vids.map((v) => v.snippet?.channelId).filter(Boolean))];
const chans = {};
for (const c of (await api.channels(chanIds)).items ?? []) chans[c.id] = c;

// Каталог канала: нужен, чтобы знать его норму и понять, выброс перед нами
// или обычный для него результат.
const catalog = {};
for (const cid of chanIds) {
  const pl = chans[cid]?.contentDetails?.relatedPlaylists?.uploads;
  if (!pl) continue;
  try {
    const page = await api.playlistItems(pl);
    const vidIds = (page.items ?? []).map((i) => i.contentDetails?.videoId).filter(Boolean);
    if (!vidIds.length) continue;
    const det = (await api.videos(vidIds.slice(0, 50))).items ?? [];
    catalog[cid] = det.map((v) => ({
      title: v.snippet?.title ?? '',
      publishedAt: v.snippet?.publishedAt,
      durationSec: parseDuration(v.contentDetails?.duration ?? ''),
      views: Number(v.statistics?.viewCount ?? 0),
    }));
  } catch (e) { console.log(`  каталог ${cid}: ${e.message}`); }
}

for (const v of vids) {
  const cid = v.snippet?.channelId;
  const ch = chans[cid] ?? {};
  const subs = Number(ch.statistics?.subscriberCount ?? 0);
  const views = Number(v.statistics?.viewCount ?? 0);
  const sec = parseDuration(v.contentDetails?.duration ?? '');
  const age = (Date.now() - Date.parse(v.snippet?.publishedAt)) / 86400000;
  const cat = catalog[cid] ?? [];
  const mature = cat.filter((x) => (Date.now() - Date.parse(x.publishedAt)) / 86400000 > 30);
  const norm = med(mature.map((x) => x.views));
  const conv = conveyorProfile(cat, { templateMinVideos: 8, templateScoreFlag: 4 });

  console.log('='.repeat(72));
  console.log(v.snippet?.title);
  console.log(`https://youtu.be/${v.id}`);
  console.log('');
  console.log(`  канал        ${ch.snippet?.title ?? '—'}`);
  console.log(`  подписчиков  ${nn(subs)}`);
  console.log(`  роликов      ${nn(Number(ch.statistics?.videoCount ?? 0))}`);
  console.log(`  канал с      ${(ch.snippet?.publishedAt ?? '').slice(0, 10)}`);
  console.log('');
  console.log(`  просмотров   ${nn(views)}`);
  console.log(`  вышел        ${(v.snippet?.publishedAt ?? '').slice(0, 10)} (${Math.round(age)} дн назад)`);
  console.log(`  длина        ${Math.round(sec / 60)} мин`);
  console.log(`  лайков       ${nn(Number(v.statistics?.likeCount ?? 0))}`
    + (views ? ` (${(Number(v.statistics?.likeCount ?? 0) / views * 100).toFixed(1)}% от просмотров)` : ''));
  console.log(`  комментариев ${nn(Number(v.statistics?.commentCount ?? 0))}`);
  console.log('');
  console.log(`  норма канала ${nn(norm)} по ${mature.length} роликам старше месяца`);
  console.log(`  этот ролик   ${norm ? '×' + (views / norm).toFixed(1) + ' к норме' : '—'}`);
  console.log(`  к подписчикам ${subs ? (views / subs).toFixed(2) : '—'}`);
  console.log('');
  if (conv.templateScore != null) {
    console.log(`  станок       ${conv.templateScore} из 10`
      + (conv.templated ? '  ← ПОМЕЧЕН КАК ШАБЛОННЫЙ' : ''));
    console.log(`    рамка заголовка ${(conv.templateFrame * 100).toFixed(0)}%`
      + `, один хронометраж ${((conv.durationUniform ?? 0) * 100).toFixed(0)}%`
      + `, с номерами ${(conv.serialShare * 100).toFixed(0)}%`
      + `, ${(conv.uploadsPerWeekAll ?? 0).toFixed(1)} роликов в неделю`);
  }
  console.log('');
  console.log('  последние ролики канала:');
  for (const x of cat.slice(0, 8)) {
    console.log(`    ${String(Math.round(x.durationSec / 60)).padStart(4)} мин  ${nn(x.views).padStart(12)}  ${x.title.slice(0, 64)}`);
  }
  console.log('');
}
console.log(`Потрачено юнитов: ${quota.spent}`);
