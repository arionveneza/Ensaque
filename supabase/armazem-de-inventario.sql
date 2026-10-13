-- ============================================================
-- "Armazém de inventário" (13/10/2026, pedido do Arion: "preciso de um
-- armazém de inventário, por exemplo, criar o armazém A inventário, B
-- inventário etc. Depois de inventariado, vamos substituir o armazém A pelo
-- armazém A inventário"). Inverte o que inventario-por-armazem.sql fez uma
-- hora antes: o inventário de um armazém NÃO alimenta o mapa enquanto conta
-- — a contagem fica guardada nele (é o "armazém A inventário", que o Mapa
-- mostra numa grade própria) e só entra no mapa quando o PCP manda
-- SUBSTITUIR o armazém real por ele.
--
-- 1. CHECK vira "armazém ⇒ NÃO alimenta o mapa" (o único inventário de
--    armazém existente, criado às 14:00 sem contagem, é virado aqui).
-- 2. substituir_armazem_pelo_inventario(p_id): com o inventário FECHADO —
--    tira do mapa tudo que estava no armazém (mesma régua do
--    esvaziar_armazem_mapa: lote só de lá zera, o que está em outro armazém
--    fica) e põe a contagem lançamento a lançamento pela MESMA função do
--    inventário que alimenta o mapa (inventario_mapa_poe, no ramo "1ª
--    contagem de um armazém": endereços só deste armazém, saldo = fora +
--    contado; lote fora da lista nasce no mapa; descarte marca). Rastro em
--    mapa_ajustes com o delta LÍQUIDO por combinação. Repetível: reabrir,
--    corrigir, fechar e substituir de novo refaz o armazém inteiro
--    (inventario_mapa_assumido é zerado antes).
-- 3. aplicar_inventario_no_mapa recusa inventário de armazém (base: a
--    definição viva, pg_get_functiondef).
-- ============================================================

set search_path = tsi, public;

-- ---------- 1. inventário de armazém não alimenta o mapa ----------
-- o CHECK antigo (armazém ⇒ alimenta) barraria o update: cai antes
alter table inventarios drop constraint if exists inventarios_armazem_alimenta;

do $$
begin
  perform set_config('tsi.rpc_inventario', '1', true);
  if exists (select 1 from inventarios i where i.armazem is not null and i.alimenta_mapa
              and exists (select 1 from inventario_itens t where t.inventario_id = i.id)) then
    raise exception 'há inventário de armazém com contagem já lançada no mapa — resolver à mão antes';
  end if;
  update inventarios set alimenta_mapa = false where armazem is not null and alimenta_mapa;
end $$;

alter table inventarios add constraint inventarios_armazem_alimenta
  check (armazem is null or not alimenta_mapa);

comment on column inventarios.armazem is
  'Inventário de UM armazém = "armazém X inventário" (13/10/2026): a lista vem do mapa daquele armazém, a contagem fica guardada aqui (não alimenta o mapa) e entra no mapa só pelo substituir_armazem_pelo_inventario. Nulo = galpão inteiro.';

-- ---------- 2. substituir o armazém real pelo inventário ----------
create or replace function tsi.substituir_armazem_pelo_inventario(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_inv inventarios%rowtype;
  v_arm text;
  r record;
  i inventario_itens%rowtype;
  v_novo numeric;
  v_aqui numeric;
  v_fora numeric;
  v_fora_desconhecido boolean;
  v_enderecos_fora integer;
  v_retiradas integer := 0;
  v_contadas integer := 0;
  v_criadas integer := 0;
  v_bags_antes numeric;
  v_bags_depois numeric;
  v_motivo text;
begin
  if not tem_acao('inventario','abrir') or not tem_acao('mapa','ajustar') then
    raise exception 'Perfil sem permissão para substituir o armazém pelo inventário';
  end if;
  perform set_config('tsi.rpc_inventario', '1', true);

  select * into v_inv from inventarios where id = p_id for update;
  if not found then
    raise exception 'inventário não encontrado';
  end if;
  if v_inv.armazem is null then
    raise exception 'este inventário é do galpão inteiro — use "Aplicar no mapa"';
  end if;
  if v_inv.fechado_em is null then
    raise exception 'feche o inventário antes de substituir o armazém — a contagem precisa estar pronta';
  end if;
  if v_inv.alimenta_mapa then
    raise exception 'este inventário já lança cada contagem no mapa — não há o que substituir';
  end if;
  v_arm := v_inv.armazem;
  v_motivo := 'Armazém ' || v_arm || ' substituído pelo inventário "' || v_inv.titulo || '"';

  -- foto do antes: toda combinação com endereço no armazém ou contada aqui
  drop table if exists tmp_antes;
  create temp table tmp_antes (lote text, tratamento text, saldo numeric) on commit drop;
  insert into tmp_antes
  select m.lote, m.tratamento, m.bags from lotes_mapa m
   where exists (select 1 from lote_enderecos e
                  where e.lote = m.lote and e.tratamento = m.tratamento and e.armazem = v_arm)
      or exists (select 1 from inventario_itens t
                  where t.inventario_id = p_id
                    and regexp_replace(upper(btrim(t.lote)), '(-\d+)+$', '') = m.lote
                    and upper(btrim(t.tratamento)) = m.tratamento);
  select coalesce(sum(e.bags), 0) into v_bags_antes from lote_enderecos e where e.armazem = v_arm;

  -- a) o armazém real sai do mapa (mesma régua do esvaziar_armazem_mapa)
  for r in
    select m.lote, m.tratamento, m.bags as saldo
      from lotes_mapa m
     where exists (select 1 from lote_enderecos x
                    where x.lote = m.lote and x.tratamento = m.tratamento and x.armazem = v_arm)
     for update of m
  loop
    select sum(e.bags) filter (where e.armazem = v_arm),
           sum(e.bags) filter (where e.armazem <> v_arm),
           coalesce(bool_or(e.bags is null) filter (where e.armazem <> v_arm), false),
           count(*) filter (where e.armazem <> v_arm)
      into v_aqui, v_fora, v_fora_desconhecido, v_enderecos_fora
      from lote_enderecos e
     where e.lote = r.lote and e.tratamento = r.tratamento;
    v_novo := case when v_enderecos_fora = 0 then 0
                   when not v_fora_desconhecido then coalesce(v_fora, 0)
                   else greatest(r.saldo - coalesce(v_aqui, 0), 0) end;
    delete from lote_enderecos where lote = r.lote and tratamento = r.tratamento and armazem = v_arm;
    update lotes_mapa
       set bags = v_novo,
           nao_encontrado_inventario_em = case when v_novo <= 0 then null else nao_encontrado_inventario_em end,
           atualizado_em = now()
     where lote = r.lote and tratamento = r.tratamento;
    v_retiradas := v_retiradas + 1;
  end loop;

  -- b) a contagem entra, lançamento a lançamento — cada combinação volta a
  --    ser "1ª contagem" (substituir de novo refaz o armazém inteiro)
  delete from inventario_mapa_assumido where inventario_id = p_id;
  for i in select * from inventario_itens where inventario_id = p_id order by criado_em, id loop
    perform inventario_mapa_poe(i);
  end loop;
  select count(*) into v_contadas from (
    select 1 from inventario_itens t where t.inventario_id = p_id and t.bags > 0
     group by regexp_replace(upper(btrim(t.lote)), '(-\d+)+$', ''), upper(btrim(t.tratamento))) c;

  -- c) rastro: o delta líquido por combinação que mudou
  for r in
    select a.lote, a.tratamento, a.saldo as antes, m.bags as depois
      from tmp_antes a join lotes_mapa m on m.lote = a.lote and m.tratamento = a.tratamento
     where m.bags <> a.saldo
  loop
    insert into mapa_ajustes (lote, tratamento, delta, motivo, armazem, saldo_depois)
    values (r.lote, r.tratamento, r.depois - r.antes, v_motivo, v_arm, r.depois);
  end loop;
  -- combinação que NASCEU no mapa pela contagem (fora da lista)
  for r in
    select m.lote, m.tratamento, m.bags
      from lotes_mapa m
     where not exists (select 1 from tmp_antes a where a.lote = m.lote and a.tratamento = m.tratamento)
       and exists (select 1 from inventario_itens t
                    where t.inventario_id = p_id
                      and regexp_replace(upper(btrim(t.lote)), '(-\d+)+$', '') = m.lote
                      and upper(btrim(t.tratamento)) = m.tratamento)
  loop
    insert into mapa_ajustes (lote, tratamento, delta, motivo, armazem, saldo_depois)
    values (r.lote, r.tratamento, r.bags, v_motivo || ' (lote novo no mapa)', v_arm, r.bags);
    v_criadas := v_criadas + 1;
  end loop;

  select coalesce(sum(e.bags), 0) into v_bags_depois from lote_enderecos e where e.armazem = v_arm;

  update inventarios set aplicado_em = now(), aplicado_por = auth.uid() where id = p_id;

  return jsonb_build_object(
    'retiradas', v_retiradas, 'contadas', v_contadas, 'criadas', v_criadas,
    'bags_antes', v_bags_antes, 'bags_depois', v_bags_depois);
