-- ============================================================
-- Pesagem — checklist de carregamento com conferência de peso — 14/09/2026
--
-- Especificação do Arion: substitui a planilha
-- Checklist_Carregamento_Pesagem.xlsx com as MESMAS regras, agora com três
-- operadores da balança lançando ao mesmo tempo. Duas etapas por veículo:
--
-- 1. PRÉ-CONFERÊNCIA (antes de carregar): tara + peso da ordem cabem no PBT
--    (peso bruto total legal) do tipo de veículo? Sem tolerância — a
--    tolerância legal é margem de balança, não de planejamento.
-- 2. CONFERÊNCIA FINAL (depois da pesagem): líquido = bruto − tara;
--    legislação (dentro do PBT / dentro da tolerância legal de 5% / excesso);
--    líquido × ordem (tolerância de 0,5%); parecer "Liberado?".
--
-- Decisões do Arion (14/09/2026): módulo TOTALMENTE separado da montagem de
-- carga do Mapa (cargas_montadas tem placa/tara/peso, mas não se cruza);
-- só a Balança registra, o Gestor administra (tipos, tolerâncias, correção
-- de pesagem); pré-conferência NÃO permite a etapa 2 COM JUSTIFICATIVA
-- (observação obrigatória, quem autorizou e quando ficam gravados).
--
-- Por que a tabela chama `pesagens` e não `carregamentos`: `carregamentos`
-- já existe (foto legada da SimpleAgro que a Expedição lê).
--
-- O que fica congelado na linha: `pbt_max_kg_aplicado` (no INSERT) e as
-- duas tolerâncias (na PRIMEIRA gravação do bruto). Mudar o PBT de um tipo
-- ou uma tolerância vale só para o futuro — o histórico não muda de status.
--
-- Concorrência: `versao` inteira, incrementada pelo gatilho; o cliente grava
-- com `.eq('versao', v)` e zero linhas = "outro operador alterou". Inteiro,
-- não `atualizado_em`: o PostgREST devolve microssegundos, `Date` trunca em
-- ms e a comparação nunca casaria.
--
-- A fórmula vive em UMA função pura (`calc_pesagem`), usada pela view
-- `v_pesagens` e pela conferência no fim deste arquivo (6 casos de aceite da
-- especificação). O front tem a MESMA fórmula em src/dominio/pesagem.ts —
-- mudou uma, mude a outra.
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 1. Tipos de veículo (parâmetro, editável pelo administrador)
-- ------------------------------------------------------------
create table if not exists tipos_veiculo (
  id          uuid primary key default gen_random_uuid(),
  nome        text unique not null check (nome <> ''),
  pbt_max_kg  integer not null check (pbt_max_kg > 0),
  ativo       boolean not null default true
);
comment on table tipos_veiculo is
  'Tipos de veículo da pesagem com o PBT (peso bruto total) máximo legal em kg (14/09/2026).';

insert into tipos_veiculo (nome, pbt_max_kg) values
  ('Rodotrem',   74000),
  ('Bitrem',     57000),
  ('LS Simples', 41500),
  ('LS Trucada', 48500),
  ('LS 4 Eixos', 58500),
  ('Truck',      23000),
  ('Bitruck',    29000)
on conflict (nome) do nothing;

alter table tipos_veiculo enable row level security;
drop policy if exists ler_tipos_veiculo on tipos_veiculo;
create policy ler_tipos_veiculo on tipos_veiculo for select using (meu_perfil() is not null);
drop policy if exists adm_tipos_veiculo on tipos_veiculo;
create policy adm_tipos_veiculo on tipos_veiculo for all
  using (tem_acao('pesagem','administrar')) with check (tem_acao('pesagem','administrar'));

