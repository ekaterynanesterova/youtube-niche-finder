// Вывод: то, ради чего всё считалось. Не таблица, а несколько ниш с ответом
// «сколько это приносит, кто уже дошёл и за какой срок».

const MARKET = { de: 'немецкий', en: 'английский' };

export function buildVerdict({ niches, thresholds, minYoung = 2 }) {
  const rows = [];
  for (const n of niches) {
    for (const [lang, m] of Object.entries(n.byMarket)) {
      // Доказательством считаем только повторяемость: один дошедший канал
      // может быть чьей угодно удачей, двое — уже закономерность.
      if (m.youngOutlierChannels < minYoung) continue;
      // Без выборки свежих роликов судить не о чем: главный вопрос ниши
      // именно в них.
      if (m.freshViews == null) continue;
      rows.push({
        id: n.id, ru: n.ru, group: n.group, lang,
        market: MARKET[lang] ?? lang,
        query: n.queries[lang] ?? n.id,
        young: m.youngOutlierChannels,
        total: m.outlierChannels,
        nicheChannels: m.channels,
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
        freshOver20k: m.freshOverWorking,
        freshOver100k: m.freshOverBreakout,
        freshSample: m.freshSample,
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

  // Ранжируем по тому, что решает: сколько соберёт новый ролик у новичка и
  // насколько это повторяемо. Число дошедших каналов — подтверждение, а не
  // основание: канал мог дойти год назад, когда в нише было пусто.
  rows.sort((a, b) =>
    ((b.fresh ?? 0) * (0.5 + (b.freshOver20k ?? 0))) -
    ((a.fresh ?? 0) * (0.5 + (a.freshOver20k ?? 0))));

  for (const r of rows) {
    r.why = why(r);
    r.risk = risk(r, thresholds);
    r.effort = effort(r);
  }
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

function why(r) {
  const parts = [];
  if (r.fresh != null) {
    parts.push(`свежий ролик у канала без аудитории собирает около ` +
      `${Math.round(r.fresh).toLocaleString('ru-RU')} просмотров, ` +
      `${Math.round((r.freshOver20k ?? 0) * 100)}% таких роликов берут 20 тысяч и выше`);
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
  if (r.nicheChannels != null && r.nicheChannels < 6) {
    out.push(`в нише всего ${plural(r.nicheChannels, 'канал', 'канала', 'каналов')} — выборка тонкая, проценты по ней шаткие`);
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
    ? ` На немецком до цели доходят ${Math.round(de.youngRate * 100)}% молодых каналов, на английском — ${Math.round(en.youngRate * 100)}%.`
    : '';
  return `Лучшее на сегодня — «${top.query}» (${top.market} рынок): ${plural(top.young, 'молодой канал', 'молодых канала', 'молодых каналов')} уже ${top.young === 1 ? 'зарабатывает' : 'зарабатывают'}, ` +
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
