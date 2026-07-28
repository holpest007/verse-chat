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

  -- Статистика пользователя (отдельная таблица под вкладку «Статистика»)
  CREATE TABLE IF NOT EXISTS user_stats (
    user_id       TEXT PRIMARY KEY,
    total_minutes INTEGER DEFAULT 0,
    total_calls   INTEGER DEFAULT 0,
    xp            INTEGER DEFAULT 0,
    level         INTEGER DEFAULT 1
  );

  -- Справочник достижений (ачивок)
  CREATE TABLE IF NOT EXISTS achievements (
    id             INTEGER PRIMARY KEY,
    name           TEXT,
    description    TEXT,
    icon           TEXT,
    condition_type TEXT,      -- 'calls' | 'minutes' | 'level'
    condition_value INTEGER
  );

  -- Полученные пользователями достижения
  CREATE TABLE IF NOT EXISTS user_achievements (
    user_id        TEXT,
    achievement_id INTEGER,
    unlocked_at    INTEGER,
    PRIMARY KEY (user_id, achievement_id)
  );

  -- Выполненные дневные челленджи (чтобы бонус давался один раз в день)
  CREATE TABLE IF NOT EXISTS challenge_claims (
    user_id    TEXT,
    day        TEXT,          -- YYYY-MM-DD
    kind       TEXT,          -- 'minutes' | 'calls'
    claimed_at INTEGER,
    PRIMARY KEY (user_id, day, kind)
  );
`);

// Справочник достижений — фиксированный список (сид при старте)
const ACHIEVEMENTS = [
  { id: 1, name: 'Первый разговор', description: 'Проведите свой первый разговор', icon: 'fa-comment-dots', condition_type: 'calls', condition_value: 1 },
  { id: 2, name: 'Разговорчивый', description: '10 разговоров', icon: 'fa-comments', condition_type: 'calls', condition_value: 10 },
  { id: 3, name: 'Легенда общения', description: '100 разговоров', icon: 'fa-crown', condition_type: 'calls', condition_value: 100 },
  { id: 4, name: 'Час в эфире', description: '100 минут в чате', icon: 'fa-clock', condition_type: 'minutes', condition_value: 100 },
  { id: 5, name: 'Марафонец', description: '500 минут в чате', icon: 'fa-hourglass-half', condition_type: 'minutes', condition_value: 500 },
  { id: 6, name: 'Восходящая звезда', description: 'Достигните 5 уровня', icon: 'fa-star', condition_type: 'level', condition_value: 5 },
  { id: 7, name: 'Мастер общения', description: 'Достигните 10 уровня', icon: 'fa-medal', condition_type: 'level', condition_value: 10 },
];
(function seedAchievements() {
  const up = db.prepare('INSERT OR REPLACE INTO achievements (id, name, description, icon, condition_type, condition_value) VALUES (?, ?, ?, ?, ?, ?)');
  for (const a of ACHIEVEMENTS) up.run(a.id, a.name, a.description, a.icon, a.condition_type, a.condition_value);
})();

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

// Оценки собеседников после разговора (1–5 звёзд). Само окно оценки появится в
// фазе рейтинга; таблица и средний рейтинг заводятся заранее — под колонку админки.
db.exec(`
  CREATE TABLE IF NOT EXISTS ratings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user_id TEXT,
    to_user_id   TEXT,
    rating       INTEGER,
    created_at   INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_ratings_to ON ratings (to_user_id);
