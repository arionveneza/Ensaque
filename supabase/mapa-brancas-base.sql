-- ============================================================
-- Mapa: semente BRANCA também pelo número BASE — 30/08/2026
-- Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- Achado do Arion (30/08/2026): o SAP também sufixa lote BRANCO
-- (reentrada/desdobramento: SV...733-1), e a fusão anterior
-- (mapa-alimentado-pela-producao.sql) só tratou os tratados. Branca
-- sufixada não casa com a ordem de produção (que usa o número base) —
-- o desconto do gatilho e a régua do loteamento passavam reto.
--
-- O conversor do upload já foi corrigido (agrega branca por base); aqui
-- fundem-se as brancas sufixadas que JÁ estão no banco: bags somados,
-- endereços movidos, duplicados deduplicados. Dry-run de 30/08/2026:
-- 10 sufixadas, 2 endereços, 6 fusões com base existente.
-- ============================================================

set search_path = tsi, public;

do $$
declare r record;
begin
  for r in
    select lote, tratamento, regexp_replace(lote, '(-\d+)+$', '') as base
      from lotes_mapa
     where tratamento = 'SEM TSI' and lote ~ '-\d+$'
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

-- endereços duplicados pela fusão viram um só
delete from lote_enderecos a
 using lote_enderecos b
 where a.id > b.id
   and a.lote = b.lote and a.tratamento = b.tratamento
   and a.armazem = b.armazem and a.bloco = b.bloco and a.quadra = b.quadra
   and a.bags is not distinct from b.bags;

-- ============================================================
-- Conferência
-- ============================================================
-- select lote from lotes_mapa where lote ~ '-\d+$';  -- 0 linhas (nada sufixado)
