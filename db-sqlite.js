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
  CREATE TABLE IF NOT EXISTS accounts (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL UNIQUE,
    email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash   TEXT NOT NULL,
    password_salt   TEXT NOT NULL,
    reset_hash      TEXT DEFAULT '',
    reset_expires   INTEGER DEFAULT 0,
    created_at      INTEGER NOT NULL,
    last_login      INTEGER DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email COLLATE NOCASE);

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
    icon           TEXT,      -- эмодзи
    condition_type TEXT,      -- calls|minutes|ratings|avg_rating|groups|topics|photos|reg_days|modes|nights|combo
    condition_value INTEGER,
    condition_extra INTEGER DEFAULT 0, -- доп. параметр (напр. мин. число оценок для avg_rating)
    category       TEXT DEFAULT '',
    xp_reward      INTEGER DEFAULT 0  -- сколько XP даёт получение достижения
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

// Справочник достижений — 40+ ачивок по категориям (сид/апсерт при старте).
// icon — эмодзи; condition_extra используется для avg_rating (мин. число оценок).
const ACHIEVEMENTS = [
  // 1. Разговоры (количество)
  { id: 1, name: 'Первый контакт', description: 'Провести 1 разговор', icon: '👋', condition_type: 'calls', condition_value: 1, category: 'Разговоры' },
  { id: 2, name: 'Болтун', description: 'Провести 10 разговоров', icon: '🗣️', condition_type: 'calls', condition_value: 10, category: 'Разговоры' },
  { id: 3, name: 'Общительный', description: 'Провести 25 разговоров', icon: '💬', condition_type: 'calls', condition_value: 25, category: 'Разговоры' },
  { id: 4, name: 'Мастер общения', description: 'Провести 50 разговоров', icon: '🏆', condition_type: 'calls', condition_value: 50, category: 'Разговоры' },
  { id: 5, name: 'Легендарный собеседник', description: 'Провести 100 разговоров', icon: '👑', condition_type: 'calls', condition_value: 100, category: 'Разговоры' },
  { id: 6, name: 'Гуру чата', description: 'Провести 250 разговоров', icon: '🌟', condition_type: 'calls', condition_value: 250, category: 'Разговоры' },
  { id: 7, name: 'Бессмертный болтун', description: 'Провести 500 разговоров', icon: '⚡', condition_type: 'calls', condition_value: 500, category: 'Разговоры' },
  // 2. Время в чате (минуты)
  { id: 8, name: 'Новичок', description: '5 минут в чате', icon: '🕐', condition_type: 'minutes', condition_value: 5, category: 'Время' },
  { id: 9, name: 'Увлечённый', description: '30 минут в чате', icon: '⏳', condition_type: 'minutes', condition_value: 30, category: 'Время' },
  { id: 10, name: 'Знаток', description: '60 минут (1 час) в чате', icon: '⌛', condition_type: 'minutes', condition_value: 60, category: 'Время' },
  { id: 11, name: 'Любитель поговорить', description: '300 минут (5 часов) в чате', icon: '🎯', condition_type: 'minutes', condition_value: 300, category: 'Время' },
  { id: 12, name: 'Профессионал', description: '600 минут (10 часов) в чате', icon: '💎', condition_type: 'minutes', condition_value: 600, category: 'Время' },
  { id: 13, name: 'Гуру времени', description: '1500 минут (25 часов) в чате', icon: '⏰', condition_type: 'minutes', condition_value: 1500, category: 'Время' },
  { id: 14, name: 'Ветеран эфира', description: '5000 минут (~83 часа) в чате', icon: '🏅', condition_type: 'minutes', condition_value: 5000, category: 'Время' },
  // 3. Оценки (количество полученных)
  { id: 15, name: 'Первая оценка', description: 'Получить первую оценку', icon: '⭐', condition_type: 'ratings', condition_value: 1, category: 'Оценки' },
  { id: 16, name: 'Популярный', description: 'Получить 5 оценок', icon: '🌟', condition_type: 'ratings', condition_value: 5, category: 'Оценки' },
  { id: 17, name: 'Любимец', description: 'Получить 10 оценок', icon: '💖', condition_type: 'ratings', condition_value: 10, category: 'Оценки' },
  { id: 18, name: 'Звезда общения', description: 'Получить 25 оценок', icon: '✨', condition_type: 'ratings', condition_value: 25, category: 'Оценки' },
  { id: 19, name: 'Икона чата', description: 'Получить 50 оценок', icon: '💫', condition_type: 'ratings', condition_value: 50, category: 'Оценки' },
  // 4. Качество оценок (средний рейтинг)
  { id: 20, name: 'Приятный собеседник', description: 'Средний рейтинг ≥ 4.5 (мин. 3 оценки)', icon: '😊', condition_type: 'avg_rating', condition_value: 45, condition_extra: 3, category: 'Качество' },
  { id: 21, name: 'Восхитительный', description: 'Средний рейтинг ≥ 4.8 (мин. 5 оценок)', icon: '😍', condition_type: 'avg_rating', condition_value: 48, condition_extra: 5, category: 'Качество' },
  { id: 22, name: 'Идеальный', description: 'Средний рейтинг = 5.0 (мин. 10 оценок)', icon: '🤩', condition_type: 'avg_rating', condition_value: 50, condition_extra: 10, category: 'Качество' },
  // 5. Групповые чаты
  { id: 23, name: 'Командный игрок', description: 'Участие в групповом чате 1 раз', icon: '👥', condition_type: 'groups', condition_value: 1, category: 'Группы' },
  { id: 24, name: 'Социалист', description: 'Участие в групповом чате 10 раз', icon: '🤝', condition_type: 'groups', condition_value: 10, category: 'Группы' },
  { id: 25, name: 'Друг компании', description: 'Участие в групповом чате 25 раз', icon: '🎉', condition_type: 'groups', condition_value: 25, category: 'Группы' },
  // 6. Темы для разговора
  { id: 26, name: 'Любознательный', description: 'Использовать тему разговора 3 раза', icon: '🤔', condition_type: 'topics', condition_value: 3, category: 'Темы' },
  { id: 27, name: 'Интеллектуал', description: 'Использовать тему разговора 15 раз', icon: '🧠', condition_type: 'topics', condition_value: 15, category: 'Темы' },
  { id: 28, name: 'Эрудит', description: 'Использовать тему разговора 50 раз', icon: '📚', condition_type: 'topics', condition_value: 50, category: 'Темы' },
  // 7. Фото в текстовом чате
  { id: 29, name: 'Фотограф-любитель', description: 'Отправить фото 1 раз', icon: '📸', condition_type: 'photos', condition_value: 1, category: 'Фото' },
  { id: 30, name: 'Опытный фотограф', description: 'Отправить фото 10 раз', icon: '🖼️', condition_type: 'photos', condition_value: 10, category: 'Фото' },
  { id: 31, name: 'Профи-фотограф', description: 'Отправить фото 50 раз', icon: '📷', condition_type: 'photos', condition_value: 50, category: 'Фото' },
  // 8. Временные вехи (стаж по created_at)
  { id: 32, name: 'Новичок в доме', description: 'В сервисе 1 день', icon: '🆕', condition_type: 'reg_days', condition_value: 1, category: 'Вехи' },
  { id: 33, name: 'Старожил', description: 'В сервисе 7 дней', icon: '📆', condition_type: 'reg_days', condition_value: 7, category: 'Вехи' },
  { id: 34, name: 'Постоянный', description: 'В сервисе 30 дней (1 месяц)', icon: '📅', condition_type: 'reg_days', condition_value: 30, category: 'Вехи' },
  { id: 35, name: 'Завсегдатай', description: 'В сервисе 90 дней (3 месяца)', icon: '🗓️', condition_type: 'reg_days', condition_value: 90, category: 'Вехи' },
  { id: 36, name: 'Преданный', description: 'В сервисе 180 дней (6 месяцев)', icon: '📋', condition_type: 'reg_days', condition_value: 180, category: 'Вехи' },
  { id: 37, name: 'Ветеран', description: 'В сервисе 365 дней (1 год)', icon: '🎂', condition_type: 'reg_days', condition_value: 365, category: 'Вехи' },
  { id: 38, name: 'Легенда', description: 'В сервисе 730 дней (2 года)', icon: '🔥', condition_type: 'reg_days', condition_value: 730, category: 'Вехи' },
  // 9. Специальные
  { id: 39, name: 'Все виды общения', description: 'Провести разговор в голосовом, видео и текстовом чате', icon: '💯', condition_type: 'modes', condition_value: 3, category: 'Специальные' },
  { id: 40, name: 'Социальная бабочка', description: '50+ разговоров, 10+ оценок и 500+ минут в чате', icon: '🦋', condition_type: 'combo', condition_value: 0, category: 'Специальные' },
  { id: 41, name: 'Ночной режим', description: 'Провести 5+ разговоров между 00:00 и 06:00', icon: '🌙', condition_type: 'nights', condition_value: 5, category: 'Специальные' },
];
// XP за достижение по тирам:
//  вехи стажа — +100; специальные и качество оценок — +75;
//  остальные по «весу» условия: простые +10, средние +25, сложные +50.
function xpReward(a) {
  if (a.condition_type === 'reg_days') return 100;
  if (a.category === 'Специальные' || a.condition_type === 'avg_rating') return 75;
  const v = a.condition_value || 0, t = a.condition_type;
  const hard = { calls: 100, minutes: 300, ratings: 25, groups: 25, topics: 50, photos: 50 };
  const medium = { calls: 10, minutes: 30, ratings: 5, groups: 10, topics: 15, photos: 10 };
  if (v >= (hard[t] || Infinity)) return 50;
  if (v >= (medium[t] || Infinity)) return 25;
  return 10;
}
function seedAchievements() {
  const up = db.prepare('INSERT OR REPLACE INTO achievements (id, name, description, icon, condition_type, condition_value, condition_extra, category, xp_reward) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const a of ACHIEVEMENTS) up.run(a.id, a.name, a.description, a.icon, a.condition_type, a.condition_value, a.condition_extra || 0, a.category || '', xpReward(a));
}

// Миграция: добавляем новые колонки в уже существующую базу (без потери данных)
for (const col of [
  "zodiac TEXT DEFAULT ''",
  "profession TEXT DEFAULT ''",
  "height INTEGER DEFAULT 0",
  "convCount INTEGER DEFAULT 0",     // сколько разговоров провёл (статистика/уровни)
  "totalDuration INTEGER DEFAULT 0", // суммарная длительность разговоров, сек
  "points INTEGER DEFAULT 0",        // очки для системы уровней
  "level INTEGER DEFAULT 1",         // текущий уровень (1..10+)
  // Счётчики для достижений
  "groupCount INTEGER DEFAULT 0",    // участий в групповых чатах
  "topicCount INTEGER DEFAULT 0",    // использований тем разговора
  "photoCount INTEGER DEFAULT 0",    // отправленных фото
  "nightCount INTEGER DEFAULT 0",    // разговоров ночью (00:00–06:00)
  "modeVoice INTEGER DEFAULT 0",     // был ли голосовой разговор
  "modeVideo INTEGER DEFAULT 0",     // был ли видеочат
  "modeText INTEGER DEFAULT 0",      // был ли текстовый чат
]) {
  try { db.exec('ALTER TABLE users ADD COLUMN ' + col); } catch (e) { /* колонка уже есть */ }
}
// Миграция таблицы достижений (для уже существующих баз) — ДО сида,
// чтобы сид мог писать в новые колонки condition_extra/category.
for (const col of ['condition_extra INTEGER DEFAULT 0', "category TEXT DEFAULT ''", 'xp_reward INTEGER DEFAULT 0']) {
  try { db.exec('ALTER TABLE achievements ADD COLUMN ' + col); } catch (e) { /* уже есть */ }
}
seedAchievements(); // теперь колонки точно существуют

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
       GROUP BY city ORDER BY n DESC LIMIT 20`
  ),
  // --- Аналитика по произвольному диапазону дат ---
  loginsInRange: db.prepare(
    `SELECT createdAt FROM activity_logs WHERE type = 'login' AND createdAt >= ? AND createdAt <= ?`
  ),
  uniqueInRange: db.prepare(
    `SELECT COUNT(DISTINCT userId) AS n FROM activity_logs WHERE type = 'login' AND createdAt >= ? AND createdAt <= ?`
  ),
  newUsersInRange: db.prepare('SELECT COUNT(*) AS n FROM users WHERE createdAt >= ? AND createdAt <= ?'),
  ratingsInRange: db.prepare('SELECT rating, created_at FROM ratings WHERE created_at >= ? AND created_at <= ?'),
  avgRatingAll: db.prepare('SELECT ROUND(AVG(rating), 2) AS avg, COUNT(*) AS n FROM ratings'),
  getAccountByEmail: db.prepare('SELECT * FROM accounts WHERE email = ? COLLATE NOCASE'),
  getAccountByUserId: db.prepare('SELECT * FROM accounts WHERE user_id = ?'),
  getAccountById: db.prepare('SELECT * FROM accounts WHERE id = ?'),
  getAccountByReset: db.prepare('SELECT * FROM accounts WHERE reset_hash = ? AND reset_expires > ?'),
  insertAccount: db.prepare(
    `INSERT INTO accounts (id, user_id, email, password_hash, password_salt, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ),
  updateAccountLogin: db.prepare('UPDATE accounts SET last_login = ? WHERE id = ?'),
  updateAccountPassword: db.prepare(
    "UPDATE accounts SET password_hash = ?, password_salt = ?, reset_hash = '', reset_expires = 0 WHERE id = ?"
  ),
  setResetToken: db.prepare('UPDATE accounts SET reset_hash = ?, reset_expires = ? WHERE id = ?'),
};

