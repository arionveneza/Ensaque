-- ============================================================
-- Mapa: a unidade vira LOTE + TRATAMENTO — 28/08/2026
-- Execute no SQL Editor do Supabase (idempotente)
-- RECRIA lotes_mapa e lote_enderecos (os dados são recarregados na
-- sequência pelo import — nada manual se perde: endereçamento ainda
-- não tinha sido gravado).
-- ============================================================
--
-- O endereçamento inicial do Arion (28/08/2026) provou que a unidade
-- física endereçada é a COMBINAÇÃO lote + tratamento: o mesmo lote
-- existe branco E tratado ao mesmo tempo, em endereços diferentes
-- (ex.: SV0891056060482 aparece com 5 tratamentos, cada um num lugar).
-- A chave só pelo nº do lote misturava tudo. Ajustes:
--
--   - lotes_mapa: PK (lote, tratamento); tratamento NOT NULL com
--     'SEM TSI' = semente branca (mesma convenção de lotes_semente);
--   - lote_enderecos: FK composta; QUADRA vira TEXTO (nem sempre é
--     número: CORREDOR, SILO, DESCARTE — número maior segue sendo a
--     frente do bloco); BAGS vira OPCIONAL (o endereçamento físico não
--     controla quantidade por endereço).
-- ============================================================

set search_path = tsi, public;

drop table if exists lote_enderecos;
drop table if exists lotes_mapa;

create table lotes_mapa (
  lote          text not null,                    -- Nº do Lote
  tratamento    text not null,                    -- 'SEM TSI' = semente branca
  cultivar      text not null,
  embalagem     text not null references embalagens(codigo),
  pms           numeric(8,3),
  peso_bag_kg   numeric(10,3) not null,           -- "Peso Bruto" do SAP (fallback pms × fator)
  bags          numeric(10,2) not null,           -- Qtd em Estoque no VEN_GER
  destinacao    text,                             -- coluna "Destinação" do SAP — dispara o aviso na carga
  classificacao text,                             -- "Classificação de Qualidade" (Classe B/C/D…)
  peneira       text,
  categoria     text,
  atualizado_em timestamptz not null default now(),
  primary key (lote, tratamento)
);

comment on table lotes_mapa is
  'Todo lote do SAP no depósito VEN_GER, por LOTE + TRATAMENTO (o mesmo lote existe branco e tratado ao mesmo tempo, em lugares diferentes — 28/08/2026). SEM TSI = branca. Substituição total por upload: o que não vem some; endereços dos que continuam sobrevivem via upsert.';

create table lote_enderecos (
  id         uuid primary key default gen_random_uuid(),
  lote       text not null,
  tratamento text not null,
  armazem    text not null,
  bloco      text not null,
  -- TEXTO de propósito: quadra nem sempre é número (CORREDOR, SILO,
  -- DESCARTE). Quando é número, maior = frente do bloco (acesso fácil).
  quadra     text not null,
  -- opcional: o endereçamento físico não controla bags por endereço
  bags       numeric(10,2) check (bags is null or bags > 0),
  criado_por uuid references usuarios(id),
  criado_em  timestamptz not null default now(),
  foreign key (lote, tratamento) references lotes_mapa (lote, tratamento) on delete cascade
);

comment on table lote_enderecos is
  'Endereçamento físico da combinação lote + tratamento (aba Mapa), dado pela Logística — pode ocupar vários endereços. Some junto com o lote (cascade) quando ele zera no SAP.';

create index if not exists lote_enderecos_lote on lote_enderecos(lote, tratamento);

-- ---------------- RLS (mesmas regras de antes) ----------------
alter table lotes_mapa     enable row level security;
alter table lote_enderecos enable row level security;

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

-- ---------------- realtime (o drop tira da publicação) ----------------
do $$ begin
  alter publication supabase_realtime add table lotes_mapa;
exception when others then null; end $$;
do $$ begin
  alter publication supabase_realtime add table lote_enderecos;
exception when others then null; end $$;

-- ============================================================
-- Conferência
-- ============================================================
-- select count(*) from lotes_mapa;      -- 0 até reimportar (o Claude recarrega)
-- select count(*) from lote_enderecos;  -- 0 até a carga do endereçamento
