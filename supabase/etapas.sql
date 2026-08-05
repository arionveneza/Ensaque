-- ============================================================
-- Etapas da ordem: qualidade em 2 tempos, conferência da
-- logística e visão geral
-- Execute no SQL Editor do Supabase
-- ============================================================
--
-- Decisões do PCP em 05/08/2026:
-- · o checklist (recobrimento 1–5, umidade, pó, observação) SUBSTITUI o
--   Aprovado/Reprovado + amostra — é apenas informativo, nunca bloqueia
-- · qualidade EM PROCESSO: vários registros por ordem, com hora — histórico
-- · qualidade FINAL: um registro por ordem; ao gravar, a ordem vai de
--   Finalizada para "Qualidade apontada" (o enum de status não muda)
-- · conferência da logística: bags contados fisicamente, para comparar com
--   o esperado da ordem; etapa paralela, não trava o AGROTIS
--
-- A tabela antiga ordem_qualidade fica sem uso (remoção na limpeza geral).
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 1. Checklist de qualidade (as duas etapas na mesma tabela)
-- ------------------------------------------------------------
create table if not exists qualidade_checks (
  id           uuid primary key default gen_random_uuid(),
  ordem_id     uuid not null references ordens(id) on delete cascade,
  etapa        text not null check (etapa in ('processo','final')),
  -- de onde saiu a amostra da verificação em processo (a final não usa)
  origem       text check (origem in ('BOWL','BAG')),
  -- "qualidade geral do tratamento" na tela; nome histórico da coluna
  recobrimento int  not null check (recobrimento between 1 and 5),
  umidade_ok   boolean not null,   -- false = fora do padrão
  po_ok        boolean not null,   -- desprendimento de pó; false = fora do padrão
  observacao   text,
  inspetor_id  uuid references usuarios(id),
  ts           timestamptz not null default now()
);
-- quem já criou a tabela sem a coluna (versão anterior deste script)
alter table qualidade_checks add column if not exists origem text
  check (origem in ('BOWL','BAG'));
create index if not exists qualidade_checks_ordem on qualidade_checks (ordem_id);

-- em processo repete; a final é única por ordem
create unique index if not exists qualidade_final_unica
  on qualidade_checks (ordem_id) where etapa = 'final';

-- etapa certa no status certo (defesa em profundidade — o app também valida)
create or replace function fn_valida_qualidade_check() returns trigger as $$
declare st text;
begin
  select status::text into st from ordens where id = new.ordem_id;
  if new.etapa = 'processo' and st not in ('Em producao','Parada') then
    raise exception 'Checklist em processo exige ordem em execucao (status atual: %)', st;
  end if;
  if new.etapa = 'processo' and new.origem is null then
    raise exception 'Checklist em processo exige a origem da amostra (BOWL ou BAG)';
  end if;
  if new.etapa = 'final' and st <> 'Finalizada' then
    raise exception 'Checklist final exige ordem Finalizada (status atual: %)', st;
  end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;
drop trigger if exists tg_valida_qualidade_check on qualidade_checks;
create trigger tg_valida_qualidade_check before insert on qualidade_checks
  for each row execute function fn_valida_qualidade_check();

-- ------------------------------------------------------------
-- 2. Conferência de estoque (logística) — uma por ordem
-- ------------------------------------------------------------
create table if not exists ordem_conferencias (
  ordem_id      uuid primary key references ordens(id) on delete cascade,
  bags_contados int not null check (bags_contados >= 0),
  observacao    text,
  conferido_por uuid references usuarios(id),
  ts            timestamptz not null default now()
);

create or replace function fn_valida_conferencia() returns trigger as $$
declare st text;
begin
  select status::text into st from ordens where id = new.ordem_id;
  if st not in ('Finalizada','Qualidade apontada','Apontada') then
    raise exception 'Conferencia de estoque exige ordem finalizada (status atual: %)', st;
  end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;
drop trigger if exists tg_valida_conferencia on ordem_conferencias;
create trigger tg_valida_conferencia before insert or update on ordem_conferencias
  for each row execute function fn_valida_conferencia();

