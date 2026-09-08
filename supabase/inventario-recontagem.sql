-- ============================================================
-- RECONTAGEM: corrigir o contado de uma linha do inventário — 10/09/2026
-- Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- Fluxo do Arion (10/09/2026): linha divergente (ex.: SV0091056560517
-- contado 52 × SAP 14) → conta-se DE NOVO no físico e grava-se o valor
-- recontado na própria linha da conferência, SEM reabrir o inventário:
-- - bateu: a divergência some (e a 1ª contagem fica no rastro);
-- - ainda diverge: fica gravado o recontado, com a marca "recontado" —
--   divergência confirmada por segunda contagem.
-- A 1ª contagem é preservada (bags_primeira_contagem); os lançamentos
-- originais não são tocados. Ação `contar` (quem conta, reconta).
-- ============================================================

set search_path = tsi, public;

alter table inventario_resultados add column if not exists recontado_em timestamptz;
alter table inventario_resultados add column if not exists recontado_por uuid;
alter table inventario_resultados add column if not exists bags_primeira_contagem numeric(12,2);

comment on column inventario_resultados.recontado_em is
  'Linha recontada no físico depois do fechamento (10/09/2026). bags_contados passa a ser o valor RECONTADO; a 1ª contagem fica em bags_primeira_contagem.';

create or replace function recontar_inventario(p_resultado uuid, p_bags numeric)
returns void
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_r inventario_resultados%rowtype;
begin
  if not tem_acao('inventario','contar') then
    raise exception 'Perfil sem permissão para recontar';
  end if;
  if p_bags is null or p_bags < 0 then
    raise exception 'informe a quantidade recontada (0 vale: recontei e está vazio)';
  end if;

  select * into v_r from inventario_resultados where id = p_resultado for update;
  if not found then
    raise exception 'linha da conferência não encontrada';
  end if;

  update inventario_resultados
     set bags_primeira_contagem = coalesce(bags_primeira_contagem, bags_contados),
         bags_contados = p_bags,
         recontado_em  = now(),
         recontado_por = auth.uid()
   where id = p_resultado;

  -- recontou e ACHOU alguma coisa: a combinação sai da lista de não
  -- encontrados do mapa (achada é achada)
  if p_bags > 0 then
    update lotes_mapa set nao_encontrado_inventario_em = null
     where lote = v_r.lote and tratamento = v_r.tratamento
       and nao_encontrado_inventario_em is not null;
  end if;
end $$;

-- o Supabase dá EXECUTE a PUBLIC em toda função nova — padrão do projeto
revoke execute on function recontar_inventario(uuid, numeric) from public, anon;
grant execute on function recontar_inventario(uuid, numeric) to authenticated, service_role;

-- ============================================================
-- Conferência
-- ============================================================
-- select column_name from information_schema.columns
--  where table_schema='tsi' and table_name='inventario_resultados'
--    and column_name in ('recontado_em','recontado_por','bags_primeira_contagem');  -- 3
-- select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--  where n.nspname='tsi' and proname='recontar_inventario';  -- 1
