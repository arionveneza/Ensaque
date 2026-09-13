-- ============================================================
-- Filial do pedido de venda, para a Expedição — 13/09/2026
--
-- Pedido do Arion: "na tela de expedição preciso ver em qual filial foi
-- feito o pedido de venda, pois para pedidos de outra filial é necessário
-- solicitar a transferência de saldo em estoque". O relatório de agendados
-- tem coluna FILIAL, mas ela vem VAZIA (289 de 289 linhas em 10/09/2026);
-- a filial só existe no Pedidos Analítico Resumido (col. B Filial, col. D
-- Número Pedido), que já é importado na aba Ordens. O NUMERO dos agendados
-- casa com o Número Pedido em 289 de 289.
--
-- Tabela PRÓPRIA, fora de pedidos_venda, de propósito: pedidos_venda agrega
-- por cultivar+tratamento+embalagem pro balanço; pôr o número do pedido na
-- chave explodiria o balanço. Uma linha por pedido, por carga — a Expedição
-- lê a carga de pedidos mais recente (mesma regra da v_balanco_demanda).
-- ============================================================

set search_path = tsi, public;

create table if not exists pedidos_filial (
  carga_id      uuid not null references cargas_demanda(id) on delete cascade,
  numero_pedido text not null,
  filial        text,                 -- normalizada; nula = '0'/vazia no relatório
  primary key (carga_id, numero_pedido)
);

comment on table pedidos_filial is
  'Filial de cada pedido de venda (Pedidos Analítico, col. B), por carga. Cruza com agendamentos.pedido na Expedição (13/09/2026).';

alter table pedidos_filial enable row level security;

drop policy if exists ler_pedfil on pedidos_filial;
create policy ler_pedfil on pedidos_filial for select using (meu_perfil() is not null);

-- grava quem grava a carga de pedidos (mesma regra de pedidos_venda)
drop policy if exists pedfil_all on pedidos_filial;
create policy pedfil_all on pedidos_filial for all
  using (tem_acao('ordens','criar')) with check (tem_acao('ordens','criar'));

-- fonte secundária: a FILIAL do próprio relatório de agendados, se um dia vier preenchida
alter table agendamentos add column if not exists filial text;

-- ------------------------------------------------------------
-- Conferência
-- ------------------------------------------------------------
select 'tabela pedidos_filial' as item, (count(*) = 1)::text as ok
  from information_schema.tables
 where table_schema = 'tsi' and table_name = 'pedidos_filial'
union all
select 'politicas da tabela', (count(*) = 2)::text
  from pg_policies where schemaname = 'tsi' and tablename = 'pedidos_filial'
union all
select 'agendamentos.filial', (count(*) = 1)::text
  from information_schema.columns
 where table_schema = 'tsi' and table_name = 'agendamentos' and column_name = 'filial';
