-- ============================================================
-- Calendário de turnos + histórico de reprogramação
-- Execute no SQL Editor do Supabase
-- ============================================================
--
-- Pode rodar mesmo que a primeira versão deste script já tenha sido
-- executada: a parte 1 migra a coluna antiga `turnos` (0/1/2) para
-- `turno1`/`turno2` e tudo o mais é `if not exists`.
--
-- 1. CALENDÁRIO — nem todo dia roda os dois turnos, e importa SABER QUAL:
--    um dia só de 2º turno tem 9,5 h (114 t a 12 t/h), um só de 1º tem 10 h
--    (120 t). Guardamos só a exceção: dia sem linha roda os dois.
--
-- 2. HISTÓRICO — até aqui mudar o dia de uma ordem sobrescrevia `data_prog`
--    sem deixar rastro, e a reprogramação em cascata mexe em dezenas de uma
--    vez. Sem histórico não dá para responder "para quando isto estava
--    programado?" nem medir quanto a fábrica empurra o plano.
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 1. Calendário de turnos
-- ------------------------------------------------------------
create table if not exists dias_producao (
  data         date primary key,
  turno1       boolean not null default true,
  turno2       boolean not null default true,
  observacao   text,
  alterado_em  timestamptz not null default now(),
  alterado_por uuid references usuarios(id)
);

comment on table dias_producao is
  'Exceções do calendário: só os dias que NÃO rodam os dois turnos. Ausência = 1º e 2º.';

-- migração da 1ª versão, que guardava a QUANTIDADE de turnos
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'tsi' and table_name = 'dias_producao'
                and column_name = 'turnos') then
    alter table dias_producao add column if not exists turno1 boolean not null default true;
    alter table dias_producao add column if not exists turno2 boolean not null default true;
    -- 2 turnos = ambos · 1 turno = era sempre o primeiro · 0 = nenhum
    update dias_producao set turno1 = (turnos >= 1), turno2 = (turnos >= 2);
    alter table dias_producao drop column turnos;
    raise notice 'dias_producao migrada de turnos(0..2) para turno1/turno2';
  end if;
end $$;

alter table dias_producao enable row level security;

drop policy if exists ler_dias on dias_producao;
create policy ler_dias on dias_producao for select using (meu_perfil() is not null);

drop policy if exists edita_dias on dias_producao;
create policy edita_dias on dias_producao for all
  using (tem_acao('programacao','editar'))
  with check (tem_acao('programacao','editar'));

do $$ begin
  alter publication supabase_realtime add table dias_producao;
exception when others then null; end $$;

-- ------------------------------------------------------------
-- 2. Histórico de reprogramação
-- ------------------------------------------------------------
alter table ordens add column if not exists data_prog_original date;
alter table ordens add column if not exists reprogramacoes smallint not null default 0;
alter table ordens add column if not exists reprogramada_em timestamptz;

comment on column ordens.data_prog_original is
  'Primeiro dia em que a ordem foi programada. Nunca muda depois de definido.';

-- ordens que já existem: o dia atual é o original que conhecemos
update ordens set data_prog_original = data_prog
 where data_prog_original is null and data_prog is not null;

create table if not exists ordem_reprogramacoes (
  id           uuid primary key default gen_random_uuid(),
  ordem_id     uuid not null references ordens(id) on delete cascade,
  de_dia       date,
  para_dia     date,
  -- sem chave estrangeira de propósito: histórico não pode travar o cadastro
  de_maquina   text,
  para_maquina text,
  de_seq       int,
  para_seq     int,
  usuario_id   uuid references usuarios(id),
  ts           timestamptz not null default now()
);
create index if not exists ordem_reprog_ordem on ordem_reprogramacoes (ordem_id);
create index if not exists ordem_reprog_ts    on ordem_reprogramacoes (ts desc);

alter table ordem_reprogramacoes enable row level security;
drop policy if exists ler_reprog on ordem_reprogramacoes;
create policy ler_reprog on ordem_reprogramacoes for select using (meu_perfil() is not null);
-- ninguém escreve direto: só o gatilho, que é security definer

/*
 * Carimba a ordem e registra a linha do histórico.
 *
 * Ganhar dia pela PRIMEIRA vez é programação, não reprogramação — senão
 * toda ordem nasceria com uma reprogramação no contador. Só a partir da
 * segunda vez conta.
 *
 * A linha do histórico também sai quando muda só de máquina: para a fábrica
 * "saiu da TSI 1 para a TSI 2" é tão relevante quanto mudar de dia. Já o
 * contador `reprogramacoes` conta apenas mudança de DIA, que é o que o PCP
 * quer medir.
 */
create or replace function fn_registra_reprogramacao() returns trigger as $$
begin
  if tg_op = 'INSERT' then
    new.data_prog_original := new.data_prog;
    return new;
  end if;

  if old.data_prog is null and new.data_prog is not null then
    new.data_prog_original := coalesce(new.data_prog_original, new.data_prog);
  elsif new.data_prog is distinct from old.data_prog then
    new.data_prog_original := coalesce(old.data_prog_original, old.data_prog);
    new.reprogramacoes     := coalesce(old.reprogramacoes, 0) + 1;
    new.reprogramada_em    := now();
  end if;

  if new.data_prog is distinct from old.data_prog
     or new.maquina_id is distinct from old.maquina_id then
    insert into tsi.ordem_reprogramacoes
      (ordem_id, de_dia, para_dia, de_maquina, para_maquina, de_seq, para_seq, usuario_id)
    values (old.id, old.data_prog, new.data_prog,
            old.maquina_id, new.maquina_id, old.seq, new.seq, auth.uid());
  end if;
  return new;
