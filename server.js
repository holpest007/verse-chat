// ============================================================================
//  server.js — бэкенд приложения (Node.js + Express + Socket.IO)
//  Отвечает за:
//    - раздачу статических файлов фронтенда (папка public)
//    - подбор собеседников для голосового и текстового чата по фильтрам
//    - управление групповыми комнатами (создание, вход по коду, поиск)
//    - подсчёт онлайн-пользователей
//    - ретрансляцию сигналов WebRTC (SDP / ICE) между участниками
//  Все комнаты и пользователи хранятся В ПАМЯТИ сервера (подходит для MVP).
// ============================================================================

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const db = require('./db');           // слой базы данных (SQLite)
const admin = require('./admin');     // маршруты и логика админ-панели

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Лимит тела запроса поднят до 8 МБ: фото в чате приходят как base64 (data-URL)
app.use(express.json({ limit: '8mb' }));

// Раздаём статику (index.html, styles.css, app.js) из папки public
app.use(express.static(path.join(__dirname, 'public')));

// Папка для загруженных фото (создаём при старте, если ещё нет)
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch (e) {}

// --- Загрузка фото в чат: принимаем base64, пишем файл, возвращаем URL ---
// Без сторонних зависимостей (multer не нужен) — важно для деплоя в РФ.
app.post('/api/upload', (req, res) => {
  try {
    const data = String((req.body && req.body.image) || '');
    const m = data.match(/^data:image\/(png|jpe?g|gif|webp);base64,([\s\S]+)$/);
    if (!m) return res.status(400).json({ ok: false, error: 'Неверный формат изображения' });
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 7 * 1024 * 1024) return res.status(413).json({ ok: false, error: 'Файл слишком большой' });
    const name = 'img-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
    res.json({ ok: true, url: '/uploads/' + name });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'Не удалось сохранить фото' });
  }
});


// Раздаём FontAwesome со своего сервера (иконки без внешних CDN,
// чтобы сайт открывался в РФ без VPN)
app.use('/fa', express.static(path.join(__dirname, 'node_modules/@fortawesome/fontawesome-free')));

// Разрыв всех сессий пользователя по его UUID (используется при бане из админки)
function kickUser(uuid) {
  for (const [, sock] of io.sockets.sockets) {
    if (sock.data && sock.data.uuid === uuid) {
      sock.emit('banned');
      sock.disconnect(true);
    }
  }
}

// Подключаем API и статику админ-панели (роль admin/superAdmin, защита JWT)
admin.mount(app, io, { kickUser });

// Конфигурация ICE для WebRTC. STUN бесплатный; TURN нужен для звонков между
// разными сетями (за NAT). TURN задаётся в .env — без него голос может не пройти
// у части пользователей. Пример: TURN_URL=turn:host:3478 TURN_USER=... TURN_PASS=...
app.get('/rtc-config', (req, res) => {
  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // Публичный бесплатный TURN (Open Relay) — чтобы голос проходил между
    // разными сетями/операторами. Для нагрузки поставьте свой TURN в .env.
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ];
  // Свой TURN из .env (приоритетнее, если задан)
  if (process.env.TURN_URL) {
    iceServers.unshift({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USER || '',
      credential: process.env.TURN_PASS || '',
    });
  }
  res.json({ iceServers });
});

// Тарифы подписок (цены в рублях) — общий источник правды для сервера
const PLANS = { free: 0, plus: 199, max: 399 };

// ВРЕМЕННО: все премиум-функции открыты всем (оплата отключена, тарифы = «Soon»).
// Чтобы включить платный доступ обратно — поставьте OPEN_ALL = false.
const OPEN_ALL = true;
function premAccess(u) {
  return OPEN_ALL || (u && u.subscription && u.subscription !== 'free');
}

// ============================================================================
//  ХРАНИЛИЩА В ПАМЯТИ
// ============================================================================

// users: socket.id -> объект с данными пользователя
//   { gender, age, city, filterGender, filterAge, mode, partnerId, groupCode }
//   mode: null | 'voice' | 'text' | 'group'
const users = new Map();

// Очереди ожидания подбора собеседника (хранят socket.id)
const voiceQueue = []; // ждут голосового собеседника
const textQueue = [];  // ждут текстового собеседника
const videoQueue = []; // ждут видео-собеседника

// groups: code -> объект групповой комнаты
//   { code, name, open, max, members: Set<socket.id> }
const groups = new Map();

// Наборы активных участников по режимам — нужны для онлайн-счётчиков
const voiceActive = new Set(); // кто сейчас ищет или разговаривает голосом
const textActive = new Set();  // кто сейчас ищет или переписывается
const videoActive = new Set(); // кто сейчас ищет или разговаривает по видео

