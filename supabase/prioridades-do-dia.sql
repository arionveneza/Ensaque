-- ============================================================
-- Prioridades do dia — 16/09/2026
--
-- Pedido do Arion: "temos várias ordens urgentes, mas dentre as urgentes a
-- produção não consegue priorizar. Queria um campo de prioridades do dia,
-- acima da fila da máquina na Programação; arrastar as ordens para lá, e
-- isso refletir na tela de Execução."
--
-- `prioridade` é um enum binário (Normal/Urgente): com 8 urgentes na TSI 1
-- a etiqueta não distingue nada. A faixa "Prioridades do dia" é uma lista
-- curta e ORDENADA por máquina e dia: o PCP escolhe e ordena, a Execução
-- mostra em destaque no topo da fila da máquina (P1, P2, P3…).
--
-- Tabela PRÓPRIA, não coluna em `ordens`: coluna nova esbarraria no
-- fn_ordens_por_acao (já recriado seis vezes) e no fn_ordem_imutavel.
-- Máquina e dia vêm da própria ordem — a prioridade é DA CÉLULA onde foi
-- marcada: se a ordem muda de dia/máquina (cascata, arraste) ou conclui, a
-- linha cai (gatilho). Escrita só pela RPC, atômica: a faixa inteira é
-- regravada a cada arraste/▲▼/✕ — nunca uma posição avulsa (a lição do
-- aplicarAtribuicoes sem transação, que deixava seq duplicado).
-- ============================================================

set search_path = tsi, public;

create table if not exists ordem_prioridades_dia (
  ordem_id     uuid primary key references ordens(id) on delete cascade,
  posicao      integer not null check (posicao > 0),
  definida_por uuid references usuarios(id),
  definida_em  timestamptz not null default now()
);
comment on table ordem_prioridades_dia is
  'Faixa "Prioridades do dia" da Programação: ordem ranqueada (posicao) dentro da célula máquina×dia da própria ordem. Cai quando a ordem muda de célula ou conclui (16/09/2026).';

alter table ordem_prioridades_dia enable row level security;
drop policy if exists ler_prioridades_dia on ordem_prioridades_dia;
create policy ler_prioridades_dia on ordem_prioridades_dia for select using (meu_perfil() is not null);
-- sem policy de insert/update/delete: só a RPC (security definer) escreve

-- ------------------------------------------------------------
-- A prioridade é da célula: mudou de máquina/dia ou concluiu, sai
-- ------------------------------------------------------------
create or replace function fn_prioridade_dia_cai() returns trigger
language plpgsql security definer set search_path = tsi, public as $$
begin
  if new.maquina_id is distinct from old.maquina_id
     or new.data_prog is distinct from old.data_prog
     or (new.status in ('Finalizada','Qualidade apontada','Apontada','Excluida')
         and old.status not in ('Finalizada','Qualidade apontada','Apontada','Excluida')) then
    delete from ordem_prioridades_dia where ordem_id = new.id;
  end if;
  return new;
end $$;
drop trigger if exists tg_prioridade_dia_cai on ordens;
create trigger tg_prioridade_dia_cai after update on ordens
  for each row execute function fn_prioridade_dia_cai();

-- ------------------------------------------------------------
-- RPC: regrava a faixa inteira de uma célula
-- ------------------------------------------------------------
create or replace function definir_prioridades_dia(
  p_maquina text, p_dia date, p_ordens uuid[]
) returns void as $$
declare
  v_ids uuid[];
  v_n int;
begin
  if not (tem_acao('programacao','editar') or tem_acao('ordens','editar')) then
    raise exception 'Definir prioridades do dia exige a acao Editar programacao';
  end if;
  if p_maquina is null or p_dia is null then
    raise exception 'Maquina e dia sao obrigatorios';
  end if;
  v_ids := coalesce(p_ordens, '{}');
  -- sem repetição
  if (select count(*) from unnest(v_ids)) <> (select count(distinct x) from unnest(v_ids) x) then
    raise exception 'Ordem repetida na lista de prioridades';
  end if;
  -- todas da célula e ainda não concluídas
  select count(*) into v_n
    from ordens o
   where o.id = any(v_ids)
     and o.maquina_id = p_maquina and o.data_prog = p_dia
     and o.status not in ('Finalizada','Qualidade apontada','Apontada','Excluida');
  if v_n <> cardinality(v_ids) then
    raise exception 'Toda ordem da faixa precisa estar programada em % no dia % e ainda nao concluida', p_maquina, p_dia;
  end if;

  -- regrava a célula inteira: apaga o que era desta máquina/dia e insere na ordem recebida
  delete from ordem_prioridades_dia p
   using ordens o
   where o.id = p.ordem_id and o.maquina_id = p_maquina and o.data_prog = p_dia;
  insert into ordem_prioridades_dia (ordem_id, posicao, definida_por)
  select id, ord, auth.uid()
    from unnest(v_ids) with ordinality as u(id, ord);