-- ------------------------------------------------------------
-- 2. Parâmetros (linha única)
-- ------------------------------------------------------------
create table if not exists parametros_pesagem (
  id                    smallint primary key default 1 check (id = 1),
  -- Lei 7.408/85: 5% sobre o PBT. Só na etapa 2.
  tolerancia_legal_pct  numeric(6,4) not null default 0.05
                        check (tolerancia_legal_pct >= 0 and tolerancia_legal_pct < 1),
  -- diferença aceitável entre líquido e ordem (premissa inicial 0,5%)
  tolerancia_ordem_pct  numeric(6,4) not null default 0.005
                        check (tolerancia_ordem_pct >= 0 and tolerancia_ordem_pct < 1),
  atualizado_em         timestamptz not null default now(),
  atualizado_por        uuid references usuarios(id)
);
insert into parametros_pesagem (id) values (1) on conflict (id) do nothing;

alter table parametros_pesagem enable row level security;
drop policy if exists ler_param_pesagem on parametros_pesagem;
create policy ler_param_pesagem on parametros_pesagem for select using (meu_perfil() is not null);
-- só UPDATE: ninguém cria segunda linha nem apaga a única
drop policy if exists adm_param_pesagem on parametros_pesagem;
create policy adm_param_pesagem on parametros_pesagem for update
  using (tem_acao('pesagem','administrar')) with check (tem_acao('pesagem','administrar'));

-- ------------------------------------------------------------
-- 3. Pesagens (uma linha por veículo/ordem)
-- ------------------------------------------------------------
create table if not exists pesagens (
  id                      uuid primary key default gen_random_uuid(),
  -- etapa 1
  data                    date not null default current_date,
  numero_ordem            text not null check (numero_ordem <> ''),
  placa                   text not null check (placa ~ '^[A-Z0-9]{7}$'),
  tipo_veiculo_id         uuid not null references tipos_veiculo(id),
  peso_tara_kg            integer not null check (peso_tara_kg > 0),
  peso_ordem_kg           integer not null check (peso_ordem_kg > 0),
  pbt_max_kg_aplicado     integer not null,   -- congelado do tipo no INSERT (gatilho)
  -- etapa 2
  peso_bruto_final_kg     integer check (peso_bruto_final_kg is null or peso_bruto_final_kg > peso_tara_kg),
  tol_legal_pct_aplicada  numeric(6,4),       -- congeladas na 1ª gravação do bruto
  tol_ordem_pct_aplicada  numeric(6,4),
  pesado_em               timestamptz,
  pesado_por              uuid references usuarios(id),
  -- pré-conferência NÃO e mesmo assim pesou: justificativa em observacoes
  excesso_autorizado_em   timestamptz,
  excesso_autorizado_por  uuid references usuarios(id),
  -- correção do bruto pelo administrador (pesado_* guarda a 1ª pesagem)
  corrigido_em            timestamptz,
  corrigido_por           uuid references usuarios(id),
  observacoes             text,
  -- auditoria e concorrência
  criado_em               timestamptz not null default now(),
  criado_por              uuid references usuarios(id),
  atualizado_em           timestamptz not null default now(),
  versao                  integer not null default 1
);
create index if not exists pesagens_data on pesagens (data desc);
create index if not exists pesagens_placa on pesagens (placa);
create index if not exists pesagens_ordem on pesagens (numero_ordem);
-- três operadores ao mesmo tempo: um carregamento EM ABERTO por ordem + placa
-- (a mesma ordem pode voltar noutro caminhão, ou o mesmo caminhão noutra ordem)
create unique index if not exists pesagens_aberta_unica
  on pesagens (numero_ordem, placa) where peso_bruto_final_kg is null;
comment on table pesagens is
  'Checklist de carregamento: pré-conferência (tara + ordem × PBT) e pesagem final (bruto → líquido, legislação, × ordem). 14/09/2026.';

