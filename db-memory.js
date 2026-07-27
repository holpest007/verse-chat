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

function defaultUser(id) {
  const now = Date.now();
  return {
    id, nick: '', gender: 'male', age: 18, city: 'Москва',
    subscription: 'free', subscriptionExpiry: null, role: 'user', isBanned: 0,
    avatar: '', description: '', theme: 'default', interests: '',
    zodiac: '', profession: '', height: 0,
    convCount: 0, totalDuration: 0, points: 0, level: 1,
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
  { id: 1, name: 'Первый разговор', description: 'Проведите свой первый разговор', icon: 'fa-comment-dots', condition_type: 'calls', condition_value: 1 },
  { id: 2, name: 'Разговорчивый', description: '10 разговоров', icon: 'fa-comments', condition_type: 'calls', condition_value: 10 },
  { id: 3, name: 'Легенда общения', description: '100 разговоров', icon: 'fa-crown', condition_type: 'calls', condition_value: 100 },
  { id: 4, name: 'Час в эфире', description: '100 минут в чате', icon: 'fa-clock', condition_type: 'minutes', condition_value: 100 },
  { id: 5, name: 'Марафонец', description: '500 минут в чате', icon: 'fa-hourglass-half', condition_type: 'minutes', condition_value: 500 },
  { id: 6, name: 'Восходящая звезда', description: 'Достигните 5 уровня', icon: 'fa-star', condition_type: 'level', condition_value: 5 },
  { id: 7, name: 'Мастер общения', description: 'Достигните 10 уровня', icon: 'fa-medal', condition_type: 'level', condition_value: 10 },
];
const userAch = new Map();       // user_id -> Map(achId -> unlockedAt)
const claims = new Set();        // "user|day|kind"
const CHALLENGES = [
  { kind: 'minutes', name: 'Проведи 30 минут в чате сегодня', target: 30, reward: 50 },
  { kind: 'calls', name: 'Проведи 3 разговора сегодня', target: 3, reward: 30 },
];
function achCond(u, a) {
  const minutes = Math.floor((u.totalDuration || 0) / 60);
  if (a.condition_type === 'calls') return (u.convCount || 0) >= a.condition_value;
  if (a.condition_type === 'minutes') return minutes >= a.condition_value;
  return (u.level || 1) >= a.condition_value;
}
function checkAchievements(id) {
  const u = getUser(id); if (!u) return [];
  if (!userAch.has(id)) userAch.set(id, new Map());
  const have = userAch.get(id);
  const newly = [];
  for (const a of ACHIEVEMENTS) if (!have.has(a.id) && achCond(u, a)) { have.set(a.id, Date.now()); newly.push(a); }
  return newly;
}
function getAchievements(id) {
  const u = getUser(id) || {};
  const minutes = Math.floor((u.totalDuration || 0) / 60);
  const have = userAch.get(id) || new Map();
  return ACHIEVEMENTS.map((a) => {
    const cur = a.condition_type === 'calls' ? (u.convCount || 0) : a.condition_type === 'minutes' ? minutes : (u.level || 1);
    return { id: a.id, name: a.name, description: a.description, icon: a.icon, target: a.condition_value, progress: Math.min(cur, a.condition_value), unlocked: have.has(a.id), unlockedAt: have.get(a.id) || null };
  });
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
function dayKey() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function getChallenges(id) {
  const prog = todayProgress(id); const day = dayKey();
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
  const key = id + '|' + dayKey() + '|' + kind;
  if (claims.has(key)) return { ok: false, error: 'Бонус уже получен' };
  claims.add(key); const st = addXp(id, c.reward);
  return { ok: true, reward: c.reward, points: st ? st.points : 0, level: st ? st.level : 1 };
}
function getFullStats(id) {
  const s = getUserStats(id);
  const cur = 25 * (s.level - 1) * s.level, next = 25 * s.level * (s.level + 1);
  return {
    stats: { totalMinutes: Math.floor(s.totalDuration / 60), totalCalls: s.convCount, xp: s.xp, level: s.level, curLevelXp: cur, nextLevelXp: next, toNext: Math.max(0, next - s.xp) },
    achievements: getAchievements(id), challenges: getChallenges(id), leaderboard: getLeaderboard(),
  };
}

// --- Реакции ---
function addReaction(userId, msgId, emoji) {
  reactions.push({ userId, msgId: String(msgId).slice(0, 64), emoji: String(emoji).slice(0, 16), createdAt: Date.now() });
}
function getReactions(msgId) {
  return reactions.filter((r) => r.msgId === String(msgId).slice(0, 64)).sort((a, b) => a.createdAt - b.createdAt);
}

// --- Аналитика ---
function getAnalytics() {
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const uniq = (since) => {
    const set = new Set();
    activityLogs.forEach((l) => { if (l.type === 'login' && l.createdAt >= since) set.add(l.userId); });
    return set.size;
  };
  const hours = new Array(24).fill(0);
  activityLogs.forEach((l) => {
    if (l.type === 'login' && l.createdAt >= now - 30 * day) hours[new Date(l.createdAt).getHours()]++;
  });
  const cityMap = {};
  for (const u of users.values()) if (u.city) cityMap[u.city] = (cityMap[u.city] || 0) + 1;
  const cities = Object.entries(cityMap).map(([city, n]) => ({ city, n })).sort((a, b) => b.n - a.n).slice(0, 10);
  return { unique: { day: uniq(now - day), week: uniq(now - 7 * day), month: uniq(now - 30 * day) }, hours, cities };
}

module.exports = {
  db: null,
  getOrCreateUser, getUser, getUserByNick, saveProfile, setSubscription, activePlan,
  banUser, setRole, touch, addReport, addAdminLog, addActivity, addMessage, getMessages,
  pruneMessages, recordConversation, getUserStats, addXp, checkAchievements, getAchievements,
  getLeaderboard, getChallenges, claimChallenge, getFullStats, addReaction, getReactions, getAnalytics, getStats,
  allUsers: () => [...users.values()].sort((a, b) => b.createdAt - a.createdAt),
  allReports: () => reports.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 200),
  allAdminLogs: () => adminLogs.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 200),
  allActivity: () => activityLogs.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 200),
  setReportHandled,
};
