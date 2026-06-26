# АнтиКино — сайт + Telegram-бот

## Быстрый старт

### 1. Установи зависимости
```bash
npm install
```

### 2. Настрой .env
```bash
cp .env.example .env
```
Открой `.env` и заполни:
- `BOT_TOKEN` — токен от @BotFather
- `ADMIN_CHAT_ID` — твой Telegram ID (узнать у @userinfobot)
- `PORT` — порт сервера (по умолчанию 3000)

### 3. Запусти сервер
```bash
node server.js
# или для разработки:
npm run dev
```

Сайт будет доступен на `http://localhost:3000`

---

## Управление через Telegram

Напиши боту /start — откроется меню:

| Кнопка | Что делает |
|--------|-----------|
| 💳 Карта оплаты | Смена номера, банка, получателя |
| 📱 QR-код | Новая ссылка или загрузка картинки |
| 🍿 Допы/снеки | Добавить / изменить / удалить снек |
| 🏙 Города и адреса | Управление городами и адресами филиалов |
| ⚙️ Jivo виджет | Вставить код виджета чата |

---

## Структура файлов

```
antikino/
├── server.js          # Сервер + бот
├── package.json
├── .env               # Секретные ключи (не коммитить!)
├── .env.example       # Пример настроек
├── data/
│   ├── settings.json  # Карта, QR, города
│   └── snacks.json    # Снеки
├── uploads/           # Загруженные QR-картинки
└── public/
    └── index.html     # Сайт
```

---

## Деплой на сервер (Ubuntu/Debian)

```bash
# Установи Node.js если нет
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Клонируй проект и установи зависимости
npm install

# Запусти через PM2 (автозапуск)
npm install -g pm2
pm2 start server.js --name antikino
pm2 save
pm2 startup
```

## Jivo чат

1. Зарегистрируйся на [jivo.ru](https://www.jivo.ru)
2. Создай виджет, скопируй код скрипта
3. Напиши боту ⚙️ Jivo виджет и вставь код
4. Сайт автоматически подхватит виджет
