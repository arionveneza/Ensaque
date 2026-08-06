-- ============================================================
-- Quantidade produzida na finalização + pesos finais no AGROTIS
-- Decisões de 05/08/2026:
--  - Ao confirmar a finalização, a produção informa OBRIGATORIAMENTE a
--    quantidade produzida (bags). Vai para ordens.bags_produzidos.
--  - O peso final dos tanques deixa de ser obrigatório na Execução:
--    o operador anota no papel (folha da ordem) e o PCP digita na tela
--    AGROTIS. O lançamento no AGROTIS passa a exigir todos os pesos.
--  - A conferência da logística continua em bags_contados; a
--    obrigatoriedade de digitar (sem pré-preenchimento) é do app.
--
-- Requer matriz-permissoes-no-banco.sql aplicado.
-- Executar no SQL Editor e publicar o app em seguida (o Confirmar
-- finalização novo chama confirmar_fim com dois argumentos).
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 1. A coluna
-- ------------------------------------------------------------
alter table ordens add column if not exists bags_produzidos int
  check (bags_produzidos is null or bags_produzidos > 0);

-- ------------------------------------------------------------
-- 2. Views: v_ordens é `select o.*` e a expansão congela na criação —
-- coluna nova não entra sozinha. Recria a cadeia inteira (as
-- dependentes caem junto no cascade), verbatim do schema.sql.
-- ------------------------------------------------------------
drop view if exists v_ordens cascade;

create view v_ordens as
select o.*,
  case
    when o.status in ('Em producao','Parada','Finalizada','Qualidade apontada','Apontada')
      then o.status::text
    when o.maquina_id is null then 'Nao programada'
    when ls.status = 'Em estoque' then 'Aguardando lote'
    else 'Pronto para produzir'
  end as status_efetivo,
  ls.peso_bag_kg,
  o.bags * ls.peso_bag_kg           as peso_kg,
  o.bags * ls.peso_bag_kg / 1000.0  as peso_t,
  r.nome                            as receita_nome
from ordens o
join lotes_semente ls on ls.id = o.lote_id
join receitas r       on r.id = o.receita_id;

create view v_ordem_itens_planejado as
select o.id as ordem_id, ri.tanque, ri.produto_id, pq.codigo, pq.nome, pq.unidade,
       pq.densidade, ri.dose,
       case when pq.unidade = 'ml/kg'
            then ri.dose * o.peso_kg * coalesce(pq.densidade,1) / 1000.0
            else ri.dose * o.peso_kg / 1000.0
       end as peso_planejado_kg,
       case when pq.unidade = 'ml/kg'
            then ri.dose * o.peso_kg / 1000.0 else null
       end as volume_planejado_l
from v_ordens o
join receita_itens ri on ri.receita_id = o.receita_id
join produtos_quimicos pq on pq.id = ri.produto_id;

create view v_ordem_tanque_consumo as
select ot.ordem_id, ot.tanque, ot.peso_inicial, ot.peso_final,
       p.planejado_kg,
       case when ot.peso_inicial is not null and ot.peso_final is not null
            then greatest(0, ot.peso_inicial - ot.peso_final) end as real_kg,
       case when ot.peso_inicial is not null and ot.peso_final is not null and p.planejado_kg > 0
            then (greatest(0, ot.peso_inicial - ot.peso_final) - p.planejado_kg)
                 / p.planejado_kg * 100 end as desvio_pct
from ordem_tanques ot
join (select ordem_id, tanque, sum(peso_planejado_kg) as planejado_kg
      from v_ordem_itens_planejado group by 1,2) p
  on p.ordem_id = ot.ordem_id and p.tanque = ot.tanque;

create view v_ordem_tempos as
with ev as (
  select ordem_id,
         min(ts) filter (where tipo='inicio') as ini,
         max(ts) filter (where tipo='fim')    as fim
  from ordem_eventos group by 1),
par as (
  select p.ordem_id,
    sum(extract(epoch from (coalesce(p.fim, now()) - p.inicio)))                                    as par_total,
    sum(extract(epoch from (coalesce(p.fim, now()) - p.inicio))) filter (where m.tipo='Planejada')   as par_plan,
    sum(extract(epoch from (coalesce(p.fim, now()) - p.inicio))) filter (where m.tipo='Nao planejada') as par_nplan
  from ordem_paradas p join motivos_parada m on m.id = p.motivo_id group by 1)
select o.id as ordem_id, o.numero, o.maquina_id, o.data_prog, o.turno_id, o.peso_t,
  ev.ini, ev.fim,
  extract(epoch from (coalesce(ev.fim, now()) - ev.ini))                     as bruto_s,
  coalesce(par.par_total,0)                                                  as paradas_s,
  coalesce(par.par_plan,0)                                                   as paradas_plan_s,
  coalesce(par.par_nplan,0)                                                  as paradas_nplan_s,
  extract(epoch from (coalesce(ev.fim, now()) - ev.ini)) - coalesce(par.par_total,0) as liquido_s,
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

