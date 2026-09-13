-- ============================================================
-- Setup entre ordens no cadastro de cada máquina — 13/09/2026
--
-- Pedido do Arion: "para cada ordem diferente de produção, devemos
-- considerar 20 minutos de setup; hoje estamos considerando apenas a
-- capacidade nominal da máquina. Se for cultivar X tratamento A e cultivar Y
-- tratamento A, 20 minutos; se o tratamento muda (limpeza), 40."
--
-- Os minutos ficam POR MÁQUINA (decisão dele): a TSI 1 e a TSI 2 podem ter
-- setups diferentes. Entram SÓ na Programação (ocupação, encaixe, cascata,
-- checklist) — não no tempo planejado da ordem nem no OEE, porque o setup
-- real já é apontado como parada Planejada ("Setup / troca de receita",
-- "Limpeza de maquina") e somá-lo ao planejado inflaria a performance.
-- ============================================================

alter table tsi.maquinas
  add column if not exists setup_mesmo_min integer not null default 20,
  add column if not exists setup_troca_min integer not null default 40;

comment on column tsi.maquinas.setup_mesmo_min is
  'Minutos de setup entre duas ordens seguidas com o MESMO tratamento (receita). Só na Programação.';
comment on column tsi.maquinas.setup_troca_min is
  'Minutos de setup quando o tratamento MUDA entre ordens seguidas (inclui limpeza). Só na Programação.';

alter table tsi.maquinas drop constraint if exists maquinas_setup_nao_negativo;
alter table tsi.maquinas add constraint maquinas_setup_nao_negativo
  check (setup_mesmo_min >= 0 and setup_troca_min >= 0);

select id, capacidade_th, setup_mesmo_min, setup_troca_min from tsi.maquinas order by id;
