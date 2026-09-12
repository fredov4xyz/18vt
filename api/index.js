const crypto = require('crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

const DEFAULT_MODEL = 'meta-llama/llama-3.3-70b-instruct:free';
const VISION_MODEL = 'google/gemini-2.0-flash-exp:free';
const FALLBACK_CHAIN = [DEFAULT_MODEL, 'google/gemini-2.0-flash-exp:free', 'deepseek/deepseek-chat-v3-0324:free'];
const MAX_BODY_BYTES = 12_000_000;
const UPSTREAM_TIMEOUT_MS = 55_000; // stay under Vercel's function timeout

// Lightweight in-memory rate limiter (per lambda instance; Vercel may spawn
// several, but this still blunts bursts and costs nothing).
const RATE_LIMITS = { chat: 20, media: 40, auth: 15, default: 60 };
const rateBuckets = new Map();
function rateLimit(scope, key, limit) {
    const now = Date.now();
    const windowMs = 60_000;
    const bucketKey = `${scope}:${key}`;
    const bucket = rateBuckets.get(bucketKey) || { count: 0, reset: now + windowMs };
    if (now > bucket.reset) { bucket.count = 0; bucket.reset = now + windowMs; }
    bucket.count += 1;
    rateBuckets.set(bucketKey, bucket);
    if (rateBuckets.size > 5_000) rateBuckets.clear(); // avoid unbounded memory
    return { ok: bucket.count <= limit, retryAfter: Math.ceil((bucket.reset - now) / 1000) };
}

function clientKey(req) {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || 'anon';
    return ip;
}

// Tiny TTL cache for upstream GETs (TMDB/Jikan) to cut latency + rate-limit hits.
const cache = new Map();
async function cachedJson(url, options = {}, ttlMs = 5 * 60_000) {
    const hit = cache.get(url);
    if (hit && Date.now() < hit.expires) return hit.data;
    const response = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS), ...options });
    const data = await response.json().catch(() => ({}));
    if (response.ok) {
        cache.set(url, { data, expires: Date.now() + ttlMs });
        if (cache.size > 500) cache.clear();
    }
    return data;
}

console.log('[18vt startup] Environment check:');
console.log('  SUPABASE_URL:', SUPABASE_URL ? '✓ configured' : '✗ MISSING');
console.log('  SUPABASE_ANON_KEY:', SUPABASE_ANON_KEY ? '✓ configured' : '✗ MISSING');
console.log('  OPENROUTER_API_KEY:', OPENROUTER_API_KEY ? '✓ configured' : '✗ MISSING');
console.log('  TMDB_API_KEY:', TMDB_API_KEY ? '✓ configured' : '✗ MISSING');

const json = (res, status, body, headers = {}) => {
    res.statusCode = status;
    Object.entries({ 'content-type': 'application/json; charset=utf-8', ...headers }).forEach(([key, value]) => res.setHeader(key, value));
    res.end(JSON.stringify(body));
};

const body = (req) => new Promise((resolve, reject) => {
    let value = '';
    req.on('data', (chunk) => { value += chunk; if (value.length > MAX_BODY_BYTES) { reject(new Error('Request body is too large')); req.destroy(); } });
    req.on('end', () => { try { resolve(JSON.parse(value || '{}')); } catch { reject(new Error('Request body must be valid JSON')); } });
    req.on('error', reject);
});

const cookies = (req) => Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map((item) => { const [key, ...rest] = item.trim().split('='); return [key, decodeURIComponent(rest.join('='))]; }));

