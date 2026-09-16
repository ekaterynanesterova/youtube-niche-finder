// Хранилище. Формы данных в памяти те же, что были всегда; на диске они
// лежат плотно и сжато.
//
// Почему это переписано. Раньше videos.json весил 82,5 МБ на 279 тысяч
// роликов — 310 байт на ролик, при том что полезного в ролике байт сорок.
// Разбор по полям показал, куда уходило остальное:
//
//   отступы и переносы       ~13 МБ   файл был на 2,5 миллиона строк
//   firstSeen                10,4 МБ  поле не читается НИГДЕ, только пишется
//   channelId у каждого      10,4 МБ  4,5 тысячи каналов, строка по 24 символа
//                                     лежала в среднем по 60 раз
//   publishedAt строкой       9,8 МБ  «2026-08-18T12:00:25Z» вместо числа
//   id вторым экземпляром     5,1 МБ  он же и так ключ записи
//   сжатия не было вовсе              текст жмётся вчетверо даром
//
// Отсюда все решения ниже: колонки вместо объектов, справочники вместо
// повторов, числа вместо дат, gzip поверх всего. Данные при этом не теряются —
// кроме firstSeen, которого не читал никто.
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = join(ROOT, 'data');
export const SNAPSHOTS = join(DATA, 'snapshots');
export const REPORTS = join(ROOT, 'reports');

// Ролики по возрасту НЕ обрезаем, и это решение стоит объяснить, потому что
// напрашивается обратное.
//
// Обрезка на двух годах выбрасывала 42 тысячи роликов из 279 и экономила
// 1,6 МБ из 11,4. Проверка на настоящих данных показала, что цена другая:
// канал попадает в нишу, только если у него хотя бы три ролика по теме, и
// у части каналов третий ролик оказался как раз старым. Они выпали из ниш
// целиком — вместе со своими свежими роликами. У «james webb telescope»
// из семи зарабатывающих каналов осталось три, лучший свежий ролик темы
// упал с 342 до 199 тысяч просмотров. Двадцать два канала исчезли из базы.
//
// Полтора мегабайта того не стоят. Старые ролики никуда не растут — их
// число фиксировано, а база пухнет от новых. Экономия должна идти от
// формата, а не от выбрасывания данных.
export const KEEP_VIDEO_DAYS = Infinity;

// --- чтение и запись, с gzip ---

export function readJson(path, fallback) {
  const gz = path.endsWith('.gz') ? path : path + '.gz';
  if (existsSync(gz)) {
    try { return JSON.parse(gunzipSync(readFileSync(gz)).toString('utf8')); }
    catch (e) { throw new Error(`Битый архив в ${gz}: ${e.message}`); }
  }
  // Несжатый файл читается тоже: так старая база переезжает на новый формат
  // сама, без отдельного шага миграции.
  const plain = path.endsWith('.gz') ? path.slice(0, -3) : path;
  if (!existsSync(plain)) return fallback;
  try { return JSON.parse(readFileSync(plain, 'utf8')); }
  catch (e) { throw new Error(`Битый JSON в ${plain}: ${e.message}`); }
}

export function writeJson(path, value) {
  const gz = path.endsWith('.gz') ? path : path + '.gz';
  mkdirSync(dirname(gz), { recursive: true });
  writeFileSync(gz, gzipSync(Buffer.from(JSON.stringify(value)), { level: 9 }));
  // Несжатого двойника после переезда быть не должно: иначе он останется
  // лежать со старым содержимым и однажды будет прочитан.
  const plain = gz.slice(0, -3);
  if (existsSync(plain)) rmSync(plain);
}

// Конфиги и всё, что правит человек, остаются обычным JSON с отступами:
// их читают и правят глазами, а весят они килобайты.
export function writePlainJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

export function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export const paths = {
  channels: join(DATA, 'channels.json.gz'),
  videos: join(DATA, 'videos.json.gz'),
  current: join(DATA, 'current.json.gz'),
  baseline: join(DATA, 'baseline.json.gz'),
  translations: join(DATA, 'translations.json.gz'),
  state: join(DATA, 'state.json.gz'),
  series: join(DATA, 'series.json.gz'),
  bases: join(DATA, 'bases.json.gz'),
  report: (name) => join(REPORTS, name),
};

