-- ============================================================
-- Checklist de veículos (pré-carregamento, pós-carregamento, faturamento)
-- + Chamada de motorista (painel tipo TV) + perfil Balança
-- Execute no SQL Editor do Supabase
-- ============================================================
--
-- Pedido do Arion (15/08/2026): módulo pro pátio/portaria. Dois pedaços:
--
-- 1. CHECKLIST DE VEÍCULO — configurável de propósito ("deve haver o cadastro
--    do tipo de checklist, perguntas e possibilidade de tornar perguntas
--    obrigatórias"): `checklist_tipos`/`checklist_perguntas` são um cadastro
--    comum (mesmo padrão de `receitas`/`receita_itens`), sem conteúdo fixo —
--    o Arion cadastra as perguntas reais pela tela. Cada preenchimento
--    (`veiculo_checklists`/`veiculo_checklist_itens`) é LANÇAMENTO SOLTO: não
--    vincula a um `carregamento` já importado da Expedição, placa/motorista
--    são digitados na hora (cobre veículo de terceiro/coleta avulsa).
--
--    `veiculo_checklists.id` não tem `default gen_random_uuid()`: ele nasce
--    no CLIENTE (`crypto.randomUUID()`) ao abrir o formulário, porque as até
--    6 fotos sobem ao Storage NA SELEÇÃO (mesma correção que a Qualidade
--    acabou de ganhar — nunca guardar dataURL no rascunho) e precisam de uma
--    pasta antes de o registro existir no banco; o mesmo id vira a chave da
--    RPC de salvar.
--
-- 2. CHAMADA DE MOTORISTA — log simples (`chamadas_motorista`), sem RPC (não
--    tem efeito colateral em outra tabela): inserção direta, como
--    `registrarCheckProcesso` da Qualidade. O painel de TV lê as últimas e
--    anuncia a mais recente.
--
-- 3. PERFIL BALANÇA — enxerga só `veiculos` (ver/chamar/checklist), nada
--    mais. `usuarios.perfil` é enum (`perfil_tipo`); Postgres não deixa usar
--    um valor de enum recém-criado antes de commitar — mesmo problema já
--    resolvido quando o perfil Direção foi criado
--    (`principios-ativos-e-direcao.sql`): `alter type ... add value` seguido
--    de `commit;` no mesmo script, antes de qualquer coisa que use o valor.
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 0. Perfil Balança no enum (precisa commitar antes de ser usado abaixo)
-- ------------------------------------------------------------
alter type perfil_tipo add value if not exists 'Balanca';

commit;  -- valor novo de enum só pode ser USADO depois de commitado

-- ------------------------------------------------------------
-- 1. Cadastro configurável: tipos de checklist + perguntas
-- ------------------------------------------------------------
create table if not exists checklist_tipos (
  id     uuid primary key default gen_random_uuid(),
  nome   text unique not null,
  ativo  boolean not null default true
);

create table if not exists checklist_perguntas (
  id          uuid primary key default gen_random_uuid(),
  tipo_id     uuid not null references checklist_tipos(id) on delete cascade,
  texto       text not null,
  obrigatoria boolean not null default true,
  ordem       int not null default 0
);
create index if not exists checklist_perguntas_tipo on checklist_perguntas (tipo_id);

comment on table checklist_tipos is
  'Cadastro configurável (tela Cadastros): tipos de checklist de veículo.';
comment on column checklist_perguntas.obrigatoria is
  'Se true, salvar_checklist_veiculo recusa o checklist sem resposta pra esta pergunta.';

alter table checklist_tipos enable row level security;
alter table checklist_perguntas enable row level security;

drop policy if exists ler_ctipo on checklist_tipos;
create policy ler_ctipo on checklist_tipos for select using (meu_perfil() is not null);
drop policy if exists edita_ctipo on checklist_tipos;
create policy edita_ctipo on checklist_tipos for all
  using (tem_acao('cadastros','editar')) with check (tem_acao('cadastros','editar'));

drop policy if exists ler_cperg on checklist_perguntas;
create policy ler_cperg on checklist_perguntas for select using (meu_perfil() is not null);
drop policy if exists edita_cperg on checklist_perguntas;
create policy edita_cperg on checklist_perguntas for all
  using (tem_acao('cadastros','editar')) with check (tem_acao('cadastros','editar'));

do $$ begin
  alter publication supabase_realtime add table checklist_tipos;
exception when others then null; end $$;
do $$ begin
  alter publication supabase_realtime add table checklist_perguntas;
exception when others then null; end $$;

insert into checklist_tipos (nome) values
  ('Pré-carregamento'), ('Pós-carregamento'), ('Faturamento')
on conflict (nome) do nothing;

-- ------------------------------------------------------------
-- 2. Preenchimento do checklist (lançamento solto, sem vínculo com carregamentos)
-- ------------------------------------------------------------
create table if not exists veiculo_checklists (
  id              uuid primary key,   -- gerado no cliente, ver nota no topo
  tipo_id         uuid not null references checklist_tipos(id),
  placa           text not null,
  motorista       text not null,
  transportadora  text,
  observacao      text,
  fotos           text[] not null default '{}',
  respondido_por  uuid not null references usuarios(id),
  ts              timestamptz not null default now()
);
create index if not exists veiculo_checklists_ts on veiculo_checklists (ts desc);

alter table veiculo_checklists drop constraint if exists veiculo_checklist_ate_6_fotos;
alter table veiculo_checklists add constraint veiculo_checklist_ate_6_fotos
  check (array_length(fotos, 1) is null or array_length(fotos, 1) <= 6);

create table if not exists veiculo_checklist_itens (
  id            uuid primary key default gen_random_uuid(),
  checklist_id  uuid not null references veiculo_checklists(id) on delete cascade,
  pergunta_id   uuid not null references checklist_perguntas(id),
  ok            boolean not null,
  observacao    text
);
create index if not exists veiculo_checklist_itens_checklist on veiculo_checklist_itens (checklist_id);

comment on column veiculo_checklists.fotos is
  'Caminhos no bucket `veiculos` do Storage. Até 6 por checklist.';
comment on table veiculo_checklists is
  'Lançamento solto: placa/motorista digitados na hora, sem vínculo com carregamentos importados.';

alter table veiculo_checklists enable row level security;
alter table veiculo_checklist_itens enable row level security;

-- só leitura direta: a única porta de escrita é a RPC salvar_checklist_veiculo
drop policy if exists ler_vchecklist on veiculo_checklists;
create policy ler_vchecklist on veiculo_checklists for select using (meu_perfil() is not null);
drop policy if exists ler_vitens on veiculo_checklist_itens;
create policy ler_vitens on veiculo_checklist_itens for select using (meu_perfil() is not null);

do $$ begin
  alter publication supabase_realtime add table veiculo_checklists;
exception when others then null; end $$;
do $$ begin
  alter publication supabase_realtime add table veiculo_checklist_itens;
exception when others then null; end $$;

/*
 * Upsert por `id` (idempotente — reenviar depois de um timeout de rede não
 * duplica) + substituição total dos itens (mesmo padrão de `salvarReceita`).
 * Valida as perguntas obrigatórias no servidor além da tela: é registro de
 * conformidade, vale reforçar.
 */
create or replace function salvar_checklist_veiculo(
  p_id uuid,
  p_tipo_id uuid,
  p_placa text,
  p_motorista text,
  p_transportadora text,
  p_observacao text,
  p_fotos text[],
  p_itens jsonb   -- [{ "pergunta_id": "...", "ok": true, "observacao": "..." }, ...]
) returns uuid as $$
declare
  v_faltando int;
begin
  if not tem_acao('veiculos','checklist') then
    raise exception 'Perfil sem permissao para preencher checklist de veiculo';
  end if;
  if p_placa is null or trim(p_placa) = '' then
    raise exception 'Informe a placa do veiculo';
  end if;
  if p_motorista is null or trim(p_motorista) = '' then
    raise exception 'Informe o motorista';
  end if;
  if coalesce(array_length(p_fotos, 1), 0) > 6 then
    raise exception 'No maximo 6 fotos por checklist';
  end if;

  select count(*) into v_faltando
    from checklist_perguntas cp
   where cp.tipo_id = p_tipo_id and cp.obrigatoria
     and not exists (
       select 1 from jsonb_array_elements(coalesce(p_itens, '[]'::jsonb)) it
        where (it->>'pergunta_id')::uuid = cp.id
     );
  if v_faltando > 0 then
    raise exception 'Existem % pergunta(s) obrigatoria(s) sem resposta', v_faltando;
  end if;

  insert into veiculo_checklists
    (id, tipo_id, placa, motorista, transportadora, observacao, fotos, respondido_por)
  values
    (p_id, p_tipo_id, trim(p_placa), trim(p_motorista),
     nullif(trim(coalesce(p_transportadora, '')), ''),
     nullif(trim(coalesce(p_observacao, '')), ''),
     coalesce(p_fotos, '{}'), auth.uid())
  on conflict (id) do update set
    tipo_id = excluded.tipo_id, placa = excluded.placa, motorista = excluded.motorista,
    transportadora = excluded.transportadora, observacao = excluded.observacao,
    fotos = excluded.fotos;

  delete from veiculo_checklist_itens where checklist_id = p_id;

  insert into veiculo_checklist_itens (checklist_id, pergunta_id, ok, observacao)
  select p_id, (it->>'pergunta_id')::uuid, (it->>'ok')::boolean,
         nullif(trim(coalesce(it->>'observacao', '')), '')
    from jsonb_array_elements(coalesce(p_itens, '[]'::jsonb)) it;

  return p_id;
end $$ language plpgsql security definer set search_path = tsi, public;

revoke execute on function salvar_checklist_veiculo(uuid,uuid,text,text,text,text,text[],jsonb) from public, anon;
grant execute on function salvar_checklist_veiculo(uuid,uuid,text,text,text,text,text[],jsonb) to authenticated;

-- ------------------------------------------------------------
-- 3. Bucket de fotos do checklist de veículo (mesma receita da Qualidade)
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('veiculos', 'veiculos', false)
on conflict (id) do nothing;

drop policy if exists veiculos_fotos_ler on storage.objects;
create policy veiculos_fotos_ler on storage.objects for select
  using (bucket_id = 'veiculos' and auth.uid() is not null);

drop policy if exists veiculos_fotos_gravar on storage.objects;
create policy veiculos_fotos_gravar on storage.objects for insert
  with check (bucket_id = 'veiculos' and tsi.tem_acao('veiculos','checklist'));

drop policy if exists veiculos_fotos_apagar on storage.objects;
create policy veiculos_fotos_apagar on storage.objects for delete
  using (bucket_id = 'veiculos' and tsi.tem_acao('veiculos','checklist'));

-- ------------------------------------------------------------
-- 4. Chamada de motorista (log simples, sem RPC — sem efeito em outra tabela)
-- ------------------------------------------------------------
create table if not exists chamadas_motorista (
  id            uuid primary key default gen_random_uuid(),
  placa         text not null,
  motorista     text not null,
  motivo        text not null,   -- texto livre; a tela sugere 'Carregamento'/'Retirada de nota fiscal'
  observacao    text,
  chamado_por   uuid not null references usuarios(id),
  chamado_em    timestamptz not null default now()
);
create index if not exists chamadas_motorista_ts on chamadas_motorista (chamado_em desc);

comment on table chamadas_motorista is
  'Log de chamadas pro painel de TV do pátio. Histórico, sem update/delete.';

alter table chamadas_motorista enable row level security;

drop policy if exists ler_chamada on chamadas_motorista;
create policy ler_chamada on chamadas_motorista for select using (meu_perfil() is not null);
drop policy if exists grava_chamada on chamadas_motorista;
create policy grava_chamada on chamadas_motorista for insert
  with check (tem_acao('veiculos','chamar'));

do $$ begin
  alter publication supabase_realtime add table chamadas_motorista;
exception when others then null; end $$;

-- ------------------------------------------------------------
-- 5. Recurso 'veiculos' no padrão de fábrica do tem_acao + perfil Balança.
--    Espelho de MATRIZ_PADRAO em src/dominio/permissoes.ts — mudou um, mude
--    o outro. (Recria a função inteira: é o padrão deste projeto.)
-- ------------------------------------------------------------
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
      ('PCP','veiculos','ver'), ('PCP','veiculos','chamar'), ('PCP','veiculos','checklist'),
      ('Logistica','programacao','ver'), ('Logistica','lotes','ver'),
      ('Logistica','lotes','baixar_lote'), ('Logistica','lotes','conferir'),
      ('Logistica','etapas','ver'), ('Logistica','indicadores','ver'),
      ('Logistica','expedicao','ver'), ('Logistica','expedicao','importar'),
      ('Logistica','veiculos','ver'), ('Logistica','veiculos','chamar'), ('Logistica','veiculos','checklist'),
      ('Producao','programacao','ver'), ('Producao','execucao','ver'),
      ('Producao','execucao','apontar'),
      ('Producao','etapas','ver'), ('Producao','indicadores','ver'),
      ('Qualidade','execucao','ver'), ('Qualidade','qualidade','ver'),
      ('Qualidade','qualidade','qualidade'),
      ('Qualidade','etapas','ver'), ('Qualidade','indicadores','ver'),
      -- Direção: só leitura, em tudo
      ('Direcao','ordens','ver'), ('Direcao','programacao','ver'),
      ('Direcao','lotes','ver'), ('Direcao','execucao','ver'),
      ('Direcao','qualidade','ver'), ('Direcao','agrotis','ver'),
      ('Direcao','etapas','ver'), ('Direcao','indicadores','ver'),
      ('Direcao','cadastros','ver'), ('Direcao','expedicao','ver'),
      ('Direcao','veiculos','ver'),
      -- Balança: só o módulo de veículos, nada mais
      ('Balanca','veiculos','ver'), ('Balanca','veiculos','chamar'), ('Balanca','veiculos','checklist')
    ) as padrao(perfil, recurso, acao)
      where padrao.perfil = tsi.meu_perfil()::text
        and padrao.recurso = p_recurso and padrao.acao = p_acao),
    false  -- NUNCA null: chamador sem perfil (inclusive anônimo) é sempre "não pode"
  );
