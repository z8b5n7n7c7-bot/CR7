// КарточкаPRO — генератор SEO-карточек товаров для Wildberries и Ozon.
// Без зависимостей: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.MODEL || 'claude-sonnet-5-5';
const FREE_PER_DAY = Number(process.env.FREE_PER_DAY || 3);
const PRO_CODES = new Set((process.env.PRO_CODES || '').split(',').filter(Boolean));
const PAYMENT_URL = process.env.PAYMENT_URL || '#';

const LIMITS = { wb: { title: 60, desc: 5000 }, ozon: { title: 200, desc: 6000 } };
const usage = new Map(); // ip|date -> count

function todayKey(ip) {
  return ip + '|' + new Date().toISOString().slice(0, 10);
}

function buildPrompt(p) {
  const lim = LIMITS[p.marketplace] || LIMITS.wb;
  const mp = p.marketplace === 'ozon' ? 'Ozon' : 'Wildberries';
  return `Ты — топовый SEO-копирайтер маркетплейса ${mp}. Создай продающую карточку товара.

Товар: ${p.name}
Категория: ${p.category || 'не указана'}
Особенности и характеристики: ${p.features || 'не указаны'}
Целевая аудитория: ${p.audience || 'широкая'}
Тон: ${p.tone || 'дружелюбный и уверенный'}

Требования:
- title: до ${lim.title} символов, главный поисковый запрос в начале, без CAPS и восклицательных знаков.
- description: 1200–2000 символов, абзацы, выгоды для покупателя, естественно вписанные ключевые слова, без запрещённых площадкой слов («лучший», «№1», «скидка», контакты).
- keywords: 15–25 поисковых запросов, по которым реально ищут такой товар.
- bullets: 5–7 коротких преимуществ для блока «Особенности».
- slides: 5 текстов для слайдов инфографики (заголовок до 4 слов + подпись до 10 слов).

Ответь СТРОГО валидным JSON без markdown:
{"title":"...","description":"...","keywords":["..."],"bullets":["..."],"slides":[{"head":"...","sub":"..."}]}`;
}

async function generateAI(p) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 3000,
      messages: [{ role: 'user', content: buildPrompt(p) }],
    }),
  });
  if (!res.ok) throw new Error('AI API ' + res.status + ': ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  const text = data.content.map((c) => c.text || '').join('');
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return JSON.parse(json);
}

// Демо-режим без API-ключа: шаблонная генерация, чтобы можно было показать продукт.
function generateDemo(p) {
  const name = p.name.trim();
  const feats = (p.features || '').split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
  const cat = (p.category || '').trim();
  const lim = LIMITS[p.marketplace] || LIMITS.wb;
  const title = [name, cat && cat.toLowerCase(), feats[0]].filter(Boolean).join(' ').slice(0, lim.title);
  const bullets = (feats.length ? feats : ['Качественные материалы', 'Продуманный дизайн', 'Удобство в использовании'])
    .slice(0, 7).map((f) => f[0].toUpperCase() + f.slice(1));
  const description =
    `${name} — практичное решение для тех, кто ценит качество и комфорт каждый день.\n\n` +
    (feats.length ? `Ключевые особенности: ${feats.join(', ')}. ` : '') +
    `Товар создан с вниманием к деталям: он прослужит долго и сохранит отличный внешний вид.\n\n` +
    `Подойдёт ${p.audience ? 'для ' + p.audience : 'для себя и в подарок'}. ` +
    `${name} легко впишется в ваш образ жизни и избавит от лишних хлопот.\n\n` +
    `Оформите заказ сейчас — доставка в удобный пункт выдачи.\n\n` +
    `⚠️ Демо-режим: подключите ANTHROPIC_API_KEY, чтобы получать уникальные тексты от ИИ.`;
  const base = name.toLowerCase();
  const keywords = [base, cat && cat.toLowerCase(), `${base} купить`, `${base} недорого`, `${base} в подарок`,
    ...feats.slice(0, 5).map((f) => `${base} ${f.toLowerCase()}`)].filter(Boolean);
  const slides = bullets.slice(0, 5).map((b) => ({ head: b.split(' ').slice(0, 4).join(' '), sub: `${name}: ${b.toLowerCase()}` }));
  return { title, description, keywords, bullets, slides, demo: true };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 20000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { reject(e); } });
  });
}

function send(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/config') {
    return send(res, 200, { freePerDay: FREE_PER_DAY, paymentUrl: PAYMENT_URL, demo: !API_KEY });
  }
  if (req.method === 'POST' && req.url === '/api/generate') {
    let p;
    try { p = await readBody(req); } catch { return send(res, 400, { error: 'Некорректный запрос' }); }
    if (!p.name || !p.name.trim()) return send(res, 400, { error: 'Укажите название товара' });

    const isPro = p.proCode && PRO_CODES.has(p.proCode);
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
    const key = todayKey(ip);
    const used = usage.get(key) || 0;
    if (!isPro && used >= FREE_PER_DAY) {
      return send(res, 402, { error: 'limit', message: `Бесплатный лимит (${FREE_PER_DAY} в день) исчерпан` });
    }
    try {
      const result = API_KEY ? await generateAI(p) : generateDemo(p);
      if (!isPro) usage.set(key, used + 1);
      return send(res, 200, { ...result, left: isPro ? null : FREE_PER_DAY - used - 1 });
    } catch (e) {
      console.error(e);
      return send(res, 500, { error: 'Ошибка генерации, попробуйте ещё раз' });
    }
  }
  // статика
  const file = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : path.normalize(req.url).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
    res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`КарточкаPRO: http://localhost:${PORT} ${API_KEY ? '(ИИ-режим)' : '(демо-режим, нет ANTHROPIC_API_KEY)'}`);
});
