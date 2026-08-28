-- ============================================================
-- Mapa e Montagem de Carga — 28/08/2026
-- Execute no SQL Editor do Supabase (idempotente)
-- RODAR ANTES de usar a aba Mapa: sem as tabelas, a tela avisa e o
-- upload falha com erro claro; o resto do app não depende delas.
-- ============================================================
--
-- Pedido do Arion (27-28/08/2026): tela nova com TODO o estoque de lote do
-- SAP (semente branca E tratada — hoje só a branca vira lote no app), pra
-- Logística endereçar (Armazém + Bloco + Quadra, um lote pode ter VÁRIOS
-- endereços), com mapa esquemático (quadra maior = acesso mais fácil) e
-- montagem de carga pela Balança (nº da ordem de carregamento + cultivar +
-- tratamento + bags; aviso quando o lote tem Destinação no SAP; peso total).
--
-- Fonte: export de saldo do SAP (SAP.xlsx — colunas Destinação, Depósito,
-- Classificação etc.). SÓ o depósito VEN_GER entra; lote zerado some do
-- mapa na carga seguinte. Tabela própria (lotes_mapa), SEPARADA de
-- lotes_semente de propósito: a base de produção (ordens/baixa/expedição)
-- assume semente branca e não pode ganhar lote tratado por tabela — o mapa
-- é outra vista do estoque, com outro ciclo de vida (substituição total a
-- cada carga, endereço preservado por upsert).
-- ============================================================

set search_path = tsi, public;

create table if not exists lotes_mapa (
  id            text primary key,                 -- Nº do Lote
  cultivar      text not null,
  tratamento    text,                             -- null = semente branca
  embalagem     text not null references embalagens(codigo),
  pms           numeric(8,3),
  peso_bag_kg   numeric(10,3) not null,           -- "Peso Bruto" do SAP (fallback pms × fator)
  bags          numeric(10,2) not null,           -- Qtd em Estoque no VEN_GER
  destinacao    text,                             -- coluna "Destinação" do SAP — dispara o aviso na carga
  classificacao text,                             -- "Classificação de Qualidade" (Classe B/C/D…)
  peneira       text,
  categoria     text,
  atualizado_em timestamptz not null default now()
);

comment on table lotes_mapa is
  'Todo lote do SAP no depósito VEN_GER (branco e tratado) — base da aba Mapa. Substituição total por upload: o que não vem na carga é apagado (lote zerado some), endereços sobrevivem via upsert enquanto o lote existir.';

create table if not exists lote_enderecos (
  id        uuid primary key default gen_random_uuid(),
  lote_id   text not null references lotes_mapa(id) on delete cascade,
  armazem   text not null,
  bloco     text not null,
  -- número de propósito: quanto MAIOR a quadra dentro do bloco, mais fácil
  -- o acesso — o mapa ordena por ela
  quadra    int not null check (quadra >= 0),
  bags      numeric(10,2) not null check (bags > 0),
  criado_por uuid references usuarios(id),
  criado_em  timestamptz not null default now()
);

comment on table lote_enderecos is
  'Endereçamento físico do lote (aba Mapa), dado pela Logística — um lote pode ocupar vários endereços, com bags em cada. Some junto com o lote (cascade) quando ele zera no SAP.';

create index if not exists lote_enderecos_lote on lote_enderecos(lote_id);

create table if not exists cargas_montadas (
  id               uuid primary key default gen_random_uuid(),
  numero           text not null,                 -- nº da ordem de carregamento
  cultivar         text not null,
  tratamento       text,
  bags_solicitados numeric(10,2) not null,
  peso_total_kg    numeric(12,2) not null,
  criada_por       uuid references usuarios(id),
  criada_em        timestamptz not null default now()
);

create table if not exists carga_montada_itens (
  id         uuid primary key default gen_random_uuid(),
  carga_id   uuid not null references cargas_montadas(id) on delete cascade,
  -- SEM FK pro lote de propósito: a carga é registro histórico e precisa
  -- sobreviver ao lote sumir do mapa (zerou no SAP — inclusive POR CAUSA
  -- desta carga)
  lote_id    text not null,
  bags       numeric(10,2) not null check (bags > 0),
  peso_kg    numeric(12,2) not null,
  -- foto do aviso no momento da montagem — a destinação do SAP muda depois
  destinacao text
);

create index if not exists carga_montada_itens_carga on carga_montada_itens(carga_id);

-- ---------------- RLS ----------------
alter table lotes_mapa          enable row level security;
alter table lote_enderecos      enable row level security;
alter table cargas_montadas     enable row level security;
alter table carga_montada_itens enable row level security;

drop policy if exists ler_lotes_mapa on lotes_mapa;
create policy ler_lotes_mapa on lotes_mapa for select using (meu_perfil() is not null);
drop policy if exists imp_lotes_mapa on lotes_mapa;
create policy imp_lotes_mapa on lotes_mapa for all
  using (meu_perfil() in ('PCP','Logistica','Gestor'))
  with check (meu_perfil() in ('PCP','Logistica','Gestor'));

drop policy if exists ler_lote_end on lote_enderecos;
create policy ler_lote_end on lote_enderecos for select using (meu_perfil() is not null);
drop policy if exists log_lote_end on lote_enderecos;
create policy log_lote_end on lote_enderecos for all
  using (meu_perfil() in ('Logistica','Gestor'))
  with check (meu_perfil() in ('Logistica','Gestor'));

drop policy if exists ler_cargas_mont on cargas_montadas;
create policy ler_cargas_mont on cargas_montadas for select using (meu_perfil() is not null);
drop policy if exists bal_cargas_mont on cargas_montadas;
create policy bal_cargas_mont on cargas_montadas for all
  using (meu_perfil() in ('Balanca','Logistica','Gestor'))
  with check (meu_perfil() in ('Balanca','Logistica','Gestor'));

drop policy if exists ler_carga_itens on carga_montada_itens;
create policy ler_carga_itens on carga_montada_itens for select using (meu_perfil() is not null);
drop policy if exists bal_carga_itens on carga_montada_itens;
create policy bal_carga_itens on carga_montada_itens for all
  using (meu_perfil() in ('Balanca','Logistica','Gestor'))
  with check (meu_perfil() in ('Balanca','Logistica','Gestor'));

-- ---------------- realtime ----------------
do $$ begin
  alter publication supabase_realtime add table lotes_mapa;
exception when others then null; end $$;
do $$ begin
  alter publication supabase_realtime add table lote_enderecos;
exception when others then null; end $$;
do $$ begin
  alter publication supabase_realtime add table cargas_montadas;
exception when others then null; end $$;

-- ============================================================
-- Conferência
-- ============================================================
-- select count(*) from lotes_mapa;        -- 0 até o primeiro upload
-- select count(*) from lote_enderecos;    -- 0 até a Logística endereçar
