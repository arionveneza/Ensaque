-- ============================================================
-- tem_acao CONSOLIDADA — única versão válida a partir de 08/08/2026
-- Execute no SQL Editor do Supabase (idempotente)
--
-- POR QUE EXISTE: dois scripts recriavam a função inteira e brigavam:
--   · carregamentos.sql (07/08) acrescentou o recurso EXPEDIÇÃO,
--     mas não tem a blindagem anti-NULL;
--   · fecha-rpc-sem-guarda.sql (08/08) acrescentou a blindagem anti-NULL
--     (sem ela, `if not tem_acao(...)` falha ABERTO para chamador sem
--     perfil — inclusive anônimo), mas a lista de padrões dele NÃO tem
--     a Expedição.
-- Quem rodava por último apagava o avanço do outro. Se fecha-rpc rodou
-- depois, PCP e Logística PERDERAM a aba Expedição — este script devolve.
--
-- Esta é a união dos dois: Expedição + Direção + coalesce(..., false).
-- Espelho de MATRIZ_PADRAO em src/dominio/permissoes.ts — mudou um, mude
-- o outro. Migração futura que precise mexer aqui: edite ESTE arquivo e
-- reexecute-o, em vez de embutir outra cópia da função.
-- ============================================================

set search_path = tsi, public;

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
        and padrao.recurso = p_recurso and padrao.acao = p_acao),
    false  -- NUNCA null: chamador sem perfil (inclusive anônimo) é sempre "não pode"
  );
$$ language sql stable security definer set search_path = tsi, public;

-- ------------------------------------------------------------
-- Conferência: as duas propriedades JUNTAS, que é o que os scripts
-- anteriores não garantiam ao mesmo tempo.
-- ------------------------------------------------------------
select 'expedicao no padrao' as item,
       (position('expedicao' in prosrc) > 0)::text as ok
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
 where ns.nspname = 'tsi' and p.proname = 'tem_acao'
union all
select 'blindagem anti-NULL (false final)',
       (position('false  -- NUNCA null' in prosrc) > 0)::text
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
 where ns.nspname = 'tsi' and p.proname = 'tem_acao'
union all
select 'sem sessao devolve false, nunca null',
       (tem_acao('execucao','apontar') is false)::text;
