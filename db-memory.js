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
let reportSeq = 1;

function defaultUser(id) {
  const now = Date.now();
  return {
    id, nick: '', gender: 'male', age: 18, city: 'Москва',
    subscription: 'free', subscriptionExpiry: null, role: 'user', isBanned: 0,
    avatar: '', description: '', theme: 'default', interests: '',
    zodiac: '', profession: '', height: 0,
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

module.exports = {
  db: null,
  getOrCreateUser, getUser, getUserByNick, saveProfile, setSubscription, activePlan,
  banUser, setRole, touch, addReport, addAdminLog, addActivity, addMessage, getMessages,
  pruneMessages, getStats,
  allUsers: () => [...users.values()].sort((a, b) => b.createdAt - a.createdAt),
  allReports: () => reports.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 200),
  allAdminLogs: () => adminLogs.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 200),
  allActivity: () => activityLogs.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, 200),
  setReportHandled,
};
