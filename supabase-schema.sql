create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  prompt text not null,
  reply text not null,
  file_name text not null default '',
  model_name text not null default '18vt AI',
  image_url text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.watchlist (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  media_type text not null check (media_type in ('movie', 'tv', 'anime')),
  external_id text not null,
  title text not null,
  poster_url text not null default '',
  year text not null default '',
  progress integer not null default 0 check (progress between 0 and 100),
  status text not null default 'planned' check (status in ('planned', 'watching', 'watched')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, media_type, external_id)
);

create index if not exists conversations_user_created_idx on public.conversations(user_id, created_at desc);
create index if not exists watchlist_user_updated_idx on public.watchlist(user_id, updated_at desc);

alter table public.conversations enable row level security;
alter table public.watchlist enable row level security;

drop policy if exists "Users can read their conversations" on public.conversations;
drop policy if exists "Users can create their conversations" on public.conversations;
drop policy if exists "Users can delete their conversations" on public.conversations;
create policy "Users can read their conversations" on public.conversations for select using (auth.uid() = user_id);
create policy "Users can create their conversations" on public.conversations for insert with check (auth.uid() = user_id);
create policy "Users can delete their conversations" on public.conversations for delete using (auth.uid() = user_id);

drop policy if exists "Users can read their watchlist" on public.watchlist;
drop policy if exists "Users can create their watchlist" on public.watchlist;
drop policy if exists "Users can update their watchlist" on public.watchlist;
drop policy if exists "Users can delete their watchlist" on public.watchlist;
create policy "Users can read their watchlist" on public.watchlist for select using (auth.uid() = user_id);
create policy "Users can create their watchlist" on public.watchlist for insert with check (auth.uid() = user_id);
create policy "Users can update their watchlist" on public.watchlist for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete their watchlist" on public.watchlist for delete using (auth.uid() = user_id);
