-- ============================================================
-- Carga montada POR PRODUTO — 28/08/2026
-- Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- Fluxo novo (pedido do Arion, 28/08/2026): primeiro monta-se a ordem de
-- carregamento com CADA PRODUTO que vai na carga (cultivar + tratamento +
-- quantidade de bags) e só depois se escolhem os lotes, produto a produto.
-- Um caminhão leva vários produtos — o cabeçalho da carga perde a
-- combinação única (cultivar/tratamento/bags_solicitados saem de
-- cargas_montadas) e nasce carga_montada_produtos entre a carga e os itens.
--
-- A tabela cargas_montadas estava VAZIA quando esta migração foi escrita
-- (conferido via REST em 28/08/2026) — não há dado a migrar; se alguma
-- carga foi salva entre lá e cá, o bloco de migração abaixo a converte em
-- uma carga de produto único antes de derrubar as colunas.
-- ============================================================

set search_path = tsi, public;

create table if not exists carga_montada_produtos (
  id               uuid primary key default gen_random_uuid(),
  carga_id         uuid not null references cargas_montadas(id) on delete cascade,
  cultivar         text not null,
  tratamento       text not null,                -- 'SEM TSI' = semente branca
  bags_solicitados numeric(10,2) not null default 0
);

comment on table carga_montada_produtos is
  'Produtos de uma ordem de carregamento (cultivar + tratamento + bags pedidos). Os lotes escolhidos penduram aqui via carga_montada_itens.produto_id.';

alter table carga_montada_itens
  add column if not exists produto_id uuid references carga_montada_produtos(id) on delete cascade;

-- rede de segurança: carga salva no modelo antigo vira produto único
do $$ begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'tsi' and table_name = 'cargas_montadas'
               and column_name = 'cultivar') then
    insert into carga_montada_produtos (carga_id, cultivar, tratamento, bags_solicitados)
    select c.id, c.cultivar, coalesce(c.tratamento, 'SEM TSI'), c.bags_solicitados
      from cargas_montadas c
     where not exists (select 1 from carga_montada_produtos p where p.carga_id = c.id);
    update carga_montada_itens i
       set produto_id = (select p.id from carga_montada_produtos p where p.carga_id = i.carga_id limit 1)
     where i.produto_id is null;
  end if;
end $$;

alter table cargas_montadas drop column if exists cultivar;
alter table cargas_montadas drop column if exists tratamento;
alter table cargas_montadas drop column if exists bags_solicitados;

-- ---------------- RLS (espelha carga_montada_itens) ----------------
alter table carga_montada_produtos enable row level security;
drop policy if exists ler_carga_prod on carga_montada_produtos;
create policy ler_carga_prod on carga_montada_produtos for select using (meu_perfil() is not null);
drop policy if exists bal_carga_prod on carga_montada_produtos;
create policy bal_carga_prod on carga_montada_produtos for all
  using (meu_perfil() in ('Balanca','Logistica','Gestor'))
  with check (meu_perfil() in ('Balanca','Logistica','Gestor'));

-- ---------------- realtime ----------------
-- No modelo novo o cabeçalho quase não carrega dado exibido: sem eventos das
-- tabelas filhas, outro tablet recarregava no meio da gravação e ficava com a
-- carga sem produtos até um F5 (achado da revisão de 28/08/2026).
do $$ begin
  alter publication supabase_realtime add table carga_montada_produtos;
exception when others then null; end $$;
do $$ begin
  alter publication supabase_realtime add table carga_montada_itens;
exception when others then null; end $$;

-- ---------------- gravação transacional ----------------
-- Criar/editar carga eram 3–4 requisições separadas: falha no meio deixava
-- carga órfã (criar) ou APAGAVA os lotes salvos antes de regravar (editar).
-- A RPC faz tudo numa transação — ou grava inteiro, ou nada muda.
-- SECURITY INVOKER de propósito: a RLS acima continua valendo pra quem chama.
create or replace function salvar_carga_montada(
  p_id       uuid,     -- null = carga nova
  p_carga    jsonb,    -- {numero, peso_total_kg, placa, cliente, tara_kg}
  p_produtos jsonb,    -- [{cultivar, tratamento, bags_solicitados, itens: [{lote_id, bags, peso_kg, destinacao}]}]
  p_usuario  uuid      -- criada_por (só na criação)
) returns uuid
language plpgsql
security invoker
set search_path = tsi, public
as $$
declare
  v_id      uuid := p_id;
  v_prod    jsonb;
  v_prod_id uuid;
begin
  if v_id is null then
    insert into cargas_montadas (numero, peso_total_kg, placa, cliente, tara_kg, criada_por)
    values (
      p_carga->>'numero',
      (p_carga->>'peso_total_kg')::numeric,
      p_carga->>'placa',
      p_carga->>'cliente',
      (p_carga->>'tara_kg')::numeric,
      p_usuario
    )
    returning id into v_id;
  else
    update cargas_montadas
       set numero        = p_carga->>'numero',
           peso_total_kg = (p_carga->>'peso_total_kg')::numeric,
           placa         = p_carga->>'placa',
           cliente       = p_carga->>'cliente',
           tara_kg       = (p_carga->>'tara_kg')::numeric
     where id = v_id;
    if not found then
      raise exception 'carga % não encontrada (ou sem permissão para editar)', v_id;
    end if;
    delete from carga_montada_itens where carga_id = v_id;
    delete from carga_montada_produtos where carga_id = v_id;
  end if;

  for v_prod in select value from jsonb_array_elements(coalesce(p_produtos, '[]'::jsonb)) loop
    insert into carga_montada_produtos (carga_id, cultivar, tratamento, bags_solicitados)
    values (
      v_id,
      v_prod->>'cultivar',
      v_prod->>'tratamento',
      coalesce((v_prod->>'bags_solicitados')::numeric, 0)
    )
    returning id into v_prod_id;

    insert into carga_montada_itens (carga_id, produto_id, lote_id, bags, peso_kg, destinacao)
    select v_id, v_prod_id, i->>'lote_id', (i->>'bags')::numeric, (i->>'peso_kg')::numeric, i->>'destinacao'
      from jsonb_array_elements(coalesce(v_prod->'itens', '[]'::jsonb)) i;
  end loop;

  return v_id;
end $$;

grant execute on function salvar_carga_montada(uuid, jsonb, jsonb, uuid) to authenticated;
grant execute on function salvar_carga_montada(uuid, jsonb, jsonb, uuid) to service_role;

-- ============================================================
-- Conferência
-- ============================================================
-- select column_name from information_schema.columns
--   where table_schema='tsi' and table_name='cargas_montadas';
--   -- cultivar/tratamento/bags_solicitados NÃO aparecem mais
-- select count(*) from carga_montada_produtos;  -- 0 (tabela nova, base vazia)
