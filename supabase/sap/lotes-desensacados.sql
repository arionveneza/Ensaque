-- ============================================================
-- Lotes de semente desensacados — SAP B1 (HANA)
-- ============================================================
--
-- Para rodar no Query Manager do cliente B1 (produção: é SELECT,
-- somente leitura). Depois pode virar consulta de origem 'sap' no
-- gerenciador do app, como LotesSA.
--
-- ============================================================
-- ESQUEMA DESCOBERTO NA BASE (04/08/2026, via CUFD/System Info)
-- ============================================================
--
-- Ordem de serviço da Agrotis (form AGRTFrmOrdem) é UDO de dados
-- mestres:
--   @AGRT_ORDEM    cabeçalho — chave "Code" (ex. 0000272);
--                  U_AGRT_DocNum = nº da tela (272);
--                  U_AGRT_Tipo: 'D' = Desensaque;
--                  U_AGRT_Situacao: 'L' = Fechada
--   @AGRT_ORDEMMP  itens a consumir — só item, depósito e
--                  quantidades (U_AGRT_QtdPlan/QtdEmit). SEM lote.
--
-- O lote vive nos documentos padrão. Ao "Produzir", o add-on emite
-- Saída de mercadoria/Emissão p/ produção (OIGE/IGE1, ObjType 60)
-- CARIMBADA com a ordem de serviço:
--   OIGE.U_AGRT_VincOP    'Y'/'N' — vinculada a uma ordem
--   OIGE.U_AGRT_CodigoOP  código da ordem de serviço
--   OIGE.U_TX_Ordem       nº da ordem de produção (OWOR)
--   IGE1.U_AGRT_LinhaOP   linha da OP
--
-- E o rastro de lote é o padrão do B1:
--   OITL (DocType 60 + DocEntry/DocLine do documento)
--    └─ ITL1 (lote × quantidade; saída = negativo, por isso ABS)
--        └─ OBTN (DistNumber = número do lote visível)
--
-- O join usa Code OU DocNum-como-texto porque o formato gravado em
-- U_AGRT_CodigoOP ('0000272' ou '272') não foi confirmado — os dois
-- não colidem entre si (Code é zero-padded).
--
-- "Total embalagens (ordem)" = soma dos bags de todos os lotes da
-- mesma ordem (window function), que deve bater com o "Emitido" da
-- tela (ex.: 81 na ordem 272).
--
-- Diagnóstico se vier vazio (mostra o formato real do vínculo):
--   SELECT "DocNum", "DocDate", "U_AGRT_VincOP", "U_AGRT_CodigoOP",
--          "U_TX_Ordem"
--   FROM "OIGE" ORDER BY "DocEntry" DESC LIMIT 20
-- ============================================================

SELECT
  'Desensaque'                         AS "Tipo de transação",
  a."U_AGRT_DocNum"                    AS "Nº ordem serviço",
  COALESCE(w."DocNum", o."U_TX_Ordem") AS "Nº OP",
  a."U_AGRT_DataIni"                   AS "Data",
  t."ItemCode"                         AS "Item",
  i."ItemName"                         AS "Descrição",
  b."DistNumber"                       AS "Lote",
  ABS(SUM(t."Quantity"))               AS "Bags do lote",
  SUM(ABS(SUM(t."Quantity")))
    OVER (PARTITION BY a."U_AGRT_DocNum") AS "Total embalagens (ordem)",
  g."LocCode"                          AS "Depósito"

FROM "@AGRT_ORDEM" a
  INNER JOIN "OIGE" o
    ON (o."U_AGRT_CodigoOP" = a."Code"
        OR o."U_AGRT_CodigoOP" = TO_VARCHAR(a."U_AGRT_DocNum"))
  INNER JOIN "IGE1" l ON l."DocEntry" = o."DocEntry"
  INNER JOIN "OITL" g ON g."DocType" = 60
    AND g."DocEntry" = o."DocEntry" AND g."DocLine" = l."LineNum"
  INNER JOIN "ITL1" t ON t."LogEntry" = g."LogEntry"
  INNER JOIN "OBTN" b ON b."ItemCode" = t."ItemCode" AND b."SysNumber" = t."SysNumber"
  INNER JOIN "OITM" i ON i."ItemCode" = t."ItemCode"
  LEFT JOIN "OWOR" w ON l."BaseType" = 202 AND w."DocEntry" = l."BaseEntry"

WHERE a."U_AGRT_Tipo" = 'D'

GROUP BY a."U_AGRT_DocNum", a."U_AGRT_DataIni", t."ItemCode", i."ItemName",
         b."DistNumber", g."LocCode", w."DocNum", o."U_TX_Ordem"

ORDER BY a."U_AGRT_DocNum" DESC, b."DistNumber"
