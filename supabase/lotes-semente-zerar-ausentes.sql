-- ============================================================
-- Lote que some da planilha do SAP/SimpleAgro é ZERADO — 11/09/2026
-- Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- Achado do Arion: a importação de Saldos (relatório da SimpleAgro OU
-- o substituto do SAP) era um upsert por número de lote — atualizava
-- quem vinha na planilha nova, mas NUNCA zerava nem removia quem
-- sumia dela. Caso real: lote 262013 (44 bags) foi reentrado/desdo-
-- brado no SAP como 262013-1 (mesmo saldo, mesma cultivar) — o SAP
-- parou de listar o 262013, mas o app continuava mostrando ele com 44
-- bags disponíveis, como se o saldo existisse duas vezes.
--
-- Fix: a importação vira uma RPC transacional (`importar_lotes_semente`)
-- que faz upsert de quem veio na planilha E zera `bags_disp` de quem
-- não veio — mesmo espírito da substituição total do Mapa, mas SEM
-- apagar a linha (ordens e movimentos têm FK pro id do lote; zerar é
-- seguro, apagar não). NÃO mexe em status/baixado_em/baixado_por/
-- devolver — a baixa continua controlando isso, o upload só corrige o
-- saldo mostrado. Lote de origem MANUAL (Cadastros ▸ criar lote, fora
-- do SAP — compra de terceiro etc.) tem a coluna `origem_manual` e
-- nunca é zerado por esta rotina.
-- ============================================================

set search_path = tsi, public;

alter table lotes_semente add column if not exists origem_manual boolean not null default false;

comment on column lotes_semente.origem_manual is
  'Lote cadastrado manualmente (Cadastros ▸ criar lote), fora do upload de Saldos — nunca zerado quando some de uma planilha nova (11/09/2026).';

create or replace function importar_lotes_semente(p_lotes jsonb)
returns jsonb
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_ids text[];
  v_importados integer;
  v_zerados integer;
begin
  -- mesma regra das policies de INSERT/UPDATE de lotes_semente
  if not (tem_acao('ordens','criar') or tem_acao('cadastros','editar')) then
    raise exception 'Perfil sem permissão para importar lotes';
  end if;
  if p_lotes is null or jsonb_array_length(p_lotes) = 0 then
    raise exception 'planilha sem lote nenhum — nada foi importado (evita zerar tudo por engano)';
  end if;

  insert into lotes_semente
    (id, cultivar, tratamento, pms, peso_bag_kg, bags_disp, peneira, categoria, atualizado_em)
  select
    x.id, x.cultivar, x.tratamento, x.pms, x.peso_bag_kg, x.bags_disp, x.peneira, x.categoria, now()
    from jsonb_to_recordset(p_lotes) as x(
      id text, cultivar text, tratamento text, pms numeric,
      peso_bag_kg numeric, bags_disp numeric, peneira text, categoria text
    )
  on conflict (id) do update
     set cultivar      = excluded.cultivar,
         tratamento    = excluded.tratamento,
         pms           = excluded.pms,
         peso_bag_kg   = excluded.peso_bag_kg,
         bags_disp     = excluded.bags_disp,
         peneira       = excluded.peneira,
         categoria     = excluded.categoria,
         atualizado_em = now();
  get diagnostics v_importados = row_count;

  select array_agg(x.id) into v_ids
    from jsonb_to_recordset(p_lotes) as x(id text);

  -- sumiu da planilha nova: zera o saldo mostrado (preserva a linha,
  -- status e histórico); lote manual nunca é tocado aqui
  update lotes_semente
     set bags_disp = 0, atualizado_em = now()
   where origem_manual = false
     and coalesce(bags_disp, 0) <> 0
     and not (id = any(v_ids));
  get diagnostics v_zerados = row_count;

  return jsonb_build_object('importados', v_importados, 'zerados', v_zerados);
end $$;

revoke execute on function importar_lotes_semente(jsonb) from public, anon;
grant execute on function importar_lotes_semente(jsonb) to authenticated, service_role;

-- ============================================================
-- Fix imediato do caso relatado (261013 → 262013-1) — os dois já
-- foram conferidos: 262013 sem ordem/movimento vinculado, seguro zerar
-- ============================================================
update lotes_semente
   set bags_disp = 0
 where id = '262013' and bags_disp = 44;

-- ============================================================
-- Conferência
-- ============================================================
-- select column_name from information_schema.columns
--  where table_schema='tsi' and table_name='lotes_semente'
--    and column_name='origem_manual';  -- 1
-- select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--  where n.nspname='tsi' and proname='importar_lotes_semente';  -- 1
-- select id, bags_disp from lotes_semente where id in ('262013','262013-1');
--   -- 262013 com 0, 262013-1 com 44