-- ------------------------------------------------------------
-- 4. Regras (gatilho)
-- ------------------------------------------------------------
create or replace function fn_pesagens_regras() returns trigger
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_excesso integer;
begin
  -- normalização: o front já faz, aqui é garantia
  new.placa := upper(regexp_replace(coalesce(new.placa, ''), '[^A-Za-z0-9]', '', 'g'));
  new.numero_ordem := trim(coalesce(new.numero_ordem, ''));
  new.atualizado_em := now();

  if tg_op = 'INSERT' then
    new.criado_por := coalesce(auth.uid(), new.criado_por);
    new.criado_em := now();
    new.versao := 1;
    if new.peso_bruto_final_kg is not null then
      raise exception 'Peso bruto final só na etapa 2 (pesagem), depois de registrar o carregamento.';
    end if;
    select pbt_max_kg into new.pbt_max_kg_aplicado
      from tipos_veiculo where id = new.tipo_veiculo_id and ativo;
    if new.pbt_max_kg_aplicado is null then
      raise exception 'Tipo de veículo inexistente ou inativo.';
    end if;
    new.pesado_em := null; new.pesado_por := null;
    new.corrigido_em := null; new.corrigido_por := null;
    new.excesso_autorizado_em := null; new.excesso_autorizado_por := null;
    new.tol_legal_pct_aplicada := null; new.tol_ordem_pct_aplicada := null;
    return new;
  end if;

  -- UPDATE ---------------------------------------------------
  new.versao := old.versao + 1;   -- o cliente não manda versão; a trava é o filtro do update
  if new.id <> old.id or new.criado_em <> old.criado_em
     or new.criado_por is distinct from old.criado_por then
    raise exception 'id/criado_em/criado_por não mudam.';
  end if;

  -- campos da etapa 1
  if (new.data, new.numero_ordem, new.placa, new.tipo_veiculo_id, new.peso_tara_kg, new.peso_ordem_kg)
     is distinct from
     (old.data, old.numero_ordem, old.placa, old.tipo_veiculo_id, old.peso_tara_kg, old.peso_ordem_kg) then
    if old.peso_bruto_final_kg is not null and not tem_acao('pesagem','administrar') then
      raise exception 'Carregamento já pesado: só o administrador altera os dados da etapa 1.';
    end if;
    if new.tipo_veiculo_id <> old.tipo_veiculo_id and old.peso_bruto_final_kg is not null then
      -- o PBT aplicado é histórico; trocar o tipo deixaria tipo e PBT de veículos diferentes
      raise exception 'Carregamento já pesado: o tipo de veículo não muda (o PBT aplicado é histórico).';
    end if;
    if new.tipo_veiculo_id <> old.tipo_veiculo_id and old.peso_bruto_final_kg is null then
      -- ainda não pesado: trocar o tipo recongela o PBT
      select pbt_max_kg into new.pbt_max_kg_aplicado
        from tipos_veiculo where id = new.tipo_veiculo_id and ativo;
      if new.pbt_max_kg_aplicado is null then
        raise exception 'Tipo de veículo inexistente ou inativo.';
      end if;
    end if;
  end if;
  if old.peso_bruto_final_kg is not null and new.pbt_max_kg_aplicado <> old.pbt_max_kg_aplicado then
    raise exception 'PBT aplicado não muda depois da pesagem — é o histórico.';
  end if;
  if old.peso_bruto_final_kg is null and new.tipo_veiculo_id = old.tipo_veiculo_id then
    new.pbt_max_kg_aplicado := old.pbt_max_kg_aplicado;
  end if;

  -- carimbos que só o gatilho grava
  new.pesado_em := old.pesado_em; new.pesado_por := old.pesado_por;
  new.corrigido_em := old.corrigido_em; new.corrigido_por := old.corrigido_por;
  new.excesso_autorizado_em := old.excesso_autorizado_em;
  new.excesso_autorizado_por := old.excesso_autorizado_por;
  new.tol_legal_pct_aplicada := old.tol_legal_pct_aplicada;
  new.tol_ordem_pct_aplicada := old.tol_ordem_pct_aplicada;

  if old.peso_bruto_final_kg is null and new.peso_bruto_final_kg is not null then
    -- primeira pesagem
    new.pesado_em := now();
    new.pesado_por := auth.uid();
    select tolerancia_legal_pct, tolerancia_ordem_pct
      into new.tol_legal_pct_aplicada, new.tol_ordem_pct_aplicada
      from parametros_pesagem where id = 1;
    new.tol_legal_pct_aplicada := coalesce(new.tol_legal_pct_aplicada, 0.05);
    new.tol_ordem_pct_aplicada := coalesce(new.tol_ordem_pct_aplicada, 0.005);
    v_excesso := (new.peso_tara_kg + new.peso_ordem_kg) - new.pbt_max_kg_aplicado;
    if v_excesso > 0 then
      if length(trim(coalesce(new.observacoes, ''))) = 0 then
        raise exception 'Pré-conferência NÃO: tara + ordem excedem o PBT em % kg. Justifique em observações para pesar mesmo assim.', v_excesso;
      end if;
      new.excesso_autorizado_em := now();
      new.excesso_autorizado_por := auth.uid();
    end if;
  elsif old.peso_bruto_final_kg is not null
        and new.peso_bruto_final_kg is distinct from old.peso_bruto_final_kg then
    -- correção: só o administrador, e nunca "apagar" — apagar reabriria a
    -- 1ª pesagem (pesado_em/por e tolerâncias seriam sobrescritos na próxima)
    if not tem_acao('pesagem','administrar') then
      raise exception 'Peso bruto final já registrado: só o administrador corrige.';
    end if;
    if new.peso_bruto_final_kg is null then
      raise exception 'Peso bruto final não se apaga: corrija com o valor certo.';
    end if;
    new.corrigido_em := now();
    new.corrigido_por := auth.uid();
  end if;

  -- a justificativa do excesso autorizado não se apaga depois
  if old.excesso_autorizado_em is not null and length(trim(coalesce(new.observacoes, ''))) = 0 then
    raise exception 'Este carregamento foi pesado acima do PBT com justificativa: a observação não pode ficar vazia.';
  end if;

  return new;
