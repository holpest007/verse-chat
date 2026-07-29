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
  const lvl = partner.level ? ` · <span class="level-badge sm">Ур. ${partner.level}</span>` : '';
  return `<span class="cflag">${RF_FLAG}</span> ${partner.country} · ${partner.age}${lvl}`;
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
function setupCity(inputId, listId, allowAny) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  // Для фильтров по умолчанию «Любой» (город не важен). В профиле — пусто:
  // пользователь заполняет город вручную (автоопределение по IP отключено).
  input.value = allowAny ? 'Любой' : '';

  // Отрисовать список подходящих городов по введённому тексту
  function renderList(query) {
    const q = query.trim().toLowerCase();
    // «Любой» или пустой запрос → показываем весь список городов
    const showAll = !q || q === 'любой';
    let matches = (showAll
      ? CITIES
      : CITIES.filter((c) => c.toLowerCase().includes(q))
    ).slice(0, 8);
    // Для фильтров добавляем «Любой» первым пунктом
    if (allowAny && (showAll || 'любой'.includes(q))) {
      matches = ['Любой', ...matches].slice(0, 8);
    }

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
setupCity('voice-city', 'voice-city-list', true);
setupCity('video-city', 'video-city-list', true);
setupCity('text-city', 'text-city-list', true);

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
  // Город: пустое значение или «Любой» → не ограничиваем поиск городом
  const cityRaw = $('#' + prefix + '-city').value.trim();
  const f = {
    city: (!cityRaw || cityRaw === 'Любой') ? '' : cityRaw,
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
    // При открытии вкладки «Статистика» — подгружаем актуальные данные
    if (tab.dataset.tab === 'stats') loadStatsTab();
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
  // Общее число онлайн-пользователей на всех вкладках
  const txt = pluralUsers(c.online || 0, 'онлайн');
  $('#voice-online').textContent = txt;
  $('#text-online').textContent = txt;
  $('#group-online').textContent = txt;
  const vo = $('#video-online');
  if (vo) vo.textContent = txt;
});

// Экраны каждой вкладки
const SCREENS = {
  voice: ['setup', 'searching', 'call', 'ended'],
  video: ['setup', 'searching', 'call', 'ended'],
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
// Метки начала разговора (для статистики длительности), в мс. 0 — разговор не идёт
let voiceCallStart = 0, textChatStart = 0, groupStart = 0, videoCallStart = 0;
// Состояние переговоров WebRTC (perfect negotiation) для звонка 1-на-1
let voiceNeg = { polite: false, makingOffer: false, ignoreOffer: false };

async function getMic() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  return localStream;
}

// Общая переотправка предложения при добавлении/удалении видеодорожки на лету
async function renegotiate(pc, peerId, neg) {
  try {
    neg.makingOffer = true;
    const offer = await pc.createOffer();
    if (pc.signalingState !== 'stable') return;
    await pc.setLocalDescription(offer);
    socket.emit('signal', { to: peerId, data: { sdp: pc.localDescription } });
  } catch (e) { /* переговоры прервались — ничего страшного */ }
  finally { neg.makingOffer = false; }
}

function createVoicePC(peerId) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  // Исходящий звук может быть обработан голосовым эффектом (премиум)
  const out = getOutgoingStream();
  out.getAudioTracks().forEach((track) => pc.addTrack(track, out));
  pc.ontrack = (e) => {
    // Голосовой чат — только звук
    const a = $('#voice-audio');
    a.srcObject = e.streams[0];
    a.muted = false;
    a.playsInline = true;
    // Явно запускаем воспроизведение — на iOS <audio autoplay> сам не играет
    a.play().catch(() => {});
  };
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
  flushCallStat('voice');
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
  openRateModal();
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
  ratablePartner = true; // после разговора можно оценить собеседника
  // Инициатор шлёт первый offer → он «невежливый»; собеседник «вежливый»
  voiceNeg = { polite: !initiator, makingOffer: false, ignoreOffer: false };
  voicePC = createVoicePC(peerId);
  stopTimer('voiceSearch');
  $('#voice-peer-name').textContent = 'Разговор с ' + (partner.nick || 'собеседником');
  $('#voice-peer-info').innerHTML = peerInfoHTML(partner);
  const rl = $('#voice-remote-label');
  if (rl) rl.textContent = partner.nick || 'Собеседник';
  // сброс кнопок mute/speaker
  $('#voice-mute').classList.remove('muted');
  $('#voice-mute').innerHTML = '<i class="fa-solid fa-microphone"></i>';
  $('#voice-speaker').classList.remove('muted');
  $('#voice-speaker').innerHTML = '<i class="fa-solid fa-volume-high"></i>';
  $('#voice-audio').muted = false;
  showScreen('voice', 'call');
  startTimer('voiceCall', '#voice-timer');
  voiceCallStart = Date.now();
  resetTopicBar('voice');
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
  // neg — объект состояния переговоров: { polite, makingOffer, ignoreOffer }
  let pc = null, neg = null;
  if (from === voicePeerId && voicePC) { pc = voicePC; neg = voiceNeg; }
  else if (from === videoPeerId && videoPC) { pc = videoPC; neg = videoNeg; }
  else if (groupPeers[from]) { pc = groupPeers[from].pc; neg = groupPeers[from]; }
  if (!pc) return;

  try {
    if (data.sdp) {
      const desc = data.sdp;
      // Столкновение предложений (glare): пришёл offer, пока мы сами делаем offer
      const collision = desc.type === 'offer' &&
        (neg.makingOffer || pc.signalingState !== 'stable');
      neg.ignoreOffer = !neg.polite && collision;
      if (neg.ignoreOffer) return; // невежливая сторона отклоняет чужой offer
      if (collision) {
        // Вежливая сторона откатывает свой offer и принимает чужой
        await Promise.all([
          pc.setLocalDescription({ type: 'rollback' }).catch(() => {}),
          pc.setRemoteDescription(new RTCSessionDescription(desc)),
        ]);
      } else {
        await pc.setRemoteDescription(new RTCSessionDescription(desc));
      }
      if (desc.type === 'offer') {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('signal', { to: from, data: { sdp: pc.localDescription } });
      }
    } else if (data.candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); }
      catch (e) { if (!neg.ignoreOffer) { /* игнорируем гонки кандидатов */ } }
    }
  } catch (e) { /* переговоры прервались — молча пропускаем */ }
});

