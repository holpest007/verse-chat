/* ==========================================================================
   app.js — клиентская логика «Nyme chat» (ванильный JS)
     - переключение вкладок нижней навигацией (SPA)
     - выбор страны с флагом
     - множественный выбор пола/возраста (плашки-чипы)
     - голос через WebRTC, текст и группы через Socket.IO
   ========================================================================== */

// Постоянный анонимный идентификатор пользователя (хранится локально).
// По нему сервер узнаёт нас между сессиями: профиль, подписка, роль.
function getUUID() {
  let id = localStorage.getItem('vt_uuid');
  if (!id) {
    id = (crypto.randomUUID && crypto.randomUUID()) ||
      ('u-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    localStorage.setItem('vt_uuid', id);
  }
  return id;
}

// Подключаемся к серверу, передавая свой UUID
const socket = io({ auth: { uuid: getUUID() } });

// Текущая подписка и роль пользователя (обновляются сервером через событие 'me')
let myPlan = 'free';
let myRole = 'user';
socket.on('me', (info) => {
  myPlan = info.subscription || 'free';
  myRole = info.role || 'user';
  updatePremiumUI();
});
socket.on('banned', () => {
  document.body.innerHTML =
    '<div style="display:flex;height:100vh;align-items:center;justify-content:center;color:#e0524a;font:600 20px Inter,sans-serif;text-align:center;padding:24px">Ваш аккаунт заблокирован администрацией.</div>';
});

// Конфигурация WebRTC. Подтягиваем ICE-серверы (STUN/TURN) с сервера —
// на проде TURN задаётся в .env и нужен для звонков между разными сетями.
const RTC_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
fetch('/rtc-config').then((r) => r.json()).then((c) => {
  if (c && Array.isArray(c.iceServers)) RTC_CONFIG.iceServers = c.iceServers;
}).catch(() => {});

// Города России для поля с поиском по вводу
const CITIES = [
  'Москва', 'Санкт-Петербург', 'Новосибирск', 'Екатеринбург', 'Казань',
  'Нижний Новгород', 'Челябинск', 'Красноярск', 'Самара', 'Уфа',
  'Ростов-на-Дону', 'Краснодар', 'Омск', 'Воронеж', 'Пермь',
  'Волгоград', 'Саратов', 'Тюмень', 'Тольятти', 'Барнаул',
  'Ижевск', 'Ульяновск', 'Иркутск', 'Хабаровск', 'Махачкала',
  'Ярославль', 'Владивосток', 'Оренбург', 'Томск', 'Кемерово',
  'Новокузнецк', 'Рязань', 'Астрахань', 'Пенза', 'Липецк',
  'Тула', 'Киров', 'Чебоксары', 'Калининград', 'Курск',
  'Улан-Удэ', 'Ставрополь', 'Магнитогорск', 'Тверь', 'Иваново',
  'Брянск', 'Белгород', 'Сургут', 'Владимир', 'Нижний Тагил',
  'Архангельск', 'Чита', 'Симферополь', 'Калуга', 'Смоленск',
  'Волжский', 'Курган', 'Орёл', 'Череповец', 'Вологда',
  'Владикавказ', 'Мурманск', 'Саранск', 'Якутск', 'Тамбов',
  'Грозный', 'Стерлитамак', 'Кострома', 'Петрозаводск', 'Нижневартовск',
  'Новороссийск', 'Йошкар-Ола', 'Таганрог', 'Комсомольск-на-Амуре', 'Сыктывкар',
  'Нальчик', 'Шахты', 'Дзержинск', 'Орск', 'Братск',
  'Ангарск', 'Энгельс', 'Благовещенск', 'Великий Новгород', 'Старый Оскол',
  'Королёв', 'Псков', 'Бийск', 'Прокопьевск', 'Балашиха',
  'Армавир', 'Рыбинск', 'Северодвинск', 'Абакан', 'Петропавловск-Камчатский',
  'Норильск', 'Сочи', 'Уссурийск', 'Волгодонск', 'Каменск-Уральский',
  'Новочеркасск', 'Златоуст', 'Электросталь', 'Альметьевск', 'Салават',
  'Миасс', 'Керчь', 'Копейск', 'Пятигорск', 'Майкоп',
  'Коломна', 'Одинцово', 'Химки', 'Мытищи', 'Люберцы',
  'Хасавюрт', 'Домодедово', 'Нефтеюганск', 'Березники', 'Каспийск',
  'Троицк',
];
// Города — по алфавиту (русская локаль)
CITIES.sort((a, b) => a.localeCompare(b, 'ru'));

// Флаг России (SVG) — для карточек собеседника на экранах разговора
const RF_FLAG =
  '<svg viewBox="0 0 30 22"><rect width="30" height="7.33" fill="#fff"/><rect y="7.33" width="30" height="7.33" fill="#0039A6"/><rect y="14.66" width="30" height="7.34" fill="#D52B1E"/></svg>';

// Текст возрастного диапазона по выбранным фильтрам (для экрана поиска)
const AGE_RANGE_RU = { '18-24': 'от 18 до 24 лет', '25-32': 'от 25 до 32 лет', '33': 'старше 33 лет' };
function ageRangeText(ages) {
  if (!ages || ages.length === 0) return 'любой возраст';
  return ages.map((a) => AGE_RANGE_RU[a]).join(', ');
}
// Разметка «флаг + Российская Федерация» для карточки собеседника
function peerInfoHTML(partner) {
  return `<span class="cflag">${RF_FLAG}</span> ${partner.country} · ${partner.age}`;
}

const $ = (sel) => document.querySelector(sel);
const GENDER_RU = { female: 'Женский', male: 'Мужской' };
const AGE_RU = { '18-24': '18–24', '25-32': '25–32', '33': '33+' };

// ==========================================================================
//  СКЛОНЕНИЕ СЛОВА «пользователь» (для счётчика онлайн)
// ==========================================================================
function pluralUsers(n, tail = 'онлайн') {
  const mod10 = n % 10, mod100 = n % 100;
  let word;
  if (mod10 === 1 && mod100 !== 11) word = 'пользователь';
  else if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) word = 'пользователя';
  else word = 'пользователей';
  return `${n.toLocaleString('ru-RU')} ${word} ${tail}`;
}

// ==========================================================================
//  ТОСТЫ
// ==========================================================================
function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ==========================================================================
//  ПОЛЕ ГОРОДА С ПОИСКОМ ПО ВВОДУ (автокомплит)
// ==========================================================================
function setupCity(inputId, listId) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  input.value = 'Москва'; // город по умолчанию

  // Отрисовать список подходящих городов по введённому тексту
  function renderList(query) {
    const q = query.trim().toLowerCase();
    // Показываем совпадения (максимум 8). Пустой запрос — первые города списка.
    const matches = (q
      ? CITIES.filter((c) => c.toLowerCase().includes(q))
      : CITIES
    ).slice(0, 8);

    list.innerHTML = '';
    if (matches.length === 0) {
      list.classList.add('hidden');
      return;
    }
    matches.forEach((city) => {
      const item = document.createElement('div');
      item.className = 'city-item';
      item.textContent = city;
      // mousedown, а не click — чтобы сработало раньше события blur
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        input.value = city;
        list.classList.add('hidden');
        input.dispatchEvent(new Event('input')); // чтобы сработало сохранение (профиль)
      });
      list.appendChild(item);
    });
    list.classList.remove('hidden');
  }

  input.addEventListener('focus', () => renderList(input.value));
  input.addEventListener('input', () => renderList(input.value));
  // Прячем список при потере фокуса
  input.addEventListener('blur', () => setTimeout(() => list.classList.add('hidden'), 100));
}
setupCity('voice-city', 'voice-city-list');
setupCity('text-city', 'text-city-list');

// ==========================================================================
//  ПЛАШКИ-ЧИПЫ С МНОЖЕСТВЕННЫМ ВЫБОРОМ
//  Для группы пола (data-single-any) «Любой» взаимоисключает остальные.
// ==========================================================================
document.querySelectorAll('.chips').forEach((group) => {
  const singleAny = group.dataset.singleAny === 'true';
  const single = group.dataset.single === 'true'; // ровно один активный (radio)
  group.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const val = chip.dataset.value;
      if (single) {
        // Одиночный выбор: снимаем все, выделяем один
        group.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        return;
      }
      if (singleAny) {
        if (val === 'any') {
          // Выбрали «Любой» — снимаем остальные
          group.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
          chip.classList.add('active');
          return;
        } else {
          // Выбрали конкретный пол — снимаем «Любой»
          const anyChip = group.querySelector('.chip[data-value="any"]');
          if (anyChip) anyChip.classList.remove('active');
        }
      }
      chip.classList.toggle('active');
      // Нельзя оставить группу совсем пустой — если пусто, вернём первую плашку
      if (!group.querySelector('.chip.active')) {
        group.querySelector('.chip').classList.add('active');
      }
    });
  });
});

// Собрать выбранные значения группы чипов в массив
function getChips(groupId) {
  return [...document.querySelectorAll('#' + groupId + ' .chip.active')].map((c) => c.dataset.value);
}

// Собрать все фильтры вкладки ('voice' | 'text')
function getFilters(prefix) {
  const f = {
    city: $('#' + prefix + '-city').value.trim() || 'Москва',
    genders: getChips(prefix + '-gender'),
    ages: getChips(prefix + '-age'),
  };
  // Премиум-фильтры (интересы + зодиак) — только для платных тарифов
  if (typeof isPremium === 'function' && isPremium()) {
    f.interests = [...document.querySelectorAll('#' + prefix + '-fint .ichip.on')].map((c) => c.dataset.v);
    const z = document.getElementById(prefix + '-fzodiac');
    f.zodiac = z ? z.value : 'any';
  }
  return f;
}

