-- ============================================================
-- Estorno de liberação passa a ser POR ORDEM, não por lote inteiro
-- Execute no SQL Editor do Supabase
-- ============================================================
--
-- POR QUE (decisão de 10/08/2026, na sequência de liberacao-lote-por-ordem.sql):
-- a liberação já é por ordem desde a migração anterior, mas o ESTORNO ainda
-- desfazia todas as ordens liberadas de um lote de uma vez só
-- (`estornar_lote(p_lote)`). Se um lote tem 3 ordens liberadas e só 1 foi
-- liberada por engano (ou está para ser excluída), não tinha como desfazer
-- só ela — o botão levava as outras 2 de volta para "Aguardando lote" junto,
-- sem necessidade.
--
-- O QUE MUDA: `estornar_lote(p_lote)` é substituída por
-- `estornar_liberacao(p_ordem)` — desfaz UMA ordem, e recalcula
-- `lotes_semente.status` (só volta a 'Em estoque' se, depois deste estorno,
-- nenhuma outra ordem do lote continuar liberada). `baixar_lote(p_lote)`
-- CONTINUA em bloco, por lote: uma viagem ao depósito libera várias ordens
-- de uma vez, e não tem motivo prático para forçar clique um a um aí.
--
-- Efeito colateral que precisava de solução própria: um lote 'Baixado' sem
-- NENHUMA ordem dependente (órfão — ex.: a única ordem que dependia dele foi
-- excluída depois de liberada) não tem ordem nenhuma para o estorno por
-- ordem agir. `devolver_lote_orfao(p_lote)` cobre só esse caso específico.
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 1. estornar_liberacao(p_ordem): desfaz a liberação de UMA ordem
-- ------------------------------------------------------------
drop function if exists estornar_lote(text);

create or replace function estornar_liberacao(p_ordem uuid) returns void as $$
declare
  v_lote text;
  v_bags numeric;
begin
  if not pode_baixar_lote() then
    raise exception 'Perfil sem permissao para estornar liberacao';
  end if;

  update tsi.ordens
     set lote_liberado_em = null, lote_liberado_por = null
   where id = p_ordem
     and lote_liberado_em is not null
     and status not in ('Em producao','Parada','Finalizada','Qualidade apontada','Apontada')
  returning lote_id, bags into v_lote, v_bags;

  if v_lote is null then
    raise exception 'Ordem nao esta liberada (ou ja foi iniciada) — nao ha o que estornar';
  end if;

  -- tg_baixa_so_pela_rpc (matriz-permissoes-no-banco.sql) recusa qualquer
  -- update de status/baixado_* em lotes_semente fora desta flag de sessao.
  perform set_config('tsi.baixa_via_rpc', '1', true);

  -- o lote só volta a 'Em estoque' se NENHUMA outra ordem dele continuar
  -- liberada — senão ele continua fazendo sentido estar 'Baixado'.
  update tsi.lotes_semente
     set status = 'Em estoque', baixado_por = null, baixado_em = null, devolver = false
   where id = v_lote
     and not exists (
       select 1 from tsi.ordens where lote_id = v_lote and lote_liberado_em is not null
     );

  insert into tsi.lote_movimentos (lote_id, bags, estorno, usuario_id)
  values (v_lote, -v_bags, true, auth.uid());
end $$ language plpgsql security definer set search_path = tsi, public;

revoke execute on function estornar_liberacao(uuid) from public, anon;
grant execute on function estornar_liberacao(uuid) to authenticated;

-- ------------------------------------------------------------
-- 2. devolver_lote_orfao(p_lote): só para o caso raro de lote 'Baixado'
-- sem NENHUMA ordem dependente (nada para o estorno por ordem agir).
-- ------------------------------------------------------------
create or replace function devolver_lote_orfao(p_lote text) returns void as $$
begin
  if not pode_baixar_lote() then
    raise exception 'Perfil sem permissao para devolver lote';
  end if;

  if exists (select 1 from tsi.ordens where lote_id = p_lote) then
    raise exception 'Lote tem ordem dependente — use o estorno por ordem, nao a devolucao de orfao';
  end if;

  perform set_config('tsi.baixa_via_rpc', '1', true);

  update tsi.lotes_semente
     set status = 'Em estoque', baixado_por = null, baixado_em = null, devolver = false
   where id = p_lote and status = 'Baixado';

  if not found then
    raise exception 'Lote % nao esta baixado ou nao existe', p_lote;
  end if;

  insert into tsi.lote_movimentos (lote_id, bags, estorno, usuario_id)
  values (p_lote, 0, true, auth.uid());
end $$ language plpgsql security definer set search_path = tsi, public;

revoke execute on function devolver_lote_orfao(text) from public, anon;
grant execute on function devolver_lote_orfao(text) to authenticated;

-- ------------------------------------------------------------
-- Conferência
-- ------------------------------------------------------------
select 'estornar_lote(text) removida (deve ser 0)' as item, count(*)::text as valor
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'tsi' and p.proname = 'estornar_lote'
union all
select 'estornar_liberacao(uuid) — assinatura nova', count(*)::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'tsi' and p.proname = 'estornar_liberacao'
union all
select 'devolver_lote_orfao(text) — nova', count(*)::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'tsi' and p.proname = 'devolver_lote_orfao';