socket.on('peer:left', () => {
  if (voicePeerId) {
    closeVoice();
    showVoiceEnded('Собеседник покинул чат');
  }
  if (videoPeerId) {
    closeVideo();
    showVideoEnded('Собеседник покинул чат');
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
  flushCallStat('text');
  stopTimer('textSearch');
  $('#text-ended-msg').textContent = msg;
  showScreen('text', 'ended');
  openRateModal();
}

socket.on('text:none', () => toast('Собеседников пока нет'));

socket.on('text:matched', (data) => {
  if (shouldPreview()) { showPreview('text', data); return; }
  proceedTextMatch(data);
});

function proceedTextMatch({ peerId, partner }) {
  textPeerId = peerId;
  currentMode = 'text';
  ratablePartner = true; // после разговора можно оценить собеседника
  stopTimer('textSearch');
  // очищаем историю, показываем плашку «Отправьте первое сообщение»
  $('#text-messages').innerHTML =
    '<div class="chat-empty" id="text-empty"><i class="fa-regular fa-comment"></i><span>Отправьте первое сообщение</span></div>';
  $('#text-peer-name').textContent = partner.nick || 'Собеседник';
  $('#text-peer-info').innerHTML = peerInfoHTML(partner);
  textChatStart = Date.now();
  resetTopicBar('text');
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
  const id = 'm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  socket.emit('text:message', { text, id });
  addTextMessage({ text, who: 'me', id });
  input.value = '';
});

socket.on('text:message', ({ text, id, image }) => {
  clearTextEmpty();
  addTextMessage({ text, who: 'peer', id, image });
});

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
let roomSpeakerOn = true; // громкая связь в группе (звук всех участников)

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
  // Если своя камера уже включена — сразу отдаём видеодорожку новому участнику
  if (groupCamOn && groupCamStream) {
    const vt = groupCamStream.getVideoTracks()[0];
    if (vt) pc.addTrack(vt, groupCamStream);
  }
  pc.ontrack = (e) => {
    if (e.track.kind === 'video') {
      // Видео участника — в его плитку
      if (!document.getElementById('p-' + peerId)) addParticipantTile(peerId, roomMembers[peerId] || 'Участник');
      attachGroupVideo(peerId, e.streams[0]);
      e.track.onmute = () => detachGroupVideo(peerId);
      e.track.onended = () => detachGroupVideo(peerId);
      e.track.onunmute = () => attachGroupVideo(peerId, e.streams[0]);
      return;
    }
    let audio = document.getElementById('audio-' + peerId);
    if (!audio) {
      audio = document.createElement('audio');
      audio.id = 'audio-' + peerId;
      audio.autoplay = true;
      audio.playsInline = true;
      document.body.appendChild(audio);
    }
    audio.srcObject = e.streams[0];
    audio.muted = !roomSpeakerOn; // учитываем громкую связь
    audio.play().catch(() => {}); // iOS: явный запуск воспроизведения
    // подсветка «говорит» для этого участника
    if (!document.getElementById('p-' + peerId)) addParticipantTile(peerId, roomMembers[peerId] || 'Участник');
    setupVoiceActivity(e.streams[0], peerId);
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { to: peerId, data: { candidate: e.candidate } });
  };
  // Поля perfect negotiation. Вежливость определяем детерминированно по id,
  // чтобы обе стороны выбрали противоположные роли при столкновении offer'ов.
  groupPeers[peerId] = {
    pc,
    polite: (socket.id || '') < peerId,
    makingOffer: false,
    ignoreOffer: false,
  };
  return pc;
}

function addParticipantTile(id, label) {
  const box = $('#room-participants');
  if (document.getElementById('p-' + id)) return;
  const el = document.createElement('div');
  el.className = 'participant';
  el.id = 'p-' + id;
  // Видеослой поверх иконки: показывается, когда участник включает камеру
  el.innerHTML =
    `<div class="pvid-wrap">
       <div class="dot"><i class="fa-solid fa-user"></i></div>
       <video class="pvid" autoplay playsinline muted></video>
     </div>
     <span>${label}</span>`;
  box.appendChild(el);
}
// Показать видеопоток участника в его плитке
function attachGroupVideo(id, stream) {
  const tile = document.getElementById('p-' + id);
  if (!tile) return;
  const v = tile.querySelector('.pvid');
  if (!v) return;
  v.srcObject = stream;
  v.play().catch(() => {});
  tile.classList.add('has-video');
}
function detachGroupVideo(id) {
  const tile = document.getElementById('p-' + id);
  if (!tile) return;
  const v = tile.querySelector('.pvid');
  if (v) v.srcObject = null;
  tile.classList.remove('has-video');
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
  groupStart = Date.now();
  resetTopicBar('group');
  resetRoomMic();
  resetRoomSpeaker();
  resetRoomCam();
  // Кнопка модерации — только для владельца комнаты
  const manageBtn = document.getElementById('room-manage');
  if (manageBtn) manageBtn.classList.toggle('hidden', !isRoomOwner);
  if (localStream) setupVoiceActivity(localStream, 'me');

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

// Кнопка «Громкая связь» в группе: глушит/включает звук всех участников
function resetRoomSpeaker() {
  roomSpeakerOn = true;
  const btn = $('#room-speaker');
  btn.classList.remove('muted');
  btn.innerHTML = '<i class="fa-solid fa-volume-high"></i>';
}
$('#room-speaker').addEventListener('click', () => {
  roomSpeakerOn = !roomSpeakerOn;
  document.querySelectorAll('audio[id^="audio-"]').forEach((a) => { a.muted = !roomSpeakerOn; });
  const btn = $('#room-speaker');
  btn.classList.toggle('muted', !roomSpeakerOn);
  btn.innerHTML = roomSpeakerOn
    ? '<i class="fa-solid fa-volume-high"></i>'
    : '<i class="fa-solid fa-volume-xmark"></i>';
  toast(roomSpeakerOn ? 'Громкая связь включена' : 'Громкая связь выключена');
});

$('#room-leave').addEventListener('click', () => {
  flushCallStat('group');
  stopGroupCam();
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
    else if (mode === 'video') startVideoSearch();
    else startTextSearch();
  })
);
document.querySelectorAll('[data-change]').forEach((b) =>
  b.addEventListener('click', () => showScreen(b.dataset.change, 'setup'))
);

