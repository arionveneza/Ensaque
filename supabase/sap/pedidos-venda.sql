-- ============================================================
-- Pedidos de venda no SAP B1 (HANA) — fonte da demanda do TSI
-- ============================================================
--
-- Substitui o relatório "Pedidos Analítico Resumido" da SimpleAgro.
-- Registrada no Service Layer como SQLQuery e executada por
--   GET /b1s/v1/SQLQueries('TSI_PEDIDOS')/List
--
-- Partiu da consulta que a Veneza já usa no cliente B1, com três correções:
--
-- 1. REMOVIDO o join `RDR1 T4 ON T4.SlpCode = T3.SlpCode`.
--    T4 não era usado em lugar nenhum do SELECT e ligava apenas pelo código do
--    vendedor — ou seja, multiplicava cada linha pelo número de itens que
--    aquele vendedor já vendeu na vida. O DISTINCT escondia o efeito no
--    resultado, mas o banco processava tudo. É a diferença entre a consulta
--    voltar em segundos ou em minutos.
--
-- 2. INNER JOIN -> LEFT JOIN nos atributos opcionais (utilização, filial,
--    endereço, situação, tipo de envio). Com INNER, um pedido sem tipo de
--    envio cadastrado simplesmente DESAPARECE do resultado. Num relatório
--    isso passa; no balanço de demanda do TSI significa perder pedido e
--    planejar produção a menos, sem nenhum aviso.
--
-- 3. Schema "SBOVENPRD" removido dos nomes de tabela. A SQLQuery roda no
--    contexto da base conectada, então fixar o schema impede testar em
--    homologação sem editar a consulta.
--
-- Também acrescentado filtro de linha aberta: o TSI só precisa do que ainda
-- vai ser faturado. `OpenCreQty` é o equivalente ao "Saldo a Faturar" (coluna
-- BW) do relatório da SimpleAgro.
-- ============================================================

SELECT
  T2."DocNum"                        AS "PV",
  T2."DocDate"                       AS "DataPedido",
  T2."U_AGRT_Safra"                  AS "Safra",
  T5."BPLName"                       AS "Filial",
  T3."SlpName"                       AS "Vendedor",
  T2."U_GR_COMPRAS"                  AS "GrupoCompras",
  T2."U_Agente"                      AS "Agente",
  T2."CardCode"                      AS "CodPN",
  T2."CardName"                      AS "NomePN",
  T6."CityB"                         AS "Cidade",
  T6."StateB"                        AS "Estado",
  T6."CountryB"                      AS "Pais",
  T1."ItemCode"                      AS "CodItem",
  T1."Dscription"                    AS "DescricaoItem",
  T1."Quantity"                      AS "Quantidade",
  T1."OpenCreQty"                    AS "QuantidadePendente",
  T1."U_TP_Tratamento"               AS "Tratamento",
  T1."U_AGRC_VlrUnitLiq"             AS "Germoplasma",
  T1."U_AGRC_VlrTratamento"          AS "TSI",
  T1."U_AGRC_VlrRoyaties"            AS "Royalties",
  T1."U_AGRC_VlrFrete"               AS "Frete",
  T1."U_AGRC_VlrOutros"              AS "Outros",
  T1."LineTotal"                     AS "TotalLinha",
  T0."Usage"                         AS "Utilizacao",
  T8."TrnspName"                     AS "TipoEnvio",
  T1."WhsCode"                       AS "Deposito",
  T7."Name"                          AS "SituacaoPedido",
  T1."LineStatus"                    AS "Status"

FROM "ORDR" T2
  INNER JOIN "RDR1"  T1 ON T1."DocEntry" = T2."DocEntry"
  LEFT  JOIN "OSLP"  T3 ON T3."SlpCode"  = T2."SlpCode"
  LEFT  JOIN "OUSG"  T0 ON T0."ID"       = T1."Usage"
  LEFT  JOIN "OBPL"  T5 ON T5."BPLId"    = T2."BPLId"
  LEFT  JOIN "RDR12" T6 ON T6."DocEntry" = T2."DocEntry"
  LEFT  JOIN "@AGRT_SITPEDVENDA" T7 ON T7."Code" = T2."U_AGRT_SitVenda"
  LEFT  JOIN "OSHP"  T8 ON T8."TrnspCode" = T2."TrnspCode"

WHERE T2."CANCELED" = 'N'
  AND T1."LineStatus" = 'O'
  AND T1."OpenCreQty" > 0

ORDER BY T2."DocNum" DESC
