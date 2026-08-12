-- ============================================================
-- Confirmação do PCP antes de expor a ordem para a Logística baixar
-- Execute no SQL Editor do Supabase
-- ============================================================
--
-- POR QUE (decisão de 11/08/2026, relatado pelo Arion): dar máquina/dia a
-- uma ordem já a expunha para a Logística baixar o lote — mesmo sem
-- revisão nenhuma do PCP (nem impressa, etc.). Programar é rápido e às
-- vezes só reserva um horário; a Logística não deveria agir em cima disso
-- sem o PCP ter revisado e confirmado de propósito.
--
-- O QUE MUDA: o status derivado ganha um passo — `Programada` (já existia
-- no tipo, mas `statusEfetivo`/`v_ordens.status_efetivo` nunca devolviam
-- esse valor) passa a ser alcançável: máquina/dia dados, mas
-- `confirmada_em` nulo. Só depois que o PCP clica "confirmar" a ordem
-- segue para `Aguardando lote`/`Pronto para produzir`, que é quando a
-- Logística passa a vê-la na tela Lotes.
--
-- A view v_ordens é `select o.*` — toda coluna nova em `ordens` fica
-- invisível para ela até ser recriada. Recriar exige o CASCADE inteiro,
-- igual às migrações anteriores.
--
-- `baixar_lote` também muda: sem checar `confirmada_em`, o clique em
-- "Baixar" (que a tela só soma sobre as ordens CONFIRMADAS) liberaria por
-- baixo dos panos qualquer ordem `Programada` do mesmo lote junto — ela
-- pularia direto para `Pronto para produzir` no dia em que fosse
-- confirmada, sem passar por `Aguardando lote` nem a Logística agir sobre
-- ela de propósito.
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 1. As colunas
-- ------------------------------------------------------------
alter table ordens add column if not exists confirmada_em timestamptz;
alter table ordens add column if not exists confirmada_por uuid references usuarios(id);

comment on column ordens.confirmada_em is
  'PCP confirmou a ordem programada. Null = programada mas ainda em rascunho, invisível para a Logística.';

-- ------------------------------------------------------------
-- 2. Backfill: preserva o estado de hoje — toda ordem já programada
-- (com máquina) e ainda não iniciada é, hoje, o que a Logística já vê
-- (Aguardando lote/Pronto para produzir); sem isto, a migração faria
-- todo o board sumir da tela da Logística até alguém confirmar uma a uma.
-- ------------------------------------------------------------
-- Desliga tg_ordens_por_acao só para este UPDATE: rodando pelo SQL Editor
-- não existe usuário logado (auth.uid() é null), então tem_acao(...) dá
-- sempre false e o gatilho recusaria este backfill com "Editar a ordem
-- exige a acao Editar" — mesma armadilha de liberacao-lote-por-ordem.sql.
alter table ordens disable trigger tg_ordens_por_acao;

update ordens
   set confirmada_em = now()
 where maquina_id is not null
   and confirmada_em is null
   and status not in ('Em producao','Parada','Finalizada','Qualidade apontada','Apontada');

alter table ordens enable trigger tg_ordens_por_acao;

-- ------------------------------------------------------------
-- 3. fn_ordens_por_acao: colunas novas entram na lista ignorar (carimbadas
-- pela tela, não editadas à mão) e ganham checagem própria — mesmo padrão
-- de lote_liberado_*/agrotis_*.
-- ------------------------------------------------------------
create or replace function fn_ordens_por_acao() returns trigger as $$
declare
  ignorar constant text[] := array[
    'status','turno_id','fim_pendente','bags_produzidos',
    'prioridade','prioridade_por','prioridade_em',
    'maquina_id','data_prog','seq',
    'data_prog_original','reprogramacoes','reprogramada_em',
    'lote_liberado_em','lote_liberado_por',
    'confirmada_em','confirmada_por',
    'agrotis_num','agrotis_por','agrotis_em'];
