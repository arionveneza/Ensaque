-- ============================================================
-- Excluir ordem vira STATUS, não DELETE (25/08/2026)
-- Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- Pedido do Arion: uma ordem excluída/cancelada deve ficar com status
-- "Excluída" — registro de que foi programada e depois excluída — mas
-- SEM gerar nenhuma informação de saldo/lote/ocupação. Hoje `excluirOrdem`
-- faz um DELETE de verdade: a ordem some sem deixar rastro nenhum.
--
-- Continua exigindo ORDEM VIRGEM (mesma regra de sempre — sem história de
-- produção/qualidade/conferência): isso não muda, só o que acontece
-- quando a exclusão é permitida.
--
-- 1. Novo valor no enum status_ordem — precisa de commit isolado antes de
--    qualquer coisa que use o valor na mesma sessão (regra do Postgres).
-- ============================================================

set search_path = tsi, public;

alter type status_ordem add value if not exists 'Excluida';
commit;

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 2. Chave anti-duplicidade não pode mais ser travada para sempre por uma
--    ordem excluída — o mesmo nº/cultivar/receita/embalagem tem que poder
--    ser digitado de novo depois de excluir por engano.
-- ------------------------------------------------------------
alter table ordens drop constraint if exists ordens_numero_cultivar_receita_id_embalagem_key;
create unique index if not exists ordens_chave_ativa
  on ordens (numero, cultivar, receita_id, embalagem)
  where status <> 'Excluida';

-- ------------------------------------------------------------
-- 3. fn_ordem_imutavel: 'Excluida' entra na lista de status travados —
--    depois de excluída, NADA muda mais (nem o número, que os outros 4
--    status tocados ainda liberam).
-- ------------------------------------------------------------
create or replace function fn_ordem_imutavel() returns trigger as $$
begin
  if old.status in ('Em producao','Parada','Finalizada','Qualidade apontada','Apontada','Excluida') then
    if tg_op = 'DELETE' then
      raise exception 'Ordem % nao pode ser excluida (status %)', old.numero, old.status;
    end if;
    if new.cultivar <> old.cultivar or new.receita_id <> old.receita_id
       or new.embalagem <> old.embalagem or new.bags <> old.bags
       or new.lote_id <> old.lote_id or new.maquina_id is distinct from old.maquina_id
       or new.data_prog is distinct from old.data_prog then
      raise exception 'Ordem % em andamento/finalizada nao pode ser editada', old.numero;
    end if;
    if old.status in ('Apontada','Excluida') and new.numero is distinct from old.numero then
      raise exception 'Ordem % (status %) nao pode ter o numero corrigido', old.numero, old.status;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;

-- ------------------------------------------------------------
-- 4. fn_ordens_por_acao: transição pra 'Excluida' exige a ação
--    ordens/excluir (a mesma que já protegia o DELETE antigo)
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
    elsif new.status = 'Excluida' then
      if not tem_acao('ordens','excluir') then
        raise exception 'Excluir ordem exige a acao Excluir (Administracao)';
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
-- 5. excluir_ordem(): a exclusão em si — mesma regra de história de
--    sempre (fn_ordem_sem_historia), só que agora vira UPDATE + auditoria
--    em vez de DELETE. tg_ordem_sem_historia (BEFORE DELETE) continua
--    de pé como rede de segurança, sem uso normal a partir de agora.
-- ------------------------------------------------------------
create or replace function excluir_ordem(p_ordem uuid) returns void as $$
begin
  if not tem_acao('ordens','excluir') then
    raise exception 'Perfil sem permissao para excluir ordens';
  end if;
  if exists (select 1 from qualidade_checks    q where q.ordem_id = p_ordem)
     or exists (select 1 from ordem_conferencias c where c.ordem_id = p_ordem)
     or exists (select 1 from ordem_eventos      e where e.ordem_id = p_ordem)
     or exists (select 1 from ordem_paradas      pa where pa.ordem_id = p_ordem) then
    raise exception 'Ordem tem historia (producao/qualidade/conferencia) e nao pode ser excluida';
  end if;
  insert into tsi.ordem_auditoria (ordem_id, acao, detalhe, usuario_id)
  values (p_ordem, 'excluiu a ordem', null, auth.uid());
  update tsi.ordens set status = 'Excluida' where id = p_ordem;
  if not found then
    raise exception 'Ordem nao encontrada';
  end if;
end $$ language plpgsql security definer set search_path = tsi, public;

-- ------------------------------------------------------------
-- 6. Recria v_ordens (deixa 'Excluida' passar como status_efetivo, não
--    ser recalculada) + toda a cadeia dependente — v_ocupacao ganha o
--    filtro que nunca teve: ordem excluída não é "programado" de ninguém.
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
-- 7. v_balanco_demanda: ordem excluída some de ordens_abertas, igual
--    Apontada e fora_balanco.
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
       coalesce(p.ped_coop_pend,0) as pedido_cooperado_pendente
from ped p
full join est e on (e.cultivar,e.tratamento,e.embalagem) = (p.cultivar,p.tratamento,p.embalagem)
full join abe a on (a.cultivar,a.tratamento,a.embalagem) = (coalesce(p.cultivar,e.cultivar),
                                                            coalesce(p.tratamento,e.tratamento),
                                                            coalesce(p.embalagem,e.embalagem));

alter view v_balanco_demanda set (security_invoker = true);

-- ------------------------------------------------------------
-- Conferência
-- ------------------------------------------------------------
select 'Excluida existe no enum' as item,
       (exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
                where t.typname = 'status_ordem' and e.enumlabel = 'Excluida'))::text as ok
union all
select 'chave anti-duplicidade agora e parcial (nao trava ordem excluida)',
       (exists (select 1 from pg_indexes where schemaname='tsi' and indexname='ordens_chave_ativa'))::text
union all
select 'v_ocupacao ignora ordem excluida',
       (position('status <> ''Excluida''' in pg_get_viewdef('tsi.v_ocupacao'::regclass)) > 0)::text
union all
select 'v_balanco_demanda ignora ordem excluida',
       (position('Excluida' in pg_get_viewdef('tsi.v_balanco_demanda'::regclass)) > 0)::text
union all
select 'rpc excluir_ordem existe',
       (exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                where n.nspname='tsi' and p.proname='excluir_ordem'))::text;
