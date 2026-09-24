-- ============================================================
-- Estoque futuro: o planejado passa a cobrir a ordem confirmada do começo
-- ao fim da produção (24/09/2026, achado do Arion: "o planejado não está
-- contando todas as ordens planejadas").
--
-- A 1ª versão (estoque-futuro.sql, 22/09) contava só Aguardando lote,
-- Pronto para produzir e Qualidade apontada — lido ao pé da letra do
-- pedido. O efeito era uma ordem SUMIR do estoque futuro enquanto estava
-- sendo produzida (Em producao/Parada/Finalizada) e voltar na Qualidade
-- apontada: no dia 24/09 a 154856 (NEO700 I2X · STDK + RCoMoNi, 26 bg,
-- Parada) não contava. Agora conta toda ordem confirmada até a Qualidade
-- apontada; fora continuam Nao programada e Programada sem confirmação.
--
-- (A outra parte do achado — ordem APONTADA depois do último saldo do SAP,
-- que saiu do planejado e ainda não está no saldo — é resolvida no front,
-- por listarApontadasAposSaldo: pôr Apontada aqui criaria linhas novas no
-- Balanço, que tem a regra própria "apontada sai e volta no próximo upload".)
--
-- Execute no SQL Editor do Supabase (idempotente). Base: a versão MAIS
-- RECENTE de v_balanco_demanda (estoque-futuro.sql, 22/09/2026) — grep -rl
-- v_balanco_demanda supabase/ antes de mexer aqui de novo.
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
               sum(bags) filter (where not aprovado and multiplicador) as ped_mult_pend,
               sum(faturado)                              as ped_fat,
               sum(faturado) filter (where cooperado)     as ped_fat_coop,
               sum(faturado) filter (where multiplicador) as ped_fat_mult
        from pedidos_venda where carga_id = (select id from ult_ped) group by 1,2,3),
est as (select cultivar, tratamento, embalagem, sum(bags) as est_bags
        from estoque_pa where carga_id = (select id from ult_est) group by 1,2,3),
abe as (select o.cultivar, r.nome as tratamento, o.embalagem,
               sum(o.bags) as abertas,
               -- toda ordem CONFIRMADA, do Aguardando lote até a Qualidade apontada,
               -- inclusive Em producao/Parada/Finalizada (24/09/2026: fora delas a
               -- ordem sumia do estoque futuro enquanto era produzida). Fora só
               -- Nao programada e Programada sem confirmação — ainda não é compromisso.
               sum(o.bags) filter (where
                 o.status in ('Em producao','Parada','Finalizada','Qualidade apontada')
                 or (o.maquina_id is not null and o.confirmada_em is not null)
               ) as planejado
        from ordens o join receitas r on r.id = o.receita_id
        where o.status not in ('Apontada','Excluida') and not o.fora_balanco
        group by 1,2,3)
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
       coalesce(p.ped_fat_mult,0)  as faturado_multiplicador,
       coalesce(a.planejado,0)     as planejado_confirmado
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
select 'view manteve as colunas de faturado',
       (count(*) = 3)::text
  from information_schema.columns
 where table_schema = 'tsi' and table_name = 'v_balanco_demanda'
   and column_name in ('faturado', 'faturado_cooperado', 'faturado_multiplicador')
union all
select 'view ganhou planejado_confirmado',
       (count(*) = 1)::text
  from information_schema.columns
 where table_schema = 'tsi' and table_name = 'v_balanco_demanda'
   and column_name = 'planejado_confirmado'
union all
select 'view manteve security_invoker',
       (position('security_invoker=true' in array_to_string(c.reloptions, ',')) > 0)::text
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
 where ns.nspname = 'tsi' and c.relname = 'v_balanco_demanda'
union all
-- planejado_confirmado nunca passa de ordens_abertas (é subconjunto por construção,
-- mesma origem/filtro de fora_balanco/Apontada/Excluida, só um FILTER a mais)
select 'planejado_confirmado <= ordens_abertas em toda linha',
       (not exists(select 1 from v_balanco_demanda where planejado_confirmado > ordens_abertas))::text
union all
-- em produção/parada/finalizada agora contam: nenhuma ordem confirmada aberta fora
select 'planejado cobre toda ordem confirmada (Em producao/Parada/Finalizada inclusive)',
       ((select coalesce(sum(planejado_confirmado),0) from v_balanco_demanda)
        = (select coalesce(sum(o.bags),0) from ordens o
            where o.status not in ('Apontada','Excluida') and not o.fora_balanco
              and (o.status in ('Em producao','Parada','Finalizada','Qualidade apontada')
                   or (o.maquina_id is not null and o.confirmada_em is not null))))::text;
