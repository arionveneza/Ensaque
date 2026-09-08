-- ============================================================
-- Marca "não encontrado": achada SÓ batendo lote+tratamento+EMBALAGEM
-- 10/09/2026 — Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- Decisão do Arion (10/09/2026), revertendo o patch
-- inventario-marca-contada-fix.sql do mesmo dia: contada em OUTRA
-- embalagem NÃO conta como achada — bag de BB5M não prova que o MEIOBAG
-- existe. Qualquer linha não contada da combinação marca o lote no mapa.
-- O front (planoAplicacao) muda junto — mudou um, mude o outro.
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 1. RPC recriada (cópia fiel de inventario-mapa-ajuste-reserva.sql —
--    o update das não contadas volta a marcar SEM exceção de embalagem)
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
  -- do MAPA (lote + tratamento):
  for r in
    select lote, tratamento
      from inventario_resultados
     where inventario_id = p_id and bags_contados is not null
     group by lote, tratamento
  loop
    if exists (select 1 from lotes_mapa where lote = r.lote and tratamento = r.tratamento) then
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
      v_sem_mapa := v_sem_mapa || (r.lote || ' · ' || r.tratamento);
    end if;
  end loop;

  -- NÃO CONTADAS marcam SEMPRE (decisão de 10/09/2026): achada só é achada
  -- batendo lote+tratamento+EMBALAGEM — contada em outra embalagem não
  -- prova nada sobre esta. Roda DEPOIS do loop das contadas, então a marca
  -- vence a limpeza quando a combinação tem as duas situações.
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
end $$;

-- ------------------------------------------------------------
-- 2. One-shot: devolve a marca às combinações do último inventário
--    aplicado que têm linha NÃO contada (a limpeza do patch anterior
--    tirou; re-execução não muda nada — quem já tem marca fica com ela)
-- ------------------------------------------------------------
update lotes_mapa lm
   set nao_encontrado_inventario_em = coalesce(lm.nao_encontrado_inventario_em, now())
  from (
    select id from inventarios
     where aplicado_em is not null
     order by aplicado_em desc
     limit 1
  ) ult
 where lm.nao_encontrado_inventario_em is null
   and exists (
     select 1 from inventario_resultados ir
      where ir.inventario_id = ult.id
        and ir.bags_contados is null
        and ir.lote = lm.lote and ir.tratamento = lm.tratamento
   );

-- ============================================================
-- Conferência
-- ============================================================
-- select 'rpc marca sempre', position('marcam SEMPRE' in prosrc) > 0
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname='tsi' and p.proname='aplicar_inventario_no_mapa';
-- select count(*) from lotes_mapa where nao_encontrado_inventario_em is not null;
--   -- volta a ~20/21 (as contadas-em-outra-embalagem retornam à lista)
