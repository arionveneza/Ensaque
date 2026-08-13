-- ============================================================
-- Peso da ordem passa a usar a EMBALAGEM DA ORDEM (13/08/2026)
--
-- O peso de semente de uma ordem era `bags × lotes_semente.peso_bag_kg` —
-- e o peso_bag_kg do lote é congelado na importação com o fator da
-- embalagem ORIGINAL do lote (big bag = PMS×5, meio bag = PMS×2,5). Uma
-- ordem MEIOBAG produzida de um lote big bag saía com o DOBRO de peso em
-- tudo: peso de semente, químico planejado, ensaque, tempo planejado e
-- ocupação ("o cálculo do meio bag tá estranho", 13/08/2026).
--
-- O peso certo do bag DA ORDEM é `PMS × fator da embalagem da ordem`
-- (CLAUDE.md §1). Fallback quando o lote não tem PMS (coluna nullable,
-- casos raros de cadastro manual): mantém o peso_bag_kg do lote, o
-- comportamento antigo — sem PMS não há como recalcular.
--
-- `baixar_lote`/lote_movimentos NÃO mudam de propósito: a logística
-- movimenta os bags FÍSICOS do lote (semente branca na embalagem original),
-- então o peso do movimento é mesmo o do lote.
-- ============================================================

drop view if exists v_ordens cascade;

create view v_ordens as
select o.*,
  case
    when o.status in ('Em producao','Parada','Finalizada','Qualidade apontada','Apontada')
      then o.status::text
    when o.maquina_id is null then 'Nao programada'
    when o.confirmada_em is null then 'Programada'
    when o.lote_liberado_em is null then 'Aguardando lote'
    else 'Pronto para produzir'
  end as status_efetivo,
  ls.peso_bag_kg,
  ls.pms,
  coalesce(ls.pms * e.fator_peso, ls.peso_bag_kg)            as peso_bag_ordem_kg,
  o.bags * coalesce(ls.pms * e.fator_peso, ls.peso_bag_kg)          as peso_kg,
  o.bags * coalesce(ls.pms * e.fator_peso, ls.peso_bag_kg) / 1000.0 as peso_t,
  r.nome                            as receita_nome
from ordens o
join lotes_semente ls on ls.id = o.lote_id
join embalagens e     on e.codigo = o.embalagem
join receitas r       on r.id = o.receita_id;

-- ---- cadeia dependente, idêntica à versão anterior
-- (confirmar-ordem-programada.sql) — o peso novo entra por o.peso_kg/peso_t
create view v_ordem_itens_planejado as
select o.id as ordem_id, op.tanque, ri.produto_id, pq.codigo, pq.nome, pq.unidade,
       pq.densidade, ri.dose,
       case when pq.unidade::text like 'ml%'
            then ri.dose * o.peso_kg * coalesce(pq.densidade,1) / 1000.0
            else ri.dose * o.peso_kg / 1000.0
       end / (case when pq.unidade::text like '%/100kg' then 100 else 1 end)
         as peso_planejado_kg,
       case when pq.unidade::text like 'ml%'
            then ri.dose * o.peso_kg / 1000.0
                 / (case when pq.unidade::text like '%/100kg' then 100 else 1 end)
       end as volume_planejado_l
from v_ordens o
join receita_itens ri on ri.receita_id = o.receita_id
join ordem_produtos op on op.ordem_id = o.id and op.produto_id = ri.produto_id
join produtos_quimicos pq on pq.id = ri.produto_id;

create view v_ordem_tanque_consumo as
with abast as (
  select tanque_id, sum(peso_kg) as abastecido_kg
    from ordem_tanque_abastecimentos
   group by 1
)
select ot.ordem_id, ot.tanque, ot.peso_inicial, ot.peso_final,
       coalesce(a.abastecido_kg, 0) as abastecido_kg,
       p.planejado_kg,
       case when ot.peso_inicial is not null and ot.peso_final is not null
            then greatest(0, ot.peso_inicial + coalesce(a.abastecido_kg, 0) - ot.peso_final)
       end as real_kg,
       case when ot.peso_inicial is not null and ot.peso_final is not null and p.planejado_kg > 0
            then (greatest(0, ot.peso_inicial + coalesce(a.abastecido_kg, 0) - ot.peso_final)
                  - p.planejado_kg) / p.planejado_kg * 100
       end as desvio_pct
from ordem_tanques ot
join (select ordem_id, tanque, sum(peso_planejado_kg) as planejado_kg
      from v_ordem_itens_planejado group by 1,2) p
  on p.ordem_id = ot.ordem_id and p.tanque = ot.tanque
left join abast a on a.tanque_id = ot.id;

create view v_ordem_tempos as
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

create view v_ocupacao as
select o.maquina_id, o.data_prog,
       sum(o.peso_t)                                        as programado_t,
       m.capacidade_th * (select sum(horas) from turnos)     as capacidade_t,
       sum(o.peso_t) / (m.capacidade_th * (select sum(horas) from turnos)) * 100 as ocupacao_pct
from v_ordens o join maquinas m on m.id = o.maquina_id
where o.maquina_id is not null
group by 1,2, m.capacidade_th;

create view v_ordem_etapas as
select o.*,
       coalesce(qp.qtd, 0)          as checks_processo,
       (qf.ordem_id is not null)    as tem_qualidade_final,
       (c.ordem_id  is not null)    as conferida,
       c.bags_contados
from v_ordens o
left join (select ordem_id, count(*) as qtd
             from qualidade_checks where etapa = 'processo' group by 1) qp
       on qp.ordem_id = o.id
left join (select distinct ordem_id
             from qualidade_checks where etapa = 'final') qf
       on qf.ordem_id = o.id
left join ordem_conferencias c on c.ordem_id = o.id;

alter view v_ordens                set (security_invoker = true);
alter view v_ordem_itens_planejado set (security_invoker = true);
alter view v_ordem_tanque_consumo  set (security_invoker = true);
alter view v_ordem_tempos          set (security_invoker = true);
alter view v_ocupacao              set (security_invoker = true);
alter view v_ordem_etapas          set (security_invoker = true);

grant select on v_ordens, v_ordem_itens_planejado, v_ordem_tanque_consumo,
                v_ordem_tempos, v_ocupacao, v_ordem_etapas to authenticated;

-- ============================================================
-- Conferência: ordens em que o peso MUDOU com a correção (embalagem da
-- ordem diferente da conta antiga). Esperado: só ordens MEIOBAG de lote
-- big bag (peso cai pela metade) ou o inverso (dobra).
-- ============================================================
select o.numero, o.embalagem, o.bags, ls.pms,
       ls.peso_bag_kg                                   as bag_lote_kg,
       round(coalesce(ls.pms * e.fator_peso, ls.peso_bag_kg), 1) as bag_ordem_kg,
       round(o.bags * ls.peso_bag_kg / 1000.0, 2)               as peso_t_antigo,
       round(o.bags * coalesce(ls.pms * e.fator_peso, ls.peso_bag_kg) / 1000.0, 2) as peso_t_novo,
       o.status
from ordens o
join lotes_semente ls on ls.id = o.lote_id
join embalagens e     on e.codigo = o.embalagem
where coalesce(ls.pms * e.fator_peso, ls.peso_bag_kg) <> ls.peso_bag_kg
order by o.numero;
