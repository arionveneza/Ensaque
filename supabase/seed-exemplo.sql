-- ============================================================
-- DADOS DE EXEMPLO — apenas para desenvolvimento e demonstração
-- ============================================================
--
-- ATENÇÃO: produtos, doses e DENSIDADES aqui são ficticios plausiveis,
-- herdados do prototipo. Densidade errada desloca todo o planejado de
-- balanca. Antes de usar em producao, substitua pelas fichas tecnicas
-- (FISPQ) reais.
--
-- Para remover tudo o que este arquivo cria:
--   delete from tsi.ordens;
--   delete from tsi.lotes_semente;
--   delete from tsi.receita_itens;
--   delete from tsi.receitas;
--   delete from tsi.produtos_quimicos;
-- ============================================================

set search_path = tsi, public;

-- ---------- produtos químicos ----------
insert into produtos_quimicos (codigo, nome, unidade, densidade) values
  ('FTZ', 'Fortenza Duo',    'ml/kg', 1.08),
  ('CRU', 'Cruiser 350 FS',  'ml/kg', 1.10),
  ('MXA', 'Maxim Advanced',  'ml/kg', 1.05),
  ('DER', 'Dermacor',        'ml/kg', 1.15),
  ('RAN', 'Rancona',         'ml/kg', 1.12),
  ('POL', 'Polimero Verde',  'ml/kg', 1.20),
  ('GRF', 'Grafite',         'g/kg',  null),
  ('EKM', 'Inoculante EKM',  'ml/kg', 1.02)
on conflict (codigo) do nothing;

-- ---------- receitas (nome = código do comercial) ----------
insert into receitas (nome) values
  ('FTZ60'), ('V&P'), ('CORTEVA ESPECIAL'), ('DER + LMT'),
  ('FTZ60 + EKM'), ('CORTEVA COMPLETO'), ('FTZ ELITE')
on conflict (nome) do nothing;

insert into receita_itens (receita_id, produto_id, dose, tanque)
select r.id, p.id, v.dose, v.tanque
from (values
  ('FTZ60','FTZ',0.60,1), ('FTZ60','MXA',0.25,2),
  ('FTZ60','POL',0.30,3), ('FTZ60','GRF',0.50,4),

  ('V&P','CRU',0.45,1), ('V&P','MXA',0.25,2), ('V&P','POL',0.30,3),

  ('CORTEVA ESPECIAL','DER',0.50,1), ('CORTEVA ESPECIAL','RAN',0.35,2),
  ('CORTEVA ESPECIAL','POL',0.30,3), ('CORTEVA ESPECIAL','GRF',0.50,4),

  ('DER + LMT','DER',0.55,1), ('DER + LMT','MXA',0.20,2), ('DER + LMT','POL',0.30,3),

  ('FTZ60 + EKM','FTZ',0.60,1), ('FTZ60 + EKM','MXA',0.25,2),
  ('FTZ60 + EKM','POL',0.30,3), ('FTZ60 + EKM','EKM',0.40,5),

  -- 6 produtos em 5 tanques: MXA e POL sao MISTURADOS no tanque 3
  ('CORTEVA COMPLETO','DER',0.50,1), ('CORTEVA COMPLETO','RAN',0.35,2),
  ('CORTEVA COMPLETO','MXA',0.20,3), ('CORTEVA COMPLETO','POL',0.30,3),
  ('CORTEVA COMPLETO','GRF',0.50,4), ('CORTEVA COMPLETO','EKM',0.40,5),

  ('FTZ ELITE','FTZ',0.80,1), ('FTZ ELITE','MXA',0.25,2),
  ('FTZ ELITE','POL',0.30,3), ('FTZ ELITE','GRF',0.50,4)
) as v(receita, cod, dose, tanque)
join receitas r on r.nome = v.receita
join produtos_quimicos p on p.codigo = v.cod
on conflict (receita_id, produto_id) do nothing;

-- ---------- lotes de semente (peso_bag = PMS x fator) ----------
insert into lotes_semente (id, cultivar, pms, peso_bag_kg, bags_disp, status) values
  ('L-4412', '761 I2X',     181, 905, 200, 'Baixado'),
  ('L-4418', 'O790 IPRO',   178, 890, 150, 'Baixado'),
  ('L-4423', 'NEO680 IPRO', 182.4, 912, 120, 'Baixado'),
  ('L-4431', 'NEO700 I2X',  176, 880, 130, 'Em estoque'),
  ('L-4437', 'O760 CE',     186.8, 934, 180, 'Baixado'),
  ('L-4440', 'NEO750 IPRO', 179.6, 898, 90,  'Em estoque')
on conflict (id) do nothing;

-- ---------- ordens do dia ----------
insert into ordens (numero, cultivar, receita_id, embalagem, bags, lote_id,
                    cliente, observacao, prioridade, maquina_id, data_prog, seq, status, origem)
select v.numero, v.cultivar, r.id, v.emb, v.bags, v.lote,
       nullif(v.cliente,''), nullif(v.obs,''), v.prio::prioridade_tipo,
       v.maq, current_date, v.seq, 'Programada'::status_ordem, 'exemplo'
from (values
  ('79500-1','761 I2X',     'FTZ60',            'BG5M', 45, 'L-4412', '', '', 'Normal',  'TSI1', 1),
  ('79500-2','761 I2X',     'V&P',              'BG5M', 40, 'L-4412', '', '', 'Normal',  'TSI1', 2),
  ('82335-1','761 I2X',     'FTZ60 + EKM',      'BG5M', 35, 'L-4412', '', '', 'Urgente', 'TSI1', 3),
  ('79485-1','NEO680 IPRO', 'FTZ60',            'BG5M', 30, 'L-4423', '', '', 'Normal',  'TSI1', 4),
  ('91516-1','O760 CE',     'CORTEVA ESPECIAL', 'BG5M', 60, 'L-4437',
     'GIOVANI BATISTA PALUDO', '', 'Normal', 'TSI2', 1),
  ('79464-1','O790 IPRO',   'FTZ60',            'BG5M', 50, 'L-4418', '', '', 'Normal',  'TSI2', 2),
  ('90347-1','O790 IPRO',   'V&P',              'BG5M', 30, 'L-4418',
     'MARCIO BARBOSA DE BARROS', 'SEM GRAFITE - exigencia do cliente', 'Urgente', 'TSI2', 3),
  ('79469-1','NEO700 I2X',  'V&P',              'BG5M', 20, 'L-4431', '', '', 'Normal',  'TSI2', 4),
  ('80074-1','O760 CE',     'CORTEVA COMPLETO', 'MEIOBAG', 18, 'L-4437', '', '', 'Normal', null, null)
) as v(numero, cultivar, receita, emb, bags, lote, cliente, obs, prio, maq, seq)
join receitas r on r.nome = v.receita
on conflict (numero, cultivar, receita_id, embalagem) do nothing;