const setAuthCookies = (session) => [
    `18vt_access=${encodeURIComponent(session.access_token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
    `18vt_refresh=${encodeURIComponent(session.refresh_token || '')}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE * 2}`
];

const clearAuthCookies = () => [
    '18vt_access=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    '18vt_refresh=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'
];

const publicUser = (user) => user && ({ id: user.id, email: user.email, name: user.user_metadata?.name || user.user_metadata?.full_name || user.email?.split('@')[0] || 'Friend', createdAt: user.created_at });

const supabase = async (endpoint, options = {}, accessToken = '') => {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        throw new Error('Supabase is not configured. Add SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY to Vercel Environment Variables.');
    }
    const response = await fetch(`${SUPABASE_URL}${endpoint}`, {
        ...options,
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${accessToken || SUPABASE_ANON_KEY}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data.msg || data.error_description || data.message || data.error || `Supabase request failed (${response.status})`);
    }
    return data;
};

const accessUser = async (req, res) => {
    const jar = cookies(req);
    if (!jar['18vt_access']) return null;
    try {
        return { user: await supabase('/auth/v1/user', { method: 'GET' }, jar['18vt_access']), accessToken: jar['18vt_access'] };
    } catch {
        if (!jar['18vt_refresh']) return null;
        try {
            const session = await supabase('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: jar['18vt_refresh'] }) });
            res.setHeader('Set-Cookie', setAuthCookies(session));
            return { user: await supabase('/auth/v1/user', { method: 'GET' }, session.access_token), accessToken: session.access_token };
        } catch { return null; }
    }
};

const requireUser = async (req, res) => {
    const auth = await accessUser(req, res);
    if (!auth) { json(res, 401, { error: 'Sign in to use this feature.' }); return null; }
    return auth;
};

const rest = async (table, query, options, token) => supabase(`/rest/v1/${table}${query}`, options, token);

const mapConversation = (item) => ({ id: item.id, prompt: item.prompt, reply: item.reply, fileName: item.file_name || '', modelName: item.model_name || '18vt AI', imageUrl: item.image_url || '', createdAt: item.created_at });
const mapWatch = (item) => ({ id: item.id, mediaType: item.media_type, externalId: item.external_id, title: item.title, posterUrl: item.poster_url || '', year: item.year || '', progress: item.progress || 0, status: item.status || 'planned', createdAt: item.created_at, updatedAt: item.updated_at });
const normalizeJikan = (item) => ({ externalId: String(item.mal_id), mediaType: 'anime', title: item.title, posterUrl: item.images?.jpg?.large_image_url || item.images?.jpg?.image_url || '', year: String(item.aired?.prop?.from?.year || ''), score: item.score || '', overview: item.synopsis || '' });
const normalizeTmdb = (item, type) => ({ externalId: String(item.id), mediaType: type, title: item.title || item.name, posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : '', year: String(item.release_date?.split('-')[0] || item.first_air_date?.split('-')[0] || ''), score: item.vote_average ? Number(item.vote_average).toFixed(1) : '', overview: item.overview || '' });

const searchMedia = async (query, type) => {
    if (type === 'anime') {
        const endpoint = query === 'popular' ? 'top/anime?limit=12&sfw=true' : `anime?q=${encodeURIComponent(query)}&limit=12&sfw=true`;
        const data = await cachedJson(`https://api.jikan.moe/v4/${endpoint}`, {}, 10 * 60_000);
        if (!data.data) throw new Error('Anime search is temporarily unavailable.');
        return data.data.map(normalizeJikan);
    }
    if (!TMDB_API_KEY) {
        return [{ externalId: 'demo-1', mediaType: type, title: `Search ready for "${query}"`, posterUrl: '', year: '', overview: 'Add TMDB_API_KEY in Vercel Environment Variables for live movie/TV search.' }];
    }
    const endpoint = query === 'popular' ? `trending/${type === 'tv' ? 'tv' : 'movie'}/week?api_key=${encodeURIComponent(TMDB_API_KEY)}` : `search/${type === 'tv' ? 'tv' : 'movie'}?api_key=${encodeURIComponent(TMDB_API_KEY)}&query=${encodeURIComponent(query)}`;
    const data = await cachedJson(`https://api.themoviedb.org/3/${endpoint}`, {}, 5 * 60_000);
    if (!data.results) throw new Error('Film search is temporarily unavailable.');
    return data.results.slice(0, 12).map((item) => normalizeTmdb(item, type));
};

const chatCompletion = async (model, messages, system) => {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        headers: {
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': process.env.PUBLIC_URL || 'https://18vt.vercel.app',
            'X-Title': '18vt'
        },
        body: JSON.stringify({ model, messages, system })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        if (response.status === 401) throw Object.assign(new Error('OpenRouter API key is invalid or expired. Check OPENROUTER_API_KEY in Vercel Environment Variables.'), { status: 502 });
        if (response.status === 429) throw Object.assign(new Error('AI provider rate limit reached. Try again in a moment.'), { status: 429 });
        throw Object.assign(new Error(data?.error?.message || `AI provider error (${response.status})`), { status: 502 });
    }
    const reply = data?.choices?.[0]?.message?.content || '';
    if (!reply) throw new Error('The model returned an empty reply. Try again or pick another model.');
    return reply;
};