// ============================================================================
//  ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================================================

// Случайный элемент массива
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Генерация уникального кода группы из 6 БУКВ (без похожих I/O)
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // только буквы, без I и O
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += pick(chars.split(''));
  } while (groups.has(code)); // гарантируем уникальность
  return code;
}

// Множественный выбор пола: фильтр — массив вроде ['female'] или ['any'].
// Пустой массив или наличие 'any' означает «пол не важен».
function genderMatches(filters, gender) {
  if (!filters || filters.length === 0 || filters.includes('any')) return true;
  return filters.includes(gender);
}

// Множественный выбор возраста: фильтр — массив вроде ['18-24','25-32'].
// Пустой массив означает «возраст не важен».
function ageMatches(filters, age) {
  if (!filters || filters.length === 0) return true;
  return filters.includes(age);
}

// Точный возраст-число из корзины (запасной вариант, если профиль не заполнен)
function bucketToNum(bucket) {
  if (bucket === '25-32') return 25;
  if (bucket === '33') return 33;
  return 18;
}

// Число-возраст → корзина для подбора
function numToBucket(age) {
  const n = parseInt(age, 10) || 18;
  if (n >= 33) return '33';
  if (n >= 25) return '25-32';
  return '18-24';
}

// Заблокировали ли пользователи друг друга (проверка в обе стороны)
function blockedEachOther(a, b, aId, bId) {
  return a.blocked.has(bId) || b.blocked.has(aId);
}

// Премиум-фильтр по знаку зодиака (односторонний: фильтр «a» к знаку «b»)
function zodiacMatches(filter, zodiac) {
  if (!filter || filter === 'any') return true;
  return filter === zodiac;
}
// Премиум-фильтр по интересам: если у кого-то задан — нужно хотя бы одно совпадение
function interestsMatch(a, b) {
  const fa = a.filterInterests || [], fb = b.filterInterests || [];
  if (fa.length === 0 && fb.length === 0) return true;
  const bi = b.interests || [], ai = a.interests || [];
  const okA = fa.length === 0 || fa.some((i) => bi.includes(i));
  const okB = fb.length === 0 || fb.some((i) => ai.includes(i));
  return okA && okB;
}

// Проверка взаимной совместимости двух пользователей.
// Кандидат должен подходить искателю И искатель — кандидату (честный подбор).
// Премиум-фильтры (интересы, зодиак) применяются только если у искателя есть подписка.
function compatible(a, b, aId, bId) {
  if (blockedEachOther(a, b, aId, bId)) return false; // исключаем заблокированных
  const base =
    genderMatches(a.filterGenders, b.gender) &&
    ageMatches(a.filterAges, b.age) &&
    genderMatches(b.filterGenders, a.gender) &&
    ageMatches(b.filterAges, a.age);
  if (!base) return false;
  // Премиум-условия фильтрации (сейчас доступны всем)
  const aPrem = premAccess(a);
  const bPrem = premAccess(b);
  if (aPrem && !zodiacMatches(a.filterZodiac, b.zodiac)) return false;
  if (bPrem && !zodiacMatches(b.filterZodiac, a.zodiac)) return false;
  if ((aPrem || bPrem) && !interestsMatch(a, b)) return false;
  // Подбор по близкому рейтингу: если у ОБОИХ есть оценки — разница ≤ 0.5.
  // Если у кого-то оценок нет — фильтр не применяем (не мешаем новичкам).
  if (a.ratingCount > 0 && b.ratingCount > 0 &&
      Math.abs((a.avgRating || 0) - (b.avgRating || 0)) > 0.5) return false;
  return true;
}

// Публичная «карточка» пользователя — что показываем собеседнику.
// Страна фиксированно «Российская Федерация», возраст — числом.
// В анонимном режиме (премиум) возраст скрыт, ник — временный.
// Для превью до соединения включаем аватар/описание/интересы.
function publicCard(u) {
  // Анонимный ник: «Плюс» — постоянный «Аноним», «Максимум» — временный со сменой
  const anonNick = u.subscription === 'max' ? (u.anonNick || 'Гость') : 'Аноним';
  return {
    nick: u.anon ? anonNick : (u.nick || ''),
    country: 'Российская Федерация',
    gender: u.gender,
    age: u.anon ? null : (u.ageExact || bucketToNum(u.age)),
    premium: u.subscription && u.subscription !== 'free',
    avatar: u.anon ? '' : (u.avatar || ''),
    description: u.anon ? '' : (u.description || ''),
    interests: u.anon ? [] : (u.interests || []),
    zodiac: u.anon ? '' : (u.zodiac || ''),
    profession: u.anon ? '' : (u.profession || ''),
    height: u.anon ? 0 : (u.height || 0),
    level: u.level || 1,   // уровень собеседника (показывается рядом с ником)
  };
}

