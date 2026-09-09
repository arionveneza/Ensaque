-- ============================================================
-- Unifica cultivar "O700 I2X" com "NEO700 I2X" no Mapa — 11/09/2026
-- Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- Achado do Arion: o filtro do Mapa mostrava "NEO700 I2X" e "O700 I2X"
-- como cultivares separados, mas é o MESMO cultivar — o SAP grava o
-- nome truncado ("O700 I2X") em boa parte das linhas. O app já tinha
-- esse de-para pronto (CULTIVAR_DEPARA em simpleagro.ts, usado pelo
-- import da SimpleAgro desde 20/08/2026), mas o importador do Mapa
-- (converterLotesMapa/converterEstoqueInventario) nunca aplicava —
-- corrigido no código (migração de código, não de banco).
--
-- Reenviar a planilha do SAP.xlsx corrige a semente BRANCA (o upload
-- substitui ela por inteiro), mas NÃO corrige as combinações TRATADAS
-- já lançadas no mapa pela produção — o cultivar delas foi copiado de
-- lotes_semente no momento da entrada e só é copiado de novo se aquele
-- lote+tratamento entrar de novo no mapa (não acontece por conflito).
-- Por isso o ajuste direto aqui, nas duas tabelas fonte do nome:
-- lotes_mapa (o que o filtro do Mapa lê) e lotes_semente (pra não
-- repetir o problema na próxima vez que uma ordem desse lote lançar
-- uma combinação tratada nova no mapa).
-- ============================================================

set search_path = tsi, public;

-- Bloco único de propósito: da vez passada só o segundo update rodou
-- (o cursor/seleção pegou só uma parte) — dentro de um DO só existe UM
-- statement pra selecionar, os dois updates são atômicos juntos.
do $$
begin
  update lotes_mapa
     set cultivar = 'NEO700 I2X'
   where cultivar = 'O700 I2X';

  update lotes_semente
     set cultivar = 'NEO700 I2X'
   where cultivar = 'O700 I2X';
end $$;

-- ============================================================
-- Conferência
-- ============================================================
-- select cultivar, count(*) from lotes_mapa
--  where cultivar in ('O700 I2X','NEO700 I2X') group by cultivar;
--   -- só NEO700 I2X deve aparecer
-- select cultivar, count(*) from lotes_semente
--  where cultivar in ('O700 I2X','NEO700 I2X') group by cultivar;
--   -- idem