// ==========================================================================
//  ПЕРЕКЛЮЧЕНИЕ ВКЛАДОК (нижняя навигация, SPA)
// ==========================================================================
document.querySelectorAll('.nav-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    $('#panel-' + tab.dataset.tab).classList.add('active');
    // При открытии вкладки Premium перерисовываем тарифы (подсветка текущего)
    if (tab.dataset.tab === 'subs') renderSubs();
  });
});

// Программное переключение на вкладку по её data-tab
function switchTab(name) {
  const tab = document.querySelector('.nav-tab[data-tab="' + name + '"]');
  if (tab) tab.click();
}

// ==========================================================================
//  ОНЛАЙН-СЧЁТЧИКИ
// ==========================================================================
socket.on('counts', (c) => {
  $('#voice-online').textContent = pluralUsers(c.voice, 'в поиске');
  $('#text-online').textContent = pluralUsers(c.text, 'в поиске');
  $('#group-online').textContent = pluralUsers(c.group, 'онлайн');
});

// Экраны каждой вкладки
const SCREENS = {
  voice: ['setup', 'searching', 'call', 'ended'],
  text: ['setup', 'searching', 'chat', 'ended'],
};
// Показать один из экранов внутри вкладки
function showScreen(prefix, screen) {
  SCREENS[prefix].forEach((s) => {
    const el = $('#' + prefix + '-' + s);
    if (el) el.classList.toggle('hidden', s !== screen);
  });
}

// ==========================================================================
//  ТАЙМЕРЫ (поиск и разговор), формат MM:SS
// ==========================================================================
function fmtTime(sec) {
  const m = String(Math.floor(sec / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return m + ':' + s;
}
const timers = {}; // name -> intervalId
function startTimer(name, elSel) {
  stopTimer(name);
  let t = 0;
  $(elSel).textContent = '00:00';
  timers[name] = setInterval(() => {
    t++;
    const el = $(elSel);
    if (el) el.textContent = fmtTime(t);
  }, 1000);
}
function stopTimer(name) {
  if (timers[name]) { clearInterval(timers[name]); delete timers[name]; }
}

// ==========================================================================
//  ГОЛОСОВОЙ ЧАТ (1 на 1, WebRTC)
// ==========================================================================
let voicePC = null;
let localStream = null;
let voicePeerId = null;
let currentMode = null; // 'voice' | 'text' — для модалок жалобы/правил

async function getMic() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  return localStream;
}

function createVoicePC(peerId) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  // Исходящий звук может быть обработан голосовым эффектом (премиум)
  const out = getOutgoingStream();
  out.getAudioTracks().forEach((track) => pc.addTrack(track, out));
  pc.ontrack = (e) => { $('#voice-audio').srcObject = e.streams[0]; };
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { to: peerId, data: { candidate: e.candidate } });
  };
  return pc;
}

// Начать поиск голосового собеседника
async function startVoiceSearch() {
  try { await getMic(); }
  catch (err) { toast('Нет доступа к микрофону'); return; }
  const f = getFilters('voice');
  $('#voice-search-info').innerHTML =
    `<span class="sline"><span class="cflag">${RF_FLAG}</span> Российская Федерация</span><span class="sline">${ageRangeText(f.ages)}</span>`;
  showScreen('voice', 'searching');
  startTimer('voiceSearch', '#voice-search-timer');
  socket.emit('voice:start', f);
}
$('#voice-start').addEventListener('click', startVoiceSearch);

$('#voice-cancel').addEventListener('click', () => {
  socket.emit('voice:stop');
  stopTimer('voiceSearch');
  showScreen('voice', 'setup');
});

// Завершить разговор своей кнопкой -> экран завершения
$('#voice-end').addEventListener('click', () => {
  socket.emit('voice:stop');
  closeVoice();
  showVoiceEnded('Вы завершили диалог');
});

// Кнопка «Микрофон» (mute/unmute своего звука)
$('#voice-mute').addEventListener('click', () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const btn = $('#voice-mute');
  btn.classList.toggle('muted', !track.enabled);
  btn.innerHTML = track.enabled
    ? '<i class="fa-solid fa-microphone"></i>'
    : '<i class="fa-solid fa-microphone-slash"></i>';
});

// Кнопка «Динамик» (вкл/выкл звук собеседника)
$('#voice-speaker').addEventListener('click', () => {
  const audio = $('#voice-audio');
  audio.muted = !audio.muted;
  const btn = $('#voice-speaker');
  btn.classList.toggle('muted', audio.muted);
  btn.innerHTML = audio.muted
    ? '<i class="fa-solid fa-volume-xmark"></i>'
    : '<i class="fa-solid fa-volume-high"></i>';
});

function closeVoice() {
  stopTimer('voiceCall');
  stopRecordingIfAny(); // сохранить запись, если велась
  if (voicePC) { voicePC.close(); voicePC = null; }
  voicePeerId = null;
  $('#voice-audio').srcObject = null;
}

// Показать экран завершения голосового разговора
function showVoiceEnded(msg) {
  stopTimer('voiceCall');
  stopTimer('voiceSearch');
  $('#voice-ended-msg').textContent = msg;
  showScreen('voice', 'ended');
}

socket.on('voice:none', () => toast('Собеседников пока нет'));

socket.on('voice:matched', (data) => {
  // Премиум: просмотр профиля собеседника ДО соединения (модалка)
  if (shouldPreview()) { showPreview('voice', data); return; }
  proceedVoiceMatch(data);
});

async function proceedVoiceMatch({ peerId, initiator, partner }) {
  voicePeerId = peerId;
  currentMode = 'voice';
  voicePC = createVoicePC(peerId);
  stopTimer('voiceSearch');
  $('#voice-peer-name').textContent = 'Разговор с ' + (partner.nick || 'собеседником');
  $('#voice-peer-info').innerHTML = peerInfoHTML(partner);
  // сброс кнопок mute/speaker
  $('#voice-mute').classList.remove('muted');
  $('#voice-mute').innerHTML = '<i class="fa-solid fa-microphone"></i>';
  $('#voice-speaker').classList.remove('muted');
  $('#voice-speaker').innerHTML = '<i class="fa-solid fa-volume-high"></i>';
  $('#voice-audio').muted = false;
  showScreen('voice', 'call');
  startTimer('voiceCall', '#voice-timer');
  startRecordingIfEnabled(); // премиум: запись своей стороны
  if (initiator) {
    const offer = await voicePC.createOffer();
    await voicePC.setLocalDescription(offer);
    socket.emit('signal', { to: peerId, data: { sdp: voicePC.localDescription } });
  }
}

// ==========================================================================
//  ОБРАБОТКА СИГНАЛОВ WebRTC (голос 1-на-1 и группы)
// ==========================================================================
socket.on('signal', async ({ from, data }) => {
  let pc = null;
  if (from === voicePeerId) pc = voicePC;
  else if (groupPeers[from]) pc = groupPeers[from].pc;
  if (!pc) return;

  if (data.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    if (data.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { to: from, data: { sdp: pc.localDescription } });
    }
  } else if (data.candidate) {
    try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); }
    catch (e) { /* игнорируем гонки кандидатов */ }
  }
});

socket.on('peer:left', () => {
  if (voicePeerId) {
    closeVoice();
    showVoiceEnded('Собеседник покинул чат');
  }
  if (textPeerId) {
    textPeerId = null;
    showTextEnded('Собеседник покинул чат');
  }
});

// ==========================================================================
//  ТЕКСТОВЫЙ ЧАТ (1 на 1)
// ==========================================================================
let textPeerId = null;

function addMessage(containerSel, text, who, author) {
  const box = $(containerSel);
  const el = document.createElement('div');
  el.className = 'msg ' + who;
  if (author) {
    const w = document.createElement('span');
    w.className = 'who';
    w.textContent = author;
    el.appendChild(w);
  }
  el.appendChild(document.createTextNode(text));
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

// Начать поиск текстового собеседника
function startTextSearch() {
  const f = getFilters('text');
  $('#text-search-info').innerHTML =
    `<span class="sline"><span class="cflag">${RF_FLAG}</span> Российская Федерация</span><span class="sline">${ageRangeText(f.ages)}</span>`;
  showScreen('text', 'searching');
  startTimer('textSearch', '#text-search-timer');
  socket.emit('text:start', f);
}
$('#text-start').addEventListener('click', startTextSearch);

$('#text-cancel').addEventListener('click', () => {
  socket.emit('text:stop');
  stopTimer('textSearch');
  showScreen('text', 'setup');
});

// Кнопка «назад» из переписки -> экран завершения
$('#text-end').addEventListener('click', () => {
  socket.emit('text:stop');
  textPeerId = null;
  showTextEnded('Вы завершили диалог');
});

// Показать экран завершения переписки
function showTextEnded(msg) {
  stopTimer('textSearch');
  $('#text-ended-msg').textContent = msg;
  showScreen('text', 'ended');
}

socket.on('text:none', () => toast('Собеседников пока нет'));

socket.on('text:matched', (data) => {
  if (shouldPreview()) { showPreview('text', data); return; }
  proceedTextMatch(data);
});

function proceedTextMatch({ peerId, partner }) {
  textPeerId = peerId;
  currentMode = 'text';
  stopTimer('textSearch');
  // очищаем историю, показываем плашку «Отправьте первое сообщение»
  $('#text-messages').innerHTML =
    '<div class="chat-empty" id="text-empty"><i class="fa-regular fa-comment"></i><span>Отправьте первое сообщение</span></div>';
  $('#text-peer-name').textContent = partner.nick || 'Собеседник';
  $('#text-peer-info').innerHTML = peerInfoHTML(partner);
  showScreen('text', 'chat');
}

// Убрать плашку пустого чата при первом сообщении
function clearTextEmpty() {
  const empty = document.getElementById('text-empty');
  if (empty) empty.remove();
}

$('#text-msg-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#text-msg-input');
  const text = input.value.trim();
  if (!text || !textPeerId) return;
  clearTextEmpty();
  socket.emit('text:message', { text });
  addMessage('#text-messages', text, 'me');
  input.value = '';
});

