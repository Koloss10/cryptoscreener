-- Посилення за результатами рецензії бекенду.

-- 1) 2FA: JWT aal2 І існує підтверджений TOTP-фактор (після видалення фактора старий aal2-токен більше не діє)
create or replace function private.mfa_strict() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select auth.jwt() ->> 'aal'), 'aal1') = 'aal2'
     and exists (select 1 from auth.mfa_factors f where f.user_id = (select auth.uid()) and f.status = 'verified')
$$;

-- 2) ex_secret_for віддає ще й статус ключа: функція не довіряє ключу, що не пройшов перевірку (check)
drop function if exists public.ex_secret_for(uuid, text);
create function public.ex_secret_for(p_uid uuid, p_exchange text)
returns table (conn_id uuid, api_key text, api_secret text, status text)
language sql stable security definer set search_path = '' as $$
  select c.id, (d.decrypted_secret::json) ->> 'key', (d.decrypted_secret::json) ->> 'secret', c.status
  from public.exchange_connections c join vault.decrypted_secrets d on d.id = c.vault_secret_id
  where c.user_id = p_uid and c.exchange = p_exchange and c.status <> 'revoked'
$$;
revoke all on function public.ex_secret_for(uuid, text) from public, anon, authenticated;
grant execute on function public.ex_secret_for(uuid, text) to service_role;

-- 3) ex_save: одночасні виклики для однієї пари користувач+біржа виконуються по черзі
create or replace function public.ex_save(p_key text, p_secret text, p_exchange text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); sid uuid; cid uuid; payload text; lbl text;
begin
  if uid is null then raise exception 'not authenticated'; end if;
  if not private.mfa_strict() then raise exception 'mfa required'; end if;
  if p_exchange not in ('binance', 'bybit') then raise exception 'unsupported exchange'; end if;
  p_key := btrim(coalesce(p_key, '')); p_secret := btrim(coalesce(p_secret, ''));
  if p_key !~ '^[A-Za-z0-9]{10,128}$' or p_secret !~ '^[A-Za-z0-9]{10,128}$' then raise exception 'invalid key format'; end if;
  perform pg_advisory_xact_lock(hashtext(uid::text || p_exchange));
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

-- 4) Секрет у Vault видаляється разом із підключенням, зокрема й коли акаунт видаляють каскадом
create or replace function private.exchange_connection_cleanup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.vault_secret_id is not null then delete from vault.secrets where id = old.vault_secret_id; end if;
  return old;
end $$;
revoke all on function private.exchange_connection_cleanup() from public, anon, authenticated;
create trigger exchange_connections_cleanup before delete on public.exchange_connections
  for each row execute function private.exchange_connection_cleanup();

-- 5) Слот: окремі ліміти для «рухів» (order, close) і читань; поки попередній рух виконується (pending < 30 с), новий не приймається
create or replace function public.trade_claim(
  p_user uuid, p_exchange text, p_action text, p_symbol text, p_side text,
  p_notional numeric, p_leverage integer, p_link text, p_gap_ms integer)
returns bigint language plpgsql security definer set search_path = '' as $$
declare rid bigint; moves boolean := p_action in ('order', 'close');
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));
  if exists (select 1 from public.trade_log
             where user_id = p_user and (action in ('order', 'close')) = moves
               and created_at > now() - make_interval(secs => p_gap_ms / 1000.0)) then
    return null;
  end if;
  if moves and exists (select 1 from public.trade_log
                       where user_id = p_user and action in ('order', 'close') and ok = false and error = 'pending'
                         and created_at > now() - interval '30 seconds') then
    return null;
  end if;
  insert into public.trade_log (user_id, exchange, action, symbol, side, notional, leverage, link, ok, error)
  values (p_user, p_exchange, p_action, p_symbol, p_side, p_notional, p_leverage, p_link, false, 'pending')
  returning id into rid;
  return rid;
end $$;