$$ language sql stable security definer set search_path = tsi, public;

-- ------------------------------------------------------------
-- Conferência
-- ------------------------------------------------------------
select 'perfil Balanca no enum' as item,
       (exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
                 where t.typname = 'perfil_tipo' and e.enumlabel = 'Balanca'))::text as ok
union all
select 'tabelas do checklist', (count(*) = 4)::text
  from information_schema.tables
 where table_schema = 'tsi' and table_name in
   ('checklist_tipos','checklist_perguntas','veiculo_checklists','veiculo_checklist_itens')
union all
select 'tabela chamadas_motorista', (count(*) = 1)::text
  from information_schema.tables
 where table_schema = 'tsi' and table_name = 'chamadas_motorista'
union all
select '3 tipos seed', (count(*) = 3)::text from checklist_tipos
union all
select 'rpc salvar_checklist_veiculo', (count(*) = 1)::text
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
 where ns.nspname = 'tsi' and p.proname = 'salvar_checklist_veiculo'
union all
select 'bucket veiculos', (count(*) = 1)::text from storage.buckets where id = 'veiculos'
union all
select 'tem_acao com veiculos e Balanca',
       (position('veiculos' in prosrc) > 0 and position('Balanca' in prosrc) > 0)::text
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
 where ns.nspname = 'tsi' and p.proname = 'tem_acao';
