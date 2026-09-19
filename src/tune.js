// Подбор формата для темы: пробуем несколько способов её найти и оставляем
// тот, что приводит наш контент, а не чужой.
//
// Зачем это существует. Раньше формат был один — «documentary» — и он
// дописывался к каждой теме автоматически. Инструмент искал документалки,
// находил документальные каналы, «узнавал», что documentary популярно, и
// дописывал его к новым темам. Выхода из петли не было: тема, живущая под
// другим словом, не могла быть найдена никогда.
//
// Замер стоит дорого — сто юнитов за поиск, — поэтому здесь жёсткий бюджет.
// За прогон подбирается формат для одной-двух тем, и тема, для которой он
// уже подобран, больше не трогается. За месяц через это пройдут все.
import { YouTubeApi, parseDuration } from './api.js';
import { formatsFor, buildQuery, scoreHarvest, pickFormat } from './formats.js';

// Сколько тем за прогон. Один подбор — это число форматов × 100 юнитов,
// то есть около 500 из девяти тысяч. Больше двух за раз брать незачем:
// темы никуда не убегут, а квота нужна сбору.
const TOPICS_PER_RUN = 2;

async function harvest(api, db, query) {
  const res = await api.search({ q: query, maxResults: 50, relevanceLanguage: 'en' });
  const ids = (res.items ?? []).map((i) => i.id?.videoId).filter(Boolean);
  if (!ids.length) return [];

  const details = [];
  for (let i = 0; i < ids.length; i += 50) {
    const d = await api.videos(ids.slice(i, i + 50));
    details.push(...(d.items ?? []));
  }
  // Подписчиков берём из своей базы, а не отдельным запросом: лишний вызов
  // на каждый формат стоил бы дороже самого подбора, а для оценки хватает
  // тех каналов, что мы уже знаем.
  return details.map((v) => {
    const cid = v.snippet?.channelId;
    return {
      channelId: cid,
      sec: parseDuration(v.contentDetails?.duration ?? ''),
      subs: db.channels[cid]?.subscribers ?? null,
    };
  });
}

// Темы без подобранного формата, самые молодые первыми: свежая находка
// важнее — по ней ещё не собрано ничего, и ошибиться с запросом дороже.
export function needFormat(seeds, lang = 'en') {
  return seeds
    .filter((s) => s[lang] && !s.formatTried && s.source === 'auto')
    .sort((a, b) => String(b.addedAt ?? '').localeCompare(String(a.addedAt ?? '')));
}

export async function tuneFormats({ api, db, seeds, lang = 'en', limit = TOPICS_PER_RUN }) {
  const queue = needFormat(seeds, lang).slice(0, limit);
  const formats = formatsFor(lang);
  const done = [];

  for (const seed of queue) {
    const subject = seed.subject ?? seed[lang];
    if (!subject) continue;
    const tried = [];
    for (const format of formats) {
      const query = buildQuery(subject, format);
      if (!query) continue;
      if (!api.quota.canAfford('search')) break;
      try {
        const rows = await harvest(api, db, query);
        tried.push({ format, query, ...scoreHarvest(rows) });
      } catch (e) {
        console.log(`  подбор формата «${query}»: ${e.message}`);
      }
    }
    if (!tried.length) continue;

    const best = pickFormat(tried);
    if (!best) continue;
    seed.subject = subject;
    seed.format = best.format;
    seed[lang] = best.query;
    seed.formatTried = tried.map((t) => ({
      format: t.format, score: Math.round(t.score * 100) / 100,
      longShare: Math.round(t.longShare * 100) / 100,
      smallShare: Math.round(t.smallShare * 100) / 100,
      channels: t.channels,
    }));
    done.push({ subject, chosen: best.format || '(без слова)', tried: tried.length });
  }
  return done;
}
