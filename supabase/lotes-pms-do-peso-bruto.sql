-- Lotes que entraram sem PMS na carga de saldos do SAP de 10/09/2026
-- ====================================================================
-- A coluna "PMS (g)" do export do SAP vem com formatos misturados. Em 6
-- linhas da carga de 10/09 ela era ilegível pro importador:
--   * 3 células formatadas como DATA (o leitor de xlsx devolve um Date
--     montado do número de série do Excel: 19/07/1900 = dia 201 = PMS 201);
--   * 2 números fora de escala (1208880 e 1318880), que a trava contra o
--     "numeric field overflow" zera de propósito;
--   * 1 (SV0012036762039-2) num export que já não existe no computador —
--     no arquivo seguinte a célula dele voltou a ser o número 205.
-- Resultado: pms NULL e peso_bag_kg 0, e as ordens P73 e P77 saíram com
-- peso, tempo planejado e ocupação zerados.
--
-- Os valores abaixo vêm da coluna "Peso Bruto" da MESMA linha do mesmo
-- export (peso do bag em kg), dividida pelo fator da embalagem — todas as
-- 6 são BB5M, fator 5. Essa coluna bate com PMS × fator em 100% das 1.137
-- linhas do arquivo que têm as duas, e é a mesma fonte que o importador
-- passou a usar como rede a partir desta correção. peso_bag_kg segue o
-- arredondamento que o importador faz (inteiro), pra que reimportar o
-- arquivo não mude nada.
--
-- Só mexe em pms/peso_bag_kg, e só onde ainda está faltando: saldo, status
-- e histórico ficam intactos. Rodar uma vez; rodar de novo não faz nada.

update tsi.lotes_semente as l
   set pms           = v.pms,
       peso_bag_kg   = v.peso_bag_kg,
       atualizado_em = now()
  from (values
    ('SV0012036762039-2', 205.000::numeric, 1025::numeric),
    ('SV0012036762011-2', 201.000::numeric, 1005::numeric),
    ('SV0022036062020-1', 169.000::numeric,  845::numeric),
    ('SV0072036762036-3', 204.000::numeric, 1020::numeric),
    ('A267672319-2',      120.888::numeric,  604::numeric),
    ('A267672323-1',      131.888::numeric,  659::numeric)
  ) as v(id, pms, peso_bag_kg)
 where l.id = v.id
   and coalesce(l.pms, 0) = 0;

-- Conferência: os 6 com peso, e as ordens que dependiam deles.
select
  (select jsonb_agg(jsonb_build_object('lote', id, 'pms', pms, 'peso_bag_kg', peso_bag_kg, 'bags', bags_disp) order by id)
     from tsi.lotes_semente
    where id in ('SV0012036762039-2','SV0012036762011-2','SV0022036062020-1',
                 'SV0072036762036-3','A267672319-2','A267672323-1')) as corrigidos,
  (select jsonb_agg(jsonb_build_object('ordem', numero, 'lote', lote_id, 'bags', bags,
                                       'peso_bag', peso_bag_ordem_kg, 'peso_t', peso_t) order by numero)
     from tsi.v_ordens
    where lote_id in ('SV0012036762039-2','SV0012036762011-2','SV0022036062020-1',
                      'SV0072036762036-3','A267672319-2','A267672323-1')) as ordens,
  (select count(*) from tsi.lotes_semente where coalesce(pms,0) = 0 and bags_disp > 0) as ainda_sem_pms_com_saldo;
