// ============================================================================
//  db.js — слой базы данных (встроенный SQLite Node.js — node:sqlite)
//  Хранит пользователей, жалобы, логи действий администраторов и активности.
//  Данные сохраняются в файл data.db и переживают перезапуск сервера.
//  Используем встроенный модуль node:sqlite (не требует нативной сборки).
// ============================================================================

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// Файл БД лежит рядом с сервером
const db = new DatabaseSync(path.join(__dirname, 'data.db'));
db.exec('PRAGMA journal_mode = WAL'); // быстрее и надёжнее при параллельных записях

// ----------------------------------------------------------------------------
//  СОЗДАНИЕ ТАБЛИЦ (если ещё не созданы)
// ----------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id             TEXT PRIMARY KEY,           -- анонимный UUID пользователя
    nick           TEXT DEFAULT '',
    gender         TEXT DEFAULT 'male',        -- male | female
    age            INTEGER DEFAULT 18,
    city           TEXT DEFAULT 'Москва',
    subscription   TEXT DEFAULT 'free',        -- free | plus | max
    subscriptionExpiry INTEGER,                -- метка времени окончания (ms) или NULL
    role           TEXT DEFAULT 'user',        -- user | admin | superAdmin
    isBanned       INTEGER DEFAULT 0,          -- 0 | 1
    avatar         TEXT DEFAULT '',            -- data-URL аватарки (премиум)
    description    TEXT DEFAULT '',            -- описание профиля (премиум)
    theme          TEXT DEFAULT 'default',     -- тема оформления (премиум)
    interests      TEXT DEFAULT '',            -- интересы через запятую (премиум)
    zodiac         TEXT DEFAULT '',            -- знак зодиака (премиум)
    profession     TEXT DEFAULT '',            -- профессия (премиум)
    height         INTEGER DEFAULT 0,          -- рост в см (премиум)
    createdAt      INTEGER,                    -- дата регистрации (ms)
    lastSeen       INTEGER                     -- последняя активность (ms)
  );

  -- История сообщений (для премиум-истории переписки)
  CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    userId    TEXT,                            -- владелец записи (чью историю)
    peerId    TEXT,                            -- собеседник или код группы
    peerNick  TEXT DEFAULT '',
    scope     TEXT,                            -- 'text' | 'group'
    dir       TEXT,                            -- 'in' | 'out'
    text      TEXT,
    createdAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS reports (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    reporterId TEXT,                           -- кто пожаловался
    targetId   TEXT,                           -- на кого
    reason     TEXT DEFAULT '',
    createdAt  INTEGER,
    handled    INTEGER DEFAULT 0               -- обработана ли жалоба
  );

  CREATE TABLE IF NOT EXISTS admin_logs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    adminId   TEXT,                            -- какой админ выполнил действие
    action    TEXT,                            -- что сделал (ban, unban, add_admin...)
    targetId  TEXT,                            -- над кем
    createdAt INTEGER
  );

  CREATE TABLE IF NOT EXISTS activity_logs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    userId    TEXT,
    type      TEXT,                            -- login | call | group_create ...
    info      TEXT DEFAULT '',                 -- доп. данные (например длительность)
    createdAt INTEGER
  );

  -- Реакции на сообщения (лайки/смайлики) в текстовом чате
  CREATE TABLE IF NOT EXISTS reactions (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    userId    TEXT,                            -- кто поставил реакцию
    msgId     TEXT,                            -- клиентский id сообщения (общий у пары)
    emoji     TEXT,                            -- сама реакция (эмодзи)
    createdAt INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_reactions_msg ON reactions(msgId);
`);

// Миграция: добавляем новые колонки в уже существующую базу (без потери данных)
for (const col of [
  "zodiac TEXT DEFAULT ''",
  "profession TEXT DEFAULT ''",
  "height INTEGER DEFAULT 0",
  "convCount INTEGER DEFAULT 0",     // сколько разговоров провёл (статистика/уровни)
  "totalDuration INTEGER DEFAULT 0", // суммарная длительность разговоров, сек
  "points INTEGER DEFAULT 0",        // очки для системы уровней
  "level INTEGER DEFAULT 1",         // текущий уровень (1..10+)
]) {
  try { db.exec('ALTER TABLE users ADD COLUMN ' + col); } catch (e) { /* колонка уже есть */ }
}

// ----------------------------------------------------------------------------
//  ПОДГОТОВЛЕННЫЕ ЗАПРОСЫ
// ----------------------------------------------------------------------------
const stmts = {
  getUser: db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByNick: db.prepare('SELECT * FROM users WHERE nick = ? COLLATE NOCASE'),
  insertUser: db.prepare(`INSERT INTO users (id, createdAt, lastSeen) VALUES (?, ?, ?)`),
  allUsers: db.prepare('SELECT * FROM users ORDER BY createdAt DESC'),
  countUsers: db.prepare('SELECT COUNT(*) AS n FROM users'),
  countSubs: db.prepare(`SELECT subscription, COUNT(*) AS n FROM users GROUP BY subscription`),
  setBan: db.prepare('UPDATE users SET isBanned = ? WHERE id = ?'),
  setRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
  setSubscription: db.prepare('UPDATE users SET subscription = ?, subscriptionExpiry = ? WHERE id = ?'),
  updateProfile: db.prepare(
    `UPDATE users SET nick = ?, gender = ?, age = ?, city = ?, avatar = ?, description = ?, theme = ?, interests = ?, zodiac = ?, profession = ?, height = ?, lastSeen = ? WHERE id = ?`
  ),
  touch: db.prepare('UPDATE users SET lastSeen = ? WHERE id = ?'),

  insertMessage: db.prepare(
    `INSERT INTO messages (userId, peerId, peerNick, scope, dir, text, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ),
  messagesFor: db.prepare('SELECT * FROM messages WHERE userId = ? ORDER BY createdAt DESC LIMIT 500'),
  deleteOldMessages: db.prepare('DELETE FROM messages WHERE createdAt < ?'),

  insertReport: db.prepare(
    `INSERT INTO reports (reporterId, targetId, reason, createdAt, handled) VALUES (?, ?, ?, ?, 0)`
  ),
  allReports: db.prepare('SELECT * FROM reports ORDER BY createdAt DESC LIMIT 200'),
  countReports: db.prepare('SELECT COUNT(*) AS n FROM reports WHERE handled = 0'),
  setReportHandled: db.prepare('UPDATE reports SET handled = 1 WHERE id = ?'),

  insertAdminLog: db.prepare(
    `INSERT INTO admin_logs (adminId, action, targetId, createdAt) VALUES (?, ?, ?, ?)`
  ),
  allAdminLogs: db.prepare('SELECT * FROM admin_logs ORDER BY createdAt DESC LIMIT 200'),

  insertActivity: db.prepare(
    `INSERT INTO activity_logs (userId, type, info, createdAt) VALUES (?, ?, ?, ?)`
  ),
  allActivity: db.prepare('SELECT * FROM activity_logs ORDER BY createdAt DESC LIMIT 200'),

  // --- Статистика пользователя и уровни ---
  bumpStats: db.prepare(
    `UPDATE users SET convCount = convCount + 1, totalDuration = totalDuration + ?,
       points = points + ?, level = ? WHERE id = ?`
  ),

  // --- Реакции на сообщения ---
  insertReaction: db.prepare(
    `INSERT INTO reactions (userId, msgId, emoji, createdAt) VALUES (?, ?, ?, ?)`
  ),
  reactionsByMsg: db.prepare('SELECT userId, emoji, createdAt FROM reactions WHERE msgId = ? ORDER BY createdAt'),

  // --- Аналитика (админка) ---
  // Уникальные пользователи с login-активностью за период (since — метка времени ms)
  uniqueSince: db.prepare(
    `SELECT COUNT(DISTINCT userId) AS n FROM activity_logs WHERE type = 'login' AND createdAt >= ?`
  ),
  // Все login-события за период — по ним считаем пиковые часы
  loginsSince: db.prepare(
    `SELECT createdAt FROM activity_logs WHERE type = 'login' AND createdAt >= ?`
  ),
  // Популярные города (по профилям пользователей)
  topCities: db.prepare(
    `SELECT city, COUNT(*) AS n FROM users WHERE city IS NOT NULL AND city != ''
       GROUP BY city ORDER BY n DESC LIMIT 10`
  ),
};

