-- ============================================================
-- Desativação de lote de químico
-- Execute no SQL Editor do Supabase
-- ============================================================
--
-- Problema: `ordem_tanque_lotes` referencia `lotes_quimico`, então um lote já
-- apontado numa ordem NÃO pode ser excluído. Isso está correto — apagar
-- destruiria a rastreabilidade do tratamento, que é justamente o motivo de
-- registrar o lote de cada produto no tanque.
--
-- Mas faltava a alternativa: sem um campo de desativar, o lote velho ficava
-- para sempre na lista de escolha do operador, junto com os atuais.
--
-- `ativo = false` tira o lote das novas seleções sem apagar o histórico. O
-- lote continua existindo, as ordens antigas continuam apontando para ele, e
-- o operador não o vê mais ao iniciar uma ordem nova.
-- ============================================================

set search_path = tsi, public;

alter table lotes_quimico
  add column if not exists ativo boolean not null default true;

comment on column lotes_quimico.ativo is
  'false = fora das novas seleções. Não apaga: as ordens antigas precisam do lote para rastreabilidade.';

-- lote esgotado ou vencido normalmente não deve mais ser escolhido;
-- deixa a validade em dia como ativa e o resto por decisão de quem cadastra
create index if not exists idx_lotes_quimico_ativo
  on lotes_quimico (produto_id) where ativo;
