-- ============================================================
-- Inventário de sementes — contagem física × estoque do SAP
-- 04/09/2026 — Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- Fluxo do Arion (04/09/2026):
-- 1. O PCP cria o inventário e INSERE o estoque do SAP nele (upload da
--    mesma planilha do mapa) — a lista fica guardada em inventario_saldos,
--    congelada dentro do inventário.
-- 2. O operador (Logística/Produção) conta contra a lista: lança ENDEREÇO
--    (Armazém/Bloco/Quadra) + QUANTIDADE. A mesma combinação pode ser
--    lançada várias vezes — um lançamento por endereço; a conferência soma.
-- 3. Achou algo fora da lista → lançamento manual completo (lote,
--    cultivar, tratamento, embalagem, quantidade) — "fora do SAP".
-- 4. Conferência por lote + tratamento + EMBALAGEM (bag de BB5M e de BMB
--    não somam juntos): bate / sobra / falta / não contado / fora do SAP.
--    Contagem CEGA: a qtd do SAP não aparece na tela de contagem.
--
-- FORA do mapa de propósito: nenhum saldo é ajustado — só conferência.
-- Fechar congela a comparação em inventario_resultados (registro).
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 1. Tabelas
-- ------------------------------------------------------------
create table if not exists inventarios (
  id          uuid primary key default gen_random_uuid(),
  titulo      text not null,
  criado_em   timestamptz not null default now(),
  criado_por  uuid default auth.uid(),
  fechado_em  timestamptz,
  fechado_por uuid
);

comment on table inventarios is
  'Sessão de inventário físico (04/09/2026). Aberto = em contagem; fechado = comparação congelada em inventario_resultados. Não ajusta saldo nenhum.';

create table if not exists inventario_saldos (
  id            uuid primary key default gen_random_uuid(),
  inventario_id uuid not null references inventarios(id) on delete cascade,
  lote          text not null,   -- número BASE, maiúsculo (sufixos -1/-2 morrem na entrada)
  tratamento    text not null,   -- 'SEM TSI' = semente branca
  cultivar      text not null,
  embalagem     text not null,
  bags          numeric(12,2) not null,
  unique (inventario_id, lote, tratamento, embalagem)
);

comment on table inventario_saldos is
  'A lista do SAP inserida pelo PCP no inventário (upload da mesma planilha do mapa) — a referência da contagem, congelada dentro do inventário.';

create index if not exists inventario_saldos_inv on inventario_saldos (inventario_id);

create table if not exists inventario_itens (
  id            uuid primary key default gen_random_uuid(),
  inventario_id uuid not null references inventarios(id) on delete cascade,
  lote          text not null,
  tratamento    text not null,
  cultivar      text,
  embalagem     text not null,
  armazem       text,            -- endereço onde contou (quadra em TEXTO, como no mapa)
  bloco         text,
  quadra        text,
  bags          numeric(10,2) not null check (bags >= 0),
  fora_da_lista boolean not null default false,
  criado_em     timestamptz not null default now(),
  criado_por    uuid default auth.uid()
);

comment on table inventario_itens is
  'Lançamentos da contagem física — um por endereço (a conferência soma). bags = 0 vale: é "contei e está vazio". fora_da_lista = achado no galpão sem estar na lista do SAP.';

create index if not exists inventario_itens_inv on inventario_itens (inventario_id);

create table if not exists inventario_resultados (
  id            uuid primary key default gen_random_uuid(),
  inventario_id uuid not null references inventarios(id) on delete cascade,
  lote          text not null,
  tratamento    text not null,
  cultivar      text,
  embalagem     text not null,
  bags_contados numeric(12,2),   -- null = combinação do SAP que ninguém contou
  bags_sistema  numeric(12,2),   -- null = contada mas fora da lista do SAP
  constraint inventario_resultado_algum
    check (bags_contados is not null or bags_sistema is not null)
);

comment on table inventario_resultados is
  'Foto da comparação no fechamento — histórica de propósito: a lista do SAP e a contagem não mudam mais depois de fechado.';

create index if not exists inventario_resultados_inv on inventario_resultados (inventario_id);

-- ------------------------------------------------------------
-- 2. Inventário fechado é registro: contagem e lista do SAP não mudam
--    mais (reabrir apaga os resultados e libera de novo)
-- ------------------------------------------------------------
create or replace function fn_inventario_aberto() returns trigger
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_ids uuid[];
  v_id uuid;
  v_fechado timestamptz;
