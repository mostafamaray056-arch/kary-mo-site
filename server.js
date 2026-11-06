import { createServer } from 'node:http';
import { readFile, readFileSync, stat } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const siteRoot = resolve(projectRoot, 'site');
const maxBodyBytes = 12000;
const maxMessageLength = 3500;
const rateLimitWindowMs = 15 * 60 * 1000;
const rateLimitMaxRequests = 8;
const requestsByAddress = new Map();
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon']
]);

function loadLocalEnv() {
  let contents;
  try {
    contents = readFileSync(join(projectRoot, '.env'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }

  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    const value = match[2].replace(/^(['"])(.*)\1$/, '$2');
    process.env[match[1]] = value;
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(payload));
}

function checkRateLimit(address) {
  const now = Date.now();
  for (const [key, entry] of requestsByAddress) {
    if (entry.expiresAt <= now) requestsByAddress.delete(key);
  }

  const entry = requestsByAddress.get(address);
  if (!entry || entry.expiresAt <= now) {
    requestsByAddress.set(address, { count: 1, expiresAt: now + rateLimitWindowMs });
    return true;
  }
  if (entry.count >= rateLimitMaxRequests) return false;
  entry.count += 1;
  return true;
}

async function readRequestBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

async function handleTelegramOrder(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    sendJson(response, 405, { error: 'Method not allowed.' });
    return;
  }

  const origin = request.headers.origin;
  if (origin && new URL(origin).host !== request.headers.host) {
    sendJson(response, 403, { error: 'Request origin is not allowed.' });
    return;
  }
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    sendJson(response, 415, { error: 'Content-Type must be application/json.' });
    return;
  }
  if (!checkRateLimit(request.socket.remoteAddress || 'unknown')) {
    sendJson(response, 429, { error: 'طلبات كثيرة. حاول مرة أخرى بعد قليل.' });
    return;
  }

  let body;
  try {
    body = await readRequestBody(request);
  } catch (error) {
    sendJson(response, error.statusCode || 400, { error: error.message });
    return;
  }

  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message || message.length > maxMessageLength) {
    sendJson(response, 400, { error: 'بيانات الإعلان فارغة أو أطول من المسموح.' });
    return;
  }

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('Telegram delivery is not configured. Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.');
    sendJson(response, 503, { error: 'استقبال الطلبات غير جاهز حاليًا. حاول لاحقًا أو تواصل معنا.' });
    return;
  }

  let telegramResponse;
  try {
    telegramResponse = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
      signal: AbortSignal.timeout(10000)
    });
  } catch (error) {
    console.error('Telegram request failed:', error.name);
    sendJson(response, 502, { error: 'تعذر الوصول إلى تيليجرام. حاول مرة أخرى.' });
    return;
  }

  let telegramResult;
  try {
    telegramResult = await telegramResponse.json();
  } catch {
    console.error('Telegram returned a non-JSON response:', telegramResponse.status);
    sendJson(response, 502, { error: 'تيليجرام أرجع استجابة غير متوقعة.' });
    return;
  }

  if (!telegramResponse.ok || !telegramResult.ok) {
    console.error('Telegram rejected a message:', telegramResponse.status, telegramResult.error_code || 'unknown');
    sendJson(response, 502, { error: 'لم يتم إرسال الطلب. راجع إعدادات البوت وحاول مرة أخرى.' });
    return;
  }

  sendJson(response, 200, { ok: true });
}

function serveStaticFile(request, response, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { error: 'Invalid URL path.' });
    return;
  }

  const requestedPath = decodedPath === '/' ? '/index.html' : decodedPath;
  const filePath = resolve(siteRoot, `.${requestedPath}`);
  const relativePath = relative(siteRoot, filePath);
  if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || relativePath.startsWith(sep)) {
    response.writeHead(403);
    response.end();
    return;
  }

  stat(filePath, (statError, fileStats) => {
    if (statError || !fileStats.isFile()) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    response.writeHead(200, {
      'Content-Type': contentTypes.get(extname(filePath).toLowerCase()) || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': extname(filePath).toLowerCase() === '.html' ? 'no-cache' : 'public, max-age=3600'
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    readFile(filePath, (readError, contents) => {
      if (readError) {
        console.error('Failed to read a site file:', readError.code || 'unknown');
        if (!response.headersSent) response.writeHead(500);
        response.end('Unable to load file');
        return;
      }
      response.end(contents);
    });
  });
}

loadLocalEnv();

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('PORT must be an integer from 1 to 65535.');
  process.exit(1);
}

const server = createServer((request, response) => {
  let url;
  try {
    url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  } catch {
    sendJson(response, 400, { error: 'Invalid request URL.' });
    return;
  }

  if (url.pathname === '/api/telegram/order') {
    handleTelegramOrder(request, response).catch((error) => {
      console.error('Unexpected Telegram endpoint error:', error.name);
      if (!response.headersSent) sendJson(response, 500, { error: 'حدث خطأ أثناء إرسال الطلب.' });
      else response.destroy();
    });
    return;
  }

  if (!['GET', 'HEAD'].includes(request.method)) {
    response.setHeader('Allow', 'GET, HEAD');
    response.writeHead(405);
    response.end();
    return;
  }
  serveStaticFile(request, response, url.pathname);
});

server.listen(port, '0.0.0.0', () => {
  console.log(`KARY..MO site is running on http://localhost:${port}`);
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
    console.warn('Telegram delivery is disabled until TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are configured.');
  }
});
