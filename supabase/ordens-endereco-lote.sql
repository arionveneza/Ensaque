-- ============================================================
-- Endereço do lote na ordem de produção
-- Execute no SQL Editor do Supabase
-- ============================================================
--
-- Por que o endereço fica na ORDEM e não no lote: no relatório de Saldos da
-- SimpleAgro o mesmo lote aparece em vários endereços — o conversor de saldos
-- inclusive soma os bags do mesmo lote espalhado em endereços diferentes.
-- Logo, "onde está o lote" não é um valor único; "de onde buscar para esta
-- ordem" é uma decisão por ordem.
--
-- Três campos separados, como a operação fala: armazém, bloco e quadra.
-- Guardar concatenado impediria filtrar por armazém depois.
--
-- Todos opcionais: ordem replicada de outro sistema pode não trazer endereço,
-- e a logística preenche na hora de separar.
--
-- A view v_ordens usa `o.*`, então já expõe as colunas novas sem recriar nada.
-- ============================================================

set search_path = tsi, public;

alter table ordens
  add column if not exists armazem text,
  add column if not exists bloco   text,
  add column if not exists quadra  text;

comment on column ordens.armazem is 'Ex.: ARMAZEM C. Onde buscar o lote para esta ordem.';
comment on column ordens.bloco   is 'Ex.: BL01.';
comment on column ordens.quadra  is 'Ex.: QD04.';

-- a logística separa por armazém: o índice serve a esse agrupamento
create index if not exists idx_ordens_armazem on ordens (armazem)
  where armazem is not null;

select column_name, data_type
from information_schema.columns
where table_schema = 'tsi' and table_name = 'ordens'
  and column_name in ('armazem', 'bloco', 'quadra')
order by column_name;
