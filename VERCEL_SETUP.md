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

Import this repository into Vercel. The included `vercel.json` keeps `/` pointed at `indev.html`, while `api/[...path].js` handles the nested API endpoints.

After deploying, test:

- Sign up, sign out, and sign in again.
- Send an AI prompt.
- Open Watch, search anime, and add a title to your watchlist.
- Move the progress slider and reload the page.

Anime search uses Jikan without a key. Movie and TV search uses TMDB when `TMDB_API_KEY` is present. Image generation uses the free Pollinations image endpoint.