end $$;

drop trigger if exists tg_pesagens_regras on pesagens;
create trigger tg_pesagens_regras before insert or update on pesagens
  for each row execute function fn_pesagens_regras();

alter table pesagens enable row level security;
drop policy if exists ler_pesagens on pesagens;
create policy ler_pesagens on pesagens for select using (meu_perfil() is not null);
drop policy if exists insere_pesagens on pesagens;
create policy insere_pesagens on pesagens for insert
  with check (tem_acao('pesagem','registrar') or tem_acao('pesagem','administrar'));
drop policy if exists altera_pesagens on pesagens;
create policy altera_pesagens on pesagens for update
  using (tem_acao('pesagem','registrar') or tem_acao('pesagem','administrar'))
  with check (tem_acao('pesagem','registrar') or tem_acao('pesagem','administrar'));
-- sem policy de delete: registro de conformidade

-- ------------------------------------------------------------
-- 5. Fórmula pura (a mesma de src/dominio/pesagem.ts)
-- ------------------------------------------------------------
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
      case when liq is null then 'AGUARDANDO'
           when abs(dif)::numeric <= p_ordem::numeric * p_tol_ordem then 'OK'
           when dif > 0 then 'DIVERGENTE_ACIMA'
           else 'DIVERGENTE_ABAIXO' end as ord
    from c
  )
  select cap, previsto, exc_prev, pode, liq, pbt_tol, exc_real, dif, pct, leg, ord,
    case when leg = 'AGUARDANDO' or ord = 'AGUARDANDO' then 'PENDENTE'
         when leg in ('OK','ATENCAO') and ord = 'OK' then 'SIM'
         else 'NAO' end
  from d
$$;

