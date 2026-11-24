-- Серверне обмеження частоти торгових дій: «зайняти слот» атомарно (advisory lock на користувача),
-- щоб два паралельні запити не пройшли обидва. Викликає лише Edge Function (service_role).
create or replace function public.trade_claim(
  p_user uuid, p_exchange text, p_action text, p_symbol text, p_side text,
  p_notional numeric, p_leverage integer, p_link text, p_gap_ms integer)
returns bigint language plpgsql security definer set search_path = '' as $$
declare rid bigint;
begin
  perform pg_advisory_xact_lock(hashtext(p_user::text));
  if exists (select 1 from public.trade_log
             where user_id = p_user and action in ('order', 'close')
               and created_at > now() - make_interval(secs => p_gap_ms / 1000.0)) then
    return null;
  end if;
  insert into public.trade_log (user_id, exchange, action, symbol, side, notional, leverage, link, ok, error)
  values (p_user, p_exchange, p_action, p_symbol, p_side, p_notional, p_leverage, p_link, false, 'pending')
  returning id into rid;
  return rid;
end $$;

-- Позначити результат; незавершені записи лишаються «pending» (результат невідомий)
create or replace function public.trade_finish(p_id bigint, p_ok boolean, p_error text)
returns void language sql security definer set search_path = '' as $$
  update public.trade_log set ok = p_ok, error = left(p_error, 300) where id = p_id
$$;

revoke all on function public.trade_claim(uuid, text, text, text, text, numeric, integer, text, integer),
  public.trade_finish(bigint, boolean, text) from public, anon, authenticated;
grant execute on function public.trade_claim(uuid, text, text, text, text, numeric, integer, text, integer),
  public.trade_finish(bigint, boolean, text) to service_role;