begin
  -- UPDATE que troca de inventário checa OS DOIS pais (varredura de
  -- 04/09/2026: checando só o novo, dava pra mover linha PRA FORA de um
  -- inventário fechado e mutilar o registro histórico)
  v_ids := array_remove(array[
    case when tg_op <> 'DELETE' then new.inventario_id end,
    case when tg_op <> 'INSERT' then old.inventario_id end
  ], null);
  foreach v_id in array v_ids loop
    -- FOR SHARE serializa com o FOR UPDATE do fechar_inventario: um
    -- lançamento no instante exato do fechamento espera o commit e leva o
    -- raise, em vez de entrar calado num inventário já congelado
    select fechado_em into v_fechado from inventarios where id = v_id for share;
    -- pai não encontrado = cascade do DELETE do inventário: permitido
    if found and v_fechado is not null then
      raise exception 'inventário fechado é registro — reabra antes de mexer';
    end if;
  end loop;
  return coalesce(new, old);
end $$;

drop trigger if exists tg_inventario_item_aberto on inventario_itens;
create trigger tg_inventario_item_aberto
  before insert or update or delete on inventario_itens
  for each row execute function fn_inventario_aberto();

drop trigger if exists tg_inventario_saldo_aberto on inventario_saldos;
create trigger tg_inventario_saldo_aberto
  before insert or update or delete on inventario_saldos
  for each row execute function fn_inventario_aberto();

-- fechado_em/fechado_por só mudam pelas RPCs (varredura de 04/09/2026:
-- PATCH direto em inventarios fechava sem gerar foto nenhuma, ou reabria
-- sem apagar o congelado — contornando fechar/reabrir_inventario). As RPCs
-- liberam o gatilho com um GUC de transação.
create or replace function fn_inventario_marcos() returns trigger
language plpgsql security definer set search_path = tsi, public as $$
begin
  if (new.fechado_em is distinct from old.fechado_em
      or new.fechado_por is distinct from old.fechado_por)
     and coalesce(current_setting('tsi.rpc_inventario', true), '') <> '1' then
    raise exception 'fechar/reabrir inventário só pelas funções fechar_inventario/reabrir_inventario';
  end if;
  return new;
end $$;

drop trigger if exists tg_inventario_marcos on inventarios;
create trigger tg_inventario_marcos
  before update on inventarios
  for each row execute function fn_inventario_marcos();

-- ------------------------------------------------------------
-- 3. RPCs (SECURITY INVOKER — a RLS vale pra quem chama)
-- ------------------------------------------------------------

-- Substituição TOTAL da lista do SAP do inventário, transacional (mesma
-- semântica do upload do mapa: o que não veio, sai).
create or replace function substituir_saldos_inventario(p_id uuid, p_saldos jsonb)
returns integer
language plpgsql security invoker set search_path = tsi, public as $$
declare
  v_qtd integer;
begin
  perform 1 from inventarios where id = p_id and fechado_em is null for update;
  if not found then
    raise exception 'inventário não encontrado, sem permissão ou já fechado';
  end if;

  delete from inventario_saldos where inventario_id = p_id;

  insert into inventario_saldos (inventario_id, lote, tratamento, cultivar, embalagem, bags)
  select p_id,
         upper(btrim(s->>'lote')),
         upper(btrim(s->>'tratamento')),
         btrim(s->>'cultivar'),
         upper(btrim(s->>'embalagem')),
         (s->>'bags')::numeric
    from jsonb_array_elements(coalesce(p_saldos, '[]'::jsonb)) s;

  get diagnostics v_qtd = row_count;
  return v_qtd;
end $$;

