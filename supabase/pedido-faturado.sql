-- ============================================================
-- "Quanto já foi faturado" de cada combinação, com o recorte
-- cooperado/multiplicador (pedido do Arion, 21/09/2026): depois de ver a
-- coluna "a faturar" ele perguntou "e quanto já faturou de cooperado e
-- multiplicador?" — o Pedidos Analítico Resumido NUNCA trouxe essa
-- informação até agora (só o saldo residual, "Saldo a Faturar", que já
-- vem líquido do faturado).
--
-- Achado no arquivo real (docs/dados-exemplo/pedidos-simpleagro-2026-07-28.xlsx,
-- range de colunas BE-BW que o Arion apontou): `Quantidade` (BE) é o pedido
-- ORIGINAL, e `Quantidade = Quantidade Faturada (BK) + Saldo a Faturar (BW)`
-- é identidade exata em toda linha conferida (inclusive uma com saldo
-- negativo por reajuste). Uso `QTD Faturada - Devolvida` (BO) — a mesma
-- coisa, já líquida de devolução — por ser o número que a própria
-- SimpleAgro já calcula. As colunas com sufixo "SC" (sacas) são de OUTRA
-- unidade (confirmado pela soma total do arquivo: Quantidade=22007 bate
-- com Quantidade Faturada + Saldo a Faturar, mas Quantidade SC=549525 é
-- ~25× maior) — nunca usar coluna "SC" aqui.
--
-- NÃO é gated por `aprovado`: o arquivo real tem linha com Status
-- Financeiro "Não Aprovado" e Quantidade Faturada > 0 — faturamento é um
-- fato independente da aprovação financeira do saldo residual.
--
-- Execute no SQL Editor do Supabase (idempotente). Base: a versão MAIS
-- RECENTE de v_balanco_demanda (balanco-demanda-corrige-regressao.sql,
-- 20/09/2026) — grep -rl v_balanco_demanda supabase/ antes de mexer aqui de novo.
-- ============================================================

set search_path = tsi, public;

alter table pedidos_venda add column if not exists faturado numeric not null default 0;

create or replace view v_balanco_demanda as
with ult_ped as (select id from cargas_demanda where tipo='pedidos' order by criada_em desc limit 1),
     ult_est as (select id from cargas_demanda where tipo='estoque' order by criada_em desc limit 1),
ped as (select cultivar, tratamento, embalagem,
               sum(bags) filter (where aprovado)     as ped_aprov,
               sum(bags) filter (where not aprovado) as ped_pend,
               sum(bags) filter (where aprovado and cooperado)     as ped_coop,
               sum(bags) filter (where not aprovado and cooperado) as ped_coop_pend,
               sum(bags) filter (where aprovado and multiplicador)     as ped_mult,
               sum(bags) filter (where not aprovado and multiplicador) as ped_mult_pend,
               sum(faturado)                              as ped_fat,
               sum(faturado) filter (where cooperado)     as ped_fat_coop,
               sum(faturado) filter (where multiplicador) as ped_fat_mult
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
       coalesce(p.ped_mult_pend,0) as pedido_multiplicador_pendente,
       coalesce(p.ped_fat,0)       as faturado,
       coalesce(p.ped_fat_coop,0)  as faturado_cooperado,
       coalesce(p.ped_fat_mult,0)  as faturado_multiplicador
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
select 'view continua ignorando Excluida' as item,
       (position('Excluida' in pg_get_viewdef('tsi.v_balanco_demanda'::regclass)) > 0)::text as ok
union all
select 'view continua ignorando fora_balanco',
       (position('fora_balanco' in pg_get_viewdef('tsi.v_balanco_demanda'::regclass)) > 0)::text
union all
select 'view manteve as colunas de multiplicador',
       (count(*) = 2)::text
  from information_schema.columns
 where table_schema = 'tsi' and table_name = 'v_balanco_demanda'
   and column_name in ('pedido_multiplicador', 'pedido_multiplicador_pendente')
union all
select 'view ganhou as 3 colunas de faturado',
       (count(*) = 3)::text
  from information_schema.columns
 where table_schema = 'tsi' and table_name = 'v_balanco_demanda'
   and column_name in ('faturado', 'faturado_cooperado', 'faturado_multiplicador')
union all
select 'view manteve security_invoker',
       (position('security_invoker=true' in array_to_string(c.reloptions, ',')) > 0)::text
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
 where ns.nspname = 'tsi' and c.relname = 'v_balanco_demanda';
