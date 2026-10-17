const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../lib/store');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-')), 'store.json');

test('лимит: резерв, исчерпание, откат', () => {
  const s = createStore(null);
  const a = s.reserve('ip:1', 2);
  assert.equal(a.left, 1);
  assert.equal(s.reserve('ip:1', 2).left, 0);
  assert.equal(s.reserve('ip:1', 2), null);
  assert.ok(s.reserve('ip:2', 2), 'у другого пользователя свой лимит');
  a.refund();
  assert.ok(s.reserve('ip:1', 2), 'после отката слот снова доступен');
});

test('лимит сбрасывается на следующий день, старые записи удаляются', () => {
  let t = Date.parse('2026-10-17T10:00:00Z');
  const s = createStore(null, { now: () => t });
  s.reserve('ip:1', 1);
  assert.equal(s.reserve('ip:1', 1), null);
  t += 24 * 3600 * 1000;
  assert.ok(s.reserve('ip:1', 1));
  assert.equal(Object.keys(s._data().usage).length, 1);
});

test('PRO-коды: срок действия, регистр, служебные ключи', () => {
  let t = 1_000_000;
  const s = createStore(null, { now: () => t });
  const code = s.issueCode({ days: 30, plan: 'month', orderId: 'o' });
  assert.match(code, /^PRO-[0-9A-F]{10}$/);
  assert.ok(s.checkCode(code));
  assert.ok(s.checkCode(' ' + code.toLowerCase() + ' '));
  for (const bad of [undefined, null, 42, '', '__proto__', 'constructor', 'toString']) assert.equal(s.checkCode(bad), null);
  t += 31 * 24 * 3600 * 1000;
  assert.equal(s.checkCode(code), null, 'истёкший код недействителен');
  assert.equal(s.getOrder('__proto__'), null);
});

test('данные сохраняются на диск и читаются после перезапуска', () => {
  const file = tmpFile();
  const s1 = createStore(file);
  const code = s1.issueCode({ days: 30, plan: 'month', orderId: 'o' });
  const order = s1.createOrder({ plan: 'month' });
  s1.reserve('ip:1', 3);
  s1.flush();
  const s2 = createStore(file);
  assert.ok(s2.checkCode(code));
  assert.equal(s2.getOrder(order).plan, 'month');
  assert.equal(s2.reserve('ip:1', 3).left, 1);
});

test('повреждённый файл не роняет сервер и сохраняется копией', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{битый');
  const orig = console.error;
  console.error = () => {};
  try {
    const s = createStore(file);
    assert.ok(s.reserve('ip:1', 1));
  } finally { console.error = orig; }
  assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.includes('.corrupt-')));
});

test('брошенные заказы удаляются, оплаченные остаются', () => {
  let t = 1_000_000;
  const s = createStore(null, { now: () => t });
  const abandoned = s.createOrder({ plan: 'month' });
  const paid = s.createOrder({ plan: 'month' });
  s.updateOrder(paid, { code: 'PRO-X', status: 'paid' });
  t += 3 * 24 * 3600 * 1000;
  s.createOrder({ plan: 'month' });
  assert.equal(s.getOrder(abandoned), null);
  assert.equal(s.getOrder(paid).code, 'PRO-X');
});
