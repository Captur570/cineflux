-- Cinéflux : base de synchronisation (à exécuter une seule fois dans Supabase > SQL Editor > New query > Run)
-- Le serveur ne stocke que des données chiffrées : identifiants de groupe et noms d'éléments hachés.

create table if not exists public.cf_items (
  gid  text        not null,
  k    text        not null,
  v    text        not null,
  del  boolean     not null default false,
  ts   bigint      not null,
  srv  timestamptz not null default clock_timestamp(),
  primary key (gid, k)
);
create index if not exists cf_items_pull on public.cf_items (gid, srv, k);

create table if not exists public.cf_pair (
  h       text primary key,
  payload text not null,
  exp     timestamptz not null
);

-- aucun accès direct aux tables : tout passe par les fonctions ci-dessous
alter table public.cf_items enable row level security;
alter table public.cf_pair  enable row level security;
revoke all on public.cf_items from anon, authenticated;
revoke all on public.cf_pair  from anon, authenticated;

-- envoi d'éléments (le plus récent gagne)
create or replace function public.cf_push(p_gid text, p_items jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if p_gid is null or length(p_gid) <> 64 then raise exception 'groupe invalide'; end if;
  if jsonb_array_length(p_items) > 500 then raise exception 'trop d''éléments'; end if;
  insert into cf_items (gid, k, v, del, ts, srv)
  select p_gid, x->>'k', x->>'v', coalesce((x->>'d')::boolean, false), (x->>'t')::bigint, clock_timestamp()
  from jsonb_array_elements(p_items) x
  where length(x->>'v') < 200000
  on conflict (gid, k) do update
    set v = excluded.v, del = excluded.del, ts = excluded.ts, srv = clock_timestamp()
    where cf_items.ts <= excluded.ts;
  get diagnostics n = row_count;
  return n;
end $$;

-- réception des éléments modifiés depuis le dernier passage
create or replace function public.cf_pull(p_gid text, p_since timestamptz default null, p_after_k text default '')
returns table (k text, v text, del boolean, ts bigint, srv timestamptz)
language sql stable security definer set search_path = public as $$
  select i.k, i.v, i.del, i.ts, i.srv from cf_items i
  where i.gid = p_gid
    and (p_since is null or (i.srv, i.k) > (p_since, coalesce(p_after_k, '')))
  order by i.srv, i.k
  limit 1000
$$;

-- association d'un appareil : code valable 10 minutes, à usage unique
create or replace function public.cf_pair_create(p_h text, p_payload text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if length(p_h) <> 64 or length(p_payload) > 4000 then raise exception 'invalide'; end if;
  delete from cf_pair where exp < now();
  insert into cf_pair (h, payload, exp) values (p_h, p_payload, now() + interval '10 minutes')
  on conflict (h) do update set payload = excluded.payload, exp = excluded.exp;
  return true;
end $$;

create or replace function public.cf_pair_claim(p_h text)
returns text language plpgsql security definer set search_path = public as $$
declare r text;
begin
  delete from cf_pair where h = p_h and exp > now() returning payload into r;
  delete from cf_pair where exp < now();
  return r;
end $$;

revoke all on function public.cf_push(text, jsonb), public.cf_pull(text, timestamptz, text),
                public.cf_pair_create(text, text), public.cf_pair_claim(text) from public;
grant execute on function public.cf_push(text, jsonb), public.cf_pull(text, timestamptz, text),
                public.cf_pair_create(text, text), public.cf_pair_claim(text) to anon, authenticated;