// Разослать всем актуальные счётчики «в поиске» — сколько людей прямо сейчас
// ждут собеседника (в очереди) по каждому типу чата. Обновляется в реальном
// времени при любом изменении очередей.
function broadcastCounts() {
  // Общее число онлайн — по числу подключённых пользователей (кроме «невидимок»).
  // users содержит по записи на каждый активный сокет (добавляется при connect,
  // удаляется при disconnect) — это надёжнее, чем engine.clientsCount.
  let online = 0;
  for (const u of users.values()) if (!u.invisible) online++;
  io.emit('counts', { online });
}

// Убрать socket.id из очереди (если он там есть)
function removeFromQueue(queue, id) {
  const idx = queue.indexOf(id);
  if (idx !== -1) queue.splice(idx, 1);
}

// ============================================================================
//  ЛОГИКА ПОДБОРА СОБЕСЕДНИКА (1 на 1) — общая для голоса и текста
// ============================================================================

// mode = 'voice' | 'text' | 'video'
function tryMatch(socket, mode) {
  const me = users.get(socket.id);
  const queue = mode === 'voice' ? voiceQueue : (mode === 'video' ? videoQueue : textQueue);

  // Ищем в очереди первого совместимого кандидата
  for (let i = 0; i < queue.length; i++) {
    const candidateId = queue[i];
    const candidate = users.get(candidateId);
    if (!candidate) { queue.splice(i, 1); i--; continue; } // отвалившийся — чистим
    if (compatible(me, candidate, socket.id, candidateId)) {
      // Нашли пару — убираем кандидата из очереди
      queue.splice(i, 1);

      // Связываем пользователей друг с другом
      me.partnerId = candidateId;
      candidate.partnerId = socket.id;

      // Для голоса нужен инициатор WebRTC-соединения.
      // Инициатором делаем того, кто пришёл раньше (кандидат из очереди).
      io.to(candidateId).emit(mode + ':matched', {
        peerId: socket.id,
        initiator: true, // кандидат создаёт offer
        partner: publicCard(me),
      });
      socket.emit(mode + ':matched', {
        peerId: candidateId,
        initiator: false, // новый пользователь ждёт offer
        partner: publicCard(candidate),
      });
      broadcastCounts(); // очередь уменьшилась
      return true;
    }
  }

  // Совместимого нет — встаём в очередь.
  // Приоритетный поиск (премиум): платные тарифы встают в НАЧАЛО очереди,
  // поэтому их находят быстрее следующие искатели.
  if (premAccess(me)) queue.unshift(socket.id);
  else queue.push(socket.id);
  socket.emit(mode + ':searching');
  socket.emit(mode + ':none'); // фронт покажет «Собеседников пока нет», но поиск продолжается
  broadcastCounts(); // очередь пополнилась
  return false;
}

// Завершение диалога 1-на-1: разрываем связь и уведомляем собеседника
function endOneToOne(socket) {
  const me = users.get(socket.id);
  if (!me) return;
  const partnerId = me.partnerId;
  me.partnerId = null;
  if (partnerId) {
    const partner = users.get(partnerId);
    if (partner) partner.partnerId = null;
    // Запоминаем uuid собеседника у обеих сторон — чтобы можно было оценить
    // друг друга после разговора (клиент не знает чужой uuid — резолвим тут).
    if (partner && partner.uuid) me.lastPartnerUuid = partner.uuid;
    if (partner) partner.lastPartnerUuid = me.uuid;
    io.to(partnerId).emit('peer:left'); // собеседник вернётся в режим поиска
  }
}

// ============================================================================
//  ОБРАБОТКА ПОДКЛЮЧЕНИЙ
// ============================================================================

