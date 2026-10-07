-- ============================================================
-- Relatório gerencial (07/10/2026, pedido do Arion): o PCP lança, por dia,
-- veículos carregados, bags carregados, veículos descarregados e veículos que
-- sobraram no pátio; a tela soma o acumulado da semana (segunda a domingo). O
-- planejado × executado de produção sai do que já existe (ordens, tempos e
-- ordem_reprogramacoes) — só o carregamento precisa de tabela.
--
-- Recurso novo `gerencial`: ver (PCP, Direção, Gestor) · editar (PCP, Gestor).
-- tem_acao recriada sobre a definição vigente (pesagem.sql) com 3 linhas a
-- mais; a matriz do front (src/dominio/permissoes.ts) espelha.
-- ============================================================

create table if not exists tsi.relatorio_carregamento (
  dia date primary key,
  -- nulo = não informado (≠ zero)
  veiculos_carregados integer check (veiculos_carregados >= 0),
  bags_carregados numeric(10,2) check (bags_carregados >= 0),
  veiculos_descarregados integer check (veiculos_descarregados >= 0),
  veiculos_patio integer check (veiculos_patio >= 0),
  observacao text,
  atualizado_em timestamptz not null default now(),
  atualizado_por uuid references tsi.usuarios(id) default auth.uid()
);

comment on table tsi.relatorio_carregamento is
  'Carregamento do dia, digitado pelo PCP (07/10/2026) — base do relatório gerencial (acumulado da semana de segunda a domingo).';

create or replace function tsi.fn_relatorio_carregamento_carimbo()
returns trigger
language plpgsql set search_path = tsi, public as $$
begin
  new.atualizado_em := now();
  new.atualizado_por := coalesce(auth.uid(), new.atualizado_por);
  return new;
end $$;

drop trigger if exists tg_relatorio_carregamento_carimbo on tsi.relatorio_carregamento;
create trigger tg_relatorio_carregamento_carimbo
  before insert or update on tsi.relatorio_carregamento
  for each row execute function tsi.fn_relatorio_carregamento_carimbo();

alter table tsi.relatorio_carregamento enable row level security;
drop policy if exists ler_relatorio_carregamento on tsi.relatorio_carregamento;
create policy ler_relatorio_carregamento on tsi.relatorio_carregamento for select
  using (tsi.tem_acao('gerencial', 'ver'));
drop policy if exists editar_relatorio_carregamento on tsi.relatorio_carregamento;
create policy editar_relatorio_carregamento on tsi.relatorio_carregamento for all
  using (tsi.tem_acao('gerencial', 'editar'))
  with check (tsi.tem_acao('gerencial', 'editar'));

grant select, insert, update, delete on tsi.relatorio_carregamento to authenticated;

-- a tela assina a tabela: entra na publicação na mesma migração
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'tsi'
                    and tablename = 'relatorio_carregamento') then
    execute 'alter publication supabase_realtime add table tsi.relatorio_carregamento';
  end if;
end $$;

-- permissão padrão do recurso novo (base: tem_acao vigente, de pesagem.sql)
CREATE OR REPLACE FUNCTION tsi.tem_acao(p_recurso text, p_acao text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'tsi', 'public'
AS $function$
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
      ('PCP','mrp','ver'), ('PCP','mrp','importar'),
      ('PCP','mapa','ver'), ('PCP','mapa','importar'), ('PCP','mapa','montar_carga'),
      ('PCP','mapa','ajustar'),
      ('PCP','inventario','ver'), ('PCP','inventario','abrir'), ('PCP','inventario','contar'),
      ('PCP','veiculos','ver'), ('PCP','veiculos','chamar'), ('PCP','veiculos','checklist'),
      ('PCP','pesagem','ver'),
      -- Relatório gerencial (07/10/2026): o PCP lança e vê
      ('PCP','gerencial','ver'), ('PCP','gerencial','editar'),
      ('Logistica','programacao','ver'), ('Logistica','lotes','ver'),
      ('Logistica','lotes','baixar_lote'), ('Logistica','lotes','conferir'),
      ('Logistica','etapas','ver'), ('Logistica','indicadores','ver'),
      ('Logistica','expedicao','ver'), ('Logistica','expedicao','importar'),
      ('Logistica','mapa','ver'), ('Logistica','mapa','importar'), ('Logistica','mapa','enderecar'),
      ('Logistica','mapa','ajustar'),
      ('Logistica','inventario','ver'), ('Logistica','inventario','contar'),
      ('Logistica','veiculos','ver'), ('Logistica','veiculos','chamar'), ('Logistica','veiculos','checklist'),
      ('Logistica','pesagem','ver'),
      ('Producao','programacao','ver'), ('Producao','execucao','ver'),
      ('Producao','execucao','apontar'),
      ('Producao','etapas','ver'), ('Producao','indicadores','ver'),
      ('Producao','inventario','ver'), ('Producao','inventario','contar'),
      ('Qualidade','execucao','ver'), ('Qualidade','qualidade','ver'),
      ('Qualidade','qualidade','qualidade'),
      ('Qualidade','etapas','ver'), ('Qualidade','indicadores','ver'),
      -- Direção: só leitura, em tudo
      ('Direcao','ordens','ver'), ('Direcao','programacao','ver'),
      ('Direcao','lotes','ver'), ('Direcao','execucao','ver'),
      ('Direcao','qualidade','ver'), ('Direcao','agrotis','ver'),
      ('Direcao','etapas','ver'), ('Direcao','indicadores','ver'),
      ('Direcao','cadastros','ver'), ('Direcao','expedicao','ver'),
      ('Direcao','mrp','ver'), ('Direcao','mapa','ver'),
      ('Direcao','inventario','ver'),
      ('Direcao','veiculos','ver'),
      ('Direcao','pesagem','ver'),
      ('Direcao','gerencial','ver'),
      -- Balança: veículos, leitura do mapa e a pesagem (14/09/2026)
      ('Balanca','veiculos','ver'), ('Balanca','veiculos','chamar'), ('Balanca','veiculos','checklist'),
      ('Balanca','mapa','ver'),
      ('Balanca','pesagem','ver'), ('Balanca','pesagem','registrar')
    ) as padrao(perfil, recurso, acao)
      where padrao.perfil = tsi.meu_perfil()::text
        and padrao.recurso = p_recurso and padrao.acao = p_acao),
    false  -- NUNCA null: chamador sem perfil (inclusive anônimo) é sempre "não pode"
  );
$function$;

-- Conferência
select json_build_object(
  'tabela', (select count(*) from information_schema.tables
              where table_schema = 'tsi' and table_name = 'relatorio_carregamento'),
  'rls', (select relrowsecurity from pg_class where oid = 'tsi.relatorio_carregamento'::regclass),
  'politicas', (select json_agg(policyname) from pg_policies
                 where schemaname = 'tsi' and tablename = 'relatorio_carregamento'),
  'realtime', (select count(*) from pg_publication_tables
                where pubname = 'supabase_realtime' and schemaname = 'tsi'
                  and tablename = 'relatorio_carregamento'),
  'tem_acao_tem_gerencial', (select position('gerencial' in pg_get_functiondef('tsi.tem_acao(text,text)'::regprocedure)) > 0)
) as conferencia;