-- ------------------------------------------------------------
-- 6. View para relatórios/BI (a tela lê a tabela e calcula no front)
-- ------------------------------------------------------------
-- recriar do zero: coalesce muda o tipo da coluna e `create or replace` recusa
drop view if exists v_pesagens;
create view v_pesagens as
select
  p.id, p.data, p.numero_ordem, p.placa,
  p.tipo_veiculo_id, t.nome as tipo_veiculo,
  p.peso_tara_kg, p.peso_ordem_kg, p.pbt_max_kg_aplicado as pbt_max_kg,
  p.peso_bruto_final_kg,
  coalesce(p.tol_legal_pct_aplicada, par.tolerancia_legal_pct) as tol_legal_pct,
  coalesce(p.tol_ordem_pct_aplicada, par.tolerancia_ordem_pct) as tol_ordem_pct,
  c.capacidade_liquida_kg, c.peso_bruto_previsto_kg, c.excesso_previsto_kg, c.pode_carregar,
  c.peso_liquido_kg, c.pbt_com_tolerancia_kg, c.excesso_real_kg,
  c.diferenca_ordem_kg, c.diferenca_ordem_pct,
  c.status_legislacao, c.status_ordem, c.liberado,
  p.observacoes,
  p.criado_em, uc.nome as criado_por_nome,
  p.pesado_em, up.nome as pesado_por_nome,
  p.excesso_autorizado_em, ua.nome as excesso_autorizado_por_nome,
  p.corrigido_em, uk.nome as corrigido_por_nome,
  coalesce(up.nome, uc.nome) as responsavel,
  p.atualizado_em, p.versao
from pesagens p
join tipos_veiculo t on t.id = p.tipo_veiculo_id
cross join lateral (
  select coalesce((select tolerancia_legal_pct from parametros_pesagem where id = 1), 0.05) as tolerancia_legal_pct,
         coalesce((select tolerancia_ordem_pct from parametros_pesagem where id = 1), 0.005) as tolerancia_ordem_pct
) par
left join usuarios uc on uc.id = p.criado_por
left join usuarios up on up.id = p.pesado_por
left join usuarios ua on ua.id = p.excesso_autorizado_por
left join usuarios uk on uk.id = p.corrigido_por
cross join lateral calc_pesagem(
  p.peso_tara_kg, p.peso_ordem_kg, p.pbt_max_kg_aplicado, p.peso_bruto_final_kg,
  coalesce(p.tol_legal_pct_aplicada, par.tolerancia_legal_pct),
  coalesce(p.tol_ordem_pct_aplicada, par.tolerancia_ordem_pct)
) c;
alter view v_pesagens set (security_invoker = true);
grant select on v_pesagens to authenticated;

-- ------------------------------------------------------------
-- 7. Permissões: recurso `pesagem`
-- ------------------------------------------------------------
-- perfil_permissoes guarda só o que o Gestor MEXEU; o padrão do recurso novo
-- entra no `values` de tem_acao (e em MATRIZ_PADRAO no front)
delete from perfil_permissoes where recurso = 'pesagem'
  and (perfil, acao, permitido) in (
    ('Balanca','ver',true), ('Balanca','registrar',true),
    ('PCP','ver',true), ('Logistica','ver',true), ('Direcao','ver',true));

