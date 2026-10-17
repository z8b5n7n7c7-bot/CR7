const test = require('node:test');
const assert = require('node:assert/strict');
const { createBot, chunk, formatCard } = require('../lib/bot');
const { createStore } = require('../lib/store');
const { generateDemo, RefusalError } = require('../lib/generate');

function setup(generate = async (p) => generateDemo(p)) {
  const sent = [];
  const store = createStore(null);
  const fetchImpl = async (url, opts) => {
    const method = url.split('/').pop();
    const body = JSON.parse(opts.body);
    if (method === 'sendMessage') sent.push(body);
    return { json: async () => ({ ok: true, result: method === 'getUpdates' ? [] : {} }) };
  };
  const log = { error: () => {} };
  const bot = createBot({ token: 'T', store, generate, config: { freePerDay: 1, baseUrl: 'https://site.test' }, fetchImpl, log });
  const say = (text, chatId = 7) => bot.handle({ chat: { id: chatId }, text });
  return { bot, store, sent, say };
}

test('команды /start, /ozon, /buy, неизвестная', async () => {
  const s = setup();
  await s.say('/start');
  assert.match(s.sent.at(-1).text, /Wildberries и Ozon/);
  assert.equal(s.sent.at(-1).parse_mode, 'HTML');
  await s.say('/ozon@KartochkaBot');
  assert.match(s.sent.at(-1).text, /Ozon/);
  await s.say('/buy');
  assert.match(s.sent.at(-1).text, /https:\/\/site\.test\/#price/);
  await s.say('/foo');
  assert.match(s.sent.at(-1).text, /Не знаю/);
  await s.bot.handle({ chat: { id: 1 } }); // стикер или фото без текста
  await s.bot.handle(undefined);
});

test('генерация, лимит и активация PRO', async () => {
  let mp;
  const s = setup(async (p) => { mp = p.marketplace; return generateDemo(p); });
  await s.say('/ozon');
  await s.say('Термокружка\n500 мл, сталь');
  assert.equal(mp, 'ozon');
  assert.ok(s.sent.some((m) => m.text.includes('Термокружка')));
  await s.say('Ещё товар');
  assert.match(s.sent.at(-1).text, /лимит/);

  await s.say('/pro PRO-NOPE');
  assert.match(s.sent.at(-1).text, /не найден/);
  const code = s.store.issueCode({ days: 30, plan: 'month', orderId: 'o' });
  await s.say('/pro ' + code.toLowerCase());
  assert.match(s.sent.at(-1).text, /PRO активирован/);
  const before = s.sent.length;
  await s.say('Ещё товар');
  assert.ok(s.sent.slice(before).some((m) => m.text.includes('Ещё товар')));
  assert.ok(!s.sent.slice(before).some((m) => /лимит|Осталось/.test(m.text)));
});

test('ошибка генерации возвращает лимит пользователю', async () => {
  let fail = true;
  const s = setup(async (p) => { if (fail) throw new RefusalError('x'); return generateDemo(p); });
  await s.say('Кружка');
  assert.match(s.sent.at(-1).text, /Не получилось/);
  fail = false;
  await s.say('Кружка');
  assert.match(s.sent.at(-1).text, /Осталось бесплатно сегодня: 0/);
});

test('пока карточка готовится, второй запрос из того же чата отклоняется', async () => {
  let release;
  const s = setup(() => new Promise((r) => { release = r; }));
  s.store.issueCode({ days: 1, plan: 'month', orderId: 'o' });
  const first = s.say('Кружка');
  await new Promise((r) => setImmediate(r));
  await s.say('Кружка 2');
  assert.match(s.sent.at(-1).text, /Подождите/);
  release(generateDemo({ name: 'Кружка', features: '', category: '', audience: '', marketplace: 'wb', tone: '' }));
  await first;
});

test('HTML экранируется, длинные карточки делятся на части ≤ 4096', () => {
  const card = generateDemo({ name: '<script>&', features: '', category: '', audience: '', marketplace: 'wb', tone: '' });
  const blocks = formatCard(card);
  assert.ok(blocks.join('').includes('&lt;script&gt;&amp;'));
  assert.ok(!blocks.join('').includes('<script>'));

  const long = formatCard({ ...card, description: ('Абзац & <тег> '.repeat(40) + '\n').repeat(30) });
  const parts = chunk(long);
  assert.ok(parts.length > 1);
  for (const p of parts) {
    assert.ok(p.length <= 4096, `часть длиной ${p.length}`);
    assert.doesNotMatch(p, /&(a|am|amp|l|lt|g|gt)?$/, 'сущность не разрезана в конце');
    assert.doesNotMatch(p, /^(mp|p|t|;)/, 'сущность не разрезана в начале');
  }
  assert.equal(parts.join('').replace(/\s/g, '').length, long.join('').replace(/\s/g, '').length, 'текст не потерян');

  const noNewlines = chunk(['&amp;'.repeat(2000)]);
  for (const p of noNewlines) assert.match(p, /^(&amp;)+$/);
});
