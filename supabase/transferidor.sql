-- ============================================================
-- Transferidor: destino 0 para produto que não vai em tanque
-- Execute no SQL Editor do Supabase
-- ============================================================
--
-- O pó secante (grafite) nunca passa por tanque — é aplicado pelo
-- transferidor. Na receita e no apontamento ele vira o destino 0,
-- com pesagem (peso inicial/final) e lote de químico iguais aos
-- tanques (decisão do PCP em 05/08/2026). Toda a validação de
-- início/fim já cobre o 0 sem mudança.
-- ============================================================

set search_path = tsi, public;

alter table receita_itens drop constraint if exists receita_itens_tanque_check;
alter table receita_itens add constraint receita_itens_tanque_check
  check (tanque between 0 and 5);  -- 0 = transferidor

alter table ordem_tanques drop constraint if exists ordem_tanques_tanque_check;
alter table ordem_tanques add constraint ordem_tanques_tanque_check
  check (tanque between 0 and 5);  -- 0 = transferidor

-- conferência: as duas restrições novas
select conname, pg_get_constraintdef(oid) as definicao
from pg_constraint
where conname in ('receita_itens_tanque_check', 'ordem_tanques_tanque_check');