socket.on('text:message', ({ text }) => { clearTextEmpty(); addMessage('#text-messages', text, 'peer'); });

// ==========================================================================
//  ГРУППОВОЙ ЧАТ
// ==========================================================================
document.querySelectorAll('[data-group]').forEach((btn) => {
  btn.addEventListener('click', () => {
    $('#group-home').classList.add('hidden');
    $('#group-' + btn.dataset.group).classList.remove('hidden');
  });
});
document.querySelectorAll('[data-back]').forEach((btn) => {
  btn.addEventListener('click', () => {
    btn.closest('.group-form').classList.add('hidden');
    $('#group-home').classList.remove('hidden');
  });
});

let createdGroupCode = null;

$('#grp-max').addEventListener('input', (e) => { $('#grp-max-val').textContent = e.target.value; });

$('#grp-create-btn').addEventListener('click', () => {
  const name = $('#grp-name').value.trim() || 'Без названия';
  const open = $('#grp-open').checked;
  const max = parseInt($('#grp-max').value, 10);
  const gender = (getChips('grp-gender')[0]) || 'any'; // выбранный пол участников
  socket.emit('group:create', { name, open, max, gender }, (res) => {
    if (res.ok) {
      createdGroupCode = res.code;
      $('#grp-code').textContent = res.code;
      $('#grp-code-box').classList.remove('hidden');
      $('#grp-start-call').classList.remove('hidden');
      toast('Группа создана');
    }
  });
});

$('#grp-copy').addEventListener('click', () => {
  if (createdGroupCode) {
    navigator.clipboard.writeText(createdGroupCode)
      .then(() => toast('Код скопирован'))
      .catch(() => toast('Не удалось скопировать'));
  }
});

$('#grp-start-call').addEventListener('click', async () => {
  if (createdGroupCode) await enterGroupRoom(createdGroupCode);
});

// Ограничитель ввода кода: только латинские буквы, верхний регистр, ровно 6 символов
$('#join-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6);
});

$('#join-btn').addEventListener('click', async () => {
  const code = $('#join-code').value.trim().toUpperCase();
  if (code.length !== 6) { toast('Код должен состоять из 6 букв'); return; }
  await enterGroupRoom(code);
});

$('#find-btn').addEventListener('click', () => {
  const size = $('#find-size').value;
  socket.emit('group:find', { size }, async (res) => {
    if (res.ok) { await getMicSafe(); }
    else toast(res.error || 'Группа не найдена');
  });
});

async function getMicSafe() {
  try { await getMic(); }
  catch (e) { toast('Нет доступа к микрофону'); }
}

async function enterGroupRoom(code) {
  try { await getMic(); }
  catch (e) { toast('Нет доступа к микрофону'); return; }
  socket.emit('group:join', { code }, (res) => {
    if (!res.ok) toast(res.error || 'Не удалось войти');
  });
}

let groupCode = null;
const groupPeers = {};

// Анализ громкости потока — подсвечивает плитку участника, когда он говорит.
// tileId: 'me' для себя или socket.id участника.
function setupVoiceActivity(stream, tileId) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = window._audioCtx || (window._audioCtx = new Ctx());
    if (ctx.state === 'suspended') ctx.resume();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser); // только анализ, к динамикам не подключаем (без эха)
    const data = new Uint8Array(analyser.frequencyBinCount);
    // setInterval (а не requestAnimationFrame) — тикает даже когда вкладка не в фокусе
    const iv = setInterval(() => {
      const tile = document.getElementById('p-' + tileId);
      if (!tile) { clearInterval(iv); try { source.disconnect(); } catch (e) {} return; }
      // если свой микрофон выключен — не подсвечиваем себя
      if (tileId === 'me' && localStream) {
        const myTrack = localStream.getAudioTracks()[0];
        if (myTrack && !myTrack.enabled) { tile.classList.remove('speaking'); return; }
      }
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length;
      tile.classList.toggle('speaking', avg > 12); // порог громкости
    }, 120);
  } catch (e) { /* Web Audio недоступен — молча пропускаем */ }
}

function createGroupPC(peerId) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  // Исходящий звук с учётом голосового эффекта (премиум)
  const out = getOutgoingStream();
  out.getAudioTracks().forEach((track) => pc.addTrack(track, out));
  pc.ontrack = (e) => {
    let audio = document.getElementById('audio-' + peerId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'audio-' + peerId;
      audio.autoplay = true;
      document.body.appendChild(audio);
    }
    audio.srcObject = e.streams[0];
    // подсветка «говорит» для этого участника
    if (!document.getElementById('p-' + peerId)) addParticipantTile(peerId, 'Участник');
    setupVoiceActivity(e.streams[0], peerId);
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { to: peerId, data: { candidate: e.candidate } });
  };
  groupPeers[peerId] = { pc };
  return pc;
}

function addParticipantTile(id, label) {
  const box = $('#room-participants');
  if (document.getElementById('p-' + id)) return;
  const el = document.createElement('div');
  el.className = 'participant';
  el.id = 'p-' + id;
  el.innerHTML = `<div class="dot"><i class="fa-solid fa-user"></i></div><span>${label}</span>`;
  box.appendChild(el);
}

function removeParticipantTile(id) {
  const el = document.getElementById('p-' + id);
  if (el) el.remove();
  const audio = document.getElementById('audio-' + id);
  if (audio) audio.remove();
}

// Имена участников группы (socket.id -> ник) для панели модерации
let roomMembers = {};
let isRoomOwner = false;

socket.on('group:joined', async ({ code, name, peers, isOwner }) => {
  groupCode = code;
  isRoomOwner = !!isOwner;
  roomMembers = {};
  $('#group-home').classList.add('hidden');
  document.querySelectorAll('.group-form').forEach((f) => f.classList.add('hidden'));
  $('#group-room').classList.remove('hidden');

  $('#room-name').textContent = name;
  $('#room-code').textContent = code;
  $('#room-participants').innerHTML = '';
  $('#room-messages').innerHTML = '';
  addParticipantTile('me', 'Вы');
  resetRoomMic();
  if (localStream) setupVoiceActivity(localStream, 'me');
  // Кнопка модерации — только у владельца
  $('#room-manage').classList.toggle('hidden', !isRoomOwner);
  $('#moderate-panel').classList.add('hidden');

  for (const p of peers) {
    const peerId = p.id || p;
    roomMembers[peerId] = p.nick || 'Участник';
    addParticipantTile(peerId, roomMembers[peerId]);
    const pc = createGroupPC(peerId);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { to: peerId, data: { sdp: pc.localDescription } });
  }
  addMessage('#room-messages', `Вы вошли в комнату «${name}»`, 'sys');
});

socket.on('group:peer-joined', ({ id, nick }) => {
  roomMembers[id] = nick || 'Участник';
  addParticipantTile(id, roomMembers[id]);
  if (!groupPeers[id]) createGroupPC(id);
  addMessage('#room-messages', 'Новый участник присоединился', 'sys');
  if (isRoomOwner) renderModeratePanel();
});

socket.on('group:peer-left', ({ id }) => {
  if (groupPeers[id]) { groupPeers[id].pc.close(); delete groupPeers[id]; }
  delete roomMembers[id];
  removeParticipantTile(id);
  addMessage('#room-messages', 'Участник вышел', 'sys');
  if (isRoomOwner) renderModeratePanel();
});

// Кнопка микрофона в комнате: включает/выключает передачу своего звука
function resetRoomMic() {
  if (localStream) {
    const track = localStream.getAudioTracks()[0];
    if (track) track.enabled = true;
  }
  const btn = $('#room-mute');
  btn.classList.remove('muted');
  btn.innerHTML = '<i class="fa-solid fa-microphone"></i>';
  const hint = $('#room-mic-hint');
  hint.classList.remove('muted');
  hint.textContent = 'Микрофон включён — говорите';
}
$('#room-mute').addEventListener('click', () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  const on = track.enabled;
  const btn = $('#room-mute');
  btn.classList.toggle('muted', !on);
  btn.innerHTML = on
    ? '<i class="fa-solid fa-microphone"></i>'
    : '<i class="fa-solid fa-microphone-slash"></i>';
  const hint = $('#room-mic-hint');
  hint.classList.toggle('muted', !on);
  hint.textContent = on ? 'Микрофон включён — говорите' : 'Микрофон выключен';
  // своя плитка: приглушаем вид и убираем подсветку при выключенном микрофоне
  const me = document.getElementById('p-me');
  if (me) { me.classList.toggle('muted-self', !on); if (!on) me.classList.remove('speaking'); }
});

$('#room-leave').addEventListener('click', () => {
  socket.emit('group:leave');
  Object.keys(groupPeers).forEach((id) => {
    groupPeers[id].pc.close();
    removeParticipantTile(id);
    delete groupPeers[id];
  });
  groupCode = null;
  $('#group-room').classList.add('hidden');
  $('#group-home').classList.remove('hidden');
});