// ==========================================================================
//  МОДАЛКА ОЦЕНКИ СОБЕСЕДНИКА (1–5 звёзд) — после завершения разговора
// ==========================================================================
let ratablePartner = false; // был ли реальный собеседник (можно оценить)
function paintRateStars(n) {
  document.querySelectorAll('#rate-stars .rate-star').forEach((s) =>
    s.classList.toggle('on', Number(s.dataset.v) <= n)
  );
}
function openRateModal() {
  if (!ratablePartner) return;       // нечего оценивать (не было соединения)
  ratablePartner = false;            // одно окно на один разговор
  paintRateStars(0);
  $('#rate-modal').classList.remove('hidden');
}
function closeRateModal() { $('#rate-modal').classList.add('hidden'); }
document.querySelectorAll('#rate-stars .rate-star').forEach((s) => {
  s.addEventListener('mouseenter', () => paintRateStars(Number(s.dataset.v)));
  s.addEventListener('click', () => {
    const v = Number(s.dataset.v);
    paintRateStars(v);
    socket.emit('rate', { rating: v });   // без подтверждений — молча
    toast('Спасибо за оценку!');
    setTimeout(closeRateModal, 220);
  });
});
const rateStarsBox = document.getElementById('rate-stars');
if (rateStarsBox) rateStarsBox.addEventListener('mouseleave', () => paintRateStars(0));
$('#rate-skip').addEventListener('click', closeRateModal);
$('#rate-modal').addEventListener('click', (e) => { if (e.target.id === 'rate-modal') closeRateModal(); });

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
  b.addEventListener('click', () => {
    // Сбрасываем поле причины при каждом открытии
    $('#report-reason').classList.add('hidden');
    $('#report-reason-text').value = '';
    $('#report-reason-hint').textContent = '';
    $('#report-modal').classList.remove('hidden');
  })
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
  } else if (currentMode === 'video' && videoPeerId) {
    closeVideo();
    showVideoEnded(msg);
  } else if (currentMode === 'text' && textPeerId) {
    textPeerId = null;
    showTextEnded(msg);
  }
}
// Событие остановки текущего режима (для сервера)
function stopCurrentModeEvent() {
  return currentMode === 'voice' ? 'voice:stop' : (currentMode === 'video' ? 'video:stop' : 'text:stop');
}

