// КарточкаPRO — генератор SEO-карточек товаров для Wildberries и Ozon.
// Запуск: node server.js (настройки — в переменных окружения, см. .env.example)
const http = require('http');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { createAIGenerator, generateDemo } = require('./lib/generate');
const { createStore } = require('./lib/store');
const { createYooKassa } = require('./lib/payments');
const { createApp } = require('./lib/app');
const { createBot } = require('./lib/bot');

// Подхватываем .env из текущей папки, если он есть (Node 20.12+).
try { process.loadEnvFile(); } catch {}

const env = process.env;
const PORT = Number(env.PORT || 3000);
const config = {
  freePerDay: Number(env.FREE_PER_DAY || 3),
  baseUrl: (env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, ''),
  trustProxy: env.TRUST_PROXY === '1',
  demo: !env.ANTHROPIC_API_KEY,
  botUsername: (env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, ''),
};

const store = createStore(env.DATA_FILE || path.join(__dirname, 'data', 'store.json'));
const generate = config.demo
  ? async (p) => generateDemo(p)
  : createAIGenerator(new Anthropic(), {
    model: env.MODEL || 'claude-opus-5-5',
    effort: env.EFFORT || 'low',
    // Реальная стоимость генерации видна в логах: сверяйте с ценами на console.anthropic.com
    onUsage: (u, model) => console.log(`usage ${model}: in=${u?.input_tokens} out=${u?.output_tokens}`),
  });
const payments = env.YOOKASSA_SHOP_ID && env.YOOKASSA_SECRET_KEY
  ? createYooKassa({ shopId: env.YOOKASSA_SHOP_ID, secretKey: env.YOOKASSA_SECRET_KEY })
  : null;

const server = http.createServer(createApp({ store, generate, payments, config }));
server.requestTimeout = 120_000;
server.listen(PORT, () => {
  console.log(`КарточкаPRO: ${config.baseUrl}`);
  console.log(`  ИИ: ${config.demo ? 'демо-режим (нет ANTHROPIC_API_KEY)' : 'включён'}`);
  console.log(`  Оплата: ${payments ? 'ЮKassa' : 'не подключена'}`);
});

const bot = env.TELEGRAM_BOT_TOKEN ? createBot({ token: env.TELEGRAM_BOT_TOKEN, store, generate, config }) : null;
if (bot) {
  bot.run();
  console.log('  Telegram-бот: запущен');
}

function shutdown() {
  bot?.stop();
  store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
