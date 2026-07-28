-- ============================================================
-- Pedidos de venda no SAP B1 (HANA) — fonte da demanda do TSI
-- ============================================================
--
-- Registrada no Service Layer como SQLQuery e executada por
--   GET /b1s/v1/SQLQueries('TSI_PEDIDOS')/List
--
-- ============================================================
-- POR QUE ESTA VERSÃO É ENXUTA
-- ============================================================
--
-- A consulta original da Veneza junta oito tabelas. Ao registrá-la, o SAP
-- recusou com "Table 'OSLP' not accessible": o usuário de integração não tem
-- autorização no cadastro de vendedores. O mesmo valeria provavelmente para
-- OBPL, OUSG, OSHP e a UDT de situação.
--
-- Em vez de pedir mais permissões, esta versão usa só o que o TSI precisa
-- para planejar produção: ORDR e RDR1. Vendedor, filial, transportadora,
-- endereço e utilização são colunas de RELATÓRIO — não entram no balanço de
-- demanda nem definem o que a máquina trata.
--
-- Isso também reduz a superfície de permissão do usuário de integração, que
-- é desejável por si só: quanto menos tabelas ele precisa enxergar, menor o
-- estrago possível se a credencial vazar.
--
-- A situação de venda é devolvida como CÓDIGO (U_AGRT_SitVenda), sem juntar a
-- UDT que traz a descrição. O código basta para filtrar; a descrição é
-- cosmética e custaria mais uma tabela.
--
-- ============================================================
-- CORREÇÕES HERDADAS DA CONSULTA ORIGINAL
-- ============================================================
--
-- 1. Removido o join `RDR1 T4 ON T4.SlpCode = T3.SlpCode`. T4 não era usado
--    em nenhuma coluna e ligava só pelo vendedor, multiplicando cada linha
--    pelo número de itens que aquele vendedor já vendeu. O DISTINCT escondia
--    o efeito no resultado, mas o banco processava a explosão inteira.
-- 2. Sem o schema fixo "SBOVENPRD", para a mesma consulta servir homologação.
-- 3. Só linha aberta com saldo: `OpenCreQty` é o equivalente ao "Saldo a
--    Faturar" (coluna BW) do relatório da SimpleAgro.
-- ============================================================

SELECT
  T0."DocNum"              AS "PV",
  T0."DocDate"             AS "DataPedido",
  T0."U_AGRT_Safra"        AS "Safra",
  T0."CardCode"            AS "CodPN",
  T0."CardName"            AS "NomePN",
  T0."U_AGRT_SitVenda"     AS "SituacaoPedido",
  T1."ItemCode"            AS "CodItem",
  T1."Dscription"          AS "DescricaoItem",
  T1."U_TP_Tratamento"     AS "Tratamento",
  T1."Quantity"            AS "Quantidade",
  T1."OpenCreQty"          AS "QuantidadePendente",
  T1."WhsCode"             AS "Deposito",
  T1."LineTotal"           AS "TotalLinha",
  T1."LineStatus"          AS "Status"

FROM "ORDR" T0
  INNER JOIN "RDR1" T1 ON T1."DocEntry" = T0."DocEntry"

WHERE T0."CANCELED" = 'N'
  AND T1."LineStatus" = 'O'
  AND T1."OpenCreQty" > 0

ORDER BY T0."DocNum" DESC

-- ============================================================
-- Se um dia o usuário de integração ganhar as autorizações, as colunas de
-- relatório voltam com estes LEFT JOIN — nunca INNER, porque INNER faz o
-- pedido sem o atributo DESAPARECER do resultado, e no balanço de demanda
-- isso vira produção planejada a menos, sem aviso nenhum:
--
--   LEFT JOIN "OSLP"  ON "OSLP"."SlpCode"   = T0."SlpCode"      -- vendedor
--   LEFT JOIN "OBPL"  ON "OBPL"."BPLId"     = T0."BPLId"        -- filial
--   LEFT JOIN "OUSG"  ON "OUSG"."ID"        = T1."Usage"        -- utilização
--   LEFT JOIN "RDR12" ON "RDR12"."DocEntry" = T0."DocEntry"     -- endereço
--   LEFT JOIN "OSHP"  ON "OSHP"."TrnspCode" = T0."TrnspCode"    -- tipo envio
--   LEFT JOIN "@AGRT_SITPEDVENDA" ON "Code" = T0."U_AGRT_SitVenda"
-- ============================================================
