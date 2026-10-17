const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../lib/app');
const { createStore } = require('../lib/store');
const { createYooKassa } = require('../lib/payments');
const { generateDemo, RefusalError } = require('../lib/generate');

// Эмулятор ЮKassa: платежи хранятся в памяти, статус меняем вручную.
function fakeKassa() {
  const db = {};
  let n = 0;
  return {
    db,
    async createPayment({ plan, orderId, returnUrl }) {
      const id = 'pay_' + ++n;
      db[id] = { id, status: 'pending', paid: false, amount: { value: plan === 'year' ? '3990.00' : '490.00', currency: 'RUB' }, metadata: { orderId, plan }, returnUrl };
      return { paymentId: id, url: 'https://yoomoney.example/pay/' + id };
    },
    async getPayment(id) {
      if (!db[id]) throw new Error('404');
      return structuredClone(db[id]);
    },
    succeed(id) { Object.assign(db[id], { status: 'succeeded', paid: true }); },
  };
}

async function setup({ generate = async (p) => generateDemo(p), payments = fakeKassa(), trustProxy = false } = {}) {
  const store = createStore(null);
  const app = createApp({ store, generate, payments, config: { freePerDay: 2, baseUrl: 'https://site.test', trustProxy, demo: true } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, url, body, headers = {}) => {
    const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text, type: r.headers.get('content-type') };
  };
  return { store, payments, req, close: () => new Promise((r) => server.close(r)) };
}

test('конфиг и статика', async (t) => {
  const s = await setup();
  t.after(s.close);
  const c = await s.req('GET', '/api/config');
  assert.equal(c.json.freePerDay, 2);
  assert.equal(c.json.payments, true);
  assert.equal(c.json.plans.month.amount, 490);
  const page = await s.req('GET', '/?order=abc&utm=1');
  assert.equal(page.status, 200, 'query-строка не ломает главную');
  assert.match(page.type, /text\/html/);
  assert.equal((await s.req('GET', '/health')).json.ok, true);
  assert.equal((await s.req('GET', '/nope.html')).status, 404);
  assert.equal((await s.req('GET', '/api/nope')).status, 404);
  assert.equal((await s.req('DELETE', '/index.html')).status, 405);
});

test('статика: нельзя выйти за пределы public', async (t) => {
  const s = await setup();
  t.after(s.close);
  for (const url of ['/..%2fserver.js', '/..%2F..%2Fetc%2Fpasswd', '/%2e%2e/server.js', '/%E0%A4%A']) {
    const r = await s.req('GET', url);
    assert.ok([400, 403, 404].includes(r.status), `${url} -> ${r.status}`);
    assert.doesNotMatch(r.text, /createServer|root:/);
  }
});

test('генерация: успех, валидация, лимит', async (t) => {
  const s = await setup();
  t.after(s.close);
  const ok = await s.req('POST', '/api/generate', { name: 'Кружка', features: '500 мл' });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.title);
  assert.equal(ok.json.left, 1);
  assert.equal((await s.req('POST', '/api/generate', { name: '' })).status, 400);
  assert.equal((await s.req('POST', '/api/generate', '{bad')).status, 400);
  assert.equal((await s.req('POST', '/api/generate', 'null')).status, 400);
  assert.equal((await s.req('POST', '/api/generate', { name: 'x'.repeat(30000) })).status, 413);
  assert.equal((await s.req('POST', '/api/generate', { name: 'Кружка' })).json.left, 0);
  const lim = await s.req('POST', '/api/generate', { name: 'Кружка' });
  assert.equal(lim.status, 402);
  assert.equal(lim.json.code, 'limit');
});

test('X-Forwarded-For игнорируется без TRUST_PROXY и учитывается с ним', async (t) => {
  const s = await setup();
  t.after(s.close);
  for (let i = 0; i < 2; i++) await s.req('POST', '/api/generate', { name: 'a' }, { 'x-forwarded-for': `1.1.1.${i}` });
  assert.equal((await s.req('POST', '/api/generate', { name: 'a' }, { 'x-forwarded-for': '9.9.9.9' })).status, 402, 'подмена заголовка не обходит лимит');

  const p = await setup({ trustProxy: true });
  t.after(p.close);
  for (let i = 0; i < 2; i++) await p.req('POST', '/api/generate', { name: 'a' }, { 'x-forwarded-for': '5.5.5.5' });
  assert.equal((await p.req('POST', '/api/generate', { name: 'a' }, { 'x-forwarded-for': '5.5.5.5' })).status, 402);
  assert.equal((await p.req('POST', '/api/generate', { name: 'a' }, { 'x-forwarded-for': '6.6.6.6, 10.0.0.1' })).status, 200);
});

test('ошибка генерации не тратит лимит; отказ модели даёт 422', async (t) => {
  let mode = 'fail';
  const orig = console.error;
  console.error = () => {};
  t.after(() => { console.error = orig; });
  const s = await setup({
    generate: async (p) => {
      if (mode === 'fail') throw new Error('API down');
      if (mode === 'refuse') throw new RefusalError('no');
      return generateDemo(p);
    },
  });
  t.after(s.close);
  for (let i = 0; i < 3; i++) assert.equal((await s.req('POST', '/api/generate', { name: 'a' })).status, 500);
  mode = 'refuse';
  assert.equal((await s.req('POST', '/api/generate', { name: 'a' })).status, 422);
  mode = 'ok';
  assert.equal((await s.req('POST', '/api/generate', { name: 'a' })).json.left, 1, 'неудачные попытки не списаны');
});

