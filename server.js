require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const TelegramBot = require('node-telegram-bot-api');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const app = express();
const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = parseInt(process.env.ADMIN_CHAT_ID);
const SUPPORT_GROUP_ID = -1004411290413;

// ─── Пути к данным ───────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const SNACKS_FILE = path.join(DATA_DIR, 'snacks.json');

const readJSON = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');

// ─── Multer для загрузки QR-картинок ─────────────────────────────────────────
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => cb(null, 'qr_' + Date.now() + path.extname(file.originalname))
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/oplata', express.static(path.join(__dirname, 'oplata')));
app.get('/payment', (req, res) => {
  const qs = req.query.amount ? '?amount=' + req.query.amount : '';
  res.redirect('/oplata/' + encodeURIComponent('Оплата заказа.html') + qs);
});

// ─── API: получить все данные для сайта ──────────────────────────────────────
app.get('/api/data', (req, res) => {
  const settings = readJSON(SETTINGS_FILE);
  const snacks = readJSON(SNACKS_FILE);
  res.json({ ...settings, snacks });
});

// ─── API: заявка на бронирование ─────────────────────────────────────────────
app.post('/api/booking', async (req, res) => {
  const { name, phone, room, date, time, comment, extras, package: pkg, price } = req.body || {};
  res.json({ ok: true });

  if (!bot) return;
  const extrasTotal = extras?.reduce((s, e) => s + e.price * e.qty, 0) || 0;
  const grandTotal = (price || 0) + extrasTotal;
  const extrasText = extras?.length
    ? extras.map(e => `  ${e.emoji} ${e.name} × ${e.qty} = ${(e.price * e.qty).toLocaleString('ru-RU')} ₽`).join('\n')
    : '  без допов';
  const lines = [
    `🎬 *Новая заявка на бронирование*\n`,
    pkg ? `🎬 *Тариф:* ${pkg}${price ? ` — ${price.toLocaleString('ru-RU')} ₽` : ''}` : null,
    `👤 *Имя:* ${name || '—'}`,
    `📞 *Телефон:* ${phone || '—'}`,
    date    ? `📅 *Дата:* ${date}` : null,
    time    ? `🕐 *Время:* ${time}` : null,
    comment ? `💬 *Комментарий:* ${comment}` : null,
    `\n🍿 *Допы:*\n${extrasText}`,
    `\n💰 *ИТОГО: ${grandTotal.toLocaleString('ru-RU')} ₽*`,
  ].filter(Boolean).join('\n');

  bot.sendMessage(ADMIN_CHAT_ID, lines, { parse_mode: 'Markdown' }).catch(() => {});
});

app.post('/api/callback', (req, res) => {
  const { phone } = req.body || {};
  res.json({ ok: true });
  if (!bot || !phone) return;
  bot.sendMessage(ADMIN_CHAT_ID, `📞 *Запрос звонка*\n\nТелефон: ${phone}`, { parse_mode: 'Markdown' }).catch(() => {});
});

// ─── Чат техподдержки: сессии ────────────────────────────────────────────────
const chatSessions = new Map();    // sessionId → { ws, threadId, name }
const threadToSession = new Map(); // threadId  → sessionId

function generateId() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

