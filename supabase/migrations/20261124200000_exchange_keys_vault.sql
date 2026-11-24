-- CryptoScreener: ключі Demo/Testnet бірж у Supabase Vault (браузер їх не бачить) за схемою Orbix.
-- Суворіше за Orbix: ключі й ордери ЛИШЕ з підтвердженим 2FA (aal2) — у Orbix акаунти без 2FA пропускаються.
-- Реальний рахунок неможливий і на рівні схеми: is_testnet завжди true (check), адреси бірж зашиті в Edge Function.

create schema if not exists private;

-- Сесія пройшла 2FA (JWT aal = aal2). Без 2FA — false.
create or replace function private.mfa_strict() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
$$;
revoke all on function private.mfa_strict() from public, anon;
grant usage on schema private to authenticated;
grant execute on function private.mfa_strict() to authenticated;

-- Обгортка для Edge Function (викликається з JWT користувача)
create or replace function public.mfa_ok_now() returns boolean
language sql stable security definer set search_path = '' as $$ select private.mfa_strict() $$;
revoke all on function public.mfa_ok_now() from public, anon;
grant execute on function public.mfa_ok_now() to authenticated;

create table public.exchange_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  exchange text not null check (exchange in ('bybit', 'binance')),
  label text not null,
  is_testnet boolean not null default true check (is_testnet),
  vault_secret_id uuid,
  key_hint text,
  can_trade boolean not null default false,
  can_withdraw boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'active', 'invalid', 'revoked')),
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, exchange)
);
alter table public.exchange_connections enable row level security;
create policy "own connections are readable" on public.exchange_connections
  for select to authenticated using (user_id = (select auth.uid()));
-- Записи змінюють лише функції security definer нижче й Edge Function (service_role); клієнт — тільки читає свої рядки
revoke all on public.exchange_connections from anon, authenticated;
grant select (id, exchange, label, is_testnet, key_hint, can_trade, status, last_checked_at, created_at)
  on public.exchange_connections to authenticated;

-- Журнал торгових дій (пише лише Edge Function): аудит і серверне обмеження частоти
create table public.trade_log (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  exchange text not null,
  action text not null,
  symbol text,
  side text,
  notional numeric,
  leverage integer,
  link text,
  ok boolean not null,
  error text,
  created_at timestamptz not null default now()
);
create index trade_log_user_time on public.trade_log (user_id, created_at desc);
alter table public.trade_log enable row level security;
create policy "own trade log is readable" on public.trade_log
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.trade_log from anon, authenticated;
grant select on public.trade_log to authenticated;

-- Зберегти або замінити ключі (Vault, JSON {key, secret})
create or replace function public.ex_save(p_key text, p_secret text, p_exchange text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); sid uuid; cid uuid; payload text; lbl text;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if not private.mfa_strict() then raise exception 'mfa required'; end if;
  if p_exchange not in ('binance', 'bybit') then raise exception 'unsupported exchange'; end if;
  p_key := btrim(coalesce(p_key, '')); p_secret := btrim(coalesce(p_secret, ''));
  if p_key !~ '^[A-Za-z0-9]{10,128}$' or p_secret !~ '^[A-Za-z0-9]{10,128}$' then raise exception 'invalid key format'; end if;
  lbl := case p_exchange when 'bybit' then 'Bybit Demo Trading' else 'Binance Futures Testnet' end;
  payload := json_build_object('key', p_key, 'secret', p_secret)::text;
  select id, vault_secret_id into cid, sid from public.exchange_connections where user_id = uid and exchange = p_exchange;
  if sid is null then
    sid := vault.create_secret(payload, 'cs_' || uid::text || '_' || p_exchange, 'CryptoScreener ' || lbl || ' API key');
  else
    perform vault.update_secret(sid, payload);
  end if;
  if cid is null then
    insert into public.exchange_connections (user_id, exchange, label, vault_secret_id, key_hint)
    values (uid, p_exchange, lbl, sid, right(p_key, 4)) returning id into cid;
  else
    update public.exchange_connections set vault_secret_id = sid, key_hint = right(p_key, 4), status = 'pending',
      can_trade = false, can_withdraw = false, last_checked_at = null, updated_at = now() where id = cid;
  end if;
  return cid;
end $$;

-- Видалити ключі разом із секретом у Vault
create or replace function public.ex_delete(p_exchange text)
returns void language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); sid uuid;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if not private.mfa_strict() then raise exception 'mfa required'; end if;
  delete from public.exchange_connections where user_id = uid and exchange = p_exchange returning vault_secret_id into sid;
  if sid is not null then delete from vault.secrets where id = sid; end if;
end $$;

-- Розшифровані ключі — лише для сервера (service_role); відкликані (право виведення) не віддаються
create or replace function public.ex_secret_for(p_uid uuid, p_exchange text)
returns table (conn_id uuid, api_key text, api_secret text)
language sql stable security definer set search_path = '' as $$
  select c.id, (d.decrypted_secret::json) ->> 'key', (d.decrypted_secret::json) ->> 'secret'
  from public.exchange_connections c join vault.decrypted_secrets d on d.id = c.vault_secret_id
  where c.user_id = p_uid and c.exchange = p_exchange and c.status <> 'revoked'
$$;

revoke all on function public.ex_save(text, text, text), public.ex_delete(text), public.ex_secret_for(uuid, text)
  from public, anon, authenticated;
grant execute on function public.ex_save(text, text, text), public.ex_delete(text) to authenticated;
grant execute on function public.ex_secret_for(uuid, text) to service_role;
