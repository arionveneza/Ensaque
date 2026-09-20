-- ============================================================
-- Agendamento de VENDA MULTIPLICADOR — Expedição (20/09/2026)
-- Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- Pedido do Arion: no cartão "Por tipo de venda" da Expedição, além de
-- VENDA COOPERADO (já existe, coluna `cooperado`), separar também VENDA
-- MULTIPLICADOR. Mesmo desenho — coluna própria, mesma regra por "inclui"
-- na coluna TIPO VENDA do relatório de agendados.
--
-- Sem view envolvida aqui (ao contrário de v_balanco_demanda): a tela lê a
-- tabela `agendamentos` direto (`listarAgendamentos`), então é só ALTER
-- TABLE — nenhum "create or replace view" pra repetir security_invoker.
-- ============================================================

set search_path = tsi, public;

alter table agendamentos add column if not exists multiplicador boolean not null default false;

comment on column agendamentos.multiplicador is
  'Coluna TIPO VENDA = VENDA MULTIPLICADOR no relatório de agendados. Mesmo desenho do `cooperado`.';

-- ------------------------------------------------------------
-- Conferência
-- ------------------------------------------------------------
select 'coluna multiplicador em agendamentos' as item, (count(*) = 1)::text as ok
  from information_schema.columns
 where table_schema = 'tsi' and table_name = 'agendamentos' and column_name = 'multiplicador';
