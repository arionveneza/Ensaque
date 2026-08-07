-- ============================================================
-- Reabastecimento de tanque + fotos na qualidade final
-- Execute no SQL Editor do Supabase
-- ============================================================
--
-- 1. REABASTECIMENTO — o consumo era `peso_inicial − peso_final`, o que só
--    vale se o tanque nunca é completado no meio da ordem. Na prática o pó
--    secante acaba e o operador põe mais: começou com 100 kg, completou com
--    100, terminou com 50 → consumiu 150, não 50. O cálculo antigo erraria
--    por três vezes, e o Real vs Planejado apontaria economia inexistente.
--
--    Cada abastecimento vira uma linha, com hora e quem fez: o total é
--    derivável, mas o histórico não — e "quantas vezes precisou completar"
--    é justamente o que denuncia tanque subdimensionado para a receita.
--
-- 2. FOTOS — a qualidade final aceita até 3 imagens. Ficam no Storage do
--    Supabase (bucket privado), e a linha do teste guarda só o caminho.
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 1. Abastecimentos do tanque durante a ordem
-- ------------------------------------------------------------
create table if not exists ordem_tanque_abastecimentos (
  id         uuid primary key default gen_random_uuid(),
  tanque_id  uuid not null references ordem_tanques(id) on delete cascade,
  peso_kg    numeric(10,3) not null check (peso_kg > 0),
  usuario_id uuid references usuarios(id),
  ts         timestamptz not null default now()
);
create index if not exists ota_tanque on ordem_tanque_abastecimentos (tanque_id);

comment on table ordem_tanque_abastecimentos is
  'O que foi acrescentado ao tanque DEPOIS do peso inicial. Consumo real = inicial + soma daqui - final.';

alter table ordem_tanque_abastecimentos enable row level security;

drop policy if exists ler_abast on ordem_tanque_abastecimentos;
create policy ler_abast on ordem_tanque_abastecimentos for select
  using (meu_perfil() is not null);

-- quem aponta produção abastece; o registro é histórico e não se edita
drop policy if exists grava_abast on ordem_tanque_abastecimentos;
create policy grava_abast on ordem_tanque_abastecimentos for insert
  with check (tem_acao('execucao','apontar'));

drop policy if exists apaga_abast on ordem_tanque_abastecimentos;
create policy apaga_abast on ordem_tanque_abastecimentos for delete
  using (tem_acao('execucao','apontar'));

do $$ begin
  alter publication supabase_realtime add table ordem_tanque_abastecimentos;
exception when others then null; end $$;

/*
 * Registrar abastecimento é apontamento de produção, e só faz sentido com a
 * ordem rodando: antes do início o operador ainda está montando o tanque e
 * corrige o próprio peso inicial; depois de finalizada, a ordem é histórico.
 */
create or replace function abastecer_tanque(p_tanque uuid, p_peso numeric)
returns void as $$
declare
  v_status text;
begin
  if not tem_acao('execucao','apontar') then
    raise exception 'Perfil sem permissao para apontar producao';
  end if;
  if p_peso is null or p_peso <= 0 then
    raise exception 'Informe quanto foi colocado no tanque';
  end if;
  select o.status into v_status
    from tsi.ordem_tanques t join tsi.ordens o on o.id = t.ordem_id
   where t.id = p_tanque;
  if v_status is null then
    raise exception 'Tanque nao encontrado';
  end if;
  if v_status not in ('Em producao','Parada') then
    raise exception 'So da para abastecer com a ordem em producao ou parada (esta: %)', v_status;
  end if;
  insert into tsi.ordem_tanque_abastecimentos (tanque_id, peso_kg, usuario_id)
  values (p_tanque, p_peso, auth.uid());
end $$ language plpgsql security definer set search_path = tsi, public;

-- ------------------------------------------------------------
-- 2. Consumo real passa a somar os abastecimentos
--    (a view existia comparando só inicial − final)
-- ------------------------------------------------------------
create or replace view v_ordem_tanque_consumo as
select ot.ordem_id,
       ot.tanque,
       ot.peso_inicial,
       ot.peso_final,
       coalesce((select sum(a.peso_kg)
                   from tsi.ordem_tanque_abastecimentos a
                  where a.tanque_id = ot.id), 0) as abastecido_kg,
       case
         when ot.peso_inicial is null or ot.peso_final is null then null
         else greatest(0,
                ot.peso_inicial
              + coalesce((select sum(a.peso_kg)
                            from tsi.ordem_tanque_abastecimentos a
                           where a.tanque_id = ot.id), 0)
              - ot.peso_final)
       end as consumo_real_kg
  from tsi.ordem_tanques ot;

