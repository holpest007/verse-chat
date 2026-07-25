# Как выложить проект в интернет (Verse Team)

Приложение — это **сервер на Node.js** (не просто статичные файлы), поэтому нужен хостинг
с поддержкой Node.js. Тогда сайт откроется в любом браузере: Chrome, Safari, Yandex, Firefox
и т.д. — отдельно «загружать в Яндекс/Google» ничего не нужно, это один сайт по одному адресу.

## Важно про голосовой чат
Голос и микрофон (WebRTC) работают **только по HTTPS** (или на localhost). Любой нормальный
хостинг даёт HTTPS автоматически. Для звонков между людьми из разных сетей нужен **TURN-сервер**
(см. пункт 5) — без него текст/группы работают, а голос может не соединяться.

---

## Требования
- Node.js версии **22 или новее** (в проекте используется встроенный SQLite `node:sqlite`).
- Файлы проекта из папки `chat-app`.

## Вариант A — проще всего (рекомендую для старта): Render или Railway
PaaS-платформы: сами ставят зависимости, дают HTTPS-домен, кнопка Deploy из GitHub.

1. Залейте папку `chat-app` в репозиторий на GitHub (без `.env`, `node_modules`, `data.db` —
   они уже в `.gitignore`).
2. Зарегистрируйтесь на **render.com** (или **railway.app**).
3. New → Web Service → подключите репозиторий.
4. Настройки:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Node version: 22+ (в `package.json` уже указано `engines: node >=22`).
5. В разделе **Environment** добавьте переменные (то, что у вас в `.env`):
   - `ADMIN_LOGIN`, `ADMIN_PASSWORD` (можно несколько пар — как в `.env`)
   - `JWT_SECRET` — длинная случайная строка
   - (позже) `TURN_URL`, `TURN_USER`, `TURN_PASS`
6. Deploy. Получите адрес вида `https://verse-team.onrender.com` — это и есть ваш сайт.

> Минус бесплатных тарифов PaaS: файловая система временная — база `data.db` может обнуляться
> при перезапуске. Для постоянных данных возьмите платный план с диском (Persistent Disk) или
> вынесите базу на управляемую БД. На старте для теста — сойдёт.

## Вариант B — свой сервер (VPS), полный контроль
Подходит: **Timeweb, Reg.ru, Selectel** (РФ) или **Hetzner, DigitalOcean** (дешёвые). ~200–500 ₽/мес.

1. Возьмите VPS с Ubuntu.
2. Установите Node.js 22+:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```
3. Скопируйте проект на сервер (через git или scp), в папке выполните:
   ```bash
   npm install
   ```
4. Создайте `.env` (логин/пароль админа, JWT_SECRET).
5. Запустите под менеджером процессов, чтобы работало постоянно:
   ```bash
   sudo npm install -g pm2
   pm2 start server.js --name verse
   pm2 save && pm2 startup
   ```
6. Купите домен, направьте его A-записью на IP сервера.
7. Поставьте **Nginx** как обратный прокси + бесплатный HTTPS (Let's Encrypt):
   ```bash
   sudo apt install -y nginx certbot python3-certbot-nginx
   sudo certbot --nginx -d ваш-домен.ru
   ```
   Nginx проксирует порт 443 → на приложение (порт 3000), с поддержкой WebSocket.

Пример блока Nginx (в `/etc/nginx/sites-available/verse`):
```
server {
  server_name ваш-домен.ru;
  location / {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
  }
}
```

## 5. TURN-сервер для голоса (нужен на проде)
Без TURN звонки между разными сетями/операторами могут не соединяться.
- Простой путь: платный TURN, например **metered.ca** (есть бесплатный лимит) — дают
  URL/логин/пароль, вписываете в `.env` (`TURN_URL`, `TURN_USER`, `TURN_PASS`).
- Свой путь: поставить **coturn** на том же VPS.

## 6. Оплата (когда будете включать)
Сейчас все функции открыты, тарифы показывают «Soon». Чтобы включить платный режим:
- В `server.js` поставьте `OPEN_ALL = false`.
- В `public/app.js` верните `isPremium` на проверку тарифа и цены/кнопки оплаты.
- Подключите ЮKassa (нужны мерчант-ключи и webhook на ваш HTTPS-домен) в обработчике `sub:buy`.

## Итог по шагам
1. Node.js 22+ на хостинге.
2. `npm install` → `npm start`.
3. HTTPS-домен (на PaaS автоматически, на VPS — Nginx + certbot).
4. Переменные окружения из `.env`.
5. TURN для голоса.
6. Готово — сайт открывается во всех браузерах.
