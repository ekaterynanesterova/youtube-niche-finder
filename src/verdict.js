// Вывод: то, ради чего всё считалось. Не таблица, а несколько ниш с ответом
// «сколько это приносит, кто уже дошёл и за какой срок».

const MARKET = { de: 'немецкий', en: 'английский' };

export function buildVerdict({ niches, thresholds, minYoung = 2 }) {
  const rows = [];
  const pending = [];
  const broad = [];
  for (const n of niches) {
    // Запрос, не называющий предмет, ранжировать нельзя: его цифры описывают
    // не тему, а весь жанр. Показываем отдельно и с объяснением.
    if (n.broad) {
      const best = Object.entries(n.byMarket)
        .sort((a, b) => (b[1].channels ?? 0) - (a[1].channels ?? 0))[0];
      // Показываем ровно тот запрос, по которому и вынесен вердикт: иначе
      // рядом с немецкой строкой стоят английские слова из объяснения.
      broad.push({ id: n.id, ru: n.ru, query: n.broadQuery ?? n.queries[n.broadLang] ?? n.id,
                   lang: n.broadLang ?? best?.[0] ?? 'en', reason: n.broadReason,
                   channels: best?.[1]?.channels ?? 0, fresh: best?.[1]?.freshViews ?? null });
      continue;
    }
    for (const [lang, m] of Object.entries(n.byMarket)) {
      // Доказательством считаем только повторяемость: один дошедший канал
      // может быть чьей угодно удачей, двое — уже закономерность.
      if (m.youngOutlierChannels < minYoung) continue;
      // Без выборки свежих роликов судить не о чем: главный вопрос ниши
      // именно в них.
      if (m.freshViews == null) continue;
      // Ниша, по которой сделали один поиск, ничего о себе не сообщает: её
      // «размер» — это размер нашего обхода. Такие показываем отдельно, не
      // в рейтинге.
      // Доказательство — найденные каналы, а не журнал поисков: журнал ведётся
      // только с недавних пор, а данные копились раньше. Число поисков служит
      // объяснением, почему тема тонкая, а не самостоятельным барьером.
      if (m.channels < (thresholds.nicheMinChannels ?? 15)) {
        pending.push({ id: n.id, ru: n.ru, lang, query: n.queries[lang] ?? n.id,
                       searches: n.searches, channels: m.channels,
                       totalResults: n.totalResults, fresh: m.freshViews });
        continue;
      }
      rows.push({
        id: n.id, ru: n.ru, group: n.group, lang,
        market: MARKET[lang] ?? lang,
        query: n.queries[lang] ?? n.id,
        young: m.youngOutlierChannels,
        total: m.outlierChannels,
        nicheChannels: m.channels,
        searches: n.searches,
        totalResults: n.totalResults,
        newLastSearch: n.newChannelsLastSearch,
        usd: m.medianYoungMonthlyUsd ?? m.medianMonthlyUsd,
        mature: m.matureChannels,
        matureUsd: m.medianMatureUsd,
        climb: m.medianClimbUsd,
        fastestMonths: m.fastestYoungDays == null ? null : m.fastestYoungDays / 30.4,
        minutes: m.medianOutlierMinutes,
        pace: m.medianEarningMinutesPerWeek,
        conveyor: m.conveyorShare,
        missing: m.lotteryShare,
        views: m.medianOutlierViews,
        fresh: m.freshViews,
        freshTop: m.freshTop,
        freshBest: m.freshBest,
        freshOver20k: m.freshOverWorking,
        freshOver100k: m.freshOverBreakout,
        freshSample: m.freshSample,
        freshChannels: m.freshChannels,
        freshWinners: m.freshWinners,
        shelf: m.shelfLiveIndex ?? m.shelfIndex,
        shelfLive: m.shelfLiveIndex != null,
        shelfOldShare: m.shelfOldShare,
        shelfShare: m.shelfLiveIndex != null ? m.shelfGainShare : m.shelfViewShare,
        catalog: m.medianEarningCatalog,
        catalogMax: m.maxEarningCatalog,
      });
    }
  }

  // Разные запросы могут описывать одну тему («deep sea documentary» и
  // «deep sea creatures»). Показывать их дважды — засорять вывод.
  const seen = new Map();
  const unique = [];
  for (const r of rows) {
    const key = r.lang + '|' + r.young + '|' + Math.round(r.usd ?? 0) + '|' + Math.round(r.catalog ?? 0);
    if (seen.has(key)) { seen.get(key).alias.push(r.query); continue; }
    r.alias = [];
    seen.set(key, r);
    unique.push(r);
  }
  rows.length = 0;
  rows.push(...unique);

  // Ранжируем по тому, что решает: сколько соберёт УДАЧНЫЙ ролик у новичка и у
  // скольких разных новичков это вышло.
  //
  // Раньше в основании стояла медиана — и она уводила в сторону. Распределение
  // здесь степенное: в «dinosaur documentary» медиана свежего ролика 982
  // просмотра, верхняя четверть 14 239, лучший 893 401, и планку в 20 тысяч
  // взяли двенадцать разных молодых каналов. Медиана описывала поток
  // однотипных роликов, которые мы всё равно снимать не собираемся, и ниша
  // с двенадцатью пробившимися новичками оказывалась внизу списка.
  //
  // Повторяемость считаем по каналам, а не по роликам: один канал, заливший
  // тридцать штук, сам себе делает любой процент.
  const upside = (r) => r.freshTop ?? r.fresh ?? 0;
  const repeat = (r) => (r.freshChannels ? (r.freshWinners ?? 0) / r.freshChannels : 0);
  rows.sort((a, b) => (upside(b) * (0.5 + repeat(b))) - (upside(a) * (0.5 + repeat(a))));

  for (const r of rows) {
    r.why = why(r);
    r.risk = risk(r, thresholds);
    r.effort = effort(r);
  }
  pending.sort((a, b) => (b.fresh ?? 0) - (a.fresh ?? 0));
  rows.pending = pending;
  rows.broad = broad;
  return rows;
}

