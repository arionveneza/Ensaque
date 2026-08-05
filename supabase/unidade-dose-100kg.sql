-- ============================================================
-- Dose por 100 kg de semente
-- Execute no SQL Editor do Supabase
-- ============================================================
--
-- As bulas de TSI costumam expressar a dose por 100 kg de semente
-- ("60 ml/100 kg"); o sistema só aceitava por kg, obrigando conversão
-- de cabeça — onde nasce erro de 100×. O enum ganha as duas bases e o
-- cálculo divide por 100 quando a unidade termina em /100kg.
--
-- O `commit` no meio é obrigatório: o Postgres não deixa USAR um valor
-- novo de enum na mesma transação que o criou (erro 55P04), e o editor
-- roda o script inteiro numa transação só.
-- ============================================================

alter type tsi.unidade_dose add value if not exists 'ml/100kg';
alter type tsi.unidade_dose add value if not exists 'g/100kg';

commit;

-- conferência: deve listar as quatro unidades
select unnest(enum_range(null::tsi.unidade_dose)) as unidades;