$('#room-msg-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#room-msg-input');
  const text = input.value.trim();
  if (!text || !groupCode) return;
  socket.emit('group:message', { text });
  addMessage('#room-messages', text, 'me');
  input.value = '';
});

socket.on('group:message', ({ text }) => addMessage('#room-messages', text, 'peer', 'Участник'));

// ==========================================================================
//  ЭКРАН ЗАВЕРШЕНИЯ: кнопки «Начать разговор» и «Изменить параметры»
// ==========================================================================
document.querySelectorAll('[data-restart]').forEach((b) =>
  b.addEventListener('click', () => {
    const mode = b.dataset.restart;
    if (mode === 'voice') startVoiceSearch();
    else startTextSearch();
  })
);
document.querySelectorAll('[data-change]').forEach((b) =>
  b.addEventListener('click', () => showScreen(b.dataset.change, 'setup'))
);

// ==========================================================================
//  МОДАЛКА «ПРАВИЛА»
// ==========================================================================
document.querySelectorAll('[data-rules]').forEach((b) =>
  b.addEventListener('click', () => $('#rules-modal').classList.remove('hidden'))
);
// ==========================================================================
//  МОДАЛКА «ПОЖАЛОВАТЬСЯ ИЛИ ЗАБЛОКИРОВАТЬ»
// ==========================================================================
document.querySelectorAll('[data-report]').forEach((b) =>
  b.addEventListener('click', () => $('#report-modal').classList.remove('hidden'))
);
// Закрытие любой модалки (крестик, кнопка, клик по фону)
document.querySelectorAll('[data-close-modal]').forEach((b) =>
  b.addEventListener('click', () => $('#' + b.dataset.closeModal).classList.add('hidden'))
);
document.querySelectorAll('.modal-backdrop').forEach((m) =>
  m.addEventListener('click', (e) => { if (e.target === m) m.classList.add('hidden'); })
);

// Завершить текущий разговор и показать нужный экран завершения
function endCurrentChat(msg) {
  $('#report-modal').classList.add('hidden');
  if (currentMode === 'voice' && voicePeerId) {
    closeVoice();
    showVoiceEnded(msg);
  } else if (currentMode === 'text' && textPeerId) {
    textPeerId = null;
    showTextEnded(msg);
  }
}

// Пожаловаться: сервер завершает чат для обоих
$('#do-report').addEventListener('click', () => {
  socket.emit('report_user');
  socket.emit(currentMode === 'voice' ? 'voice:stop' : 'text:stop');
  endCurrentChat('Жалоба отправлена');
});
// Заблокировать: сервер добавит собеседника в чёрный список
$('#do-block').addEventListener('click', () => {
  socket.emit('block_user');
  socket.emit(currentMode === 'voice' ? 'voice:stop' : 'text:stop');
  endCurrentChat('Пользователь заблокирован');
});

// ==========================================================================
//  НАСТРОЙКИ
// ==========================================================================

// ---- Открытие / закрытие оверлея настроек ----
$('#open-settings').addEventListener('click', () => {
  showSettingsView('main');
  $('#settings').classList.remove('hidden');
});
document.querySelectorAll('[data-close-settings]').forEach((b) =>
  b.addEventListener('click', () => $('#settings').classList.add('hidden'))
);
// Переход в подэкран
document.querySelectorAll('[data-open]').forEach((b) =>
  b.addEventListener('click', () => showSettingsView(b.dataset.open))
);
// Кнопка «назад» внутри настроек — всегда на главный список
document.querySelectorAll('[data-back-settings]').forEach((b) =>
  b.addEventListener('click', () => showSettingsView('main'))
);

function showSettingsView(name) {
  document.querySelectorAll('.settings-view').forEach((v) => v.classList.remove('active'));
  $('#sv-' + name).classList.add('active');
  $('#settings').scrollTop = 0;
}

// ==========================================================================
//  ПРОФИЛЬ (сохраняется в localStorage и влияет на подбор)
// ==========================================================================
// Поле «Ваш город» в профиле — тот же поиск по городам, что и на вкладках
setupCity('pf-city', 'pf-city-list');

// Возраст (число) -> возрастная «корзина» для подбора
function ageToBucket(age) {
  const n = parseInt(age, 10) || 18;
  if (n <= 24) return '18-24';
  if (n <= 32) return '25-32';
  return '33';
}

// Загрузка профиля из localStorage
function loadProfile() {
  try { return JSON.parse(localStorage.getItem('vt_profile')) || {}; }
  catch (e) { return {}; }
}

let profile = loadProfile();

// Применяем профиль к полям формы
function applyProfileToForm() {
  $('#pf-nick').value = profile.nick || '';
  $('#pf-gender').value = profile.gender || 'male';
  $('#pf-city').value = profile.city || 'Москва';
  $('#pf-age').value = profile.age || '';
  // Премиум-поля
  if ($('#pf-desc')) $('#pf-desc').value = profile.description || '';
  if ($('#pf-profession')) $('#pf-profession').value = profile.profession || '';
  if ($('#pf-height')) $('#pf-height').value = profile.height || '';
  if ($('#pf-zodiac')) $('#pf-zodiac').value = profile.zodiac || '';
  updateAvatarPreview(profile.avatar || '');
}
applyProfileToForm();

// Отправка профиля на сервер — сервер использует пол/возраст/ник для подбора
function sendProfile() {
  if (!profile.gender || !profile.age) return;
  socket.emit('profile', {
    nick: profile.nick || '',
    gender: profile.gender,
    age: ageToBucket(profile.age),
    ageNum: parseInt(profile.age, 10) || 18,
    // Премиум-поля (сервер применит только при подписке)
    avatar: profile.avatar || '',
    description: profile.description || '',
    interests: profile.interests || [],
    zodiac: profile.zodiac || '',
    profession: profile.profession || '',
    height: profile.height || 0,
    theme: localStorage.getItem('vt_scheme') || 'default',
  });
}
// При загрузке страницы, если профиль уже заполнен — сразу отправляем
if (profile.gender && profile.age) sendProfile();

// Сохранение профиля при изменении любого поля
function saveProfileFromForm() {
  const nick = $('#pf-nick').value.trim();
  profile = {
    nick,
    gender: $('#pf-gender').value,
    city: $('#pf-city').value.trim() || 'Москва',
    age: $('#pf-age').value,
    // Премиум-поля (сохраняем как есть; сервер применит при подписке)
    avatar: profile.avatar || '',
    description: $('#pf-desc') ? $('#pf-desc').value : (profile.description || ''),
    interests: profile.interests || [],
    zodiac: $('#pf-zodiac') ? $('#pf-zodiac').value : (profile.zodiac || ''),
    profession: $('#pf-profession') ? $('#pf-profession').value : (profile.profession || ''),
    height: $('#pf-height') ? ($('#pf-height').value || 0) : (profile.height || 0),
  };

  // Валидация ника (минимум 4 символа) — показываем подсказку
  const hint = $('#pf-hint');
  if (nick && nick.length < 4) {
    hint.textContent = 'Ник — минимум 4 символа';
  } else {
    hint.textContent = '';
  }

  localStorage.setItem('vt_profile', JSON.stringify(profile));
  sendProfile();
}
['#pf-nick', '#pf-gender', '#pf-city', '#pf-age', '#pf-desc', '#pf-zodiac', '#pf-profession', '#pf-height'].forEach((sel) => {
  const el = document.querySelector(sel);
  if (el) el.addEventListener('input', saveProfileFromForm);
});

// Карандаш — фокус на поле ника
$('#profile-edit').addEventListener('click', () => $('#pf-nick').focus());

// Удаление профиля
$('#pf-delete').addEventListener('click', () => {
  localStorage.removeItem('vt_profile');
  profile = {};
  applyProfileToForm();
  $('#pf-hint').textContent = '';
  toast('Профиль удалён');
});

// ==========================================================================
//  ТЕМА (светлая / тёмная / системная)
// ==========================================================================
const THEME_RU = { light: 'Светлая', dark: 'Тёмная', system: 'Как на устройстве' };

