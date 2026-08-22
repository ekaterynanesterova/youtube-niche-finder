// Метрики. Всё считается из накопленных данных, ничего не предсказывается.
import { daysBetween } from './store.js';
import { stopWords, topicShape } from './topics.js';

// Возраст канала. Полный архив даёт настоящую дату первой загрузки; когда
// архив не долистан, берём дату регистрации — она может только состарить канал,
// а это безопасная сторона ошибки.
const ageDays_ = (at, now) => daysBetween(at, now);

function ageDays(ch, now) {
  const basis = ch.firstUploadComplete ? ch.firstUploadAt : ch.publishedAt;
  return basis ? daysBetween(basis, now) : null;
}

// Смысл ниши — деньги, а не проценты. Цель задана в долларах в месяц;
// из неё и RPM получается порог просмотров, и уже он решает, состоялся канал
// или нет. Кратность к медиане тут бесполезна: у мёртвого канала она
// огромная именно потому, что медиана мёртвая.
export function targetMonthlyViews(thresholds) {
  return (thresholds.targetMonthlyUsd / thresholds.rpmUsd) * 1000;
}

export function hitProfile(videos, thresholds, now) {
  const breakouts = videos.filter((v) => v.views >= thresholds.breakoutViews).length;
  const working = videos.filter((v) => v.views >= thresholds.workingViews).length;

  // Что канал приносит СЕЙЧАС: просмотры свежих роликов, а не заслуги
  // многолетней давности. Три месяца — достаточно, чтобы сгладить всплеск.
  const fresh = videos.filter((v) => daysBetween(v.publishedAt, now) <= 90);
  const monthlyViews = fresh.reduce((sum, v) => sum + (v.views ?? 0), 0) / 3;
  const target = targetMonthlyViews(thresholds);

  return {
    breakouts, working,
    workingRate: videos.length ? working / videos.length : 0,
    monthlyViews,
    monthlyUsd: (monthlyViews / 1000) * thresholds.rpmUsd,
    // Канал состоялся, если на свежем контенте выходит на цель.
    earning: monthlyViews >= target,
    // Молодой канал судить целью нельзя: он два месяца как открылся и десять
    // роликов сделал. Для него важно другое — он уже что-то зарабатывает,
    // то есть поехал. Цель остаётся мерой зрелости, а не входным билетом.
    started: (monthlyViews / 1000) * thresholds.rpmUsd >= (thresholds.startingUsd ?? 400),
    // Попадания есть, а денег нет совсем.
    lottery: working >= 1 && (monthlyViews / 1000) * thresholds.rpmUsd < (thresholds.startingUsd ?? 400),
    bestViews: videos.reduce((m, v) => Math.max(m, v.views ?? 0), 0),
  };
}