io.on('connection', (socket) => {
  // Постоянный анонимный идентификатор пользователя приходит с клиента (localStorage).
  // По нему загружаем/создаём запись в БД — так профиль, подписка и роль сохраняются.
  const uuid = String(socket.handshake.auth?.uuid || '').slice(0, 64) || 'anon-' + socket.id;
  socket.data.uuid = uuid;
  // Загрузка из БД защищена: даже если БД недоступна, соединение и все
  // обработчики событий всё равно регистрируются, и чат/группы работают.
  let record = {};
  try { record = db.getOrCreateUser(uuid) || {}; } catch (e) { record = {}; }

  // Забаненных сразу отключаем
  if (record.isBanned) {
    socket.emit('banned');
    socket.disconnect(true);
    return;
  }
  try { db.addActivity(uuid, 'login', ''); } catch (e) {}

  // Данные пользователя в памяти (для быстрого подбора) + постоянные поля из БД
  users.set(socket.id, {
    uuid,
    gender: record.gender || pick(['female', 'male']),
    age: numToBucket(record.age),    // корзина возраста для подбора
    ageExact: record.age || null,    // точный возраст (число) из профиля
    nick: record.nick || '',
    city: record.city || 'Москва',
    subscription: (() => { try { return db.activePlan(record) || 'free'; } catch (e) { return 'free'; } })(),
    role: record.role || 'user',
    anon: false,                     // режим «анонимно» (премиум) — включается клиентом
    // Премиум-поля профиля (для превью и фильтров)
    avatar: record.avatar || '',
    description: record.description || '',
    interests: (record.interests || '').split(',').map((s) => s.trim()).filter(Boolean),
    zodiac: record.zodiac || '',
    profession: record.profession || '',
    height: record.height || 0,
    level: record.level || 1,        // уровень (система очков)
    // Средний рейтинг (для подбора по близкому рейтингу ±0.5)
    avgRating: (() => { try { return db.getAvgRating(uuid).avg; } catch (e) { return 0; } })(),
    ratingCount: (() => { try { return db.getAvgRating(uuid).count; } catch (e) { return 0; } })(),
    filterGenders: ['any'],
    filterAges: ['18-24'],
    filterInterests: [],             // премиум-фильтр по интересам
    filterZodiac: 'any',             // премиум-фильтр по знаку зодиака
    blocked: new Set(),
    mode: null,
    partnerId: null,
    lastPartnerUuid: null,           // кого можно оценить после разговора
    groupCode: null,
  });

  broadcastCounts();
  // Сообщаем клиенту его текущую подписку и роль
  socket.emit('me', { subscription: users.get(socket.id).subscription, role: users.get(socket.id).role });
  // Отправляем текущую статистику/уровень пользователя
  try { socket.emit('stat:me', db.getUserStats(uuid)); } catch (e) {}

  // Профиль пользователя (из настроек): свой пол, возраст, ник + премиум-поля.
  socket.on('profile', (data) => {
    const me = users.get(socket.id);
    if (!me) return;
    if (data.gender === 'male' || data.gender === 'female') me.gender = data.gender;
    if (['18-24', '25-32', '33'].includes(data.age)) me.age = data.age;
    if (data.ageNum) me.ageExact = Math.max(18, Math.min(99, parseInt(data.ageNum, 10) || 18));
    if (typeof data.nick === 'string') me.nick = data.nick.slice(0, 20);
    if (typeof data.city === 'string' && data.city.trim()) me.city = data.city.trim().slice(0, 40);
    // Сохраняем профиль в БД (премиум-поля сейчас доступны всем)
    const prem = premAccess(me);
    if (prem) {
      me.avatar = data.avatar || me.avatar;
      me.description = (data.description || '').slice(0, 300);
      me.interests = Array.isArray(data.interests) ? data.interests.slice(0, 10)
        : String(data.interests || '').split(',').map((s) => s.trim()).filter(Boolean);
      me.zodiac = data.zodiac || '';
      me.profession = (data.profession || '').slice(0, 40);
      me.height = parseInt(data.height, 10) || 0;
    }
    db.saveProfile(uuid, {
      nick: me.nick, gender: me.gender, age: me.ageExact || 18, city: me.city,
      avatar: prem ? me.avatar : '',
      description: prem ? me.description : '',
      theme: prem ? (data.theme || 'default') : 'default',
      interests: prem ? me.interests.join(',') : '',
      zodiac: prem ? me.zodiac : '',
      profession: prem ? me.profession : '',
      height: prem ? me.height : 0,
    });
  });

  // ---------- ПОДПИСКА (демо-оплата) ----------

  // Клиент запрашивает свою текущую подписку
  socket.on('sub:get', (ack) => {
    const me = users.get(socket.id);
    if (typeof ack === 'function') ack({ subscription: me ? me.subscription : 'free' });
  });

  // Демо-оплата тарифа: в боевом режиме здесь создаётся платёж ЮKassa и права
  // выдаются только после webhook об успешной оплате. Сейчас — эмуляция успеха.
  socket.on('sub:buy', (data, ack) => {
    const me = users.get(socket.id);
    if (!me) return;
    const plan = data && data.plan;
    if (!['free', 'plus', 'max'].includes(plan)) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Неизвестный тариф' });
      return;
    }
    // TODO(боевой режим): создать платёж через ЮKassa, дождаться webhook.
    db.setSubscription(uuid, plan, 30);
    me.subscription = plan;
    db.addActivity(uuid, 'subscription', plan);
    socket.emit('me', { subscription: me.subscription, role: me.role });
    if (typeof ack === 'function') ack({ ok: true, plan, price: PLANS[plan] });
  });

  // Включение/выключение премиум-режима «анонимно» (скрывает город и возраст)
  socket.on('anon:set', (on) => {
    const me = users.get(socket.id);
    if (!me) return;
    me.anon = !!on && premAccess(me); // сейчас доступно всем
    // «Максимум»: временный ник, который меняется не реже раза в 24 ч
    if (me.anon && me.subscription === 'max') {
      const stale = !me.anonNickTime || (Date.now() - me.anonNickTime > 24 * 60 * 60 * 1000);
      if (stale) {
        me.anonNick = 'Гость' + Math.floor(1000 + Math.random() * 9000);
        me.anonNickTime = Date.now();
      }
    }
  });

  // Режим «Невидимка» (премиум): скрывает пользователя из онлайн-счётчиков
  socket.on('invisible:set', (on) => {
    const me = users.get(socket.id);
    if (!me) return;
    me.invisible = !!on && premAccess(me);
    broadcastCounts();
  });

  // ---------- ЖАЛОБА И БЛОКИРОВКА ----------

  // Пожаловаться на текущего собеседника: чат немедленно завершается для обоих.
  socket.on('report_user', (data) => {
    const me = users.get(socket.id);
    if (!me || !me.partnerId) return;
    const partner = users.get(me.partnerId);
    // Записываем жалобу в БД (для админ-панели), причина ограничена по длине
    const reason = String((data && data.reason) || '').slice(0, 500);
    db.addReport(me.uuid, partner ? partner.uuid : me.partnerId, reason);
    endOneToOne(socket); // уведомит собеседника событием peer:left
  });

  // Заблокировать собеседника: добавляем в чёрный список и завершаем чат.
  // Пара с этим человеком больше не будет подбираться (проверка в compatible).
  socket.on('block_user', () => {
    const me = users.get(socket.id);
    if (!me || !me.partnerId) return;
    me.blocked.add(me.partnerId);
    console.log(`Блокировка: ${socket.id} заблокировал ${me.partnerId}`);
    endOneToOne(socket);
  });

  // ---------- ГОЛОСОВОЙ ЧАТ (1 на 1) ----------

  // Применить фильтры поиска (базовые + премиум-фильтры для платных)
  function applyFilters(me, filters) {
    // Город в подборе не используется как жёсткий фильтр; пустое значение / «Любой»
    // означает «искать по всем городам». Профильный город фильтром не перетираем.
    me.filterGenders = filters.genders || ['any'];
    me.filterAges = filters.ages || [];
    const prem = premAccess(me);
    me.filterInterests = prem && Array.isArray(filters.interests) ? filters.interests.slice(0, 10) : [];
    me.filterZodiac = prem ? (filters.zodiac || 'any') : 'any';
  }

  socket.on('voice:start', (filters) => {
    const me = users.get(socket.id);
    if (!me) return;
    applyFilters(me, filters);
    me.mode = 'voice';
    voiceActive.add(socket.id);
    broadcastCounts();
    tryMatch(socket, 'voice');
  });

  socket.on('voice:stop', () => {
    removeFromQueue(voiceQueue, socket.id);
    endOneToOne(socket);
    voiceActive.delete(socket.id);
    const me = users.get(socket.id);
    if (me) me.mode = null;
    broadcastCounts();
  });

  // ---------- ВИДЕОЧАТ (1 на 1) — тот же подбор, но с видео ----------
  socket.on('video:start', (filters) => {
    const me = users.get(socket.id);
    if (!me) return;
    applyFilters(me, filters);
    me.mode = 'video';
    videoActive.add(socket.id);
    broadcastCounts();
    tryMatch(socket, 'video');
  });

  socket.on('video:stop', () => {
    removeFromQueue(videoQueue, socket.id);
    endOneToOne(socket);
    videoActive.delete(socket.id);
    const me = users.get(socket.id);
    if (me) me.mode = null;
    broadcastCounts();
  });

  // ---------- ТЕКСТОВЫЙ ЧАТ (1 на 1) ----------

  socket.on('text:start', (filters) => {
    const me = users.get(socket.id);
    if (!me) return;
    applyFilters(me, filters);
    me.mode = 'text';
    textActive.add(socket.id);
    broadcastCounts();
    tryMatch(socket, 'text');
  });

  socket.on('text:stop', () => {
    removeFromQueue(textQueue, socket.id);
    endOneToOne(socket);
    textActive.delete(socket.id);
    const me = users.get(socket.id);
    if (me) me.mode = null;
    broadcastCounts();
  });

  // Текстовое сообщение собеседнику 1-на-1 (может нести фото и id для реакций)
  socket.on('text:message', (payload) => {
    const me = users.get(socket.id);
    if (!me || !me.partnerId) return;
    const text = String(payload.text || '').slice(0, 2000);
    const id = String(payload.id || '').slice(0, 64);           // общий id сообщения (для реакций)
    const image = /^\/uploads\/[\w.-]+$/.test(String(payload.image || '')) ? payload.image : ''; // только наш URL
    const partner = users.get(me.partnerId);
    io.to(me.partnerId).emit('text:message', { from: 'peer', text, id, image });
    // История переписки: сохраняем у обоих (сейчас доступно всем)
    const stored = image ? (text ? text + ' [фото]' : '[фото]') : text;
    if (premAccess(me)) {
      db.addMessage(me.uuid, partner ? partner.uuid : me.partnerId, partner ? partner.nick : '', 'text', 'out', stored);
    }
    if (partner && premAccess(partner)) {
      db.addMessage(partner.uuid, me.uuid, me.nick, 'text', 'in', stored);
    }
  });

  // Реакция на сообщение (лайк/смайлик) — сохраняем в БД и шлём собеседнику
  socket.on('text:reaction', (payload) => {
    const me = users.get(socket.id);
    if (!me || !me.partnerId) return;
    const msgId = String((payload && payload.msgId) || '').slice(0, 64);
    const emoji = String((payload && payload.emoji) || '').slice(0, 16);
    if (!msgId || !emoji) return;
    try { db.addReaction(me.uuid, msgId, emoji); } catch (e) {}
    io.to(me.partnerId).emit('text:reaction', { msgId, emoji, from: 'peer' });
  });

  // Поделиться выбранной темой разговора с собеседником / группой
  socket.on('topic:share', (payload) => {
    const me = users.get(socket.id);
    if (!me) return;
    const topic = String((payload && payload.topic) || '').slice(0, 200);
    if (!topic) return;
    if (me.partnerId) io.to(me.partnerId).emit('topic:share', { topic });
    else if (me.groupCode) socket.to(me.groupCode).emit('topic:share', { topic });
  });

  // Зафиксировать завершённый разговор (для статистики и уровней)
  socket.on('stat:call', (payload) => {
    const me = users.get(socket.id);
    if (!me) return;
    const dur = Math.max(0, Math.min(24 * 3600, parseInt(payload && payload.duration, 10) || 0));
    try {
      // Активность пишем ДО начисления, чтобы прогресс дневных челленджей учёл этот звонок
      db.addActivity(me.uuid, 'call', String(dur) + 's');
      const st = db.recordConversation(me.uuid, dur);
      if (st) { me.level = st.level; socket.emit('stat:me', st); }
      // Проверяем новые достижения и уведомляем клиента
      const newly = db.checkAchievements(me.uuid);
      if (newly && newly.length) newly.forEach((a) => socket.emit('achievement:unlocked', { name: a.name, icon: a.icon }));
    } catch (e) {}
  });

  // Оценка собеседника (1–5 звёзд) после разговора. Клиент не знает чужой uuid —
  // ставим оценку последнему партнёру, запомненному сервером в endOneToOne.
  socket.on('rate', (payload) => {
    const me = users.get(socket.id);
    if (!me || !me.lastPartnerUuid) return;
    const r = parseInt(payload && payload.rating, 10);
    if (!(r >= 1 && r <= 5)) return;
    try { db.addRating(me.uuid, me.lastPartnerUuid, r); } catch (e) {}
    me.lastPartnerUuid = null; // одна оценка за один разговор
  });

  // Запрос своей статистики (короткая версия, для бейджа уровня)
  socket.on('stat:get', (ack) => {
    const me = users.get(socket.id);
    if (typeof ack !== 'function') return;
    try { ack(db.getUserStats(me ? me.uuid : '')); } catch (e) { ack({ convCount: 0, totalDuration: 0, points: 0, xp: 0, level: 1 }); }
  });

  // Полная статистика для вкладки «Статистика» (уровень, XP, ачивки, челленджи, топ)
  socket.on('stats:get', (ack) => {
    const me = users.get(socket.id);
    if (typeof ack !== 'function') return;
    try { ack(db.getFullStats(me ? me.uuid : '')); }
    catch (e) { ack({ stats: { totalMinutes: 0, totalCalls: 0, xp: 0, level: 1, curLevelXp: 0, nextLevelXp: 50, toNext: 50 }, achievements: [], challenges: [], leaderboard: [] }); }
  });

  // Забрать бонус за выполненный дневной челлендж
  socket.on('challenge:claim', (payload, ack) => {
    const me = users.get(socket.id);
    if (typeof ack !== 'function') return;
    if (!me) return ack({ ok: false, error: 'Нет сессии' });
    try {
      const res = db.claimChallenge(me.uuid, String(payload && payload.kind || ''));
      if (res.ok) { me.level = res.level; socket.emit('stat:me', db.getUserStats(me.uuid)); }
      ack(res);
    } catch (e) { ack({ ok: false, error: 'Ошибка' }); }
  });

  // Подарок собеседнику (премиум): отправляем стикер/анимацию
  socket.on('gift:send', (payload) => {
    const me = users.get(socket.id);
    if (!me || !me.partnerId) return;
    if (!premAccess(me)) return; // подарки (сейчас доступны всем)
    const gift = String(payload.gift || '').slice(0, 8);
    io.to(me.partnerId).emit('gift:recv', { gift, from: me.nick || 'Собеседник' });
  });

  // Запрос истории переписки (премиум)
  socket.on('history:get', (ack) => {
    const me = users.get(socket.id);
    if (typeof ack !== 'function') return;
    if (!me || !premAccess(me)) return ack({ ok: false, messages: [] });
    let messages = db.getMessages(me.uuid);
    // Ограничение 7 дней действует только для платного «Плюс» (сейчас всё открыто)
    if (!OPEN_ALL && me.subscription === 'plus') {
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      messages = messages.filter((m) => m.createdAt >= weekAgo);
    }
    ack({ ok: true, plan: me.subscription, messages });
  });

  // ---------- ГРУППОВОЙ ЧАТ ----------

  // Создание новой группы
  socket.on('group:create', (data, ack) => {
    const me = users.get(socket.id);
    const code = generateCode();
    // Лимит участников: сейчас всем 50 (при платном режиме — free 5, plus 15, max 50)
    const planCap = OPEN_ALL ? 50 : (me && me.subscription === 'max' ? 50 : (me && me.subscription === 'plus' ? 15 : 5));
    const group = {
      code,
      name: (data.name || 'Без названия').slice(0, 60),
      open: data.open !== false,                 // по умолчанию открыта
      max: Math.min(Math.max(parseInt(data.max, 10) || 4, 1), planCap),
      gender: ['any', 'female', 'male'].includes(data.gender) ? data.gender : 'any', // пол участников
      ownerId: socket.id,                        // владелец (может модерировать)
      ownerUuid: me ? me.uuid : null,
      muted: new Set(),                          // socket.id заглушённых владельцем
      banned: new Set(),                         // uuid забаненных в этой группе
      members: new Set(),
    };
    groups.set(code, group);
    if (me) db.addActivity(me.uuid, 'group_create', code);
    broadcastCounts();
    // Возвращаем код клиенту (через callback-подтверждение Socket.IO)
    if (typeof ack === 'function') ack({ ok: true, code });
    socket.emit('group:created', { code });
  });

  // Вход в группу по коду (используется и «Присоединиться», и «Создать звонок»)
  socket.on('group:join', (data, ack) => {
    const code = String(data.code || '').toUpperCase();
    const group = groups.get(code);
    if (!group) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Комната не найдена' });
      return;
    }
    if (group.members.size >= group.max) {
      if (typeof ack === 'function') ack({ ok: false, error: 'В комнате нет свободных мест' });
      return;
    }
    const me = users.get(socket.id);
    if (me && group.banned.has(me.uuid)) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Вы забанены в этой комнате' });
      return;
    }

    joinGroup(socket, group);
    if (typeof ack === 'function') ack({ ok: true, code });
  });

  // Автоподбор случайной открытой группы со свободными местами
  socket.on('group:find', (data, ack) => {
    const desiredSize = parseInt(data.size, 10); // фильтр по числу участников (не обяз.)
    const candidates = [];
    for (const group of groups.values()) {
      if (!group.open) continue;                     // только открытые
      if (group.members.size >= group.max) continue; // только со свободными местами
      if (desiredSize && group.max !== desiredSize) continue; // фильтр по вместимости
      candidates.push(group);
    }
    if (candidates.length === 0) {
      if (typeof ack === 'function') ack({ ok: false, error: 'Открытых групп пока нет' });
      return;
    }
    const group = pick(candidates);
    joinGroup(socket, group);
    if (typeof ack === 'function') ack({ ok: true, code: group.code });
  });

  // Выход из групповой комнаты
  socket.on('group:leave', () => leaveGroup(socket));

  // Текстовое сообщение внутри группы
  socket.on('group:message', (payload) => {
    const me = users.get(socket.id);
    if (!me || !me.groupCode) return;
    const group = groups.get(me.groupCode);
    if (!group) return;
    if (group.muted.has(socket.id)) return; // заглушённый писать не может
    // Рассылаем всем участникам группы, кроме отправителя
    socket.to(me.groupCode).emit('group:message', {
      from: socket.id,
      text: String(payload.text || '').slice(0, 2000),
    });
  });

  // ---------- МОДЕРАЦИЯ ГРУППЫ (только владелец) ----------
  // action: 'kick' | 'mute' | 'unmute' | 'ban'; target — socket.id участника
  socket.on('group:moderate', ({ action, target }) => {
    const me = users.get(socket.id);
    if (!me || !me.groupCode) return;
    const group = groups.get(me.groupCode);
    if (!group || group.ownerId !== socket.id) return; // только владелец
    const targetUser = users.get(target);
    if (!targetUser || target === socket.id) return;

    if (action === 'mute') {
      group.muted.add(target);
      io.to(target).emit('group:muted', { muted: true });
    } else if (action === 'unmute') {
      group.muted.delete(target);
      io.to(target).emit('group:muted', { muted: false });
    } else if (action === 'kick' || action === 'ban') {
      if (action === 'ban') group.banned.add(targetUser.uuid);
      const targetSock = io.sockets.sockets.get(target);
      io.to(target).emit('group:kicked', { banned: action === 'ban' });
      if (targetSock) leaveGroup(targetSock);
    }
  });

  // ---------- УНИВЕРСАЛЬНАЯ СИГНАЛИЗАЦИЯ WebRTC ----------
  // Клиент шлёт { to, data }, сервер пересылает адресату { from, data }.
  // Используется и для связи 1-на-1, и для mesh-схемы в группах.
  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  // ---------- ОТКЛЮЧЕНИЕ ----------

  socket.on('disconnect', () => {
    // Чистим очереди и связи
    removeFromQueue(voiceQueue, socket.id);
    removeFromQueue(textQueue, socket.id);
    removeFromQueue(videoQueue, socket.id);
    endOneToOne(socket);
    leaveGroup(socket);
    voiceActive.delete(socket.id);
    textActive.delete(socket.id);
    videoActive.delete(socket.id);
    users.delete(socket.id);
    broadcastCounts();
  });
});

