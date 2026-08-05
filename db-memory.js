// ============================================================================
//  db-memory.js — запасное хранилище В ПАМЯТИ (тот же API, что и db-sqlite.js).
//  Используется, если встроенный SQLite недоступен. Данные не сохраняются
//  между перезапусками, но чат/группы/онлайн/подписки работают в рамках сессии.
// ============================================================================

const users = new Map();      // id -> объект пользователя
const reports = [];           // жалобы
const adminLogs = [];         // действия админов
const activityLogs = [];      // активность
const messages = [];          // история сообщений
const reactions = [];         // реакции на сообщения
let reportSeq = 1;

const accounts = new Map();
function getAccountByEmail(email) { const e = String(email || '').trim().toLowerCase(); return [...accounts.values()].find((a) => a.email === e); }
function getAccountByUserId(userId) { return [...accounts.values()].find((a) => a.user_id === userId); }
function getAccountById(id) { return accounts.get(id); }
function getAccountByReset(hash, now) { return [...accounts.values()].find((a) => a.reset_hash === hash && a.reset_expires > (now || Date.now())); }
function createAccount(data) { const account = { id: data.id, user_id: data.userId, email: data.email, password_hash: data.passwordHash, password_salt: data.passwordSalt, reset_hash: '', reset_expires: 0 }; accounts.set(account.id, account); return account; }
function markAccountLogin() {}
function setAccountResetToken(id, hash, expires) { const a = accounts.get(id); if (a) { a.reset_hash = hash; a.reset_expires = expires; } }
function updateAccountPassword(id, hash, salt) { const a = accounts.get(id); if (a) { a.password_hash = hash; a.password_salt = salt; a.reset_hash = ''; a.reset_expires = 0; } }

function defaultUser(id) {
  const now = Date.now();
  return {
    id, nick: '', gender: 'male', age: 18, city: 'Москва',
    subscription: 'free', subscriptionExpiry: null, role: 'user', isBanned: 0,
    avatar: '', description: '', theme: 'default', interests: '',
    zodiac: '', profession: '', height: 0,
    convCount: 0, totalDuration: 0, points: 0, level: 1,
    groupCount: 0, topicCount: 0, photoCount: 0, nightCount: 0,
    modeVoice: 0, modeVideo: 0, modeText: 0,
    createdAt: now, lastSeen: now,
  };
}

function getOrCreateUser(id) {
  if (!users.has(id)) users.set(id, defaultUser(id));
  return users.get(id);
}
function getUser(id) { return users.get(id); }
function getUserByNick(nick) {
  const n = String(nick || '').toLowerCase();
  for (const u of users.values()) if ((u.nick || '').toLowerCase() === n) return u;
  return undefined;
}

function saveProfile(id, p) {
  const u = getOrCreateUser(id);
  u.nick = p.nick || '';
  u.gender = p.gender || 'male';
  u.age = parseInt(p.age, 10) || 18;
  u.city = p.city || 'Москва';
  u.avatar = p.avatar || '';
  u.description = p.description || '';
  u.theme = p.theme || 'default';
  u.interests = p.interests || '';
  u.zodiac = p.zodiac || '';
  u.profession = p.profession || '';
  u.height = parseInt(p.height, 10) || 0;
  u.lastSeen = Date.now();
  return u;
}

function setSubscription(id, plan, days = 30) {
  const u = getOrCreateUser(id);
  u.subscription = plan;
  u.subscriptionExpiry = plan === 'free' ? null : Date.now() + days * 24 * 60 * 60 * 1000;
  return u;
}
function activePlan(user) {
  if (!user || user.subscription === 'free') return 'free';
  if (user.subscriptionExpiry && user.subscriptionExpiry < Date.now()) return 'free';
  return user.subscription;
}
function banUser(id, banned) { const u = users.get(id); if (u) u.isBanned = banned ? 1 : 0; }
function setRole(id, role) { const u = users.get(id); if (u) u.role = role; }
function touch(id) { const u = users.get(id); if (u) u.lastSeen = Date.now(); }