// Пожаловаться: сначала раскрываем поле причины (описание обязательно)
$('#do-report').addEventListener('click', () => {
  $('#report-reason').classList.remove('hidden');
  $('#report-reason-hint').textContent = '';
  $('#report-reason-text').focus();
});
// Отправка жалобы с текстом причины
$('#report-send').addEventListener('click', () => {
  const ta = $('#report-reason-text');
  const reason = ta.value.trim();
  if (!reason) { $('#report-reason-hint').textContent = 'Опишите причину жалобы'; ta.focus(); return; }
  socket.emit('report_user', { reason });
  socket.emit(stopCurrentModeEvent());
  ta.value = '';
  $('#report-reason').classList.add('hidden');
  endCurrentChat('Жалоба отправлена');
});
// Заблокировать: сервер добавит собеседника в чёрный список
$('#do-block').addEventListener('click', () => {
  socket.emit('block_user');
  socket.emit(stopCurrentModeEvent());
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
  $('#pf-city').value = profile.city || '';
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
    city: profile.city || '',
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
    city: $('#pf-city').value.trim(), // город вводится вручную; пусто — допустимо
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
// Связь с админом — отдельный адрес (тот же механизм mailto)
$('#s-admin').addEventListener('click', () => {
  window.location.href = 'mailto:admin@verseteam.app?subject=Сообщение администратору Verse Team';
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

// ==========================================================================
//  ВОССТАНОВЛЕНИЕ ЗВУКА ПРИ ВОЗВРАТЕ НА ВКЛАДКУ
//  Браузер приостанавливает AudioContext и может ставить медиа на паузу, когда
//  вкладка/браузер свёрнуты. При возврате возобновляем контексты (в т.ч. fxCtx,
//  который обрабатывает ИСХОДЯЩИЙ звук) и перезапускаем все аудио/видео-потоки.
//  Работает для голоса 1-на-1, видеочата и групповых режимов.
// ==========================================================================
function resumeMediaAfterVisible() {
  [window._audioCtx, typeof fxCtx !== 'undefined' ? fxCtx : null].forEach((ctx) => {
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
  });
  // Перезапускаем воспроизведение всех медиа-элементов, у которых есть поток,
  // но которые встали на паузу из-за сворачивания.
  document.querySelectorAll('audio, video').forEach((el) => {
    if (el.srcObject && el.paused) el.play().catch(() => {});
  });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resumeMediaAfterVisible();
});
// Резервно: некоторые браузеры при разворачивании окна дают только 'focus'
window.addEventListener('focus', resumeMediaAfterVisible);

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
fillZodiac(document.getElementById('video-fzodiac'), true);
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
fillFilterInterests('video-fint');
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
// Сворачивание/разворачивание расширенных фильтров по клику на заголовок
document.querySelectorAll('.prem-filter-head').forEach((h) =>
  h.addEventListener('click', () => h.closest('.prem-filter').classList.toggle('open')));

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
  if (m.mode === 'voice') proceedVoiceMatch(m.data);
  else if (m.mode === 'video') proceedVideoMatch(m.data);
  else proceedTextMatch(m.data);
});
document.getElementById('prev-skip').addEventListener('click', () => {
  document.getElementById('preview-modal').classList.add('hidden');
  if (!pendingMatch) return;
  const m = pendingMatch; pendingMatch = null;
  if (m.mode === 'voice') { socket.emit('voice:stop'); setTimeout(startVoiceSearch, 100); }
  else if (m.mode === 'video') { socket.emit('video:stop'); setTimeout(startVideoSearch, 100); }
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

/* ==========================================================================
   ЭТАП 5 (Фаза 1): статистика/уровни, ID в профиле, темы разговора,
   реакции на сообщения, отправка фото, определение города по IP
   ========================================================================== */

// ---------- МОЙ ID В ПРОФИЛЕ ----------
(function initProfileId() {
  const el = document.getElementById('pf-uuid');
  if (el) el.textContent = getUUID();
  const copy = document.getElementById('pf-uuid-copy');
  if (copy) copy.addEventListener('click', () => {
    navigator.clipboard.writeText(getUUID())
      .then(() => toast('ID скопирован'))
      .catch(() => toast('Не удалось скопировать'));
  });
})();

// ---------- СТАТИСТИКА, УРОВНИ, ДОСТИЖЕНИЯ (вкладка «Статистика») ----------
let myStats = { convCount: 0, totalDuration: 0, points: 0, xp: 0, level: 1 };

// Загрузить и отрисовать вкладку статистики
function loadStatsTab() {
  socket.emit('stats:get', (data) => { if (data) renderStatsTab(data); });
  loadAchievements(); // сетка достижений — отдельным запросом GET /api/achievements
}

// Загрузка всех достижений с прогрессом пользователя (REST, как в ТЗ)
function loadAchievements() {
  fetch('/api/achievements?uuid=' + encodeURIComponent(getUUID()))
    .then((r) => r.json())
    .then((res) => { renderAchievements((res && res.achievements) || []); })
    .catch(() => {});
}

// Отрисовать все достижения: по категориям, полученные выделены, остальные заблокированы
function renderAchievements(list) {
  const ag = document.getElementById('st-achievements');
  if (!ag) return;
  if (!list.length) { ag.innerHTML = '<div class="empty-note">Достижения загружаются…</div>'; return; }
  const cats = [], byCat = {};
  list.forEach((a) => { const c = a.category || 'Прочее'; if (!byCat[c]) { byCat[c] = []; cats.push(c); } byCat[c].push(a); });
  const sum = document.getElementById('st-ach-summary');
  if (sum) {
    const got = list.filter((a) => a.unlocked).length, total = list.length, left = total - got;
    const p = total ? Math.round((got / total) * 100) : 0;
    sum.innerHTML = '<div class="ach-sum-top"><b>Получено ' + got + ' из ' + total + '</b>' +
      '<span>осталось ' + left + ' · ' + p + '%</span></div>' +
      '<div class="mini-bar"><span style="width:' + p + '%"></span></div>';
  }
  ag.innerHTML = cats.map((cat) => {
    const items = byCat[cat].map((a) => {
      const numeric = (a.numeric !== undefined) ? a.numeric : (a.target != null);
      const pct = (numeric && a.target) ? Math.min(100, Math.round(((a.progress || 0) / a.target) * 100)) : (a.unlocked ? 100 : 0);
      const status = a.unlocked ? 'Получено' : (numeric ? (a.progress || 0) + ' / ' + a.target : 'Не выполнено');
      const bar = (numeric && !a.unlocked) ? '<div class="ach-bar"><span style="width:' + pct + '%"></span></div>' : '';
      const xpTag = a.xp ? '<div class="ach-xp">+' + a.xp + ' XP</div>' : '';
      return '<div class="ach' + (a.unlocked ? ' unlocked' : '') + '" title="' + escapeHtml(a.description || '') + '">' +
        '<div class="ach-ic">' + escapeHtml(a.icon || '🏅') + '</div>' +
        '<div class="ach-name">' + escapeHtml(a.name || '') + '</div>' + xpTag + bar +
        '<div class="ach-prog">' + status + '</div></div>';
    }).join('');
    return '<div class="ach-cat"><div class="ach-cat-h">' + escapeHtml(cat) + '</div><div class="ach-grid">' + items + '</div></div>';
  }).join('');
}
function fmtMinutes(min) {
  if (min >= 60) { const h = Math.floor(min / 60), m = min % 60; return h + ' ч' + (m ? ' ' + m + ' мин' : ''); }
  return min + ' мин';
}
function renderStatsTab(data) {
  const s = data.stats || {};
  const setTxt = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  setTxt('st-level', 'Ур. ' + (s.level || 1));
  setTxt('st-xp', (s.xp || 0) + ' XP');
  setTxt('st-xp2', s.xp || 0);
  setTxt('st-calls', s.totalCalls || 0);
  setTxt('st-time', fmtMinutes(s.totalMinutes || 0));
  // Рейтинг от собеседников: звёзды (округляем) + среднее + число оценок
  const avg = s.avgRating || 0, rc = s.ratingCount || 0;
  const filled = Math.round(avg);
  setTxt('st-rating-stars', '★'.repeat(filled) + '☆'.repeat(5 - filled));
  setTxt('st-rating-num', rc ? avg.toFixed(1) : '—');
  setTxt('st-rating-count', rc ? ('оценок: ' + rc) : 'пока нет оценок');
  setTxt('st-tonext', (s.level >= 99) ? 'Максимальный уровень' : ('До ' + ((s.level || 1) + 1) + ' уровня: ' + (s.toNext || 0) + ' XP'));
  const cur = s.curLevelXp || 0, next = s.nextLevelXp || 50;
  const pct = next > cur ? Math.min(100, Math.round((((s.xp || 0) - cur) / (next - cur)) * 100)) : 100;
  const fill = document.getElementById('st-fill'); if (fill) fill.style.width = pct + '%';

  // Челленджи + сводка «выполнено X из Y сегодня»
  const ch = document.getElementById('st-challenges');
  if (ch) {
    const chs = data.challenges || [];
    const doneN = chs.filter((c) => c.done || c.claimed).length;
    const head = chs.length
      ? '<div class="ch-summary"><span>Выполнено <b>' + doneN + ' из ' + chs.length + '</b> сегодня</span>' +
        '<div class="mini-bar"><span style="width:' + Math.round((doneN / chs.length) * 100) + '%"></span></div></div>'
      : '';
    const items = chs.map((c) => {
      const pct2 = Math.min(100, Math.round((c.progress / c.target) * 100));
      const btn = c.claimed
        ? '<span class="ch-claimed"><i class="fa-solid fa-check"></i> Получено</span>'
        : (c.done ? '<button class="btn btn-green btn-sm ch-claim" data-kind="' + c.kind + '">+' + c.reward + ' XP</button>'
                  : '<span class="ch-reward">+' + c.reward + ' XP</span>');
      return '<div class="challenge"><div class="ch-head"><span>' + escapeHtml(c.name) + '</span>' + btn + '</div>' +
        '<div class="ch-bar"><span style="width:' + pct2 + '%"></span></div>' +
        '<div class="ch-prog">' + c.progress + ' / ' + c.target + '</div></div>';
    }).join('') || '<div class="empty-note">Нет активных челленджей</div>';
    ch.innerHTML = head + items;
  }

  // Сетку достижений рисует loadAchievements() (GET /api/achievements).
  // Если сокет всё же вернул достижения — используем их сразу (без ожидания REST).
  if (data.achievements && data.achievements.length) renderAchievements(data.achievements);
  renderProfileBadges(data.achievements); // синхронизируем бейджи в профиле

  // Таблица лидеров
  const lb = document.getElementById('st-leaderboard');
  if (lb) lb.innerHTML = (data.leaderboard || []).map((r) => {
    const medal = r.rank <= 3 ? ' top' + r.rank : '';
    return '<div class="lb-row' + medal + '"><span class="lb-rank">' + r.rank + '</span>' +
      '<span class="lb-nick">' + escapeHtml(r.nick) + '</span>' +
      '<span class="lb-lvl">Ур. ' + r.level + '</span>' +
      '<span class="lb-xp">' + r.xp + ' XP</span></div>';
  }).join('') || '<div class="empty-note">Пока никого нет</div>';
}

// Клик по кнопке «забрать бонус» челленджа
document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('.ch-claim');
  if (!btn) return;
  socket.emit('challenge:claim', { kind: btn.dataset.kind }, (res) => {
    if (res && res.ok) { toast('Бонус +' + res.reward + ' XP получен!'); loadStatsTab(); }
    else toast((res && res.error) || 'Не удалось получить бонус');
  });
});

// Обновление краткой статистики (уровень у ника и т.п.)
socket.on('stat:me', (s) => {
  if (!s) return;
  myStats = s;
  // Если вкладка статистики открыта — перезагрузим её
  const panel = document.getElementById('panel-stats');
  if (panel && panel.classList.contains('active')) loadStatsTab();
});
// Уведомление о новом достижении (тост с эмодзи и начисленными XP)
socket.on('achievement:unlocked', (a) => {
  if (!a || !a.name) return;
  const xp = a.xp ? ' (+' + a.xp + ' XP)' : '';
  toast((a.icon || '🏆') + ' Достижение: ' + a.name + xp);
  // Обновим сетку достижений и бейджи, если они на экране
  if (typeof loadAchievements === 'function') loadAchievements();
});

// Переключение под-вкладок статистики: Обзор / Достижения
document.querySelectorAll('.stab-btn').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.stab-btn').forEach((x) => x.classList.toggle('active', x === b));
    const t = b.dataset.stab;
    document.getElementById('stats-overview').classList.toggle('hidden', t !== 'overview');
    document.getElementById('stats-ach').classList.toggle('hidden', t !== 'ach');
  })
);