// Прямой запрос к Telegram Bot API (для методов форума)
function telegramRequest(method, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(params);
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ─── HTTP + WebSocket сервер ──────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let bot = null;

wss.on('connection', (ws) => {
  const sessionId = generateId();
  let initialized = false;

  ws.on('message', async (rawData) => {
    try {
      const msg = JSON.parse(rawData.toString());

      if (msg.type === 'start' && !initialized) {
        if (!BOT_TOKEN || !bot) {
          ws.send(JSON.stringify({ type: 'error', text: 'Чат временно недоступен' }));
          return;
        }
        initialized = true;
        const clientName = ((msg.name || '').trim().slice(0, 50)) || 'Гость';
        const clientPhone = (msg.phone || '').trim().slice(0, 30);
        const now = new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', hour12: false });
        const topicName = `${clientName} · ${now}`.slice(0, 128);

        const result = await telegramRequest('createForumTopic', {
          chat_id: SUPPORT_GROUP_ID,
          name: topicName
        });

        if (result.ok) {
          const threadId = result.result.message_thread_id;
          chatSessions.set(sessionId, { ws, threadId, name: clientName, phone: clientPhone });
          threadToSession.set(threadId, sessionId);
          ws.send(JSON.stringify({ type: 'ready' }));
          const phoneLine = clientPhone ? `\n📞 Телефон: ${clientPhone}` : '';
          await bot.sendMessage(SUPPORT_GROUP_ID,
            `🎬 Новый клиент: *${clientName}*${phoneLine}\nОтвечайте в этой теме — ответы мгновенно идут в чат на сайте.`,
            { message_thread_id: threadId, parse_mode: 'Markdown' }
          );
        } else {
          ws.send(JSON.stringify({ type: 'error', text: 'Не удалось подключиться к оператору' }));
          console.error('createForumTopic failed:', result);
        }

      } else if (msg.type === 'message' && msg.text) {
        const session = chatSessions.get(sessionId);
        if (session && bot) {
          await bot.sendMessage(SUPPORT_GROUP_ID, msg.text, {
            message_thread_id: session.threadId
          });
        }
      }
    } catch (e) {
      console.error('WS error:', e);
    }
  });

  ws.on('close', () => {
    const session = chatSessions.get(sessionId);
    if (session) {
      threadToSession.delete(session.threadId);
      if (bot) {
        bot.sendMessage(SUPPORT_GROUP_ID, '🔴 Клиент отключился от чата', {
          message_thread_id: session.threadId
        }).catch(() => {});
      }
    }
    chatSessions.delete(sessionId);
  });
});

// ─── Telegram Bot ─────────────────────────────────────────────────────────────
if (!BOT_TOKEN) {
  console.warn('⚠️  BOT_TOKEN не задан в .env — бот не запущен');
} else {
  bot = new TelegramBot(BOT_TOKEN, { polling: true });

  const isAdmin = (msg) => msg.chat.id === ADMIN_CHAT_ID;

  const state = {};
  const setState = (chatId, s) => { state[chatId] = s; };
  const getState = (chatId) => state[chatId] || null;
  const clearState = (chatId) => { delete state[chatId]; };

  // ── /start или /help ────────────────────────────────────────────────────────
  bot.onText(/\/(start|help)/, (msg) => {
    if (!isAdmin(msg)) return;
    clearState(msg.chat.id);
    bot.sendMessage(msg.chat.id,
      `👋 *Imperial Vision — панель управления*\n\nВыбери раздел:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          keyboard: [
            ['💳 Карта оплаты', '📱 QR-код'],
            ['🍿 Допы/снеки', '🏙 Города и адреса'],
            ['💰 Тарифы', '🎭 Залы']
          ],
          resize_keyboard: true
        }
      }
    );
  });

  // ── Меню карты ──────────────────────────────────────────────────────────────
  bot.onText(/💳 Карта оплаты/, (msg) => {
    if (!isAdmin(msg)) return;
    const s = readJSON(SETTINGS_FILE);
    bot.sendMessage(msg.chat.id,
      `💳 *Текущие реквизиты:*\n\nНомер: \`${s.card.number}\`\nБанк: ${s.card.bank}\nПолучатель: ${s.card.name}\n\nЧто изменить?`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔢 Номер карты', callback_data: 'card_number' }],
            [{ text: '🏦 Банк', callback_data: 'card_bank' }],
            [{ text: '👤 Получатель', callback_data: 'card_name' }]
          ]
        }
      }
    );
  });

  // ── Меню QR ─────────────────────────────────────────────────────────────────
  bot.onText(/📱 QR-код/, (msg) => {
    if (!isAdmin(msg)) return;
    const s = readJSON(SETTINGS_FILE);
    bot.sendMessage(msg.chat.id,
      `📱 *QR-код*\n\nТекущее значение: ${s.qr.value || 'не задано'}\n\nВыбери действие:`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔗 Задать ссылку', callback_data: 'qr_url' }],
            [{ text: '🖼 Загрузить картинку', callback_data: 'qr_image' }]
          ]
        }
      }
    );
  });

  // ── Меню снеков ─────────────────────────────────────────────────────────────
  bot.onText(/🍿 Допы\/снеки/, (msg) => {
    if (!isAdmin(msg)) return;
    sendSnacksList(msg.chat.id);
  });

  const sendSnacksList = (chatId) => {
    const snacks = readJSON(SNACKS_FILE);
    if (snacks.length === 0) {
      bot.sendMessage(chatId, '🍿 Список пустой. Добавь первый снек:',
        { reply_markup: { inline_keyboard: [[{ text: '➕ Добавить снек', callback_data: 'snack_add' }]] } }
      );
      return;
    }
    const buttons = snacks.map(s => [
      { text: `${s.emoji} ${s.name} — ${s.price}₽`, callback_data: `snack_view_${s.id}` }
    ]);
    buttons.push([{ text: '➕ Добавить снек', callback_data: 'snack_add' }]);
    bot.sendMessage(chatId, '🍿 *Допы и снеки:*', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    });
  };

  // ── Меню городов ────────────────────────────────────────────────────────────
  bot.onText(/🏙 Города и адреса/, (msg) => {
    if (!isAdmin(msg)) return;
    sendCitiesList(msg.chat.id);
  });

  const sendCitiesList = (chatId) => {
    const s = readJSON(SETTINGS_FILE);
    if (s.cities.length === 0) {
      bot.sendMessage(chatId, '🏙 Городов нет. Добавь первый:', {
        reply_markup: { inline_keyboard: [[{ text: '➕ Добавить город', callback_data: 'city_add' }]] }
      });
      return;
    }
    const buttons = s.cities.map(c => [
      { text: `🏙 ${c.name} (${c.addresses.length} адр.)`, callback_data: `city_view_${c.id}` }
    ]);
    buttons.push([{ text: '➕ Добавить город', callback_data: 'city_add' }]);
    bot.sendMessage(chatId, '🏙 *Города:*', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    });
  };

  // ── Залы ────────────────────────────────────────────────────────────────────
  bot.onText(/🎭 Залы/, (msg) => {
    if (!isAdmin(msg)) return;
    sendRoomsList(msg.chat.id);
  });

  const sendRoomsList = (chatId) => {
    const s = readJSON(SETTINGS_FILE);
    const rooms = s.rooms || [];
    if (rooms.length === 0) {
      bot.sendMessage(chatId, '🎭 Залов нет. Добавь первый:', {
        reply_markup: { inline_keyboard: [[{ text: '➕ Добавить зал', callback_data: 'room_add' }]] }
      });
      return;
    }
    const buttons = rooms.map(r => ([{ text: `🎭 ${r.name} — ${r.tag || ''}`, callback_data: `room_view_${r.id}` }]));
    buttons.push([{ text: '➕ Добавить зал', callback_data: 'room_add' }]);
    bot.sendMessage(chatId, '🎭 *Залы:*', { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } });
  };

  const sendRoomCard = (chatId, room) => {
    const featList = room.features.length > 0 ? room.features.map((f, i) => `${i+1}. ${f}`).join('\n') : 'Нет характеристик';
    const featDelBtns = room.features.map((f, i) => ([{ text: `🗑 ${f.substring(0,30)}`, callback_data: `room_feat_del_${room.id}_${i}` }]));
    const photoStatus = room.photo ? '✅ фото загружено' : '📸 фото не загружено';
    bot.sendMessage(chatId,
      `🎭 *${room.name}*\n🏷 ${room.tag || '—'}\n${photoStatus}\n\n*Характеристики:*\n${featList}`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '✏️ Название', callback_data: `room_edit_name_${room.id}` }, { text: '🏷 Тег', callback_data: `room_edit_tag_${room.id}` }],
          [{ text: '📸 Загрузить фото', callback_data: `room_photo_${room.id}` }],
          [{ text: '➕ Добавить характеристику', callback_data: `room_feat_add_${room.id}` }],
          ...featDelBtns,
          [{ text: '🗑 Удалить зал', callback_data: `room_delete_${room.id}` }],
          [{ text: '« К залам', callback_data: 'room_list' }]
        ]}
      }
    );
  };

  // ── Тарифы ──────────────────────────────────────────────────────────────────
  bot.onText(/💰 Тарифы/, (msg) => {
    if (!isAdmin(msg)) return;
    sendPackagesList(msg.chat.id);
  });

  const sendPackagesList = (chatId) => {
    const s = readJSON(SETTINGS_FILE);
    const pkgs = s.packages || [];
    if (pkgs.length === 0) {
      bot.sendMessage(chatId, '💰 Тарифов нет. Добавь первый:', {
        reply_markup: { inline_keyboard: [[{ text: '➕ Добавить тариф', callback_data: 'pkg_add' }]] }
      });
      return;
    }
    const buttons = pkgs.map(p => ([{
      text: `${p.featured ? '⭐ ' : ''}${p.name} — ${p.price}₽ (${p.duration})`,
      callback_data: `pkg_view_${p.id}`
    }]));
    buttons.push([{ text: '➕ Добавить тариф', callback_data: 'pkg_add' }]);
    bot.sendMessage(chatId, '💰 *Тарифы:*', {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: buttons }
    });
  };

  const sendPackageCard = (chatId, pkg) => {
    const featStr = pkg.features.length > 0
      ? pkg.features.map((f, i) => `${i + 1}. ${f}`).join('\n')
      : 'Нет опций';
    const featDeleteBtns = pkg.features.map((f, i) => ([{
      text: `🗑 ${f.substring(0, 28)}`,
      callback_data: `pkg_feat_del_${pkg.id}_${i}`
    }]));
    const oldPriceLine = pkg.oldPrice ? `\n~~${pkg.oldPrice}₽~~ → *${pkg.price}₽*` : `\n💰 ${pkg.price}₽`;
    const oldPriceBtnText = pkg.oldPrice ? `📉 Старая цена: ${pkg.oldPrice}₽` : '📉 Добавить старую цену';
    bot.sendMessage(chatId,
      `${pkg.featured ? '⭐ ' : ''}*${pkg.name}*\n⏱ ${pkg.duration}${oldPriceLine}${pkg.badge ? ` · 🏷 ${pkg.badge}` : ''}\n\n*Опции:*\n${featStr}`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✏️ Название', callback_data: `pkg_edit_name_${pkg.id}` },
              { text: '⏱ Длительность', callback_data: `pkg_edit_dur_${pkg.id}` }
            ],
            [
              { text: '💰 Новая цена', callback_data: `pkg_edit_price_${pkg.id}` },
              { text: '🏷 Бейдж', callback_data: `pkg_edit_badge_${pkg.id}` }
            ],
            [{ text: oldPriceBtnText, callback_data: `pkg_edit_oldprice_${pkg.id}` }],
            [{ text: pkg.featured ? '⭐ Убрать ХИТ' : '⭐ Сделать ХИТ', callback_data: `pkg_toggle_${pkg.id}` }],
            [{ text: '➕ Добавить опцию', callback_data: `pkg_feat_add_${pkg.id}` }],
            ...featDeleteBtns,
            [{ text: '🗑 Удалить тариф', callback_data: `pkg_delete_${pkg.id}` }],
            [{ text: '« К тарифам', callback_data: 'pkg_list' }]
          ]
        }
      }
    );
  };

  // ── Callback-кнопки ─────────────────────────────────────────────────────────
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    if (chatId !== ADMIN_CHAT_ID) return;
    const data = query.data;
    bot.answerCallbackQuery(query.id);

    if (data === 'card_number') {
      setState(chatId, { action: 'card_number' });
      bot.sendMessage(chatId, '🔢 Введи новый номер карты (16 цифр):');
    } else if (data === 'card_bank') {
      setState(chatId, { action: 'card_bank' });
      bot.sendMessage(chatId, '🏦 Введи название банка:');
    } else if (data === 'card_name') {
      setState(chatId, { action: 'card_name' });
      bot.sendMessage(chatId, '👤 Введи имя получателя:');
    } else if (data === 'qr_url') {
      setState(chatId, { action: 'qr_url' });
      bot.sendMessage(chatId, '🔗 Отправь ссылку для QR-кода:');
    } else if (data === 'qr_image') {
      setState(chatId, { action: 'qr_image' });
      bot.sendMessage(chatId, '🖼 Отправь картинку QR-кода:');
    } else if (data.startsWith('snack_view_')) {
      const id = data.replace('snack_view_', '');
      const snacks = readJSON(SNACKS_FILE);
      const snack = snacks.find(s => s.id === id);
      if (!snack) return;
      const imgStatus = snack.image ? '✅ есть' : '❌ нет';
      const thumbStatus = snack.thumb ? '✅ есть' : '❌ нет';
      const visual = snack.image ? `🖼 [фон: ${snack.image}]` : (snack.thumb ? `📸 [thumb: ${snack.thumb}]` : snack.emoji);
      bot.sendMessage(chatId,
        `${snack.emoji} *${snack.name}*\nЦена: ${snack.price}₽\nФон: ${imgStatus} · Миниатюра: ${thumbStatus}`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✏️ Изменить название', callback_data: `snack_edit_name_${id}` }],
              [{ text: '💰 Изменить цену', callback_data: `snack_edit_price_${id}` }],
              [{ text: '😀 Изменить эмодзи', callback_data: `snack_edit_emoji_${id}` }],
              [{ text: '🖼 Загрузить фон', callback_data: `snack_image_${id}` }, { text: '🗑 Очистить фон', callback_data: `snack_image_clear_${id}` }],
              [{ text: '📸 Загрузить миниатюру', callback_data: `snack_thumb_${id}` }, { text: '🗑 Очистить миниатюру', callback_data: `snack_thumb_clear_${id}` }],
              [{ text: '🗑 Удалить', callback_data: `snack_delete_${id}` }],
              [{ text: '« Назад к списку', callback_data: 'snack_list' }]
            ]
          }
        }
      );
    } else if (data === 'snack_list') {
      sendSnacksList(chatId);
    } else if (data === 'snack_add') {
      setState(chatId, { action: 'snack_add', step: 'name' });
      bot.sendMessage(chatId, '➕ *Новый снек*\n\nШаг 1/3 — Введи название:', { parse_mode: 'Markdown' });
    } else if (data.startsWith('snack_edit_name_')) {
      const id = data.replace('snack_edit_name_', '');
      setState(chatId, { action: 'snack_edit', field: 'name', id });
      bot.sendMessage(chatId, '✏️ Введи новое название:');
    } else if (data.startsWith('snack_edit_price_')) {
      const id = data.replace('snack_edit_price_', '');
      setState(chatId, { action: 'snack_edit', field: 'price', id });
      bot.sendMessage(chatId, '💰 Введи новую цену (только цифры):');
    } else if (data.startsWith('snack_edit_emoji_')) {
      const id = data.replace('snack_edit_emoji_', '');
      setState(chatId, { action: 'snack_edit', field: 'emoji', id });
      bot.sendMessage(chatId, '😀 Отправь эмодзи:');
    } else if (data.startsWith('snack_delete_')) {
      const id = data.replace('snack_delete_', '');
      const snacks = readJSON(SNACKS_FILE);
      const snack = snacks.find(s => s.id === id);
      bot.sendMessage(chatId, `🗑 Удалить *${snack?.name}*?`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Да, удалить', callback_data: `snack_delete_confirm_${id}` }],
            [{ text: '❌ Отмена', callback_data: `snack_view_${id}` }]
          ]
        }
      });
    } else if (data.startsWith('snack_delete_confirm_')) {
      const id = data.replace('snack_delete_confirm_', '');
      let snacks = readJSON(SNACKS_FILE);
      snacks = snacks.filter(s => s.id !== id);
      writeJSON(SNACKS_FILE, snacks);
      bot.sendMessage(chatId, '✅ Снек удалён!');
      sendSnacksList(chatId);
    } else if (data.startsWith('snack_image_')) {
      const id = data.replace('snack_image_', '');
      if (id.startsWith('clear_')) {
        const snackId = id.replace('clear_', '');
        const snacks = readJSON(SNACKS_FILE);
        const snack = snacks.find(s => s.id === snackId);
        if (snack) {
          delete snack.image;
          writeJSON(SNACKS_FILE, snacks);
          bot.sendMessage(chatId, '✅ Фоновая картинка удалена!');
          bot.emit('callback_query', { ...query, data: `snack_view_${snackId}` });
        }
      } else {
        setState(chatId, { action: 'snack_image', id });
        bot.sendMessage(chatId, '🖼 Отправь картинку для фона снека (будет фоном всей карточки):');
      }
    } else if (data.startsWith('snack_thumb_')) {
      const id = data.replace('snack_thumb_', '');
      if (id.startsWith('clear_')) {
        const snackId = id.replace('clear_', '');
        const snacks = readJSON(SNACKS_FILE);
        const snack = snacks.find(s => s.id === snackId);
        if (snack) {
          delete snack.thumb;
          writeJSON(SNACKS_FILE, snacks);
          bot.sendMessage(chatId, '✅ Миниатюра удалена!');
          bot.emit('callback_query', { ...query, data: `snack_view_${snackId}` });
        }
      } else {
        setState(chatId, { action: 'snack_thumb', id });
        bot.sendMessage(chatId, '📸 Отправь картинку для миниатюры снека (покажется вместо эмодзи):');
      }
    } else if (data === 'city_add') {
      setState(chatId, { action: 'city_add' });
      bot.sendMessage(chatId, '🏙 Введи название нового города:');
    } else if (data.startsWith('city_view_')) {
      const cityId = data.replace('city_view_', '');
      const s = readJSON(SETTINGS_FILE);
      const city = s.cities.find(c => c.id === cityId);
      if (!city) return;
      const addrList = city.addresses.length > 0
        ? city.addresses.map(a => `• ${a.address}`).join('\n')
        : 'Адресов нет';
      bot.sendMessage(chatId,
        `🏙 *${city.name}*\n\n📍 Адреса:\n${addrList}`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '➕ Добавить адрес', callback_data: `city_addr_add_${cityId}` }],
              ...city.addresses.map(a => [{ text: `🗑 Удалить: ${a.address.substring(0, 25)}`, callback_data: `city_addr_del_${cityId}_${a.id}` }]),
              [{ text: '🗑 Удалить город', callback_data: `city_delete_${cityId}` }],
              [{ text: '« К списку городов', callback_data: 'city_list' }]
            ]
          }
        }
      );
    } else if (data === 'city_list') {
      sendCitiesList(chatId);
    } else if (data.startsWith('city_addr_add_')) {
      const cityId = data.replace('city_addr_add_', '');
      setState(chatId, { action: 'city_addr_add', cityId });
      bot.sendMessage(chatId, '📍 Введи новый адрес:');
    } else if (data.startsWith('city_addr_del_')) {
      const parts = data.replace('city_addr_del_', '').split('_');
      const cityId = parts[0];
      const addrId = parts[1];
      const s = readJSON(SETTINGS_FILE);
      const city = s.cities.find(c => c.id === cityId);
      if (city) {
        city.addresses = city.addresses.filter(a => a.id !== addrId);
        writeJSON(SETTINGS_FILE, s);
        bot.sendMessage(chatId, '✅ Адрес удалён!');
        bot.emit('callback_query', { ...query, data: `city_view_${cityId}` });
      }
    } else if (data.startsWith('city_delete_')) {
      const cityId = data.replace('city_delete_', '');
      const s = readJSON(SETTINGS_FILE);
      s.cities = s.cities.filter(c => c.id !== cityId);
      writeJSON(SETTINGS_FILE, s);
      bot.sendMessage(chatId, '✅ Город удалён!');
      sendCitiesList(chatId);

    // ── Тарифы ──
    } else if (data === 'pkg_list') {
      sendPackagesList(chatId);
    } else if (data.startsWith('pkg_view_')) {
      const id = data.replace('pkg_view_', '');
      const s = readJSON(SETTINGS_FILE);
      const pkg = (s.packages || []).find(p => p.id === id);
      if (pkg) sendPackageCard(chatId, pkg);
    } else if (data === 'pkg_add') {
      setState(chatId, { action: 'pkg_add', step: 'name' });
      bot.sendMessage(chatId, '➕ *Новый тариф*\n\nШаг 1/3 — Введи название:', { parse_mode: 'Markdown' });
    } else if (data.startsWith('pkg_edit_name_')) {
      const id = data.replace('pkg_edit_name_', '');
      setState(chatId, { action: 'pkg_edit', field: 'name', id });
      bot.sendMessage(chatId, '✏️ Введи новое название тарифа:');
    } else if (data.startsWith('pkg_edit_dur_')) {
      const id = data.replace('pkg_edit_dur_', '');
      setState(chatId, { action: 'pkg_edit', field: 'duration', id });
      bot.sendMessage(chatId, '⏱ Введи новую длительность (например: 3 часа):');
    } else if (data.startsWith('pkg_edit_price_')) {
      const id = data.replace('pkg_edit_price_', '');
      setState(chatId, { action: 'pkg_edit', field: 'price', id });
      bot.sendMessage(chatId, '💰 Введи новую цену (только цифры):');
    } else if (data.startsWith('pkg_edit_badge_')) {
      const id = data.replace('pkg_edit_badge_', '');
      setState(chatId, { action: 'pkg_edit', field: 'badge', id });
      bot.sendMessage(chatId, '🏷 Введи текст бейджа (например: ХИТ) или — чтобы убрать:');
    } else if (data.startsWith('pkg_edit_oldprice_')) {
      const id = data.replace('pkg_edit_oldprice_', '');
      setState(chatId, { action: 'pkg_edit', field: 'oldPrice', id });
      bot.sendMessage(chatId, '📉 Введи старую цену (только цифры) или — чтобы убрать:');
    } else if (data.startsWith('pkg_toggle_')) {
      const id = data.replace('pkg_toggle_', '');
      const s = readJSON(SETTINGS_FILE);
      const pkg = (s.packages || []).find(p => p.id === id);
      if (pkg) {
        pkg.featured = !pkg.featured;
        writeJSON(SETTINGS_FILE, s);
        bot.sendMessage(chatId, pkg.featured ? '⭐ Тариф помечен как ХИТ!' : '✅ Отметка ХИТ снята.');
        sendPackageCard(chatId, pkg);
      }
    } else if (data.startsWith('pkg_feat_add_')) {
      const id = data.replace('pkg_feat_add_', '');
      setState(chatId, { action: 'pkg_feat_add', id });
      bot.sendMessage(chatId, '➕ Введи новую опцию тарифа (одну строку):');
    } else if (data.startsWith('pkg_feat_del_')) {
      const rest = data.replace('pkg_feat_del_', '');
      const lastUs = rest.lastIndexOf('_');
      const id = rest.substring(0, lastUs);
      const idx = parseInt(rest.substring(lastUs + 1));
      const s = readJSON(SETTINGS_FILE);
      const pkg = (s.packages || []).find(p => p.id === id);
      if (pkg && !isNaN(idx)) {
        pkg.features.splice(idx, 1);
        writeJSON(SETTINGS_FILE, s);
        bot.sendMessage(chatId, '✅ Опция удалена!');
        sendPackageCard(chatId, pkg);
      }
    } else if (data.startsWith('pkg_delete_') && !data.startsWith('pkg_delete_confirm_')) {
      const id = data.replace('pkg_delete_', '');
      const s = readJSON(SETTINGS_FILE);
      const pkg = (s.packages || []).find(p => p.id === id);
      bot.sendMessage(chatId, `🗑 Удалить тариф *${pkg?.name}*?`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Да, удалить', callback_data: `pkg_delete_confirm_${id}` }],
            [{ text: '❌ Отмена', callback_data: `pkg_view_${id}` }]
          ]
        }
      });
    } else if (data.startsWith('pkg_delete_confirm_')) {
      const id = data.replace('pkg_delete_confirm_', '');
      const s = readJSON(SETTINGS_FILE);
      s.packages = (s.packages || []).filter(p => p.id !== id);
      writeJSON(SETTINGS_FILE, s);
      bot.sendMessage(chatId, '✅ Тариф удалён!');
      sendPackagesList(chatId);

    // ── Залы ──
    } else if (data === 'room_list') {
      sendRoomsList(chatId);
    } else if (data === 'room_add') {
      setState(chatId, { action: 'room_add', step: 'name' });
      bot.sendMessage(chatId, '🎭 *Новый зал*\n\nШаг 1/2 — Введи название:', { parse_mode: 'Markdown' });
    } else if (data.startsWith('room_view_')) {
      const id = data.replace('room_view_', '');
      const s = readJSON(SETTINGS_FILE);
      const room = (s.rooms || []).find(r => r.id === id);
      if (room) sendRoomCard(chatId, room);
    } else if (data.startsWith('room_edit_name_')) {
      const id = data.replace('room_edit_name_', '');
      setState(chatId, { action: 'room_edit', field: 'name', id });
      bot.sendMessage(chatId, '✏️ Введи новое название зала:');
    } else if (data.startsWith('room_edit_tag_')) {
      const id = data.replace('room_edit_tag_', '');
      setState(chatId, { action: 'room_edit', field: 'tag', id });
      bot.sendMessage(chatId, '🏷 Введи тег зала (например: Зал 1 · До 6 человек):');
    } else if (data.startsWith('room_photo_')) {
      const id = data.replace('room_photo_', '');
      setState(chatId, { action: 'room_photo', id });
      bot.sendMessage(chatId, '📸 Отправь фото зала:');
    } else if (data.startsWith('room_feat_add_')) {
      const id = data.replace('room_feat_add_', '');
      setState(chatId, { action: 'room_feat_add', id });
      bot.sendMessage(chatId, '➕ Введи новую характеристику зала:');
    } else if (data.startsWith('room_feat_del_')) {
      const rest = data.replace('room_feat_del_', '');
      const lastUs = rest.lastIndexOf('_');
      const id = rest.substring(0, lastUs);
      const idx = parseInt(rest.substring(lastUs + 1));
      const s = readJSON(SETTINGS_FILE);
      const room = (s.rooms || []).find(r => r.id === id);
      if (room && !isNaN(idx)) {
        room.features.splice(idx, 1);
        writeJSON(SETTINGS_FILE, s);
        bot.sendMessage(chatId, '✅ Характеристика удалена!');
        sendRoomCard(chatId, room);
      }
    } else if (data.startsWith('room_delete_') && !data.startsWith('room_delete_confirm_')) {
      const id = data.replace('room_delete_', '');
      const s = readJSON(SETTINGS_FILE);
      const room = (s.rooms || []).find(r => r.id === id);
      bot.sendMessage(chatId, `🗑 Удалить зал *${room?.name}*?`, {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [
          [{ text: '✅ Да, удалить', callback_data: `room_delete_confirm_${id}` }],
          [{ text: '❌ Отмена', callback_data: `room_view_${id}` }]
        ]}
      });
    } else if (data.startsWith('room_delete_confirm_')) {
      const id = data.replace('room_delete_confirm_', '');
      const s = readJSON(SETTINGS_FILE);
      s.rooms = (s.rooms || []).filter(r => r.id !== id);
      writeJSON(SETTINGS_FILE, s);
      bot.sendMessage(chatId, '✅ Зал удалён!');
      sendRoomsList(chatId);
    }
  });

  // ── Обработка текстовых сообщений ───────────────────────────────────────────
  bot.on('message', async (msg) => {
    // Сообщения из группы техподдержки → пробрасываем в WebSocket клиента
    if (msg.chat.id === SUPPORT_GROUP_ID && msg.message_thread_id && !msg.from?.is_bot) {
      const sessionId = threadToSession.get(msg.message_thread_id);
      if (sessionId) {
        const session = chatSessions.get(sessionId);
        if (session && session.ws.readyState === WebSocket.OPEN) {
          session.ws.send(JSON.stringify({
            type: 'message',
            text: msg.text || '',
            from: msg.from?.first_name || 'Оператор'
          }));
        }
      }
      return;
    }

    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const text = msg.text;
    const st = getState(chatId);

    if (!st) return;
    if (text && text.startsWith('/')) return;

    const s = readJSON(SETTINGS_FILE);

    if (st.action === 'card_number' && text) {
      s.card.number = text.trim();
      writeJSON(SETTINGS_FILE, s);
      clearState(chatId);
      bot.sendMessage(chatId, `✅ Номер карты обновлён: \`${s.card.number}\``, { parse_mode: 'Markdown' });
    } else if (st.action === 'card_bank' && text) {
      s.card.bank = text.trim();
      writeJSON(SETTINGS_FILE, s);
      clearState(chatId);
      bot.sendMessage(chatId, `✅ Банк обновлён: *${s.card.bank}*`, { parse_mode: 'Markdown' });
    } else if (st.action === 'card_name' && text) {
      s.card.name = text.trim();
      writeJSON(SETTINGS_FILE, s);
      clearState(chatId);
      bot.sendMessage(chatId, `✅ Получатель обновлён: *${s.card.name}*`, { parse_mode: 'Markdown' });
    } else if (st.action === 'qr_url' && text) {
      s.qr.type = 'url';
      s.qr.value = text.trim();
      s.qr.image = null;
      writeJSON(SETTINGS_FILE, s);
      clearState(chatId);
      bot.sendMessage(chatId, `✅ QR-ссылка обновлена!`);
    } else if (st.action === 'snack_add') {
      if (st.step === 'name' && text) {
        setState(chatId, { action: 'snack_add', step: 'price', name: text.trim() });
        bot.sendMessage(chatId, `Шаг 2/3 — Введи цену в рублях (только цифры):`);
      } else if (st.step === 'price' && text) {
        const price = parseInt(text.trim());
        if (isNaN(price)) {
          bot.sendMessage(chatId, '❌ Только цифры! Введи цену ещё раз:');
          return;
        }
        setState(chatId, { action: 'snack_add', step: 'emoji', name: st.name, price });
        bot.sendMessage(chatId, `Шаг 3/3 — Отправь эмодзи для снека:`);
      } else if (st.step === 'emoji' && text) {
        const snacks = readJSON(SNACKS_FILE);
        const newSnack = { id: Date.now().toString(), name: st.name, price: st.price, emoji: text.trim() };
        snacks.push(newSnack);
        writeJSON(SNACKS_FILE, snacks);
        clearState(chatId);
        bot.sendMessage(chatId, `✅ Снек добавлен: ${newSnack.emoji} *${newSnack.name}* — ${newSnack.price}₽`, { parse_mode: 'Markdown' });
        sendSnacksList(chatId);
      }
    } else if (st.action === 'snack_edit' && text) {
      const snacks = readJSON(SNACKS_FILE);
      const idx = snacks.findIndex(s => s.id === st.id);
      if (idx === -1) return;
      if (st.field === 'price') {
        const price = parseInt(text.trim());
        if (isNaN(price)) { bot.sendMessage(chatId, '❌ Только цифры!'); return; }
        snacks[idx].price = price;
      } else {
        snacks[idx][st.field] = text.trim();
      }
      writeJSON(SNACKS_FILE, snacks);
      clearState(chatId);
      bot.sendMessage(chatId, `✅ Снек обновлён!`);
      sendSnacksList(chatId);
    } else if (st.action === 'city_add' && text) {
      const newCity = { id: Date.now().toString(), name: text.trim(), addresses: [] };
      s.cities.push(newCity);
      writeJSON(SETTINGS_FILE, s);
      clearState(chatId);
      bot.sendMessage(chatId, `✅ Город *${newCity.name}* добавлен!`, { parse_mode: 'Markdown' });
      sendCitiesList(chatId);
    } else if (st.action === 'city_addr_add' && text) {
      const city = s.cities.find(c => c.id === st.cityId);
      if (city) {
        city.addresses.push({ id: Date.now().toString(), address: text.trim() });
        writeJSON(SETTINGS_FILE, s);
        clearState(chatId);
        bot.sendMessage(chatId, `✅ Адрес добавлен!`);
      }

    // ── Тарифы — добавление ──
    } else if (st.action === 'pkg_add') {
      if (st.step === 'name' && text) {
        setState(chatId, { action: 'pkg_add', step: 'duration', name: text.trim() });
        bot.sendMessage(chatId, 'Шаг 2/3 — Введи длительность (например: 3 часа):');
      } else if (st.step === 'duration' && text) {
        setState(chatId, { action: 'pkg_add', step: 'price', name: st.name, duration: text.trim() });
        bot.sendMessage(chatId, 'Шаг 3/3 — Введи цену в рублях (только цифры):');
      } else if (st.step === 'price' && text) {
        const price = parseInt(text.trim());
        if (isNaN(price)) { bot.sendMessage(chatId, '❌ Только цифры! Введи цену:'); return; }
        const newPkg = {
          id: 'pkg_' + Date.now(),
          name: st.name,
          duration: st.duration,
          price,
          features: [],
          featured: false,
          badge: null
        };
        s.packages = s.packages || [];
        s.packages.push(newPkg);
        writeJSON(SETTINGS_FILE, s);
        clearState(chatId);
        bot.sendMessage(chatId, `✅ Тариф *${newPkg.name}* добавлен!`, { parse_mode: 'Markdown' });
        sendPackageCard(chatId, newPkg);
      }

    // ── Тарифы — редактирование поля ──
    } else if (st.action === 'pkg_edit' && text) {
      const pkg = (s.packages || []).find(p => p.id === st.id);
      if (!pkg) return;
      if (st.field === 'price') {
        const price = parseInt(text.trim());
        if (isNaN(price)) { bot.sendMessage(chatId, '❌ Только цифры!'); return; }
        pkg.price = price;
      } else if (st.field === 'oldPrice') {
        if (text.trim() === '—') {
          pkg.oldPrice = null;
        } else {
          const oldPrice = parseInt(text.trim());
          if (isNaN(oldPrice)) { bot.sendMessage(chatId, '❌ Только цифры или — чтобы убрать!'); return; }
          pkg.oldPrice = oldPrice;
        }
      } else if (st.field === 'badge') {
        pkg.badge = text.trim() === '—' ? null : text.trim();
      } else {
        pkg[st.field] = text.trim();
      }
      writeJSON(SETTINGS_FILE, s);
      clearState(chatId);
      bot.sendMessage(chatId, '✅ Тариф обновлён!');
      sendPackageCard(chatId, pkg);

    // ── Тарифы — добавление опции ──
    } else if (st.action === 'pkg_feat_add' && text) {
      const pkg = (s.packages || []).find(p => p.id === st.id);
      if (pkg) {
        pkg.features.push(text.trim());
        writeJSON(SETTINGS_FILE, s);
        clearState(chatId);
        bot.sendMessage(chatId, '✅ Опция добавлена!');
        sendPackageCard(chatId, pkg);
      }

    // ── Залы — добавление ──
    } else if (st.action === 'room_add') {
      if (st.step === 'name' && text) {
        setState(chatId, { action: 'room_add', step: 'tag', name: text.trim() });
        bot.sendMessage(chatId, 'Шаг 2/2 — Введи тег (например: Зал 1 · До 6 человек):');
      } else if (st.step === 'tag' && text) {
        const newRoom = { id: 'room_' + Date.now(), name: st.name, tag: text.trim(), features: [], photo: null };
        const s2 = readJSON(SETTINGS_FILE);
        s2.rooms = s2.rooms || [];
        s2.rooms.push(newRoom);
        writeJSON(SETTINGS_FILE, s2);
        clearState(chatId);
        bot.sendMessage(chatId, `✅ Зал *${newRoom.name}* добавлен!`, { parse_mode: 'Markdown' });
        sendRoomCard(chatId, newRoom);
      }

    // ── Залы — редактирование ──
    } else if (st.action === 'room_edit' && text) {
      const s2 = readJSON(SETTINGS_FILE);
      const room = (s2.rooms || []).find(r => r.id === st.id);
      if (!room) return;
      room[st.field] = text.trim();
      writeJSON(SETTINGS_FILE, s2);
      clearState(chatId);
      bot.sendMessage(chatId, '✅ Зал обновлён!');
      sendRoomCard(chatId, room);

    // ── Залы — характеристика ──
    } else if (st.action === 'room_feat_add' && text) {
      const s2 = readJSON(SETTINGS_FILE);
      const room = (s2.rooms || []).find(r => r.id === st.id);
      if (room) {
        room.features.push(text.trim());
        writeJSON(SETTINGS_FILE, s2);
        clearState(chatId);
        bot.sendMessage(chatId, '✅ Характеристика добавлена!');
        sendRoomCard(chatId, room);
      }
    }
  });

  // ── QR картинка (фото) ──────────────────────────────────────────────────────
  bot.on('photo', async (msg) => {
    if (!isAdmin(msg)) return;
    const chatId = msg.chat.id;
    const st = getState(chatId);
    if (!st) return;

    const photo = msg.photo[msg.photo.length - 1];
    const fileInfo = await bot.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
    const ext = path.extname(fileInfo.file_path) || '.jpg';

    // ── Фото зала ──
    if (st.action === 'room_photo') {
      const filename = 'room_' + Date.now() + ext;
      const dest = path.join(UPLOADS_DIR, filename);
      const file = fs.createWriteStream(dest);
      https.get(fileUrl, (response) => {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          const s = readJSON(SETTINGS_FILE);
          const room = (s.rooms || []).find(r => r.id === st.id);
          if (room) {
            room.photo = '/uploads/' + filename;
            writeJSON(SETTINGS_FILE, s);
            clearState(chatId);
            bot.sendMessage(chatId, '✅ Фото зала обновлено!');
            sendRoomCard(chatId, room);
          }
        });
      });
      return;
    }

    // ── Фото снека (фон карточки) ──
    if (st.action === 'snack_image') {
      const filename = 'snack_' + Date.now() + ext;
      const dest = path.join(UPLOADS_DIR, filename);
      const file = fs.createWriteStream(dest);
      https.get(fileUrl, (response) => {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          const snacks = readJSON(SNACKS_FILE);
          const snack = snacks.find(s => s.id === st.id);
          if (snack) {
            snack.image = '/uploads/' + filename;
            writeJSON(SNACKS_FILE, snacks);
            clearState(chatId);
            bot.sendMessage(chatId, '✅ Фоновая картинка снека обновлена!');
            bot.emit('callback_query', { id: '', from: msg.from, message: { chat: { id: chatId } }, data: `snack_view_${st.id}` });
          }
        });
      });
      return;
    }

    // ── Фото миниатюры снека ──
    if (st.action === 'snack_thumb') {
      const filename = 'snack_thumb_' + Date.now() + ext;
      const dest = path.join(UPLOADS_DIR, filename);
      const file = fs.createWriteStream(dest);
      https.get(fileUrl, (response) => {
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          const snacks = readJSON(SNACKS_FILE);
          const snack = snacks.find(s => s.id === st.id);
          if (snack) {
            snack.thumb = '/uploads/' + filename;
            writeJSON(SNACKS_FILE, snacks);
            clearState(chatId);
            bot.sendMessage(chatId, '✅ Миниатюра снека обновлена!');
            bot.emit('callback_query', { id: '', from: msg.from, message: { chat: { id: chatId } }, data: `snack_view_${st.id}` });
          }
        });
      });
      return;
    }

    if (st.action !== 'qr_image') return;

    const filename = 'qr_' + Date.now() + ext;
    const dest = path.join(UPLOADS_DIR, filename);

    const file = fs.createWriteStream(dest);
    https.get(fileUrl, (response) => {
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        const s = readJSON(SETTINGS_FILE);
        s.qr.type = 'image';
        s.qr.image = '/uploads/' + filename;
        s.qr.value = '';
        writeJSON(SETTINGS_FILE, s);
        clearState(chatId);
        bot.sendMessage(chatId, '✅ QR-картинка обновлена на сайте!');
      });
    });
  });

  console.log('🤖 Telegram-бот запущен');
}

// ─── Запуск сервера ───────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
});
