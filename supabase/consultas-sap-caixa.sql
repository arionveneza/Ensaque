-- ============================================================
-- Código de consulta em caixa mista + cadastro das 6 consultas reais
-- Execute no SQL Editor do Supabase
-- ============================================================
--
-- O botão "Ver o que existe no SAP" revelou as consultas já registradas:
-- LotesSA, LotesSATratamentos, LotesSANome, LotesSAProduto, LotesSAOri e
-- LotesAnaliseSA. Os códigos são em caixa MISTA, e o SAP diferencia
-- maiúsculas de minúsculas — a regra antiga (só maiúsculas) transformava
-- LotesSA em LOTESSA, que não existe lá. Era isso que derrubava a execução.
--
-- O TESTE1 é removido: não existe no SAP (não aparece na listagem), e o 403
-- que ele gerava era o SAP recusando uma consulta inexistente.
-- ============================================================

set search_path = tsi, public;

alter table consultas_sap drop constraint if exists consultas_sap_codigo_check;
alter table consultas_sap add constraint consultas_sap_codigo_check
  check (codigo ~ '^[A-Za-z][A-Za-z0-9_]{2,29}$');

delete from consultas_sap where codigo = 'TESTE1';

-- origem 'sap': já vivem no Service Layer, o app só executa.
-- O campo sql fica vazio até alguém colar o texto como documentação.
insert into consultas_sap (codigo, nome, descricao, sql, origem) values
  ('LotesSA',            'LotesSA',            'Consulta já registrada no SAP.', '', 'sap'),
  ('LotesSATratamentos', 'LotesSATratamentos', 'Consulta já registrada no SAP.', '', 'sap'),
  ('LotesSANome',        'LotesSANome',        'Consulta já registrada no SAP.', '', 'sap'),
  ('LotesSAProduto',     'LotesSAProduto',     'Consulta já registrada no SAP.', '', 'sap'),
  ('LotesSAOri',         'LotesSAOri',         'Consulta já registrada no SAP.', '', 'sap'),
  ('LotesAnaliseSA',     'LotesAnaliseSA',     'Consulta já registrada no SAP.', '', 'sap')
on conflict (codigo) do nothing;

select codigo, origem from consultas_sap order by codigo;
