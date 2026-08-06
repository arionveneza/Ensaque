-- ============================================================
-- Princípios ativos do produto químico + perfil Direção
-- Execute no SQL Editor do Supabase
-- ============================================================
--
-- 1. PRINCÍPIOS ATIVOS: um produto pode ter vários (produto combinado), e
--    cada um tem nome, concentração e classe agronômica própria — é comum
--    o mesmo produto juntar fungicida e inseticida.
--
-- 2. PERFIL DIREÇÃO: enxerga a operação inteira e baixa relatório, mas não
--    altera nada. Como `tem_acao` cai no padrão de fábrica quando não há
--    linha explícita em perfil_permissoes, basta a Direção NÃO aparecer na
--    lista de padrões de escrita — e ela só recebe 'ver'.
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 1. Princípios ativos
-- ------------------------------------------------------------
create table if not exists produto_principios (
  id           uuid primary key default gen_random_uuid(),
  produto_id   uuid not null references produtos_quimicos(id) on delete cascade,
  nome         text not null,
  concentracao numeric(10,3),
  unidade_conc text not null default 'g/L' check (unidade_conc in ('g/L','g/kg','%')),
  classe       text not null check (classe in
                 ('Fungicida','Inseticida','Biologico','Nematicida','Inoculante','Outros')),
  unique (produto_id, nome)
);
create index if not exists produto_principios_produto on produto_principios (produto_id);

alter table produto_principios enable row level security;
drop policy if exists ler_pa on produto_principios;
create policy ler_pa on produto_principios for select using (meu_perfil() is not null);
drop policy if exists edita_pa on produto_principios;
create policy edita_pa on produto_principios for all
  using (tem_acao('cadastros','editar'))
  with check (tem_acao('cadastros','editar'));

do $$ begin
  alter publication supabase_realtime add table produto_principios;
exception when others then null; end $$;

-- ------------------------------------------------------------
-- 2. Perfil Direção
-- ------------------------------------------------------------
alter type perfil_tipo add value if not exists 'Direcao';

commit;  -- valor novo de enum só pode ser USADO depois de commitado

-- padrão de fábrica: Direção com 'ver' em tudo e nenhuma ação de escrita.
-- Espelho de MATRIZ_PADRAO em src/dominio/permissoes.ts — mudou um, mude o outro.
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
      ('Logistica','programacao','ver'), ('Logistica','lotes','ver'),
      ('Logistica','lotes','baixar_lote'), ('Logistica','lotes','conferir'),
      ('Logistica','etapas','ver'), ('Logistica','indicadores','ver'),
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
      ('Direcao','cadastros','ver')
    ) as padrao(perfil, recurso, acao)
      where padrao.perfil = tsi.meu_perfil()::text
        and padrao.recurso = p_recurso and padrao.acao = p_acao)
  );
$$ language sql stable security definer set search_path = tsi, public;

-- conferência
select 'perfis no enum' as item, string_agg(e.enumlabel, ', ' order by e.enumsortorder) as valor
  from pg_enum e join pg_type t on t.oid = e.enumtypid
 where t.typname = 'perfil_tipo'
union all
select 'produto_principios existe', count(*)::text from produto_principios;
