-- ============================================================
-- Pedido de VENDA COOPERADO destacado no balanço de demanda
-- Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- Pedido do Arion (21/08/2026): a coluna L (`Tipo Venda`) do relatório de
-- Pedidos da SimpleAgro marca VENDA COOPERADO, e esse compromisso tem peso
-- diferente pro PCP — "tenho 100 bags, destes 20 são de VENDA COOPERADO"
-- precisa aparecer na linha do painel Demanda × Estoque × Planejado.
--
-- O importador passa a dividir a combinação em linha própria quando é
-- cooperado (mesmo desenho do flag `aprovado`), e a v_balanco_demanda soma
-- a parcela cooperada do pedido aprovado numa coluna nova no FIM da view
-- (create or replace só aceita acrescentar coluna no fim — mudar/remover
-- é 42P16).
-- ============================================================

set search_path = tsi, public;

alter table pedidos_venda add column if not exists cooperado boolean not null default false;

comment on column pedidos_venda.cooperado is
  'Coluna L `Tipo Venda` = VENDA COOPERADO no relatório da SimpleAgro. Divide a combinação em linha própria, como `aprovado`.';

create or replace view v_balanco_demanda as
with ult_ped as (select id from cargas_demanda where tipo='pedidos' order by criada_em desc limit 1),
     ult_est as (select id from cargas_demanda where tipo='estoque' order by criada_em desc limit 1),
ped as (select cultivar, tratamento, embalagem,
               sum(bags) filter (where aprovado)     as ped_aprov,
               sum(bags) filter (where not aprovado) as ped_pend,
               sum(bags) filter (where aprovado and cooperado) as ped_coop
        from pedidos_venda where carga_id = (select id from ult_ped) group by 1,2,3),
est as (select cultivar, tratamento, embalagem, sum(bags) as est_bags
        from estoque_pa where carga_id = (select id from ult_est) group by 1,2,3),
abe as (select o.cultivar, r.nome as tratamento, o.embalagem, sum(o.bags) as abertas
        from ordens o join receitas r on r.id = o.receita_id
        where o.status <> 'Apontada' group by 1,2,3)
select coalesce(p.cultivar, e.cultivar, a.cultivar)       as cultivar,
       coalesce(p.tratamento, e.tratamento, a.tratamento) as tratamento,
       coalesce(p.embalagem, e.embalagem, a.embalagem)    as embalagem,
       coalesce(p.ped_aprov,0) as pedido_aprovado,
       coalesce(p.ped_pend,0)  as pedido_pendente,
       coalesce(e.est_bags,0)  as estoque_pa,
       coalesce(a.abertas,0)   as ordens_abertas,
       coalesce(p.ped_aprov,0) - coalesce(e.est_bags,0) - coalesce(a.abertas,0) as saldo,
       exists(select 1 from receitas r where r.nome = coalesce(p.tratamento,e.tratamento,a.tratamento))
         as receita_cadastrada,
       coalesce(p.ped_coop,0)  as pedido_cooperado
from ped p
full join est e on (e.cultivar,e.tratamento,e.embalagem) = (p.cultivar,p.tratamento,p.embalagem)
full join abe a on (a.cultivar,a.tratamento,a.embalagem) = (coalesce(p.cultivar,e.cultivar),
                                                            coalesce(p.tratamento,e.tratamento),
                                                            coalesce(p.embalagem,e.embalagem));

-- view sem security_invoker roda com os privilégios de quem criou e fura o RLS
alter view v_balanco_demanda set (security_invoker = true);

-- ------------------------------------------------------------
-- Conferência
-- ------------------------------------------------------------
select 'coluna cooperado' as item, (count(*) = 1)::text as ok
  from information_schema.columns
 where table_schema = 'tsi' and table_name = 'pedidos_venda' and column_name = 'cooperado'
union all
select 'view com pedido_cooperado', (count(*) = 1)::text
  from information_schema.columns
 where table_schema = 'tsi' and table_name = 'v_balanco_demanda' and column_name = 'pedido_cooperado'
union all
select 'view manteve security_invoker',
       (position('security_invoker=true' in array_to_string(c.reloptions, ',')) > 0)::text
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
 where ns.nspname = 'tsi' and c.relname = 'v_balanco_demanda';
