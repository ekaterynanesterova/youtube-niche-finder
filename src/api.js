// Тонкая обёртка над YouTube Data API v3. Без зависимостей — fetch есть в Node 20+.

const BASE = 'https://www.googleapis.com/youtube/v3';

export class QuotaExceeded extends Error {
  constructor(msg) { super(msg); this.name = 'QuotaExceeded'; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class YouTubeApi {
  constructor(key, quota) {
    if (!key) throw new Error('Нет ключа: переменная окружения YOUTUBE_API_KEY пуста');
    this.key = key;
    this.quota = quota;
  }

  async call(endpoint, params) {
    this.quota.spend(endpoint);

    const url = new URL(`${BASE}/${endpoint}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    url.searchParams.set('key', this.key);

    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(1000 * 2 ** attempt);
      let res;
      try {
        res = await fetch(url, { headers: { accept: 'application/json' } });
      } catch (e) {
        lastErr = e;
        continue; // сеть моргнула — повторяем
      }

      if (res.ok) return res.json();

      const body = await res.text();
      // Исчерпанная квота — не ретраится, до завтра бесполезно.
      if (res.status === 403 && /quota/i.test(body)) {
        throw new QuotaExceeded(`Квота проекта в Google Cloud исчерпана: ${body.slice(0, 300)}`);
      }
      // 400 — наша ошибка в параметрах, ретрай не поможет.
      if (res.status === 400 || res.status === 404) {
        throw new Error(`${endpoint} ${res.status}: ${body.slice(0, 300)}`);
      }
      lastErr = new Error(`${endpoint} ${res.status}: ${body.slice(0, 300)}`);
    }
    throw lastErr;
  }

  // Разведка: ищем не видео, а каналы, которые их сняли.
  search({ q, publishedAfter, regionCode, relevanceLanguage, videoDuration = 'long', maxResults = 50 }) {
    return this.call('search', {
      part: 'snippet', type: 'video', order: 'viewCount',
      q, publishedAfter, regionCode, relevanceLanguage, videoDuration, maxResults,
    });
  }

  channels(ids) {
    return this.call('channels', {
      part: 'snippet,statistics,contentDetails',
      id: ids.join(','), maxResults: 50,
    });
  }

  playlistItems(playlistId, pageToken) {
    return this.call('playlistItems', {
      part: 'contentDetails', playlistId, maxResults: 50, pageToken,
    });
  }

  videos(ids) {
    return this.call('videos', {
      part: 'snippet,contentDetails,statistics',
      id: ids.join(','), maxResults: 50,
    });
  }
}

// PT1H2M3S -> 3723
export function parseDuration(iso) {
  if (!iso) return 0;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return 0;
  const [, d, h, min, s] = m.map((x) => (x ? Number(x) : 0));
  return d * 86400 + h * 3600 + min * 60 + s;
}