-- Fechar congela a comparação. Normalização IGUAL ao front
-- (src/dominio/inventario.ts — mudou um, mude o outro): lote BASE
-- maiúsculo, tratamento/embalagem maiúsculos, soma por combinação.
-- SECURITY DEFINER com checagem própria (varredura de 04/09/2026):
-- inventario_resultados NÃO tem policy de escrita — a foto congelada só
-- nasce e morre por estas funções.
create or replace function fechar_inventario(p_id uuid) returns integer
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_qtd integer;
begin
  if not tem_acao('inventario','abrir') then
    raise exception 'Perfil sem permissão para fechar inventário';
  end if;
  -- libera o gatilho de marcos SÓ nesta transação
  perform set_config('tsi.rpc_inventario', '1', true);

  -- lock: dois cliques de "Fechar" ao mesmo tempo não duplicam resultado
  perform 1 from inventarios where id = p_id and fechado_em is null for update;
  if not found then
    raise exception 'inventário não encontrado ou já fechado';
  end if;

  delete from inventario_resultados where inventario_id = p_id;

  insert into inventario_resultados
    (inventario_id, lote, tratamento, cultivar, embalagem, bags_contados, bags_sistema)
  select p_id,
         coalesce(c.lote, s.lote),
         coalesce(c.tratamento, s.tratamento),
         coalesce(s.cultivar, c.cultivar),
         coalesce(c.embalagem, s.embalagem),
         c.bags,
         s.bags
    from (
      select upper(btrim(regexp_replace(lote, '(-\d+)+$', ''))) as lote,
             upper(btrim(tratamento)) as tratamento,
             upper(btrim(embalagem)) as embalagem,
             max(cultivar) as cultivar,
             sum(bags) as bags
        from inventario_itens
       where inventario_id = p_id
       group by 1, 2, 3
    ) c
    full outer join (
      select upper(btrim(regexp_replace(lote, '(-\d+)+$', ''))) as lote,
             upper(btrim(tratamento)) as tratamento,
             upper(btrim(embalagem)) as embalagem,
             max(cultivar) as cultivar,
             sum(bags) as bags
        from inventario_saldos
       where inventario_id = p_id
       group by 1, 2, 3
    ) s on s.lote = c.lote and s.tratamento = c.tratamento and s.embalagem = c.embalagem;

  get diagnostics v_qtd = row_count;

  update inventarios set fechado_em = now(), fechado_por = auth.uid()
   where id = p_id;
  return v_qtd;
end $$;

create or replace function reabrir_inventario(p_id uuid) returns void
language plpgsql security definer set search_path = tsi, public as $$
begin
  if not tem_acao('inventario','abrir') then
    raise exception 'Perfil sem permissão para reabrir inventário';
  end if;
  perform set_config('tsi.rpc_inventario', '1', true);

  perform 1 from inventarios where id = p_id and fechado_em is not null for update;
  if not found then
    raise exception 'inventário não encontrado ou não está fechado';
  end if;
  delete from inventario_resultados where inventario_id = p_id;
  update inventarios set fechado_em = null, fechado_por = null where id = p_id;
end $$;

