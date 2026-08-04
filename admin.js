// ============================================================================
//  admin.js — админ-панель: вход по логину/паролю, JWT-защита, API.
//  Роли: superAdmin (основатель, вход из .env) и admin (назначается в панели).
//  Все действия администраторов пишутся в таблицу admin_logs.
// ============================================================================

const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const db = require('./db');

// --- Простейшая загрузка .env без внешних пакетов ---
(function loadEnv() {
  try {
    const p = path.join(__dirname, '.env');
    if (!fs.existsSync(p)) return;
    fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line) => {
      if (/^\s*#/.test(line) || !line.trim()) return;      // пропускаем комментарии
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    });
  } catch (e) { /* игнорируем */ }
})();

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';

// Читаем ВСЕХ администраторов из .env (можно несколько пар логин/пароль).
// Поддерживаются оба формата:
//   ADMIN_LOGIN / ADMIN_PASSWORD  (можно повторять несколько раз подряд)
//   ADMIN1_LOGIN / ADMIN1_PASSWORD, ADMIN2_LOGIN / ADMIN2_PASSWORD, ...
// Логины и пароли берутся по порядку и объединяются в пары.
function parseAdmins() {
  const admins = [];
  try {
    const p = path.join(__dirname, '.env');
    if (fs.existsSync(p)) {
      const logins = [];
      const passwords = [];
      fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line) => {
        if (/^\s*#/.test(line) || !line.trim()) return;
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
        if (!m) return;
        const key = m[1].toUpperCase();
        if (key === 'ADMIN_LOGIN' || /^ADMIN\d+_LOGIN$/.test(key)) logins.push(m[2]);
        else if (key === 'ADMIN_PASSWORD' || /^ADMIN\d+_PASSWORD$/.test(key)) passwords.push(m[2]);
      });
      for (let i = 0; i < logins.length; i++) {
        if (logins[i] && passwords[i] !== undefined) {
          admins.push({ login: logins[i], password: passwords[i] });
        }
      }
    }
  } catch (e) { /* игнорируем */ }
  // Если в .env ничего не задано — временный доступ admin/admin
  if (admins.length === 0) admins.push({ login: 'admin', password: 'admin' });
  return admins;
}
const ADMINS = parseAdmins();

// Кеш аналитики: ключ = «from|to», значение = { t, data }. TTL 5 минут —
// раздел открывается мгновенно, тяжёлые агрегаты не считаются на каждый заход.
const analyticsCache = new Map();
const ANALYTICS_TTL = 5 * 60 * 1000;

// Хуки из основного сервера (например, разрыв сессий забаненного)
let hooks = { kickUser: () => {} };

// Middleware: проверка «пропуска» (JWT) для защищённых эндпоинтов
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Требуется вход' });
  try {
    req.admin = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Сессия истекла, войдите заново' });
  }
}

// Middleware: только для главного администратора
function superOnly(req, res, next) {
  if (req.admin.role !== 'superAdmin') {
    return res.status(403).json({ error: 'Доступно только главному администратору' });
  }
  next();
}