end $$ language plpgsql security definer set search_path = tsi, public;

drop trigger if exists tg_registra_reprogramacao on ordens;
create trigger tg_registra_reprogramacao
  before insert or update on ordens
  for each row execute function fn_registra_reprogramacao();

-- ------------------------------------------------------------
-- 3. As colunas novas entram na lista `ignorar` de fn_ordens_por_acao
--    Sem isso, quem tem 'programacao/editar' mas não 'ordens/editar'
--    passaria a ser barrado ao mover uma ordem: o gatilho acima carimba
--    essas colunas e a regra final veria "editou a ordem".
--    (Espelho de corrige-finalizar-producao.sql — mudou lá, mude aqui.)
-- ------------------------------------------------------------
create or replace function fn_ordens_por_acao() returns trigger as $$
declare
  ignorar constant text[] := array[
    'status','turno_id','fim_pendente','bags_produzidos',
    'prioridade','prioridade_por','prioridade_em',
    'maquina_id','data_prog','seq',
    'data_prog_original','reprogramacoes','reprogramada_em',
    'agrotis_num','agrotis_por','agrotis_em'];
begin
  if new.status is distinct from old.status then
    if new.status = 'Apontada' then
      if not tem_acao('agrotis','lancar') then
        raise exception 'Encerrar no AGROTIS exige a acao Lancar (Administracao)';
      end if;
    elsif new.status = 'Qualidade apontada' then
      if not tem_acao('qualidade','qualidade') then
        raise exception 'Apontar qualidade exige a acao Qualidade (Administracao)';
      end if;
    elsif old.status in ('Nao programada','Programada','Em producao','Parada')
      and new.status in ('Nao programada','Programada','Em producao','Parada','Finalizada') then
      if not tem_acao('execucao','apontar') then
        raise exception 'Apontar producao exige a acao Apontar (Administracao)';
      end if;
    else
      raise exception 'Transicao de status fora do fluxo exige a acao Editar ordens';
    end if;
  end if;
  if (new.turno_id is distinct from old.turno_id
      or new.fim_pendente is distinct from old.fim_pendente
      or new.bags_produzidos is distinct from old.bags_produzidos)
     and not tem_acao('execucao','apontar') then
    raise exception 'Apontar producao exige a acao Apontar (Administracao)';
  end if;
  if (new.prioridade is distinct from old.prioridade
      or new.prioridade_por is distinct from old.prioridade_por
      or new.prioridade_em is distinct from old.prioridade_em)
     and not tem_acao('ordens','priorizar') then
    raise exception 'Priorizar exige a acao Priorizar (Administracao)';
  end if;
  if (new.maquina_id is distinct from old.maquina_id
      or new.data_prog is distinct from old.data_prog
      or new.seq is distinct from old.seq)
     and not (tem_acao('programacao','editar') or tem_acao('ordens','editar')) then
    raise exception 'Programar exige a acao Editar programacao (Administracao)';
  end if;
  if (new.agrotis_num is distinct from old.agrotis_num
      or new.agrotis_por is distinct from old.agrotis_por
      or new.agrotis_em is distinct from old.agrotis_em)
     and not tem_acao('agrotis','lancar') then
    raise exception 'Encerrar no AGROTIS exige a acao Lancar (Administracao)';
  end if;
  if (to_jsonb(new) - ignorar) <> (to_jsonb(old) - ignorar)
     and not tem_acao('ordens','editar') then
    raise exception 'Editar a ordem exige a acao Editar (Administracao)';
  end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;

-- ------------------------------------------------------------
-- Conferência
-- ------------------------------------------------------------
select 'dias_producao com turno1/turno2' as item,
       (count(*) = 2)::text as ok
  from information_schema.columns
 where table_schema = 'tsi' and table_name = 'dias_producao'
   and column_name in ('turno1','turno2')
union all
select 'coluna turnos removida',
       (count(*) = 0)::text
  from information_schema.columns
 where table_schema = 'tsi' and table_name = 'dias_producao' and column_name = 'turnos'
union all
select 'ordens com data_prog_original',
       (count(*) = 3)::text
  from information_schema.columns
 where table_schema = 'tsi' and table_name = 'ordens'
   and column_name in ('data_prog_original','reprogramacoes','reprogramada_em')
union all
select 'gatilho do historico ativo',
       (count(*) = 1)::text
  from pg_trigger where tgname = 'tg_registra_reprogramacao'
union all
select 'ignorar tem as 3 colunas novas',
       (position('data_prog_original' in prosrc) > 0)::text
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
 where ns.nspname = 'tsi' and p.proname = 'fn_ordens_por_acao'
union all
select 'ordens ja com dia original preenchido',
       count(*)::text from ordens where data_prog_original is not null;