function addReport(reporterId, targetId, reason) {
  reports.push({ id: reportSeq++, reporterId, targetId, reason: reason || '', createdAt: Date.now(), handled: 0 });
}
function setReportHandled(rid) { const r = reports.find((x) => x.id === Number(rid)); if (r) r.handled = 1; }
function addAdminLog(adminId, action, targetId) {
  adminLogs.push({ id: adminLogs.length + 1, adminId, action, targetId: targetId || '', createdAt: Date.now() });
}
function addActivity(userId, type, info) {
  activityLogs.push({ id: activityLogs.length + 1, userId, type, info: info || '', createdAt: Date.now() });
}
function addMessage(userId, peerId, peerNick, scope, dir, text) {
  messages.push({ id: messages.length + 1, userId, peerId, peerNick: peerNick || '', scope, dir, text: String(text).slice(0, 2000), createdAt: Date.now() });
}
function getMessages(userId) {
  return messages.filter((m) => m.userId === userId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 500);
}
function pruneMessages(days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].createdAt < cutoff) messages.splice(i, 1);
}

function getStats() {
  const subs = { free: 0, plus: 0, max: 0 };
  for (const u of users.values()) subs[u.subscription] = (subs[u.subscription] || 0) + 1;
  const openReports = reports.filter((r) => !r.handled).length;
  const revenue = subs.plus * 199 + subs.max * 399;
  return { total: users.size, subs, openReports, revenue };
}

// --- Статистика пользователя и уровни (зеркало db-sqlite) ---
function levelForPoints(points) {
  let level = 1;
  while (level < 99 && points >= 25 * level * (level + 1)) level++;
  return level;
}
function recordConversation(id, durationSec) {
  const u = getUser(id);
  if (!u) return null;
  const dur = Math.max(0, parseInt(durationSec, 10) || 0);
  const gained = 10 + Math.floor(dur / 60);
  u.convCount = (u.convCount || 0) + 1;
  u.totalDuration = (u.totalDuration || 0) + dur;
  u.points = (u.points || 0) + gained;
  u.level = levelForPoints(u.points);
  return { convCount: u.convCount, totalDuration: u.totalDuration, points: u.points, level: u.level };
}
function addXp(id, amount) {
  const u = getUser(id);
  if (!u) return null;
  u.points = (u.points || 0) + Math.max(0, parseInt(amount, 10) || 0);
  u.level = levelForPoints(u.points);
  return { points: u.points, level: u.level };
}
function getUserStats(id) {
  const u = getUser(id);
  if (!u) return { convCount: 0, totalDuration: 0, points: 0, xp: 0, level: 1 };
  return { convCount: u.convCount || 0, totalDuration: u.totalDuration || 0, points: u.points || 0, xp: u.points || 0, level: u.level || 1 };
}

