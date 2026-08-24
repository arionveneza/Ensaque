-- ============================================================
-- Peneira e Categoria no lote de semente — 25/08/2026
-- Execute no SQL Editor do Supabase (idempotente)
-- RODAR ANTES do deploy do front desta feature: o SELECT das ordens passa
-- a pedir as colunas novas — com o banco antigo, a Execução inteira cai.
-- ============================================================
--
-- A etiqueta DM (pedido do Arion, 25/08/2026 — réplica da aba ETQ. DM da
-- planilha DM 2025) imprime PENEIRA e CATEGORIA do lote, que o app não
-- guardava. O export de saldo do SAP já traz as colunas "Peneira" e
-- "Categoria do Lote": a importação passa a gravá-las aqui. Lote vindo da
-- SimpleAgro (que não tem essas colunas) fica com null — a etiqueta
-- imprime "—" até o lote ser reimportado pelo SAP.
-- ============================================================

set search_path = tsi, public;

alter table lotes_semente add column if not exists peneira text;
alter table lotes_semente add column if not exists categoria text;

comment on column lotes_semente.peneira is
  'Coluna "Peneira" do export de saldo do SAP (ex.: "P 6.75 mm"). Null em lote da SimpleAgro. Sai na etiqueta DM.';
comment on column lotes_semente.categoria is
  'Coluna "Categoria do Lote" do export de saldo do SAP (ex.: "S2"). Null em lote da SimpleAgro. Sai na etiqueta DM.';

-- ------------------------------------------------------------
-- Conferência
-- ------------------------------------------------------------
select 'colunas peneira e categoria' as item, (count(*) = 2)::text as ok
  from information_schema.columns
 where table_schema = 'tsi' and table_name = 'lotes_semente'
   and column_name in ('peneira', 'categoria');
