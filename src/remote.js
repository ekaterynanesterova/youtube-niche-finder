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

// Адрес проекта, а не адрес Data API.
//
// В панели Supabase на видном месте лежит ссылка вида
// https://xxx.supabase.co/rest/v1/ — это REST-эндпоинт базы, и скопировать
// хочется именно его. Нам же нужен корень: /storage/v1/... пристраивается
// к нему сам. Отрезаем хвост молча, чтобы человек не выяснял это по
// невнятной ошибке.
const URL_ = process.env.SUPABASE_URL
  ?.trim()
  .replace(/\/+$/, '')
  .replace(/\/rest\/v1$/, '')
  .replace(/\/storage\/v1$/, '');
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

// «Файла нет» — это ответ, а не сбой, и повторять запрос незачем.
//
// Тонкость, на которой прогон и упал: Supabase на отсутствующий объект
// отвечает не 404, а 400 с пояснением в теле. Прежний код считал ответом
// только 404, поэтому пустое хранилище выглядело как поломка сервиса —
// три попытки, четырнадцать секунд и падение всего прогона.
//
// Разбирать тело приходится потому, что 400 у Supabase значит и «нет
// объекта», и «запрос кривой». Путать их нельзя в обе стороны: принять
// поломку за пустоту значит начать сбор с пустой базой и затереть ею
// хорошую, а принять пустоту за поломку значит никогда не стартовать.
export function looksMissing(status, body = '') {
  if (status === 404) return true;
  if (status !== 400) return false;
  return /not\s*found|nosuchkey|does not exist/i.test(body);
}

async function tryFetch(url, init, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      // Тело читаем только у неуспешных ответов: у успешных оно нужно целиком
      // и вторым чтением его уже не получить.
      const body = res.status === 400 ? await res.clone().text().catch(() => '') : '';
      // Плоский объект, а не Response: у Response свойства лежат в прототипе
      // и через расширение не копируются. Вызывающим нужен только статус.
      if (looksMissing(res.status, body)) return { ok: false, status: 404, missing: true };
      // Неверный ключ повторять бессмысленно и опасно: молчаливый повтор
      // прячет причину, по которой база не приедет.
      if (res.status === 401 || res.status === 403) {
        throw new Error(`${res.status}: ключ не подошёл`);
      }
      last = new Error(`${res.status} ${res.statusText}${body ? ' — ' + body.slice(0, 200) : ''}`);
    } catch (e) {
      if (/ключ не подошёл/.test(e.message)) throw e;
      last = e;
    }
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

// Проверка настройки: заливаем крошечный файл, читаем обратно, сверяем,
// удаляем. Без неё «я всё настроила» и «оно работает» — разные утверждения,
// и разницу между ними видно только через сутки, когда прогон не найдёт базу.
export async function checkRemote() {
  const steps = [];
  const say = (ok, text) => { steps.push({ ok, text }); return ok; };

  if (!remoteConfigured()) {
    say(false, 'Переменные SUPABASE_URL и SUPABASE_KEY не заданы — хранилище не настроено');
    return { ok: false, steps };
  }
  say(true, `Адрес ${URL_}, бакет «${BUCKET}», ключ ${KEY.slice(0, 12)}…`);
  if (!/^sb_secret_|^eyJ/.test(KEY)) {
    say(false, 'Это похоже на публичный ключ. Нужен секретный: sb_secret_… или старый service_role');
    return { ok: false, steps };
  }

  const name = `probe-${Date.now()}.txt`;
  const body = Buffer.from(`проверка связи ${new Date().toISOString()}`);

  try {
    const up = await tryFetch(endpoint(name), {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'text/plain', 'x-upsert': 'true' },
      body,
    }, 1);
    if (!up.ok) {
      const why = up.status === 400 || up.status === 404
        ? `бакет «${BUCKET}» не найден — создайте его в Storage`
        : up.status === 401 || up.status === 403
          ? 'ключ не подошёл — нужен секретный (sb_secret_… или service_role), не публичный'
          : `ответ ${up.status}`;
      say(false, `Записать не удалось: ${why}`);
      return { ok: false, steps };
    }
    say(true, 'Запись прошла');

    const down = await tryFetch(endpoint(name), { headers: auth }, 1);
    if (!down.ok) { say(false, `Прочитать обратно не удалось: ответ ${down.status}`); return { ok: false, steps }; }
    const back = Buffer.from(await down.arrayBuffer());
    if (!back.equals(body)) { say(false, 'Прочиталось не то, что записывали'); return { ok: false, steps }; }
    say(true, 'Чтение прошло, содержимое совпало');

    const del = await tryFetch(endpoint(name), { method: 'DELETE', headers: auth }, 1);
    say(del.ok, del.ok ? 'Пробный файл убран' : `Пробный файл остался лежать (ответ ${del.status}), это не страшно`);

    // Главное — путь «файла нет». Прежняя проверка его не трогала: она
    // читала файл, который сама только что записала. А сломался прогон
    // именно здесь, потому что Supabase отвечает на пропажу кодом 400.
    const gone = await tryFetch(endpoint(`nothing-here-${Date.now()}.txt`), { headers: auth }, 1);
    if (gone.status !== 404) {
      say(false, `Отсутствующий файл распознан как ответ ${gone.status}, а должен как «нет файла»`);
      return { ok: false, steps };
    }
    say(true, 'Отсутствующий файл распознан правильно');

    // И наконец — что в хранилище лежит на самом деле. Без этого «база
    // уехала» остаётся утверждением: заливка вернула успех, но увидеть
    // результат было негде.
    const ls = await tryFetch(`${URL_}/storage/v1/object/list/${BUCKET}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix: '', limit: 100, sortBy: { column: 'name', order: 'asc' } }),
    }, 1);
    if (ls.ok) {
      const items = await ls.json().catch(() => []);
      const db = items.filter((o) => FILES.includes(o.name));
      if (!db.length) {
        say(true, 'Базы в хранилище пока нет — приедет после первого сбора');
      } else {
        const size = db.reduce((n, o) => n + (o.metadata?.size ?? 0), 0);
        say(true, `В хранилище ${db.length} из ${FILES.length} файлов базы, ${(size / 1048576).toFixed(1)} МБ`);
        for (const o of db) {
          const mb = ((o.metadata?.size ?? 0) / 1048576).toFixed(2);
          const when = (o.updated_at ?? '').slice(0, 16).replace('T', ' ');
          steps.push({ ok: true, text: `    ${o.name.padEnd(22)} ${mb.padStart(6)} МБ   ${when}` });
        }
      }
    }

    return { ok: true, steps };
  } catch (e) {
    say(false, `Связи нет: ${e.message}`);
    return { ok: false, steps };
  }
}

function hash(buf) {
  let h = 5381;
  for (let i = 0; i < buf.length; i++) h = ((h * 33) ^ buf[i]) >>> 0;
  return buf.length + ':' + h.toString(36);
}
