-- ============================================================
-- Mapa: ordem apontada DESCONTA a semente branca consumida — 30/08/2026
-- Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- Complemento do mapa alimentado pela produção: no mesmo momento em que a
-- ordem "Qualidade apontada" cria o lote TRATADO no mapa, ela desconta a
-- BRANCA que consumiu — peso da ordem ÷ peso do bag do lote (uma ordem
-- MEIOBAG consome meio bag do lote, naturalmente). Sem isso o mapa da
-- branca só mudava no upload seguinte do SAP.
--
-- A régua de disponibilidade do loteamento muda junto (front): ordens em
-- "Qualidade apontada"/"Apontada" saem do desconto de ordens abertas —
-- o próprio mapa já está debitado a partir daí.
-- ============================================================

set search_path = tsi, public;

create or replace function fn_lote_tratado_no_mapa() returns trigger
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_receita text;
  v_ls      lotes_semente%rowtype;
  v_emb     embalagens%rowtype;
  v_peso    numeric;
  v_bags    numeric;
begin
  select nome into v_receita from receitas where id = new.receita_id;
  -- ensaque sem tratamento não cria tratado nem desconta branca no mapa
  -- (o lote continua branco, só muda de embalagem; o upload acerta)
  if v_receita is null or upper(trim(v_receita)) = 'SEM TSI' then
    return new;
  end if;

  select * into v_ls from lotes_semente where id = new.lote_id;
  if not found then
    return new;
  end if;
  select * into v_emb from embalagens where codigo = new.embalagem;

  -- peso do bag DA ORDEM: peso fixo → pms × fator → peso do lote
  v_peso := coalesce(
    nullif(v_emb.peso_fixo_kg, 0),
    v_ls.pms * v_emb.fator_peso,
    v_ls.peso_bag_kg,
    0
  );
  v_bags := coalesce(new.bags_produzidos, new.bags);

  -- 1. o TRATADO produzido entra no mapa (lote base + tratamento)
  insert into lotes_mapa
    (lote, tratamento, cultivar, embalagem, pms, peso_bag_kg, bags,
     destinacao, classificacao, peneira, categoria, atualizado_em)
  values
    (new.lote_id, v_receita, v_ls.cultivar, new.embalagem, v_ls.pms,
     v_peso, v_bags, null, null, v_ls.peneira, v_ls.categoria, now())
  on conflict (lote, tratamento) do update
    set bags          = lotes_mapa.bags + excluded.bags,
        atualizado_em = now();

  -- 2. a BRANCA consumida sai do mapa (em bags DO LOTE)
  if v_ls.peso_bag_kg > 0 and v_peso > 0 then
    update lotes_mapa
       set bags = greatest(0, bags - (v_bags * v_peso / v_ls.peso_bag_kg)),
           atualizado_em = now()
     where lote = new.lote_id and tratamento = 'SEM TSI';
  end if;

  return new;
end $$;

-- o gatilho tg_lote_tratado_no_mapa já existe e aponta pra esta função

-- ============================================================
-- Conferência
-- ============================================================
-- select prosrc from pg_proc where proname = 'fn_lote_tratado_no_mapa';
--   -- deve conter "a BRANCA consumida sai do mapa"