// Бейджи достижений в профиле (эмодзи рядом с ником)
function renderProfileBadges(achievements) {
  const box = document.getElementById('pf-badges');
  if (!box) return;
  const unlocked = (achievements || []).filter((a) => a.unlocked);
  if (!unlocked.length) {
    box.innerHTML = '<span class="pf-badges-empty">Пока нет достижений — общайтесь, чтобы их получить</span>';
    return;
  }
  box.innerHTML = unlocked.slice(0, 12).map((a) =>
    '<span class="pf-badge" title="' + escapeHtml(a.name) + '">' + escapeHtml(a.icon) + '</span>').join('') +
    (unlocked.length > 12 ? '<span class="pf-badge more">+' + (unlocked.length - 12) + '</span>' : '');
}
// Разовая подгрузка бейджей при старте (не дожидаясь открытия вкладки статистики)
socket.emit('stats:get', (d) => { if (d) renderProfileBadges(d.achievements); });

// Отправить длительность завершённого разговора на сервер (для очков/уровня)
function flushCallStat(mode) {
  let start = 0;
  if (mode === 'voice') { start = voiceCallStart; voiceCallStart = 0; }
  else if (mode === 'video') { start = videoCallStart; videoCallStart = 0; }
  else if (mode === 'text') { start = textChatStart; textChatStart = 0; }
  else if (mode === 'group') { start = groupStart; groupStart = 0; }
  if (!start) return;
  const dur = Math.round((Date.now() - start) / 1000);
  if (dur < 3) return; // слишком короткие сессии не считаем
  socket.emit('stat:call', { mode, duration: dur });
}