// Инкременты счётчиков достижений (mode-колонки — установка флага в 1)
const incStmts = {
  groupCount: db.prepare('UPDATE users SET groupCount = groupCount + 1 WHERE id = ?'),
  topicCount: db.prepare('UPDATE users SET topicCount = topicCount + 1 WHERE id = ?'),
  photoCount: db.prepare('UPDATE users SET photoCount = photoCount + 1 WHERE id = ?'),
  nightCount: db.prepare('UPDATE users SET nightCount = nightCount + 1 WHERE id = ?'),
  modeVoice: db.prepare('UPDATE users SET modeVoice = 1 WHERE id = ?'),
  modeVideo: db.prepare('UPDATE users SET modeVideo = 1 WHERE id = ?'),
  modeText: db.prepare('UPDATE users SET modeText = 1 WHERE id = ?'),
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

function getAccountByEmail(email) {
  return stmts.getAccountByEmail.get(String(email || '').trim().toLowerCase());
}

function getAccountByUserId(userId) {
  return stmts.getAccountByUserId.get(String(userId || ''));
}

function getAccountById(id) {
  return stmts.getAccountById.get(String(id || ''));
}

function getAccountByReset(hash, now) {
  return stmts.getAccountByReset.get(String(hash || ''), now || Date.now());
}

function createAccount(data) {
  stmts.insertAccount.run(data.id, data.userId, data.email, data.passwordHash, data.passwordSalt, Date.now());
  return getAccountById(data.id);
}

function markAccountLogin(id) {
  stmts.updateAccountLogin.run(Date.now(), id);
}

function setAccountResetToken(id, hash, expires) {
  stmts.setResetToken.run(hash, expires, id);
}

function updateAccountPassword(id, hash, salt) {
  stmts.updateAccountPassword.run(hash, salt, id);
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
// Контекст метрик пользователя для проверки условий
function statCtx(u) {
  const r = getAvgRating(u.id);
  const modesDone = (u.modeVoice ? 1 : 0) + (u.modeVideo ? 1 : 0) + (u.modeText ? 1 : 0);
  const regDays = u.createdAt ? Math.floor((Date.now() - u.createdAt) / 86400000) : 0;
  return {
    calls: u.convCount || 0,
    minutes: Math.floor((u.totalDuration || 0) / 60),
    level: u.level || 1,
    ratingsCount: r.count, avgRating: r.avg,
    groups: u.groupCount || 0, topics: u.topicCount || 0, photos: u.photoCount || 0,
    nights: u.nightCount || 0, modesDone, regDays,
  };
}
// Выполнено ли условие достижения при данном контексте
function achMet(a, ctx) {
  switch (a.condition_type) {
    case 'calls': return ctx.calls >= a.condition_value;
    case 'minutes': return ctx.minutes >= a.condition_value;
    case 'level': return ctx.level >= a.condition_value;
    case 'ratings': return ctx.ratingsCount >= a.condition_value;
    case 'avg_rating': return ctx.ratingsCount >= (a.condition_extra || 0) && ctx.avgRating >= a.condition_value / 10;
    case 'groups': return ctx.groups >= a.condition_value;
    case 'topics': return ctx.topics >= a.condition_value;
    case 'photos': return ctx.photos >= a.condition_value;
    case 'reg_days': return ctx.regDays >= a.condition_value;
    case 'modes': return ctx.modesDone >= a.condition_value;
    case 'nights': return ctx.nights >= a.condition_value;
    case 'combo': return ctx.calls >= 50 && ctx.ratingsCount >= 10 && ctx.minutes >= 500;
    default: return false;
  }
}
// Текущее числовое значение прогресса (null — прогресс-бар неприменим)
function achProgress(a, ctx) {
  switch (a.condition_type) {
    case 'calls': return ctx.calls;
    case 'minutes': return ctx.minutes;
    case 'level': return ctx.level;
    case 'ratings': return ctx.ratingsCount;
    case 'groups': return ctx.groups;
    case 'topics': return ctx.topics;
    case 'photos': return ctx.photos;
    case 'reg_days': return ctx.regDays;
    case 'modes': return ctx.modesDone;
    case 'nights': return ctx.nights;
    default: return null; // avg_rating, combo — без числового бара
  }
}

// Проверить и разблокировать новые достижения; вернуть список новых
function checkAchievements(id) {
  const u = getUser(id);
  if (!u) return [];
  const ctx = statCtx(u);
  const have = new Set(stmts.userAchievements.all(id).map((r) => r.achievement_id));
  const newly = [];
  for (const a of stmts.allAchievements.all()) {
    if (have.has(a.id)) continue;
    if (achMet(a, ctx)) {
      stmts.unlockAchievement.run(id, a.id, Date.now());
      if (a.xp_reward) addXp(id, a.xp_reward); // начисляем XP и пересчитываем уровень
      newly.push(a); // a.xp_reward уходит клиенту для тоста
    }
  }
  return newly;
}
// Все достижения со статусом разблокировки, категорией и прогрессом
function getAchievements(id) {
  const u = getUser(id) || { id };
  const ctx = statCtx(u);
  const have = new Map(stmts.userAchievements.all(id).map((r) => [r.achievement_id, r.unlocked_at]));
  return stmts.allAchievements.all().map((a) => {
    const cur = achProgress(a, ctx);
    return {
      id: a.id, name: a.name, description: a.description, icon: a.icon,
      category: a.category || 'Прочее',
      target: a.condition_value,
      progress: cur == null ? null : Math.min(cur, a.condition_value),
      numeric: cur != null,
      xp: a.xp_reward || 0,
      unlocked: have.has(a.id), unlockedAt: have.get(a.id) || null,
    };
  });
}

// Инкременты счётчиков для достижений
function incCounter(id, col) {
  const s = incStmts[col];
  if (s) s.run(id);
}
function grantAchievement(userId, achId) {
  stmts.unlockAchievement.run(userId, parseInt(achId, 10), Date.now());
}
function incGroup(id) { incCounter(id, 'groupCount'); }
function incTopic(id) { incCounter(id, 'topicCount'); }
function incPhoto(id) { incCounter(id, 'photoCount'); }
// Отметить режим общения (для «Все виды общения») и ночной разговор
function recordCallExtras(id, mode, isNight) {
  if (mode === 'voice') incCounter(id, 'modeVoice');
  else if (mode === 'video') incCounter(id, 'modeVideo');
  else if (mode === 'text') incCounter(id, 'modeText');
  if (isNight) incCounter(id, 'nightCount');
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
// Ключ сегодняшнего дня 'YYYY-MM-DD' (без аргументов). ВАЖНО: имя отличается от
// analytics-функции dayKey(d) ниже — иначе из-за hoisting челленджи падали и вся
// вкладка «Статистика» (включая достижения) не отображалась.
function todayKey() {
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
  const day = todayKey();
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
  const day = todayKey();
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
// Ключ дня 'YYYY-MM-DD' по локальному времени
function dayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
// Заполнить все дни диапазона (чтобы линия была непрерывной), но не более 92 точек
function fillDays(fromMs, toMs, map) {
  const out = [];
  const start = new Date(fromMs); start.setHours(0, 0, 0, 0);
  const end = new Date(toMs); end.setHours(0, 0, 0, 0);
  let days = Math.round((end - start) / 86400000) + 1;
  if (days < 1) days = 1;
  if (days > 92) {
    // слишком широкий диапазон — отдаём только дни с данными
    return Object.keys(map).sort().map((k) => ({ day: k, n: map[k] }));
  }
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 86400000);
    const k = dayKey(d);
    out.push({ day: k, n: map[k] || 0 });
  }
  return out;
}

// Аналитика по диапазону [fromMs, toMs]. Без аргументов — последние 30 дней.
function getAnalytics(fromMs, toMs) {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const to = toMs || now;
  const from = fromMs || (to - 30 * day);

  // Карточки-виджеты
  const totalUsers = stmts.countUsers.get().n;
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const todayNew = stmts.newUsersInRange.get(startToday.getTime(), now).n;
  const ar = stmts.avgRatingAll.get();
  const avgRating = ar && ar.avg ? ar.avg : 0;
  const uniqueInRange = stmts.uniqueInRange.get(from, to).n;
  const newInRange = stmts.newUsersInRange.get(from, to).n;

  // Посещаемость по дням + пиковые часы (из login-событий в диапазоне)
  const hours = new Array(24).fill(0);
  const byDay = {};
  stmts.loginsInRange.all(from, to).forEach((r) => {
    const d = new Date(r.createdAt);
    hours[d.getHours()]++;
    const k = dayKey(d);
    byDay[k] = (byDay[k] || 0) + 1;
  });
  const visitsByDay = fillDays(from, to, byDay);

  // Динамика рейтинга по дням (средняя оценка за день)
  const rSum = {}, rCnt = {};
  stmts.ratingsInRange.all(from, to).forEach((r) => {
    const k = dayKey(new Date(r.created_at));
    rSum[k] = (rSum[k] || 0) + r.rating;
    rCnt[k] = (rCnt[k] || 0) + 1;
  });
  const ratingByDay = Object.keys(rCnt).sort().map((k) => ({
    day: k, avg: Math.round((rSum[k] / rCnt[k]) * 100) / 100, n: rCnt[k],
  }));

  const cities = stmts.topCities.all();
  return {
    range: { from, to },
    cards: { totalUsers, todayNew, avgRating, uniqueInRange, newInRange },
    visitsByDay, hours, cities, ratingByDay,
  };
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

// Полная очистка тестовой базы. Каталог достижений не удаляем: это системные
// данные приложения, а не пользовательская статистика.
function resetStats() {
  db.exec(`
    DELETE FROM messages;
    DELETE FROM reports;
    DELETE FROM admin_logs;
    DELETE FROM reactions;
    DELETE FROM ratings;
    DELETE FROM activity_logs;
    DELETE FROM user_stats;
    DELETE FROM user_achievements;
    DELETE FROM challenge_claims;
    DELETE FROM users;
    DELETE FROM sqlite_sequence
      WHERE name IN ('messages', 'reports', 'admin_logs', 'activity_logs',
                     'reactions', 'ratings', 'user_stats', 'user_achievements',
                     'challenge_claims', 'users');
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
  getAccountByEmail,
  getAccountByUserId,
  getAccountById,
  getAccountByReset,
  createAccount,
  markAccountLogin,
  setAccountResetToken,
  updateAccountPassword,
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
  incGroup,
  incTopic,
  incPhoto,
  recordCallExtras,
  grantAchievement,
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
