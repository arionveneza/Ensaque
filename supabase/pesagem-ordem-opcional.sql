-- ============================================================
-- Peso da ordem passa a ser OPCIONAL na Pesagem (21/09/2026, pedido do
-- Arion: "Na tela carregamento no APP, nao permite salvar sem o peso da
-- ordem, passe a permitir"). Nem sempre esse peso está à mão na balança —
-- a tara continua obrigatória (define a capacidade líquida do veículo).
--
-- Sem tratamento, isso quebraria em dois lugares (achado ao investigar
-- antes de mexer): (1) todo caminhão pesado sem peso da ordem ficaria
-- PENDENTE pra sempre, mesmo depois de pesado — `status_ordem` caía no
-- mesmo balde de "ainda não pesou" (AGUARDANDO); (2) o CASE de
-- `status_ordem` em `calc_pesagem` comparava NULL com `<=`/`>` (sempre
-- "desconhecido" em SQL) e caía por cascata no ELSE, virando
-- 'DIVERGENTE_ABAIXO' por engano — `v_pesagens` reportaria "não liberado,
-- abaixo da ordem" pra um caminhão que só não teve o peso da ordem
-- informado.
--
-- Decisão do Arion: sem o peso da ordem, o Liberado sai só pela
-- legislação (a comparação × ordem vira uma etiqueta neutra "sem ordem
-- informada", nunca bloqueia). Mesma regra dos dois lados — TS
-- (src/dominio/pesagem.ts, novo status `SEM_ORDEM`) e aqui.
--
-- Execute no SQL Editor do Supabase (idempotente).
-- ============================================================

set search_path = tsi, public;

-- NULL sempre passa por `check (peso_ordem_kg > 0)` (nunca é FALSE, é
-- desconhecido) — só a obrigatoriedade precisa sair.
alter table pesagens alter column peso_ordem_kg drop not null;

-- mesma fórmula de src/dominio/pesagem.ts — mudou uma, mude a outra
create or replace function calc_pesagem(
  p_tara integer, p_ordem integer, p_pbt integer, p_bruto integer,
  p_tol_legal numeric, p_tol_ordem numeric
) returns table (
  capacidade_liquida_kg  integer,
  peso_bruto_previsto_kg integer,
  excesso_previsto_kg    integer,
  pode_carregar          text,
  peso_liquido_kg        integer,
  pbt_com_tolerancia_kg  numeric,
  excesso_real_kg        integer,
  diferenca_ordem_kg     integer,
  diferenca_ordem_pct    numeric,
  status_legislacao      text,
  status_ordem           text,
  liberado               text
) language sql immutable as $$
  with b as (
    select
      p_pbt - p_tara                                   as cap,
      p_tara + p_ordem                                 as previsto,
      greatest(0, p_tara + p_ordem - p_pbt)            as exc_prev,
      case when p_tara is null or p_ordem is null or p_pbt is null or p_tara <= 0 or p_ordem <= 0
           then 'INCOMPLETO'
           when p_tara + p_ordem <= p_pbt then 'SIM' else 'NAO' end as pode,
      p_pbt::numeric * (1 + p_tol_legal)               as pbt_tol,
      case when p_bruto is null or p_bruto <= p_tara then null else p_bruto - p_tara end as liq
  ),
  c as (
    select b.*,
      case when liq is null then null else greatest(0, p_bruto - p_pbt) end as exc_real,
      -- p_ordem null propaga null automaticamente (aritmética/divisão com
      -- NULL em SQL sempre dá NULL) — sem tratamento especial aqui
      case when liq is null then null else liq - p_ordem end as dif,
      case when liq is null or p_ordem = 0 then null else (liq - p_ordem)::numeric / p_ordem end as pct
    from b
  ),
  d as (
    select c.*,
      case when liq is null then 'AGUARDANDO'
           when p_bruto <= p_pbt then 'OK'
           when p_bruto::numeric <= pbt_tol then 'ATENCAO'
           else 'EXCESSO' end as leg,
      -- este SIM precisa do caso explícito: `abs(dif) <= ...` com dif NULL
      -- é NULL (desconhecido), nunca vira FALSE, e o CASE caía direto no
      -- ELSE = 'DIVERGENTE_ABAIXO' por engano
      case when liq is null then 'AGUARDANDO'
           when p_ordem is null or p_ordem <= 0 then 'SEM_ORDEM'
           when abs(dif)::numeric <= p_ordem::numeric * p_tol_ordem then 'OK'
           when dif > 0 then 'DIVERGENTE_ACIMA'
           else 'DIVERGENTE_ABAIXO' end as ord
    from c
  )
  select cap, previsto, exc_prev, pode, liq, pbt_tol, exc_real, dif, pct, leg, ord,
    case when leg = 'AGUARDANDO' or ord = 'AGUARDANDO' then 'PENDENTE'
         -- sem peso da ordem, Liberado sai só pela legislação (decisão do
         -- Arion, 21/09/2026) — SEM_ORDEM nunca bloqueia, só OK conta igual
         when leg in ('OK','ATENCAO') and ord in ('OK','SEM_ORDEM') then 'SIM'
         else 'NAO' end
  from d
$$;

-- ------------------------------------------------------------
-- Conferência
-- ------------------------------------------------------------
select 'peso_ordem_kg aceita null' as item,
  (not attnotnull)::text as ok
  from pg_attribute
 where attrelid = 'tsi.pesagens'::regclass and attname = 'peso_ordem_kg'
union all
select 'caso A sem ordem, legislacao OK -> liberado SIM',
  (peso_liquido_kg = 10200 and status_legislacao = 'OK' and status_ordem = 'SEM_ORDEM'
   and diferenca_ordem_kg is null and diferenca_ordem_pct is null and liberado = 'SIM')::text
  from calc_pesagem(9800, null, 23000, 20000, 0.05, 0.005)
union all
select 'caso B sem ordem, legislacao EXCESSO -> liberado NAO mesmo assim',
  (status_legislacao = 'EXCESSO' and status_ordem = 'SEM_ORDEM' and liberado = 'NAO')::text
  from calc_pesagem(9800, null, 23000, 25000, 0.05, 0.005)
union all
select 'caso C sem ordem, sem bruto ainda -> PENDENTE (nao SEM_ORDEM prematuro)',
  (status_legislacao = 'AGUARDANDO' and status_ordem = 'AGUARDANDO' and liberado = 'PENDENTE')::text
  from calc_pesagem(9800, null, 23000, null, 0.05, 0.005)
union all
select 'pre-conferencia sem ordem continua INCOMPLETO (nao trava, so nao confirma cabe)',
  (pode_carregar = 'INCOMPLETO')::text
  from calc_pesagem(9800, null, 23000, null, 0.05, 0.005)
union all
select 'casos 1-6 e fronteira do pesagem.sql continuam batendo (com ordem, nada mudou)',
  (
    (select liberado = 'SIM' and status_ordem = 'OK' from calc_pesagem(21400, 35000, 57000, 56300, 0.05, 0.005))
    and (select status_ordem = 'DIVERGENTE_ACIMA' and liberado = 'NAO' from calc_pesagem(28000, 46000, 74000, 76500, 0.05, 0.005))
    and (select status_legislacao = 'EXCESSO' and liberado = 'NAO' from calc_pesagem(15000, 26000, 41500, 44000, 0.05, 0.005))
  )::text;