// ---------- ТЕМЫ ДЛЯ РАЗГОВОРА ----------
let TOPICS = [
  'Какое у тебя самое яркое воспоминание из детства?',
  'Если бы ты мог(ла) отправиться в любую точку мира — куда?',
  'Какой фильм ты можешь пересматривать бесконечно?',
];
fetch('topics.json').then((r) => r.json()).then((list) => {
  if (Array.isArray(list) && list.length) TOPICS = list;
}).catch(() => {});

let lastTopic = '';
function randomTopic() {
  if (TOPICS.length <= 1) return TOPICS[0] || '';
  let t;
  do { t = TOPICS[Math.floor(Math.random() * TOPICS.length)]; } while (t === lastTopic);
  lastTopic = t;
  return t;
}
// Показать тему в панели нужного режима
function setTopicText(mode, text) {
  const bar = document.querySelector('.topic-bar[data-topic="' + mode + '"]');
  if (!bar) return;
  const span = bar.querySelector('.topic-text');
  if (span) { span.textContent = text; span.classList.add('has-topic'); }
}
// Сбросить панель темы при начале нового разговора
function resetTopicBar(mode) {
  const bar = document.querySelector('.topic-bar[data-topic="' + mode + '"]');
  if (!bar) return;
  const span = bar.querySelector('.topic-text');
  if (span) span.classList.remove('has-topic');
}
// Клик по кнопке «Подобрать тему»
document.querySelectorAll('.topic-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const bar = btn.closest('.topic-bar');
    const mode = bar ? bar.dataset.topic : '';
    const topic = randomTopic();
    if (!topic) return;
    setTopicText(mode, topic);
    socket.emit('topic:share', { topic }); // синхронизируем с собеседником/группой
  });
});
// Собеседник/группа выбрал(и) тему — показываем её у себя.
// Режим определяем по РЕАЛЬНОМУ активному контексту, а не по currentMode
// (он не сбрасывается после звонка и мог указывать на прошлый режим).
socket.on('topic:share', ({ topic }) => {
  if (!topic) return;
  let mode = '';
  if (groupCode) mode = 'group';
  else if (voicePeerId) mode = 'voice';
  else if (videoPeerId) mode = 'video';
  else if (textPeerId) mode = 'text';
  if (mode) setTopicText(mode, topic);
});

// ---------- ТЕКСТОВОЕ СООБЩЕНИЕ С РЕАКЦИЯМИ И ФОТО ----------
const REACTIONS = ['❤️', '👍', '😂', '😮', '😢', '🔥'];

// Универсальный рендер сообщения в текстовом чате 1-на-1
function addTextMessage({ text, who, id, image }) {
  const box = $('#text-messages');
  if (!box) return;
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap ' + who;
  if (id) wrap.dataset.id = id;

  const bubble = document.createElement('div');
  bubble.className = 'msg ' + who;
  if (image) {
    const img = document.createElement('img');
    img.className = 'msg-img';
    img.src = image;
    img.loading = 'lazy';
    img.addEventListener('click', () => window.open(image, '_blank'));
    bubble.appendChild(img);
  }
  if (text) bubble.appendChild(document.createTextNode(text));
  // Клик по сообщению — меню реакций (реакцию можно ставить на любое сообщение)
  if (id) bubble.addEventListener('click', (e) => {
    if (e.target.classList.contains('msg-img')) return; // клик по фото открывает его
    openReactionPicker(bubble, id);
  });
  wrap.appendChild(bubble);

  const reactions = document.createElement('div');
  reactions.className = 'reactions';
  wrap.appendChild(reactions);

  box.appendChild(wrap);
  box.scrollTop = box.scrollHeight;
  return wrap;
}

// Меню выбора реакции возле сообщения
let reactionPickerEl = null;
function closeReactionPicker() {
  if (reactionPickerEl) { reactionPickerEl.remove(); reactionPickerEl = null; }
}
function openReactionPicker(bubble, msgId) {
  closeReactionPicker();
  const picker = document.createElement('div');
  picker.className = 'reaction-picker';
  REACTIONS.forEach((emoji) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'reaction-opt';
    b.textContent = emoji;
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      applyReaction(msgId, emoji, 'me');
      socket.emit('text:reaction', { msgId, emoji });
      closeReactionPicker();
    });
    picker.appendChild(b);
  });
  bubble.parentElement.appendChild(picker);
  reactionPickerEl = picker;
  // Закрытие по клику вне меню
  setTimeout(() => document.addEventListener('click', onDocClickCloseReaction, { once: true }), 0);
}
function onDocClickCloseReaction(e) {
  if (reactionPickerEl && !reactionPickerEl.contains(e.target)) closeReactionPicker();
}
// Показать реакцию под сообщением
function applyReaction(msgId, emoji, who) {
  const wrap = document.querySelector('.msg-wrap[data-id="' + CSS.escape(msgId) + '"]');
  if (!wrap) return;
  const box = wrap.querySelector('.reactions');
  if (!box) return;
  const chip = document.createElement('span');
  chip.className = 'reaction-chip ' + who;
  chip.textContent = emoji;
  box.appendChild(chip);
}
socket.on('text:reaction', ({ msgId, emoji }) => applyReaction(msgId, emoji, 'peer'));

// ---------- ОТПРАВКА ФОТО В ТЕКСТОВОМ ЧАТЕ ----------
const textPhotoBtn = document.getElementById('text-photo-btn');
const textPhotoInput = document.getElementById('text-photo-input');
if (textPhotoBtn && textPhotoInput) {
  textPhotoBtn.addEventListener('click', () => { if (textPeerId) textPhotoInput.click(); else toast('Нет активного диалога'); });
  textPhotoInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = ''; // сброс, чтобы можно было выбрать тот же файл снова
    if (!file || !textPeerId) return;
    resizeImage(file, 1280, 0.82).then((dataUrl) => uploadPhoto(dataUrl)).catch(() => toast('Не удалось обработать фото'));
  });
}
// Уменьшить изображение до maxSide и вернуть data-URL (jpeg)
function resizeImage(file, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxSide || height > maxSide) {
          const k = Math.min(maxSide / width, maxSide / height);
          width = Math.round(width * k); height = Math.round(height * k);
        }
        const c = document.createElement('canvas');
        c.width = width; c.height = height;
        c.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