alter view v_ordem_tanque_consumo set (security_invoker = true);

-- ------------------------------------------------------------
-- 3. Fotos na qualidade final
-- ------------------------------------------------------------
alter table qualidade_checks add column if not exists fotos text[] not null default '{}';

comment on column qualidade_checks.fotos is
  'Caminhos no bucket `qualidade` do Storage. Até 3 na etapa final.';

alter table qualidade_checks drop constraint if exists qualidade_ate_3_fotos;
alter table qualidade_checks add constraint qualidade_ate_3_fotos
  check (array_length(fotos, 1) is null or array_length(fotos, 1) <= 3);

-- bucket privado: foto de lote é registro interno, não vai para a web aberta
insert into storage.buckets (id, name, public)
values ('qualidade', 'qualidade', false)
on conflict (id) do nothing;

-- leitura: qualquer usuário logado do TSI (PCP e Direção precisam ver)
drop policy if exists qualidade_fotos_ler on storage.objects;
create policy qualidade_fotos_ler on storage.objects for select
  using (bucket_id = 'qualidade' and auth.uid() is not null);

-- gravação: só quem aponta qualidade
drop policy if exists qualidade_fotos_gravar on storage.objects;
create policy qualidade_fotos_gravar on storage.objects for insert
  with check (bucket_id = 'qualidade' and tsi.tem_acao('qualidade','qualidade'));

drop policy if exists qualidade_fotos_apagar on storage.objects;
create policy qualidade_fotos_apagar on storage.objects for delete
  using (bucket_id = 'qualidade' and tsi.tem_acao('qualidade','qualidade'));

/*
 * A RPC da qualidade final ganha as fotos.
 *
 * O parâmetro novo entra por DROP + CREATE, não por `create or replace`:
 * assinatura diferente cria uma SEGUNDA função de mesmo nome, e o PostgREST
 * recusa a chamada por ambiguidade. `p_fotos` tem valor padrão para o front
 * antigo — que não manda o campo — continuar funcionando na janela entre
 * rodar este script e publicar a tela nova.
 */
drop function if exists apontar_qualidade_final(uuid, int, boolean, boolean, text);

create or replace function apontar_qualidade_final(
  p_ordem uuid,
  p_recobrimento int,
  p_umidade_ok boolean,
  p_po_ok boolean,
  p_obs text,
  p_fotos text[] default '{}'
) returns void as $$
begin
  if not tem_acao('qualidade','qualidade') then
    raise exception 'Perfil sem permissao para apontar qualidade';
  end if;
  if coalesce(array_length(p_fotos, 1), 0) > 3 then
    raise exception 'No maximo 3 fotos por teste';
  end if;
  insert into qualidade_checks
    (ordem_id, etapa, recobrimento, umidade_ok, po_ok, observacao, inspetor_id, fotos)
  values
    (p_ordem, 'final', p_recobrimento, p_umidade_ok, p_po_ok,
     nullif(trim(coalesce(p_obs,'')), ''), auth.uid(), coalesce(p_fotos, '{}'));
  update ordens set status = 'Qualidade apontada'
   where id = p_ordem and status = 'Finalizada';
end $$ language plpgsql security definer set search_path = tsi, public;

revoke execute on function apontar_qualidade_final(uuid,int,boolean,boolean,text,text[]) from public, anon;
grant execute on function apontar_qualidade_final(uuid,int,boolean,boolean,text,text[]) to authenticated;

-- ------------------------------------------------------------
-- Conferência
-- ------------------------------------------------------------
select 'tabela de abastecimentos' as item, (count(*) = 1)::text as ok
  from information_schema.tables
 where table_schema = 'tsi' and table_name = 'ordem_tanque_abastecimentos'
union all
select 'rpc abastecer_tanque', (count(*) = 1)::text
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
 where ns.nspname = 'tsi' and p.proname = 'abastecer_tanque'
union all
select 'view soma abastecido', (position('abastecido_kg' in pg_get_viewdef('tsi.v_ordem_tanque_consumo'::regclass)) > 0)::text
union all
select 'coluna fotos', (count(*) = 1)::text
  from information_schema.columns
 where table_schema = 'tsi' and table_name = 'qualidade_checks' and column_name = 'fotos'
union all
select 'bucket qualidade', (count(*) = 1)::text from storage.buckets where id = 'qualidade'
union all
select 'apontar_qualidade_final unica (sem ambiguidade)', (count(*) = 1)::text
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
 where ns.nspname = 'tsi' and p.proname = 'apontar_qualidade_final';