function months(x) {
  const n = Math.round(x);
  const k = n % 10, m = n % 100;
  return n + ' ' + (m > 10 && m < 20 ? 'месяцев' : k === 1 ? 'месяц' : k > 1 && k < 5 ? 'месяца' : 'месяцев');
}

function plural(n, a, b, c) {
  const m = n % 100, k = n % 10;
  return n + ' ' + (m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c);
}

const nn = (x) => Math.round(x).toLocaleString('ru-RU');

function why(r) {
  const parts = [];
  if (r.freshTop != null) {
    // Сначала то, ради чего в нишу идут, потом то, что бывает у большинства.
    parts.push(`удачный ролик у канала без аудитории берёт ${nn(r.freshTop)} просмотров `
      + `за первые два месяца, лучший в нише — ${nn(r.freshBest)}`);
    parts.push(`типовой при этом ${nn(r.fresh)} — половина роликов ниши проходит незамеченной`);
  } else if (r.fresh != null) {
    parts.push(`типовой свежий ролик у канала без аудитории собирает ${nn(r.fresh)} просмотров `
      + `за первые два месяца, лучший — ${nn(r.freshBest)}`);
  }
  if (r.freshWinners) {
    parts.push(`планку в 20 тысяч взяли ${r.freshWinners} из ${r.freshChannels} `
      + plural(r.freshChannels, 'молодого канала', 'молодых каналов', 'молодых каналов').replace(/^\d+\s/, ''));
  }
  parts.push(`${plural(r.young, 'канал', 'канала', 'каналов')} моложе года уже ${r.young === 1 ? 'зарабатывает' : 'зарабатывают'}`);
  if (r.mature) parts.push(`${r.mature} доросли до полной цели`);
  if (r.fastestMonths != null) parts.push(`самый быстрый дошёл за ${months(r.fastestMonths)}`);
  return parts.join(', ') + '.';
}

