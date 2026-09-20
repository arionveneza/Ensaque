-- ============================================================
-- CORREÇÃO: pedido-multiplicador.sql (20/09/2026) recriou a
-- v_balanco_demanda copiando o CTE `abe` de pedido-cooperado.sql (24/08),
-- sem ver que DUAS migrações posteriores já tinham corrigido esse mesmo
-- CTE: ordem-fora-do-estoque.sql (24/08, `and not o.fora_balanco`) e
-- exclusao-vira-status.sql (25/08, `status not in ('Apontada','Excluida')`).
-- Resultado: ordem fora do estoque (sacaria) e ordem excluída voltaram a
-- contar em `ordens_abertas` — achado do Arion, 20/09/2026, com o caso
-- real "0790 IPRO · V&P + RF + Lli" aparecendo com planejado = estoque.
--
-- Esta migração restaura o CTE `abe` para o estado correto (o de
-- exclusao-vira-status.sql) e MANTÉM as colunas de multiplicador.
-- Execute no SQL Editor do Supabase (idempotente).
-- ============================================================

set search_path = tsi, public;

create or replace view v_balanco_demanda as
with ult_ped as (select id from cargas_demanda where tipo='pedidos' order by criada_em desc limit 1),
     ult_est as (select id from cargas_demanda where tipo='estoque' order by criada_em desc limit 1),
ped as (select cultivar, tratamento, embalagem,
               sum(bags) filter (where aprovado)     as ped_aprov,
               sum(bags) filter (where not aprovado) as ped_pend,
               sum(bags) filter (where aprovado and cooperado)     as ped_coop,
               sum(bags) filter (where not aprovado and cooperado) as ped_coop_pend,
               sum(bags) filter (where aprovado and multiplicador)     as ped_mult,
               sum(bags) filter (where not aprovado and multiplicador) as ped_mult_pend
        from pedidos_venda where carga_id = (select id from ult_ped) group by 1,2,3),
est as (select cultivar, tratamento, embalagem, sum(bags) as est_bags
        from estoque_pa where carga_id = (select id from ult_est) group by 1,2,3),
abe as (select o.cultivar, r.nome as tratamento, o.embalagem, sum(o.bags) as abertas
        from ordens o join receitas r on r.id = o.receita_id
        where o.status not in ('Apontada','Excluida') and not o.fora_balanco group by 1,2,3)
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
       coalesce(p.ped_coop,0)      as pedido_cooperado,
       coalesce(p.ped_coop_pend,0) as pedido_cooperado_pendente,
       coalesce(p.ped_mult,0)      as pedido_multiplicador,
       coalesce(p.ped_mult_pend,0) as pedido_multiplicador_pendente
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
select 'view volta a ignorar Excluida' as item,
       (position('Excluida' in pg_get_viewdef('tsi.v_balanco_demanda'::regclass)) > 0)::text as ok
union all
select 'view volta a ignorar fora_balanco',
       (position('fora_balanco' in pg_get_viewdef('tsi.v_balanco_demanda'::regclass)) > 0)::text
union all
select 'view manteve as colunas de multiplicador',
       (count(*) = 2)::text
  from information_schema.columns
 where table_schema = 'tsi' and table_name = 'v_balanco_demanda'
   and column_name in ('pedido_multiplicador', 'pedido_multiplicador_pendente')
union all
select 'view manteve security_invoker',
       (position('security_invoker=true' in array_to_string(c.reloptions, ',')) > 0)::text
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
 where ns.nspname = 'tsi' and c.relname = 'v_balanco_demanda';
