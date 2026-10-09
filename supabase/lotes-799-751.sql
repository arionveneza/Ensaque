-- ============================================================
-- Lotes do 799 e do 751 para montar ordem (09/10/2026, pedido do Arion:
-- "os lotes do cultivar 799 e 751 não estão aparecendo para montagem de
-- ordem de produção").
--
-- 799: o SAP traz o lote 26B98C0007 em SC200MS (saco de 200 mil sementes) —
--   o importador jogava fora como granel. Daqui pra frente ele entra pelo
--   upload (EMBALAGEM_SO_LOTE_BRANCO em sap.ts); aqui só antecipa, com os
--   dados do export de 08/10 (75 sacos, PMS 140,2, peso 28,04 kg). Não é
--   manual: o próximo upload do SAP cuida dele.
-- 751: nenhum NEO751 CE em nenhum export do SAP de 14/09 a 08/10. Os 2 lotes
--   existem só no Mapa (lançados à mão em 07/10). Decisão dele: cadastrar
--   como lote MANUAL (o upload do SAP não zera), com o peso do Mapa e o PMS
--   derivado dele (peso ÷ 5, a mesma rede do Peso Bruto do importador) —
--   sem PMS, ordem MEIOBAG desse lote usaria o peso do bag inteiro.
-- ============================================================

insert into tsi.lotes_semente
  (id, cultivar, tratamento, pms, peso_bag_kg, bags_disp, status, peneira, categoria, origem_manual)
values
  ('26B98C0007', 'NEO799 I2X', 'SEM TSI', 140.2, 28.04, 75, 'Em estoque', 'P 6.0', 'BAS', false),
  ('26B65C0162', 'NEO751 CE',  'SEM TSI', 154,   770,   4,  'Em estoque', null,    null,  true),
  ('26B65C0163', 'NEO751 CE',  'SEM TSI', 190,   950,   5,  'Em estoque', null,    null,  true)
on conflict (id) do nothing;

-- Conferência
select json_agg(row_to_json(x) order by x.id) as conferencia from (
  select id, cultivar, tratamento, pms, peso_bag_kg, bags_disp, status, origem_manual
    from tsi.lotes_semente
   where id in ('26B98C0007', '26B65C0162', '26B65C0163', '26B65C0132')
) x;
