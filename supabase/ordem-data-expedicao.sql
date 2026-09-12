-- ============================================================
-- Ordem: data de expedição + urgente no formulário — 12/09/2026
--
-- Pedido do Arion: "na montagem da ordem de produção, colocar um campo
-- para eu marcar urgente e também para marcar a data de expedição".
--
-- Urgente já existia (ordens.prioridade, ação ordens/priorizar) — só não
-- estava no formulário: era um clique à parte depois de criar. Nada muda no
-- banco para isso: o INSERT já pode trazer prioridade (a policy exige
-- ordens/criar), e no UPDATE o gatilho fn_ordens_por_acao segue exigindo a
-- ação Priorizar, como antes.
--
-- Data de expedição é coluna nova, opcional. Fica FORA da lista `ignorar`
-- do fn_ordens_por_acao de propósito: mudar exige ordens/editar, igual a
-- cliente/observação. E fica FORA do fn_ordem_imutavel porque não entra em
-- cálculo nenhum — hoje, porém, só é editável pelo formulário, enquanto a
-- ordem não foi iniciada (MATRIZ_STATUS.editar); um caminho para corrigir a
-- data do caminhão em ordem já rodada ficou como próximo passo.
--
-- ATENÇÃO ao recriar v_ordens: `create or replace view` ZERA as reloptions,
-- e a view volta a rodar como o dono (postgres, bypassrls) — o RLS de
-- `ordens` some e a chave anon lê a produção inteira pela view. A primeira
-- versão desta migração esqueceu o `alter view ... security_invoker` e ficou
-- assim por cerca de uma hora em 12/09/2026 (pego na revisão, contido no
-- banco na hora). Toda recriação repete o alter e confere no fim.
-- ============================================================

set search_path = tsi, public;

alter table ordens add column if not exists data_expedicao date;

comment on column ordens.data_expedicao is
  'Data prevista de expedicao (caminhao) desta producao. Opcional; informativa.';

-- v_ordens enumera colunas: a nova entra NO FIM (create or replace view só
-- aceita coluna acrescentada no final, sem mexer na ordem das existentes).
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
       o.data_expedicao
  from ordens o
  join lotes_semente ls on ls.id = o.lote_id
  join embalagens e on e.codigo = o.embalagem
  join receitas r on r.id = o.receita_id;

-- a view respeita o RLS de quem consulta, não o do dono (ver cabeçalho)
alter view v_ordens set (security_invoker = true);

-- conferência
select
  (select position('security_invoker=true' in array_to_string(c.reloptions, ',')) > 0
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'tsi' and c.relname = 'v_ordens') as security_invoker,
  (select count(*) from information_schema.columns
    where table_schema = 'tsi' and table_name = 'ordens' and column_name = 'data_expedicao') as coluna,
  (select count(*) from information_schema.columns
    where table_schema = 'tsi' and table_name = 'v_ordens' and column_name = 'data_expedicao') as na_view,
  (select count(*) from v_ordens) as linhas_view;