// --- Достижения / челленджи / лидерборд (в памяти) ---
const ACHIEVEMENTS = [
  { id: 1, name: 'Первый контакт', description: 'Провести 1 разговор', icon: '👋', condition_type: 'calls', condition_value: 1, category: 'Разговоры' },
  { id: 2, name: 'Болтун', description: 'Провести 10 разговоров', icon: '🗣️', condition_type: 'calls', condition_value: 10, category: 'Разговоры' },
  { id: 3, name: 'Общительный', description: 'Провести 25 разговоров', icon: '💬', condition_type: 'calls', condition_value: 25, category: 'Разговоры' },
  { id: 4, name: 'Мастер общения', description: 'Провести 50 разговоров', icon: '🏆', condition_type: 'calls', condition_value: 50, category: 'Разговоры' },
  { id: 5, name: 'Легендарный собеседник', description: 'Провести 100 разговоров', icon: '👑', condition_type: 'calls', condition_value: 100, category: 'Разговоры' },
  { id: 6, name: 'Гуру чата', description: 'Провести 250 разговоров', icon: '🌟', condition_type: 'calls', condition_value: 250, category: 'Разговоры' },
  { id: 7, name: 'Бессмертный болтун', description: 'Провести 500 разговоров', icon: '⚡', condition_type: 'calls', condition_value: 500, category: 'Разговоры' },
  { id: 8, name: 'Новичок', description: '5 минут в чате', icon: '🕐', condition_type: 'minutes', condition_value: 5, category: 'Время' },
  { id: 9, name: 'Увлечённый', description: '30 минут в чате', icon: '⏳', condition_type: 'minutes', condition_value: 30, category: 'Время' },
  { id: 10, name: 'Знаток', description: '60 минут в чате', icon: '⌛', condition_type: 'minutes', condition_value: 60, category: 'Время' },
  { id: 11, name: 'Любитель поговорить', description: '300 минут в чате', icon: '🎯', condition_type: 'minutes', condition_value: 300, category: 'Время' },
  { id: 12, name: 'Профессионал', description: '600 минут в чате', icon: '💎', condition_type: 'minutes', condition_value: 600, category: 'Время' },
  { id: 13, name: 'Гуру времени', description: '1500 минут в чате', icon: '⏰', condition_type: 'minutes', condition_value: 1500, category: 'Время' },
  { id: 14, name: 'Ветеран эфира', description: '5000 минут в чате', icon: '🏅', condition_type: 'minutes', condition_value: 5000, category: 'Время' },
  { id: 15, name: 'Первая оценка', description: 'Получить первую оценку', icon: '⭐', condition_type: 'ratings', condition_value: 1, category: 'Оценки' },
  { id: 16, name: 'Популярный', description: 'Получить 5 оценок', icon: '🌟', condition_type: 'ratings', condition_value: 5, category: 'Оценки' },
  { id: 17, name: 'Любимец', description: 'Получить 10 оценок', icon: '💖', condition_type: 'ratings', condition_value: 10, category: 'Оценки' },
  { id: 18, name: 'Звезда общения', description: 'Получить 25 оценок', icon: '✨', condition_type: 'ratings', condition_value: 25, category: 'Оценки' },
  { id: 19, name: 'Икона чата', description: 'Получить 50 оценок', icon: '💫', condition_type: 'ratings', condition_value: 50, category: 'Оценки' },
  { id: 20, name: 'Приятный собеседник', description: 'Средний рейтинг ≥ 4.5 (мин. 3 оценки)', icon: '😊', condition_type: 'avg_rating', condition_value: 45, condition_extra: 3, category: 'Качество' },
  { id: 21, name: 'Восхитительный', description: 'Средний рейтинг ≥ 4.8 (мин. 5 оценок)', icon: '😍', condition_type: 'avg_rating', condition_value: 48, condition_extra: 5, category: 'Качество' },
  { id: 22, name: 'Идеальный', description: 'Средний рейтинг = 5.0 (мин. 10 оценок)', icon: '🤩', condition_type: 'avg_rating', condition_value: 50, condition_extra: 10, category: 'Качество' },
  { id: 23, name: 'Командный игрок', description: 'Участие в групповом чате 1 раз', icon: '👥', condition_type: 'groups', condition_value: 1, category: 'Группы' },
  { id: 24, name: 'Социалист', description: 'Участие в групповом чате 10 раз', icon: '🤝', condition_type: 'groups', condition_value: 10, category: 'Группы' },
  { id: 25, name: 'Друг компании', description: 'Участие в групповом чате 25 раз', icon: '🎉', condition_type: 'groups', condition_value: 25, category: 'Группы' },
  { id: 26, name: 'Любознательный', description: 'Использовать тему разговора 3 раза', icon: '🤔', condition_type: 'topics', condition_value: 3, category: 'Темы' },
  { id: 27, name: 'Интеллектуал', description: 'Использовать тему разговора 15 раз', icon: '🧠', condition_type: 'topics', condition_value: 15, category: 'Темы' },
  { id: 28, name: 'Эрудит', description: 'Использовать тему разговора 50 раз', icon: '📚', condition_type: 'topics', condition_value: 50, category: 'Темы' },
  { id: 29, name: 'Фотограф-любитель', description: 'Отправить фото 1 раз', icon: '📸', condition_type: 'photos', condition_value: 1, category: 'Фото' },
  { id: 30, name: 'Опытный фотограф', description: 'Отправить фото 10 раз', icon: '🖼️', condition_type: 'photos', condition_value: 10, category: 'Фото' },
  { id: 31, name: 'Профи-фотограф', description: 'Отправить фото 50 раз', icon: '📷', condition_type: 'photos', condition_value: 50, category: 'Фото' },
  { id: 32, name: 'Новичок в доме', description: 'В сервисе 1 день', icon: '🆕', condition_type: 'reg_days', condition_value: 1, category: 'Вехи' },
  { id: 33, name: 'Старожил', description: 'В сервисе 7 дней', icon: '📆', condition_type: 'reg_days', condition_value: 7, category: 'Вехи' },
  { id: 34, name: 'Постоянный', description: 'В сервисе 30 дней', icon: '📅', condition_type: 'reg_days', condition_value: 30, category: 'Вехи' },
  { id: 35, name: 'Завсегдатай', description: 'В сервисе 90 дней', icon: '🗓️', condition_type: 'reg_days', condition_value: 90, category: 'Вехи' },
  { id: 36, name: 'Преданный', description: 'В сервисе 180 дней', icon: '📋', condition_type: 'reg_days', condition_value: 180, category: 'Вехи' },
  { id: 37, name: 'Ветеран', description: 'В сервисе 365 дней', icon: '🎂', condition_type: 'reg_days', condition_value: 365, category: 'Вехи' },
  { id: 38, name: 'Легенда', description: 'В сервисе 730 дней', icon: '🔥', condition_type: 'reg_days', condition_value: 730, category: 'Вехи' },
  { id: 39, name: 'Все виды общения', description: 'Разговор в голосовом, видео и текстовом чате', icon: '💯', condition_type: 'modes', condition_value: 3, category: 'Специальные' },
  { id: 40, name: 'Социальная бабочка', description: '50+ разговоров, 10+ оценок и 500+ минут', icon: '🦋', condition_type: 'combo', condition_value: 0, category: 'Специальные' },
  { id: 41, name: 'Ночной режим', description: '5+ разговоров между 00:00 и 06:00', icon: '🌙', condition_type: 'nights', condition_value: 5, category: 'Специальные' },
];
const userAch = new Map();       // user_id -> Map(achId -> unlockedAt)
const claims = new Set();        // "user|day|kind"
const CHALLENGES = [
  { kind: 'minutes', name: 'Проведи 30 минут в чате сегодня', target: 30, reward: 50 },
  { kind: 'calls', name: 'Проведи 3 разговора сегодня', target: 3, reward: 30 },
];
function statCtx(u) {
  const r = getAvgRating(u.id);
  const modesDone = (u.modeVoice ? 1 : 0) + (u.modeVideo ? 1 : 0) + (u.modeText ? 1 : 0);
  return {
    calls: u.convCount || 0, minutes: Math.floor((u.totalDuration || 0) / 60), level: u.level || 1,
    ratingsCount: r.count, avgRating: r.avg, groups: u.groupCount || 0, topics: u.topicCount || 0,
    photos: u.photoCount || 0, nights: u.nightCount || 0, modesDone,
    regDays: u.createdAt ? Math.floor((Date.now() - u.createdAt) / 86400000) : 0,
  };
}
function achMet(a, c) {
  switch (a.condition_type) {
    case 'calls': return c.calls >= a.condition_value;
    case 'minutes': return c.minutes >= a.condition_value;
    case 'level': return c.level >= a.condition_value;
    case 'ratings': return c.ratingsCount >= a.condition_value;
    case 'avg_rating': return c.ratingsCount >= (a.condition_extra || 0) && c.avgRating >= a.condition_value / 10;
    case 'groups': return c.groups >= a.condition_value;
    case 'topics': return c.topics >= a.condition_value;
    case 'photos': return c.photos >= a.condition_value;
    case 'reg_days': return c.regDays >= a.condition_value;
    case 'modes': return c.modesDone >= a.condition_value;
    case 'nights': return c.nights >= a.condition_value;
    case 'combo': return c.calls >= 50 && c.ratingsCount >= 10 && c.minutes >= 500;
    default: return false;
  }
}
function achProg(a, c) {
  const m = { calls: c.calls, minutes: c.minutes, level: c.level, ratings: c.ratingsCount, groups: c.groups, topics: c.topics, photos: c.photos, reg_days: c.regDays, modes: c.modesDone, nights: c.nights };
  return (a.condition_type in m) ? m[a.condition_type] : null;
}
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
function checkAchievements(id) {
  const u = getUser(id); if (!u) return [];
  if (!userAch.has(id)) userAch.set(id, new Map());
  const have = userAch.get(id);
  const ctx = statCtx(u);
  const newly = [];
  for (const a of ACHIEVEMENTS) if (!have.has(a.id) && achMet(a, ctx)) {
    have.set(a.id, Date.now());
    const xp = xpReward(a); if (xp) addXp(id, xp);
    newly.push({ ...a, xp_reward: xp });
  }
  return newly;
}
function getAchievements(id) {
  const u = getUser(id) || { id };
  const ctx = statCtx(u);
  const have = userAch.get(id) || new Map();
  return ACHIEVEMENTS.map((a) => {
    const cur = achProg(a, ctx);
    return { id: a.id, name: a.name, description: a.description, icon: a.icon, category: a.category || 'Прочее', target: a.condition_value, progress: cur == null ? null : Math.min(cur, a.condition_value), numeric: cur != null, xp: xpReward(a), unlocked: have.has(a.id), unlockedAt: have.get(a.id) || null };
  });
}
function incGroup(id) { const u = getUser(id); if (u) u.groupCount = (u.groupCount || 0) + 1; }
function incTopic(id) { const u = getUser(id); if (u) u.topicCount = (u.topicCount || 0) + 1; }
function incPhoto(id) { const u = getUser(id); if (u) u.photoCount = (u.photoCount || 0) + 1; }
function recordCallExtras(id, mode, isNight) {
  const u = getUser(id); if (!u) return;
  if (mode === 'voice') u.modeVoice = 1; else if (mode === 'video') u.modeVideo = 1; else if (mode === 'text') u.modeText = 1;
  if (isNight) u.nightCount = (u.nightCount || 0) + 1;
}
function grantAchievement(userId, achId) {
  if (!userAch.has(userId)) userAch.set(userId, new Map());
  userAch.get(userId).set(parseInt(achId, 10), Date.now());
}
function getLeaderboard() {
  return [...users.values()]
    .map((u) => ({ nick: u.nick || 'Аноним', xp: u.points || 0, level: u.level || 1, calls: u.convCount || 0 }))
    .sort((a, b) => b.xp - a.xp || b.calls - a.calls).slice(0, 10)
    .map((r, i) => ({ rank: i + 1, ...r }));
}
function todayProgress(id) {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const rows = activityLogs.filter((l) => l.userId === id && l.type === 'call' && l.createdAt >= start);
  let minutes = 0; rows.forEach((r) => { minutes += Math.floor((parseInt(String(r.info), 10) || 0) / 60); });
  return { minutes, calls: rows.length };
}
// Имя отличается от analytics-функции dayKey(d) ниже (иначе hoisting ломал челленджи).
function todayKey() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function getChallenges(id) {
  const prog = todayProgress(id); const day = todayKey();
  return CHALLENGES.map((c) => {
    const cur = c.kind === 'minutes' ? prog.minutes : prog.calls;
    return { kind: c.kind, name: c.name, target: c.target, progress: Math.min(cur, c.target), reward: c.reward, done: cur >= c.target, claimed: claims.has(id + '|' + day + '|' + c.kind) };
  });
}
function claimChallenge(id, kind) {
  const c = CHALLENGES.find((x) => x.kind === kind);
  if (!c) return { ok: false, error: 'Неизвестный челлендж' };
  const prog = todayProgress(id); const cur = c.kind === 'minutes' ? prog.minutes : prog.calls;
  if (cur < c.target) return { ok: false, error: 'Челлендж ещё не выполнен' };
  const key = id + '|' + todayKey() + '|' + kind;
  if (claims.has(key)) return { ok: false, error: 'Бонус уже получен' };
  claims.add(key); const st = addXp(id, c.reward);
  return { ok: true, reward: c.reward, points: st ? st.points : 0, level: st ? st.level : 1 };
}
function getFullStats(id) {
  const s = getUserStats(id);
  const cur = 25 * (s.level - 1) * s.level, next = 25 * s.level * (s.level + 1);
  return {
    stats: { totalMinutes: Math.floor(s.totalDuration / 60), totalCalls: s.convCount, xp: s.xp, level: s.level, curLevelXp: cur, nextLevelXp: next, toNext: Math.max(0, next - s.xp), avgRating: getAvgRating(id).avg, ratingCount: getAvgRating(id).count },
    achievements: getAchievements(id), challenges: getChallenges(id), leaderboard: getLeaderboard(),
  };
}