function risk(r, thresholds) {
  const out = [];
  // Тонкая выборка — сама по себе риск. Красивые проценты по трём каналам
  // и десятку роликов не значат почти ничего.
  if (r.nicheChannels != null && r.nicheChannels < 25) {
    out.push(`в базе всего ${plural(r.nicheChannels, 'канал', 'канала', 'каналов')} по теме — выборка тонкая, проценты по ней шаткие`);
  }
  if (r.freshSample != null && r.freshSample < 25) {
    out.push(`свежих роликов для замера всего ${r.freshSample}, цифра может сильно поехать`);
  }
  if ((r.missing ?? 0) >= 0.6) {
    out.push(`${Math.round(r.missing * 100)}% каналов ниши до цели не дотягивают — попадания там есть, денег нет`);
  }
  if ((r.conveyor ?? 0) >= 0.6) {
    out.push(`ниша работает на потоке: ${Math.round(r.conveyor * 100)}% каналов гонят больше трёх часов видео в неделю`);
  }
  if (r.minutes != null && r.minutes >= 90) {
    out.push(`типовой ролик — ${Math.round(r.minutes)} минут, это тяжёлый вход`);
  }
  // Главный риск — свежий ролик не собирает. Всё остальное вторично.
  if (r.fresh != null && r.fresh < 3000) {
    out.push(`свежий ролик новичка собирает всего около ${Math.round(r.fresh).toLocaleString('ru-RU')} просмотров — заработать в моменте не выйдет`);
  } else if ((r.freshOver20k ?? 0) < 0.2) {
    out.push(`только ${Math.round((r.freshOver20k ?? 0) * 100)}% свежих роликов берут 20 тысяч — большинство выходит впустую`);
  }
  // Тема может кончиться раньше канала — это отдельный риск, не связанный
  // с деньгами и конкуренцией.
  if (r.catalog != null && r.catalog < 30) {
    out.push(`тема неглубокая: у дошедших каналов в среднем всего ${Math.round(r.catalog)} роликов, надолго её может не хватить`);
  }
  return out.length ? out.join('; ') + '.' : 'Явных ловушек в цифрах не видно.';
}

// Во что обойдётся вход. Считать «цель ÷ медиана выброса» нельзя: это
// предполагает, что каждый твой ролик соберёт как лучшие в нише. Берём то,
// что измерено — сколько готового видео в неделю реально держат те, кто дошёл.
function effort(r) {
  if (r.pace == null) return null;
  return {
    hoursPerWeek: Math.round((r.pace / 60) * 10) / 10,
    hoursPerMonth: Math.round((r.pace * 4.35) / 60),
    minutes: r.minutes == null ? null : Math.round(r.minutes),
  };
}

// Одна фраза наверх страницы: что вообще происходит.
export function headline(rows, marketStats) {
  if (!rows.length) {
    return 'Пока ни в одной нише не набралось двух молодых каналов, вышедших на цель. Нужны прогоны.';
  }
  const top = rows[0];
  const de = marketStats.de, en = marketStats.en;
  const gap = de.youngRate != null && en.youngRate != null && en.youngRate > 0
    ? ` Для сравнения рынков: на немецком до цели доходят ${Math.round(de.youngRate * 100)}% молодых каналов, на английском — ${Math.round(en.youngRate * 100)}%.`
    : '';
  // Название лидера уже стоит в шапке крупно — здесь важно то, чего там нет:
  // сколько он приносит и как рынки соотносятся между собой.
  return `У ${plural(top.young, 'молодого канала', 'молодых каналов', 'молодых каналов')} в этой нише уже есть доход, ` +
         `типичный — около $${Math.round(top.usd ?? 0)} в месяц.${gap}`;
}

export function marketStats(channels, thresholds) {
  const out = {};
  for (const lang of ['de', 'en']) {
    const all = Object.values(channels).filter((c) => c.lang === lang);
    const young = all.filter((c) => c.ageDays != null && c.ageDays <= thresholds.youngChannelDays);
    const earning = young.filter((c) => c.earning);
    out[lang] = {
      channels: all.length,
      young: young.length,
      youngEarning: earning.length,
      youngRate: young.length ? earning.length / young.length : null,
    };
  }
  return out;
}
