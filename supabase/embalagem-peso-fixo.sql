-- ============================================================
-- Embalagens de PESO FIXO (10 kg e 20 kg) — 24/08/2026
-- Execute no SQL Editor do Supabase (idempotente)
-- RODAR ANTES do deploy do front desta feature: o front novo pede
-- `embalagens.peso_fixo_kg` no select embutido das ordens — com o banco
-- antigo, a tela Execução inteira cai. (Front antigo + banco novo convive.)
-- ============================================================
--
-- Pedido do Arion (24/08/2026): produzir em sacos de 10 e 20 kg. As duas
-- embalagens de hoje são definidas por QUANTIDADE DE SEMENTES (peso do bag
-- = PMS × fator, varia por lote); as novas são o contrário — peso fixo por
-- saco, não importa o PMS. Pedido e saldo dessas embalagens NÃO existem no
-- SAP nem na SimpleAgro (tudo manual no TSI), então nenhum importador as
-- conhece — e o front as isenta do painel de demanda, como o SEM TSI.
--
-- Precedência do peso do bag da ordem, idêntica no front e aqui:
--   peso_fixo_kg (>0)  →  pms × fator_peso (>0)  →  lotes_semente.peso_bag_kg
--
-- O `nullif(..., 0)` também fecha uma divergência pré-existente: com
-- fator_peso 0 o front caía no fallback (guard `> 0`) mas o SQL produzia
-- ordem de 0 kg (`pms × 0` não é null e o coalesce parava ali).
--
-- A baixa do lote generaliza sozinha: 1 saco de 10 kg consome
-- 10/peso_bag_do_lote bags do lote — mesma conta proporcional ao peso que
-- o MEIOBAG já usa (peso-por-embalagem-na-baixa-do-lote.sql).
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 1. Coluna nova + modos válidos
-- ------------------------------------------------------------
alter table embalagens add column if not exists peso_fixo_kg numeric(10,3);

comment on column embalagens.peso_fixo_kg is
  'Peso fixo por saco (kg). Preenchido = embalagem por peso (10/20 kg), vence o PMS × fator. Nulo = embalagem por sementes (BG5M/MEIOBAG).';

-- embalagem por kg não tem contagem de sementes nem fator
alter table embalagens alter column sementes drop not null;
alter table embalagens alter column fator_peso drop not null;

-- toda embalagem é OU por sementes OU por peso fixo — nunca nenhum dos dois
alter table embalagens drop constraint if exists embalagem_modo_valido;
alter table embalagens add constraint embalagem_modo_valido
  check (peso_fixo_kg > 0 or (sementes > 0 and fator_peso > 0));

insert into embalagens (codigo, codigo_ext, descricao, sementes, fator_peso, peso_fixo_kg) values
  ('SC10', null, 'Saco 10 kg', null, null, 10),
  ('SC20', null, 'Saco 20 kg', null, null, 20)
on conflict (codigo) do nothing;

-- ------------------------------------------------------------
-- 2. Cadeia de views com a precedência nova
--    (DROP + CREATE: replace não muda expressão de coluna — 42P16)
-- ------------------------------------------------------------
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
  coalesce(nullif(e.peso_fixo_kg, 0), nullif(ls.pms * e.fator_peso, 0), ls.peso_bag_kg)            as peso_bag_ordem_kg,
  o.bags * coalesce(nullif(e.peso_fixo_kg, 0), nullif(ls.pms * e.fator_peso, 0), ls.peso_bag_kg)          as peso_kg,
  o.bags * coalesce(nullif(e.peso_fixo_kg, 0), nullif(ls.pms * e.fator_peso, 0), ls.peso_bag_kg) / 1000.0 as peso_t,
  r.nome                            as receita_nome
from ordens o
join lotes_semente ls on ls.id = o.lote_id
join embalagens e     on e.codigo = o.embalagem
join receitas r       on r.id = o.receita_id;

-- ---- cadeia dependente, idêntica à versão anterior
-- (peso-por-embalagem-da-ordem.sql) — o peso novo entra por o.peso_kg/peso_t
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

-- view recriada volta sem security_invoker e sem grants: sem isto ela roda
-- com os privilégios de quem criou e passa por cima do RLS
alter view v_ordens                set (security_invoker = true);
alter view v_ordem_itens_planejado set (security_invoker = true);
alter view v_ordem_tanque_consumo  set (security_invoker = true);
alter view v_ordem_tempos          set (security_invoker = true);
alter view v_ocupacao              set (security_invoker = true);
alter view v_ordem_etapas          set (security_invoker = true);