-- ------------------------------------------------------------
-- 3. Qualidade final grava o check E muda o status da ordem.
-- SECURITY DEFINER porque o perfil Qualidade não tem UPDATE em `ordens`
-- pelo RLS — sem isso o flip de status falharia em silêncio (0 linhas).
-- ------------------------------------------------------------
create or replace function apontar_qualidade_final(
  p_ordem uuid,
  p_recobrimento int,
  p_umidade_ok boolean,
  p_po_ok boolean,
  p_obs text
) returns void as $$
begin
  if meu_perfil() not in ('Qualidade','Gestor') then
    raise exception 'Apenas Qualidade ou Gestor apontam a qualidade final';
  end if;

  insert into qualidade_checks
    (ordem_id, etapa, recobrimento, umidade_ok, po_ok, observacao, inspetor_id)
  values
    (p_ordem, 'final', p_recobrimento, p_umidade_ok, p_po_ok,
     nullif(trim(coalesce(p_obs,'')), ''), auth.uid());

  update ordens set status = 'Qualidade apontada'
   where id = p_ordem and status = 'Finalizada';
end $$ language plpgsql security definer set search_path = tsi, public;

-- ------------------------------------------------------------
-- 3b. AGROTIS exige a conferência da logística (pré-requisito).
-- A qualidade final já é garantida pelo fluxo de status
-- (Apontada só nasce de 'Qualidade apontada'); a conferência não
-- muda status, então precisa deste cadeado.
-- ------------------------------------------------------------
create or replace function fn_valida_agrotis() returns trigger as $$
begin
  if new.status = 'Apontada' and old.status is distinct from 'Apontada' then
    if not exists (select 1 from ordem_conferencias c where c.ordem_id = new.id) then
      raise exception 'Lancamento no AGROTIS exige a conferencia de estoque da logistica';
    end if;
  end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;
drop trigger if exists tg_valida_agrotis on ordens;
create trigger tg_valida_agrotis before update on ordens
  for each row execute function fn_valida_agrotis();

-- ------------------------------------------------------------
-- 4. Visão geral das etapas por ordem
-- ------------------------------------------------------------
create or replace view v_ordem_etapas as
select o.*,
       coalesce(qp.qtd, 0)          as checks_processo,
       (qf.ordem_id is not null)    as tem_qualidade_final,
       (c.ordem_id  is not null)    as conferida,
       c.bags_contados
from v_ordens o
left join (select ordem_id, count(*) as qtd
             from qualidade_checks where etapa = 'processo' group by 1) qp
       on qp.ordem_id = o.id
left join (select distinct ordem_id
             from qualidade_checks where etapa = 'final') qf
       on qf.ordem_id = o.id
left join ordem_conferencias c on c.ordem_id = o.id;

-- view exposta na API precisa respeitar o RLS de quem chama
alter view v_ordem_etapas set (security_invoker = true);

-- ------------------------------------------------------------
-- 5. RLS
-- ------------------------------------------------------------
alter table qualidade_checks   enable row level security;
alter table ordem_conferencias enable row level security;

drop policy if exists ler_qc on qualidade_checks;
create policy ler_qc on qualidade_checks for select
  using (meu_perfil() is not null);

-- checklist é trilha: insere, não edita nem apaga
drop policy if exists qual_qc on qualidade_checks;
create policy qual_qc on qualidade_checks for insert
  with check (meu_perfil() in ('Qualidade','Gestor'));

drop policy if exists ler_conf on ordem_conferencias;
create policy ler_conf on ordem_conferencias for select
  using (meu_perfil() is not null);

-- conferência pode ser corrigida (recontagem) pela própria logística
drop policy if exists log_conf on ordem_conferencias;
create policy log_conf on ordem_conferencias for all
  using (meu_perfil() in ('Logistica','Gestor'))
  with check (meu_perfil() in ('Logistica','Gestor'));

-- ------------------------------------------------------------
-- 6. Realtime (ignora se a publicação já cobre tudo)
-- ------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table qualidade_checks;
exception when others then null; end $$;
do $$ begin
  alter publication supabase_realtime add table ordem_conferencias;
exception when others then null; end $$;

-- conferência final
select 'qualidade_checks' as tabela, count(*) from qualidade_checks
union all
select 'ordem_conferencias', count(*) from ordem_conferencias;
