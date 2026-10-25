-- =====================================================================
-- Anamnese 2.0 — banco de dados no Supabase
-- Cole TUDO no painel: SQL Editor > New query > Run.  (Pode rodar de novo sem problema.)
-- O banco só guarda texto CIFRADO no aparelho; nada aqui consegue ler as fichas.
-- =====================================================================

-- ---------- configuração privada (ninguém acessa pela API) ----------
create table if not exists public.app_config (key text primary key, value text not null);
alter table public.app_config enable row level security;
revoke all on public.app_config from anon, authenticated;

-- ---------- cofre de chaves de cada conta (chaves já embrulhadas/cifradas no aparelho) ----------
create table if not exists public.vaults (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  wrap_pw    text   not null,
  wrap_rec   text   not null,
  kdf        jsonb  not null default '{}'::jsonb,
  seq        bigint not null default 0,
  created_at timestamptz not null default now()
);
alter table public.vaults enable row level security;

-- ---------- fichas e consultas (blocos cifrados) ----------
create table if not exists public.records (
  user_id uuid    not null references auth.users(id) on delete cascade,
  id      text    not null,
  blob    text    not null default '',
  deleted boolean not null default false,
  ts      bigint  not null,
  seq     bigint  not null,
  primary key (user_id, id)
);
create index if not exists records_user_seq on public.records (user_id, seq);
alter table public.records enable row level security;

-- ---------- permissões mínimas ----------
revoke all on public.vaults  from anon, authenticated;
revoke all on public.records from anon, authenticated;
grant select on public.vaults  to authenticated;
grant update (wrap_pw) on public.vaults to authenticated;   -- só a senha embrulhada pode ser trocada pelo próprio usuário
grant select on public.records to authenticated;            -- escrita só pela função sync_records

-- ---------- 2ª etapa obrigatória no servidor para quem ativou o 2FA ----------
create or replace function public.aal_ok() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified');
$$;
revoke all on function public.aal_ok() from public, anon;
grant execute on function public.aal_ok() to authenticated;

-- ---------- regras de acesso (cada conta só enxerga as próprias linhas) ----------
drop policy if exists vaults_select  on public.vaults;
drop policy if exists vaults_update  on public.vaults;
drop policy if exists records_select on public.records;
create policy vaults_select  on public.vaults  for select to authenticated using (user_id = (select auth.uid()) and public.aal_ok());
create policy vaults_update  on public.vaults  for update to authenticated using (user_id = (select auth.uid()) and public.aal_ok()) with check (user_id = (select auth.uid()));
create policy records_select on public.records for select to authenticated using (user_id = (select auth.uid()) and public.aal_ok());

-- ---------- criação de conta: confere o convite e cria o cofre ----------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare inv text; m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
begin
  select value into inv from public.app_config where key = 'invite';
  if inv is null or inv = '' or coalesce(m ->> 'invite', '') <> inv then raise exception 'invalid_invite'; end if;
  if coalesce(m ->> 'wrap_pw', '') = '' or coalesce(m ->> 'wrap_rec', '') = '' then raise exception 'bad_request'; end if;
  insert into public.vaults (user_id, wrap_pw, wrap_rec, kdf) values (new.id, m ->> 'wrap_pw', m ->> 'wrap_rec', coalesce(m -> 'kdf', '{}'::jsonb));
  update auth.users set raw_user_meta_data = '{}'::jsonb where id = new.id;
  return null;
end $$;
revoke all on function public.handle_new_user() from public, anon, authenticated;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- ---------- sincronização (única porta de escrita das fichas) ----------
create or replace function public.sync_records(p_since bigint, p_changes jsonb default '[]'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid(); c jsonb; ex_ts bigint; v_seq bigint; cnt bigint;
  accepted jsonb := '[]'::jsonb; stale jsonb := '[]'::jsonb;
  rid text; rts bigint; rdel boolean; rblob text;
  out_rows jsonb; n int; mx bigint; v_more boolean;
begin
  if uid is null then raise exception 'unauthorized'; end if;
  if not public.aal_ok() then raise exception 'mfa_required'; end if;
  if p_since is null or p_since < 0 then p_since := 0; end if;
  if p_changes is null then p_changes := '[]'::jsonb; end if;
  if jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) > 100 then raise exception 'bad_request'; end if;

  select seq into v_seq from public.vaults where user_id = uid for update;
  if v_seq is null then raise exception 'no_vault'; end if;
  select count(*) into cnt from public.records where user_id = uid;

  for c in select value from jsonb_array_elements(p_changes) loop
    rid := c ->> 'id'; rts := (c ->> 'ts')::bigint; rdel := coalesce((c ->> 'deleted')::boolean, false); rblob := coalesce(c ->> 'blob', '');
    if rid is null or rid !~ '^[A-Za-z0-9_-]{1,64}$' or rts is null or rts < 0
       or rts > (extract(epoch from now()) * 1000)::bigint + 86400000 then raise exception 'bad_request'; end if;
    if not rdel and rblob !~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' then raise exception 'bad_request'; end if;
    if length(rblob) > 2000000 then raise exception 'too_large'; end if;
    select ts into ex_ts from public.records where user_id = uid and id = rid;
    if found and ex_ts > rts then stale := stale || to_jsonb(rid); continue; end if;
    if not found then
      if cnt >= 50000 then raise exception 'quota_exceeded'; end if;
      cnt := cnt + 1;
    end if;
    v_seq := v_seq + 1;
    insert into public.records (user_id, id, blob, deleted, ts, seq)
      values (uid, rid, case when rdel then '' else rblob end, rdel, rts, v_seq)
      on conflict (user_id, id) do update set blob = excluded.blob, deleted = excluded.deleted, ts = excluded.ts, seq = excluded.seq;
    accepted := accepted || to_jsonb(rid);
  end loop;
  update public.vaults set seq = v_seq where user_id = uid;

  with t as (select r.id, r.blob, r.deleted, r.ts, r.seq from public.records r where r.user_id = uid and r.seq > p_since order by r.seq limit 500)
  select coalesce(jsonb_agg(to_jsonb(t) order by t.seq), '[]'::jsonb), count(*), max(t.seq) into out_rows, n, mx from t;
  v_more := n = 500;
  return jsonb_build_object('records', out_rows, 'next', case when v_more then mx else v_seq end, 'more', v_more, 'accepted', accepted, 'stale', stale);
end $$;
revoke all on function public.sync_records(bigint, jsonb) from public, anon;
grant execute on function public.sync_records(bigint, jsonb) to authenticated;

-- ---------- excluir a própria conta (direito ao apagamento) ----------
create or replace function public.delete_my_account() returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'unauthorized'; end if;
  if not public.aal_ok() then raise exception 'mfa_required'; end if;
  delete from auth.users where id = auth.uid();   -- apaga em cascata cofre e fichas
end $$;
revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;

-- ---------- CÓDIGO DE CONVITE: troque pelo seu e rode esta linha UMA vez ----------
-- insert into public.app_config (key, value) values ('invite', 'TROQUE-POR-UM-CODIGO-LONGO') on conflict (key) do update set value = excluded.value;
-- Depois de criar a conta da cliente, feche o cadastro:   delete from public.app_config where key = 'invite';
