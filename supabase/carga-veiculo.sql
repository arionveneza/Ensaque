-- ============================================================
-- Carga montada: tipo de VEÍCULO (croqui de carregamento) — 29/08/2026
-- Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- O croqui da carga (réplica do formulário de papel "Registro de
-- Expedição de Sementes — Croqui da Carga") é desenhado por tipo de
-- veículo: Utilitário, Truck, Bitruck, Carreta LS, Bitrem e Rodotrem
-- 9 eixos. O tipo fica na carga; capacidades e filas são do front
-- (src/dominio/croqui.ts). A RPC de gravação passa a levar o campo.
-- ============================================================

set search_path = tsi, public;

alter table cargas_montadas add column if not exists veiculo text;

comment on column cargas_montadas.veiculo is
  'Tipo de veículo (UTILITARIO/TRUCK/BITRUCK/CARRETA_LS/BITREM/RODOTREM) — desenha o croqui e dá o aviso de capacidade.';

-- regrava a RPC com o campo novo (mesma assinatura)
create or replace function salvar_carga_montada(
  p_id       uuid,
  p_carga    jsonb,
  p_produtos jsonb,
  p_usuario  uuid
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
    insert into cargas_montadas (numero, peso_total_kg, placa, cliente, tara_kg, veiculo, criada_por)
    values (
      p_carga->>'numero',
      (p_carga->>'peso_total_kg')::numeric,
      p_carga->>'placa',
      p_carga->>'cliente',
      (p_carga->>'tara_kg')::numeric,
      p_carga->>'veiculo',
      p_usuario
    )
    returning id into v_id;
  else
    update cargas_montadas
       set numero        = p_carga->>'numero',
           peso_total_kg = (p_carga->>'peso_total_kg')::numeric,
           placa         = p_carga->>'placa',
           cliente       = p_carga->>'cliente',
           tara_kg       = (p_carga->>'tara_kg')::numeric,
           veiculo       = p_carga->>'veiculo'
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
--   where table_schema='tsi' and table_name='cargas_montadas' and column_name='veiculo';
