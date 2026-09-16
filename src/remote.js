// Хранение базы вне GitHub — в Supabase Storage.
//
// Зачем. 15 сентября 2026 аккаунт заблокировали за то, что база жила в
// репозитории: каждый ночной прогон дописывал в историю около ста мегабайт.
// Это починено, но база до сих пор ночует рядом с GitHub — в кэше Actions и
// в артефактах. Пока она там, претензия «репозиторий в роли базы данных»
// формально остаётся живой.
//
// Supabase Storage её снимает целиком: в GitHub не остаётся ни байта
// собранных данных, только исходный код и готовая страница. Бесплатного
// гигабайта хватает нашим двадцати шести мегабайтам с запасом в тридцать
// восемь раз.
//
// Устройство намеренно тупое. Файлы остаются файлами, store.js остаётся
// синхронным и ничего не знает про сеть. В начале прогона база скачивается
// в data/, в конце — заливается обратно. Всё различие между «локально» и
// «в облаке» умещается в две функции здесь.
//
// Без переменных окружения ничего не происходит: прогон работает на
// локальных файлах ровно как раньше. Так же он ведёт себя и в самопроверке.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DATA } from './store.js';

const URL_ = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const KEY = process.env.SUPABASE_KEY;
const BUCKET = process.env.SUPABASE_BUCKET || 'niche-db';

export const remoteConfigured = () => !!(URL_ && KEY);

const endpoint = (name) => `${URL_}/storage/v1/object/${BUCKET}/${name}`;
const auth = { Authorization: `Bearer ${KEY}`, apikey: KEY };

// Файлы базы. Список явный, а не «всё, что лежит в data/»: случайный мусор,
// оставшийся в каталоге, не должен уезжать в хранилище и возвращаться оттуда.
const FILES = ['videos.json.gz', 'channels.json.gz', 'current.json.gz',
               'series.json.gz', 'bases.json.gz', 'state.json.gz',
               'translations.json.gz'];

async function tryFetch(url, init, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, init);
      // 404 — это ответ, а не сбой: файла ещё нет, и повторять незачем.
      if (res.ok || res.status === 404) return res;
      last = new Error(`${res.status} ${res.statusText}`);
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
  }
  throw last;
}

// Скачать базу в data/ перед прогоном.
export async function pullData() {
  if (!remoteConfigured()) return { skipped: true };
  mkdirSync(DATA, { recursive: true });
  const got = [], missing = [];
  let bytes = 0;
  for (const name of FILES) {
    const res = await tryFetch(endpoint(name), { headers: auth });
    if (res.status === 404) { missing.push(name); continue; }
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(join(DATA, name), buf);
    bytes += buf.length;
    got.push(name);
  }
  return { got, missing, bytes };
}

// Залить обратно то, что изменилось.
//
// Сравниваем по размеру и содержимому: заливать целиком всё каждый раз —
// это лишние двадцать шесть мегабайт исходящего трафика в сутки, а его на
// бесплатном тарифе пять гигабайт в месяц. Файлы, которые прогон не трогал
// (translations, bases в обычный день), так и остаются лежать.
export async function pushData(before = new Map()) {
  if (!remoteConfigured()) return { skipped: true };
  const sent = [], same = [];
  let bytes = 0;
  for (const name of FILES) {
    const path = join(DATA, name);
    if (!existsSync(path)) continue;
    const buf = readFileSync(path);
    if (before.get(name) === hash(buf)) { same.push(name); continue; }
    const res = await tryFetch(endpoint(name), {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/gzip', 'x-upsert': 'true' },
      body: buf,
    });
    if (!res.ok) throw new Error(`Не удалось залить ${name}: ${res.status}`);
    sent.push(name);
    bytes += buf.length;
  }
  return { sent, same, bytes };
}

// Отпечаток того, что лежало на диске до прогона, — чтобы потом залить
// только изменившееся. Длина плюс дешёвая сумма: криптостойкость тут не
// нужна, нужно отличить «файл тот же» от «файл другой».
export function snapshotLocal() {
  const out = new Map();
  if (!existsSync(DATA)) return out;
  for (const name of readdirSync(DATA)) {
    const path = join(DATA, name);
    if (!statSync(path).isFile()) continue;
    out.set(name, hash(readFileSync(path)));
  }
  return out;
}

function hash(buf) {
  let h = 5381;
  for (let i = 0; i < buf.length; i++) h = ((h * 33) ^ buf[i]) >>> 0;
  return buf.length + ':' + h.toString(36);
}