// Загрузить фото на сервер и отправить ссылку собеседнику
function uploadPhoto(dataUrl) {
  toast('Отправка фото…');
  fetch('/api/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: dataUrl }),
  }).then((r) => r.json()).then((res) => {
    if (!res.ok || !res.url) { toast(res.error || 'Ошибка загрузки'); return; }
    if (!textPeerId) return;
    clearTextEmpty();
    const id = 'm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    socket.emit('text:message', { text: '', image: res.url, id });
    addTextMessage({ who: 'me', id, image: res.url });
  }).catch(() => toast('Ошибка загрузки фото'));
}

// Определение города по IP отключено: город в профиле пользователь вводит вручную,
// а фильтры по умолчанию «Любой» (поиск не ограничен городом).


/* ==========================================================================
   ЭТАП 6 (Фаза 2): ВИДЕОЧАТ (1 на 1) и групповое видео
   ========================================================================== */

// ---------- ВИДЕОЧАТ 1-на-1 ----------
let videoPC = null;
let videoPeerId = null;
let videoNeg = { polite: false, makingOffer: false, ignoreOffer: false };
let videoLocalStream = null;   // свой поток (аудио + видео)
let videoFacing = 'user';      // 'user' — фронтальная | 'environment' — тыловая

async function getVideoMedia(facing) {
  return navigator.mediaDevices.getUserMedia({
    audio: true,
    video: { facingMode: { ideal: facing || 'user' } },
  });
}

// Зеркалим ТОЛЬКО фронтальную камеру в своём окне; тыловую — без зеркала.
// Видео собеседника не зеркалим никогда.
function applyLocalMirror() {
  const v = document.getElementById('video-local-video');
  if (v) v.style.transform = videoFacing === 'user' ? 'scaleX(-1)' : 'none';
}
function showLocalPreview() {
  const v = document.getElementById('video-local-video');
  if (v && videoLocalStream) { v.srcObject = videoLocalStream; v.play().catch(() => {}); }
}

function createVideoPC(peerId) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  if (videoLocalStream) videoLocalStream.getTracks().forEach((t) => pc.addTrack(t, videoLocalStream));
  pc.ontrack = (e) => {
    const stage = document.getElementById('video-visual');
    if (e.track.kind === 'video') {
      const v = document.getElementById('video-remote-video');
      v.srcObject = e.streams[0];
      v.play().catch(() => {});
      const show = () => stage && stage.classList.add('has-remote');
      const hide = () => stage && stage.classList.remove('has-remote');
      show(); // показываем сразу, как только пришла видеодорожка собеседника
      e.track.onunmute = show; e.track.onmute = hide; e.track.onended = hide;
    } else {
      const a = document.getElementById('video-audio');
      a.srcObject = e.streams[0]; a.muted = false; a.playsInline = true;
      a.play().catch(() => {});
    }
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { to: peerId, data: { candidate: e.candidate } });
  };
  return pc;
}

async function startVideoSearch() {
  try { if (!videoLocalStream) videoLocalStream = await getVideoMedia(videoFacing); }
  catch (e) { toast('Нет доступа к камере или микрофону'); return; }
  showLocalPreview(); applyLocalMirror();
  const f = getFilters('video');
  $('#video-search-info').innerHTML =
    `<span class="sline"><span class="cflag">${RF_FLAG}</span> Российская Федерация</span><span class="sline">${ageRangeText(f.ages)}</span>`;
  showScreen('video', 'searching');
  startTimer('videoSearch', '#video-search-timer');
  socket.emit('video:start', f);
}
$('#video-start').addEventListener('click', startVideoSearch);

$('#video-cancel').addEventListener('click', () => {
  socket.emit('video:stop');
  stopTimer('videoSearch');
  stopVideoLocal();
  showScreen('video', 'setup');
});

$('#video-end').addEventListener('click', () => {
  socket.emit('video:stop');
  closeVideo();
  showVideoEnded('Вы завершили видеочат');
});

// Микрофон
$('#video-mute').addEventListener('click', () => {
  if (!videoLocalStream) return;
  const t = videoLocalStream.getAudioTracks()[0]; if (!t) return;
  t.enabled = !t.enabled;
  const btn = $('#video-mute');
  btn.classList.toggle('muted', !t.enabled);
  btn.innerHTML = t.enabled ? '<i class="fa-solid fa-microphone"></i>' : '<i class="fa-solid fa-microphone-slash"></i>';
});

// Камера вкл/выкл (своя видеодорожка)
$('#video-cam').addEventListener('click', () => {
  if (!videoLocalStream) return;
  const t = videoLocalStream.getVideoTracks()[0]; if (!t) return;
  t.enabled = !t.enabled;
  const btn = $('#video-cam');
  btn.classList.toggle('muted', !t.enabled);
  btn.innerHTML = t.enabled ? '<i class="fa-solid fa-video"></i>' : '<i class="fa-solid fa-video-slash"></i>';
  const stage = document.getElementById('video-visual');
  if (stage) stage.classList.toggle('cam-off', !t.enabled);
});

// Перевернуть камеру (фронтальная ⇄ тыловая) с корректным зеркалированием
$('#video-flip').addEventListener('click', async () => {
  if (!videoLocalStream) return;
  const btn = $('#video-flip'); btn.disabled = true;
  const target = videoFacing === 'user' ? 'environment' : 'user';
  let vs;
  try { vs = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: target } } }); }
  catch (e) { toast('Вторая камера недоступна'); btn.disabled = false; return; }
  const newTrack = vs.getVideoTracks()[0];
  const oldTrack = videoLocalStream.getVideoTracks()[0];
  if (videoPC) {
    const sender = videoPC.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) { try { await sender.replaceTrack(newTrack); } catch (e) {} }
  }
  if (oldTrack) { try { videoLocalStream.removeTrack(oldTrack); } catch (e) {} oldTrack.stop(); }
  videoLocalStream.addTrack(newTrack);
  videoFacing = target;
  showLocalPreview(); applyLocalMirror();
  btn.disabled = false;
  toast(videoFacing === 'user' ? 'Фронтальная камера' : 'Тыловая камера');
});

