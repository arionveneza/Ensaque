-- ============================================================
-- Carga montada: placa, cliente e tara — 28/08/2026
-- Execute no SQL Editor do Supabase (idempotente)
-- Pode rodar depois do deploy: o front tenta gravar com os campos novos
-- e cai sem eles enquanto a migração não roda (mesmo padrão do cooperado).
-- ============================================================
--
-- A ordem de carregamento impressa (pedido do Arion, 28/08/2026) leva
-- placa do veículo, cliente, e o peso: total da carga + campo de TARA +
-- somatório (tara + carga). Placa/cliente/tara entram no formulário da
-- montagem (opcionais) e saem na impressão — tara em branco na impressão
-- quando não informada, pra anotar na balança.
-- ============================================================

set search_path = tsi, public;

alter table cargas_montadas add column if not exists placa   text;
alter table cargas_montadas add column if not exists cliente text;
alter table cargas_montadas add column if not exists tara_kg numeric(12,2);

comment on column cargas_montadas.placa is 'Placa do veículo — sai na ordem de carregamento impressa.';
comment on column cargas_montadas.cliente is 'Cliente do carregamento — sai na impressão.';
comment on column cargas_montadas.tara_kg is 'Tara do veículo (kg), opcional — informada, a impressão soma tara + carga; em branco, sai campo pra anotar.';

-- ============================================================
-- Conferência
-- ============================================================
-- select column_name from information_schema.columns
--   where table_schema='tsi' and table_name='cargas_montadas';  -- placa, cliente, tara_kg presentes