end $$;

revoke execute on function tsi.substituir_armazem_pelo_inventario(uuid) from public, anon;
grant execute on function tsi.substituir_armazem_pelo_inventario(uuid) to authenticated, service_role;

-- ---------- 3. aplicar (só endereços) não serve ao inventário de armazém ----------
CREATE OR REPLACE FUNCTION tsi.aplicar_inventario_no_mapa(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tsi', 'public'
AS $function$
declare
  v_enderecados integer := 0;
  v_nao integer := 0;
  v_sem_mapa text[] := '{}';
  r record;
begin
  if not tem_acao('inventario','abrir') then
    raise exception 'Perfil sem permissão para aplicar inventário no mapa';
  end if;
  perform set_config('tsi.rpc_inventario', '1', true);

  if exists (select 1 from inventarios where id = p_id and alimenta_mapa) then
    raise exception 'este inventário já lança cada contagem no mapa — não há o que aplicar';
  end if;
  if exists (select 1 from inventarios where id = p_id and armazem is not null) then
    raise exception 'inventário de um armazém: use "Substituir o armazém pelo inventário"';
  end if;

  -- lock: dois cliques não aplicam duas vezes
  perform 1 from inventarios
    where id = p_id and fechado_em is not null and aplicado_em is null
    for update;
  if not found then
    raise exception 'inventário não encontrado, ainda aberto, ou já aplicado';
  end if;

  for r in
    select lote, tratamento
      from inventario_resultados
     where inventario_id = p_id and bags_contados is not null
     group by lote, tratamento
  loop
    if exists (select 1 from lotes_mapa where lote = r.lote and tratamento = r.tratamento) then
      delete from lote_enderecos where lote = r.lote and tratamento = r.tratamento;
      insert into lote_enderecos (lote, tratamento, armazem, bloco, quadra, bags, criado_por)
      select r.lote, r.tratamento, a, b, q, sum(bg), auth.uid()
        from (select upper(btrim(i.armazem)) a,
                     coalesce(numero_endereco(i.bloco, 44), upper(btrim(i.bloco))) b,
                     coalesce(numero_endereco(i.quadra, 20), upper(btrim(i.quadra))) q,
                     i.bags bg
                from inventario_itens i
               where i.inventario_id = p_id
                 and upper(btrim(regexp_replace(i.lote, '(-\d+)+$', ''))) = r.lote
                 and upper(btrim(i.tratamento)) = r.tratamento
                 and coalesce(btrim(i.armazem), '') <> '') x
       group by a, b, q
      having sum(bg) > 0;

      update lotes_mapa set nao_encontrado_inventario_em = null
       where lote = r.lote and tratamento = r.tratamento;
      v_enderecados := v_enderecados + 1;
    else
      v_sem_mapa := v_sem_mapa || (r.lote || ' · ' || r.tratamento);
    end if;
  end loop;

  update lotes_mapa lm
     set nao_encontrado_inventario_em = now()
   where exists (
     select 1 from inventario_resultados ir
      where ir.inventario_id = p_id
        and ir.bags_contados is null
        and ir.lote = lm.lote and ir.tratamento = lm.tratamento
   );
  get diagnostics v_nao = row_count;

  update inventarios set aplicado_em = now(), aplicado_por = auth.uid()
   where id = p_id;

  return jsonb_build_object(
    'enderecados', v_enderecados,
    'nao_encontrados', v_nao,
    'sem_mapa', to_jsonb(v_sem_mapa)
  );
end $function$;

-- Conferência
select json_build_object(
  'check_invertido', (select pg_get_constraintdef(oid) from pg_constraint where conname = 'inventarios_armazem_alimenta'),
  'inventarios_armazem', (select json_agg(json_build_object('titulo', titulo, 'armazem', armazem, 'alimenta', alimenta_mapa)) from tsi.inventarios where armazem is not null),
  'funcao', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'tsi' and p.proname = 'substituir_armazem_pelo_inventario'),
  'aplicar_recusa', (select position('Substituir o armazém' in pg_get_functiondef('tsi.aplicar_inventario_no_mapa(uuid)'::regprocedure)) > 0),
  'grants', (select json_agg(grantee::text) from information_schema.routine_privileges
              where routine_schema = 'tsi' and routine_name = 'substituir_armazem_pelo_inventario')
) as conferencia;

