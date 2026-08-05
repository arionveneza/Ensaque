-- ============================================================
-- Coluna TRATAMENTO no lote de semente
-- Execute no SQL Editor do Supabase
-- ============================================================
--
-- O relatório de Saldos da SimpleAgro tem a coluna LOTE TRATAMENTO. Até agora
-- o importador usava esse valor apenas para decidir o destino da linha
-- (`SEM TSI` virava lote de semente, tratamento real virava estoque PA) e
-- descartava o texto. Agora o valor é guardado.
-- ============================================================

set search_path = tsi, public;

alter table lotes_semente
  add column if not exists tratamento text;

comment on column lotes_semente.tratamento is
  'Tratamento do lote como veio da origem. SEM TSI = semente crua, ainda a tratar.';

-- lotes já importados vieram todos da faixa SEM TSI do relatório
update lotes_semente set tratamento = 'SEM TSI' where tratamento is null;

select tratamento, count(*) from lotes_semente group by tratamento order by 1;
