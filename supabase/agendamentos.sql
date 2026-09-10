-- ============================================================
-- Pedidos agendados (Expedição) — 12/09/2026
-- Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- A Expedição deixa de importar a "montagem de carga" e passa a importar o
-- relatório "pedidos agendados" da SimpleAgro: cada linha é um item de
-- pedido com QTD AGENDADA (a que vale — pode ser menor que o pedido), DATA
-- AGENDADA e TIPO VENDA. A tela cruza com o estoque do SAP (lotes de
-- semente pra branca, estoque PA pro tratado — o upload da aba Ordens) e com
-- a produção aberta, caminhão a caminhão, e separa VENDA COOPERADO × OUTRAS.
--
-- Substituição total a cada upload: o arquivo é a foto do dia. A tabela
-- `carregamentos` (montagem de carga) fica como histórico — não é apagada.
-- ============================================================

set search_path = tsi, public;

create table if not exists agendamentos (
  id              uuid primary key default gen_random_uuid(),
  identificador   text not null,            -- coluna A do relatório; único lá, mas não é PK (repetição não trava upload)
  pedido          text,                     -- NUMERO — repete por item do pedido
  tipo_venda      text not null default '', -- VENDA PRODUCAO / DISTRIBUIDOR / COOPERADO / BONIFICAÇÃO...
  cooperado       boolean not null default false,
  cliente         text,
  cidade          text,
  estado          text,
  cultivar        text not null,
  categoria       text,
  tratamento      text not null,            -- 'SEM TSI' = semente branca
  embalagem       text not null,            -- já traduzida (BG5M/MEIOBAG); sem FK: código novo não pode travar o upload
  qtd_pedido      numeric(12,2) not null default 0,
  bags            numeric(12,2) not null,   -- QTD AGENDADA: a quantidade que vale
  status_entrega  text not null default 'Sem status',
  carga           text,
  status_carga    text,
  data            date,                     -- DATA AGENDADA; sem dia existe: marcado, não escondido
  observacao      text,
  importado_em    timestamptz not null default now(),
  importado_por   uuid references usuarios(id)
);
create index if not exists agendamentos_data on agendamentos (data);
create index if not exists agendamentos_produto on agendamentos (cultivar, tratamento, embalagem);

comment on table agendamentos is
  'Foto do relatório pedidos agendados da SimpleAgro. Substituição total a cada upload (12/09/2026).';

alter table agendamentos enable row level security;

drop policy if exists ler_agend on agendamentos;
create policy ler_agend on agendamentos for select using (meu_perfil() is not null);

-- upload: quem tem a ação importar da Expedição (PCP e Logística por padrão)
drop policy if exists grava_agend on agendamentos;
create policy grava_agend on agendamentos for all
  using (tem_acao('expedicao','importar'))
  with check (tem_acao('expedicao','importar'));

do $$ begin
  alter publication supabase_realtime add table agendamentos;
exception when others then null; end $$;

-- ------------------------------------------------------------
-- Conferência
-- ------------------------------------------------------------
select 'tabela agendamentos' as item, (count(*) = 1)::text as ok
  from information_schema.tables
 where table_schema = 'tsi' and table_name = 'agendamentos'
union all
select 'politicas da tabela', (count(*) = 2)::text
  from pg_policies where schemaname = 'tsi' and tablename = 'agendamentos';