socket.on('video:none', () => toast('Собеседников пока нет'));
socket.on('video:matched', (data) => {
  if (shouldPreview()) { showPreview('video', data); return; }
  proceedVideoMatch(data);
});
socket.on('video:matched', () => maybeNotify('Собеседник найден!', 'Вас ждут в видеочате'));

async function proceedVideoMatch({ peerId, initiator, partner }) {
  videoPeerId = peerId;
  currentMode = 'video';
  ratablePartner = true; // после разговора можно оценить собеседника
  videoNeg = { polite: !initiator, makingOffer: false, ignoreOffer: false };
  try { if (!videoLocalStream) videoLocalStream = await getVideoMedia(videoFacing); }
  catch (e) { toast('Нет доступа к камере'); }
  showLocalPreview(); applyLocalMirror();
  videoPC = createVideoPC(peerId);
  stopTimer('videoSearch');
  $('#video-peer-name').textContent = 'Видеочат с ' + (partner.nick || 'собеседником');
  $('#video-peer-info').innerHTML = peerInfoHTML(partner);
  const rl = $('#video-remote-label'); if (rl) rl.textContent = partner.nick || 'Собеседник';
  $('#video-mute').classList.remove('muted'); $('#video-mute').innerHTML = '<i class="fa-solid fa-microphone"></i>';
  $('#video-cam').classList.remove('muted'); $('#video-cam').innerHTML = '<i class="fa-solid fa-video"></i>';
  const stage = document.getElementById('video-visual'); if (stage) stage.classList.remove('cam-off');
  showScreen('video', 'call');
  startTimer('videoCall', '#video-timer');
  videoCallStart = Date.now();
  resetTopicBar('video');
  if (initiator) {
    const offer = await videoPC.createOffer();
    await videoPC.setLocalDescription(offer);
    socket.emit('signal', { to: peerId, data: { sdp: videoPC.localDescription } });
  }
}

function stopVideoLocal() {
  if (videoLocalStream) { videoLocalStream.getTracks().forEach((t) => t.stop()); videoLocalStream = null; }
  const lv = document.getElementById('video-local-video'); if (lv) lv.srcObject = null;
}
function closeVideo() {
  flushCallStat('video');
  stopTimer('videoCall');
  if (videoPC) { videoPC.close(); videoPC = null; }
  videoPeerId = null;
  stopVideoLocal();
  const rv = document.getElementById('video-remote-video'); if (rv) rv.srcObject = null;
  const a = document.getElementById('video-audio'); if (a) a.srcObject = null;
  const stage = document.getElementById('video-visual'); if (stage) stage.classList.remove('has-remote', 'cam-off');
}
function showVideoEnded(msg) {
  stopTimer('videoCall'); stopTimer('videoSearch');
  $('#video-ended-msg').textContent = msg;
  showScreen('video', 'ended');
  openRateModal();
}

// ---------- ГРУППОВОЕ ВИДЕО ----------
let groupCamOn = false;
let groupCamStream = null;     // MediaStream с видеодорожкой камеры для группы
let groupFacing = 'user';

function setRoomCamBtn(on) {
  const btn = document.getElementById('room-cam');
  if (!btn) return;
  btn.classList.toggle('cam-on', on);
  btn.innerHTML = on ? '<i class="fa-solid fa-video"></i>' : '<i class="fa-solid fa-video-slash"></i>';
}
function resetRoomCam() {
  groupCamOn = false;
  if (groupCamStream) { groupCamStream.getTracks().forEach((t) => t.stop()); groupCamStream = null; }
  detachGroupVideo('me');
  setRoomCamBtn(false);
}
// Показать своё видео в собственной плитке (зеркалим фронтальную)
function showOwnGroupVideo() {
  const tile = document.getElementById('p-me');
  if (!tile || !groupCamStream) return;
  const v = tile.querySelector('.pvid');
  if (v) {
    v.srcObject = groupCamStream;
    v.style.transform = groupFacing === 'user' ? 'scaleX(-1)' : 'none';
    v.play().catch(() => {});
  }
  tile.classList.add('has-video');
}
async function stopGroupCam() {
  if (!groupCamOn) return;
  const track = groupCamStream && groupCamStream.getVideoTracks()[0];
  for (const id in groupPeers) {
    const gp = groupPeers[id];
    const sender = gp.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) { try { gp.pc.removeTrack(sender); } catch (e) {} await renegotiate(gp.pc, id, gp); }
  }
  if (track) track.stop();
  groupCamStream = null;
  groupCamOn = false;
  detachGroupVideo('me');
  setRoomCamBtn(false);
}

const roomCamBtn = document.getElementById('room-cam');
if (roomCamBtn) roomCamBtn.addEventListener('click', async () => {
  if (!groupCode) return;
  const btn = roomCamBtn; btn.disabled = true;
  try {
    if (!groupCamOn) {
      try { groupCamStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: groupFacing } } }); }
      catch (e) { toast('Нет доступа к камере'); return; }
      const track = groupCamStream.getVideoTracks()[0];
      for (const id in groupPeers) {
        const gp = groupPeers[id];
        gp.pc.addTrack(track, groupCamStream);
        await renegotiate(gp.pc, id, gp);
      }
      groupCamOn = true;
      setRoomCamBtn(true);
      showOwnGroupVideo();
      toast('Камера включена');
    } else {
      await stopGroupCam();
      toast('Камера выключена');
    }
  } finally { btn.disabled = false; }
});
