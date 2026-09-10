-- ============================================================
-- Parada de MÁQUINA (sem ordem) — 12/09/2026
--
-- Pedido do Arion: "não conseguimos mensurar o tempo que a máquina para
-- por aguardar semente". Toda parada de hoje pertence a uma ordem
-- (`ordem_paradas.ordem_id` é `not null references ordens`), e a RPC
-- `registrar_parada` só aceita ordem `Em producao`. Com a máquina ociosa
-- não existe ordem para pendurar a parada, e a hora perdida não existe em
-- lugar nenhum.
--
-- Tabela NOVA em vez de afrouxar `ordem_paradas`: tornar `ordem_id`
-- nullable contaminaria as paradas já gravadas, a `v_ordem_tempos` e o OEE,
-- todos ancorados na ordem. Parada de máquina é outro eixo — máquina × dia
-- — e de propósito NÃO entra em disponibilidade nem em OEE da ordem.
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 1. Motivo próprio
-- ------------------------------------------------------------
-- Separado do "Falta de lote de semente" que já existe: aquele é parada NO
-- MEIO da ordem (a semente acabou), este é ANTES da ordem (a semente não
-- chegou). Juntar os dois apagaria exatamente a diferença que se quer medir.
insert into motivos_parada (descricao, tipo, ativo)
select 'Aguardando semente', 'Nao planejada', true
 where not exists (select 1 from motivos_parada where descricao = 'Aguardando semente');

-- ------------------------------------------------------------
-- 2. Tabela
-- ------------------------------------------------------------
create table if not exists maquina_paradas (
  id         uuid primary key default gen_random_uuid(),
  maquina_id text not null references maquinas(id),
  motivo_id  uuid not null references motivos_parada(id),
  inicio     timestamptz not null default now(),
  fim        timestamptz,
  usuario_id uuid references usuarios(id),
  observacao text,
  constraint parada_maq_fim_apos_inicio check (fim is null or fim >= inicio)
);

comment on table maquina_paradas is
  'Parada de maquina ociosa, sem ordem (ex.: aguardando semente). NAO entra '
  'em v_ordem_tempos, disponibilidade nem OEE — e um eixo proprio, maquina x dia.';

-- uma parada aberta por máquina é regra do banco, não da tela: dois tablets
-- abrindo ao mesmo tempo criariam duas contagens do mesmo tempo
create unique index if not exists maquina_paradas_uma_aberta
  on maquina_paradas (maquina_id) where fim is null;
create index if not exists maquina_paradas_inicio on maquina_paradas (inicio);

-- ------------------------------------------------------------
-- 3. RLS — mesma ação de ordem_paradas (execucao/apontar)
-- ------------------------------------------------------------
alter table maquina_paradas enable row level security;

drop policy if exists ler_par_maq on maquina_paradas;
create policy ler_par_maq on maquina_paradas
  for select using (meu_perfil() is not null);

drop policy if exists grava_par_maq on maquina_paradas;
create policy grava_par_maq on maquina_paradas
  for all using (tem_acao('execucao','apontar'))
      with check (tem_acao('execucao','apontar'));

-- ------------------------------------------------------------
-- 4. RPCs
-- ------------------------------------------------------------
-- p_motivo entra como text e é convertido, igual a registrar_parada: com uuid
-- no parâmetro o PostgREST reclamaria de ambiguidade se um dia existir a
-- outra assinatura (lição de corrige-registrar-parada.sql).
create or replace function abrir_parada_maquina(
  p_maquina text, p_motivo text, p_obs text default null
) returns uuid as $$
declare v_id uuid;
begin
  if not tem_acao('execucao','apontar') then
    raise exception 'Perfil sem permissao para apontar producao';
  end if;
  if not exists (select 1 from tsi.maquinas where id = p_maquina) then
    raise exception 'Maquina nao encontrada';
  end if;
  if not exists (select 1 from tsi.motivos_parada where id = p_motivo::uuid) then
    raise exception 'Motivo de parada nao encontrado';
  end if;
  -- com ordem rodando o caminho certo é a parada DA ORDEM: ela entra na
  -- disponibilidade daquela ordem, esta aqui não entraria
  if exists (
    select 1 from tsi.ordens
     where maquina_id = p_maquina and status in ('Em producao','Parada')
  ) then
    raise exception 'A maquina tem ordem em andamento — registre a parada pela ordem';
  end if;
  if exists (select 1 from tsi.maquina_paradas where maquina_id = p_maquina and fim is null) then
    raise exception 'Ja existe parada aberta nesta maquina';
  end if;

  insert into tsi.maquina_paradas (maquina_id, motivo_id, usuario_id, observacao)
  values (p_maquina, p_motivo::uuid, auth.uid(), nullif(btrim(coalesce(p_obs,'')), ''))
  returning id into v_id;
  return v_id;
