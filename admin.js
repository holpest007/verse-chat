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
    stats.online = io.engine.clientsCount || 0; // активные подключения прямо сейчас
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

  // --- Сама страница админ-панели ---
  app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  });
}

module.exports = { mount };
