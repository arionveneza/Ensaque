-- ============================================================
-- Exclusão exige ordem virgem + cancelamento leva os testes junto
-- Decisões de 05/08/2026, fechando o buraco encontrado em campo:
-- o Cancelar início "lava" o status (volta para Programada) e a
-- proteção de imutabilidade só olhava o rótulo — uma ordem com testes
-- de qualidade pôde ser excluída de fato, em cascata, sem rastro.
--
--  1. Excluir passa a exigir ordem SEM história: nenhum evento de
--     produção, parada, teste de qualidade ou conferência. Ordem-papel
--     (criada errada, nunca confirmada) continua excluível como hoje.
--     Tanques montados/pesos digitados sem confirmação NÃO bloqueiam
--     (preparação é descartável); auditoria também não (senão uma
--     ordem cancelada nunca mais poderia ser excluída).
--  2. Cancelar início apaga TAMBÉM os testes de qualidade em processo
--     — a tela avisa quantos antes de confirmar. Órfão é pior: teste
--     pendurado em ordem "Programada" é corrupção de dado.
--
-- Requer matriz-permissoes-no-banco.sql aplicado (redefine a RPC
-- cancelar_inicio de lá). Rodar junto com quantidade-produzida.sql.
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 1. Quem decide se a ordem pode sumir é a história, não o status
-- ------------------------------------------------------------
create or replace function fn_ordem_sem_historia() returns trigger as $$
begin
  if exists (select 1 from qualidade_checks  q where q.ordem_id = old.id)
     or exists (select 1 from ordem_conferencias c where c.ordem_id = old.id)
     or exists (select 1 from ordem_eventos  e where e.ordem_id = old.id)
     or exists (select 1 from ordem_paradas  p where p.ordem_id = old.id) then
    raise exception
      'Ordem % tem historia (producao/qualidade/conferencia) e nao pode ser excluida',
      old.numero;
  end if;
  return old;
end $$ language plpgsql set search_path = tsi, public;
drop trigger if exists tg_ordem_sem_historia on ordens;
create trigger tg_ordem_sem_historia before delete on ordens
  for each row execute function fn_ordem_sem_historia();

-- ------------------------------------------------------------
-- 2. Cancelar início: avisa (na tela) e apaga os testes junto
-- ------------------------------------------------------------
create or replace function cancelar_inicio(p_ordem uuid, p_detalhe text) returns void as $$
begin
  if not tem_acao('execucao','apontar') then
    raise exception 'Perfil sem permissao para apontar producao';
  end if;
  insert into tsi.ordem_auditoria (ordem_id, acao, detalhe, usuario_id)
  values (p_ordem, 'cancelou o início', p_detalhe, auth.uid());
  -- o status volta antes dos descartes: o trigger de imutabilidade
  -- só libera a ordem depois que ela deixa de estar em andamento
  update tsi.ordens set status = 'Programada', turno_id = null, fim_pendente = false
   where id = p_ordem and status in ('Em producao','Parada');
  if not found then
    raise exception 'A ordem nao esta em andamento';
  end if;
  delete from tsi.ordem_paradas where ordem_id = p_ordem;
  delete from tsi.ordem_eventos where ordem_id = p_ordem;
  delete from tsi.ordem_tanques where ordem_id = p_ordem;
  -- decisão de 05/08/2026: os testes de qualidade vão junto (a tela
  -- avisou) — deixá-los seria teste órfão numa ordem "nunca produzida"
  delete from tsi.qualidade_checks where ordem_id = p_ordem;
end $$ language plpgsql security definer set search_path = tsi, public;

-- ------------------------------------------------------------
-- Reparo: testes órfãos que o buraco deixou (teste de qualidade em
-- ordem que voltou para antes do início — sem evento de produção)
-- ------------------------------------------------------------
delete from qualidade_checks q
where not exists (select 1 from ordem_eventos e where e.ordem_id = q.ordem_id)
  and exists (select 1 from ordens o where o.id = q.ordem_id
              and o.status in ('Nao programada','Programada'));

-- ------------------------------------------------------------
-- Conferência
-- ------------------------------------------------------------
select 'trigger de exclusao' as verificacao, count(*)::text as resultado
from pg_trigger where tgname = 'tg_ordem_sem_historia'
union all
select 'testes orfaos restantes (deve ser 0)', count(*)::text
from qualidade_checks q
where not exists (select 1 from ordem_eventos e where e.ordem_id = q.ordem_id)
  and exists (select 1 from ordens o where o.id = q.ordem_id
              and o.status in ('Nao programada','Programada'));