// ----------------------------------------------------------------------------
//  ПУБЛИЧНЫЕ ФУНКЦИИ
// ----------------------------------------------------------------------------

// Получить пользователя по UUID, создав запись при первом заходе
function getOrCreateUser(id) {
  let user = stmts.getUser.get(id);
  if (!user) {
    const now = Date.now();
    stmts.insertUser.run(id, now, now);
    user = stmts.getUser.get(id);
  }
  return user;
}

function getUser(id) {
  return stmts.getUser.get(id);
}

function getUserByNick(nick) {
  return stmts.getUserByNick.get(nick);
}

// Сохранить профиль пользователя (ник, пол, возраст, город + премиум-поля)
function saveProfile(id, p) {
  stmts.updateProfile.run(
    p.nick || '',
    p.gender || 'male',
    parseInt(p.age, 10) || 18,
    p.city || 'Москва',
    p.avatar || '',
    p.description || '',
    p.theme || 'default',
    p.interests || '',
    p.zodiac || '',
    p.profession || '',
    parseInt(p.height, 10) || 0,
    Date.now(),
    id
  );
  return getUser(id);
}

// --- История сообщений (премиум) ---
function addMessage(userId, peerId, peerNick, scope, dir, text) {
  stmts.insertMessage.run(userId, peerId, peerNick || '', scope, dir, String(text).slice(0, 2000), Date.now());
}
function getMessages(userId) {
  return stmts.messagesFor.all(userId);
}
// Очистка сообщений старше N дней (для тарифа «Плюс» — 7 дней)
function pruneMessages(days) {
  stmts.deleteOldMessages.run(Date.now() - days * 24 * 60 * 60 * 1000);
}

