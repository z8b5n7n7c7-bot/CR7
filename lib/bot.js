// Telegram-бот на long polling: тот же генератор, лимиты и PRO-коды, что и на сайте.
const { normalizeInput, InputError, RefusalError } = require('./generate');

const MAX_MSG = 4000; // лимит Telegram 4096 символов, оставляем запас
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function formatCard(card) {
  return [
    `<b>Название</b>\n<code>${esc(card.title)}</code>`,
    `<b>Описание</b>\n${esc(card.description)}`,
    `<b>Ключевые слова</b>\n${esc(card.keywords.join(', '))}`,
    `<b>Преимущества</b>\n${card.bullets.map((b) => '• ' + esc(b)).join('\n')}`,
    `<b>Инфографика</b>\n${card.slides.map((s, i) => `${i + 1}. <b>${esc(s.head)}</b> — ${esc(s.sub)}`).join('\n')}`,
  ];
}

// Склеивает блоки в сообщения не длиннее MAX_MSG, не разрывая HTML-теги внутри блока.
function chunk(blocks) {
  const out = [];
  let cur = '';
  for (let b of blocks) {
    while (b.length > MAX_MSG) {
      // Слишком длинный блок (описание) режем по абзацам/строкам; теги в описании только в заголовке.
      let cut = Math.max(b.lastIndexOf('\n', MAX_MSG), MAX_MSG / 2);
      const amp = b.lastIndexOf('&', cut);
      if (amp > cut - 6 && b.indexOf(';', amp) >= cut) cut = amp; // не разрезаем &amp; и подобные
      if (cur) { out.push(cur); cur = ''; }
      out.push(b.slice(0, cut));
      b = b.slice(cut).trimStart();
    }
    if (cur && cur.length + b.length + 2 > MAX_MSG) { out.push(cur); cur = ''; }
    cur = cur ? cur + '\n\n' + b : b;
  }
  if (cur) out.push(cur);
  return out;
}

const HELP = (free) =>
  `👋 Я пишу продающие SEO-карточки для Wildberries и Ozon.\n\n` +
  `Отправьте сообщение: в первой строке название товара, дальше характеристики.\n\n` +
  `<i>Термокружка с крышкой\n500 мл, держит тепло 12 часов, нержавеющая сталь</i>\n\n` +
  `/wb или /ozon — выбрать маркетплейс\n/pro КОД — активировать PRO\n/buy — купить PRO\n\n` +
  `Бесплатно: ${free} карточки в день.`;

function createBot({ token, store, generate, config, fetchImpl = fetch, log = console }) {
  const api = async (method, body) => {
    const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram ${method}: ${data.description}`);
    return data.result;
  };
  const reply = (chatId, text) => api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  const marketplace = new Map();
  const busy = new Set();

  async function handle(msg) {
    const chatId = msg?.chat?.id;
    const text = typeof msg?.text === 'string' ? msg.text.trim() : '';
    if (!chatId || !text) return;
    const [cmd, ...args] = text.split(/\s+/);
    const command = cmd.startsWith('/') ? cmd.split('@')[0].toLowerCase() : null;

    if (command === '/start' || command === '/help') return reply(chatId, HELP(config.freePerDay));
    if (command === '/wb' || command === '/ozon') {
      marketplace.set(chatId, command.slice(1));
      return reply(chatId, `Маркетплейс: ${command === '/wb' ? 'Wildberries' : 'Ozon'} ✅`);
    }
    if (command === '/buy') return reply(chatId, `Оформить PRO: ${config.baseUrl}/#price\nПосле оплаты пришлите сюда /pro КОД`);
    if (command === '/pro') {
      const code = (args[0] || '').toUpperCase();
      if (!store.checkCode(code)) return reply(chatId, '❌ Код не найден или срок действия истёк.');
      store.linkTelegram(chatId, code);
      return reply(chatId, '✅ PRO активирован! Генерации без ограничений.');
    }
    if (command) return reply(chatId, 'Не знаю такой команды. /help');

    if (busy.has(chatId)) return reply(chatId, '⏳ Подождите, предыдущая карточка ещё готовится.');
    const [name, ...rest] = text.split('\n');
    let input;
    try {
      input = normalizeInput({ name, features: rest.join('\n'), marketplace: marketplace.get(chatId) || 'wb' });
    } catch (e) {
      if (e instanceof InputError) return reply(chatId, e.message);
      throw e;
    }
    const pro = store.checkCode(store.telegramCode(chatId));
    const slot = pro ? null : store.reserve('tg:' + chatId, config.freePerDay);
    if (!pro && !slot) return reply(chatId, `Бесплатный лимит на сегодня исчерпан 🙌\nPRO без ограничений: /buy`);

    busy.add(chatId);
    try {
      await api('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
      const card = await generate(input);
      for (const part of chunk(formatCard(card))) await reply(chatId, part);
      if (slot) await reply(chatId, `Осталось бесплатно сегодня: ${slot.left}`);
    } catch (e) {
      slot?.refund();
      if (!(e instanceof RefusalError)) log.error(e);
      await reply(chatId, e instanceof RefusalError ? 'Не получилось обработать этот товар. Измените описание.' : 'Ошибка генерации, попробуйте ещё раз.');
    } finally {
      busy.delete(chatId);
    }
  }

  let stopped = false;
  async function run() {
    let offset = 0;
    while (!stopped) {
      try {
        const updates = await api('getUpdates', { offset, timeout: 30, allowed_updates: ['message'] });
        for (const u of updates) {
          offset = u.update_id + 1;
          // Не ждём генерацию: один долгий запрос не должен блокировать остальных пользователей.
          handle(u.message).catch((e) => log.error('bot:', e.message));
        }
      } catch (e) {
        log.error('bot polling:', e.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  return { handle, run, stop: () => { stopped = true; } };
}

module.exports = { createBot, formatCard, chunk };