`);

// ----------------------------------------------------------------------------
//  ПОДГОТОВЛЕННЫЕ ЗАПРОСЫ
// ----------------------------------------------------------------------------
const stmts = {
  getUser: db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByNick: db.prepare('SELECT * FROM users WHERE nick = ? COLLATE NOCASE'),
  insertUser: db.prepare(`INSERT INTO users (id, createdAt, lastSeen) VALUES (?, ?, ?)`),
  allUsers: db.prepare(`
    SELECT u.*,
      (SELECT ROUND(AVG(rating), 2) FROM ratings WHERE to_user_id = u.id) AS avgRating,
      (SELECT COUNT(*) FROM ratings WHERE to_user_id = u.id) AS ratingCount
    FROM users u ORDER BY u.createdAt DESC`),
  insertRating: db.prepare('INSERT INTO ratings (from_user_id, to_user_id, rating, created_at) VALUES (?, ?, ?, ?)'),
  avgRating: db.prepare('SELECT ROUND(AVG(rating), 2) AS avg, COUNT(*) AS n FROM ratings WHERE to_user_id = ?'),
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
  addXp: db.prepare('UPDATE users SET points = points + ?, level = ? WHERE id = ?'),
  // Зеркало статистики в отдельную таблицу user_stats (по ТЗ)
  upsertUserStats: db.prepare(
    `INSERT INTO user_stats (user_id, total_minutes, total_calls, xp, level)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         total_minutes = excluded.total_minutes,
         total_calls   = excluded.total_calls,
         xp            = excluded.xp,
         level         = excluded.level`
  ),
  // Таблица лидеров: топ по XP (ник берём из users)
  leaderboard: db.prepare(
    `SELECT s.user_id AS id, s.xp AS xp, s.level AS level, s.total_calls AS calls,
            COALESCE(NULLIF(u.nick, ''), 'Аноним') AS nick
       FROM user_stats s LEFT JOIN users u ON u.id = s.user_id
       ORDER BY s.xp DESC, s.total_calls DESC LIMIT 10`
  ),

  // --- Достижения ---
  allAchievements: db.prepare('SELECT * FROM achievements ORDER BY id'),
  userAchievements: db.prepare('SELECT achievement_id, unlocked_at FROM user_achievements WHERE user_id = ?'),
  unlockAchievement: db.prepare(
    'INSERT OR IGNORE INTO user_achievements (user_id, achievement_id, unlocked_at) VALUES (?, ?, ?)'
  ),

  // --- Дневные челленджи ---
  getClaim: db.prepare('SELECT 1 AS ok FROM challenge_claims WHERE user_id = ? AND day = ? AND kind = ?'),
  addClaim: db.prepare('INSERT OR IGNORE INTO challenge_claims (user_id, day, kind, claimed_at) VALUES (?, ?, ?, ?)'),
  // Активность за сегодня (для прогресса челленджей): call-события с длительностью
  callsSince: db.prepare(
    `SELECT info, createdAt FROM activity_logs WHERE userId = ? AND type = 'call' AND createdAt >= ?`
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

// Синхронизировать зеркальную таблицу user_stats из users
function syncUserStats(u) {
  if (!u) return;
  stmts.upsertUserStats.run(
    u.id, Math.floor((u.totalDuration || 0) / 60), u.convCount || 0, u.points || 0, u.level || 1
  );
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
  syncUserStats(getUser(id));
  return { convCount: (u.convCount || 0) + 1, totalDuration: (u.totalDuration || 0) + dur, points, level };
}

// Начислить XP напрямую (бонусы челленджей); пересчитать уровень
function addXp(id, amount) {
  const u = getUser(id);
  if (!u) return null;
  const points = (u.points || 0) + Math.max(0, parseInt(amount, 10) || 0);
  const level = levelForPoints(points);
  stmts.addXp.run(Math.max(0, parseInt(amount, 10) || 0), level, id);
  syncUserStats(getUser(id));
  return { points, level };
}

// Статистика для профиля/вкладки. xp = points (для совместимости).
function getUserStats(id) {
  const u = getUser(id);
  if (!u) return { convCount: 0, totalDuration: 0, points: 0, xp: 0, level: 1 };
  const level = u.level || levelForPoints(u.points || 0);
  return {
    convCount: u.convCount || 0,
    totalDuration: u.totalDuration || 0,
    points: u.points || 0,
    xp: u.points || 0,
    level,
  };
}

// --- Достижения ---
// Проверить и разблокировать новые достижения; вернуть список новых
function checkAchievements(id) {
  const u = getUser(id);
  if (!u) return [];
  const minutes = Math.floor((u.totalDuration || 0) / 60);
  const have = new Set(stmts.userAchievements.all(id).map((r) => r.achievement_id));
  const newly = [];
  for (const a of stmts.allAchievements.all()) {
    if (have.has(a.id)) continue;
    let ok = false;
    if (a.condition_type === 'calls') ok = (u.convCount || 0) >= a.condition_value;
    else if (a.condition_type === 'minutes') ok = minutes >= a.condition_value;
    else if (a.condition_type === 'level') ok = (u.level || 1) >= a.condition_value;
    if (ok) { stmts.unlockAchievement.run(id, a.id, Date.now()); newly.push(a); }
  }
  return newly;
}
// Все достижения со статусом разблокировки и прогрессом
function getAchievements(id) {
  const u = getUser(id) || {};
  const minutes = Math.floor((u.totalDuration || 0) / 60);
  const have = new Map(stmts.userAchievements.all(id).map((r) => [r.achievement_id, r.unlocked_at]));
  return stmts.allAchievements.all().map((a) => {
    const cur = a.condition_type === 'calls' ? (u.convCount || 0)
      : a.condition_type === 'minutes' ? minutes : (u.level || 1);
    return {
      id: a.id, name: a.name, description: a.description, icon: a.icon,
      target: a.condition_value, progress: Math.min(cur, a.condition_value),
      unlocked: have.has(a.id), unlockedAt: have.get(a.id) || null,
    };
  });
}

// Таблица лидеров (топ-10 по XP)
function getLeaderboard() {
  return stmts.leaderboard.all().map((r, i) => ({ rank: i + 1, nick: r.nick, xp: r.xp, level: r.level, calls: r.calls }));
}

// Прогресс за сегодня: минуты и разговоры (из activity_logs)
function todayProgress(id) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const rows = stmts.callsSince.all(id, start);
  let minutes = 0;
  rows.forEach((r) => { const sec = parseInt(String(r.info), 10) || 0; minutes += Math.floor(sec / 60); });
  return { minutes, calls: rows.length };
}
function dayKey() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// Описание дневных челленджей
const CHALLENGES = [
  { kind: 'minutes', name: 'Проведи 30 минут в чате сегодня', target: 30, reward: 50 },
  { kind: 'calls', name: 'Проведи 3 разговора сегодня', target: 3, reward: 30 },
];
// Список челленджей с прогрессом и статусом получения
function getChallenges(id) {
  const prog = todayProgress(id);
  const day = dayKey();
  return CHALLENGES.map((c) => {
    const cur = c.kind === 'minutes' ? prog.minutes : prog.calls;
    const claimed = !!stmts.getClaim.get(id, day, c.kind);
    return { kind: c.kind, name: c.name, target: c.target, progress: Math.min(cur, c.target), reward: c.reward, done: cur >= c.target, claimed };
  });
}
// Забрать бонус за выполненный челлендж (один раз в день)
function claimChallenge(id, kind) {
  const c = CHALLENGES.find((x) => x.kind === kind);
  if (!c) return { ok: false, error: 'Неизвестный челлендж' };
  const prog = todayProgress(id);
  const cur = c.kind === 'minutes' ? prog.minutes : prog.calls;
  if (cur < c.target) return { ok: false, error: 'Челлендж ещё не выполнен' };
  const day = dayKey();
  if (stmts.getClaim.get(id, day, kind)) return { ok: false, error: 'Бонус уже получен' };
  stmts.addClaim.run(id, day, kind, Date.now());
  const st = addXp(id, c.reward);
  return { ok: true, reward: c.reward, points: st ? st.points : 0, level: st ? st.level : 1 };
}

// Полная статистика для вкладки «Статистика»
function getFullStats(id) {
  const s = getUserStats(id);
  const r = getAvgRating(id);
  const cur = 25 * (s.level - 1) * s.level;        // порог текущего уровня
  const next = 25 * s.level * (s.level + 1);       // порог следующего уровня
  return {
    stats: {
      totalMinutes: Math.floor(s.totalDuration / 60),
      totalCalls: s.convCount,
      xp: s.xp,
      level: s.level,
      curLevelXp: cur,
      nextLevelXp: next,
      toNext: Math.max(0, next - s.xp),
      avgRating: r.avg,
      ratingCount: r.count,
    },
    achievements: getAchievements(id),
    challenges: getChallenges(id),
    leaderboard: getLeaderboard(),
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

// Оценка собеседника (1–5). Возвращает обновлённый средний рейтинг.
function addRating(fromId, toId, rating) {
  const r = Math.max(1, Math.min(5, parseInt(rating, 10) || 0));
  if (!toId || !r) return null;
  stmts.insertRating.run(fromId || '', toId, r, Date.now());
  return getAvgRating(toId);
}
function getAvgRating(id) {
  const row = stmts.avgRating.get(id);
  return { avg: row && row.avg ? row.avg : 0, count: row ? row.n : 0 };
}

// Полный сброс статистики: оценки, логи активности, уровни/XP/время/разговоры,
// достижения и челленджи. Пользователей, роли, подписки и жалобы НЕ трогаем.
function resetStats() {
  db.exec(`
    DELETE FROM ratings;
    DELETE FROM activity_logs;
    DELETE FROM user_stats;
    DELETE FROM user_achievements;
    DELETE FROM challenge_claims;
    UPDATE users SET convCount = 0, totalDuration = 0, points = 0, level = 1;
  `);
  return true;
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
  addRating,
  getAvgRating,
  resetStats,
  addMessage,
  getMessages,
  pruneMessages,
  recordConversation,
  getUserStats,
  addXp,
  checkAchievements,
  getAchievements,
  getLeaderboard,
  getChallenges,
  claimChallenge,
  getFullStats,
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