// --- ролики: колонки вместо объектов ---
//
// Строка ролика: [id, номер канала, заголовок, секунды с 2000 года,
// длительность, номер языка]. Канал и язык вынесены в справочники: каналов
// четыре с половиной тысячи на 279 тысяч роликов, язык — десяток значений.
//
// Секунды, а не минуты, хотя минуты короче. С округлением до минуты сверка
// старой и новой базы дала одно расхождение из 8022 значений: ролик, вышедший
// на границе шестидесятидневного окна, от сдвига на полминуты попадал в
// выборку или выпадал из неё. Лишние два знака на строку весят после сжатия
// меньше ста килобайт, а цифры становятся воспроизводимыми ровно.
const EPOCH = Date.parse('2000-01-01T00:00:00Z');
const toStamp = (iso) => Math.round((Date.parse(iso) - EPOCH) / 1000);
const fromStamp = (t) => new Date(EPOCH + t * 1000).toISOString().replace(/\.000Z$/, 'Z');

export function packVideos(videos, now = Date.now()) {
  const chans = [], ci = new Map();
  const langs = [], li = new Map();
  const idx = (list, map, key) => {
    if (!map.has(key)) { map.set(key, list.length); list.push(key); }
    return map.get(key);
  };
  const rows = [];
  for (const v of Object.values(videos)) {
    const published = Date.parse(v.publishedAt);
    if (!Number.isFinite(published)) continue;
    if ((now - published) / 86400000 > KEEP_VIDEO_DAYS) continue;
    rows.push([v.id, idx(chans, ci, v.channelId ?? ''), v.title ?? '',
               toStamp(v.publishedAt), v.durationSec ?? 0, idx(langs, li, v.lang ?? '')]);
  }
  return { v: 1, chans, langs, rows };
}

export function unpackVideos(packed) {
  if (!packed) return {};
  // Старый формат — обычный объект, ключ к ключу. Читаем как есть.
  if (!packed.rows) return packed;
  const out = {};
  for (const [id, ch, title, stamp, dur, lang] of packed.rows) {
    out[id] = { id, channelId: packed.chans[ch] ?? null, title,
                publishedAt: fromStamp(stamp), durationSec: dur,
                lang: packed.langs[lang] || null };
  }
  return out;
}

// --- каналы: выбрасываем то, чего никто не читает ---
//
// Аудит показал в записи канала четыре поля, которые только пишутся:
//
//   id                 141 КБ  он же и так ключ записи
//   uploadsPlaylistId  202 КБ  всегда «UU» + id без «UC» — проверено на всех
//                              4396 каналах, ни одного исключения. Хранить
//                              нечего, кроме самого факта «плейлиста нет»:
//                              им collect.js помечает каналы, у которых архив
//                              недоступен, и это единственное, что несёт
//                              информацию.
//   firstSeen          172 КБ  когда мы впервые увидели канал. Не читается
//                              ни метриками, ни сбором, ни отчётом
//   country             65 КБ  страна канала. Записана, не прочитана ни разу
//   viaTrending          5 КБ  пришёл ли канал из Trending. То же самое
//
// Это не про мегабайты — после сжатия тут экономятся сотни килобайт. Это про
// то, что поле, которое никто не читает, со временем начинает выглядеть как
// данные, и однажды кто-нибудь построит на нём вывод.
const DEAD_CHANNEL_FIELDS = ['id', 'uploadsPlaylistId', 'firstSeen', 'country', 'viaTrending'];

export function packChannels(channels) {
  const out = {};
  for (const [id, c] of Object.entries(channels)) {
    const row = {};
    for (const [k, v] of Object.entries(c)) {
      if (DEAD_CHANNEL_FIELDS.includes(k)) continue;
      row[k] = v;
    }
    // Плейлист выводится из id, но «плейлиста нет» вывести неоткуда.
    if (!c.uploadsPlaylistId) row.noUploads = 1;
    out[id] = row;
  }
  return { v: 1, channels: out };
}

export function unpackChannels(packed) {
  if (!packed) return {};
  const src = packed.channels ?? packed;
  const out = {};
  for (const [id, c] of Object.entries(src)) {
    const { noUploads, ...rest } = c;
    out[id] = { ...rest, id,
                uploadsPlaylistId: noUploads ? null : 'UU' + id.slice(2) };
  }
  return out;
}

// --- ряд наблюдений: один файл вместо файла в день ---
//
// Раньше каждый день клался отдельным файлом, и в каждом лежал полный
// одиннадцатисимвольный идентификатор ролика — плюс лайки и комментарии,
// которые из срезов не читает никто (проверено: из ряда берутся только
// просмотры). Теперь идентификаторы лежат один раз, а дни — строками матрицы,
// где null значит «в этот день ролика в срезе не было». Пустоты сжимаются
// почти в ничто: 58,6 МБ превращаются в 6,2.

