-- ============================================================
-- Marca "não encontrado": combinação CONTADA em outra embalagem é achada
-- 10/09/2026 — Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- Achado do cruzamento 33 × 20 (10/09/2026): a PRÉVIA do front
-- (planoAplicacao) trata combinação contada em QUALQUER embalagem como
-- achada — não marca "não encontrado" —, mas a RPC marcava quando havia
-- linha não contada em OUTRA embalagem da mesma combinação. Espelho
-- corrigido aqui (mudou um, mude o outro) + limpeza one-shot das marcas
-- já gravadas nesse caso pelo inventário aplicado mais recente.
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 1. RPC recriada (cópia fiel de inventario-mapa-ajuste-reserva.sql, com
--    UMA mudança: o NOT EXISTS no update das não contadas). CREATE OR
--    REPLACE preserva os grants/revokes existentes.
-- ------------------------------------------------------------
create or replace function aplicar_inventario_no_mapa(p_id uuid) returns jsonb
language plpgsql security definer set search_path = tsi, public as $$
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

  -- lock: dois cliques não aplicam duas vezes
  perform 1 from inventarios
    where id = p_id and fechado_em is not null and aplicado_em is null
    for update;
  if not found then
    raise exception 'inventário não encontrado, ainda aberto, ou já aplicado';
  end if;

  -- CONTADAS (bate/sobra/falta — bags_contados not null), por combinação
  -- do MAPA (lote + tratamento; a embalagem fica fora da chave):
  for r in
    select lote, tratamento
      from inventario_resultados
     where inventario_id = p_id and bags_contados is not null
     group by lote, tratamento
  loop
    if exists (select 1 from lotes_mapa where lote = r.lote and tratamento = r.tratamento) then
      -- endereços contados SUBSTITUEM os do mapa, com quantidade por
      -- endereço (o inventário sempre conta onde; soma lançamentos do
      -- mesmo lugar). Contagem 0 num lugar = nada ali: não vira endereço.
      delete from lote_enderecos where lote = r.lote and tratamento = r.tratamento;
      insert into lote_enderecos (lote, tratamento, armazem, bloco, quadra, bags, criado_por)
      select r.lote, r.tratamento,
             upper(btrim(i.armazem)), coalesce(upper(btrim(i.bloco)), ''),
             coalesce(upper(btrim(i.quadra)), ''), sum(i.bags), auth.uid()
        from inventario_itens i
       where i.inventario_id = p_id
         and upper(btrim(regexp_replace(i.lote, '(-\d+)+$', ''))) = r.lote
         and upper(btrim(i.tratamento)) = r.tratamento
         and coalesce(btrim(i.armazem), '') <> ''
       group by upper(btrim(i.armazem)), coalesce(upper(btrim(i.bloco)), ''),
                coalesce(upper(btrim(i.quadra)), '')
      having sum(i.bags) > 0;

      update lotes_mapa set nao_encontrado_inventario_em = null
       where lote = r.lote and tratamento = r.tratamento;
      v_enderecados := v_enderecados + 1;
    else
      -- contada mas sem linha no mapa (fora do SAP): o saldo é do SAP —
      -- não cria; resolve-se depois pelo Ajuste de estoque
      v_sem_mapa := v_sem_mapa || (r.lote || ' · ' || r.tratamento);
    end if;
  end loop;

  -- NÃO CONTADAS: só a marca — saldo e endereços intactos. Combinação
  -- contada em QUALQUER embalagem foi ACHADA fisicamente e não é marcada
  -- (espelho do planoAplicacao do front — correção de 10/09/2026)
  update lotes_mapa lm
     set nao_encontrado_inventario_em = now()
   where exists (
     select 1 from inventario_resultados ir
      where ir.inventario_id = p_id
        and ir.bags_contados is null
        and ir.lote = lm.lote and ir.tratamento = lm.tratamento
   )
     and not exists (
     select 1 from inventario_resultados ir2
      where ir2.inventario_id = p_id
        and ir2.bags_contados is not null
        and ir2.lote = lm.lote and ir2.tratamento = lm.tratamento
   );
  get diagnostics v_nao = row_count;

  update inventarios set aplicado_em = now(), aplicado_por = auth.uid()
   where id = p_id;

  return jsonb_build_object(
    'enderecados', v_enderecados,
    'nao_encontrados', v_nao,
    'sem_mapa', to_jsonb(v_sem_mapa)
  );
end $$;

-- ------------------------------------------------------------
-- 2. Limpeza one-shot: marcas já gravadas pelo inventário aplicado mais
--    recente em combinações que TÊM linha contada nele (re-execução não
--    acha mais nada e não faz nada)
-- ------------------------------------------------------------
update lotes_mapa lm
   set nao_encontrado_inventario_em = null
  from (
    select id from inventarios
     where aplicado_em is not null
     order by aplicado_em desc
     limit 1
  ) ult
 where lm.nao_encontrado_inventario_em is not null
   and exists (
     select 1 from inventario_resultados ir
      where ir.inventario_id = ult.id
        and ir.bags_contados is not null
        and ir.lote = lm.lote and ir.tratamento = lm.tratamento
   );

-- ============================================================
-- Conferência
-- ============================================================
-- select 'rpc com exclusao', position('ACHADA fisicamente' in prosrc) > 0
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname='tsi' and p.proname='aplicar_inventario_no_mapa';
-- select count(*) from lotes_mapa where nao_encontrado_inventario_em is not null;
--   -- deve cair das ~20 pra ~17 (as contadas em outra embalagem saem)