begin
  if new.status is distinct from old.status then
    if new.status = 'Apontada' then
      if not tem_acao('agrotis','lancar') then
        raise exception 'Encerrar no AGROTIS exige a acao Lancar (Administracao)';
      end if;
    elsif new.status = 'Qualidade apontada' then
      if not tem_acao('qualidade','qualidade') then
        raise exception 'Apontar qualidade exige a acao Qualidade (Administracao)';
      end if;
    elsif old.status in ('Nao programada','Programada','Em producao','Parada')
      and new.status in ('Nao programada','Programada','Em producao','Parada','Finalizada') then
      if not tem_acao('execucao','apontar') then
        raise exception 'Apontar producao exige a acao Apontar (Administracao)';
      end if;
    else
      raise exception 'Transicao de status fora do fluxo exige a acao Editar ordens';
    end if;
  end if;
  if (new.turno_id is distinct from old.turno_id
      or new.fim_pendente is distinct from old.fim_pendente
      or new.bags_produzidos is distinct from old.bags_produzidos)
     and not tem_acao('execucao','apontar') then
    raise exception 'Apontar producao exige a acao Apontar (Administracao)';
  end if;
  if (new.prioridade is distinct from old.prioridade
      or new.prioridade_por is distinct from old.prioridade_por
      or new.prioridade_em is distinct from old.prioridade_em)
     and not tem_acao('ordens','priorizar') then
    raise exception 'Priorizar exige a acao Priorizar (Administracao)';
  end if;
  if (new.maquina_id is distinct from old.maquina_id
      or new.data_prog is distinct from old.data_prog
      or new.seq is distinct from old.seq)
     and not (tem_acao('programacao','editar') or tem_acao('ordens','editar')) then
    raise exception 'Programar exige a acao Editar programacao (Administracao)';
  end if;
  if (new.lote_liberado_em is distinct from old.lote_liberado_em
      or new.lote_liberado_por is distinct from old.lote_liberado_por)
     and not tem_acao('lotes','baixar_lote') then
    raise exception 'Liberar lote exige a acao Baixar lote (Administracao)';
  end if;
  if (new.confirmada_em is distinct from old.confirmada_em
      or new.confirmada_por is distinct from old.confirmada_por)
     and not tem_acao('ordens','editar') then
    raise exception 'Confirmar ordem exige a acao Editar (Administracao)';
  end if;
  if (new.agrotis_num is distinct from old.agrotis_num
      or new.agrotis_por is distinct from old.agrotis_por
      or new.agrotis_em is distinct from old.agrotis_em)
     and not tem_acao('agrotis','lancar') then
    raise exception 'Encerrar no AGROTIS exige a acao Lancar (Administracao)';
  end if;
  if (to_jsonb(new) - ignorar) <> (to_jsonb(old) - ignorar)
     and not tem_acao('ordens','editar') then
    raise exception 'Editar a ordem exige a acao Editar (Administracao)';
  end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;

-- ------------------------------------------------------------
-- 4. Recria a cadeia de views inteira (cascade), com o novo passo
-- Programada em status_efetivo.
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
  o.bags * ls.peso_bag_kg           as peso_kg,
  o.bags * ls.peso_bag_kg / 1000.0  as peso_t,
  r.nome                            as receita_nome
from ordens o
join lotes_semente ls on ls.id = o.lote_id
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

-- ------------------------------------------------------------
-- 5. baixar_lote passa a exigir confirmação do PCP: sem isso, o clique
-- em "Baixar" (que a tela calcula só sobre as ordens CONFIRMADAS) liberava
-- por baixo dos panos qualquer ordem `Programada` do mesmo lote também —
-- ela pularia direto de `Programada` para `Pronto para produzir` no dia
-- em que fosse confirmada, sem nunca passar por `Aguardando lote` nem a
-- Logística ver/agir sobre ela de propósito. Assinatura não muda.
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
    returning bags
  )
  select coalesce(sum(bags), 0) into v_bags from liberadas;

  if v_bags = 0 then
    raise exception 'Nao ha ordem confirmada deste lote esperando liberacao';
  end if;

  select v_bags * ls.peso_bag_kg / 1000.0 into v_peso_t
    from tsi.lotes_semente ls where ls.id = p_lote;

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
select 'colunas confirmada_* em ordens' as item, count(*)::text as valor
  from information_schema.columns
 where table_schema = 'tsi' and table_name = 'ordens'
   and column_name in ('confirmada_em','confirmada_por')
union all
select 'ordens programadas ja confirmadas (backfill)', count(*)::text
  from ordens where maquina_id is not null and confirmada_em is not null
union all
select 'ordens programadas AINDA sem confirmar (deve ser 0 logo apos o backfill)',
       count(*)::text
  from ordens
 where maquina_id is not null and confirmada_em is null
   and status not in ('Em producao','Parada','Finalizada','Qualidade apontada','Apontada')
union all
select 'v_ordens expoe confirmada_em', (count(*) = 1)::text
  from information_schema.columns
 where table_schema = 'tsi' and table_name = 'v_ordens' and column_name = 'confirmada_em'
union all
select 'status_efetivo tem o passo Programada (checa confirmada_em)',
       (position('o.confirmada_em is null' in lower(pg_get_viewdef('v_ordens'::regclass))) > 0)::text
union all
select 'fn_ordens_por_acao trava confirmada_* (exige ordens/editar)',
       (position('confirmada_em is distinct' in prosrc) > 0)::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'tsi' and p.proname = 'fn_ordens_por_acao'
union all
select 'baixar_lote exige confirmada_em (nao libera Programada por baixo dos panos)',
       (position('confirmada_em is not null' in prosrc) > 0)::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'tsi' and p.proname = 'baixar_lote'
union all
select 'views com security_invoker (deve ser 6)', count(*)::text
  from pg_views v
 where v.schemaname = 'tsi'
   and v.viewname in ('v_ordens','v_ordem_itens_planejado','v_ordem_tanque_consumo',
                       'v_ordem_tempos','v_ocupacao','v_ordem_etapas');
