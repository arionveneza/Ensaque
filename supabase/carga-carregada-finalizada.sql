-- ============================================================
-- Carga montada: ciclo Carregada → Finalizada — 29/08/2026
-- Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- Pedido do Arion (29/08/2026): depois de loteada, a carga é marcada
-- CARREGADA quando o caminhão sai — e aí ela SAI da conta de saldo dos
-- lotes (o próximo upload do SAP já desconta o que foi embora; sem isso a
-- carga antiga descontava em dobro). Depois, FINALIZADA encerra o ciclo.
-- Os dois marcos têm data e autor, e podem ser desfeitos (volta a null).
-- ============================================================

set search_path = tsi, public;

alter table cargas_montadas add column if not exists carregada_em  timestamptz;
alter table cargas_montadas add column if not exists carregada_por uuid references usuarios(id);
alter table cargas_montadas add column if not exists finalizada_em  timestamptz;
alter table cargas_montadas add column if not exists finalizada_por uuid references usuarios(id);

comment on column cargas_montadas.carregada_em is
  'Caminhão carregado/saiu — a carga deixa de descontar o saldo dos lotes no loteamento.';
comment on column cargas_montadas.finalizada_em is
  'Ciclo encerrado (depois de carregada). Registro histórico.';

-- ============================================================
-- Conferência
-- ============================================================
-- select column_name from information_schema.columns
--   where table_schema='tsi' and table_name='cargas_montadas'
--   and column_name like '%ada_%';  -- carregada_em/por, finalizada_em/por