// ============================================================================
//  ГРУППОВЫЕ ХЕЛПЕРЫ (вне обработчиков, т.к. используются в нескольких местах)
// ============================================================================

// Подключить сокет к групповой комнате и сообщить об этом всем
function joinGroup(socket, group) {
  const me = users.get(socket.id);
  if (!me) return;

  // Сначала выходим из предыдущей группы, если были в ней
  leaveGroup(socket);

  socket.join(group.code);          // подписка на комнату Socket.IO
  group.members.add(socket.id);
  me.mode = 'group';
  me.groupCode = group.code;

  // Список уже присутствующих участников (без себя) — с ними новичок соединится
  const others = [...group.members].filter((id) => id !== socket.id).map((id) => {
    const u = users.get(id);
    return { id, nick: u ? (u.nick || 'Участник') : 'Участник' };
  });

  // Новичку — данные комнаты, признак владельца и список участников
  socket.emit('group:joined', {
    code: group.code,
    name: group.name,
    max: group.max,
    isOwner: group.ownerId === socket.id,
    peers: others, // новичок инициирует соединение к каждому из них
  });

  // Остальным — уведомление о новом участнике (они будут ждать от него offer)
  socket.to(group.code).emit('group:peer-joined', { id: socket.id, nick: me.nick || 'Участник' });

  broadcastCounts();
}

// Убрать сокет из его группы и уведомить остальных
function leaveGroup(socket) {
  const me = users.get(socket.id);
  if (!me || !me.groupCode) return;
  const group = groups.get(me.groupCode);
  const code = me.groupCode;
  me.groupCode = null;
  me.mode = null;

  socket.leave(code);
  if (group) {
    group.members.delete(socket.id);
    socket.to(code).emit('group:peer-left', { id: socket.id });
    // Если комната опустела — удаляем её
    if (group.members.size === 0) groups.delete(code);
  }
  broadcastCounts();
}

// ============================================================================
//  ЗАПУСК СЕРВЕРА
// ============================================================================

const PORT = process.env.PORT || 8080;
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});
