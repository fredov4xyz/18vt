const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');

const loadDotEnv = () => {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['\"]|['\"]$/g, '');
  }
};
loadDotEnv();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const API_KEY = process.env.OPENROUTER_API_KEY;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const MODEL_FALLBACK = 'meta-llama/llama-3.3-70b-instruct:free';
const DATA_DIR = path.resolve(__dirname, process.env.DATA_DIR || 'data');
const DB_FILE = path.join(DATA_DIR, '18vt.sqlite');
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    reply TEXT NOT NULL,
    file_name TEXT NOT NULL DEFAULT '',
    model_name TEXT NOT NULL DEFAULT '18vt AI',
    image_url TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS watchlist (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    media_type TEXT NOT NULL,
    external_id TEXT NOT NULL,
    title TEXT NOT NULL,
    poster_url TEXT NOT NULL DEFAULT '',
    year TEXT NOT NULL DEFAULT '',
    progress INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'planned',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(user_id, media_type, external_id)
  );
`);

if (!API_KEY) console.warn('OPENROUTER_API_KEY is not set. Chat and image scanning need a server key.');
if (!TMDB_API_KEY) console.warn('TMDB_API_KEY is not set. Watcher search will use the free Jikan anime API and a curated fallback for films.');

const send = (response, status, payload, headers = {}) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(payload));
};
const readBody = (request, maxBytes = 12_000_000) => new Promise((resolve, reject) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; if (body.length > maxBytes) { reject(new Error('Request body is too large')); request.destroy(); } });
  request.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Request body must be valid JSON')); } });
  request.on('error', reject);
});
const parseCookies = (request) => Object.fromEntries((request.headers.cookie || '').split(';').filter(Boolean).map((part) => { const [key, ...value] = part.trim().split('='); return [key, decodeURIComponent(value.join('='))]; }));
const sessionCookie = (token, maxAge = SESSION_TTL_MS / 1000) => `18vt_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
const hashPassword = (password, salt = crypto.randomBytes(16).toString('hex')) => `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
const verifyPassword = (password, stored) => { try { const [salt, expected] = stored.split(':'); const actual = crypto.scryptSync(password, salt, 64).toString('hex'); return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex')); } catch { return false; } };
const tokenHash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const publicUser = (user) => ({ id: user.id, name: user.name, email: user.email, createdAt: user.created_at });
const getUser = (request) => {
  const token = parseCookies(request)['18vt_session'];
  if (!token) return null;
  const session = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(tokenHash(token));
  if (!session || session.expires_at < Date.now()) { if (session) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token)); return null; }
  return db.prepare('SELECT id, name, email, created_at, password_hash FROM users WHERE id = ?').get(session.user_id) || null;
};
const requireUser = (request, response) => { const user = getUser(request); if (!user) { send(response, 401, { error: 'Sign in to use this feature.' }); return null; } return user; };
const createSession = (userId) => { const token = crypto.randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(tokenHash(token), userId, Date.now() + SESSION_TTL_MS, Date.now()); return token; };
const removeSession = (request) => { const token = parseCookies(request)['18vt_session']; if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token)); };
const validEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const mapConversation = (row) => ({ id: row.id, prompt: row.prompt, reply: row.reply, fileName: row.file_name, modelName: row.model_name, imageUrl: row.image_url, createdAt: row.created_at });
const mapWatch = (row) => ({ id: row.id, mediaType: row.media_type, externalId: row.external_id, title: row.title, posterUrl: row.poster_url, year: row.year, progress: row.progress, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at });

const openRouter = async (body) => {
  if (!API_KEY) throw new Error('OPENROUTER_API_KEY is not configured on the server.');
  const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json', 'HTTP-Referer': `http://localhost:${PORT}`, 'X-Title': '18vt AI workspace' }, body: JSON.stringify({ model: body.model || MODEL_FALLBACK, messages: [ ...(body.system ? [{ role: 'system', content: body.system }] : []), ...(Array.isArray(body.messages) ? body.messages : []) ], temperature: 0.7 }) });
  const data = await upstream.json();
  if (!upstream.ok) throw new Error(data?.error?.message || `OpenRouter request failed (${upstream.status})`);
  return data?.choices?.[0]?.message?.content || '';
};
const normalizeJikan = (item) => ({ externalId: String(item.mal_id), mediaType: 'anime', title: item.title, posterUrl: item.images?.jpg?.large_image_url || item.images?.jpg?.image_url || '', year: String(item.year || item.aired?.from?.slice(0, 4) || ''), overview: item.synopsis || '', score: item.score || null });
const normalizeTmdb = (item, mediaType) => ({ externalId: String(item.id), mediaType, title: item.title || item.name, posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : '', year: String((item.release_date || item.first_air_date || '').slice(0, 4)), overview: item.overview || '', score: item.vote_average || null });
const searchMedia = async (query, type) => {
  if (type === 'anime') {
    const endpoint = query === 'popular' ? 'top/anime?limit=12&sfw=true' : `anime?q=${encodeURIComponent(query)}&limit=12&sfw=true`;
    const response = await fetch(`https://api.jikan.moe/v4/${endpoint}`);
    if (!response.ok) throw new Error('Anime search is temporarily unavailable.');
    const data = await response.json(); return data.data.map(normalizeJikan);
  }
  if (TMDB_API_KEY) {
    const endpoint = query === 'popular' ? `trending/${type === 'tv' ? 'tv' : 'movie'}/week?api_key=${encodeURIComponent(TMDB_API_KEY)}` : `search/${type === 'tv' ? 'tv' : 'movie'}?api_key=${encodeURIComponent(TMDB_API_KEY)}&query=${encodeURIComponent(query)}&include_adult=false&page=1`;
    const response = await fetch(`https://api.themoviedb.org/3/${endpoint}`);
    if (!response.ok) throw new Error('Film search is temporarily unavailable.');
    const data = await response.json(); return data.results.map((item) => normalizeTmdb(item, type === 'tv' ? 'tv' : 'movie'));
  }
  return [{ externalId: 'demo-1', mediaType: type === 'tv' ? 'tv' : 'movie', title: `Search ready for “${query}”`, posterUrl: '', year: '', overview: 'Add TMDB_API_KEY in .env for live movie and TV results. Anime search works without a key through Jikan.' }];
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || `localhost:${PORT}`}`);
  const route = url.pathname;
  try {
    if (request.method === 'POST' && route === '/api/auth/signup') {
      const body = await readBody(request, 100_000); const name = String(body.name || '').trim(); const email = String(body.email || '').trim().toLowerCase(); const password = String(body.password || '');
      if (name.length < 2) return send(response, 400, { error: 'Enter a name with at least 2 characters.' });
      if (!validEmail(email)) return send(response, 400, { error: 'Enter a valid email address.' });
      if (password.length < 8) return send(response, 400, { error: 'Password must be at least 8 characters.' });
      if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) return send(response, 409, { error: 'An account with that email already exists.' });
      const user = { id: crypto.randomUUID(), name, email, passwordHash: hashPassword(password), createdAt: Date.now() }; db.prepare('INSERT INTO users (id,name,email,password_hash,created_at) VALUES (?,?,?,?,?)').run(user.id, user.name, user.email, user.passwordHash, user.createdAt);
      return send(response, 201, { user: { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt } }, { 'Set-Cookie': sessionCookie(createSession(user.id)) });
    }
    if (request.method === 'POST' && route === '/api/auth/signin') {
      const body = await readBody(request, 100_000); const email = String(body.email || '').trim().toLowerCase(); const user = db.prepare('SELECT id,name,email,password_hash,created_at FROM users WHERE email = ?').get(email);
      if (!user || !verifyPassword(String(body.password || ''), user.password_hash)) return send(response, 401, { error: 'Email or password is incorrect.' });
      return send(response, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(createSession(user.id)) });
    }
    if (request.method === 'POST' && route === '/api/auth/signout') { removeSession(request); return send(response, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) }); }
    if (request.method === 'GET' && route === '/api/auth/me') { const user = getUser(request); return send(response, 200, { user: user ? publicUser(user) : null }); }

    if (request.method === 'GET' && route === '/api/conversations') { const user = requireUser(request, response); if (!user) return; return send(response, 200, { conversations: db.prepare('SELECT * FROM conversations WHERE user_id = ? ORDER BY created_at DESC').all(user.id).map(mapConversation) }); }
    if (request.method === 'POST' && route === '/api/conversations') { const user = requireUser(request, response); if (!user) return; const body = await readBody(request, 500_000); const prompt = String(body.prompt || '').trim(); const reply = String(body.reply || '').trim(); if (!prompt || !reply) return send(response, 400, { error: 'A prompt and reply are required.' }); const item = { id: crypto.randomUUID(), userId: user.id, prompt, reply, fileName: String(body.fileName || '').slice(0, 200), modelName: String(body.modelName || '18vt AI').slice(0, 100), imageUrl: String(body.imageUrl || '').slice(0, 2000), createdAt: Date.now() }; db.prepare('INSERT INTO conversations (id,user_id,prompt,reply,file_name,model_name,image_url,created_at) VALUES (?,?,?,?,?,?,?,?)').run(item.id,item.userId,item.prompt,item.reply,item.fileName,item.modelName,item.imageUrl,item.createdAt); return send(response, 201, { conversation: item }); }
    if (request.method === 'DELETE' && route === '/api/conversations') { const user = requireUser(request, response); if (!user) return; db.prepare('DELETE FROM conversations WHERE user_id = ?').run(user.id); return send(response, 200, { ok: true }); }

    if (request.method === 'GET' && route === '/api/media/search') { const user = requireUser(request, response); if (!user) return; const query = String(url.searchParams.get('q') || 'trending').trim(); const type = ['movie', 'tv', 'anime'].includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'movie'; return send(response, 200, { results: await searchMedia(query, type), source: type === 'anime' ? 'Jikan' : TMDB_API_KEY ? 'TMDB' : 'Demo' }); }
    if (request.method === 'GET' && route === '/api/watchlist') { const user = requireUser(request, response); if (!user) return; return send(response, 200, { items: db.prepare('SELECT * FROM watchlist WHERE user_id = ? ORDER BY updated_at DESC').all(user.id).map(mapWatch) }); }
    if (request.method === 'POST' && route === '/api/watchlist') { const user = requireUser(request, response); if (!user) return; const body = await readBody(request, 100_000); const mediaType = String(body.mediaType || 'movie'); const externalId = String(body.externalId || ''); const title = String(body.title || '').trim(); if (!externalId || !title || !['movie','tv','anime'].includes(mediaType)) return send(response, 400, { error: 'Media details are incomplete.' }); const now = Date.now(); const existing = db.prepare('SELECT id FROM watchlist WHERE user_id = ? AND media_type = ? AND external_id = ?').get(user.id, mediaType, externalId); if (existing) { db.prepare('DELETE FROM watchlist WHERE id = ?').run(existing.id); return send(response, 200, { removed: true }); } const item = { id: crypto.randomUUID(), userId: user.id, mediaType, externalId, title, posterUrl: String(body.posterUrl || '').slice(0, 500), year: String(body.year || '').slice(0, 20), progress: 0, status: 'planned', createdAt: now, updatedAt: now }; db.prepare('INSERT INTO watchlist (id,user_id,media_type,external_id,title,poster_url,year,progress,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(item.id,item.userId,item.mediaType,item.externalId,item.title,item.posterUrl,item.year,item.progress,item.status,item.createdAt,item.updatedAt); return send(response, 201, { item }); }
    if (request.method === 'PATCH' && route.startsWith('/api/watchlist/')) { const user = requireUser(request, response); if (!user) return; const id = route.split('/').pop(); const body = await readBody(request, 100_000); const progress = Math.max(0, Math.min(100, Number(body.progress))); const status = progress >= 100 ? 'watched' : progress > 0 ? 'watching' : 'planned'; db.prepare('UPDATE watchlist SET progress = ?, status = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(progress, status, Date.now(), id, user.id); const item = db.prepare('SELECT * FROM watchlist WHERE id = ? AND user_id = ?').get(id, user.id); return item ? send(response, 200, { item: mapWatch(item) }) : send(response, 404, { error: 'Watchlist item not found.' }); }
    if (request.method === 'DELETE' && route.startsWith('/api/watchlist/')) { const user = requireUser(request, response); if (!user) return; db.prepare('DELETE FROM watchlist WHERE id = ? AND user_id = ?').run(route.split('/').pop(), user.id); return send(response, 200, { ok: true }); }

    if (request.method === 'POST' && route === '/api/generate-image') { const user = requireUser(request, response); if (!user) return; const body = await readBody(request, 100_000); const prompt = String(body.prompt || '').trim(); if (!prompt) return send(response, 400, { error: 'An image prompt is required.' }); return send(response, 200, { imageUrl: `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&safe=true` }); }
    if (request.method === 'POST' && route === '/api/chat') { const user = requireUser(request, response); if (!user) return; const body = await readBody(request, 12_000_000); return send(response, 200, { reply: await openRouter(body) }); }

    if (request.method === 'GET') { const requested = route === '/' ? '/indev.html' : route; const filePath = path.resolve(__dirname, `.${requested}`); if (filePath === path.join(__dirname, 'indev.html') && fs.existsSync(filePath)) { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return fs.createReadStream(filePath).pipe(response); } }
    return send(response, 404, { error: 'Not found' });
  } catch (error) { console.error(error); return send(response, 500, { error: error.message || 'Server error.' }); }
});

server.listen(PORT, HOST, () => console.log(`18vt running at http://${HOST}:${PORT}`));
