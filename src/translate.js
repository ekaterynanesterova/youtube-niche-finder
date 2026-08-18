// Перевод названий видео на русский. Названия — живой текст с YouTube, взять
// его неоткуда, кроме внешнего сервиса. Поэтому здесь три правила: всё
// переведённое ложится в кеш навсегда, на прогон есть жёсткий лимит символов,
// и любая неудача не роняет прогон — остаётся оригинал.

const ENDPOINT = 'https://api.mymemory.translated.net/get';

// Бесплатный анонимный тариф MyMemory — 5000 символов в сутки.
// Берём с запасом: кеш всё равно быстро сделает расход околонулевым.
export const DEFAULT_CHAR_BUDGET = 4200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Translator {
  constructor({ cache = {}, charBudget = DEFAULT_CHAR_BUDGET, fetchImpl = fetch, target = 'ru' } = {}) {
    this.cache = cache;
    this.left = charBudget;
    this.fetch = fetchImpl;
    this.target = target;
    this.stats = { hit: 0, fetched: 0, skipped: 0, failed: 0 };
    this.blocked = false; // сервис сказал, что лимит исчерпан
  }

  key(text, from) { return `${from}:${text}`; }

  cached(text, from) { return this.cache[this.key(text, from)] ?? null; }

  async translate(text, from) {
    if (!text || from === this.target) return null;
    const hit = this.cached(text, from);
    if (hit !== null) { this.stats.hit++; return hit; }
    if (this.blocked || text.length > this.left) { this.stats.skipped++; return null; }

    const url = `${ENDPOINT}?q=${encodeURIComponent(text)}&langpair=${from}|${this.target}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await sleep(1500);
      try {
        const res = await this.fetch(url, { headers: { accept: 'application/json' } });
        if (!res.ok) continue;
        const body = await res.json();
        const out = body?.responseData?.translatedText;
        if (typeof out !== 'string' || !out) continue;
        // Сервис возвращает предупреждение о лимите в поле перевода —
        // класть такое в кеш нельзя, иначе оно там останется навсегда.
        if (/MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(out)) { this.blocked = true; return null; }
        this.left -= text.length;
        this.cache[this.key(text, from)] = out;
        this.stats.fetched++;
        return out;
      } catch { /* сеть моргнула — вторая попытка */ }
    }
    this.stats.failed++;
    return null;
  }

  // Переводит по очереди: параллелить бесплатный сервис — верный способ
  // получить бан вместо переводов.
  async translateAll(items) {
    for (const it of items) {
      it.titleRu = await this.translate(it.title, it.from);
    }
    return this.stats;
  }
}
