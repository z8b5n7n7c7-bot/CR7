// HTTP-обработчик: API генерации, оплаты и раздача статики.
const fs = require('fs');
const path = require('path');
const { normalizeInput, InputError, RefusalError } = require('./generate');
const { PLANS, settleOrder } = require('./payments');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const MAX_BODY = 20_000;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', (c) => {
      if (tooBig) return; // остаток тела вычитываем впустую, чтобы клиент получил ответ 413, а не обрыв
      size += c.length;
      if (size > MAX_BODY) { tooBig = true; chunks.length = 0; reject(new HttpError(413, 'Слишком большой запрос')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooBig) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new HttpError(400, 'Некорректный JSON')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function createApp({ store, generate, payments = null, config }) {
  const { freePerDay, baseUrl, trustProxy, demo, botUsername = '' } = config;

  const clientIp = (req) =>
    (trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';

  const routes = {
    'GET /health': async () => ({ ok: true }),

    'GET /api/config': async () => ({
      freePerDay, demo, payments: !!payments, botUsername,
      plans: Object.fromEntries(Object.entries(PLANS).map(([k, p]) => [k, { amount: Number(p.amount), days: p.days }])),
    }),

    'POST /api/generate': async (req) => {
      const body = await readJson(req);
      let input;
      try { input = normalizeInput(body); } catch (e) {
        if (e instanceof InputError) throw new HttpError(400, e.message);
        throw e;
      }
      const pro = store.checkCode(body.proCode);
      const slot = pro ? null : store.reserve('ip:' + clientIp(req), freePerDay);
      if (!pro && !slot) throw Object.assign(new HttpError(402, `Бесплатный лимит (${freePerDay} в день) исчерпан`), { code: 'limit' });
      try {
        const card = await generate(input);
        return { ...card, left: pro ? null : slot.left, pro: !!pro };
      } catch (e) {
        slot?.refund(); // неудачная генерация не съедает лимит
        if (e instanceof RefusalError) throw new HttpError(422, 'Не получилось обработать этот товар. Попробуйте изменить описание.');
        throw e;
      }
    },

    'GET /api/pro': async (req, url) => {
      const rec = store.checkCode(url.searchParams.get('code'));
      return rec ? { valid: true, expires: rec.expires } : { valid: false };
    },

    'POST /api/pay': async (req) => {
      if (!payments) throw new HttpError(503, 'Оплата пока не подключена');
      const { plan } = await readJson(req);
      if (!Object.hasOwn(PLANS, plan)) throw new HttpError(400, 'Неизвестный тариф');
      const orderId = store.createOrder({ plan });
      const { paymentId, url } = await payments.createPayment({ plan, orderId, returnUrl: `${baseUrl}/?order=${orderId}` });
      store.updateOrder(orderId, { paymentId });
      return { url, orderId };
    },

    'GET /api/pay/status': async (req, url) => {
      if (!payments) throw new HttpError(503, 'Оплата пока не подключена');
      const r = await settleOrder({ store, payments, orderId: url.searchParams.get('order') });
      if (r.status === 'not_found') throw new HttpError(404, 'Заказ не найден');
      return r;
    },

    // Вебхук ЮKassa. Тело используем только как подсказку, какой платёж перепроверить.
    'POST /api/yookassa/webhook': async (req) => {
      if (!payments) throw new HttpError(503, 'Оплата пока не подключена');
      const body = await readJson(req);
      const orderId = store.findOrderByPayment(body?.object?.id);
      if (orderId) await settleOrder({ store, payments, orderId });
      return { ok: true };
    },
  };

  function serveStatic(res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400); return res.end('Bad request'); }
    if (rel === '/') rel = '/index.html';
    const file = path.resolve(PUBLIC_DIR, '.' + rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Не найдено'); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  }

  return async function handler(req, res) {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end(); }
    const route = routes[`${req.method} ${url.pathname}`];
    if (!route) {
      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'Не найдено' });
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return serveStatic(res, url.pathname);
    }
    try {
      send(res, 200, await route(req, url));
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, code: e.code });
      console.error(e);
      send(res, 500, { error: 'Ошибка сервера, попробуйте ещё раз' });
    }
  };
}

module.exports = { createApp };
