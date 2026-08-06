-- ============================================================
-- Turnos por dia — capacidade do dia deixa de ser fixa em 234 t
-- Execute no SQL Editor do Supabase
-- ============================================================
--
-- POR QUE: nem todo dia roda os dois turnos. Com a capacidade fixa em
-- 12 t/h × 19,5 h, um sábado de um turno só aparecia com metade da ocupação
-- real, e a programação automática enfiava ordem que não caberia.
--
-- COMO: uma linha por dia que FOGE do padrão. Dia sem linha = 2 turnos.
-- Guardar só a exceção evita ter que semear o calendário inteiro e mantém
-- o app funcionando igual enquanto ninguém marcar nada.
--
--   turnos = 2 → 19,5 h (T1 10 h + T2 9,5 h) → 234 t a 12 t/h
--   turnos = 1 → 10 h                        → 120 t
--   turnos = 0 → sem produção (domingo, feriado, parada programada)
-- ============================================================

set search_path = tsi, public;

create table if not exists dias_producao (
  data       date primary key,
  turnos     smallint not null default 2 check (turnos between 0 and 2),
  observacao text,
  alterado_em timestamptz not null default now(),
  alterado_por uuid references usuarios(id)
);

comment on table dias_producao is
  'Exceções do calendário: só os dias que NÃO rodam os 2 turnos. Ausência = 2 turnos.';

alter table dias_producao enable row level security;

-- leitura: todo usuário ativo (a capacidade aparece na Programação e nos Indicadores)
drop policy if exists ler_dias on dias_producao;
create policy ler_dias on dias_producao for select using (meu_perfil() is not null);

-- escrita: quem programa (PCP/Gestor pelo padrão da matriz)
drop policy if exists edita_dias on dias_producao;
create policy edita_dias on dias_producao for all
  using (tem_acao('programacao','editar'))
  with check (tem_acao('programacao','editar'));

-- o quadro fica aberto em vários computadores ao mesmo tempo
do $$ begin
  alter publication supabase_realtime add table dias_producao;
exception when others then null; end $$;

-- conferência
select 'dias_producao existe' as item, count(*)::text as valor from dias_producao
union all
select 'politicas', count(*)::text from pg_policies
 where schemaname = 'tsi' and tablename = 'dias_producao';
