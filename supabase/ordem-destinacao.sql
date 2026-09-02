-- ============================================================
-- Ordem de produção: campo DESTINAÇÃO — 31/08/2026
-- Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- Pedido do Arion (31/08/2026): a ordem de produção ganha o campo
-- Destinação, obrigatório ao montar a ordem (obrigatoriedade é do
-- formulário — a coluna fica nullable pra não quebrar ordens antigas nem
-- a importação por planilha, que não traz o campo).
--
-- Bônus que fecha o ciclo: quando a ordem vira "Qualidade apontada" e o
-- lote tratado cai no mapa, ele já nasce com a destinação da ordem — o
-- aviso vermelho do loteamento funciona sem esperar o upload do SAP.
-- (Se o mapa já tem destinação naquela combinação, ela é mantida; a da
-- ordem só preenche o vazio. O upload do SAP continua carimbando depois.)
--
-- fn_ordem_imutavel trava uma lista ESPECÍFICA de colunas — destinacao
-- fica editável como fora_balanco, de propósito (é etiqueta de rota, não
-- entra em cálculo nenhum).
-- ============================================================

set search_path = tsi, public;

alter table ordens add column if not exists destinacao text;

comment on column ordens.destinacao is
  'Destinação da produção (COMIGO, Multiplicação, GDM…). Obrigatória no formulário; herdada pelo lote tratado no mapa quando a ordem é apontada.';

-- ------------------------------------------------------------
-- v_ordens é `select o.*` mas a lista de colunas CONGELA na criação:
-- recria a view e toda a cadeia dependente (cópia fiel do bloco de
-- exclusao-vira-status.sql, 25/08/2026 — nada muda além da coluna nova
-- passar a existir no o.*).
-- ------------------------------------------------------------
drop view if exists v_ordens cascade;

create view v_ordens as
select o.*,
  case
    when o.status in ('Em producao','Parada','Finalizada','Qualidade apontada','Apontada','Excluida')
      then o.status::text
    when o.maquina_id is null then 'Nao programada'
    when o.confirmada_em is null then 'Programada'
    when o.lote_liberado_em is null then 'Aguardando lote'
    else 'Pronto para produzir'
  end as status_efetivo,
  ls.peso_bag_kg,
  ls.pms,
  coalesce(nullif(e.peso_fixo_kg, 0), nullif(ls.pms * e.fator_peso, 0), ls.peso_bag_kg)            as peso_bag_ordem_kg,
  o.bags * coalesce(nullif(e.peso_fixo_kg, 0), nullif(ls.pms * e.fator_peso, 0), ls.peso_bag_kg)          as peso_kg,
  o.bags * coalesce(nullif(e.peso_fixo_kg, 0), nullif(ls.pms * e.fator_peso, 0), ls.peso_bag_kg) / 1000.0 as peso_t,
  r.nome                            as receita_nome
from ordens o
join lotes_semente ls on ls.id = o.lote_id
join embalagens e     on e.codigo = o.embalagem
join receitas r       on r.id = o.receita_id;

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

-- ordem excluída nunca conta como "programado" de máquina/dia nenhuma
create view v_ocupacao as
select o.maquina_id, o.data_prog,
       sum(o.peso_t)                                        as programado_t,
       m.capacidade_th * (select sum(horas) from turnos)     as capacidade_t,
       sum(o.peso_t) / (m.capacidade_th * (select sum(horas) from turnos)) * 100 as ocupacao_pct
from v_ordens o join maquinas m on m.id = o.maquina_id
where o.maquina_id is not null and o.status <> 'Excluida'
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

-- ------------------------------------------------------------
-- O lote tratado nasce no mapa com a DESTINAÇÃO da ordem (função regravada
-- a partir da versão da varredura de 30/08 — única mudança: destinacao).
-- Combinação que já existe com destinação mantém a que tem; a da ordem só
-- preenche o vazio (o upload do SAP segue carimbando por cima).
-- ------------------------------------------------------------
create or replace function fn_lote_tratado_no_mapa() returns trigger
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_receita text;
  v_ls      lotes_semente%rowtype;
  v_emb     embalagens%rowtype;
  v_peso    numeric;
  v_bags    numeric;
begin
  select nome into v_receita from receitas where id = new.receita_id;
  if v_receita is null or upper(trim(v_receita)) = 'SEM TSI' then
    return new;
  end if;

  select * into v_ls from lotes_semente where id = new.lote_id;
  if not found then
    return new;
  end if;
  select * into v_emb from embalagens where codigo = new.embalagem;

  v_peso := coalesce(
    nullif(v_emb.peso_fixo_kg, 0),
    v_ls.pms * v_emb.fator_peso,
    v_ls.peso_bag_kg,
    0
  );
  v_bags := coalesce(new.bags_produzidos, new.bags);

  insert into lotes_mapa
    (lote, tratamento, cultivar, embalagem, pms, peso_bag_kg, bags,
     destinacao, classificacao, peneira, categoria, atualizado_em)
  values
    (new.lote_id, v_receita, v_ls.cultivar, new.embalagem, v_ls.pms,
     v_peso, v_bags, nullif(trim(coalesce(new.destinacao, '')), ''), null,
     v_ls.peneira, v_ls.categoria, now())
  on conflict (lote, tratamento) do update
    set bags = lotes_mapa.bags
             + case
                 when coalesce(lotes_mapa.peso_bag_kg, 0) > 0
                  and coalesce(excluded.peso_bag_kg, 0) > 0
                  and lotes_mapa.peso_bag_kg <> excluded.peso_bag_kg
                 then excluded.bags * excluded.peso_bag_kg / lotes_mapa.peso_bag_kg
                 else excluded.bags
               end,
        destinacao = coalesce(lotes_mapa.destinacao, excluded.destinacao),
        atualizado_em = now();

  if v_ls.peso_bag_kg > 0 and v_peso > 0 then
    update lotes_mapa
       set bags = greatest(0, bags - (v_bags * v_peso / v_ls.peso_bag_kg)),
           atualizado_em = now()
     where lote = new.lote_id and tratamento = 'SEM TSI';
  end if;

  return new;
end $$;

-- ============================================================
-- Conferência
-- ============================================================
-- select column_name from information_schema.columns
--   where table_schema='tsi' and table_name='ordens' and column_name='destinacao';
-- select destinacao from v_ordens limit 1;  -- a view expõe a coluna nova