function applyTheme(mode) {
  let theme = mode;
  if (mode === 'system') {
    theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', theme);
  $('#theme-current').textContent = THEME_RU[mode] || 'Тёмная';
}

let themeMode = localStorage.getItem('vt_theme') || 'dark';
applyTheme(themeMode);
document.querySelector(`input[name="theme"][value="${themeMode}"]`).checked = true;

// Открыть модалку выбора темы
$('[data-open-theme]').addEventListener('click', () => $('#theme-sheet').classList.remove('hidden'));
// Закрыть по клику на фон
$('#theme-sheet').addEventListener('click', (e) => {
  if (e.target.id === 'theme-sheet') $('#theme-sheet').classList.add('hidden');
});
// Выбор темы
document.querySelectorAll('input[name="theme"]').forEach((r) =>
  r.addEventListener('change', () => {
    themeMode = r.value;
    localStorage.setItem('vt_theme', themeMode);
    applyTheme(themeMode);
    setTimeout(() => $('#theme-sheet').classList.add('hidden'), 150);
  })
);

// ==========================================================================
//  АВТОПРИЁМ МАТЧА (сохраняется локально)
// ==========================================================================
const autoAccept = $('#set-autoaccept');
autoAccept.checked = localStorage.getItem('vt_autoaccept') === '1';
autoAccept.addEventListener('change', () =>
  localStorage.setItem('vt_autoaccept', autoAccept.checked ? '1' : '0')
);

// ==========================================================================
//  ЗВУК И ВИБРАЦИЯ (переключатели по режимам)
// ==========================================================================
const SOUND_GROUPS = [
  { key: 'voice', title: 'Голосовой чат' },
  { key: 'group', title: 'Групповой чат' },
  { key: 'text', title: 'Текстовый чат' },
];
(function buildSoundSettings() {
  const box = $('#sound-groups');
  const saved = JSON.parse(localStorage.getItem('vt_sound') || '{}');
  SOUND_GROUPS.forEach((g) => {
    const group = document.createElement('div');
    group.className = 'sound-group';
    group.innerHTML = `<h4>${g.title}</h4>`;
    ['Звук', 'Вибрация'].forEach((label, i) => {
      const key = g.key + '_' + (i === 0 ? 'sound' : 'vibro');
      const checked = saved[key] !== false; // по умолчанию включено
      const row = document.createElement('div');
      row.className = 'sound-toggle';
      row.innerHTML = `<span>${label}</span>
        <label class="switch"><input type="checkbox" ${checked ? 'checked' : ''} data-sound="${key}"><span class="slider"></span></label>`;
      group.appendChild(row);
    });
    box.appendChild(group);
  });
  // Сохранение переключателей
  box.querySelectorAll('input[data-sound]').forEach((inp) =>
    inp.addEventListener('change', () => {
      const s = JSON.parse(localStorage.getItem('vt_sound') || '{}');
      s[inp.dataset.sound] = inp.checked;
      localStorage.setItem('vt_sound', JSON.stringify(s));
    })
  );
})();

// ==========================================================================
//  ЧАСТЫЕ ВОПРОСЫ (аккордеон)
// ==========================================================================
const FAQ = [
  ['Почему так долго ищется собеседник?',
    'Нужен другой человек с подходящим полом, возрастом, городом и настройками одновременно с вами. Попробуйте расширить фильтры, сменить режим или зайти позже, когда онлайн больше пользователей.'],
  ['Меня не слышат',
    'Разрешите доступ к микрофону для Verse Team в настройках системы (iOS: Настройки ▸ Конфиденциальность ▸ Микрофон; Android: Сведения о приложении ▸ Разрешения). Во время звонка снимите заглушение микрофона со своей стороны; при странной маршрутизации звука отключите Bluetooth-гарнитуру и переподключитесь или начните поиск заново.'],
  ['Я не слышу собеседника',
    'Проверьте громкость устройства и что во время звонка у вас не включено отключение звука или заглушение. Переключите динамик и трубку кнопкой громкой связи. Отключите Bluetooth-наушники, если звук ушёл туда. Нестабильная сеть может на секунды прерывать аудио — подождите или завершите и начните поиск снова.'],
  ['В групповом чате не слышу всех участников',
    'Голосовой групповой режим нуждается в стабильном интернете у каждого участника и в достаточно свежей версии приложения. Выйдите из вечеринки и зайдите снова, чтобы восстановились связи. Когда сами не говорите, включайте заглушение микрофона — так меньше потерь пакетов.'],
  ['Текстовый чат оборвался или пропал собеседник',
    'Сессия может прерваться при слабом интернете или если собеседник вышел сам. Вернитесь к поиску — откроется новая комната при новом совпадении.'],
  ['Не сохраняется профиль или ник некорректный',
    'Ник — минимум четыре символа после обрезки пробелов. Заполните пол, возраст и страну; под полями появятся подсказки, если что-то не так.'],
  ['Почему недоступен автоприём матча?',
    'Сначала нужен полный профиль — откройте Настройки ▸ Профиль и заполните все обязательные поля.'],
  ['«Связь нестабильна» или постоянно переподключается',
    'По возможности поменяйте Wi-Fi и мобильный интернет, избегайте VPN и жёстких файрволов. Подойдите ближе к роутеру или на улицу ради лучшего сигнала. Если видите баннер «Повторить» — нажмите или перезапустите поиск.'],
  ['Как сменить язык или тёмную/светлую тему',
    'Всё в Настройках: язык интерфейса почти сверху, тема (светлая, тёмная или системная) — отдельным блоком ниже.'],
  ['Оскорбляют или ведут себя плохо — что делать?',
    'Используйте «Жалоба» или «Блок» из экрана разговора или профиля. Не отправляйте реквизиты, платежи и личные контакты. Соблюдайте правила сообщества из ссылки в Настройках.'],
  ['Удалить профиль',
    'Настройки ▸ Профиль ▸ Удалить профиль. Данные будут удалены; для функций знакомства потребуется регистрация заново.'],
];
(function buildFAQ() {
  const list = $('#faq-list');
  FAQ.forEach(([q, a]) => {
    const item = document.createElement('div');
    item.className = 'faq-item';
    item.innerHTML =
      `<button class="faq-q"><span>${q}</span><i class="fa-solid fa-chevron-down"></i></button>
       <div class="faq-a">${a}</div>`;
    item.querySelector('.faq-q').addEventListener('click', () => item.classList.toggle('open'));
    list.appendChild(item);
  });
})();

// ==========================================================================
//  ПОДДЕРЖКА И УСЛОВИЯ
// ==========================================================================
$('#s-support').addEventListener('click', () => {
  window.location.href = 'mailto:support@verseteam.app?subject=Поддержка Verse Team';
});
$('#s-terms').addEventListener('click', () => showSettingsView('terms'));

// ==========================================================================
//  АНОНИМНЫЙ ИДЕНТИФИКАТОР УСТРОЙСТВА (UUID, хранится локально)
// ==========================================================================
(function ensureUUID() {
  if (!localStorage.getItem('vt_uuid')) {
    const uuid = (crypto.randomUUID && crypto.randomUUID()) ||
      'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
    localStorage.setItem('vt_uuid', uuid);
  }
})();

// ==========================================================================
//  ТЕКСТ ПОЛЬЗОВАТЕЛЬСКОГО СОГЛАШЕНИЯ (адаптирован под Verse Team)
// ==========================================================================
const TERMS = [
  ['Пользовательское соглашение',
    ['Настоящее Соглашение регулирует отношения между пользователем и Администрацией сервиса Verse Team (веб-версия, приложения для iOS и Android). Используя платформу, вы принимаете все условия документа.']],
  ['1. Общие положения',
    ['Настоящее Соглашение регулирует отношения между пользователем и Администрацией сервиса Verse Team (веб-версия, приложения для iOS и Android). Используя платформу, вы принимаете все условия документа.']],
  ['2. Требования к пользователям',
    ['2.1. Сервис предназначен для лиц старше 18 лет. При выявлении несовершеннолетних доступ блокируется.',
     '2.2. Пользователь обязан соблюдать Соглашение и законы своей страны.',
     '2.3. Запрещено разглашать свой идентификатор устройства. Администрация не отвечает за убытки из-за утраты доступа.',
     '2.4. При подозрении на взлом аккаунта необходимо немедленно уведомить Администрацию.']],
  ['3. Запреты',
    ['Пользователям запрещается:',
     '• размещать рекламу, спам и мошеннический контент без разрешения;',
     '• проводить через Сервис любые сделки и покупки;',
     '• распространять порнографию (особенно с несовершеннолетними), материалы о насилии, терроризме, оскорбления, клевету, призывы к ненависти, инструкции к преступлениям;',
     '• выдавать себя за других лиц или организации;',
     '• публиковать фото и личные данные третьих лиц без их согласия;',
     '• использовать контент Сервиса в коммерческих целях без разрешения;',
     '• создавать производные продукты на основе платформы;',
     '• применять ботов, скрипты и автоматизацию для нарушения работы Сервиса.']],
  ['4. Права Администрации',
    ['4.1. Удалять аккаунты и контент за нарушения без предупреждения.',
     '4.2. Ограничивать или блокировать доступ временно или постоянно.',
     '4.3. Менять функциональность и содержимое Сервиса в любой момент.',
     '4.4. Не отвечать за сбои провайдеров и внешние обстоятельства.',
     '4.5. Не нести ответственность за вред при переходе по внешним ссылкам.',
     '4.6. Собирать техническую информацию об устройстве для улучшения работы.',
     '4.7. Отказывать в доступе без объяснения причин.']],
  ['5. Условия использования',
    ['5.1. Сервис бесплатен для личного некоммерческого использования.',
     '5.2. Пользователь несёт полную ответственность за свои действия и общение.',
     '5.3. Допускается анонимное использование или указание базовых данных (возраст, пол, город, никнейм).',
     '5.4. Поиск собеседников осуществляется по заданным параметрам.']],
  ['6. Модерация и наказания',
    ['6.1. Используется AI-анализ и ручная проверка жалоб.',
     '6.2. Пользователь может заблокировать собеседника или пожаловаться на него.',
     '6.3. При жалобе чат завершается немедленно.',
     '6.4. Шкала наказаний (за 24 часа): 1–4 жалобы — предупреждение; 5+ — бан на 24 часа; при повторных нарушениях — баны на 7 или 30 дней; критические нарушения (детский контент, угрозы) — перманентный бан с уведомлением правоохранительных органов.',
     '6.5. Решение модерации пересмотру не подлежит.']],
  ['7. Анонимные идентификаторы',
    ['7.1. При первом запуске создаётся случайный UUID, который хранится локально.',
     '7.2. Он используется для управления сессиями и отслеживания нарушений.',
     '7.3. Идентификатор не передаётся другим пользователям и третьим лицам.',
     '7.4. После переустановки приложения создаётся новый идентификатор.']],
  ['8. Типы чатов',
    ['Голосовой 1×1 (WebRTC, шифрование); текстовый 1×1; групповой до 8 участников (по коду-приглашению). Поиск по городам и возрастным группам: 18–24, 25–32, 33+.']],
  ['9. Ответственность',
    ['9.1. Сервис предоставляется «как есть», без гарантий.',
     '9.2. Пользователь возмещает убытки, причинённые нарушением Соглашения.',
     '9.3. При несообщении о взломе ответственность лежит на пользователе.',
     '9.4. Пользователь отвечает по законам страны проживания.']],
  ['10. Конфиденциальность',
    ['Личные данные (ID устройства, параметры поиска и др.) не передаются третьим лицам, кроме случаев, предусмотренных законом. Подробности — в Политике конфиденциальности.']],
  ['11. Защита детей',
    ['Сервис строго для лиц 18+. При обнаружении детского порнографического контента пользователь удаляется с уведомлением правоохранительных органов.']],
  ['12. Заключительные положения',
    ['12.1. Администрация не обязана отслеживать контент, но оставляет за собой это право.',
     '12.2. Соглашение регулируется законами Королевства Таиланд. Споры рассматриваются по месту нахождения Администрации.',
     '12.3. Споры решаются переговорами, при недостижении согласия — в суде.',
     '12.4. Соглашение действует с момента использования Сервиса.',
     '12.5. Администрация может менять условия в одностороннем порядке. При несогласии пользователь вправе прекратить использование Сервиса.']],
  ['13. Принятие условий',
    ['Нажимая «Продолжить», вы соглашаетесь с Пользовательским соглашением и Политикой конфиденциальности.']],
];
(function buildTerms() {
  const box = $('#terms-body');
  TERMS.forEach(([title, paras]) => {
    const h = document.createElement('h3');
    h.className = 'terms-title';
    h.textContent = title;
    box.appendChild(h);
    paras.forEach((p) => {
      const el = document.createElement('p');
      el.className = 'terms-p';
      el.textContent = p;
      box.appendChild(el);
    });
  });
})();

// ==========================================================================
//  СТАРТОВЫЙ ЭКРАН ПРИНЯТИЯ УСЛОВИЙ (показывается при первом запуске)
// ==========================================================================
if (!localStorage.getItem('vt_accepted')) {
  $('#welcome').classList.remove('hidden');
}
$('#welcome-continue').addEventListener('click', () => {
  localStorage.setItem('vt_accepted', '1');
  $('#welcome').classList.add('hidden');
});
// Ссылка на соглашение со стартового экрана — открыть настройки на разделе «Условия»
$('#welcome-terms-link').addEventListener('click', (e) => {
  e.preventDefault();
  showSettingsView('terms');
  $('#settings').classList.remove('hidden');
});

/* ==========================================================================
   PREMIUM-ПОДПИСКА (страница тарифов + демо-оплата)
   ========================================================================== */

// Данные тарифов: название, цена, список возможностей
const PLAN_DATA = [
  {
    id: 'free', name: 'Бесплатный', price: 0, accent: 'grey',
    features: [
      'Стандартная скорость поиска',
      'Профиль без кастомизации',
      'Базовые фильтры: город, пол, возраст',
      'Группы до 5 человек (без модерации и записи)',
      'Без истории сообщений и уведомлений',
      'Режим общения: голос + текст',
    ],
  },
  {
    id: 'plus', name: 'Плюс', price: 199, accent: 'indigo',
    features: [
      'Приоритетный поиск (на 30% быстрее)',
      'Анонимный режим (скрытие города и возраста, временный ник)',
      'История переписки за 7 дней',
      'Кастомизация профиля (аватар, описание)',
      'Умные уведомления о возвращении собеседника',
      'Расширенные фильтры (до 5 интересов, знак зодиака)',
      'Выбор режима: только голос или только текст',
      'Просмотр профиля собеседника до соединения',
      'Режим «Невидимка», голосовые эффекты, темы оформления',
      'Запись своего разговора',
      'Подарки (стикеры), группы до 15 чел. с модерацией и записью',
      'Поддержка — ответ за 24 ч',
    ],
  },
  {
    id: 'max', name: 'Максимум', price: 399, accent: 'gold',
    features: [
      'Максимальный приоритет поиска (почти мгновенно)',
      'Анонимный режим со сменой ника каждые 24 ч',
      'Полная история переписок с экспортом в .txt/.pdf',
      'Полная кастомизация (фото, описание, тема)',
      'Все уведомления (возвращение, избранное, напоминания)',
      'Фильтры: интересы (до 10), профессия, рост',
      'Переключение режима в любой момент',
      'Все премиум-функции: невидимка, голос-эффекты, темы, запись',
      'Расширенные подарки (анимации, эксклюзивы)',
      'Группы до 50 чел. с полной модерацией (кик, мут, бан) и записью',
      'Приоритетная поддержка — ответ за 6 ч',
    ],
  },
];

const PLAN_NAMES = { free: 'Бесплатный', plus: 'Плюс', max: 'Максимум' };

// Отрисовать карточки тарифов; текущий тариф подсвечивается
function renderSubs() {
  const box = $('#subs-cards');
  box.innerHTML = '';
  PLAN_DATA.forEach((plan) => {
    const isCurrent = plan.id === myPlan;
    const card = document.createElement('div');
    card.className = 'sub-card ' + plan.accent + (isCurrent ? ' current' : '');
    // Оплата пока отключена — у платных тарифов вместо цены показываем «Soon»
    const priceText = plan.price === 0 ? 'Бесплатно' : 'Soon';
    const features = plan.features.map((f) => `<li><i class="fa-solid fa-check"></i> ${f}</li>`).join('');
    let btn;
   if (isCurrent) {
  btn = '<div class="sub-current-label"><i class="fa-solid fa-circle-check"></i> Ваш тариф</div>';
} else if (plan.id === 'free') {
  btn = `<button class="btn btn-grey sub-btn" data-plan="free">Перейти на бесплатный</button>`;
} else {
  btn = `<button class="btn btn-primary sub-btn" data-plan="${plan.id}" disabled>Скоро</button>`;
}
    card.innerHTML =
      `<div class="sub-top">
         <div class="sub-name">${plan.name}</div>
         <div class="sub-price">${priceText}</div>
       </div>
       <ul class="sub-features">${features}</ul>
       ${btn}`;
    box.appendChild(card);
  });
  // Обработчики кнопок подключения (демо-оплата)
  box.querySelectorAll('.sub-btn').forEach((b) => {
    b.addEventListener('click', () => buyPlan(b.dataset.plan));
  });
}

// Оплата пока отключена: все функции и так доступны, платные тарифы — «Soon»
function buyPlan(plan) {
  if (plan === 'free') { doBuy('free'); return; }
  toast('Оплата скоро — сейчас все функции доступны бесплатно');
}

function doBuy(plan) {
  socket.emit('sub:buy', { plan }, (res) => {
    if (res && res.ok) {
      myPlan = plan;
      updatePremiumUI();
      renderSubs();
      toast(plan === 'free' ? 'Тариф изменён на «Бесплатный»' : `Тариф «${PLAN_NAMES[plan]}» активирован!`);
    } else {
      toast((res && res.error) || 'Не удалось изменить тариф');
    }
  });
}

// Обновить элементы интерфейса, зависящие от подписки
function updatePremiumUI() {
  const badge = document.getElementById('s-plan-badge');
  if (badge) {
    badge.textContent = PLAN_NAMES[myPlan] || 'Бесплатный';
    badge.className = 's-plan-badge plan-' + myPlan;
  }
  // Подсветка вкладки Premium в навигации для платных тарифов
  const navPrem = document.querySelector('.nav-premium');
  if (navPrem) navPrem.classList.toggle('has-premium', myPlan !== 'free');
}

// Кнопка «Назад» на вкладке Premium → возврат на голосовой чат
const subsBackBtn = document.getElementById('subs-back');
if (subsBackBtn) subsBackBtn.addEventListener('click', () => switchTab('voice'));

// Пункт «Premium-подписка» в настройках → переключение на вкладку Premium
const sPremiumBtn = document.getElementById('s-premium');
if (sPremiumBtn) sPremiumBtn.addEventListener('click', () => {
  $('#settings').classList.add('hidden');
  switchTab('subs');
});

/* ==========================================================================
   ПРЕМИУМ-ФУНКЦИИ (этап 3): темы, невидимка, голос-эффекты, запись, превью
   Все функции работают только при активной подписке «Плюс»/«Максимум».
   ========================================================================== */

// Загружаем сохранённые премиум-настройки
let voiceFx = localStorage.getItem('vt_voicefx') || 'none';
let recordEnabled = localStorage.getItem('vt_record') === '1';
let previewEnabled = localStorage.getItem('vt_preview') === '1';
let invisible = localStorage.getItem('vt_invisible') === '1';
const isPremium = () => true;

// ---------- ЦВЕТОВЫЕ СХЕМЫ ОФОРМЛЕНИЯ ----------
function applyScheme(scheme) {
  if (scheme && scheme !== 'default') document.documentElement.setAttribute('data-scheme', scheme);
  else document.documentElement.removeAttribute('data-scheme');
  localStorage.setItem('vt_scheme', scheme || 'default');
  document.querySelectorAll('.scheme').forEach((s) =>
    s.classList.toggle('active', s.dataset.scheme === (scheme || 'default')));
}
applyScheme(localStorage.getItem('vt_scheme') || 'default'); // применяем при загрузке
document.querySelectorAll('.scheme').forEach((s) => {
  s.addEventListener('click', () => {
    if (!isPremium()) { toast('Темы оформления доступны в Premium'); return; }
    applyScheme(s.dataset.scheme);
  });
});

// ---------- ГОЛОСОВЫЕ ЭФФЕКТЫ ----------
let fxCtx = null;
// Построить обработанный аудиопоток под выбранный эффект
function buildFxStream(fx) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx || !localStream) return localStream;
  if (!fxCtx) fxCtx = new Ctx();
  if (fxCtx.state === 'suspended') fxCtx.resume();
  const src = fxCtx.createMediaStreamSource(localStream);
  const dest = fxCtx.createMediaStreamDestination();
  if (fx === 'robot') {
    // Кольцевая модуляция: голос × синус → роботизированный тембр
    const ring = fxCtx.createGain(); ring.gain.value = 0;
    const osc = fxCtx.createOscillator(); osc.type = 'sine'; osc.frequency.value = 50;
    osc.connect(ring.gain); osc.start();
    src.connect(ring); ring.connect(dest);
  } else if (fx === 'low') {
    // Низкий тембр: НЧ-фильтр + усиление низов
    const lp = fxCtx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 950;
    const ls = fxCtx.createBiquadFilter(); ls.type = 'lowshelf'; ls.frequency.value = 220; ls.gain.value = 12;
    src.connect(lp); lp.connect(ls); ls.connect(dest);
  } else if (fx === 'high') {
    // Высокий тембр: ВЧ-фильтр + усиление верхов
    const hp = fxCtx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1100;
    const hs = fxCtx.createBiquadFilter(); hs.type = 'highshelf'; hs.frequency.value = 3000; hs.gain.value = 12;
    src.connect(hp); hp.connect(hs); hs.connect(dest);
  } else {
    return localStream;
  }
  return dest.stream;
}
// Какой поток отправлять собеседнику (обычный или с эффектом)
function getOutgoingStream() {
  if (!isPremium() || voiceFx === 'none' || !localStream) return localStream;
  try { return buildFxStream(voiceFx); } catch (e) { return localStream; }
}