// --- Реакции ---
const ratings = []; // { fromId, toId, rating, createdAt }
function getAvgRating(id) {
  const rs = ratings.filter((r) => r.toId === id);
  if (!rs.length) return { avg: 0, count: 0 };
  const avg = rs.reduce((s, r) => s + r.rating, 0) / rs.length;
  return { avg: Math.round(avg * 100) / 100, count: rs.length };
}
function addRating(fromId, toId, rating) {
  const r = Math.max(1, Math.min(5, parseInt(rating, 10) || 0));
  if (!toId || !r) return null;
  ratings.push({ fromId: fromId || '', toId, rating: r, createdAt: Date.now() });
  return getAvgRating(toId);
}
// Полная очистка тестовой базы. Каталог достижений системный и находится
// отдельно, поэтому он не затрагивается.
function resetStats() {
  users.clear();
  reports.length = 0;
  adminLogs.length = 0;
  ratings.length = 0;
  activityLogs.length = 0;
  messages.length = 0;
  reactions.length = 0;
  userAch.clear();
  claims.clear();
  reportSeq = 1;
  return true;
}

function addReaction(userId, msgId, emoji) {
  reactions.push({ userId, msgId: String(msgId).slice(0, 64), emoji: String(emoji).slice(0, 16), createdAt: Date.now() });
}
function getReactions(msgId) {
  return reactions.filter((r) => r.msgId === String(msgId).slice(0, 64)).sort((a, b) => a.createdAt - b.createdAt);
}