end $$ language plpgsql security definer set search_path = tsi, public;

create or replace function encerrar_parada_maquina(p_maquina text) returns void as $$
begin
  if not tem_acao('execucao','apontar') then
    raise exception 'Perfil sem permissao para apontar producao';
  end if;
  update tsi.maquina_paradas set fim = now()
   where maquina_id = p_maquina and fim is null;
  if not found then
    raise exception 'Nao ha parada aberta nesta maquina';
  end if;
end $$ language plpgsql security definer set search_path = tsi, public;

-- ------------------------------------------------------------
-- 5. Fechamento automático ao iniciar a ordem
-- ------------------------------------------------------------
-- A semente chegou e o operador inicia a ordem: a espera acabou naquele
-- instante. Exigir um "Encerrar" antes seria mais um toque para esquecer, e
-- a parada esquecida correria por cima da produção (decisão do Arion,
-- 12/09/2026). Corpo idêntico ao anterior, com o update no começo.
create or replace function confirmar_inicio(p_ordem uuid) returns void as $$
begin
  if not tem_acao('execucao','apontar') then
    raise exception 'Perfil sem permissao para apontar producao';
  end if;
  -- a espera da maquina termina aqui
  update tsi.maquina_paradas mp set fim = now()
    from tsi.ordens o
   where o.id = p_ordem and mp.maquina_id = o.maquina_id and mp.fim is null;
  -- sobra de tentativa interrompida: descarta antes de gravar o real
  delete from tsi.ordem_eventos where ordem_id = p_ordem and tipo = 'inicio';
  insert into tsi.ordem_eventos (ordem_id, tipo, usuario_id)
  values (p_ordem, 'inicio', auth.uid());
  -- tg_valida_inicio segue exigindo pesos iniciais e lote baixado
  update tsi.ordens set status = 'Em producao'
   where id = p_ordem and status in ('Nao programada','Programada');
  if not found then
    raise exception 'Ordem nao esta em estado de iniciar';
  end if;
end $$ language plpgsql security definer set search_path = tsi, public;

revoke all on function abrir_parada_maquina(text, text, text) from public, anon;
revoke all on function encerrar_parada_maquina(text) from public, anon;
revoke all on function confirmar_inicio(uuid) from public, anon;

-- ------------------------------------------------------------
-- 6. Realtime
-- ------------------------------------------------------------
-- A Execução assina ordens + ordem_eventos + ordem_paradas + ordem_tanques
-- e NENHUMA das quatro estava na publicação — e, como diz o
-- realtime-completo.sql, uma tabela inválida derruba o canal inteiro: a
-- tela só atualizava ao voltar o foco da aba, em silêncio. Sem isto a
-- parada aberta num tablet não apareceria no outro nem na TV.
do $$ begin alter publication supabase_realtime add table maquina_paradas;
exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table ordens;
exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table ordem_eventos;
exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table ordem_paradas;
exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table ordem_tanques;
exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table lotes_semente;
exception when others then null; end $$;

-- ------------------------------------------------------------
-- 7. Conferência
-- ------------------------------------------------------------
select
  (select count(*) from motivos_parada where descricao = 'Aguardando semente') as motivo,
  (select count(*) from information_schema.tables
    where table_schema = 'tsi' and table_name = 'maquina_paradas') as tabela,
  (select jsonb_agg(policyname order by policyname) from pg_policies
    where schemaname = 'tsi' and tablename = 'maquina_paradas') as policies,
  (select count(*) from pg_indexes
    where schemaname = 'tsi' and indexname = 'maquina_paradas_uma_aberta') as indice_unico,
  (select jsonb_agg(p.proname order by p.proname) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'tsi'
      and p.proname in ('abrir_parada_maquina','encerrar_parada_maquina')) as rpcs,
  (select position('maquina_paradas' in prosrc) > 0 from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'tsi' and p.proname = 'confirmar_inicio') as inicio_fecha_parada,
  (select jsonb_agg(tablename order by tablename) from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'tsi'
      and tablename in ('maquina_paradas','ordens','ordem_eventos','ordem_paradas',
                        'ordem_tanques','lotes_semente')) as realtime;
