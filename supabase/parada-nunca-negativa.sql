-- ============================================================
-- Parada nunca negativa — relógios de cliente e servidor divergem
--
-- Caso real encontrado em 05/08/2026 na ordem 131104: a parada tinha
-- `inicio` 19:41:43 (default now(), relógio do SERVIDOR) e `fim`
-- 17:44:07 (gravado pelo app com new Date(), relógio do NAVEGADOR) —
-- quase 2 h antes do início. Duração negativa => liquido_s (2h23) maior
-- que bruto_s (26min), aderência e disponibilidade sem sentido.
--
-- A CAUSA já está fechada: desde matriz-permissoes-no-banco.sql todo
-- horário de apontamento vem do servidor, dentro das RPCs
-- (registrar_parada, retomar_producao, confirmar_fim). Este script trata
-- o que sobrou e impede a reincidência por qualquer outro caminho.
--
-- Ainda dependem do relógio do navegador (informativos, não entram em
-- cálculo de duração): ordem_conferencias.ts, prioridade_em, agrotis_em.
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 1. Reparo: parada que "terminou antes de começar" vira duração zero
-- O horário do navegador é o suspeito, não o do servidor — então o
-- início (servidor) manda e o fim é puxado para junto dele.
-- ------------------------------------------------------------
update ordem_paradas set fim = inicio where fim is not null and fim < inicio;

-- ------------------------------------------------------------
-- 2. Trava: o banco recusa parada terminando antes de começar
-- ------------------------------------------------------------
alter table ordem_paradas drop constraint if exists parada_fim_apos_inicio;
alter table ordem_paradas add constraint parada_fim_apos_inicio
  check (fim is null or fim >= inicio);

-- ------------------------------------------------------------
-- 3. Cinto e suspensório: a view não deixa passar duração negativa
-- nem líquido maior que o bruto (o domínio no app já faz o mesmo).
-- Mesmas colunas de antes — create or replace basta.
-- ------------------------------------------------------------
create or replace view v_ordem_tempos as
with ev as (
  select ordem_id,
         min(ts) filter (where tipo='inicio') as ini,
         max(ts) filter (where tipo='fim')    as fim
  from ordem_eventos group by 1),
par as (
  select p.ordem_id,
    sum(greatest(0, extract(epoch from (coalesce(p.fim, now()) - p.inicio))))                                    as par_total,
    sum(greatest(0, extract(epoch from (coalesce(p.fim, now()) - p.inicio)))) filter (where m.tipo='Planejada')   as par_plan,
    sum(greatest(0, extract(epoch from (coalesce(p.fim, now()) - p.inicio)))) filter (where m.tipo='Nao planejada') as par_nplan
  from ordem_paradas p join motivos_parada m on m.id = p.motivo_id group by 1)
select o.id as ordem_id, o.numero, o.maquina_id, o.data_prog, o.turno_id, o.peso_t,
  ev.ini, ev.fim,
  greatest(0, extract(epoch from (coalesce(ev.fim, now()) - ev.ini)))        as bruto_s,
  coalesce(par.par_total,0)                                                  as paradas_s,
  coalesce(par.par_plan,0)                                                   as paradas_plan_s,
  coalesce(par.par_nplan,0)                                                  as paradas_nplan_s,
  greatest(0, extract(epoch from (coalesce(ev.fim, now()) - ev.ini))
              - coalesce(par.par_total,0))                                   as liquido_s,
  o.peso_t / m.capacidade_th * 3600                                          as planejado_s
from v_ordens o
join maquinas m on m.id = o.maquina_id
left join ev  on ev.ordem_id = o.id
left join par on par.ordem_id = o.id
where ev.ini is not null;
alter view v_ordem_tempos set (security_invoker = true);
grant select on v_ordem_tempos to authenticated;

-- ------------------------------------------------------------
-- Conferência: nenhuma parada invertida, nenhum líquido > bruto
-- ------------------------------------------------------------
select 'paradas invertidas (deve ser 0)' as verificacao, count(*)::text as resultado
from ordem_paradas where fim is not null and fim < inicio
union all
select 'ordens com liquido > bruto (deve ser 0)', count(*)::text
from v_ordem_tempos where liquido_s > bruto_s + 0.001;
