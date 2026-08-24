-- ============================================================
-- Ordem "fora do estoque" — produção que não vira saldo (24/08/2026)
-- Execute no SQL Editor do Supabase (idempotente)
-- RODAR ANTES do deploy do front desta feature (o front novo grava a
-- coluna nova ao criar ordem; com o banco antigo a criação falharia).
-- ============================================================
--
-- Pedido do Arion: as ordens da SACARIA são criadas em BG5M (bags normais),
-- mas a produção vai para o reensaque em sacos de 10/20 kg — não vira
-- estoque vendável e não tem pedido. A isenção por embalagem (SC10/SC20)
-- não cobre: é a MESMA embalagem BG5M das ordens normais. Daí a marcação
-- por ORDEM: `fora_balanco`.
--
-- Efeito: a ordem some de `ordens_abertas` na v_balanco_demanda (não conta
-- como planejado, não gera alarme "sem pedido"). NADA MAIS muda — execução,
-- tempos, indicadores, qualidade e a baixa do lote (consome o lote
-- normalmente, proporcional ao peso) seguem iguais.
--
-- GATILHOS FICAM INTACTOS DE PROPÓSITO (armadilha documentada no
-- PENDENCIAS de coluna nova em `ordens`, conferida antes):
-- · fn_ordem_imutavel trava uma lista ESPECÍFICA de colunas em ordem
--   tocada; `fora_balanco` fora da lista = editável em qualquer status —
--   é o que o Arion pediu ("informar em qualquer status dela"), e não há
--   ERP externo pra divergir (ao contrário do `numero`/AGROTIS).
-- · fn_ordens_por_acao: coluna fora da lista `ignorar` cai no catch-all
--   que exige `ordens/editar` — exatamente quem deve mexer nisso.
-- ============================================================

set search_path = tsi, public;

alter table ordens add column if not exists fora_balanco boolean not null default false;

comment on column ordens.fora_balanco is
  'Produção que NÃO vira estoque vendável (ex.: bags pra reensaque na sacaria). Fora de ordens_abertas no balanço de demanda; baixa do lote e execução normais.';

-- ------------------------------------------------------------
-- v_balanco_demanda: ordens fora do balanço somem de ordens_abertas.
-- Cópia da versão atual (pedido-cooperado.sql, 24/08/2026) mudando só o
-- CTE `abe`; create or replace serve — nenhuma coluna muda.
-- ------------------------------------------------------------
create or replace view v_balanco_demanda as
with ult_ped as (select id from cargas_demanda where tipo='pedidos' order by criada_em desc limit 1),
     ult_est as (select id from cargas_demanda where tipo='estoque' order by criada_em desc limit 1),
ped as (select cultivar, tratamento, embalagem,
               sum(bags) filter (where aprovado)     as ped_aprov,
               sum(bags) filter (where not aprovado) as ped_pend,
               sum(bags) filter (where aprovado and cooperado)     as ped_coop,
               sum(bags) filter (where not aprovado and cooperado) as ped_coop_pend
        from pedidos_venda where carga_id = (select id from ult_ped) group by 1,2,3),
est as (select cultivar, tratamento, embalagem, sum(bags) as est_bags
        from estoque_pa where carga_id = (select id from ult_est) group by 1,2,3),
abe as (select o.cultivar, r.nome as tratamento, o.embalagem, sum(o.bags) as abertas
        from ordens o join receitas r on r.id = o.receita_id
        where o.status <> 'Apontada' and not o.fora_balanco group by 1,2,3)
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
       coalesce(p.ped_coop_pend,0) as pedido_cooperado_pendente
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
select 'coluna fora_balanco' as item, (count(*) = 1)::text as ok
  from information_schema.columns
 where table_schema = 'tsi' and table_name = 'ordens' and column_name = 'fora_balanco'
union all
select 'view filtra fora_balanco',
       (position('fora_balanco' in pg_get_viewdef('tsi.v_balanco_demanda'::regclass)) > 0)::text
union all
select 'view manteve security_invoker',
       (position('security_invoker=true' in array_to_string(c.reloptions, ',')) > 0)::text
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
 where ns.nspname = 'tsi' and c.relname = 'v_balanco_demanda'
union all
-- nenhuma ordem nasce marcada: o default é false para todas as existentes
select 'nenhuma ordem marcada ainda', (count(*) = 0)::text
  from ordens where fora_balanco;
