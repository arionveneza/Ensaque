-- ============================================================
-- Mapa alimentado pela PRODUÇÃO — 30/08/2026
-- Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- Decisão do Arion (30/08/2026): a integração/atualização por SAP fica de
-- fora por enquanto. O lote TRATADO cai no mapa pela ordem de produção —
-- quando a ordem vira "Qualidade apontada", a combinação (lote base +
-- tratamento) entra em lotes_mapa com os bags APONTADOS pela produção,
-- pronta pro endereçamento. A produção não enxerga os sufixos -1/-2/-3 do
-- SAP; o mapa fala a língua do chão de fábrica.
--
-- O upload do SAP muda de papel: substituição total SÓ da semente branca;
-- pro tratado ele vira mensageiro de DESTINAÇÃO/CLASSE (enriquecimento por
-- número base + tratamento — RPC enriquecer_tratados). E a carga marcada
-- CARREGADA desconta os bags do mapa (desfazer devolve).
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 1. Ordem "Qualidade apontada" → lote tratado entra no mapa
--    SECURITY DEFINER: quem aponta é a Qualidade, que não tem (nem deve
--    ter) escrita direta em lotes_mapa — o gatilho é só contabilidade.
-- ------------------------------------------------------------
create or replace function fn_lote_tratado_no_mapa() returns trigger
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_receita text;
  v_ls      lotes_semente%rowtype;
  v_emb     embalagens%rowtype;
  v_peso    numeric;
begin
  select nome into v_receita from receitas where id = new.receita_id;
  -- ensaque sem tratamento não cria tratado; semente branca é do upload
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

  insert into lotes_mapa
    (lote, tratamento, cultivar, embalagem, pms, peso_bag_kg, bags,
     destinacao, classificacao, peneira, categoria, atualizado_em)
  values
    (new.lote_id, v_receita, v_ls.cultivar, new.embalagem, v_ls.pms,
     v_peso, coalesce(new.bags_produzidos, new.bags),
     null, null, v_ls.peneira, v_ls.categoria, now())
  on conflict (lote, tratamento) do update
    set bags          = lotes_mapa.bags + excluded.bags,
        atualizado_em = now();
  return new;
end $$;

drop trigger if exists tg_lote_tratado_no_mapa on ordens;
create trigger tg_lote_tratado_no_mapa
  after update of status on ordens
  for each row
  when (new.status = 'Qualidade apontada' and old.status is distinct from new.status)
  execute function fn_lote_tratado_no_mapa();

-- ------------------------------------------------------------
-- 2. Funde os tratados SUFIXADOS que vieram do SAP (SV...-1, -2) nas
--    combinações de número BASE — bags somados, endereços preservados,
--    destinações distintas viram "A / B". Roda uma vez; re-execução não
--    acha mais sufixo e não faz nada.
-- ------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select lote, tratamento, regexp_replace(lote, '(-\d+)+$', '') as base
      from lotes_mapa
     where tratamento <> 'SEM TSI' and lote ~ '-\d+$'
  loop
    insert into lotes_mapa
      (lote, tratamento, cultivar, embalagem, pms, peso_bag_kg, bags,
       destinacao, classificacao, peneira, categoria, atualizado_em)
    select r.base, m.tratamento, m.cultivar, m.embalagem, m.pms, m.peso_bag_kg,
           m.bags, m.destinacao, m.classificacao, m.peneira, m.categoria, m.atualizado_em
      from lotes_mapa m
     where m.lote = r.lote and m.tratamento = r.tratamento
    on conflict (lote, tratamento) do update
      set bags = lotes_mapa.bags + excluded.bags,
          destinacao = case
            when lotes_mapa.destinacao is null then excluded.destinacao
            when excluded.destinacao is null
              or position(excluded.destinacao in lotes_mapa.destinacao) > 0
              then lotes_mapa.destinacao
            else lotes_mapa.destinacao || ' / ' || excluded.destinacao
          end,
          classificacao = coalesce(lotes_mapa.classificacao, excluded.classificacao);

    update lote_enderecos
       set lote = r.base
     where lote = r.lote and tratamento = r.tratamento;

    delete from lotes_mapa where lote = r.lote and tratamento = r.tratamento;
  end loop;
end $$;

-- endereços duplicados pela fusão: sub-lotes ambíguos (mesmo base + mesmo
-- tratamento) tinham o endereço físico copiado pros dois — vira um só
delete from lote_enderecos a
 using lote_enderecos b
 where a.id > b.id
   and a.lote = b.lote and a.tratamento = b.tratamento
   and a.armazem = b.armazem and a.bloco = b.bloco and a.quadra = b.quadra
   and a.bags is not distinct from b.bags;

-- ------------------------------------------------------------
-- 3. Carga CARREGADA desconta os bags do mapa; desfazer devolve.
--    SECURITY DEFINER: a Balança marca carregada, mas não escreve no mapa.
-- ------------------------------------------------------------
create or replace function fn_carga_carregada_desconta_mapa() returns trigger
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_sinal numeric;
  r record;
begin
  if old.carregada_em is null and new.carregada_em is not null then
    v_sinal := -1;
  elsif old.carregada_em is not null and new.carregada_em is null then
    v_sinal := 1;
  else
    return new;
  end if;
  for r in
    select i.lote_id, p.tratamento, i.bags
      from carga_montada_produtos p
      join carga_montada_itens i on i.produto_id = p.id
     where p.carga_id = new.id
  loop
    update lotes_mapa
       set bags = greatest(0, bags + v_sinal * r.bags),
           atualizado_em = now()
     where lote = r.lote_id and tratamento = r.tratamento;
  end loop;
  return new;
end $$;

drop trigger if exists tg_carga_carregada_mapa on cargas_montadas;
create trigger tg_carga_carregada_mapa
  after update of carregada_em on cargas_montadas
  for each row execute function fn_carga_carregada_desconta_mapa();

-- ------------------------------------------------------------
-- 4. Enriquecimento de DESTINAÇÃO/CLASSE do upload do SAP: casa pelo
--    número BASE + tratamento; nunca cria nem apaga lote tratado.
--    SECURITY INVOKER — a RLS de escrita do mapa vale pra quem importa.
-- ------------------------------------------------------------
create or replace function enriquecer_tratados(p_itens jsonb) returns integer
language plpgsql set search_path = tsi, public as $$
declare
  v_n integer := 0;
  r record;
begin
  for r in select value from jsonb_array_elements(coalesce(p_itens, '[]'::jsonb))
  loop
    update lotes_mapa
       set destinacao    = nullif(r.value->>'destinacao', ''),
           classificacao = coalesce(nullif(r.value->>'classificacao', ''), classificacao)
     where lote = r.value->>'lote'
       and tratamento = r.value->>'tratamento';
    if found then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;

grant execute on function enriquecer_tratados(jsonb) to authenticated;
grant execute on function enriquecer_tratados(jsonb) to service_role;

-- ============================================================
-- Conferência
-- ============================================================
-- select lote, tratamento from lotes_mapa
--   where tratamento <> 'SEM TSI' and lote ~ '-\d+$';   -- 0 linhas (sufixos fundidos)
-- select tgname from pg_trigger where tgname in
--   ('tg_lote_tratado_no_mapa','tg_carga_carregada_mapa');  -- 2 gatilhos