-- o Supabase dá EXECUTE a PUBLIC em toda função nova — padrão do projeto:
-- revogar por função (trancar-rpc-anon.sql)
revoke execute on function substituir_saldos_inventario(uuid, jsonb) from public, anon;
revoke execute on function fechar_inventario(uuid) from public, anon;
revoke execute on function reabrir_inventario(uuid) from public, anon;
grant execute on function substituir_saldos_inventario(uuid, jsonb) to authenticated, service_role;
grant execute on function fechar_inventario(uuid) to authenticated, service_role;
grant execute on function reabrir_inventario(uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- 4. RLS: quem vê lê; `abrir` (PCP) cria inventário, insere o SAP, fecha,
--    reabre e exclui; `contar` (Logística/Produção) lança e mexe nos
--    lançamentos — de QUALQUER contador, a contagem é do time. tem_acao
--    respeita a matriz da Administração.
-- ------------------------------------------------------------
alter table inventarios enable row level security;
alter table inventario_saldos enable row level security;
alter table inventario_itens enable row level security;
alter table inventario_resultados enable row level security;

drop policy if exists ler_inventarios on inventarios;
create policy ler_inventarios on inventarios for select
  using (tem_acao('inventario','ver'));
drop policy if exists abrir_inventarios on inventarios;
create policy abrir_inventarios on inventarios for all
  using (tem_acao('inventario','abrir'))
  with check (tem_acao('inventario','abrir'));

drop policy if exists ler_inventario_saldos on inventario_saldos;
create policy ler_inventario_saldos on inventario_saldos for select
  using (tem_acao('inventario','ver'));
drop policy if exists abrir_inventario_saldos on inventario_saldos;
create policy abrir_inventario_saldos on inventario_saldos for all
  using (tem_acao('inventario','abrir'))
  with check (tem_acao('inventario','abrir'));

drop policy if exists ler_inventario_itens on inventario_itens;
create policy ler_inventario_itens on inventario_itens for select
  using (tem_acao('inventario','ver'));
drop policy if exists contar_inventario_itens on inventario_itens;
create policy contar_inventario_itens on inventario_itens for all
  using (tem_acao('inventario','contar') or tem_acao('inventario','abrir'))
  with check (tem_acao('inventario','contar') or tem_acao('inventario','abrir'));

drop policy if exists ler_inventario_resultados on inventario_resultados;
create policy ler_inventario_resultados on inventario_resultados for select
  using (tem_acao('inventario','ver'));
-- SEM policy de escrita, de propósito (varredura de 04/09/2026): a foto
-- congelada só nasce (fechar_inventario) e morre (reabrir_inventario ou
-- cascade do DELETE do inventário) pelas RPCs SECURITY DEFINER — escrita
-- direta via PostgREST reescreveria o registro histórico sem rastro.
drop policy if exists abrir_inventario_resultados on inventario_resultados;

-- ------------------------------------------------------------
-- 5. Permissões do recurso novo (decisão do Arion, 04/09/2026):
--    ver = PCP, Logística, Produção, Direção (e Gestor, que tem tudo)
--    abrir (criar, inserir SAP, fechar, reabrir, excluir) = PCP
--    contar (lançar contagem) = Logística e Produção (e PCP)
-- ------------------------------------------------------------
insert into perfil_permissoes (perfil, recurso, acao, permitido) values
  ('PCP',       'inventario', 'ver',    true),
  ('PCP',       'inventario', 'abrir',  true),
  ('PCP',       'inventario', 'contar', true),
  ('Logistica', 'inventario', 'ver',    true),
  ('Logistica', 'inventario', 'contar', true),
  ('Producao',  'inventario', 'ver',    true),
  ('Producao',  'inventario', 'contar', true),
  ('Direcao',   'inventario', 'ver',    true)
on conflict (perfil, recurso, acao) do update set permitido = excluded.permitido;

-- ------------------------------------------------------------
-- 6. tem_acao com `inventario` no padrão de fábrica (espelho de
--    MATRIZ_PADRAO em src/dominio/permissoes.ts — mudou um, mude o outro;
--    recria a função inteira: é o padrão deste projeto)
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
      ('PCP','mrp','ver'), ('PCP','mrp','importar'),
      ('PCP','mapa','ver'), ('PCP','mapa','importar'), ('PCP','mapa','montar_carga'),
      ('PCP','inventario','ver'), ('PCP','inventario','abrir'), ('PCP','inventario','contar'),
      ('PCP','veiculos','ver'), ('PCP','veiculos','chamar'), ('PCP','veiculos','checklist'),
      ('Logistica','programacao','ver'), ('Logistica','lotes','ver'),
      ('Logistica','lotes','baixar_lote'), ('Logistica','lotes','conferir'),
      ('Logistica','etapas','ver'), ('Logistica','indicadores','ver'),
      ('Logistica','expedicao','ver'), ('Logistica','expedicao','importar'),
      ('Logistica','mapa','ver'), ('Logistica','mapa','importar'), ('Logistica','mapa','enderecar'),
      ('Logistica','inventario','ver'), ('Logistica','inventario','contar'),
      ('Logistica','veiculos','ver'), ('Logistica','veiculos','chamar'), ('Logistica','veiculos','checklist'),
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
      -- Balança: veículos e leitura do mapa
      ('Balanca','veiculos','ver'), ('Balanca','veiculos','chamar'), ('Balanca','veiculos','checklist'),
      ('Balanca','mapa','ver')
    ) as padrao(perfil, recurso, acao)
      where padrao.perfil = tsi.meu_perfil()::text
        and padrao.recurso = p_recurso and padrao.acao = p_acao),
    false  -- NUNCA null: chamador sem perfil (inclusive anônimo) é sempre "não pode"
  );
$$ language sql stable security definer set search_path = tsi, public;

-- ------------------------------------------------------------
-- 7. Realtime: dois tablets contando ao mesmo tempo se enxergam
-- ------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table inventarios;
exception when others then null; end $$;
do $$ begin
  alter publication supabase_realtime add table inventario_saldos;
exception when others then null; end $$;
do $$ begin
  alter publication supabase_realtime add table inventario_itens;
exception when others then null; end $$;

-- ============================================================
-- Conferência
-- ============================================================
-- select tablename from pg_tables where schemaname='tsi'
--   and tablename like 'inventario%';
--   -- inventarios, inventario_saldos, inventario_itens, inventario_resultados
-- select 'tem_acao com inventario', position('inventario' in prosrc) > 0
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname='tsi' and p.proname='tem_acao';
-- select perfil, acao, permitido from perfil_permissoes
--   where recurso = 'inventario' order by perfil, acao;
