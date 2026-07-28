-- ============================================================
-- Consultas SQL do SAP gerenciadas pelo app
-- Execute no SQL Editor do Supabase, depois do schema.sql
-- ============================================================
--
-- A ideia: em vez de o código da Edge Function carregar uma consulta fixa,
-- as consultas ficam aqui. O app salva, edita e manda registrar no Service
-- Layer, e depois executa por código quantas vezes precisar.
--
-- O SQL fica guardado nos dois lugares de propósito: aqui é a fonte
-- editável e versionada por quem mexeu; no SAP é a consulta registrada que
-- de fato executa. `registrada_em` diz se os dois estão em dia.
-- ============================================================

set search_path = tsi, public;

create table if not exists consultas_sap (
  id            uuid primary key default gen_random_uuid(),
  -- código usado no SAP: GET /SQLQueries('<codigo>')/List
  codigo        text unique not null
                check (codigo ~ '^[A-Z][A-Z0-9_]{2,29}$'),
  nome          text not null,
  descricao     text,
  sql           text not null,
  -- última vez que este SQL foi enviado ao SAP; null = nunca registrada,
  -- e se for anterior a atualizado_em, o SAP está com versão velha
  registrada_em timestamptz,
  ativa         boolean not null default true,
  criada_por    uuid references usuarios(id),
  criada_em     timestamptz not null default now(),
  atualizada_em timestamptz not null default now()
);

comment on column consultas_sap.codigo is
  'Maiúsculas, dígitos e underscore. É a chave no SAP, não muda depois de registrada.';

-- toda alteração no SQL invalida o registro anterior: o SAP fica desatualizado
create or replace function fn_consulta_sap_alterada() returns trigger as $$
begin
  new.atualizada_em := now();
  -- mudou o SQL? então o que está no SAP não é mais esta consulta
  if new.sql is distinct from old.sql then
    new.registrada_em := null;
  end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;

create trigger tg_consulta_sap_alterada before update on consultas_sap
  for each row execute function fn_consulta_sap_alterada();

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
alter table consultas_sap enable row level security;

-- ler: qualquer usuário ativo (a tela mostra o que existe)
create policy ler_consultas_sap on consultas_sap for select
  using (meu_perfil() is not null);

-- escrever: só Gestor. Uma consulta aqui vira SQL executado no ERP —
-- é poder de administrador, não de operação.
create policy gestor_consultas_sap on consultas_sap for all
  using (meu_perfil() = 'Gestor') with check (meu_perfil() = 'Gestor');

grant all on consultas_sap to anon, authenticated, service_role;

-- ------------------------------------------------------------
-- Consulta inicial: pedidos de venda em aberto
-- ------------------------------------------------------------
-- Enxuta de propósito: usa só ORDR e RDR1. A versão original juntava oito
-- tabelas e o SAP recusou com "Table 'OSLP' not accessible" — o usuário de
-- integração não tem autorização no cadastro de vendedores. Vendedor, filial
-- e transportadora sao colunas de relatorio; o TSI planeja producao com
-- cultivar, tratamento e saldo.
insert into consultas_sap (codigo, nome, descricao, sql) values (
  'TSI_PEDIDOS',
  'Pedidos de venda em aberto',
  'Base da demanda do TSI. U_TP_Tratamento traz o código do tratamento e OpenCreQty é o equivalente ao Saldo a Faturar da SimpleAgro.',
$sql$SELECT
  T0."DocNum"          AS "PV",
  T0."DocDate"         AS "DataPedido",
  T0."U_AGRT_Safra"    AS "Safra",
  T0."CardCode"        AS "CodPN",
  T0."CardName"        AS "NomePN",
  T0."U_AGRT_SitVenda" AS "SituacaoPedido",
  T1."ItemCode"        AS "CodItem",
  T1."Dscription"      AS "DescricaoItem",
  T1."U_TP_Tratamento" AS "Tratamento",
  T1."Quantity"        AS "Quantidade",
  T1."OpenCreQty"      AS "QuantidadePendente",
  T1."WhsCode"         AS "Deposito",
  T1."LineTotal"       AS "TotalLinha",
  T1."LineStatus"      AS "Status"
FROM "ORDR" T0
  INNER JOIN "RDR1" T1 ON T1."DocEntry" = T0."DocEntry"
WHERE T0."CANCELED" = 'N'
  AND T1."LineStatus" = 'O'
  AND T1."OpenCreQty" > 0
ORDER BY T0."DocNum" DESC$sql$
) on conflict (codigo) do nothing;