grant select on v_ordens, v_ordem_itens_planejado, v_ordem_tanque_consumo,
                v_ordem_tempos, v_ocupacao, v_ordem_etapas to authenticated;

-- ------------------------------------------------------------
-- 3. baixar_lote com a mesma precedência — 1 saco de 10 kg consome
--    10/peso_bag_do_lote bags do lote (proporcional ao peso, como MEIOBAG)
-- ------------------------------------------------------------
create or replace function baixar_lote(p_lote text) returns void as $$
declare
  v_bags numeric;
  v_peso_t numeric;
begin
  if not pode_baixar_lote() then
    raise exception 'Perfil sem permissao para baixar lote';
  end if;

  with liberadas as (
    update tsi.ordens
       set lote_liberado_em = now(), lote_liberado_por = auth.uid()
     where lote_id = p_lote
       and lote_liberado_em is null
       and maquina_id is not null
       and confirmada_em is not null
       and status not in ('Em producao','Parada','Finalizada','Qualidade apontada','Apontada')
    returning bags, embalagem
  )
  select
    coalesce(sum(l.bags), 0),
    coalesce(sum(l.bags * coalesce(nullif(e.peso_fixo_kg, 0), nullif(ls.pms * e.fator_peso, 0), ls.peso_bag_kg)), 0) / 1000.0
    into v_bags, v_peso_t
  from liberadas l
  join tsi.lotes_semente ls on ls.id = p_lote
  join tsi.embalagens e     on e.codigo = l.embalagem;

  if v_bags = 0 then
    raise exception 'Nao ha ordem confirmada deste lote esperando liberacao';
  end if;

  -- tg_baixa_so_pela_rpc (matriz-permissoes-no-banco.sql) recusa qualquer
  -- update de status/baixado_* em lotes_semente fora desta flag de sessao.
  perform set_config('tsi.baixa_via_rpc', '1', true);

  update tsi.lotes_semente
     set status = 'Baixado',
         baixado_por = coalesce(baixado_por, auth.uid()),
         baixado_em = coalesce(baixado_em, now())
   where id = p_lote;

  insert into tsi.lote_movimentos (lote_id, bags, peso_t, estorno, usuario_id)
  values (p_lote, v_bags, v_peso_t, false, auth.uid());
end $$ language plpgsql security definer set search_path = tsi, public;

revoke execute on function baixar_lote(text) from public, anon;
grant execute on function baixar_lote(text) to authenticated;

-- ------------------------------------------------------------
-- Conferência
-- ------------------------------------------------------------
select 'coluna peso_fixo_kg' as item, (count(*) = 1)::text as ok
  from information_schema.columns
 where table_schema = 'tsi' and table_name = 'embalagens' and column_name = 'peso_fixo_kg'
union all
select 'check embalagem_modo_valido', (count(*) = 1)::text
  from information_schema.check_constraints
 where constraint_schema = 'tsi' and constraint_name = 'embalagem_modo_valido'
union all
select 'SC10 e SC20 no cadastro', (count(*) = 2)::text
  from embalagens where codigo in ('SC10','SC20') and peso_fixo_kg > 0
union all
select 'v_ordens com peso_fixo_kg',
       (position('peso_fixo_kg' in pg_get_viewdef('tsi.v_ordens'::regclass)) > 0)::text
union all
select 'baixar_lote com peso_fixo_kg', (position('peso_fixo_kg' in prosrc) > 0)::text
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
 where ns.nspname = 'tsi' and p.proname = 'baixar_lote'
union all
select 'security_invoker nas 6 views', (count(*) = 6)::text
  from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
 where ns.nspname = 'tsi'
   and c.relname in ('v_ordens','v_ordem_itens_planejado','v_ordem_tanque_consumo',
                     'v_ordem_tempos','v_ocupacao','v_ordem_etapas')
   and position('security_invoker=true' in array_to_string(c.reloptions, ',')) > 0
union all
-- nenhuma ordem existente muda de peso com esta migração (nenhuma é SC10/SC20
-- ainda, e o nullif só muda resultado se houvesse fator 0, que não há)
select 'nenhuma ordem muda de peso', (count(*) = 0)::text
from ordens o
join lotes_semente ls on ls.id = o.lote_id
join embalagens e     on e.codigo = o.embalagem
where coalesce(nullif(e.peso_fixo_kg, 0), nullif(ls.pms * e.fator_peso, 0), ls.peso_bag_kg)
   is distinct from coalesce(ls.pms * e.fator_peso, ls.peso_bag_kg);
