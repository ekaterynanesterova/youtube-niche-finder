// Отчёт, который читается глазами с планшета прямо на GitHub.
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const num = (x) => (x == null ? '—' : Math.round(x).toLocaleString('ru-RU'));
const one = (x) => (x == null ? '—' : x.toFixed(1));

// Ниша интересна, когда дверь открыта, спрос есть, а мусора мало.
// Это ранжирование по собранным данным, а не прогноз.
export function score(n) {
  if (n.permeability == null || n.outlierChannels < 3) return null;
  const demand = Math.log10(Math.max(n.medianOutlierViews ?? 0, 1)) / 6; // 0..~1
  const clean = 1 - (n.slopShare ?? 0);
  const alive = Math.min((n.medianLikeRate ?? 0) / 0.03, 1); // 3% лайков — здоровый док
  return n.permeability * 0.45 + demand * 0.25 + clean * 0.2 + alive * 0.1;
}

export function renderReport(m, seeds) {
  const ranked = Object.values(m.niches)
    .map((n) => ({ ...n, score: score(n) }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  const withData = ranked.filter((n) => n.score != null);
  const noData = ranked.filter((n) => n.score == null);

  const L = [];
  L.push(`# Ниши — срез на ${m.computedAt.slice(0, 10)}`);
  L.push('');
  L.push(`Каналов в базе: **${Object.keys(m.channels).length}** · видео: **${m.videos.length}** · дней накопления: **${m.snapshotDays}**`);
  L.push('');
  if (m.snapshotDays < 21) {
    L.push(`> ⚠️ Накоплено ${m.snapshotDays} дн. Скорость роста пока считается как «просмотры ÷ возраст» — это грубая прокси-оценка. Настоящая кривая появится после ~21 дня сбора.`);
    L.push('');
  }

  L.push('## Рейтинг — немецкий рынок');
  L.push('');
  L.push('| # | Ниша | Проницаемость | Молодых пробилось | Медиана выброса | Длина выброса | Мусорность | Лайки | Публикаций/нед | Доверие |');
  L.push('|---|------|---------------|-------------------|-----------------|---------------|------------|-------|----------------|---------|');
  withData.forEach((n, i) => {
    L.push(`| ${i + 1} | **${n.id}** <br><sub>${n.group}</sub> | ${pct(n.permeability)} | ${n.youngOutlierChannels} из ${n.outlierChannels} | ${num(n.medianOutlierViews)} | ${one(n.medianOutlierMinutes)} мин | ${pct(n.slopShare)} | ${pct(n.medianLikeRate)} | ${one(n.medianUploadsPerWeek)} | ${n.confidence} |`);
  });
  L.push('');

  L.push('## Немецкий против английского');
  L.push('');
  L.push('Язык канала определён по его собственным видео, а не по запросу: поиск с `relevanceLanguage=de` охотно возвращает National Geographic. Строки с ⚓ — опорные темы, по которым английский снимается намеренно; в остальных англоязычные каналы просто попались в немецкой выдаче.');
  L.push('');
  L.push('| Ниша | DE проницаемость | DE медиана | EN проницаемость | EN медиана |');
  L.push('|------|------------------|------------|------------------|------------|');
  for (const n of ranked.filter((x) => x.byMarket.de.channels || x.byMarket.en.channels)) {
    const d = n.byMarket.de, e = n.byMarket.en;
    L.push(`| ${n.control ? '⚓ ' : ''}${n.id} | ${pct(d.permeability)} (${d.outlierChannels}) | ${num(d.medianViews)} | ${pct(e.permeability)} (${e.outlierChannels}) | ${num(e.medianViews)} |`);
  }
  L.push('');

  L.push('## Свежие выбросы на молодых каналах');
  L.push('');
  L.push('Кандидаты «дверь открыта прямо сейчас»: канал моложе года, видео выстрелило кратно своей же медиане.');
  L.push('');
  const hot = m.videos
    .filter((v) => v.outlierRatio >= m.thresholds.outlierRatio
      && v.views >= m.thresholds.outlierMinViews
      && v.channelAgeAtUploadDays != null
      && v.channelAgeAtUploadDays <= m.thresholds.youngChannelDays)
    .sort((a, b) => (b.proxyVelocity ?? 0) - (a.proxyVelocity ?? 0))
    .slice(0, 40);
  L.push('| Видео | Канал | ×медианы | Просмотры | Возраст канала | Просм./день |');
  L.push('|-------|-------|----------|-----------|----------------|-------------|');
  for (const v of hot) {
    const title = (v.title ?? '').replace(/\|/g, '\\|').slice(0, 70);
    const ch = m.channels[v.channelId];
    L.push(`| [${title}](https://youtu.be/${v.id}) | ${(ch?.title ?? '').replace(/\|/g, '\\|').slice(0, 30)} | ${one(v.outlierRatio)} | ${num(v.views)} | ${num(v.channelAgeAtUploadDays)} дн | ${num(v.proxyVelocity)} |`);
  }
  L.push('');

  if (noData.length) {
    L.push('## Пока без данных');
    L.push('');
    L.push(noData.map((n) => `\`${n.id}\``).join(' · '));
    L.push('');
    L.push('Пробилось меньше трёх разных молодых каналов — судить не о чем. Нужны прогоны.');
    L.push('');
  }

  L.push('---');
  L.push('');
  L.push('### Как читать');
  L.push('');
  L.push('- **Проницаемость** — доля каналов с выбросами, которым на момент выстрела не было года. Высокая = алгоритм пускает новичков. Низкая = сидят старожилы, не залететь.');
  L.push('- **Молодых пробилось** — сколько *разных* каналов моложе года дали выброс, из общего числа каналов с выбросами. Смотреть надо на первое число: канал бывает «проклятым» сам по себе, и один везунчик ничего не доказывает. Ниже трёх разных каналов ниша в рейтинг не попадает вообще.');
  L.push('- **Длина выброса** — сколько минут длится типовое выстрелившее видео. Прямая оценка того, во что обойдётся вход.');
  L.push('- **Мусорность** — доля молодых каналов-конвейеров (от 5 видео в неделю, возраст до полугода). Высокая = нишу заливают AI-потоком, YouTube такое давит.');
  L.push('- **Лайки** — лайков на просмотр. У живого дока обычно 2–5%, у конвейерного контента заметно ниже.');
  L.push('- **Доверие** — можно ли уже что-то решать по этим цифрам.');
  L.push('');
  L.push('Рейтинг построен только по немецкоязычным каналам. Английский идёт отдельной таблицей как мерная линейка.');
  L.push('');
  L.push('Ранжирование считается из собранных данных и ничего не предсказывает: оно показывает, где дверь открыта *сейчас*.');
  return L.join('\n');
}