module.exports = async (req, res) => {
    const requestId = crypto.randomBytes(4).toString('hex');

    const url = new URL(req.url, `https://${req.headers.host || '18vt.vercel.app'}`);
    // Vercel's catch-all routes /api/<anything> here. Strip the /api prefix and trailing slash.
    const route = (url.pathname.replace(/^\/api/, '') || '/').replace(/\/+$/, '') || '/';
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    console.log(`\n[${requestId}] ${method} ${route}`);

    try {
        // ── Health ─────────────────────────────────────────────────────
        if (method === 'GET' && route === '/health') {
            const env = {
                SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
                SUPABASE_PUBLISHABLE_KEY: Boolean(process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY),
                OPENROUTER_API_KEY: Boolean(process.env.OPENROUTER_API_KEY),
                TMDB_API_KEY: Boolean(process.env.TMDB_API_KEY)
            };
            const missing = Object.entries(env).filter(([, ok]) => !ok).map(([key]) => key);
            return json(res, 200, {
                status: missing.length === 0 ? 'ok' : 'degraded',
                service: '18vt',
                version: '1.1.0',
                models: ['meta-llama/llama-3.3-70b-instruct:free', 'google/gemini-2.0-flash-exp:free', 'deepseek/deepseek-chat-v3-0324:free', 'qwen/qwen3-30b-a3b:free'],
                uptimeSeconds: Math.round(process.uptime()),
                env,
                missing,
                message: missing.length === 0
                    ? 'All required environment variables are configured.'
                    : `Missing environment variables: ${missing.join(', ')}. Add them in Vercel Project Settings and redeploy.`
            }, { 'Cache-Control': 'no-store' });
        }

        // ── Auth ───────────────────────────────────────────────────────
        if (route.startsWith('/auth/')) {
            const limiter = rateLimit('auth', clientKey(req), RATE_LIMITS.auth);
            if (!limiter.ok) return json(res, 429, { error: `Too many attempts. Try again in ${limiter.retryAfter}s.` }, { 'Retry-After': String(limiter.retryAfter) });

            if (method === 'POST' && route === '/auth/signup') {
                const input = await body(req);
                const name = String(input.name || '').trim();
                const email = String(input.email || '').trim().toLowerCase();
                const password = String(input.password || '');
                if (name.length < 2) return json(res, 400, { error: 'Enter a name.' });
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: 'Enter a valid email.' });
                if (password.length < 8) return json(res, 400, { error: 'Password must be 8+ characters.' });
                const session = await supabase('/auth/v1/signup', { method: 'POST', body: JSON.stringify({ email, password, data: { name } }) });
                if (!session.user) return json(res, 200, { needsEmailConfirmation: true, message: 'Account created! Check your email to confirm, then sign in.' });
                return json(res, 201, { user: { id: session.user.id, email: session.user.email, name, createdAt: session.user.created_at } }, { 'Set-Cookie': setAuthCookies(session) });
            }

            if (method === 'POST' && route === '/auth/signin') {
                const input = await body(req);
                const session = await supabase('/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email: String(input.email || '').trim().toLowerCase(), password: String(input.password || '') }) });
                return json(res, 200, { user: publicUser(session.user) }, { 'Set-Cookie': setAuthCookies(session) });
            }

            if (method === 'POST' && route === '/auth/signout') {
                const auth = await accessUser(req, res);
                if (auth) await supabase('/auth/v1/logout', { method: 'POST' }, auth.accessToken).catch(() => {});
                return json(res, 200, { ok: true }, { 'Set-Cookie': clearAuthCookies() });
            }

            if (method === 'GET' && route === '/auth/me') {
                const auth = await accessUser(req, res);
                return json(res, 200, { user: auth ? publicUser(auth.user) : null });
            }

            return json(res, 405, { error: `Method ${method} not allowed for ${route}` }, { Allow: 'GET, POST' });
        }

        // ── Chat ───────────────────────────────────────────────────────
        if (route === '/chat') {
            if (method !== 'POST') return json(res, 405, { error: 'Use POST for /api/chat' }, { Allow: 'POST' });
            const limiter = rateLimit('chat', clientKey(req), RATE_LIMITS.chat);
            if (!limiter.ok) return json(res, 429, { error: `Slow down a little — try again in ${limiter.retryAfter}s.` }, { 'Retry-After': String(limiter.retryAfter) });

            const auth = await requireUser(req, res);
            if (!auth) return;

            const input = await body(req);
            const requestedModel = String(input.model || DEFAULT_MODEL);
            const messages = Array.isArray(input.messages) ? input.messages.slice(-20) : [];
            if (!messages.length) return json(res, 400, { error: 'Send at least one message.' });
            const system = String(input.system || 'You are a helpful assistant.').slice(0, 8000);
            const streaming = input.stream === true;

            if (streaming) {
                res.statusCode = 200;
                res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
                res.setHeader('Cache-Control', 'no-store');
                res.setHeader('Connection', 'keep-alive');
                let closed = false;
                req.on('close', () => { closed = true; });
                // Keepalive comments so proxies keep the stream open while the model thinks.
                const pings = setInterval(() => { if (!closed) res.write(': ping\n\n'); }, 15_000);
                const finishStream = () => { clearInterval(pings); res.end(); };

                const models = [requestedModel, ...FALLBACK_CHAIN.filter((m) => m !== requestedModel)];
                let upstream = null;
                for (const model of models) {
                    try {
                        upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                            method: 'POST',
                            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
                            headers: {
                                Authorization: `Bearer ${OPENROUTER_API_KEY}`,
                                'Content-Type': 'application/json',
                                'HTTP-Referer': process.env.PUBLIC_URL || 'https://18vt.vercel.app',
                                'X-Title': '18vt'
                            },
                            body: JSON.stringify({ model, messages, system, stream: true })
                        });
                        if (upstream.ok) { if (model !== requestedModel) res.write(`event: notice\ndata: ${JSON.stringify({ message: `${requestedModel} was busy, switched to ${model}` })}\n\n`); break; }
                        if (upstream.status === 401) throw Object.assign(new Error('OpenRouter API key is invalid or expired.'), { fatal: true });
                        if (upstream.status !== 429 && upstream.status < 500) throw Object.assign(new Error(`AI provider error (${upstream.status})`), { fatal: true });
                        upstream = null; // fall through to next model
                    } catch (error) {
                        if (error.fatal) {
                            res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
                            return finishStream();
                        }
                        upstream = null;
                    }
                }
                if (!upstream) {
                    res.write(`event: error\ndata: ${JSON.stringify({ error: 'All AI models are busy right now. Try again shortly.' })}\n\n`);
                    return finishStream();
                }

                const reader = upstream.body.getReader();
                const decoder = new TextDecoder();
                let buffer = '';
                while (!closed) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();
                    for (const line of lines) {
                        const trimmed = line.trim();
                        if (!trimmed.startsWith('data:')) continue;
                        const payload = trimmed.slice(5).trim();
                        if (payload === '[DONE]') { res.write('event: done\ndata: {}\n\n'); return finishStream(); }
                        try {
                            const parsed = JSON.parse(payload);
                            const delta = parsed.choices?.[0]?.delta?.content || '';
                            if (delta) {
                                res.write(`data: ${JSON.stringify({ delta })}\n\n`);
                                if (typeof res.flush === 'function') res.flush();
                            }
                        } catch {}
                    }
                }
                return finishStream();
            }

            // Non-streaming with automatic model fallback.
            const models = [requestedModel, ...FALLBACK_CHAIN.filter((m) => m !== requestedModel)];
            let lastError = null;
            for (const model of models) {
                try { return json(res, 200, { reply: await chatCompletion(model, messages, system), model }); }
                catch (error) { lastError = error; if (error.status === 429 || error.status === 502) continue; throw error; }
            }
            throw lastError || new Error('Chat failed.');
        }

        // ── Conversations ──────────────────────────────────────────────
        if (route === '/conversations') {
            const auth = await requireUser(req, res);
            if (!auth) return;

            if (method === 'GET') {
                const rows = await rest('conversations', `?select=*&user_id=eq.${encodeURIComponent(auth.user.id)}&order=created_at.desc`, {}, auth.accessToken);
                return json(res, 200, { conversations: rows.map(mapConversation) });
            }

            if (method === 'POST') {
                const input = await body(req);
                const item = { user_id: auth.user.id, prompt: String(input.prompt || '').slice(0, 1000), reply: String(input.reply || '').slice(0, 50000), file_name: String(input.fileName || '').slice(0, 200), model_name: String(input.modelName || '').slice(0, 100), image_url: String(input.imageUrl || '').slice(0, 500), created_at: new Date().toISOString() };
                const result = await rest('conversations', '', { method: 'POST', body: JSON.stringify(item) }, auth.accessToken);
                return json(res, 201, { conversation: mapConversation(result[0]) });
            }

            if (method === 'DELETE') {
                await rest('conversations', `?user_id=eq.${encodeURIComponent(auth.user.id)}`, { method: 'DELETE' }, auth.accessToken);
                return json(res, 200, { ok: true });
            }

            return json(res, 405, { error: `Method ${method} not allowed for ${route}` }, { Allow: 'GET, POST, DELETE' });
        }

        if (route.startsWith('/conversations/')) {
            if (method !== 'DELETE') return json(res, 405, { error: 'Use DELETE for /api/conversations/:id' }, { Allow: 'DELETE' });
            const auth = await requireUser(req, res);
            if (!auth) return;
            const id = route.split('/').pop();
            await rest('conversations', `?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(auth.user.id)}`, { method: 'DELETE' }, auth.accessToken);
            return json(res, 200, { ok: true });
        }

        // ── Media ──────────────────────────────────────────────────────
        if (route === '/media/search') {
            if (method !== 'GET') return json(res, 405, { error: 'Use GET for /api/media/search' }, { Allow: 'GET' });
            const limiter = rateLimit('media', clientKey(req), RATE_LIMITS.media);
            if (!limiter.ok) return json(res, 429, { error: `Too many searches — retry in ${limiter.retryAfter}s.` }, { 'Retry-After': String(limiter.retryAfter) });

            const auth = await requireUser(req, res);
            if (!auth) return;
            const type = ['movie', 'tv', 'anime'].includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'movie';
            const q = String(url.searchParams.get('q') || 'popular').slice(0, 200);
            return json(res, 200, { results: await searchMedia(q, type) });
        }

        // ── Watchlist ──────────────────────────────────────────────────
        if (route === '/watchlist') {
            const auth = await requireUser(req, res);
            if (!auth) return;

            if (method === 'GET') {
                const rows = await rest('watchlist', `?select=*&user_id=eq.${encodeURIComponent(auth.user.id)}&order=created_at.desc`, {}, auth.accessToken);
                return json(res, 200, { items: rows.map(mapWatch) });
            }

            if (method === 'POST') {
                const input = await body(req);
                const status = ['planned', 'watching', 'completed', 'dropped'].includes(String(input.status)) ? String(input.status) : 'planned';
                const item = { user_id: auth.user.id, media_type: String(input.mediaType || 'movie'), external_id: String(input.externalId || ''), title: String(input.title || '').slice(0, 200), poster_url: String(input.posterUrl || '').slice(0, 500), year: String(input.year || ''), progress: 0, status, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
                const result = await rest('watchlist', '', { method: 'POST', body: JSON.stringify(item) }, auth.accessToken);
                return json(res, 201, { item: mapWatch(result[0]) });
            }

            return json(res, 405, { error: `Method ${method} not allowed for ${route}` }, { Allow: 'GET, POST' });
        }

        if (route.startsWith('/watchlist/')) {
            const auth = await requireUser(req, res);
            if (!auth) return;
            const id = route.split('/').pop();

            if (method === 'PATCH') {
                const input = await body(req);
                const progress = Math.max(0, Math.min(100, Number(input.progress) || 0));
                const update = { progress, updated_at: new Date().toISOString(), ...(input.status && { status: String(input.status).slice(0, 40) }) };
                const result = await rest('watchlist', `?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(auth.user.id)}`, { method: 'PATCH', body: JSON.stringify(update) }, auth.accessToken);
                return json(res, 200, { item: mapWatch(result[0]) });
            }

            if (method === 'DELETE') {
                await rest('watchlist', `?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(auth.user.id)}`, { method: 'DELETE' }, auth.accessToken);
                return json(res, 200, { ok: true });
            }

            return json(res, 405, { error: `Method ${method} not allowed for ${route}` }, { Allow: 'PATCH, DELETE' });
        }

        // ── Image generation ───────────────────────────────────────────
        if (route === '/generate-image') {
            if (method !== 'POST') return json(res, 405, { error: 'Use POST for /api/generate-image' }, { Allow: 'POST' });
            const limiter = rateLimit('media', clientKey(req), RATE_LIMITS.media);
            if (!limiter.ok) return json(res, 429, { error: `Slow down — retry in ${limiter.retryAfter}s.` }, { 'Retry-After': String(limiter.retryAfter) });

            const auth = await requireUser(req, res);
            if (!auth) return;
            const input = await body(req);
            const prompt = String(input.prompt || '').slice(0, 500);
            if (!prompt.trim()) return json(res, 400, { error: 'Describe the image you want.' });
            const width = Math.min(1280, Math.max(256, Math.round(Number(input.width) || 1024)));
            const height = Math.min(1280, Math.max(256, Math.round(Number(input.height) || 1024)));
            const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${width}&height=${height}&nologo=true&seed=${Math.floor(Math.random() * 1e9)}`;
            return json(res, 200, { imageUrl });
        }

        return json(res, 404, { error: `No route for ${method} ${route}`, hint: 'GET /api/health lists configured environment variables.' });
    } catch (error) {
        console.error(`[${requestId}] ERROR:`, error.message);
        return json(res, error.status || 500, { error: error.message || 'Server error.', requestId });
    }
};