// ---------- ЗАПИСЬ СВОЕГО РАЗГОВОРА ----------
let mediaRecorder = null;
let recChunks = [];
function startRecordingIfEnabled() {
  if (!isPremium() || !recordEnabled || !localStream) return;
  try {
    recChunks = [];
    mediaRecorder = new MediaRecorder(localStream);
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
    mediaRecorder.start();
  } catch (e) { /* MediaRecorder недоступен */ }
}
function stopRecordingIfAny() {
  if (!mediaRecorder) return;
  const rec = mediaRecorder; mediaRecorder = null;
  if (rec.state === 'inactive') return;
  rec.onstop = () => {
    const blob = new Blob(recChunks, { type: rec.mimeType || 'audio/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'verse-запись-' + Date.now() + '.webm';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('Запись разговора сохранена');
  };
  try { rec.stop(); } catch (e) {}
}

// ---------- ПРОСМОТР ПРОФИЛЯ ДО СОЕДИНЕНИЯ ----------
function shouldPreview() { return isPremium() && previewEnabled; }
function confirmPreview(partner) {
  const age = partner.age ? (', ' + partner.age + ' лет') : '';
  return confirm(
    `Найден собеседник:\n${partner.nick || 'Без ника'} · ${partner.country}${age}\n\n` +
    'Соединиться? (Отмена — искать другого)'
  );
}

// ---------- НЕВИДИМКА ----------
function applyInvisible() {
  socket.emit('invisible:set', invisible);
}

// ---------- ГЕЙТИНГ И ЭЛЕМЕНТЫ УПРАВЛЕНИЯ ----------
// Синхронизировать состояние контролов с сохранёнными значениями
function initPremControls() {
  const inv = document.getElementById('prem-invisible');
  const prev = document.getElementById('prem-preview');
  const rec = document.getElementById('prem-record');
  if (inv) inv.checked = invisible;
  if (prev) prev.checked = previewEnabled;
  if (rec) rec.checked = recordEnabled;
  document.querySelectorAll('#prem-voicefx .chip').forEach((c) =>
    c.classList.toggle('active', c.dataset.value === voiceFx));
}
// Показать/скрыть блокировку в зависимости от подписки
function updatePremGating() {
  const locked = !isPremium();
  const lockEl = document.getElementById('prem-locked');
  const controls = document.getElementById('prem-controls');
  if (lockEl) lockEl.classList.toggle('hidden', !locked);
  if (controls) controls.classList.toggle('locked', locked);
}

// Обработчики контролов
(function wirePremControls() {
  const inv = document.getElementById('prem-invisible');
  if (inv) inv.addEventListener('change', () => {
    invisible = inv.checked; localStorage.setItem('vt_invisible', invisible ? '1' : '0'); applyInvisible();
  });
  const prev = document.getElementById('prem-preview');
  if (prev) prev.addEventListener('change', () => {
    previewEnabled = prev.checked; localStorage.setItem('vt_preview', previewEnabled ? '1' : '0');
  });
  const rec = document.getElementById('prem-record');
  if (rec) rec.addEventListener('change', () => {
    recordEnabled = rec.checked; localStorage.setItem('vt_record', recordEnabled ? '1' : '0');
  });
  document.querySelectorAll('#prem-voicefx .chip').forEach((c) => {
    c.addEventListener('click', () => {
      voiceFx = c.dataset.value; localStorage.setItem('vt_voicefx', voiceFx);
    });
  });
  const go = document.getElementById('prem-go');
  if (go) go.addEventListener('click', () => { $('#settings').classList.add('hidden'); switchTab('subs'); });
  // Открытие экрана «Премиум-функции» → обновить гейтинг и контролы
  const openRow = document.querySelector('[data-open="premfeatures"]');
  if (openRow) openRow.addEventListener('click', () => { initPremControls(); updatePremGating(); });
})();

// При смене подписки — обновить гейтинг и применить невидимку
const _origUpdatePremiumUI = updatePremiumUI;
updatePremiumUI = function () {
  _origUpdatePremiumUI();
  updatePremGating();
  applyInvisible();
};

/* ==========================================================================
   ЭТАП 4: расширенные фильтры, кастомизация профиля, история,
   подарки, групповая модерация, умные уведомления
   ========================================================================== */

const ZODIAC = ['Овен','Телец','Близнецы','Рак','Лев','Дева','Весы','Скорпион','Стрелец','Козерог','Водолей','Рыбы'];
const INTERESTS = ['Музыка','Кино','Игры','Спорт','Путешествия','Книги','Искусство','Технологии','Кулинария','Фото','Природа','Авто','Мода','Наука','Танцы','Животные'];
const GIFTS = ['🌹','🎁','❤️','🧸','🍫','⭐','🎉','☕','🍕','🔥','💎','🍾','🐱','🌸','👑','🍩'];

// ---------- Заполнение списков зодиака ----------
function fillZodiac(sel, withAny) {
  if (!sel) return;
  sel.innerHTML = '';
  if (withAny) sel.appendChild(new Option('Любой', 'any'));
  ZODIAC.forEach((z) => sel.appendChild(new Option(z, z)));
}
fillZodiac(document.getElementById('pf-zodiac'), false);
fillZodiac(document.getElementById('voice-fzodiac'), true);
fillZodiac(document.getElementById('text-fzodiac'), true);
if (document.getElementById('pf-zodiac')) document.getElementById('pf-zodiac').value = profile.zodiac || 'Овен';

// ---------- Интересы: профиль (сохраняются в профиль) ----------
function renderProfileInterests() {
  const box = document.getElementById('pf-interests');
  if (!box) return;
  box.innerHTML = '';
  const chosen = profile.interests || [];
  INTERESTS.forEach((it) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ichip' + (chosen.includes(it) ? ' on' : '');
    b.textContent = it;
    b.addEventListener('click', () => {
      const arr = profile.interests || [];
      const i = arr.indexOf(it);
      if (i >= 0) arr.splice(i, 1); else if (arr.length < 10) arr.push(it);
      profile.interests = arr;
      b.classList.toggle('on');
      localStorage.setItem('vt_profile', JSON.stringify(profile));
      sendProfile();
    });
    box.appendChild(b);
  });
}
renderProfileInterests();

// ---------- Интересы: фильтры поиска (разовые) ----------
function fillFilterInterests(boxId) {
  const box = document.getElementById(boxId);
  if (!box) return;
  box.innerHTML = '';
  INTERESTS.forEach((it) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ichip';
    b.dataset.v = it;
    b.textContent = it;
    b.addEventListener('click', () => b.classList.toggle('on'));
    box.appendChild(b);
  });
}
fillFilterInterests('voice-fint');
fillFilterInterests('text-fint');

