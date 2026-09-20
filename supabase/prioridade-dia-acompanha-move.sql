-- ============================================================
-- Prioridade do dia ACOMPANHA a ordem quando muda de máquina/dia — 20/09/2026
--
-- Pedido do Arion: "quando eu mudo a máquina ou dia, a prioridade da ordem
-- some e eu preciso colocar novamente". Desde 16/09/2026 (prioridades-do-
-- dia.sql) o gatilho `fn_prioridade_dia_cai` APAGAVA a linha de
-- `ordem_prioridades_dia` sempre que `maquina_id`/`data_prog` mudava — a
-- prioridade era "da célula", e mudar de célula perdia o lugar. Decisão dele
-- (pergunta feita — três opções: só no arraste manual, sempre inclusive na
-- cascata, ou manter): **sempre, inclusive na Reprogramação em cascata**.
--
-- O que muda: em vez de apagar, o gatilho MOVE a mesma linha (mesma PK
-- `ordem_id`) pro FIM da fila da célula NOVA — nunca na frente do que já
-- estava lá, então uma reprogramação em massa não empurra a ordem movida
-- pra cima de prioridades que o PCP já tinha organizado no dia de destino.
-- Célula de origem some (posto no pool) continua apagando — não há pra onde
-- levar. Concluir (Finalizada/Qualidade apontada/Apontada/Excluida) continua
-- apagando: ordem parada não deveria aparecer priorizada em lugar nenhum.
--
-- A célula de ORIGEM perde um membro e pode abrir um buraco na numeração
-- (P1, P3 sem o P2) — só é visível no selo pequeno da fila normal
-- (`P{ord.prioridade_dia}`, valor cru; a faixa "Prioridades do dia" em si
-- numera pelo índice do array, sempre densa, e não seria afetada). Fecha o
-- buraco: `fn_prioridade_dia_renumerar` reordena 1..n a célula de origem
-- depois de qualquer saída (movida ou concluída).
--
-- `reprogramar`/`aplicarAtribuicoes` (src/dados/api-gestao.ts) fazem UM
-- UPDATE por ordem, sequencial (não em lote): mesmo a cascata movendo
-- dezenas de ordens, cada UPDATE dispara o gatilho e COMMITA sozinho antes
-- do próximo — sem corrida entre elas mesmo convergindo pra mesma célula.
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- Fecha o buraco de uma célula depois que ela perde um membro
-- ------------------------------------------------------------
create or replace function fn_prioridade_dia_renumerar(p_maquina text, p_dia date) returns void
language plpgsql security definer set search_path = tsi, public as $$
begin
  with ranqueada as (
    select p.ordem_id, row_number() over (order by p.posicao) as posicao_nova
      from ordem_prioridades_dia p
      join ordens o on o.id = p.ordem_id
     where o.maquina_id = p_maquina and o.data_prog = p_dia
  )
  update ordem_prioridades_dia p
     set posicao = r.posicao_nova
    from ranqueada r
   where p.ordem_id = r.ordem_id and p.posicao <> r.posicao_nova;
end $$;

revoke execute on function fn_prioridade_dia_renumerar(text, date) from public, anon, authenticated;

-- ------------------------------------------------------------
-- A prioridade acompanha a ordem; só cai se ela concluir ou for pro pool
-- ------------------------------------------------------------
create or replace function fn_prioridade_dia_cai() returns trigger
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_tinha_prioridade boolean;
  v_nova_posicao integer;
begin
  v_tinha_prioridade := exists (select 1 from ordem_prioridades_dia where ordem_id = new.id);

  -- concluiu (ou foi excluída): a prioridade nunca acompanha ordem parada
  if new.status in ('Finalizada','Qualidade apontada','Apontada','Excluida')
     and old.status not in ('Finalizada','Qualidade apontada','Apontada','Excluida') then
    if v_tinha_prioridade then
      delete from ordem_prioridades_dia where ordem_id = new.id;
      if old.maquina_id is not null and old.data_prog is not null then
        perform fn_prioridade_dia_renumerar(old.maquina_id, old.data_prog);
      end if;
    end if;
    return new;
  end if;

  -- mudou de máquina ou de dia
  if v_tinha_prioridade
     and (new.maquina_id is distinct from old.maquina_id or new.data_prog is distinct from old.data_prog) then
    if new.maquina_id is null or new.data_prog is null then
      -- foi pro pool: sem célula de destino, a prioridade não tem onde ficar
      delete from ordem_prioridades_dia where ordem_id = new.id;
    else
      -- pro FIM da fila da célula nova — nunca na frente de quem já estava lá
      select coalesce(max(p.posicao), 0) + 1 into v_nova_posicao
        from ordem_prioridades_dia p
        join ordens o on o.id = p.ordem_id
       where o.maquina_id = new.maquina_id and o.data_prog = new.data_prog
         and p.ordem_id <> new.id;
      update ordem_prioridades_dia set posicao = v_nova_posicao where ordem_id = new.id;
    end if;
    if old.maquina_id is not null and old.data_prog is not null then
      perform fn_prioridade_dia_renumerar(old.maquina_id, old.data_prog);
    end if;
  end if;

  return new;
end $$;
-- o gatilho `tg_prioridade_dia_cai` já existe (16/09/2026) e continua
-- apontando pra esta função — só o CORPO da função mudou, sem recriar

-- ------------------------------------------------------------
-- Conferência
-- ------------------------------------------------------------
select 'renumerar existe' as item, (count(*) = 1)::text as ok
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'tsi' and p.proname = 'fn_prioridade_dia_renumerar'
union all
select 'gatilho continua em ordens', (count(*) = 1)::text
  from pg_trigger where tgname = 'tg_prioridade_dia_cai';