create or replace function tem_acao(p_recurso text, p_acao text) returns boolean as $$
  select coalesce(
    (select permitido from tsi.perfil_permissoes
      where perfil = tsi.meu_perfil() and recurso = p_recurso and acao = p_acao),
    tsi.meu_perfil() = 'Gestor'  -- padrão do Gestor: tudo
    or exists (select 1 from (values
      ('PCP','ordens','ver'), ('PCP','ordens','criar'), ('PCP','ordens','editar'),
      ('PCP','ordens','excluir'), ('PCP','ordens','priorizar'),
      ('PCP','programacao','ver'), ('PCP','programacao','editar'),
      ('PCP','lotes','ver'), ('PCP','execucao','ver'), ('PCP','qualidade','ver'),
      ('PCP','agrotis','ver'), ('PCP','agrotis','lancar'),
      ('PCP','etapas','ver'), ('PCP','indicadores','ver'),
      ('PCP','cadastros','ver'), ('PCP','cadastros','editar'),
      ('PCP','expedicao','ver'), ('PCP','expedicao','importar'),
      ('PCP','mrp','ver'), ('PCP','mrp','importar'),
      ('PCP','mapa','ver'), ('PCP','mapa','importar'), ('PCP','mapa','montar_carga'),
      ('PCP','mapa','ajustar'),
      ('PCP','inventario','ver'), ('PCP','inventario','abrir'), ('PCP','inventario','contar'),
      ('PCP','veiculos','ver'), ('PCP','veiculos','chamar'), ('PCP','veiculos','checklist'),
      ('PCP','pesagem','ver'),
      ('Logistica','programacao','ver'), ('Logistica','lotes','ver'),
      ('Logistica','lotes','baixar_lote'), ('Logistica','lotes','conferir'),
      ('Logistica','etapas','ver'), ('Logistica','indicadores','ver'),
      ('Logistica','expedicao','ver'), ('Logistica','expedicao','importar'),
      ('Logistica','mapa','ver'), ('Logistica','mapa','importar'), ('Logistica','mapa','enderecar'),
      ('Logistica','mapa','ajustar'),
      ('Logistica','inventario','ver'), ('Logistica','inventario','contar'),
      ('Logistica','veiculos','ver'), ('Logistica','veiculos','chamar'), ('Logistica','veiculos','checklist'),
      ('Logistica','pesagem','ver'),
      ('Producao','programacao','ver'), ('Producao','execucao','ver'),
      ('Producao','execucao','apontar'),
      ('Producao','etapas','ver'), ('Producao','indicadores','ver'),
      ('Producao','inventario','ver'), ('Producao','inventario','contar'),
      ('Qualidade','execucao','ver'), ('Qualidade','qualidade','ver'),
      ('Qualidade','qualidade','qualidade'),
      ('Qualidade','etapas','ver'), ('Qualidade','indicadores','ver'),
      -- Direção: só leitura, em tudo
      ('Direcao','ordens','ver'), ('Direcao','programacao','ver'),
      ('Direcao','lotes','ver'), ('Direcao','execucao','ver'),
      ('Direcao','qualidade','ver'), ('Direcao','agrotis','ver'),
      ('Direcao','etapas','ver'), ('Direcao','indicadores','ver'),
      ('Direcao','cadastros','ver'), ('Direcao','expedicao','ver'),
      ('Direcao','mrp','ver'), ('Direcao','mapa','ver'),
      ('Direcao','inventario','ver'),
      ('Direcao','veiculos','ver'),
      ('Direcao','pesagem','ver'),
      -- Balança: veículos, leitura do mapa e a pesagem (14/09/2026)
      ('Balanca','veiculos','ver'), ('Balanca','veiculos','chamar'), ('Balanca','veiculos','checklist'),
      ('Balanca','mapa','ver'),
      ('Balanca','pesagem','ver'), ('Balanca','pesagem','registrar')
    ) as padrao(perfil, recurso, acao)
      where padrao.perfil = tsi.meu_perfil()::text
        and padrao.recurso = p_recurso and padrao.acao = p_acao),
    false  -- NUNCA null: chamador sem perfil (inclusive anônimo) é sempre "não pode"
  );
$$ language sql stable security definer set search_path = tsi, public;

-- ------------------------------------------------------------
-- 8. Realtime — a tela assina as três
-- ------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table pesagens;
exception when others then null; end $$;
do $$ begin
  alter publication supabase_realtime add table tipos_veiculo;
exception when others then null; end $$;
do $$ begin
  alter publication supabase_realtime add table parametros_pesagem;