// ---------- Аватар ----------
function updateAvatarPreview(dataUrl) {
  const p = document.getElementById('pf-avatar-preview');
  if (!p) return;
  if (dataUrl) { p.style.backgroundImage = 'url(' + dataUrl + ')'; p.classList.add('has'); }
  else { p.style.backgroundImage = ''; p.classList.remove('has'); }
}
const avatarInput = document.getElementById('pf-avatar');
if (avatarInput) avatarInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      const size = 200; c.width = size; c.height = size;
      const ctx = c.getContext('2d');
      const s = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      const url = c.toDataURL('image/jpeg', 0.8);
      profile.avatar = url;
      updateAvatarPreview(url);
      localStorage.setItem('vt_profile', JSON.stringify(profile));
      sendProfile();
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
});

// ---------- Гейтинг: профиль-премиум и фильтры ----------
function updateFilterGating() {
  const prem = isPremium();
  document.querySelectorAll('.prem-filter').forEach((el) => el.classList.toggle('locked', !prem));
  const pf = document.getElementById('pf-premium');
  if (pf) pf.classList.toggle('locked', !prem);
  const note = document.getElementById('pf-prem-note');
  if (note) note.textContent = prem ? 'Активно' : 'Доступно при подписке';
}
socket.on('me', updateFilterGating);
updateFilterGating();
document.querySelectorAll('.prem-filter').forEach((el) => el.addEventListener('click', () => {
  if (!isPremium()) { if ($('#settings')) $('#settings').classList.add('hidden'); switchTab('subs'); }
}));

