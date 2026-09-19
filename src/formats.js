// Формат темы: чем она ищется, а не чем она является.
//
// Разделение появилось из наблюдения пользователя: во всех выводах темы
// назывались «X documentary», и создавалось впечатление, что на YouTube
// одни документалки. Впечатление было ложным, но причина настоящая —
// toQuery дописывал одно и то же слово к каждой теме, а потом это слово
// становилось частью её названия.
//
// Здесь они разведены. Тема — это «древний Египет». «documentary» — способ
// её найти. Способов несколько, и какой подходит, решает замер.
import { readJson, ROOT } from './store.js';
import { join } from 'node:path';

const CONFIG = readJson(join(ROOT, 'config/formats.json'), { en: [], de: [] });

export function formatsFor(lang = 'en') {
  return (CONFIG[lang] ?? CONFIG.en ?? []).map((f) => f.word);
}

// Запрос из темы и формата. Пустой формат — это осознанный вариант «искать
// голым предметом», а не отсутствие настройки.
export function buildQuery(subject, format) {
  const s = (subject ?? '').trim();
  if (!s) return '';
  const f = (format ?? '').trim();
  if (!f) return s;
  // Предлог идёт впереди: «the truth about pyramids», а не «pyramids the
  // truth about».
  return /\b(about|behind|of)$/i.test(f) ? `${f} ${s}` : `${s} ${f}`;
}

// Обратная операция: вытащить предмет из запроса, собранного раньше.
// Нужна для тем, заведённых до разделения — у них в конфиге лежит только
// готовая строка.
export function splitQuery(query, lang = 'en') {
  const q = (query ?? '').trim();
  if (!q) return { subject: '', format: '' };
  for (const f of formatsFor(lang).filter(Boolean)) {
    const tail = new RegExp(`\\s+${f.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}$`, 'i');
    if (tail.test(q)) return { subject: q.replace(tail, '').trim(), format: f };
    const head = new RegExp(`^${f.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s+`, 'i');
    if (head.test(q)) return { subject: q.replace(head, '').trim(), format: f };
  }
  return { subject: q, format: '' };
}

// Насколько улов подходит нам.
//
// Три вещи, и все три из замера, который и показал проблему:
//
//   длина     доля роликов длиннее восьми минут. Мультсборники и детские
//             обучалки тоже длинные, так что одной длины мало, но без неё
//             в выборку лезут нарезки.
//   новички   доля роликов у каналов меньше ста тысяч подписчиков. Тема,
//             где всё принадлежит Netflix и National Geographic, нам
//             закрыта, какие бы там ни были просмотры.
//   разброс   сколько разных каналов. Если пятьдесят роликов принадлежат
//             пяти каналам, это не ниша, а вотчина.
//
// Просмотры намеренно НЕ участвуют. По ним выигрывал бы запрос без слова:
// MrBeast с двумястами миллионами перевесит любую нишу, в которую мы можем
// войти.
export function scoreHarvest(rows) {
  if (!rows?.length) return { score: 0, longShare: 0, smallShare: 0, channels: 0, n: 0 };
  const long = rows.filter((r) => r.sec >= 480).length / rows.length;
  const withSubs = rows.filter((r) => Number.isFinite(r.subs));
  const small = withSubs.length
    ? withSubs.filter((r) => r.subs < 100000).length / withSubs.length : 0;
  const channels = new Set(rows.map((r) => r.channelId)).size;
  const spread = Math.min(1, channels / Math.max(rows.length * 0.5, 1));
  return {
    score: long * 0.4 + small * 0.4 + spread * 0.2,
    longShare: long, smallShare: small, channels, n: rows.length,
  };
}

// Какой формат теме подходит. Ничья решается в пользу первого в списке:
// он базовый и проверен, а менять его ради сотых долей незачем.
export function pickFormat(tried) {
  const ok = tried.filter((t) => t && t.n >= 10);
  if (!ok.length) return null;
  return ok.reduce((best, t) => (t.score > best.score + 0.05 ? t : best), ok[0]);
}
