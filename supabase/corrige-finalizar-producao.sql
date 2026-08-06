-- ============================================================
-- CORREÇÃO URGENTE — a Produção não consegue finalizar ordem
-- Execute no SQL Editor do Supabase
-- ============================================================
--
-- SINTOMA: operador clica em Confirmar finalização e recebe
--   "Editar a ordem exige a acao Editar (Administracao)".
--
-- CAUSA: `fn_ordens_por_acao` tem uma lista `ignorar` com as colunas que
-- já são cobertas por uma checagem específica; o que sobra cai na regra
-- final, que exige `ordens/editar`. A coluna `bags_produzidos` nasceu em
-- quantidade-produzida.sql e NÃO foi acrescentada à lista — e é justamente
-- ela que o `confirmar_fim` grava. Resultado: finalizar virou ação de
-- administrador, e a Produção ficou sem conseguir fechar ordem.
--
-- CORREÇÃO: `bags_produzidos` entra na lista e passa a exigir
-- `execucao/apontar`, junto de turno_id e fim_pendente — é apontamento de
-- produção, não edição de ordem.
-- ============================================================

set search_path = tsi, public;

create or replace function fn_ordens_por_acao() returns trigger as $$
declare
  ignorar constant text[] := array[
    'status','turno_id','fim_pendente','bags_produzidos',
    'prioridade','prioridade_por','prioridade_em',
    'maquina_id','data_prog','seq',
    'agrotis_num','agrotis_por','agrotis_em'];
begin
  if new.status is distinct from old.status then
    if new.status = 'Apontada' then
      if not tem_acao('agrotis','lancar') then
        raise exception 'Encerrar no AGROTIS exige a acao Lancar (Administracao)';
      end if;
    elsif new.status = 'Qualidade apontada' then
      if not tem_acao('qualidade','qualidade') then
        raise exception 'Apontar qualidade exige a acao Qualidade (Administracao)';
      end if;
    elsif old.status in ('Nao programada','Programada','Em producao','Parada')
      and new.status in ('Nao programada','Programada','Em producao','Parada','Finalizada') then
      if not tem_acao('execucao','apontar') then
        raise exception 'Apontar producao exige a acao Apontar (Administracao)';
      end if;
    else
      -- transição fora do fluxo (ex.: reabrir Finalizada): só quem edita ordens
      if not tem_acao('ordens','editar') then
        raise exception 'Transicao de status fora do fluxo exige a acao Editar ordens';
      end if;
    end if;
  end if;
  -- quantidade produzida é apontamento de produção, como turno e fim_pendente
  if (new.turno_id is distinct from old.turno_id
      or new.fim_pendente is distinct from old.fim_pendente
      or new.bags_produzidos is distinct from old.bags_produzidos)
     and not tem_acao('execucao','apontar') then
    raise exception 'Apontar producao exige a acao Apontar (Administracao)';
  end if;
  if (new.prioridade is distinct from old.prioridade
      or new.prioridade_por is distinct from old.prioridade_por
      or new.prioridade_em is distinct from old.prioridade_em)
     and not tem_acao('ordens','priorizar') then
    raise exception 'Priorizar exige a acao Priorizar (Administracao)';
  end if;
  if (new.maquina_id is distinct from old.maquina_id
      or new.data_prog is distinct from old.data_prog
      or new.seq is distinct from old.seq)
     and not (tem_acao('programacao','editar') or tem_acao('ordens','editar')) then
    raise exception 'Programar exige a acao Editar programacao (Administracao)';
  end if;
  if (new.agrotis_num is distinct from old.agrotis_num
      or new.agrotis_por is distinct from old.agrotis_por
      or new.agrotis_em is distinct from old.agrotis_em)
     and not tem_acao('agrotis','lancar') then
    raise exception 'Encerrar no AGROTIS exige a acao Lancar (Administracao)';
  end if;
  if (to_jsonb(new) - ignorar) <> (to_jsonb(old) - ignorar)
     and not tem_acao('ordens','editar') then
    raise exception 'Editar a ordem exige a acao Editar (Administracao)';
  end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;

-- conferência: a lista precisa conter bags_produzidos
select 'bags_produzidos na lista de ignorar' as item,
       (position('bags_produzidos' in prosrc) > 0)::text as ok
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'tsi' and p.proname = 'fn_ordens_por_acao';
