-- ============================================================
-- REMOVE o controle de lotes de químico
-- Execute no SQL Editor do Supabase
-- ============================================================
--
-- ⚠️ APAGA DEFINITIVAMENTE as duas tabelas e os vínculos que as
-- ordens tinham com lotes de químico. Não tem desfazer.
--
-- Decisão de 05/08/2026: o controle de lote de químico saiu do
-- escopo — sem cadastro, sem escolha na ordem, sem trava no início.
-- O cadastro de PRODUTOS químicos (com densidade) continua: é dele
-- que sai o peso de balança.
-- ============================================================

set search_path = tsi, public;

-- 1. a trava de início deixa de exigir lote de químico
create or replace function fn_valida_inicio() returns trigger as $$
declare falta int;
begin
  if new.status = 'Em producao' and old.status <> 'Em producao' then
    select count(*) into falta from ordem_tanques t
      where t.ordem_id = new.id and t.peso_inicial is null;
    if falta > 0 then raise exception 'Peso inicial pendente em % tanque(s)', falta; end if;

    if (select status from lotes_semente where id = new.lote_id) = 'Em estoque' then
      raise exception 'Lote de semente nao baixado pelo estoque';
    end if;
  end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;

-- 2. as tabelas saem (vínculo primeiro, pela chave estrangeira)
drop table if exists ordem_tanque_lotes;
drop table if exists lotes_quimico;

-- conferência: as duas não devem aparecer
select table_name
from information_schema.tables
where table_schema = 'tsi'
  and table_name in ('lotes_quimico', 'ordem_tanque_lotes');