test('параллельные запросы не обходят лимит', async (t) => {
  const s = await setup({ generate: async (p) => { await new Promise((r) => setTimeout(r, 50)); return generateDemo(p); } });
  t.after(s.close);
  const res = await Promise.all(Array.from({ length: 6 }, () => s.req('POST', '/api/generate', { name: 'a' })));
  assert.equal(res.filter((r) => r.status === 200).length, 2);
  assert.equal(res.filter((r) => r.status === 402).length, 4);
});

test('оплата: заказ → ожидание → успех → PRO без лимита', async (t) => {
  const s = await setup();
  t.after(s.close);
  assert.equal((await s.req('POST', '/api/pay', { plan: 'vip' })).status, 400);
  assert.equal((await s.req('POST', '/api/pay', { plan: '__proto__' })).status, 400);
  const pay = await s.req('POST', '/api/pay', { plan: 'month' });
  assert.equal(pay.status, 200);
  assert.match(pay.json.url, /^https:\/\/yoomoney/);
  const { orderId } = pay.json;
  const pid = Object.keys(s.payments.db)[0];
  assert.equal(s.payments.db[pid].returnUrl, `https://site.test/?order=${orderId}`);

  assert.equal((await s.req('GET', '/api/pay/status?order=' + orderId)).json.status, 'pending');
  assert.equal((await s.req('GET', '/api/pay/status?order=nope')).status, 404);
  assert.equal((await s.req('GET', '/api/pay/status')).status, 404);

  s.payments.succeed(pid);
  const [a, b] = await Promise.all([
    s.req('GET', '/api/pay/status?order=' + orderId),
    s.req('GET', '/api/pay/status?order=' + orderId),
  ]);
  assert.equal(a.json.status, 'paid');
  assert.equal(a.json.code, b.json.code, 'параллельная проверка не выдаёт два кода');
  assert.equal(Object.keys(s.store._data().pro).length, 1);

  const code = a.json.code;
  assert.equal((await s.req('GET', '/api/pro?code=' + code)).json.valid, true);
  assert.equal((await s.req('GET', '/api/pro?code=PRO-FAKE')).json.valid, false);
  for (let i = 0; i < 5; i++) {
    const r = await s.req('POST', '/api/generate', { name: 'a', proCode: code });
    assert.equal(r.status, 200);
    assert.equal(r.json.left, null);
  }
});

test('оплата: неверная сумма или чужой заказ не дают PRO', async (t) => {
  const s = await setup();
  t.after(s.close);
  const { orderId } = (await s.req('POST', '/api/pay', { plan: 'year' })).json;
  const pid = Object.keys(s.payments.db)[0];
  s.payments.succeed(pid);
  s.payments.db[pid].amount.value = '1.00';
  assert.equal((await s.req('GET', '/api/pay/status?order=' + orderId)).json.status, 'pending');
  s.payments.db[pid].amount.value = '3990.00';
  s.payments.db[pid].metadata.orderId = 'other';
  assert.equal((await s.req('GET', '/api/pay/status?order=' + orderId)).json.status, 'pending');
  assert.equal(Object.keys(s.store._data().pro).length, 0);
});

test('вебхук: поддельный статус в теле не выдаёт PRO, реальная оплата выдаёт', async (t) => {
  const s = await setup();
  t.after(s.close);
  const { orderId } = (await s.req('POST', '/api/pay', { plan: 'month' })).json;
  const pid = Object.keys(s.payments.db)[0];
  const fake = { event: 'payment.succeeded', object: { id: pid, status: 'succeeded', paid: true } };
  assert.equal((await s.req('POST', '/api/yookassa/webhook', fake)).status, 200);
  assert.equal(s.store.getOrder(orderId).code, undefined, 'тело вебхука не принимается на веру');
  assert.equal((await s.req('POST', '/api/yookassa/webhook', { object: { id: 'unknown' } })).status, 200);
  s.payments.succeed(pid);
  await s.req('POST', '/api/yookassa/webhook', fake);
  assert.match(s.store.getOrder(orderId).code, /^PRO-/);
});

test('без настроенной оплаты эндпоинты отвечают 503', async (t) => {
  const s = await setup({ payments: null });
  t.after(s.close);
  assert.equal((await s.req('GET', '/api/config')).json.payments, false);
  assert.equal((await s.req('POST', '/api/pay', { plan: 'month' })).status, 503);
  assert.equal((await s.req('GET', '/api/pay/status?order=x')).status, 503);
});

test('клиент ЮKassa: авторизация, idempotence-key и формат запроса', async () => {
  const calls = [];
  const kassa = createYooKassa({
    shopId: '123', secretKey: 'sec',
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return { ok: true, json: async () => ({ id: 'p1', confirmation: { confirmation_url: 'https://pay' } }) };
    },
  });
  const r = await kassa.createPayment({ plan: 'month', orderId: 'o1', returnUrl: 'https://site/?order=o1' });
  assert.deepEqual(r, { paymentId: 'p1', url: 'https://pay' });
  const { url, opts } = calls[0];
  assert.equal(url, 'https://api.yookassa.ru/v3/payments');
  assert.equal(opts.headers.authorization, 'Basic ' + Buffer.from('123:sec').toString('base64'));
  assert.ok(opts.headers['idempotence-key']);
  const body = JSON.parse(opts.body);
  assert.deepEqual(body.amount, { value: '490.00', currency: 'RUB' });
  assert.equal(body.capture, true);
  assert.equal(body.metadata.orderId, 'o1');
  await kassa.getPayment('p/../x');
  assert.equal(calls[1].url, 'https://api.yookassa.ru/v3/payments/p%2F..%2Fx');
  assert.equal(calls[1].opts.headers['idempotence-key'], undefined);

  const failing = createYooKassa({ shopId: '1', secretKey: 's', fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'bad auth' }) });
  await assert.rejects(failing.getPayment('x'), /401/);
});
