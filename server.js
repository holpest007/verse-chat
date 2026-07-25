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
const { Server } = require('socket.io');
const db = require('./db');           // слой базы данных (SQLite)
const admin = require('./admin');     // маршруты и логика админ-панели

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

// Раздаём статику (index.html, styles.css, app.js) из папки public
app.use(express.static(path.join(__dirname, 'public')));

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

// Тарифы подписок (цены в рублях) — общий источник правды для сервера
const PLANS = { free: 0, plus: 199, max: 399 };

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

// groups: code -> объект групповой комнаты
//   { code, name, open, max, members: Set<socket.id> }
const groups = new Map();

// Наборы активных участников по режимам — нужны для онлайн-счётчиков
const voiceActive = new Set(); // кто сейчас ищет или разговаривает голосом
const textActive = new Set();  // кто сейчас ищет или переписывается

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
  // Премиум-условия (учитываем только для платных искателей)
  const aPrem = a.subscription && a.subscription !== 'free';
  const bPrem = b.subscription && b.subscription !== 'free';
  if (aPrem && !zodiacMatches(a.filterZodiac, b.zodiac)) return false;
  if (bPrem && !zodiacMatches(b.filterZodiac, a.zodiac)) return false;
  if ((aPrem || bPrem) && !interestsMatch(a, b)) return false;
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
  };
}

// Разослать всем актуальные счётчики «в поиске» — сколько людей прямо сейчас
// ждут собеседника (в очереди) по каждому типу чата. Обновляется в реальном
// времени при любом изменении очередей.
function broadcastCounts() {
  // «Невидимки» (премиум) не учитываются в счётчиках «в поиске»
  const visible = (queue) => queue.filter((id) => {
    const u = users.get(id);
    return u && !u.invisible;
  }).length;
  io.emit('counts', {
    voice: visible(voiceQueue),
    text: visible(textQueue),
    group: io.engine.clientsCount || 0,
  });
}

// Убрать socket.id из очереди (если он там есть)
function removeFromQueue(queue, id) {
  const idx = queue.indexOf(id);
  if (idx !== -1) queue.splice(idx, 1);
}

// ============================================================================
//  ЛОГИКА ПОДБОРА СОБЕСЕДНИКА (1 на 1) — общая для голоса и текста
// ============================================================================

// mode = 'voice' | 'text'
function tryMatch(socket, mode) {
  const me = users.get(socket.id);
  const queue = mode === 'voice' ? voiceQueue : textQueue;

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
  if (me.subscription && me.subscription !== 'free') queue.unshift(socket.id);
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
  const record = db.getOrCreateUser(uuid);

  // Забаненных сразу отключаем
  if (record.isBanned) {
    socket.emit('banned');
    socket.disconnect(true);
    return;
  }
  db.addActivity(uuid, 'login', '');

  // Данные пользователя в памяти (для быстрого подбора) + постоянные поля из БД
  users.set(socket.id, {
    uuid,
    gender: record.gender || pick(['female', 'male']),
    age: numToBucket(record.age),    // корзина возраста для подбора
    ageExact: record.age || null,    // точный возраст (число) из профиля
    nick: record.nick || '',
    city: record.city || 'Москва',
    subscription: db.activePlan(record), // free | plus | max (с учётом срока)
    role: record.role || 'user',
    anon: false,                     // режим «анонимно» (премиум) — включается клиентом
    // Премиум-поля профиля (для превью и фильтров)
    avatar: record.avatar || '',
    description: record.description || '',
    interests: (record.interests || '').split(',').map((s) => s.trim()).filter(Boolean),
    zodiac: record.zodiac || '',
    profession: record.profession || '',
    height: record.height || 0,
    filterGenders: ['any'],
    filterAges: ['18-24'],
    filterInterests: [],             // премиум-фильтр по интересам
    filterZodiac: 'any',             // премиум-фильтр по знаку зодиака
    blocked: new Set(),
    mode: null,
    partnerId: null,
    groupCode: null,
  });

  broadcastCounts();
  // Сообщаем клиенту его текущую подписку и роль
  socket.emit('me', { subscription: users.get(socket.id).subscription, role: users.get(socket.id).role });

  // Профиль пользователя (из настроек): свой пол, возраст, ник + премиум-поля.
  socket.on('profile', (data) => {
    const me = users.get(socket.id);
    if (!me) return;
    if (data.gender === 'male' || data.gender === 'female') me.gender = data.gender;
    if (['18-24', '25-32', '33'].includes(data.age)) me.age = data.age;
    if (data.ageNum) me.ageExact = Math.max(18, Math.min(99, parseInt(data.ageNum, 10) || 18));
    if (typeof data.nick === 'string') me.nick = data.nick.slice(0, 20);
    // Сохраняем профиль в БД (премиум-поля применяются только при подписке)
    const prem = me.subscription !== 'free';
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
    me.anon = !!on && me.subscription !== 'free'; // только для платных тарифов
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
    me.invisible = !!on && me.subscription !== 'free';
    broadcastCounts();
  });

  // ---------- ЖАЛОБА И БЛОКИРОВКА ----------

  // Пожаловаться на текущего собеседника: чат немедленно завершается для обоих.
  socket.on('report_user', (data) => {
    const me = users.get(socket.id);
    if (!me || !me.partnerId) return;
    const partner = users.get(me.partnerId);
    // Записываем жалобу в БД (для админ-панели)
    db.addReport(me.uuid, partner ? partner.uuid : me.partnerId, (data && data.reason) || '');
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
    me.city = filters.city || me.city;
    me.filterGenders = filters.genders || ['any'];
    me.filterAges = filters.ages || [];
    const prem = me.subscription && me.subscription !== 'free';
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

  // Текстовое сообщение собеседнику 1-на-1
  socket.on('text:message', (payload) => {
    const me = users.get(socket.id);
    if (!me || !me.partnerId) return;
    const text = String(payload.text || '').slice(0, 2000);
    const partner = users.get(me.partnerId);
    io.to(me.partnerId).emit('text:message', { from: 'peer', text });
    // История переписки (премиум): сохраняем у обоих, если у них есть подписка
    if (me.subscription !== 'free') {
      db.addMessage(me.uuid, partner ? partner.uuid : me.partnerId, partner ? partner.nick : '', 'text', 'out', text);
    }
    if (partner && partner.subscription !== 'free') {
      db.addMessage(partner.uuid, me.uuid, me.nick, 'text', 'in', text);
    }
  });

  // Подарок собеседнику (премиум): отправляем стикер/анимацию
  socket.on('gift:send', (payload) => {
    const me = users.get(socket.id);
    if (!me || !me.partnerId) return;
    if (me.subscription === 'free') return; // подарки — премиум
    const gift = String(payload.gift || '').slice(0, 8);
    io.to(me.partnerId).emit('gift:recv', { gift, from: me.nick || 'Собеседник' });
  });

  // Запрос истории переписки (премиум)
  socket.on('history:get', (ack) => {
    const me = users.get(socket.id);
    if (typeof ack !== 'function') return;
    if (!me || me.subscription === 'free') return ack({ ok: false, messages: [] });
    let messages = db.getMessages(me.uuid);
    // Тариф «Плюс» — история только за 7 дней; «Максимум» — вся
    if (me.subscription === 'plus') {
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
    // Лимит участников зависит от подписки: free — 5, plus — 15, max — 50
    const planCap = me && me.subscription === 'max' ? 50 : (me && me.subscription === 'plus' ? 15 : 5);
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
    endOneToOne(socket);
    leaveGroup(socket);
    voiceActive.delete(socket.id);
    textActive.delete(socket.id);
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});