// Обновить подписку (демо-оплата или реальный webhook)
function setSubscription(id, plan, days = 30) {
  const expiry = plan === 'free' ? null : Date.now() + days * 24 * 60 * 60 * 1000;
  stmts.setSubscription.run(plan, expiry, id);
  return getUser(id);
}

// Проверка активности подписки с учётом срока
function activePlan(user) {
  if (!user || user.subscription === 'free') return 'free';
  if (user.subscriptionExpiry && user.subscriptionExpiry < Date.now()) return 'free'; // истекла
  return user.subscription;
}

function banUser(id, banned) { stmts.setBan.run(banned ? 1 : 0, id); }
function setRole(id, role) { stmts.setRole.run(role, id); }
function touch(id) { stmts.touch.run(Date.now(), id); }

function addReport(reporterId, targetId, reason) {
  stmts.insertReport.run(reporterId, targetId, reason || '', Date.now());
}
function addAdminLog(adminId, action, targetId) {
  stmts.insertAdminLog.run(adminId, action, targetId || '', Date.now());
}
function addActivity(userId, type, info) {
  stmts.insertActivity.run(userId, type, info || '', Date.now());
}

// ----------------------------------------------------------------------------
//  СТАТИСТИКА ПОЛЬЗОВАТЕЛЯ И УРОВНИ
// ----------------------------------------------------------------------------
// Уровень зависит от суммы очков. Очки начисляются за разговоры и время в чате.
// Пороги растут: чем выше уровень, тем больше очков нужно для следующего.
function levelForPoints(points) {
  let level = 1;
  // Порог уровня n: 50 * n * (n-1) / 2 (нарастающая сложность). До 10 и выше.
  while (level < 99 && points >= 25 * level * (level + 1)) level++;
  return level;
}

// Зафиксировать завершённый разговор: +1 к счётчику, +длительность (сек),
// начислить очки (10 за разговор + 1 за каждую полную минуту) и пересчитать уровень.
function recordConversation(id, durationSec) {
  const u = getUser(id);
  if (!u) return null;
  const dur = Math.max(0, parseInt(durationSec, 10) || 0);
  const gained = 10 + Math.floor(dur / 60);
  const points = (u.points || 0) + gained;
  const level = levelForPoints(points);
  stmts.bumpStats.run(dur, gained, level, id);
  return { convCount: (u.convCount || 0) + 1, totalDuration: (u.totalDuration || 0) + dur, points, level };
}

// Статистика для профиля пользователя
function getUserStats(id) {
  const u = getUser(id);
  if (!u) return { convCount: 0, totalDuration: 0, points: 0, level: 1 };
  return {
    convCount: u.convCount || 0,
    totalDuration: u.totalDuration || 0,
    points: u.points || 0,
    level: u.level || levelForPoints(u.points || 0),
  };
}

// --- Реакции на сообщения ---
function addReaction(userId, msgId, emoji) {
  stmts.insertReaction.run(userId, String(msgId).slice(0, 64), String(emoji).slice(0, 16), Date.now());
}
function getReactions(msgId) {
  return stmts.reactionsByMsg.all(String(msgId).slice(0, 64));
}

// --- Аналитика для админки ---
function getAnalytics() {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const uniqueDay = stmts.uniqueSince.get(now - day).n;
  const uniqueWeek = stmts.uniqueSince.get(now - 7 * day).n;
  const uniqueMonth = stmts.uniqueSince.get(now - 30 * day).n;
  // Пиковые часы за последние 30 дней (0..23)
  const hours = new Array(24).fill(0);
  stmts.loginsSince.all(now - 30 * day).forEach((r) => {
    const h = new Date(r.createdAt).getHours();
    hours[h] = (hours[h] || 0) + 1;
  });
  const cities = stmts.topCities.all();
  return { unique: { day: uniqueDay, week: uniqueWeek, month: uniqueMonth }, hours, cities };
}

// Сводная статистика для дашборда админки
function getStats() {
  const total = stmts.countUsers.get().n;
  const subs = { free: 0, plus: 0, max: 0 };
  stmts.countSubs.all().forEach((r) => { subs[r.subscription] = r.n; });
  const openReports = stmts.countReports.get().n;
  const revenue = subs.plus * 199 + subs.max * 399; // ориентировочный доход/мес
  return { total, subs, openReports, revenue };
}

module.exports = {
  db,
  getOrCreateUser,
  getUser,
  getUserByNick,
  saveProfile,
  setSubscription,
  activePlan,
  banUser,
  setRole,
  touch,
  addReport,
  addAdminLog,
  addActivity,
  addMessage,
  getMessages,
  pruneMessages,
  recordConversation,
  getUserStats,
  addReaction,
  getReactions,
  getAnalytics,
  getStats,
  allUsers: () => stmts.allUsers.all(),
  allReports: () => stmts.allReports.all(),
  allAdminLogs: () => stmts.allAdminLogs.all(),
  allActivity: () => stmts.allActivity.all(),
  setReportHandled: (rid) => stmts.setReportHandled.run(rid),
};
