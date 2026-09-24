-- ============================================================
-- "A carregar" do Estoque futuro — relatório montagem carga vs lotes
-- (SimpleAgro) — 24/09/2026
-- Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- Pedido do Arion (24/09/2026): "o saldo futuro será composto por
-- ((estoque + planejado) − A carregar)". O "A carregar" é o que já está em
-- ordem de carregamento na SimpleAgro e ainda não foi faturado — sai do
-- relatório "montagem carga vs lotes", sem os status Faturado Fiscal,
-- Faturado Transporte e Finalizado (a nota já saiu, o SAP já baixou).
--
-- A conversão (um item por agendamento, Qtd Agendada contada UMA vez mesmo
-- quando o relatório repete a linha por lote) é feita no front —
-- src/dominio/importacao/montagemCarga.ts. Aqui chega um registro por item,
-- só dos status que ficam.
--
-- Mesmo desenho de pedidos_venda/estoque_pa/estoque_quimicos: foto por
-- carga (cargas_demanda tipo 'montagem'; substituição total = carga nova,
-- o histórico fica) e quem lê usa SÓ a carga vigente.
--
-- De propósito NÃO se grava cliente, motorista, CPF, telefone, placa nem
-- lote: a conta só precisa de produto, quantidade, status e data.
-- ============================================================

set search_path = tsi, public;

-- carga tipo novo: 'montagem' (mantém os três que já existem)
alter table cargas_demanda drop constraint if exists cargas_demanda_tipo_check;
alter table cargas_demanda add constraint cargas_demanda_tipo_check
  check (tipo in ('pedidos', 'estoque', 'quimicos', 'montagem'));

create table if not exists montagem_carga_itens (
  id            uuid primary key default gen_random_uuid(),
  carga_id      uuid not null references cargas_demanda(id) on delete cascade,
  numero_carga  text not null,               -- "Carga" do relatório (texto, sem conta)
  status_carga  text not null,               -- "Status Carga" (nunca os já faturados)
  data_carga    date,                        -- "Data Carga"; nulo = sem data no relatório
  pedido        text not null default '',
  cultivar      text not null,
  categoria     text not null default '',
  tratamento    text not null,               -- como veio; SEM TSI = semente branca
  embalagem     text not null,               -- código do app (BG5M/MEIOBAG) ou o cru, sem de-para
  bags          numeric(12,2) not null check (bags > 0),   -- Qtd Agendada do item, uma vez
  bags_loteados numeric(12,2) not null default 0,          -- Σ Quantidade Lote (informativo)
  lotes         int not null default 0                     -- linhas de lote do item
);

create index if not exists montagem_carga_itens_carga on montagem_carga_itens(carga_id);

comment on table montagem_carga_itens is
  'Itens em ordem de carregamento ainda não faturados (relatório montagem carga vs lotes da SimpleAgro), um por item de agendamento. Quem lê usa só a carga vigente (última cargas_demanda tipo montagem).';

alter table montagem_carga_itens enable row level security;

drop policy if exists ler_montagem on montagem_carga_itens;
create policy ler_montagem on montagem_carga_itens for select using (meu_perfil() is not null);

-- upload da tela Ordens (mesma régua de pedidos/estoque: ordens/criar)
drop policy if exists montagem_all on montagem_carga_itens;
create policy montagem_all on montagem_carga_itens for all
  using (tem_acao('ordens','criar')) with check (tem_acao('ordens','criar'));

grant select, insert, update, delete on montagem_carga_itens to authenticated;

-- ------------------------------------------------------------
-- Gravação TRANSACIONAL (achado da revisão adversarial, 24/09/2026): a
-- carga e os itens entram na mesma transação — antes a carga era criada numa
-- requisição e os itens em blocos separados; quem lesse no intervalo pegava
-- a carga nova como vigente com 0 itens (A carregar zerado), e se um bloco
-- falhasse o rollback pelo cliente não era conferido. Mesmo padrão de
-- substituir_saldos_inventario/salvar_carga_montada: security invoker, a RLS
-- de cargas_demanda/montagem_carga_itens (ordens/criar) continua valendo.
-- Lista vazia é válida: "nada a carregar" é uma foto legítima (tudo faturado).
-- ------------------------------------------------------------
create or replace function importar_montagem_carga(p_itens jsonb, p_usuario uuid)
returns table (carga_id uuid, itens int)
language plpgsql
security invoker
set search_path = tsi, public
as $$
declare
  v_id uuid;
  v_n  int;
begin
  if p_itens is null or jsonb_typeof(p_itens) <> 'array' then
    raise exception 'itens da montagem: esperado um array';
  end if;
  insert into cargas_demanda (tipo, origem, criada_por)
  values ('montagem', 'upload', coalesce(auth.uid(), p_usuario))
  returning id into v_id;

  insert into montagem_carga_itens (
    carga_id, numero_carga, status_carga, data_carga, pedido, cultivar, categoria,
    tratamento, embalagem, bags, bags_loteados, lotes
  )
  select v_id, i.numero_carga, i.status_carga, i.data_carga, coalesce(i.pedido, ''), i.cultivar,
         coalesce(i.categoria, ''), i.tratamento, i.embalagem, i.bags,
         coalesce(i.bags_loteados, 0), coalesce(i.lotes, 0)
    from jsonb_to_recordset(p_itens) as i(
      numero_carga text, status_carga text, data_carga date, pedido text, cultivar text,
      categoria text, tratamento text, embalagem text, bags numeric, bags_loteados numeric, lotes int
    );
  get diagnostics v_n = row_count;
  return query select v_id, v_n;
end $$;

grant execute on function importar_montagem_carga(jsonb, uuid) to authenticated;

-- ------------------------------------------------------------
-- Publicação realtime. A tela de Ordens assina SEIS tabelas num canal só, e
-- uma tabela fora da publicação derruba o canal INTEIRO em silêncio (lição do
-- realtime-completo.sql). A revisão adversarial de 24/09/2026 achou que
-- pedidos_venda NUNCA esteve na publicação — o realtime da Ordens (e do MRP,
-- que também assina receitas e estoque_quimicos) estava morto desde sempre:
-- outro PCP só via a importação nova depois de F5. Entram as quatro.
-- ------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['montagem_carga_itens', 'pedidos_venda', 'receitas', 'estoque_quimicos'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'tsi' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table tsi.%I', t);
    end if;
  end loop;
end $$;

-- ============================================================
-- Conferência (deve devolver 'ok' em todas as linhas)
-- ============================================================
select 'tipo montagem na constraint' as item,
       case when pg_get_constraintdef(oid) like '%montagem%' then 'ok' else 'FALHOU' end as resultado
  from pg_constraint where conname = 'cargas_demanda_tipo_check'
union all
select 'RLS ligada',
       case when relrowsecurity then 'ok' else 'FALHOU' end
  from pg_class where oid = 'tsi.montagem_carga_itens'::regclass
union all
select 'RPC importar_montagem_carga',
       case when exists (select 1 from pg_proc where proname = 'importar_montagem_carga') then 'ok' else 'FALHOU' end
union all
-- toda tabela que Ordens e MRP assinam no useRealtime precisa estar publicada
select 'realtime: ' || t,
       case when exists (
         select 1 from pg_publication_tables
         where pubname = 'supabase_realtime' and schemaname = 'tsi' and tablename = t
       ) then 'ok' else 'FALHOU' end
  from unnest(array['ordens', 'lotes_semente', 'pedidos_venda', 'estoque_pa', 'ordem_conferencias',
                    'montagem_carga_itens', 'receitas', 'estoque_quimicos']) as t;