export function median(xs) {
  const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const share = (n, total) => (total ? n / total : null);

// Медиана канала — по видео старше 30 дней: свежие ещё не набрали
// и занижали бы базу, раздувая каждый ratio.
export function channelBaseline(videos, thresholds, now) {
  const mature = videos.filter((v) => daysBetween(v.publishedAt, now) >= thresholds.medianMinVideoAgeDays);
  // Медиана по двум-трём видео — это не база, а случайность: любой ролик
  // рядом с ней выглядит выбросом. Такому каналу ratio не считаем вовсе.
  const enough = mature.length >= (thresholds.medianMinMatureVideos ?? 5);
  return {
    medianViews: enough ? median(mature.map((v) => v.views)) : null,
    matureCount: mature.length,
  };
}

// Частота публикаций: сколько видео в неделю тянет канал за последние 90 дней.
export function uploadsPerWeek(videos, now, windowDays = 90) {
  const recent = videos.filter((v) => daysBetween(v.publishedAt, now) <= windowDays);
  return (recent.length / windowDays) * 7;
}

// Живая аудитория лайкает и комментирует. Конвейерный AI-контент собирает
// просмотры, но не реакцию — это и есть сигнал мусорности.
export function engagement(v) {
  if (!v.views) return { like: null, comment: null };
  return {
    like: v.likes == null ? null : v.likes / v.views,
    comment: v.comments == null ? null : v.comments / v.views,
  };
}

// Параметр relevanceLanguage в search.list — подсказка, а не фильтр: по немецкому
// запросу приезжают National Geographic и KBS. Язык канала определяем по его же
// видео; запрос говорит только о теме.
export function dominantLang(videos, fallbackMarkets = []) {
  const counts = {};
  for (const v of videos) {
    const base = (v.lang ?? '').split('-')[0];
    if (base) counts[base] = (counts[base] ?? 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (top) return top[0];
  // Язык не объявлен вообще — тогда доверяем рынку, если он единственный.
  return fallbackMarkets.length === 1 ? fallbackMarkets[0] : null;
}

export function computeMetrics({ db, seeds, thresholds, snapshots = [], baseline = null,
                                 primaryLang = 'en', now = new Date().toISOString() }) {
  const byChannel = {};
  for (const v of Object.values(db.videos)) {
    const [views, likes, comments] = db.current?.[v.id] ?? [];
    if (!v.channelId || !Number.isFinite(views)) continue;
    (byChannel[v.channelId] ??= []).push({ ...v, views, likes, comments });
  }

  // --- уровень канала ---
  const channels = {};
  for (const [cid, vids] of Object.entries(byChannel)) {
    const ch = db.channels[cid] ?? { id: cid };
    const { medianViews, matureCount } = channelBaseline(vids, thresholds, now);
    channels[cid] = {
      id: cid,
      title: ch.title ?? null,
      seeds: ch.seeds ?? [],
      markets: ch.markets ?? [],
      subscribers: ch.subscribers ?? null,
      // Дате первой загрузки верим только если долистали архив до конца.
      // Иначе она врёт в опасную сторону — канал кажется моложе, чем он есть,
      // и ниша выглядит проницаемой там, где сидят старожилы.
      firstUploadAt: ch.firstUploadComplete ? ch.firstUploadAt : null,
      firstUploadComplete: !!ch.firstUploadComplete,
      ageBasis: ch.firstUploadComplete ? 'первая загрузка' : 'регистрация канала',
      ageDays: ageDays(ch, now),
      // Дата регистрации отдельно: канал могли завести годами раньше и держать
      // пустым — так делают, когда «прогревают» аккаунт перед запуском.
      registeredDays: ch.publishedAt ? daysBetween(ch.publishedAt, now) : null,
      medianViews, matureCount,
      ...hitProfile(vids, thresholds, now),
      lang: dominantLang(vids, ch.markets ?? []),
      // Два разных числа, которые раньше были одним. videoCount — сколько
      // роликов канала есть У НАС, catalogCount — сколько их у канала на самом
      // деле (цифра самого YouTube). Архив листается не до конца: у HISTORY мы
      // держим 323 ролика из 12 305. Строка «3 из 323» в таблице конкурентов
      // выдавала случайного гостя за профильный канал.
      videoCount: vids.length,
      catalogCount: Number.isFinite(ch.videoCount) && ch.videoCount > 0 ? ch.videoCount : null,
      catalogPartial: Number.isFinite(ch.videoCount) && ch.videoCount > vids.length,
      uploadsPerWeek: uploadsPerWeek(vids, now),
      minutesPerWeek: uploadsPerWeek(vids, now) * ((median(vids.map((v) => v.durationSec)) ?? 0) / 60),
    };
  }

  // Ключевые слова тем разбираются один раз, а не для каждого из десятков
  // тысяч заголовков заново.
  //
  // Частоты считаем по УЖЕ посчитанным каналам: язык канала выводится из его
  // видео и в db.channels его нет вовсе. Раньше сюда уходил db.channels, обе
  // карты частот выходили пустыми, и выбор «двух самых редких слов запроса»
  // молча вырождался в «первые два слова». Задуманного отбора не было ни разу.
  const sIndex = seedIndex(seeds, ['de', 'en'],
    wordFrequency(Object.values(db.videos), channels));

  // Существительные считаем по немецким заголовкам: приём работает только там,
  // где регистр что-то значит.
  const deTitles = Object.values(db.videos).filter((v) => channels[v.channelId]?.lang === 'de');
  const nouns = nounEvidence(deTitles);

  // --- уровень видео ---
  const videos = [];
  for (const [cid, vids] of Object.entries(byChannel)) {
    const c = channels[cid];
    for (const v of vids) {
      const ageDays = daysBetween(v.publishedAt, now);
      const eng = engagement(v);
      // Прокси-скорость: пока не накопилась настоящая кривая, делим просмотры на возраст.
      const proxyVelocity = ageDays <= thresholds.velocityMaxVideoAgeDays && ageDays > 0
        ? v.views / ageDays : null;
      videos.push({
        id: v.id, channelId: cid, title: v.title, publishedAt: v.publishedAt,
        durationSec: v.durationSec, views: v.views, ageDays,
        outlierRatio: c.medianViews ? v.views / c.medianViews : null,
        channelAgeAtUploadDays: c.ageDays == null ? null : c.ageDays - ageDays_(v.publishedAt, now),
        proxyVelocity,
        velocity: realVelocity(v.id, snapshots),
        gain: viewsGained(v.id, snapshots, baseline, v.views),
        likeRate: eng.like, commentRate: eng.comment,
        seeds: videoNiches(v.title, sIndex, c.lang),
        channelSeeds: c.seeds,
      });
    }
  }

  // --- уровень ниши ---
  // Считаем по каждому языку отдельно. Смешивать нельзя: немецкий выброс и
  // английский живут в разных выдачах и конкурируют с разными каналами.
  const niches = {};
  for (const seed of seeds) {
    const seedVideos = videos.filter((v) => v.seeds.includes(seed.id));
    const byLang = {};
    for (const lang of ['de', 'en']) {
      byLang[lang] = nicheStats(seedVideos.filter((v) => channels[v.channelId]?.lang === lang),
                                channels, thresholds);
    }
    const st = db.state?.seedStats?.[seed.id] ?? {};
    // Называет ли запрос предмет. Ниша из запроса про одно настроение считается
    // по чужим видео: под «documentary to fall asleep to» подходит и дождь,
    // и музыка для медитации. В рейтинг такие не идут.
    const shapeLang = seed[primaryLang] ? primaryLang : (seed.en ? 'en' : 'de');
    const shapeQuery = seed[shapeLang];
    let shape = topicShape(queryKeywords(shapeQuery, shapeLang), { lang: shapeLang, nouns });

    // Стоят ли слова запроса в заголовках рядом. Обрывок шаблона их не сводит:
    // «place earth» живёт в «Most Beautiful Place on Earth», где между словами
    // предлог, и темой это сочетание не является. Настоящая связка — «mariana
    // trench», «great white shark» — стоит подряд почти всегда.
    // Запрос с настроением («space to fall asleep to») разнесён служебными
    // словами намеренно — соседства от него требовать нельзя. Проверяем только
    // чистые предметные запросы, и целиком, а не по огрызку: список немаркеров
    // однажды уже съел «white» из «great white shark» и забраковал акул.
    if (shape.ok && !shape.modifiers.length) {
      const kw = shape.subjects;
      const sample = seedVideos.filter((v) => channels[v.channelId]?.lang === shapeLang);
      if (kw.length >= 2 && sample.length >= (thresholds.topicAdjacencyMinSample ?? 20)) {
        const forms = [kw.join(' '), kw.slice().reverse().join(' ')];
        const together = sample.filter((v) => {
          const t = ' ' + (v.title ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + ' ';
          return forms.some((f) => t.includes(' ' + f + ' '));
        }).length / sample.length;
        if (together < (thresholds.topicAdjacencyMin ?? 0.05)) {
          shape = { ...shape, ok: false,
                    reason: 'слова запроса почти никогда не стоят в заголовке рядом ('
                            + Math.round(together * 100) + '%) — это обрывок шаблона, а не связка' };
        }
      }
    }
    niches[seed.id] = {
      id: seed.id, group: seed.group, control: !!seed.control,
      broad: !shape.ok, broadReason: shape.reason, subjects: shape.subjects,
      broadQuery: shapeQuery ?? null, broadLang: shapeLang,
      // Сколько раз мы вообще искали по этой теме и что YouTube думает
      // о её размере. Без этого «4 канала» читается как «на YouTube их 4».
      searches: st.searches ?? 0,
      totalResults: st.totalResults ?? null,
      newChannelsLastSearch: st.newLastRun ?? null,
      explored: (st.searches ?? 0) >= (thresholds.nicheMinSearches ?? 3),
      queries: { de: seed.de ?? null, en: seed.en ?? null },
      // Поля верхнего уровня — по основному рынку. Он давно английский, а здесь
      // всё ещё стоял немецкий: текстовый отчёт ранжировал темы по рынку, на
      // котором до цели доходит один процент каналов.
      ...byLang[primaryLang],
      byMarket: byLang,
      confidence: confidence(byLang[primaryLang].videos, byLang[primaryLang].outlierChannels, snapshots.length),
    };
  }

  return { computedAt: now, thresholds, channels, videos, niches, nouns,
           // За сколько дней измерен живой прирост. Сутки — это уже данные,
           // но выводы по ним делать рано, и это должно быть видно.
           gainWindowDays: baseline?.date ? Math.round(daysBetween(baseline.date, now)) : 0,
           snapshotDays: snapshots.length };
}

// Сколько просмотров видео набрало за окно наблюдения. Ради этого числа
// снапшоты и копятся: оно показывает, живо видео сейчас или лежит.
function viewsGained(videoId, snapshots, baseline, currentViews) {
  // Опорный срез покрывает все видео — им и меряем, когда он есть.
  const was = baseline?.views?.[videoId];
  if (Number.isFinite(was) && Number.isFinite(currentViews)) return Math.max(0, currentViews - was);
  const pts = snapshots.map((s) => s.videos?.[videoId]?.[0]).filter(Number.isFinite);
  return pts.length < 2 ? null : Math.max(0, pts[pts.length - 1] - pts[0]);
}

// Настоящая скорость роста — только когда накопились снапшоты.
function realVelocity(videoId, snapshots) {
  const points = snapshots
    .map((s) => ({ date: s.date, views: s.videos?.[videoId]?.[0] }))
    .filter((p) => Number.isFinite(p.views));
  if (points.length < 2) return null;
  const a = points[0], b = points[points.length - 1];
  const days = daysBetween(a.date, b.date);
  return days > 0 ? (b.views - a.views) / days : null;
}

function nicheStats(seedVideos, channels, thresholds) {
  // Один случайный ролик по теме не делает канал каналом этой ниши.
  const perChannel = new Map();
  for (const v of seedVideos) perChannel.set(v.channelId, (perChannel.get(v.channelId) ?? 0) + 1);
  const minVideos = thresholds.nicheMinVideosPerChannel ?? 3;
  const seedChannels = [...perChannel.entries()]
    .filter(([, n]) => n >= minVideos)
    .map(([id]) => channels[id])
    .filter(Boolean);

  const outliers = seedVideos.filter((v) =>
    v.outlierRatio != null && v.outlierRatio >= thresholds.outlierRatio && v.views >= thresholds.outlierMinViews);

  // Проницаемость считаем только по каналам, которые попадают повторно.
  // Канал с одним выстрелом на двести роликов ничего не доказывает — ни про
  // себя, ни тем более про нишу.
  // Доказательство проницаемости — молодые каналы, которые ПОЕХАЛИ. Требовать
  // от двухмесячного канала полной цели значит выбрасывать ровно тех, на кого
  // мы и хотим смотреть.
  const started = seedChannels.filter((c) => c.started);
  const outlierChannels = started.map((c) => c.id);
  const youngOutlierChannels = outlierChannels.filter((id) =>
    channels[id]?.ageDays != null && channels[id].ageDays <= thresholds.youngChannelDays);
  // Отдельно — кто уже дотянул до полной цели, любого возраста.
  const matureChannels = seedChannels.filter((c) => c.earning);
  const lotteryChannels = seedChannels.filter((c) => c.lottery);

  // Сколько готового хронометража ниша выпускает в неделю. Порог стоит высоко
  // намеренно: простой видеоряд из футажей человек собирает быстро, и три часа
  // в неделю ему вполне по силам. При таком пороге конвейером оказывалась почти
  // половина молодых зарабатывающих каналов — метрика не различала ничего.
  // Пятнадцать часов — это выше девяностого процентиля по всей базе: столько
  // руками уже не сделать.
  const conveyorChannels = seedChannels.filter((c) => c.minutesPerWeek >= thresholds.conveyorMinutesPerWeek);

  const outlierDuration = median(outliers.map((v) => v.durationSec));

  return {
    channels: seedChannels.length,
    videos: seedVideos.length,
    outliers: outliers.length,
    outlierChannels: outlierChannels.length,
    // Сколько РАЗНЫХ молодых каналов пробилось. Один везунчик ничего не доказывает:
    // канал бывает «проклятым» независимо от ниши, и наоборот. Повторяемость на
    // нескольких каналах — единственное, что отличает открытую дверь от случайности.
    youngOutlierChannels: youngOutlierChannels.length,
    // Главная метрика: доля выбросов, приходящаяся на молодые каналы.
    permeability: share(youngOutlierChannels.length, outlierChannels.length),
    medianViews: median(seedVideos.map((v) => v.views)),
    medianOutlierViews: median(outliers.map((v) => v.views)),
    // Во что обойдётся вход: сколько минут длится типовой выброс.
    medianOutlierMinutes: outlierDuration == null ? null : outlierDuration / 60,
    medianUploadsPerWeek: median(seedChannels.map((c) => c.uploadsPerWeek)),
    medianLikeRate: median(seedVideos.map((v) => v.likeRate).filter((x) => x != null)),
    medianCommentRate: median(seedVideos.map((v) => v.commentRate).filter((x) => x != null)),
    // Доля каналов, работающих на потоке.
    conveyorShare: share(conveyorChannels.length, seedChannels.length),
    // Сколько каналов держатся на единственном выстреле. Высокая доля значит,
    // что ниша выдаёт разовые везения, а не устойчивый заход.
    lotteryShare: share(lotteryChannels.length, lotteryChannels.length + outlierChannels.length),
    medianWorkingRate: median(seedChannels.filter((c) => c.working > 0).map((c) => c.workingRate)),
    // Сколько денег приносит типичный состоявшийся канал ниши.
    medianMonthlyUsd: median(started.map((c) => c.monthlyUsd)),
    // Сколько каналов ниши доросли до полной цели — мера потолка, а не входа.
    matureChannels: matureChannels.length,
    medianMatureUsd: median(matureChannels.map((c) => c.monthlyUsd)),
    // Скорость набора: сколько канал зарабатывает на месяц своей жизни.
    // Молодой канал на $700 за два месяца растёт быстрее, чем старый на $2000.
    medianClimbUsd: median(seedChannels
      .filter((c) => c.started && c.ageDays > 30)
      .map((c) => c.monthlyUsd / (c.ageDays / 30.4))),
    medianYoungMonthlyUsd: median(seedChannels
      .filter((c) => c.started && c.ageDays != null && c.ageDays <= thresholds.youngChannelDays)
      .map((c) => c.monthlyUsd)),
    // За сколько дошёл самый быстрый: это и есть ответ на «успею ли я».
    fastestYoungDays: seedChannels
      .filter((c) => c.started && c.ageDays != null && c.ageDays <= thresholds.youngChannelDays)
      .reduce((min, c) => (min == null ? c.ageDays : Math.min(min, c.ageDays)), null),
    // Сколько часов готового видео в неделю держит типичный состоявшийся канал.
    medianEarningMinutesPerWeek: median(seedChannels.filter((c) => c.earning).map((c) => c.minutesPerWeek)),
    ...newcomerFresh(seedVideos, channels, thresholds),
    ...shelfLife(seedVideos, thresholds),
    // Ёмкость: на сколько роликов темы хватает тем, кто уже дошёл. Отвечает на
    // вопрос «а что я буду снимать после десятого видео».
    medianEarningCatalog: median(seedChannels.filter((c) => c.earning).map((c) => c.videoCount)),
    maxEarningCatalog: seedChannels.filter((c) => c.earning)
      .reduce((mx, c) => Math.max(mx, c.videoCount ?? 0), 0) || null,
  };
}

// search.list возвращает не тему, а «что-то похожее»: по запросу
// «deep sea documentary» приезжают ролики про Minecraft. Ведро, где ключевые
// слова запроса встречаются у меньшинства роликов, — это не ниша, а выдача,
// и любые метрики по нему считаются по мусору.
const FORMAT_WORDS = /^(documentary|doku|dokumentation|film|video|explained|erklärt|full)$/i;

// Служебные слова берём по языку запроса. На общем списке немецкое «war»
// (был) съедало английское «war» (война): от «world war 2 documentary»
// оставалось одно слово «world», и ниша про Вторую мировую собирала всё
// подряд, где это слово встречалось.
//
// Голые цифры из запроса выбрасываем намеренно. В запросе «world war 2» двойка
// есть, а в заголовках её почти нет: пишут «WWII», «World War II», «WW2».
// Требовать её — значит не найти ничего.
export function queryKeywords(query, lang = null) {
  if (!query) return [];
  const stop = stopWords(lang);
  return query.split(/\s+/)
    .map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((w) => w.length > 2 && !FORMAT_WORDS.test(w) && !stop.has(w))
    .filter((w) => !/^\d+$/.test(w));
}

// Канал, найденный по запросу «black hole documentary», снимает не только про
// чёрные дыры. Раньше в нишу засчитывался весь его каталог целиком — пятьсот
// роликов про что угодно, — и метрики считались по чужим видео. Теперь видео
// попадает в нишу, только если сама тема видна в его заголовке.
// Тему задаёт не одно слово, а связка. По одному редкому слову «human
// evolution» и «human body» цеплялись за общее «human» и давали одинаковые
// цифры. Требуем присутствия двух самых редких слов запроса сразу — а если
// значимых слов всего одно или два, то всех.
// Сколько слов запроса обязано стоять в заголовке. Раньше хватало двух самых
// редких — и это склеивало разные темы в одну. «documentary to fall asleep to»,
// «sleep stories for adults», «calm space for sleep» и «history to fall asleep
// to» давали одни и те же якоря «fall»+«asleep» и один и тот же список из 1667
// видео: четыре ниши в отчёте, один список под ними.
//
// Теперь нужны все значимые слова запроса. Строгость вскрывает плохо
// написанные темы: запрос из четырёх понятий («james webb telescope
// discovery») перестаёт находить что-либо — и это правильный сигнал сузить
// запрос, а не повод ослабить правило.
const MAX_ANCHORS = Infinity;

export function seedIndex(seeds, langs = ['de', 'en'], wordFreq = {}) {
  const idx = {};
  for (const lang of langs) {
    idx[lang] = seeds.map((s) => {
      const key = queryKeywords(s[lang], lang);
      if (!key.length) return null;
      const freq = wordFreq[lang] ?? new Map();
      const byRarity = key.slice().sort((a, b) => (freq.get(a) ?? 0) - (freq.get(b) ?? 0));
      const anchors = byRarity.slice(0, Math.min(MAX_ANCHORS, byRarity.length));
      return { id: s.id, anchors, key };
    }).filter(Boolean);
  }
  return idx;
}

// Существительное ли слово. Для немецкого это решается корпусом: существительные
// пишутся с большой буквы, и слово, встречающееся в середине заголовка со строчной,
// существительным не является. Проверено на живых данных: Einsatz, Giganten,
// Maschinen, Weltraum — 100% заглавных; gebaut, spannende, grausamste, beherrscht,
// decken — 13–20%. Ровно эти пять автопоиск и притащил как «темы».
//
// Для английского приёма нет: в Title Case с большой буквы пишут всё подряд,
// и «Shocked» неотличим от «Shark». Там спасает только список слов в policy.json.
export function nounEvidence(videos) {
  const cap = new Map(), tot = new Map();
  for (const v of videos) {
    const words = (v.title ?? '').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    // Первое слово заголовка заглавное всегда — по нему судить нельзя.
    for (let i = 1; i < words.length; i++) {
      const w = words[i], l = w.toLowerCase();
      if (l.length < 3) continue;
      tot.set(l, (tot.get(l) ?? 0) + 1);
      if (w[0] !== l[0]) cap.set(l, (cap.get(l) ?? 0) + 1);
    }
  }
  return { cap, tot };
}

export function wordFrequency(videos, channels) {
  const out = { de: new Map(), en: new Map() };
  for (const v of videos) {
    const lang = channels[v.channelId]?.lang;
    if (!out[lang]) continue;
    const m = out[lang];
    for (const w of new Set((v.title ?? '').toLowerCase().split(/[^\p{L}\p{N}]+/u))) {
      if (w.length > 2) m.set(w, (m.get(w) ?? 0) + 1);
    }
  }
  return out;
}

// Якорь должен НАЧИНАТЬ слово, а не просто где-то встречаться. Проверка
// подстрокой засчитывала «world» внутри «underworld», «decken» внутри
// «entdecken», «schiffe» внутри «Raumschiffe». Начало слова оставляет
// множественное число и падежи («dinosaur» ловит «dinosaurs»), но отсекает
// склейку с чужим корнем.
const anchorRe = new Map();
function startsWord(text, word) {
  let re = anchorRe.get(word);
  if (!re) {
    re = new RegExp('(?:^|[^\\p{L}\\p{N}])' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u');
    anchorRe.set(word, re);
  }
  return re.test(text);
}

export function videoNiches(title, index, lang) {
  const t = (title ?? '').toLowerCase();
  if (!t || !index?.[lang]) return [];
  const out = [];
  for (const s of index[lang]) {
    if (s.anchors.every((w) => startsWord(t, w))) out.push(s.id);
  }
  return out;
}

// Главный вопрос ниши: сколько соберёт НОВЫЙ ролик, выпущенный сегодня
// каналом без аудитории. Долговечность старых роликов приятна, но вторична:
// зарабатывают на ролике в момент его выхода, а не через год.
function newcomerFresh(videos, channels, thresholds) {
  const lo = thresholds.freshMinAgeDays ?? 7;      // до недели ролик ещё разгоняется
  const hi = thresholds.freshMaxAgeDays ?? 60;
  const fresh = videos.filter((v) => {
    if (v.ageDays < lo || v.ageDays > hi) return false;
    const c = channels[v.channelId];
    return c?.ageDays != null && c.ageDays <= thresholds.youngChannelDays;
  });
  if (fresh.length < (thresholds.freshMinSample ?? 10)) {
    return { freshViews: null, freshOverWorking: null, freshOverBreakout: null, freshSample: fresh.length };
  }
  const share = (n) => fresh.filter((v) => v.views >= n).length / fresh.length;
  return {
    // Столько собирает типовой свежий ролик у канала без аудитории.
    freshViews: median(fresh.map((v) => v.views)),
    // Насколько это надёжно: доля свежих роликов, перешагнувших планку.
    freshOverWorking: share(thresholds.workingViews),
    freshOverBreakout: share(thresholds.breakoutViews),
    freshSample: fresh.length,
  };
}

// Долговечность темы: работает ли старое видео или ниша требует бежать.
// Две меры, потому что первая смещена.
function shelfLife(videos, thresholds) {
  const cut = thresholds.shelfAgeDays ?? 180;
  const old = videos.filter((v) => v.ageDays > cut);
  if (videos.length < 50 || old.length < 15) {
    return { shelfIndex: null, shelfLiveIndex: null, shelfOldShare: null,
             shelfViewShare: null, shelfGainShare: null };
  }
  const countShare = old.length / videos.length;

  // Приблизительно: какая доля НАКОПЛЕННЫХ просмотров лежит на старых видео.
  // Смещено вверх — старое видео просто дольше копило, — но между нишами
  // смещение одинаковое, так что порядок сравнивать можно.
  const sum = (xs, f) => xs.reduce((s, v) => s + (f(v) ?? 0), 0);
  const shelfIndex = (sum(old, (v) => v.views) / sum(videos, (v) => v.views)) / countShare;

  // Точно: какая доля просмотров, набранных ЗА ОКНО НАБЛЮДЕНИЯ, пришлась на
  // старые видео. Смещения нет — все считали одни и те же дни. Появляется,
  // когда накопится хотя бы неделя снапшотов.
  // Без данных по самим старым видео эта мера даёт ноль и врёт, что ниша
  // мертва. Считаем, только когда прирост известен у большинства из них.
  const oldMeasured = old.filter((v) => v.gain != null).length;
  const gained = sum(videos, (v) => v.gain);
  const shelfLiveIndex = gained > 0 && oldMeasured >= old.length * 0.5
    ? (sum(old, (v) => v.gain) / gained) / countShare
    : null;

  // Сырые доли отдаём наружу: коэффициент без них ничего не объясняет.
  return {
    shelfIndex, shelfLiveIndex,
    shelfOldShare: countShare,
    shelfViewShare: sum(old, (v) => v.views) / sum(videos, (v) => v.views),
    shelfGainShare: shelfLiveIndex == null ? null : sum(old, (v) => v.gain) / gained,
  };
}

// Честная оценка того, насколько цифрам можно верить в этот день.
function confidence(videoCount, outlierChannelCount, snapshotDays) {
  if (videoCount < 30 || outlierChannelCount < 3) return 'нет данных';
  if (snapshotDays < 7) return 'низкая — прокси-скорость, кривой роста ещё нет';
  if (snapshotDays < 21) return 'средняя — кривая роста только формируется';
  return 'рабочая';
}