end $$ language plpgsql security definer set search_path = tsi, public;

revoke execute on function definir_prioridades_dia(text, date, uuid[]) from public, anon;
grant execute on function definir_prioridades_dia(text, date, uuid[]) to authenticated, service_role;

-- ------------------------------------------------------------
-- v_ordens ganha prioridade_dia (coluna nova só no FIM do select)
-- ------------------------------------------------------------
create or replace view v_ordens as
select o.id,
       o.numero,
       o.cultivar,
       o.receita_id,
       o.embalagem,
       o.bags,
       o.lote_id,
       o.cliente,
       o.observacao,
       o.prioridade,
       o.prioridade_por,
       o.prioridade_em,
       o.maquina_id,
       o.data_prog,
       o.seq,
       o.turno_id,
       o.status,
       o.fim_pendente,
       o.origem,
       o.agrotis_num,
       o.agrotis_por,
       o.agrotis_em,
       o.criado_em,
       o.armazem,
       o.bloco,
       o.quadra,
       o.bags_produzidos,
       o.data_prog_original,
       o.reprogramacoes,
       o.reprogramada_em,
       o.lote_liberado_em,
       o.lote_liberado_por,
       o.confirmada_em,
       o.confirmada_por,
       o.fora_balanco,
       o.destinacao,
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
       coalesce(nullif(e.peso_fixo_kg, 0), nullif(ls.pms * e.fator_peso, 0), ls.peso_bag_kg)
         as peso_bag_ordem_kg,
       o.bags::numeric
         * coalesce(nullif(e.peso_fixo_kg, 0), nullif(ls.pms * e.fator_peso, 0), ls.peso_bag_kg)
         as peso_kg,
       o.bags::numeric
         * coalesce(nullif(e.peso_fixo_kg, 0), nullif(ls.pms * e.fator_peso, 0), ls.peso_bag_kg)
         / 1000.0 as peso_t,
       r.nome as receita_nome,
       o.data_expedicao,
       pd.posicao as prioridade_dia
  from ordens o
  join lotes_semente ls on ls.id = o.lote_id
  join embalagens e on e.codigo = o.embalagem
  join receitas r on r.id = o.receita_id
  left join ordem_prioridades_dia pd on pd.ordem_id = o.id;

-- `create or replace view` ZERA as reloptions: repetir SEMPRE (lição de 12/09/2026)
alter view v_ordens set (security_invoker = true);

-- realtime: Programação e Execução assinam
do $$ begin
  alter publication supabase_realtime add table ordem_prioridades_dia;
exception when others then null; end $$;

-- ------------------------------------------------------------
-- Conferência
-- ------------------------------------------------------------
select 'tabela' as item, (count(*) = 1)::text as ok
  from information_schema.tables where table_schema = 'tsi' and table_name = 'ordem_prioridades_dia'
union all
select 'policy select (1, sem escrita)', (count(*) = 1)::text
  from pg_policies where schemaname = 'tsi' and tablename = 'ordem_prioridades_dia'
union all
select 'gatilho em ordens', (count(*) = 1)::text
  from pg_trigger where tgname = 'tg_prioridade_dia_cai'
union all
select 'rpc', (count(*) = 1)::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'tsi' and p.proname = 'definir_prioridades_dia'
union all
select 'v_ordens.prioridade_dia', (count(*) = 1)::text
  from information_schema.columns
 where table_schema = 'tsi' and table_name = 'v_ordens' and column_name = 'prioridade_dia'
union all
select 'v_ordens security_invoker',
  coalesce((select 'security_invoker=true' = any(c.reloptions) from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'tsi' and c.relname = 'v_ordens'), false)::text
union all
select 'realtime', (count(*) = 1)::text
  from pg_publication_tables
 where pubname = 'supabase_realtime' and schemaname = 'tsi' and tablename = 'ordem_prioridades_dia';