-- sem isto as views furam o RLS (ver §6b do schema) — nunca esquecer
alter view v_ordens                set (security_invoker = true);
alter view v_ordem_itens_planejado set (security_invoker = true);
alter view v_ordem_tanque_consumo  set (security_invoker = true);
alter view v_ordem_tempos          set (security_invoker = true);
alter view v_ocupacao              set (security_invoker = true);
alter view v_ordem_etapas          set (security_invoker = true);

-- o grant original foi "on all tables" da época; objeto recriado precisa de novo
grant select on v_ordens, v_ordem_itens_planejado, v_ordem_tanque_consumo,
                v_ordem_tempos, v_ocupacao, v_ordem_etapas to authenticated;

-- ------------------------------------------------------------
-- 3. Finalizar exige a quantidade produzida; peso final sai da regra
-- ------------------------------------------------------------
create or replace function fn_valida_fim() returns trigger as $$
declare falta int;
begin
  if new.status = 'Finalizada' and old.status <> 'Finalizada' then
    select count(*) into falta from ordem_tanques t
      where t.ordem_id = new.id and t.peso_inicial is null;
    if falta > 0 then raise exception 'Peso inicial pendente em % tanque(s)', falta; end if;
    if new.bags_produzidos is null then
      raise exception 'Informe a quantidade produzida (bags) para finalizar';
    end if;
  end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;

-- assinatura nova: a antiga cai para não virar sobrecarga ambígua
drop function if exists confirmar_fim(uuid);
create or replace function confirmar_fim(p_ordem uuid, p_bags_produzidos int)
returns void as $$
begin
  if not tem_acao('execucao','apontar') then
    raise exception 'Perfil sem permissao para apontar producao';
  end if;
  if p_bags_produzidos is null or p_bags_produzidos < 1 or p_bags_produzidos > 100000 then
    raise exception 'Quantidade produzida invalida: %', p_bags_produzidos;
  end if;
  update tsi.ordem_paradas set fim = now()
   where ordem_id = p_ordem and fim is null;
  delete from tsi.ordem_eventos where ordem_id = p_ordem and tipo = 'fim';
  insert into tsi.ordem_eventos (ordem_id, tipo, usuario_id)
  values (p_ordem, 'fim', auth.uid());
  update tsi.ordens
     set status = 'Finalizada', fim_pendente = false, bags_produzidos = p_bags_produzidos
   where id = p_ordem and status in ('Em producao','Parada');
  if not found then
    raise exception 'A ordem nao esta em producao';
  end if;
end $$ language plpgsql security definer set search_path = tsi, public;
revoke execute on function confirmar_fim(uuid, int) from public, anon;
grant execute on function confirmar_fim(uuid, int) to authenticated;

-- ------------------------------------------------------------
-- 4. AGROTIS passa a exigir os pesos finais (o PCP digita lá)
-- ------------------------------------------------------------
create or replace function fn_valida_agrotis() returns trigger as $$
declare falta int;
begin
  if new.status = 'Apontada' and old.status is distinct from 'Apontada' then
    if not exists (select 1 from ordem_conferencias c where c.ordem_id = new.id) then
      raise exception 'Lancamento no AGROTIS exige a conferencia de estoque da logistica';
    end if;
    select count(*) into falta from ordem_tanques t
      where t.ordem_id = new.id and t.peso_final is null;
    if falta > 0 then
      raise exception 'Lancamento no AGROTIS exige o peso final de todos os tanques (% pendente(s))', falta;
    end if;
  end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;

-- quem lança no AGROTIS também digita os pesos finais
drop policy if exists tq_all on ordem_tanques;
create policy tq_all on ordem_tanques for all
  using (tem_acao('execucao','apontar') or tem_acao('agrotis','lancar'))
  with check (tem_acao('execucao','apontar') or tem_acao('agrotis','lancar'));

-- ordem apontada é registro definitivo: pesos não mudam mais
create or replace function fn_tanque_imutavel() returns trigger as $$
begin
  if (select status from ordens where id = coalesce(new.ordem_id, old.ordem_id)) = 'Apontada' then
    raise exception 'Ordem apontada no AGROTIS e registro definitivo: pesos nao mudam mais';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;
drop trigger if exists tg_tanque_imutavel on ordem_tanques;
create trigger tg_tanque_imutavel before update or delete on ordem_tanques
  for each row execute function fn_tanque_imutavel();

-- ------------------------------------------------------------
-- Conferência: coluna nova visível, funções na assinatura nova
-- ------------------------------------------------------------
select 'v_ordens expoe bags_produzidos' as verificacao,
       count(*)::text as resultado
from information_schema.columns
where table_schema = 'tsi' and table_name = 'v_ordens' and column_name = 'bags_produzidos'
union all
select 'confirmar_fim(uuid,int)', count(*)::text
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'tsi' and p.proname = 'confirmar_fim'
union all
select 'views com security_invoker', count(*)::text
from pg_views v
where v.schemaname = 'tsi'
  and v.viewname in ('v_ordens','v_ordem_itens_planejado','v_ordem_tanque_consumo',
                     'v_ordem_tempos','v_ocupacao','v_ordem_etapas');
