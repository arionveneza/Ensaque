-- ============================================================
-- Realtime completo — 06/08/2026
--
-- Sonda no websocket do Realtime mostrou que `estoque_pa` NÃO está na
-- publicação supabase_realtime. Consequência pior do que parece: a tela
-- Ordens assina ordens+lotes+pedidos+estoque_pa num canal só, e quando
-- UMA tabela do canal é inválida o Realtime derruba o canal INTEIRO —
-- a tela Ordens ficava sem atualização ao vivo nenhuma, em silêncio.
--
-- Aproveita e cobre lote_movimentos, que a tela Lotes passa a assinar
-- (era a única tela de operação sem realtime).
-- ============================================================

set search_path = tsi, public;

do $$ begin
  alter publication supabase_realtime add table estoque_pa;
exception when others then null; end $$;
do $$ begin
  alter publication supabase_realtime add table lote_movimentos;
exception when others then null; end $$;

-- conferência: as tabelas que as telas assinam, todas presentes
select tablename
from pg_publication_tables
where pubname = 'supabase_realtime' and schemaname = 'tsi'
order by tablename;
