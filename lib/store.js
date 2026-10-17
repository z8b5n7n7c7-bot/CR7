// Простое хранилище в JSON-файле: лимиты, PRO-доступ и платежи переживают перезапуск.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAY_MS = 24 * 60 * 60 * 1000;
const today = (now) => new Date(now).toISOString().slice(0, 10);

function createStore(file, { now = Date.now } = {}) {
  let data = { usage: {}, pro: {}, orders: {}, tgPro: {} };
  if (file && fs.existsSync(file)) {
    try {
      data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (e) {
      // Не затираем повреждённый файл молча: сохраняем копию для разбора.
      fs.copyFileSync(file, file + '.corrupt-' + Date.now());
      console.error('Хранилище повреждено, начинаю с пустого:', e.message);
    }
  }

  let timer = null;
  function save() {
    if (!file || timer) return;
    timer = setTimeout(flush, 200);
  }
  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file); // атомарная замена: файл не окажется недописанным
  }

  function pruneUsage() {
    const d = today(now());
    for (const k of Object.keys(data.usage)) if (!k.endsWith('|' + d)) delete data.usage[k];
  }

  return {
    // Резервирует одну бесплатную генерацию. Возвращает функцию отката или null, если лимит исчерпан.
    reserve(who, limit) {
      pruneUsage();
      const key = who + '|' + today(now());
      const used = data.usage[key] || 0;
      if (used >= limit) return null;
      data.usage[key] = used + 1;
      save();
      return {
        left: limit - used - 1,
        refund: () => {
          if (data.usage[key] > 0) data.usage[key]--;
          save();
        },
      };
    },

    issueCode({ days, plan, orderId }) {
      const code = 'PRO-' + crypto.randomBytes(5).toString('hex').toUpperCase();
      data.pro[code] = { plan, orderId, expires: now() + days * DAY_MS };
      save();
      return code;
    },
    checkCode(code) {
      const rec = typeof code === 'string' && Object.hasOwn(data.pro, code.trim().toUpperCase())
        ? data.pro[code.trim().toUpperCase()] : null;
      return rec && rec.expires > now() ? rec : null;
    },

    createOrder(order) {
      // Брошенные неоплаченные заказы старше 2 дней удаляем, чтобы файл не разрастался.
      for (const [k, o] of Object.entries(data.orders)) {
        if (!o.code && now() - o.created > 2 * DAY_MS) delete data.orders[k];
      }
      const id = crypto.randomBytes(12).toString('hex');
      data.orders[id] = { ...order, status: 'pending', created: now() };
      save();
      return id;
    },
    getOrder: (id) => (typeof id === 'string' && Object.hasOwn(data.orders, id) ? data.orders[id] : null),
    findOrderByPayment: (paymentId) => Object.entries(data.orders).find(([, o]) => o.paymentId === paymentId)?.[0] || null,
    updateOrder(id, patch) {
      if (!Object.hasOwn(data.orders, id)) return; // заказ мог быть удалён очисткой
      Object.assign(data.orders[id], patch);
      save();
    },

    linkTelegram(chatId, code) {
      data.tgPro[chatId] = code;
      save();
    },
    telegramCode: (chatId) => data.tgPro[chatId] || null,

    flush,
    _data: () => data,
  };
}

module.exports = { createStore };