export function packSeries(snapshots) {
  const ids = [], ii = new Map();
  for (const s of snapshots) {
    for (const id of Object.keys(s.videos ?? {})) {
      if (!ii.has(id)) { ii.set(id, ids.length); ids.push(id); }
    }
  }
  const views = snapshots.map((s) => {
    const row = new Array(ids.length).fill(null);
    for (const [id, vals] of Object.entries(s.videos ?? {})) {
      const n = Array.isArray(vals) ? vals[0] : vals;
      if (Number.isFinite(n)) row[ii.get(id)] = n;
    }
    return row;
  });
  return { v: 1, ids, dates: snapshots.map((s) => s.date), views };
}

export function unpackSeries(packed) {
  if (!packed?.ids) return [];
  return packed.dates.map((date, d) => {
    const videos = {};
    const row = packed.views[d] ?? [];
    for (let i = 0; i < packed.ids.length; i++) {
      if (row[i] != null) videos[packed.ids[i]] = [row[i]];
    }
    return { date, videos };
  });
}

export function loadSeries() {
  const packed = readJson(paths.series, null);
  if (packed?.ids) return unpackSeries(packed);
  // Первый запуск после переезда: подбираем старые посуточные файлы.
  if (!existsSync(SNAPSHOTS)) return [];
  return readdirSync(SNAPSHOTS).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(readFileSync(join(SNAPSHOTS, f), 'utf8')));
}

// Ряд перезаписывается целиком — он и так лежит одним файлом, а хранится вне
// git, где переписать шесть мегабайт ничего не стоит.
export function saveSeries(snapshots, keepDays = 90) {
  const kept = snapshots.slice(-keepDays);
  writeJson(paths.series, packSeries(kept));
  return kept;
}

// --- опорные срезы: не один, а все ---
//
// Опорный срез — это просмотры ВСЕХ роликов, включая старые; дневные срезы
// ради места держат только молодые. Раньше файл был один и раз в неделю
// перезаписывался новым, то есть каждый предыдущий терялся.
//
// Потерялись не пустяки. В истории репозитория нашлись три перезаписанных
// опорных — за 20 и 27 августа и 3 сентября, — и каждый покрывает около ста
// тысяч роликов, которых в дневных срезах нет вовсе. Вместе с текущим это
// трёхнедельное окно по 69 245 роликам у 706 каналов: ровно то, чего не
// хватало, чтобы считать доход СТАРЫХ каналов, а не только молодых.
//
// Хранить их все стоит 0,86 МБ сверх одного. Формат тот же, что у дневного
// ряда: идентификаторы один раз, даты строками матрицы.
export function loadBases() {
  const packed = readJson(paths.bases, null);
  if (packed?.ids) return unpackSeries(packed);
  // Переезд со старого одиночного файла: он становится первым и единственным срезом.
  const one = readJson(paths.baseline, null);
  if (!one?.views) return [];
  return [{ date: one.date, videos: Object.fromEntries(
    Object.entries(one.views).map(([id, v]) => [id, [v]])) }];
}

// Двенадцати недель хватает: дальше в прошлое ни одна метрика не заглядывает,
// а каждый срез весит почти мегабайт.
export function saveBases(bases, keepWeeks = 12) {
  const kept = bases.slice(-keepWeeks);
  writeJson(paths.bases, packSeries(kept));
  return kept;
}

// Самый свежий опорный в том виде, в каком его ждут метрики.
export function latestBase(bases) {
  const last = bases[bases.length - 1];
  if (!last) return null;
  return { date: last.date, views: Object.fromEntries(
    Object.entries(last.videos).map(([id, v]) => [id, v[0]])) };
}

// --- база целиком ---

export function loadDb() {
  return {
    channels: unpackChannels(readJson(paths.channels, null)),
    videos: unpackVideos(readJson(paths.videos, null)),
    current: readJson(paths.current, {}),
    state: readJson(paths.state, { seedCursor: 0, runs: [] }),
  };
}

export function saveDb(db, now = Date.now()) {
  const packed = packVideos(db.videos, now);
  // Счётчики без ролика — мусор: current копил бы записи о том, чего в базе
  // уже нет. Сейчас таких почти не бывает (обрезки нет), но проверка стоит
  // копейки и держит два файла согласованными.
  const live = new Set(packed.rows.map((r) => r[0]));
  for (const id of Object.keys(db.current)) if (!live.has(id)) delete db.current[id];

  writeJson(paths.channels, packChannels(db.channels));
  writeJson(paths.videos, packed);
  writeJson(paths.current, db.current);
  writeJson(paths.state, db.state);
}

export const today = () => new Date().toISOString().slice(0, 10);
export const daysBetween = (a, b) => (new Date(b) - new Date(a)) / 86400000;
