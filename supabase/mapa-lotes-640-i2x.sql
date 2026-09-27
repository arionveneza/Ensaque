-- ============================================================
-- Correção de dados: lotes do 640 I2X no MAPA (27/09/2026)
-- Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- Achado do Arion: "o 640 I2X não aparece". O Mapa não recebe o upload do
-- SAP desde 28/08 (última substituição em massa da semente branca), e o SAP
-- exportou o item "SS 640 I2X BB5M (R)" com a coluna CULTIVAR VAZIA de 11/09
-- a 25/09 — os lotes novos do 640 I2X nunca entraram no Mapa, e os que
-- entraram foram digitados à mão (dois como "NEO640 I2X" e um com o número
-- cortado, SV001302656300 no lugar de SV0013026563000).
--
-- Decisão do Arion (27/09/2026): mexer SÓ nos lotes do 640 I2X — o resto do
-- Mapa fica como está (sincronizar tudo apagaria 196 lotes com endereço).
-- Valores do SAP27092026.xlsx pelo mesmo conversor do upload do Mapa
-- (converterLotesMapa: número BASE, depósito VEN_GER).
-- ============================================================

set search_path = tsi, public;

begin;

-- 1. os que faltam — nunca sobrescreve combinação que já exista
insert into lotes_mapa
  (lote, tratamento, cultivar, embalagem, pms, peso_bag_kg, bags, destinacao, classificacao, peneira, categoria, atualizado_em)
values
  ('5250004',         'SEM TSI', '640 I2X', 'BG5M', 158.2,  791,   5,  null, null, 'P 6.0 mm', null, now()),
  ('6250003',         'SEM TSI', '640 I2X', 'BG5M', 158.4,  792,   18, null, null, 'P 6.0 mm', 'S1', now()),
  ('6250004',         'SEM TSI', '640 I2X', 'BG5M', 158.2,  791,   5,  null, null, 'P 6.0 mm', 'S1', now()),
  ('6250007',         'SEM TSI', '640 I2X', 'BG5M', 162.2,  811,   5,  null, null, 'P 6.0 mm', 'S1', now()),
  ('6250014',         'SEM TSI', '640 I2X', 'BG5M', 158.56, 792.8, 2,  null, null, 'P 6.0 mm', 'S1', now()),
  ('6250017',         'SEM TSI', '640 I2X', 'BG5M', 123.02, 615.1, 2,  null, null, 'P 5.5 mm', 'S1', now()),
  ('SV0013026563000', 'SEM TSI', '640 I2X', 'BG5M', 196,    980,   18, null, null, '6.5',      'C1', now())
on conflict (lote, tratamento) do nothing;

-- 2. os dois digitados como "NEO640 I2X" (saldo já bate com o SAP: 2 e 5)
update lotes_mapa
   set cultivar = '640 I2X', atualizado_em = now()
 where tratamento = 'SEM TSI' and lote in ('6250005', '6250016') and cultivar = 'NEO640 I2X';

-- 3. número cortado: o endereço (E/06E/4, 18 bg) passa pro lote certo e a
--    linha errada sai (o cascade não leva nada — o endereço já mudou de dono)
update lote_enderecos
   set lote = 'SV0013026563000'
 where lote = 'SV001302656300' and tratamento = 'SEM TSI'
   and exists (select 1 from lotes_mapa where lote = 'SV0013026563000' and tratamento = 'SEM TSI');
delete from lotes_mapa
 where lote = 'SV001302656300' and tratamento = 'SEM TSI'
   and not exists (select 1 from lote_enderecos where lote = 'SV001302656300' and tratamento = 'SEM TSI');

commit;

-- ============================================================
-- Conferência: 10 lotes de 640 I2X com 72 bg (o mesmo do SAP), nenhum
-- "NEO640 I2X", nenhum número cortado, endereço no lote certo
-- ============================================================
select 'lotes 640 I2X no mapa' as item,
       (count(*) || ' lotes · ' || sum(bags) || ' bg') as valor
  from lotes_mapa where tratamento = 'SEM TSI' and cultivar = '640 I2X' and bags > 0
union all
select 'restou NEO640 I2X', count(*)::text from lotes_mapa where cultivar = 'NEO640 I2X'
union all
select 'restou SV001302656300', count(*)::text from lotes_mapa where lote = 'SV001302656300'
union all
select 'endereço do SV0013026563000',
       coalesce(string_agg(armazem || '/' || coalesce(bloco, '') || '/' || coalesce(quadra, '') || ' ' || coalesce(bags::text, ''), ', '), 'nenhum')
  from lote_enderecos where lote = 'SV0013026563000' and tratamento = 'SEM TSI';
