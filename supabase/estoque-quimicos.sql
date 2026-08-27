-- ============================================================
-- Estoque de químicos (upload do SAP na aba MRP) — 27/08/2026
-- Execute no SQL Editor do Supabase (idempotente)
-- RODAR ANTES de usar o upload na aba MRP: sem a tabela, a importação
-- falha com erro claro; o resto da aba segue funcionando sem ela.
-- ============================================================
--
-- Pedido do Arion (27/08/2026): subir o export de estoque de insumos do
-- SAP (Quimicos.xlsx — uma linha por lote, colunas achadas pelo nome) e
-- cruzar com a necessidade calculada no MRP, fechando "quanto falta
-- comprar". Só o armazém VEN_GER entra (estoque da UBS); a agregação por
-- item acontece na importação — aqui já chega uma linha por item do SAP.
--
-- Mesmo desenho de pedidos_venda/estoque_pa: foto por carga (substituição
-- total = carga nova; o histórico fica), e quem lê usa SÓ a carga vigente
-- — a lição do bug do estoque PA multiplicado (27/08/2026).
--
-- O casamento com o produto do app é por NOME, no front: o código do item
-- no SAP não bate com o cadastrado em vários produtos (INS00004 é RIZOLIQ
-- LLI lá e KELMAX aqui). O código fica gravado só pra conferência.
-- ============================================================

set search_path = tsi, public;

-- carga tipo novo: 'quimicos'
alter table cargas_demanda drop constraint if exists cargas_demanda_tipo_check;
alter table cargas_demanda add constraint cargas_demanda_tipo_check
  check (tipo in ('pedidos', 'estoque', 'quimicos'));

create table if not exists estoque_quimicos (
  id         uuid primary key default gen_random_uuid(),
  carga_id   uuid not null references cargas_demanda(id) on delete cascade,
  codigo_sap text not null,             -- "Nº do item" (informativo; casamento é por nome)
  nome       text not null,             -- "Descrição do Item"
  unidade    text not null,             -- "Embalagem": LT | KG | DOSES | CAIXA | UN
  quantidade numeric(14,2) not null,    -- soma de "Qtd em Estoque" dos lotes VEN_GER
  lotes      int not null default 1     -- quantos lotes somaram
);

comment on table estoque_quimicos is
  'Foto do estoque de insumos do SAP (armazém VEN_GER), agregada por item — upload na aba MRP. Quem lê usa só a carga vigente (última cargas_demanda tipo quimicos).';

alter table estoque_quimicos enable row level security;

drop policy if exists ler_est_qui on estoque_quimicos;
create policy ler_est_qui on estoque_quimicos for select using (meu_perfil() is not null);

drop policy if exists pcp_est_qui on estoque_quimicos;
create policy pcp_est_qui on estoque_quimicos for all
  using (meu_perfil() in ('PCP','Gestor')) with check (meu_perfil() in ('PCP','Gestor'));

-- ============================================================
-- Conferência
-- ============================================================
-- select conname, pg_get_constraintdef(oid) from pg_constraint
--   where conname = 'cargas_demanda_tipo_check';           -- deve listar 'quimicos'
-- select count(*) from estoque_quimicos;                    -- 0 até a primeira carga
