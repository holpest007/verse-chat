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
`);

// Миграция: добавляем новые колонки в уже существующую базу (без потери данных)
for (const col of [
  "zodiac TEXT DEFAULT ''",
  "profession TEXT DEFAULT ''",
  "height INTEGER DEFAULT 0",
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
  getStats,
  allUsers: () => stmts.allUsers.all(),
  allReports: () => stmts.allReports.all(),
  allAdminLogs: () => stmts.allAdminLogs.all(),
  allActivity: () => stmts.allActivity.all(),
  setReportHandled: (rid) => stmts.setReportHandled.run(rid),
};
