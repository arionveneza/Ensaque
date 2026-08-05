-- ============================================================
-- Remove a tabela de consultas do SAP
-- Execute no SQL Editor do Supabase
-- ============================================================
--
-- A integração com o SAP saiu do app. A tabela existia só para guardar o SQL
-- das consultas registradas no Service Layer, e nada mais a consulta.
--
-- Nenhuma tabela do TSI referencia esta — as ordens, lotes e cadastros são
-- independentes, então remover não afeta nada em uso.
--
-- Isto NÃO mexe no SAP. As consultas registradas lá (LotesSA e as outras)
-- continuam intactas no B1, porque foram criadas por lá.
-- ============================================================

set search_path = tsi, public;

drop trigger if exists tg_consulta_sap_alterada on consultas_sap;
drop function if exists fn_consulta_sap_alterada();
drop table if exists consultas_sap;

-- confere que sobrou só o que é do TSI
select table_name
from information_schema.tables
where table_schema = 'tsi'
order by table_name;
