-- ============================================================
-- Renumerar ordem já tocada pela produção — trava o número em 'Apontada'
-- Execute no SQL Editor do Supabase
-- ============================================================
--
-- POR QUE (decisão de 11/08/2026): o PCP pediu uma forma de corrigir o
-- NÚMERO de uma ordem mesmo depois que a produção já a tocou — o número não
-- entra em nenhum cálculo (tempo, consumo, peso), então corrigi-lo não
-- distorce nada, diferente de cultivar/receita/bags/lote/máquina/dia, que
-- `fn_ordem_imutavel` já trava. Front-end libera o botão "renumerar" em
-- Em produção, Parada, Finalizada e Qualidade apontada (ver
-- `MATRIZ_STATUS.renumerar` em `src/dominio/status.ts`) — mas NÃO em
-- Apontada, porque nesse ponto o número já foi lançado no AGROTIS (ERP
-- externo) e corrigir aqui divergiria de lá sem ninguém saber.
--
-- Achado ao implementar: `fn_ordem_imutavel` nunca checou a coluna `numero`
-- em NENHUM dos 5 status "tocados" — ou seja, o banco sempre permitiu essa
-- edição, inclusive em Apontada; só a tela nunca expôs. Como agora existe
-- uma tela que expõe deliberadamente até Qualidade apontada, fechar em
-- Apontada no banco também, não só escondendo o botão — a proteção real é
-- o trigger, a tela é só a conveniência.
-- ============================================================

set search_path = tsi, public;

create or replace function fn_ordem_imutavel() returns trigger as $$
begin
  if old.status in ('Em producao','Parada','Finalizada','Qualidade apontada','Apontada') then
    if tg_op = 'DELETE' then
      raise exception 'Ordem % nao pode ser excluida (status %)', old.numero, old.status;
    end if;
    -- permite apenas transições de fluxo e campos de encerramento
    if new.cultivar <> old.cultivar or new.receita_id <> old.receita_id
       or new.embalagem <> old.embalagem or new.bags <> old.bags
       or new.lote_id <> old.lote_id or new.maquina_id is distinct from old.maquina_id
       or new.data_prog is distinct from old.data_prog then
      raise exception 'Ordem % em andamento/finalizada nao pode ser editada', old.numero;
    end if;
    -- numero pode ser corrigido até Qualidade apontada; em Apontada já foi
    -- para o AGROTIS, e corrigir aqui divergiria do ERP sem ninguém saber
    if old.status = 'Apontada' and new.numero is distinct from old.numero then
      raise exception 'Ordem % ja apontada no AGROTIS: numero nao pode mais ser corrigido', old.numero;
    end if;
  end if;
  -- em trigger de DELETE o NEW e' NULL: retornar NULL num BEFORE DELETE cancelaria
  -- a exclusao silenciosamente, bloqueando ordens que a matriz permite excluir
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;

-- ------------------------------------------------------------
-- Conferência
-- ------------------------------------------------------------
select 'fn_ordem_imutavel trava numero em Apontada' as item,
       (position('old.status = ''Apontada'' and new.numero' in prosrc) > 0)::text as ok
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'tsi' and p.proname = 'fn_ordem_imutavel';
