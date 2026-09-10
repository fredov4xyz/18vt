const crypto = require('crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

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
  req.on('data', (chunk) => { value += chunk; if (value.length > 12_000_000) { reject(new Error('Request body is too large')); req.destroy(); } });
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
  console.log(`[Supabase] ${options.method || 'GET'} ${endpoint}`);
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error('[Supabase] ERROR: Missing SUPABASE_URL or SUPABASE_ANON_KEY');
    throw new Error('Supabase is not configured. Add SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY to Vercel Environment Variables.');
  }
  try {
    const response = await fetch(`${SUPABASE_URL}${endpoint}`, { 
      ...options, 
      headers: { 
        apikey: SUPABASE_ANON_KEY, 
        Authorization: `Bearer ${accessToken || SUPABASE_ANON_KEY}`, 
        'Content-Type': 'application/json', 
        ...(options.headers || {}) 
      } 
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error(`[Supabase] ${response.status}:`, data);
      throw new Error(data.msg || data.error_description || data.message || data.error || `Supabase request failed (${response.status})`);
    }
    console.log(`[Supabase] ✓ ${response.status}`);
    return data;
  } catch (error) {
    console.error('[Supabase] Fetch error:', error.message);
    throw error;
  }
};

const accessUser = async (req, res) => {
  const jar = cookies(req);
  if (!jar['18vt_access']) {
    console.log('[Auth] No access token in cookies');
    return null;
  }
  try { 
    return { user: await supabase('/auth/v1/user', { method: 'GET' }, jar['18vt_access']), accessToken: jar['18vt_access'] }; 
  } catch (error) {
    console.log('[Auth] Access token invalid, attempting refresh...');
    if (!jar['18vt_refresh']) {
      console.log('[Auth] No refresh token available');
      return null;
    }
    try {
      const session = await supabase('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: JSON.stringify({ refresh_token: jar['18vt_refresh'] }) });
      res.setHeader('Set-Cookie', setAuthCookies(session));
      console.log('[Auth] ✓ Token refreshed');
      return { user: await supabase('/auth/v1/user', { method: 'GET' }, session.access_token), accessToken: session.access_token };
    } catch (refreshError) { 
      console.error('[Auth] Refresh failed:', refreshError.message);
      return null; 
    }
  }
};

const requireUser = async (req, res) => { 
  const auth = await accessUser(req, res); 
  if (!auth) { 
    console.log('[Auth] User required but not authenticated');
    json(res, 401, { error: 'Sign in to use this feature.' }); 
    return null; 
  } 
  return auth; 
};

const rest = async (table, query, options, token) => supabase(`/rest/v1/${table}${query}`, options, token);

const mapConversation = (item) => ({ id: item.id, prompt: item.prompt, reply: item.reply, fileName: item.file_name || '', modelName: item.model_name || '18vt AI', imageUrl: item.image_url || '', createdAt: item.created_at });
const mapWatch = (item) => ({ id: item.id, mediaType: item.media_type, externalId: item.external_id, title: item.title, posterUrl: item.poster_url || '', year: item.year || '', progress: item.progress || 0, status: item.status || 'planned', createdAt: item.created_at, updatedAt: item.updated_at });
const normalizeJikan = (item) => ({ externalId: String(item.mal_id), mediaType: 'anime', title: item.title, posterUrl: item.images?.jpg?.large_image_url || item.images?.jpg?.image_url || '', year: String(item.aired?.prop?.from?.year || '') });
const normalizeTmdb = (item, type) => ({ externalId: String(item.id), mediaType: type, title: item.title || item.name, posterUrl: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : '', year: String(item.release_date?.split('-')[0] || item.first_air_date?.split('-')[0] || '') });

const searchMedia = async (query, type) => {
  console.log(`[Media] Searching ${type}: "${query}"`);
  if (type === 'anime') {
    const endpoint = query === 'popular' ? 'top/anime?limit=12&sfw=true' : `anime?q=${encodeURIComponent(query)}&limit=12&sfw=true`;
    try {
      const response = await fetch(`https://api.jikan.moe/v4/${endpoint}`); 
      if (!response.ok) throw new Error('Anime search is temporarily unavailable.'); 
      const data = await response.json(); 
      console.log(`[Media] ✓ Found ${data.data?.length || 0} anime results`);
      return data.data.map(normalizeJikan);
    } catch (error) {
      console.error('[Media] Anime search error:', error.message);
      throw error;
    }
  }
  if (!TMDB_API_KEY) {
    console.log('[Media] TMDB_API_KEY not configured, returning demo');
    return [{ externalId: 'demo-1', mediaType: type, title: `Search ready for "${query}"`, posterUrl: '', year: '', overview: 'Add TMDB_API_KEY in Vercel Environment Variables for live movie/TV search.' }];
  }
  const endpoint = query === 'popular' ? `trending/${type === 'tv' ? 'tv' : 'movie'}/week?api_key=${encodeURIComponent(TMDB_API_KEY)}` : `search/${type === 'tv' ? 'tv' : 'movie'}?api_key=${encodeURIComponent(TMDB_API_KEY)}&query=${encodeURIComponent(query)}`;
  try {
    const response = await fetch(`https://api.themoviedb.org/3/${endpoint}`); 
    if (!response.ok) throw new Error('Film search is temporarily unavailable.'); 
    const data = await response.json(); 
    console.log(`[Media] ✓ Found ${data.results?.length || 0} film results`);
    return data.results.map((item) => normalizeTmdb(item, type));
  } catch (error) {
    console.error('[Media] TMDB search error:', error.message);
    throw error;
  }
};

const openRouter = async (requestBody, token) => {
  console.log('[OpenRouter] Sending chat request');
  if (!OPENROUTER_API_KEY) {
    console.error('[OpenRouter] ERROR: OPENROUTER_API_KEY is not configured');
    throw new Error('OpenRouter API key is not configured. Add OPENROUTER_API_KEY to Vercel Environment Variables. Get a key at https://openrouter.ai/keys');
  }
  console.log('[OpenRouter] API key present, making request...');
  try {
    const requestPayload = {
      model: requestBody.model || 'meta-llama/llama-3.3-70b-instruct:free',
      messages: requestBody.messages || [],
      system: requestBody.system || 'You are a helpful assistant.'
    };
    console.log('[OpenRouter] Request:', { model: requestPayload.model, messageCount: requestPayload.messages.length });
    
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', { 
      method: 'POST', 
      headers: { 
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`, 
        'Content-Type': 'application/json', 
        'HTTP-Referer': 'https://18vt.vercel.app',
        'X-Title': '18vt'
      }, 
      body: JSON.stringify(requestPayload) 
    });

    console.log(`[OpenRouter] Response status: ${response.status}`);
    const data = await response.json();
    
    if (!response.ok) {
      console.error('[OpenRouter] API Error:', response.status, JSON.stringify(data, null, 2));
      if (response.status === 401) {
        throw new Error('OpenRouter API key is invalid or expired. Check your OPENROUTER_API_KEY in Vercel Environment Variables.');
      }
      if (response.status === 429) {
        throw new Error('OpenRouter rate limit exceeded. Try again in a moment.');
      }
      throw new Error(data?.error?.message || `OpenRouter API error (${response.status}): ${JSON.stringify(data)}`);
    }
    
    const reply = data?.choices?.[0]?.message?.content || '';
    console.log(`[OpenRouter] ✓ Success (${reply.length} chars)`);
    return reply;
  } catch (error) {
    console.error('[OpenRouter] Request failed:', error.message);
    throw error;
  }
};

module.exports = async (req, res) => {
  const requestId = crypto.randomBytes(4).toString('hex');
  console.log(`\n[${requestId}] ${req.method} ${req.url}`);
  
  const url = new URL(req.url, `https://${req.headers.host || '18vt.vercel.app'}`); 
  const route = url.searchParams.get('path') || url.pathname.replace(/^\/api/, '') || '/';
  
  try {
    if (req.method === 'POST' && route === '/auth/signup') { 
      console.log(`[${requestId}] Auth: Sign up`);
      const input = await body(req); 
      const name = String(input.name || '').trim(); 
      const email = String(input.email || '').trim().toLowerCase(); 
      const password = String(input.password || ''); 
      if (name.length < 2) return json(res, 400, { error: 'Enter a name.' }); 
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, 400, { error: 'Enter a valid email.' }); 
      if (password.length < 8) return json(res, 400, { error: 'Password must be 8+ characters.' }); 
      const session = await supabase('/auth/v1/signup', { method: 'POST', body: JSON.stringify({ email, password, data: { name } }) }); 
      console.log(`[${requestId}] ✓ Sign up successful for ${email}`);
      return json(res, 201, { user: { id: session.user.id, email: session.user.email, name, createdAt: session.user.created_at } }, { 'Set-Cookie': setAuthCookies(session) }); 
    }
    
    if (req.method === 'POST' && route === '/auth/signin') { 
      console.log(`[${requestId}] Auth: Sign in`);
      const input = await body(req); 
      console.log(`[${requestId}] Attempting sign in for: ${input.email}`);
      const session = await supabase('/auth/v1/token?grant_type=password', { method: 'POST', body: JSON.stringify({ email: input.email, password: input.password }) }); 
      console.log(`[${requestId}] ✓ Sign in successful for ${input.email}`);
      return json(res, 200, { user: publicUser(session.user) }, { 'Set-Cookie': setAuthCookies(session) }); 
    }
    
    if (req.method === 'POST' && route === '/auth/signout') { 
      console.log(`[${requestId}] Auth: Sign out`);
      const auth = await accessUser(req, res); 
      if (auth) await supabase('/auth/v1/logout', { method: 'POST' }, auth.accessToken).catch(() => {}); 
      console.log(`[${requestId}] ✓ Sign out successful`);
      return json(res, 200, { ok: true }, { 'Set-Cookie': clearAuthCookies() }); 
    }
    
    if (req.method === 'GET' && route === '/auth/me') { 
      console.log(`[${requestId}] Auth: Get current user`);
      const auth = await accessUser(req, res); 
      console.log(`[${requestId}] Current user: ${auth ? auth.user.email : 'anonymous'}`);
      return json(res, 200, { user: auth ? publicUser(auth.user) : null }); 
    }

    if (req.method === 'GET' && route === '/conversations') { 
      console.log(`[${requestId}] Conversations: List`);
      const auth = await requireUser(req, res); 
      if (!auth) return; 
      const rows = await rest('conversations', `?select=*&user_id=eq.${encodeURIComponent(auth.user.id)}&order=created_at.desc`, {}, auth.accessToken); 
      console.log(`[${requestId}] ✓ Found ${rows.length} conversations`);
      return json(res, 200, { conversations: rows.map(mapConversation) }); 
    }
    
    if (req.method === 'POST' && route === '/conversations') { 
      console.log(`[${requestId}] Conversations: Create`);
      const auth = await requireUser(req, res); 
      if (!auth) return; 
      const input = await body(req); 
      const item = { user_id: auth.user.id, prompt: String(input.prompt || '').slice(0, 1000), reply: String(input.reply || '').slice(0, 50000), file_name: String(input.fileName || '').slice(0, 200), model_name: String(input.modelName || '').slice(0, 100), image_url: String(input.imageUrl || '').slice(0, 500), created_at: new Date().toISOString() }; 
      const result = await rest('conversations', '', { method: 'POST', body: JSON.stringify(item) }, auth.accessToken); 
      console.log(`[${requestId}] ✓ Conversation created`);
      return json(res, 201, { conversation: mapConversation(result[0]) }); 
    }
    
    if (req.method === 'DELETE' && route === '/conversations') { 
      console.log(`[${requestId}] Conversations: Delete all`);
      const auth = await requireUser(req, res); 
      if (!auth) return; 
      await rest('conversations', `?user_id=eq.${encodeURIComponent(auth.user.id)}`, { method: 'DELETE' }, auth.accessToken); 
      console.log(`[${requestId}] ✓ All conversations deleted`);
      return json(res, 200, { ok: true }); 
    }

    if (req.method === 'GET' && route === '/media/search') { 
      console.log(`[${requestId}] Media: Search`);
      const auth = await requireUser(req, res); 
      if (!auth) return; 
      const type = ['movie', 'tv', 'anime'].includes(url.searchParams.get('type')) ? url.searchParams.get('type') : 'movie'; 
      const q = String(url.searchParams.get('q') || 'popular'); 
      const results = await searchMedia(q, type); 
      console.log(`[${requestId}] ✓ Media search complete`);
      return json(res, 200, { results }); 
    }
    
    if (req.method === 'GET' && route === '/watchlist') { 
      console.log(`[${requestId}] Watchlist: List`);
      const auth = await requireUser(req, res); 
      if (!auth) return; 
      const rows = await rest('watchlist', `?select=*&user_id=eq.${encodeURIComponent(auth.user.id)}&order=created_at.desc`, {}, auth.accessToken); 
      console.log(`[${requestId}] ✓ Found ${rows.length} watchlist items`);
      return json(res, 200, { items: rows.map(mapWatch) }); 
    }
    
    if (req.method === 'POST' && route === '/watchlist') { 
      console.log(`[${requestId}] Watchlist: Add item`);
      const auth = await requireUser(req, res); 
      if (!auth) return; 
      const input = await body(req); 
      const mediaType = String(input.mediaType || 'movie'); 
      const item = { user_id: auth.user.id, media_type: mediaType, external_id: String(input.externalId || ''), title: String(input.title || '').slice(0, 200), poster_url: String(input.posterUrl || '').slice(0, 500), year: String(input.year || ''), progress: 0, status: 'planned', created_at: new Date().toISOString(), updated_at: new Date().toISOString() }; 
      const result = await rest('watchlist', '', { method: 'POST', body: JSON.stringify(item) }, auth.accessToken); 
      console.log(`[${requestId}] ✓ Item added to watchlist`);
      return json(res, 201, { item: mapWatch(result[0]) }); 
    }
    
    if (req.method === 'PATCH' && route.startsWith('/watchlist/')) { 
      console.log(`[${requestId}] Watchlist: Update item`);
      const auth = await requireUser(req, res); 
      if (!auth) return; 
      const input = await body(req); 
      const progress = Math.max(0, Math.min(100, Number(input.progress) || 0)); 
      const update = { progress, updated_at: new Date().toISOString(), ...input.status && { status: input.status } }; 
      const id = route.split('/').pop(); 
      const result = await rest('watchlist', `?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(auth.user.id)}`, { method: 'PATCH', body: JSON.stringify(update) }, auth.accessToken); 
      console.log(`[${requestId}] ✓ Watchlist item updated`);
      return json(res, 200, { item: mapWatch(result[0]) }); 
    }
    
    if (req.method === 'DELETE' && route.startsWith('/watchlist/')) { 
      console.log(`[${requestId}] Watchlist: Delete item`);
      const auth = await requireUser(req, res); 
      if (!auth) return; 
      await rest('watchlist', `?id=eq.${encodeURIComponent(route.split('/').pop())}&user_id=eq.${encodeURIComponent(auth.user.id)}`, { method: 'DELETE' }, auth.accessToken); 
      console.log(`[${requestId}] ✓ Watchlist item deleted`);
      return json(res, 200, { ok: true }); 
    }

    if (req.method === 'POST' && route === '/generate-image') { 
      console.log(`[${requestId}] Image: Generate`);
      const auth = await requireUser(req, res); 
      if (!auth) return; 
      const input = await body(req); 
      const prompt = String(input.prompt || '').slice(0, 500); 
      const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}`; 
      console.log(`[${requestId}] ✓ Image URL generated`);
      return json(res, 200, { imageUrl }); 
    }
    
    if (req.method === 'POST' && route === '/chat') { 
      console.log(`[${requestId}] Chat: Send message`);
      const auth = await requireUser(req, res); 
      if (!auth) return; 
      const input = await body(req); 
      console.log(`[${requestId}] Calling OpenRouter...`);
      const reply = await openRouter(input, auth.accessToken);
      console.log(`[${requestId}] ✓ Chat complete`);
      return json(res, 200, { reply }); 
    }
    
    console.log(`[${requestId}] Route not found: ${route}`);
    return json(res, 404, { error: 'Not found' });
  } catch (error) { 
    console.error(`[${requestId}] ERROR:`, error.message);
    console.error(`[${requestId}] Stack:`, error.stack);
    return json(res, 500, { error: error.message || 'Server error.', requestId }); 
  }
};