exception when others then null; end $$;

-- ------------------------------------------------------------
-- Conferência
-- ------------------------------------------------------------
select 'tabelas' as item,
  (count(*) = 3)::text as ok
  from information_schema.tables
 where table_schema = 'tsi' and table_name in ('tipos_veiculo','parametros_pesagem','pesagens')
union all
select 'tipos seed (7)', (count(*) = 7)::text from tipos_veiculo
union all
select 'parametros (1 linha, 5% / 0,5%)',
  (count(*) = 1 and bool_and(tolerancia_legal_pct = 0.05 and tolerancia_ordem_pct = 0.005))::text
  from parametros_pesagem
union all
select 'politicas pesagens (3)', (count(*) = 3)::text
  from pg_policies where schemaname = 'tsi' and tablename = 'pesagens'
union all
select 'v_pesagens security_invoker',
  coalesce((select 'security_invoker=true' = any(c.reloptions) from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'tsi' and c.relname = 'v_pesagens'), false)::text
union all
select 'realtime (3 tabelas)', (count(*) = 3)::text
  from pg_publication_tables
 where pubname = 'supabase_realtime' and schemaname = 'tsi'
   and tablename in ('pesagens','tipos_veiculo','parametros_pesagem')
union all
select 'caso 1 Bitrem', (peso_bruto_previsto_kg = 56400 and pode_carregar = 'SIM'
  and peso_liquido_kg = 34900 and status_legislacao = 'OK' and diferenca_ordem_kg = -100
  and status_ordem = 'OK' and liberado = 'SIM')::text
  from calc_pesagem(21400, 35000, 57000, 56300, 0.05, 0.005)
union all
select 'caso 2 Truck sem bruto', (peso_bruto_previsto_kg = 24800 and excesso_previsto_kg = 1800
  and pode_carregar = 'NAO' and liberado = 'PENDENTE')::text
  from calc_pesagem(9800, 15000, 23000, null, 0.05, 0.005)
union all
select 'caso 3 Rodotrem', (peso_bruto_previsto_kg = 74000 and pode_carregar = 'SIM'
  and status_legislacao = 'ATENCAO' and peso_liquido_kg = 48500 and diferenca_ordem_kg = 2500
  and status_ordem = 'DIVERGENTE_ACIMA' and liberado = 'NAO')::text
  from calc_pesagem(28000, 46000, 74000, 76500, 0.05, 0.005)
union all
select 'caso 4 LS Simples', (status_legislacao = 'EXCESSO' and liberado = 'NAO')::text
  from calc_pesagem(15000, 26000, 41500, 44000, 0.05, 0.005)
union all
select 'caso 5 Bitruck', (peso_liquido_kg = 17450 and diferenca_ordem_kg = -50
  and status_ordem = 'OK' and status_legislacao = 'OK' and liberado = 'SIM')::text
  from calc_pesagem(11000, 17500, 29000, 28450, 0.05, 0.005)
union all
select 'caso 6 Truck', (peso_bruto_previsto_kg = 22800 and pode_carregar = 'SIM'
  and peso_liquido_kg = 13100 and diferenca_ordem_kg = 100
  and status_ordem = 'DIVERGENTE_ACIMA' and liberado = 'NAO')::text
  from calc_pesagem(9800, 13000, 23000, 22900, 0.05, 0.005)
union all
select 'fronteira 77.700 = ATENCAO', (status_legislacao = 'ATENCAO')::text
  from calc_pesagem(28000, 40000, 74000, 77700, 0.05, 0.005)
union all
select 'indice unico em aberto', (count(*) = 1)::text
  from pg_indexes where schemaname = 'tsi' and indexname = 'pesagens_aberta_unica'
union all
select 'tem_acao com pesagem', (pg_get_functiondef('tsi.tem_acao(text,text)'::regprocedure) like '%pesagem%')::text;