-- ---------- 4. reabrir: inventário aplicado/substituído volta pra correção ----------
-- Achado nesta rodada: a inventario-reabrir-aplicado.sql (10/09/2026) NUNCA chegou
-- ao banco — a definição viva ainda recusava inventário aplicado ("registro
-- definitivo — não reabre"), enquanto o front já mostrava "Reabrir pra corrigir".
-- Sem isso o "reabrir, corrigir, fechar e substituir de novo" do armazém de
-- inventário não existiria. É a MESMA função daquele arquivo, pro galpão e pro
-- armazém: apaga a conferência congelada e limpa aplicado_em/por.
create or replace function tsi.reabrir_inventario(p_id uuid) returns void
language plpgsql security definer set search_path = tsi, public as $$
begin
  if not tem_acao('inventario','abrir') then
    raise exception 'Perfil sem permissão para reabrir inventário';
  end if;
  perform set_config('tsi.rpc_inventario', '1', true);

  perform 1 from inventarios where id = p_id and fechado_em is not null for update;
  if not found then
    raise exception 'inventário não encontrado ou não está fechado';
  end if;
  delete from inventario_resultados where inventario_id = p_id;
  update inventarios
     set fechado_em = null, fechado_por = null,
         aplicado_em = null, aplicado_por = null
   where id = p_id;
end $$;

select json_build_object(
  'reabrir_limpa_aplicado',
  (select position('aplicado_em = null' in pg_get_functiondef('tsi.reabrir_inventario(uuid)'::regprocedure)) > 0)
) as conferencia_reabrir;