// --- Аналитика ---
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function getAnalytics(fromMs, toMs) {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const to = toMs || now, from = fromMs || (to - 30 * day);
  const totalUsers = users.size;
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  let todayNew = 0, newInRange = 0;
  for (const u of users.values()) {
    if (u.createdAt >= startToday.getTime()) todayNew++;
    if (u.createdAt >= from && u.createdAt <= to) newInRange++;
  }
  const allR = ratings.map((r) => r.rating);
  const avgRating = allR.length ? Math.round((allR.reduce((s, x) => s + x, 0) / allR.length) * 100) / 100 : 0;
  const uniqSet = new Set();
  const hours = new Array(24).fill(0);
  const byDay = {};
  activityLogs.forEach((l) => {
    if (l.type === 'login' && l.createdAt >= from && l.createdAt <= to) {
      uniqSet.add(l.userId);
      const d = new Date(l.createdAt); hours[d.getHours()]++;
      const k = dayKey(d); byDay[k] = (byDay[k] || 0) + 1;
    }
  });
  const visitsByDay = Object.keys(byDay).sort().map((k) => ({ day: k, n: byDay[k] }));
  const rSum = {}, rCnt = {};
  ratings.forEach((r) => {
    if (r.createdAt >= from && r.createdAt <= to) {
      const k = dayKey(new Date(r.createdAt)); rSum[k] = (rSum[k] || 0) + r.rating; rCnt[k] = (rCnt[k] || 0) + 1;
    }
  });
  const ratingByDay = Object.keys(rCnt).sort().map((k) => ({ day: k, avg: Math.round((rSum[k] / rCnt[k]) * 100) / 100, n: rCnt[k] }));
  const cityMap = {};
  for (const u of users.values()) if (u.city) cityMap[u.city] = (cityMap[u.city] || 0) + 1;
  const cities = Object.entries(cityMap).map(([city, n]) => ({ city, n })).sort((a, b) => b.n - a.n).slice(0, 20);
  return {
    range: { from, to },
    cards: { totalUsers, todayNew, avgRating, uniqueInRange: uniqSet.size, newInRange },
    visitsByDay, hours, cities, ratingByDay,
  };
}

module.exports = {
  db: null,
  getOrCreateUser, getUser, getUserByNick, getAccountByEmail, getAccountByUserId, getAccountById, getAccountByReset, createAccount, markAccountLogin, setAccountResetToken, updateAccountPassword, saveProfile, setSubscription, activePlan,
  banUser, setRole, touch, addReport, addAdminLog, addActivity, addMessage, getMessages,
  pruneMessages, recordConversation, getUserStats, addXp, checkAchievements, getAchievements,
  getLeaderboard, getChallenges, claimChallenge, getFullStats, addReaction, getReactions, getAnalytics, getStats,
  addRating, getAvgRating, resetStats,
  incGroup, incTopic, incPhoto, recordCallExtras, grantAchievement,
  allUsers: () => [...users.values()]
    .map((u) => { const r = getAvgRating(u.id); return { ...u, avgRating: r.avg || null, ratingCount: r.count }; })
    .sort((a, b) => b.createdAt - a.createdAt),
  allReports: () => reports.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 200),
  allAdminLogs: () => adminLogs.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 200),
  allActivity: () => activityLogs.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 200),
  setReportHandled,
};