function mount(app, io, providedHooks) {
  if (providedHooks) hooks = providedHooks;

  // В админке используем тот же принцип, что и на главной странице:
  // несколько вкладок/сессий с одного IP считаются одним активным устройством.
  function onlineDeviceCount() {
    const devices = new Set();
    for (const socket of io.sockets.sockets.values()) {
      const ip = socket.data && socket.data.clientIp;
      const uuid = socket.data && socket.data.uuid;
      if (ip) devices.add('ip:' + ip);
      else if (uuid) devices.add('uuid:' + uuid);
    }
    return devices.size;
  }

  // --- Вход: проверка логина/пароля, выдача JWT ---
  app.post('/admin/api/login', (req, res) => {
    const { login, password } = req.body || {};
    const match = ADMINS.find((a) => a.login === login && a.password === password);
    if (match) {
      const token = jwt.sign({ login: match.login, role: 'superAdmin' }, JWT_SECRET, { expiresIn: '12h' });
      db.addAdminLog(match.login, 'login', '');
      return res.json({ ok: true, token, role: 'superAdmin', login: match.login });
    }
    res.status(401).json({ ok: false, error: 'Неверный логин или пароль' });
  });

  // --- Дашборд: общая статистика ---
  app.get('/admin/api/stats', auth, (req, res) => {
    const stats = db.getStats();
    stats.online = onlineDeviceCount(); // уникальные активные устройства
    res.json(stats);
  });

  // --- Пользователи ---
  app.get('/admin/api/users', auth, (req, res) => {
    res.json(db.allUsers());
  });

  // Бан / разбан. При бане разрываем все сессии пользователя.
  app.post('/admin/api/users/:id/ban', auth, (req, res) => {
    const banned = !!(req.body && req.body.banned);
    db.banUser(req.params.id, banned);
    db.addAdminLog(req.admin.login, banned ? 'ban' : 'unban', req.params.id);
    if (banned) hooks.kickUser(req.params.id);
    res.json({ ok: true });
  });

  // --- Жалобы ---
  app.get('/admin/api/reports', auth, (req, res) => {
    res.json(db.allReports());
  });
  app.post('/admin/api/reports/:id/handle', auth, (req, res) => {
    db.setReportHandled(req.params.id);
    db.addAdminLog(req.admin.login, 'report_handled', String(req.params.id));
    res.json({ ok: true });
  });

  // --- Администраторы (просмотр всем админам, изменение — только superAdmin) ---
  app.get('/admin/api/admins', auth, (req, res) => {
    res.json(db.allUsers().filter((u) => u.role && u.role !== 'user'));
  });
  app.post('/admin/api/admins', auth, superOnly, (req, res) => {
    const { query, role } = req.body || {};
    if (!['user', 'admin', 'superAdmin'].includes(role)) {
      return res.status(400).json({ error: 'Неверная роль' });
    }
    // Ищем пользователя по ID или по нику
    const user = db.getUser(query) || db.getUserByNick(query);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    db.setRole(user.id, role);
    db.addAdminLog(req.admin.login, 'set_role:' + role, user.id);
    res.json({ ok: true });
  });

  // --- Логи (действия админов + активность пользователей) ---
  app.get('/admin/api/logs', auth, (req, res) => {
    res.json({ admin: db.allAdminLogs(), activity: db.allActivity() });
  });

  // --- Аналитика по диапазону дат (?from=&to= в мс). Кеш 5 мин; ?fresh=1 — обход. ---
  app.get('/admin/api/analytics', auth, (req, res) => {
    const to = parseInt(req.query.to, 10) || Date.now();
    const from = parseInt(req.query.from, 10) || (to - 30 * 24 * 60 * 60 * 1000);
    const fresh = req.query.fresh === '1';
    const key = from + '|' + to;
    // «Онлайн сейчас» считаем свежим на каждый ответ (не кешируем)
    const respond = (data, cachedFlag) => res.json({ ...data, online: onlineDeviceCount(), cached: !!cachedFlag });
    try {
      const cached = analyticsCache.get(key);
      if (!fresh && cached && (Date.now() - cached.t) < ANALYTICS_TTL) {
        return respond(cached.data, true);
      }
      const data = db.getAnalytics(from, to);
      analyticsCache.set(key, { t: Date.now(), data });
      respond(data, false);
    } catch (e) {
      res.json({ range: { from, to }, cards: {}, visitsByDay: [], hours: new Array(24).fill(0), cities: [], ratingByDay: [], online: 0 });
    }
  });

  // --- Полная очистка тестовой базы (только главный админ). ---
  app.post('/admin/api/reset-stats', auth, superOnly, (req, res) => {
    try {
      const cleared = db.resetStats();
      analyticsCache.clear(); // сброшенные данные больше не отдаём из кеша
      // Убираем активные тестовые сессии из памяти сервера, чтобы они не
      // продолжили отправлять события уже после очистки базы.
      for (const client of io.sockets.sockets.values()) client.disconnect(true);
      db.addAdminLog(req.admin.login, 'reset_all_test_data', '');
      res.json({ ok: true, cleared });
    } catch (e) {
      res.status(500).json({ ok: false, error: 'Не удалось сбросить статистику' });
    }
  });

  // --- Сама страница админ-панели ---
  app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  });
}

module.exports = { mount };
