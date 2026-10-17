// Приём оплаты через ЮKassa (https://yookassa.ru/developers/api).
// Статус платежа всегда перепроверяем запросом к API ЮKassa и не доверяем телу вебхука:
// иначе любой мог бы прислать поддельный «payment.succeeded».
const crypto = require('crypto');

const PLANS = {
  month: { title: 'КарточкаPRO на 30 дней', amount: '490.00', days: 30 },
  year: { title: 'КарточкаPRO на 365 дней', amount: '3990.00', days: 365 },
};

function createYooKassa({ shopId, secretKey, fetchImpl = fetch }) {
  const auth = 'Basic ' + Buffer.from(`${shopId}:${secretKey}`).toString('base64');
  async function call(method, url, body) {
    const res = await fetchImpl('https://api.yookassa.ru/v3' + url, {
      method,
      headers: {
        authorization: auth,
        'content-type': 'application/json',
        ...(method === 'POST' ? { 'idempotence-key': crypto.randomUUID() } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`ЮKassa ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
  return {
    async createPayment({ plan, orderId, returnUrl }) {
      const p = PLANS[plan];
      const pay = await call('POST', '/payments', {
        amount: { value: p.amount, currency: 'RUB' },
        capture: true,
        confirmation: { type: 'redirect', return_url: returnUrl },
        description: p.title,
        metadata: { orderId, plan },
      });
      return { paymentId: pay.id, url: pay.confirmation.confirmation_url };
    },
    getPayment: (id) => call('GET', '/payments/' + encodeURIComponent(id)),
  };
}

// Выдаёт PRO-код по заказу, если платёж реально прошёл. Повторный вызов вернёт тот же код.
async function settleOrder({ store, payments, orderId }) {
  const order = store.getOrder(orderId);
  if (!order) return { status: 'not_found' };
  if (order.code) return { status: 'paid', code: order.code };
  if (!order.paymentId) return { status: order.status };

  const pay = await payments.getPayment(order.paymentId);
  // Код могли выдать параллельно, пока ждали ответ ЮKassa.
  if (order.code) return { status: 'paid', code: order.code };
  const plan = PLANS[order.plan];
  const ok = pay.status === 'succeeded' && pay.paid === true &&
    pay.amount?.value === plan.amount && pay.amount?.currency === 'RUB' &&
    pay.metadata?.orderId === orderId;
  if (ok) {
    const code = store.issueCode({ days: plan.days, plan: order.plan, orderId });
    store.updateOrder(orderId, { status: 'paid', code });
    return { status: 'paid', code };
  }
  if (pay.status === 'canceled') store.updateOrder(orderId, { status: 'canceled' });
  return { status: pay.status === 'canceled' ? 'canceled' : 'pending' };
}

module.exports = { PLANS, createYooKassa, settleOrder };
