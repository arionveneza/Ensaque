-- ============================================================
-- Carregamentos agendados (montagem de carga) + recurso Expedição
-- Execute no SQL Editor do Supabase
-- ============================================================
--
-- A planilha "montagem de carga" da SimpleAgro traz os caminhões agendados.
-- A tela Expedição cruza esses agendamentos com o estoque (lotes para
-- SEM TSI, produto acabado para tratado) e com a produção programada, para
-- responder: o estoque atende o que está agendado até tal data?
--
-- Substituição total, como pedidos e saldos: cada upload apaga o anterior e
-- passa a valer. O arquivo é a foto do dia; misturar duas fotos duplica.
-- ============================================================

set search_path = tsi, public;

create table if not exists carregamentos (
  id             uuid primary key default gen_random_uuid(),
  carga          int not null,
  status         text not null,
  data           date,                    -- agendamento sem dia existe; marcado, não escondido
  pedido         text,
  cliente        text,
  cultivar       text not null,
  tratamento     text not null,           -- 'SEM TSI' = semente branca
  embalagem      text not null,           -- já traduzida (BG5M/MEIOBAG); sem FK: código novo não pode travar o upload
  bags           numeric(12,2) not null,
  transportadora text,
  motorista      text,
  placa          text,
  importado_em   timestamptz not null default now(),
  importado_por  uuid references usuarios(id)
);
create index if not exists carregamentos_data on carregamentos (data);

comment on table carregamentos is
  'Foto do relatório montagem de carga da SimpleAgro. Substituição total a cada upload.';

alter table carregamentos enable row level security;

drop policy if exists ler_carreg on carregamentos;
create policy ler_carreg on carregamentos for select using (meu_perfil() is not null);

-- upload: quem tem a ação importar da Expedição (PCP e Logística por padrão)
drop policy if exists grava_carreg on carregamentos;
create policy grava_carreg on carregamentos for all
  using (tem_acao('expedicao','importar'))
  with check (tem_acao('expedicao','importar'));

do $$ begin
  alter publication supabase_realtime add table carregamentos;
exception when others then null; end $$;

-- ------------------------------------------------------------
-- Recurso 'expedicao' no padrão de fábrica do tem_acao.
-- Espelho de MATRIZ_PADRAO em src/dominio/permissoes.ts — mudou um, mude o
-- outro. (Recria a função inteira: é o padrão deste projeto.)
-- ------------------------------------------------------------
create or replace function tem_acao(p_recurso text, p_acao text) returns boolean as $$
  select coalesce(
    (select permitido from tsi.perfil_permissoes
      where perfil = tsi.meu_perfil() and recurso = p_recurso and acao = p_acao),
    tsi.meu_perfil() = 'Gestor'  -- padrão do Gestor: tudo
    or exists (select 1 from (values
      ('PCP','ordens','ver'), ('PCP','ordens','criar'), ('PCP','ordens','editar'),
      ('PCP','ordens','excluir'), ('PCP','ordens','priorizar'),
      ('PCP','programacao','ver'), ('PCP','programacao','editar'),
      ('PCP','lotes','ver'), ('PCP','execucao','ver'), ('PCP','qualidade','ver'),
      ('PCP','agrotis','ver'), ('PCP','agrotis','lancar'),
      ('PCP','etapas','ver'), ('PCP','indicadores','ver'),
      ('PCP','cadastros','ver'), ('PCP','cadastros','editar'),
      ('PCP','expedicao','ver'), ('PCP','expedicao','importar'),
      ('Logistica','programacao','ver'), ('Logistica','lotes','ver'),
      ('Logistica','lotes','baixar_lote'), ('Logistica','lotes','conferir'),
      ('Logistica','etapas','ver'), ('Logistica','indicadores','ver'),
      ('Logistica','expedicao','ver'), ('Logistica','expedicao','importar'),
      ('Producao','programacao','ver'), ('Producao','execucao','ver'),
      ('Producao','execucao','apontar'),
      ('Producao','etapas','ver'), ('Producao','indicadores','ver'),
      ('Qualidade','execucao','ver'), ('Qualidade','qualidade','ver'),
      ('Qualidade','qualidade','qualidade'),
      ('Qualidade','etapas','ver'), ('Qualidade','indicadores','ver'),
      -- Direção: só leitura, em tudo
      ('Direcao','ordens','ver'), ('Direcao','programacao','ver'),
      ('Direcao','lotes','ver'), ('Direcao','execucao','ver'),
      ('Direcao','qualidade','ver'), ('Direcao','agrotis','ver'),
      ('Direcao','etapas','ver'), ('Direcao','indicadores','ver'),
      ('Direcao','cadastros','ver'), ('Direcao','expedicao','ver')
    ) as padrao(perfil, recurso, acao)
      where padrao.perfil = tsi.meu_perfil()::text
        and padrao.recurso = p_recurso and padrao.acao = p_acao)
  );
$$ language sql stable security definer set search_path = tsi, public;

-- ------------------------------------------------------------
-- Conferência
-- ------------------------------------------------------------
select 'tabela carregamentos' as item, (count(*) = 1)::text as ok
  from information_schema.tables
 where table_schema = 'tsi' and table_name = 'carregamentos'
union all
select 'tem_acao com expedicao', (position('expedicao' in prosrc) > 0)::text
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
 where ns.nspname = 'tsi' and p.proname = 'tem_acao'
union all
select 'politicas da tabela', (count(*) = 2)::text
  from pg_policies where schemaname = 'tsi' and tablename = 'carregamentos';
