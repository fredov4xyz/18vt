# 18vt Vercel setup

## 1. Supabase

1. Create a Supabase project.
2. Open **SQL Editor** and run all of `supabase-schema.sql`.
3. In **Authentication → URL Configuration**, add your Vercel URL to the allowed redirect/site URLs.
4. Copy the project URL and publishable key from **Project Settings → API**.

The frontend uses Supabase Auth through the serverless API. Conversations and watchlist rows are protected by row-level security and linked to `auth.users`.

## 2. Vercel environment variables

Add these in **Project Settings → Environment Variables** for Production, Preview, and Development as needed:

```text
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=your_supabase_publishable_key
OPENROUTER_API_KEY=your_openrouter_key
TMDB_API_KEY=your_tmdb_key
PUBLIC_URL=https://your-app.vercel.app
```

Never put `OPENROUTER_API_KEY`, a Supabase service-role key, or any other private key in `indev.html` or a `VITE_` variable.

## 3. Deploy

Import this repository into Vercel. The repo contains only what the deployment needs; `vercel.json` keeps `/` pointed at `indev.html`, declares the `api/**` functions explicitly (1024 MB memory, 60 s timeout), and adds security headers. Node 20+ is required (`engines` in `package.json`).

After deploying, test:

- **Open `https://your-app.vercel.app/api/health` first.** It returns which environment variables are configured (booleans only, never values) and lists anything missing. Add `?deep=1` to also probe each upstream (Supabase, OpenRouter, TMDB, Jikan) with latency. The app also shows a banner automatically if anything is missing.
- Sign up, sign out, and sign in again.
- Send an AI prompt — replies stream in live (toggleable in the settings menu) with a stop button, automatic model fallback when one is busy, and markdown rendering.
- **Send a follow-up message** — the AI remembers the current chat (last 10 exchanges), so you can ask "now explain it simpler."
- **＋ New chat** (or `Ctrl+K`) starts a fresh session; **History** toggles between the current chat and all past conversations.
- Copy any code block from a reply with the hover **⧉ Copy** button.
- Press **✦ Image** with an empty box to cycle square → landscape → portrait output.
- Open Watch, search movies, TV, or anime, and hit **▶ Trailer** — the trailer plays in an embedded player (YouTube/TMDB/Jikan, no key needed for anime).
- Open the model picker — it loads the live free-model list from OpenRouter on top of the four curated models.
- Copy or delete any exchange, or clear all conversations from the settings menu.
- Open Watch, search anime, and add a title to your watchlist.
- **Click a watchlist status** (planned → watching → completed → dropped) to change it.
- Move the progress slider and reload the page.

## API overview

| Endpoint | Notes |
|---|---|
| `GET /api/health` | Env-var status (booleans only), uptime; `?deep=1` probes upstreams |
| `GET /api/models` | Live free-model list (curated + OpenRouter), cached 5 min |
| `POST /api/auth/signup` | Validates input, sets auth cookies |
| `POST /api/auth/signin` | Rate-limited per IP |
| `POST /api/auth/signout` / `GET /api/auth/me` | |
| `GET|POST|DELETE /api/conversations` | Auth required |
| `DELETE /api/conversations/:id` | Delete one exchange (404 if not yours) |
| `GET /api/media/search` | Cached upstream (Jikan/TMDB), rate-limited |
| `GET /api/media/detail` | Trailer URL + embed for a movie/TV/anime id; auth required |
| `GET|POST /api/watchlist`, `PATCH|DELETE /api/watchlist/:id` | Auth required |
| `POST /api/chat` | Streaming (SSE) with keepalives, model fallback, multi-turn history; rate-limited |
| `POST /api/generate-image` | Pollinations, optional `width`/`height` (256–1280); rate-limited |

Wrong HTTP methods return `405` with an `Allow` header; unknown routes return `404` with a hint to check `/api/health`.

Anime search uses Jikan without a key. Movie and TV search uses TMDB when `TMDB_API_KEY` is present. Image generation uses the free Pollinations image endpoint. The frontend ships a hand-rolled utility stylesheet instead of a CSS framework CDN — no runtime compiler, no layout flash.