// ---------- Предпросмотр собеседника до соединения (премиум) ----------
let pendingMatch = null;
function showPreview(mode, data) {
  pendingMatch = { mode, data };
  const p = data.partner;
  const av = document.getElementById('prev-avatar');
  if (p.avatar) { av.style.backgroundImage = 'url(' + p.avatar + ')'; av.classList.add('has'); av.innerHTML = ''; }
  else { av.style.backgroundImage = ''; av.classList.remove('has'); av.innerHTML = '<i class="fa-solid fa-user"></i>'; }
  document.getElementById('prev-name').textContent = p.nick || 'Собеседник';
  const bits = [p.country];
  if (p.age) bits.push(p.age + ' лет');
  if (p.zodiac) bits.push(p.zodiac);
  if (p.profession) bits.push(p.profession);
  if (p.height) bits.push(p.height + ' см');
  document.getElementById('prev-meta').textContent = bits.join(' · ');
  document.getElementById('prev-desc').textContent = p.description || '';
  document.getElementById('prev-interests').innerHTML =
    (p.interests || []).map((i) => '<span class="ichip on">' + i + '</span>').join('');
  document.getElementById('preview-modal').classList.remove('hidden');
}
document.getElementById('prev-connect').addEventListener('click', () => {
  document.getElementById('preview-modal').classList.add('hidden');
  if (!pendingMatch) return;
  const m = pendingMatch; pendingMatch = null;
  if (m.mode === 'voice') proceedVoiceMatch(m.data); else proceedTextMatch(m.data);
});
document.getElementById('prev-skip').addEventListener('click', () => {
  document.getElementById('preview-modal').classList.add('hidden');
  if (!pendingMatch) return;
  const m = pendingMatch; pendingMatch = null;
  if (m.mode === 'voice') { socket.emit('voice:stop'); setTimeout(startVoiceSearch, 100); }
  else { socket.emit('text:stop'); setTimeout(startTextSearch, 100); }
});

// ---------- Подарки ----------
function openGiftPicker() {
  if (!isPremium()) { toast('Подарки доступны в Premium'); return; }
  const grid = document.getElementById('gift-grid');
  grid.innerHTML = '';
  GIFTS.forEach((g) => {
    const b = document.createElement('button');
    b.className = 'gift-item'; b.textContent = g;
    b.addEventListener('click', () => {
      socket.emit('gift:send', { gift: g });
      if (currentMode === 'text') addGiftBubble('#text-messages', g, 'me');
      else if (groupCode) addGiftBubble('#room-messages', g, 'me');
      document.getElementById('gift-modal').classList.add('hidden');
    });
    grid.appendChild(b);
  });
  document.getElementById('gift-modal').classList.remove('hidden');
}
const textGiftBtn = document.getElementById('text-gift-btn');
if (textGiftBtn) textGiftBtn.addEventListener('click', openGiftPicker);
function addGiftBubble(sel, gift, who) {
  const box = document.querySelector(sel);
  if (!box) return;
  const el = document.createElement('div');
  el.className = 'gift-bubble ' + who;
  el.textContent = gift;
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}
socket.on('gift:recv', (d) => {
  const gift = d.gift;
  if (currentMode === 'text' && textPeerId) addGiftBubble('#text-messages', gift, 'peer');
  else if (groupCode) addGiftBubble('#room-messages', gift, 'peer');
});

// ---------- История переписки (премиум) + экспорт ----------
let historyCache = [];
const sHistoryBtn = document.getElementById('s-history');
if (sHistoryBtn) sHistoryBtn.addEventListener('click', () => { showSettingsView('history'); loadHistory(); });
const histGo = document.getElementById('hist-go');
if (histGo) histGo.addEventListener('click', () => { $('#settings').classList.add('hidden'); switchTab('subs'); });
function loadHistory() {
  const locked = !isPremium();
  document.getElementById('hist-locked').classList.toggle('hidden', !locked);
  document.getElementById('hist-controls').classList.toggle('hidden', locked);
  if (locked) return;
  socket.emit('history:get', (res) => {
    historyCache = (res && res.messages) || [];
    const list = document.getElementById('hist-list');
    if (historyCache.length === 0) { list.innerHTML = '<div class="empty-note">История пуста</div>'; return; }
    list.innerHTML = historyCache.map((m) => {
      const t = new Date(m.createdAt).toLocaleString('ru-RU');
      const who = m.dir === 'out' ? 'Вы' : (m.peerNick || 'Собеседник');
      return '<div class="hist-item"><div class="hist-meta">' + t + ' · ' + who + '</div><div>' + escapeHtml(m.text) + '</div></div>';
    }).join('');
  });
}
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function historyToText() {
  return historyCache.map((m) => {
    const t = new Date(m.createdAt).toLocaleString('ru-RU');
    const who = m.dir === 'out' ? 'Вы' : (m.peerNick || 'Собеседник');
    return '[' + t + '] ' + who + ': ' + m.text;
  }).join('\n');
}
function downloadFile(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
const expTxt = document.getElementById('hist-export-txt');
if (expTxt) expTxt.addEventListener('click', () => {
  downloadFile('verse-history.txt', new Blob([historyToText()], { type: 'text/plain;charset=utf-8' }));
});
const expPdf = document.getElementById('hist-export-pdf');
if (expPdf) expPdf.addEventListener('click', () => {
  downloadFile('verse-history.pdf', new Blob([buildSimplePDF(historyToText())], { type: 'application/pdf' }));
});
function buildSimplePDF(text) {
  const lines = [];
  text.split('\n').forEach((ln) => { for (let i = 0; i < ln.length; i += 90) lines.push(ln.slice(i, i + 90)); });
  let y = 780;
  let stream = 'BT /F1 12 Tf 40 800 Td (Verse Team - istoriya) Tj ET\n';
  for (const ln of lines.slice(0, 100)) {
    const safe = ln.replace(/[\\()]/g, '\\$&').replace(/[^\x20-\x7E]/g, '?');
    stream += 'BT /F1 9 Tf 40 ' + y + ' Td (' + safe + ') Tj ET\n';
    y -= 14; if (y < 40) break;
  }
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + 'endstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n'; const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += (i + 1) + ' 0 obj\n' + o + '\nendobj\n'; });
  const xref = pdf.length;
  pdf += 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n';
  offsets.forEach((off) => { pdf += String(off).padStart(10, '0') + ' 00000 n \n'; });
  pdf += 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  return pdf;
}

// ---------- Групповая модерация (владелец) ----------
const roomManageBtn = document.getElementById('room-manage');
if (roomManageBtn) roomManageBtn.addEventListener('click', () => {
  const panel = document.getElementById('moderate-panel');
  panel.classList.toggle('hidden');
  if (!panel.classList.contains('hidden')) renderModeratePanel();
});
function renderModeratePanel() {
  const panel = document.getElementById('moderate-panel');
  if (!panel) return;
  const ids = Object.keys(roomMembers);
  if (ids.length === 0) { panel.innerHTML = '<div class="empty-note">Пока нет других участников</div>'; return; }
  panel.innerHTML = '<div class="mod-title">Управление участниками</div>' + ids.map((id) =>
    '<div class="mod-row"><span>' + escapeHtml(roomMembers[id]) + '</span>' +
    '<span class="mod-btns">' +
    '<button class="btn btn-ghost btn-sm" data-mod="mute" data-id="' + id + '">Мут</button>' +
    '<button class="btn btn-ghost btn-sm" data-mod="kick" data-id="' + id + '">Кик</button>' +
    '<button class="btn btn-danger btn-sm" data-mod="ban" data-id="' + id + '">Бан</button>' +
    '</span></div>').join('');
  panel.querySelectorAll('[data-mod]').forEach((b) => b.addEventListener('click', () => {
    socket.emit('group:moderate', { action: b.dataset.mod, target: b.dataset.id });
    if (b.dataset.mod === 'kick' || b.dataset.mod === 'ban') { delete roomMembers[b.dataset.id]; renderModeratePanel(); }
    toast('Действие применено');
  }));
}
socket.on('group:muted', (d) => {
  const muted = d.muted;
  toast(muted ? 'Владелец отключил вам микрофон и чат' : 'Ограничения сняты');
  const input = document.getElementById('room-msg-input');
  if (input) input.disabled = muted;
  if (muted && localStream) { const t = localStream.getAudioTracks()[0]; if (t) t.enabled = false; }
});
socket.on('group:kicked', (d) => {
  toast(d.banned ? 'Вас забанили в этой комнате' : 'Вас исключили из комнаты');
  document.getElementById('room-leave').click();
});

// ---------- Умные уведомления (премиум) ----------
function maybeNotify(title, body) {
  if (!isPremium()) return;
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted' && document.hidden) {
    try { new Notification(title, { body: body }); } catch (e) {}
  }
}
socket.on('me', () => {
  if (isPremium() && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
});
socket.on('voice:matched', () => maybeNotify('Собеседник найден!', 'Вас ждут в голосовом чате'));
socket.on('text:matched', () => maybeNotify('Собеседник найден!', 'Вас ждут в текстовом чате'));

