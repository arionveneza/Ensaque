-- ============================================================
-- TSI — Sistema de Controle de Tratamento Industrial de Sementes
-- Schema PostgreSQL para Supabase
-- Execute no SQL Editor do Supabase (ou via `supabase db push`)
-- ============================================================
--
-- SCHEMA EXCLUSIVO: tudo do TSI vive em `tsi`, não em `public`.
-- Isso mantém o projeto isolado caso o mesmo Supabase hospede outras
-- aplicações, e evita colisão de nomes (ordens, lotes, usuarios são nomes
-- genéricos demais para dividir o public com mais alguém).
--
-- DOIS PASSOS OBRIGATÓRIOS FORA DESTE ARQUIVO:
--
--  1. Supabase → Settings → API → Exposed schemas: acrescentar `tsi`.
--     A API REST (PostgREST) só enxerga os schemas listados ali; sem isso o
--     app recebe 404 em toda tabela, mesmo com o schema criado corretamente.
--
--  2. No cliente: createClient(url, key, { db: { schema: 'tsi' } })
--     Já está assim em src/lib/supabase.ts.
--
-- Não é preciso extensão para UUID: gen_random_uuid() é nativo do
-- PostgreSQL 13+ e vive em pg_catalog, sempre disponível.
-- ============================================================

create schema if not exists tsi;

-- Vale para a sessão que roda este script: os objetos abaixo, sem prefixo,
-- são criados dentro de `tsi`. As funções pinam o próprio search_path.
set search_path = tsi, public;

-- ============================================================
-- 1. TIPOS
-- ============================================================
create type perfil_tipo as enum ('PCP','Logistica','Producao','Qualidade','Gestor');
-- dose por kg ou por 100 kg (a base das bulas de TSI) — copiar a unidade
-- exata da FISPQ evita conversão de cabeça, onde nasce erro de 100×
create type unidade_dose as enum ('ml/kg','g/kg','ml/100kg','g/100kg');
create type status_lote as enum ('Em estoque','Baixado');
create type tipo_parada as enum ('Planejada','Nao planejada');
create type prioridade_tipo as enum ('Normal','Urgente');
create type qualidade_visual as enum ('Aprovado','Aprovado com observacao','Reprovado');
create type status_ordem as enum (
  'Nao programada','Programada','Em producao','Parada',
  'Finalizada','Qualidade apontada','Apontada');
-- obs.: 'Aguardando lote' e 'Pronto para produzir' são DERIVADOS (view), não persistidos.

-- ============================================================
-- 2. USUÁRIOS E PERMISSÕES
-- ============================================================
create table usuarios (
  id          uuid primary key references auth.users(id) on delete cascade,
  nome        text not null,
  perfil      perfil_tipo not null,
  ativo       boolean not null default true,
  criado_em   timestamptz not null default now()
);

-- matriz configurável de acesso (tela de administração)
create table perfil_permissoes (
  perfil      perfil_tipo not null,
  recurso     text not null,          -- 'ordens','programacao','lotes','execucao','qualidade','indicadores','cadastros'
  acao        text not null,          -- 'ver','criar','editar','excluir','priorizar','baixar_lote','apontar','qualidade','agrotis'
  permitido   boolean not null default false,
  primary key (perfil, recurso, acao)
);

-- ============================================================
-- 3. CADASTROS
-- ============================================================
create table maquinas (
  id            text primary key,               -- 'TSI1','TSI2'
  nome          text not null,
  capacidade_th numeric(6,2) not null default 12,
  qtd_tanques   int not null default 5,
  ativa         boolean not null default true
);

create table turnos (
  id        int primary key,                    -- 1, 2
  nome      text not null,
  inicio    time not null,                      -- 07:30 / 17:30
  fim       time not null,                      -- 17:30 / 03:00
  horas     numeric(4,2) not null               -- 10.00 / 9.50
);

create table embalagens (
  codigo      text primary key,                 -- 'BG5M','MEIOBAG'
  codigo_ext  text,                             -- 'BB5M','BMB' (SimpleAgro)
  descricao   text not null,
  sementes    bigint not null,                  -- 5000000 / 2500000
  fator_peso  numeric(5,2) not null             -- 5 / 2.5  (peso_bag = PMS * fator)
);

create table produtos_quimicos (
  id          uuid primary key default gen_random_uuid(),
  codigo      text unique not null,
  nome        text not null,
  unidade     unidade_dose not null,
  densidade   numeric(6,3),                     -- g/ml — obrigatório quando unidade='ml/kg'
  ativo       boolean not null default true,
  constraint dens_obrigatoria check (unidade <> 'ml/kg' or densidade is not null)
);

-- receita: NOME = código do comercial (FTZ60, V&P, DER + LMT...)
create table receitas (
  id        uuid primary key default gen_random_uuid(),
  nome      text unique not null,
  ativa     boolean not null default true
);

create table receita_itens (
  id          uuid primary key default gen_random_uuid(),
  receita_id  uuid not null references receitas(id) on delete cascade,
  produto_id  uuid not null references produtos_quimicos(id),
  dose        numeric(8,4) not null,
  -- 1–5 = tanque; 0 = TRANSFERIDOR (pó secante, que nunca vai em tanque).
  -- >1 produto no mesmo destino = MISTURA
  tanque      int not null check (tanque between 0 and 5),
  unique (receita_id, produto_id)
);

create table motivos_parada (
  id        uuid primary key default gen_random_uuid(),
  descricao text not null,
  tipo      tipo_parada not null,
  ativo     boolean not null default true
);

-- lotes de semente (upload do relatório de Saldos da SimpleAgro)
create table lotes_semente (
  id            text primary key,               -- 'SV0221036260794'
  cultivar      text not null,
  pms           numeric(8,3),                   -- peso de mil sementes (g)
  peso_bag_kg   numeric(10,3) not null,         -- PMS * fator da embalagem
  bags_disp     numeric(10,2),
  status        status_lote not null default 'Em estoque',
  baixado_por   uuid references usuarios(id),
  baixado_em    timestamptz,
  devolver      boolean not null default false, -- baixado e ficou sem ordens
  atualizado_em timestamptz not null default now()
);

-- ============================================================
-- 4. DEMANDA (foto diária — substituição total por carga)
-- ============================================================
create table cargas_demanda (
  id        uuid primary key default gen_random_uuid(),
  tipo      text not null check (tipo in ('pedidos','estoque')),
  origem    text not null default 'upload',     -- 'upload' | 'simpleagro-api' | 'sap'
  criada_em timestamptz not null default now(),
  criada_por uuid references usuarios(id)
);

create table pedidos_venda (
  id        uuid primary key default gen_random_uuid(),
  carga_id  uuid not null references cargas_demanda(id) on delete cascade,
  cultivar  text not null,
  tratamento text not null,                     -- código; pode não ter receita cadastrada
  embalagem text not null references embalagens(codigo),
  bags      numeric(12,2) not null,
  aprovado  boolean not null default true       -- col. H = 'Aprovado'
);

create table estoque_pa (
  id        uuid primary key default gen_random_uuid(),
  carga_id  uuid not null references cargas_demanda(id) on delete cascade,
  cultivar  text not null,
  tratamento text not null,
  embalagem text not null references embalagens(codigo),
  bags      numeric(12,2) not null
);

-- ============================================================
-- 5. ORDENS
-- ============================================================
create table ordens (
  id            uuid primary key default gen_random_uuid(),
  numero        text not null,
  cultivar      text not null,
  receita_id    uuid not null references receitas(id),
  embalagem     text not null references embalagens(codigo),
  bags          int not null check (bags > 0),
  lote_id       text not null references lotes_semente(id),
  cliente       text,                            -- texto livre (sem cadastro)
  observacao    text,                            -- ex.: 'SEM GRAFITE'
  prioridade    prioridade_tipo not null default 'Normal',
  prioridade_por uuid references usuarios(id),
  prioridade_em timestamptz,
  maquina_id    text references maquinas(id),    -- null = pool
  data_prog     date,                            -- dia de produção
  seq           int,                             -- ordem na fila da máquina/dia
  turno_id      int references turnos(id),       -- DERIVADO do horário do início
  status        status_ordem not null default 'Programada',
  fim_pendente  boolean not null default false,  -- etapa de pesagem final aberta
  bags_produzidos int check (bags_produzidos is null or bags_produzidos > 0),
                  -- informado pela producao ao confirmar a finalizacao (05/08/2026)
  origem        text not null default 'replicada', -- 'replicada'|'digitacao'|'importacao'
  agrotis_num   text,                            -- nº do lançamento no AGROTIS
  agrotis_por   uuid references usuarios(id),
  agrotis_em    timestamptz,
  criado_em     timestamptz not null default now(),
  -- chave anti-duplicidade
  unique (numero, cultivar, receita_id, embalagem)
);
create index on ordens (maquina_id, data_prog, seq);
create index on ordens (status);
create index on ordens (lote_id);

create table ordem_eventos (
  id        uuid primary key default gen_random_uuid(),
  ordem_id  uuid not null references ordens(id) on delete cascade,
  tipo      text not null check (tipo in ('inicio','fim')),
  ts        timestamptz not null default now(),
  usuario_id uuid references usuarios(id)
);

create table ordem_paradas (
  id        uuid primary key default gen_random_uuid(),
  ordem_id  uuid not null references ordens(id) on delete cascade,
  motivo_id uuid not null references motivos_parada(id),
  inicio    timestamptz not null default now(),
  fim       timestamptz,
  usuario_id uuid references usuarios(id)
);

-- 1 linha por TANQUE usado na ordem (mistura = vários produtos no mesmo tanque)
create table ordem_tanques (
  id            uuid primary key default gen_random_uuid(),
  ordem_id      uuid not null references ordens(id) on delete cascade,
  tanque        int not null check (tanque between 0 and 5),  -- 0 = transferidor
  peso_inicial  numeric(10,3),                  -- obrigatório para confirmar início
  peso_final    numeric(10,3),                  -- obrigatório para confirmar finalização
  unique (ordem_id, tanque)
);

create table ordem_qualidade (
  ordem_id    uuid primary key references ordens(id) on delete cascade,
  visual      qualidade_visual not null,
  amostra     boolean not null,
  observacao  text,
  inspetor_id uuid references usuarios(id),
  apontado_em timestamptz not null default now()
);

-- trilha de auditoria (cancelamento de início, prioridade, AGROTIS...)
create table ordem_auditoria (
  id        uuid primary key default gen_random_uuid(),
  ordem_id  uuid not null references ordens(id) on delete cascade,
  acao      text not null,
  detalhe   text,
  usuario_id uuid references usuarios(id),
  ts        timestamptz not null default now()
);

-- log de baixas/estornos de lote (relatório da logística)
create table lote_movimentos (
  id        uuid primary key default gen_random_uuid(),
  lote_id   text not null references lotes_semente(id),
  bags      numeric(12,2) not null,             -- negativo = estorno
  peso_t    numeric(12,3),
  estorno   boolean not null default false,
  usuario_id uuid references usuarios(id),
  ts        timestamptz not null default now()
);

-- ============================================================
-- 6. VIEWS DE CÁLCULO
-- ============================================================

-- status derivado: 'Aguardando lote' / 'Pronto para produzir'
create or replace view v_ordens as
select o.*,
  case
    when o.status in ('Em producao','Parada','Finalizada','Qualidade apontada','Apontada')
      then o.status::text
    when o.maquina_id is null then 'Nao programada'
    when ls.status = 'Em estoque' then 'Aguardando lote'
    else 'Pronto para produzir'
  end as status_efetivo,
  ls.peso_bag_kg,
  o.bags * ls.peso_bag_kg           as peso_kg,
  o.bags * ls.peso_bag_kg / 1000.0  as peso_t,
  r.nome                            as receita_nome
from ordens o
join lotes_semente ls on ls.id = o.lote_id
join receitas r       on r.id = o.receita_id;

-- peso de balança planejado por item de receita, para uma ordem
create or replace view v_ordem_itens_planejado as
select o.id as ordem_id, ri.tanque, ri.produto_id, pq.codigo, pq.nome, pq.unidade,
       pq.densidade, ri.dose,
       case when pq.unidade = 'ml/kg'
            then ri.dose * o.peso_kg * coalesce(pq.densidade,1) / 1000.0
            else ri.dose * o.peso_kg / 1000.0
       end as peso_planejado_kg,
       case when pq.unidade = 'ml/kg'
            then ri.dose * o.peso_kg / 1000.0 else null
       end as volume_planejado_l
from v_ordens o
join receita_itens ri on ri.receita_id = o.receita_id
join produtos_quimicos pq on pq.id = ri.produto_id;

-- Real vs Planejado por tanque (mistura = soma dos produtos do tanque)
create or replace view v_ordem_tanque_consumo as
select ot.ordem_id, ot.tanque, ot.peso_inicial, ot.peso_final,
       p.planejado_kg,
       case when ot.peso_inicial is not null and ot.peso_final is not null
            then greatest(0, ot.peso_inicial - ot.peso_final) end as real_kg,
       case when ot.peso_inicial is not null and ot.peso_final is not null and p.planejado_kg > 0
            then (greatest(0, ot.peso_inicial - ot.peso_final) - p.planejado_kg)
                 / p.planejado_kg * 100 end as desvio_pct
from ordem_tanques ot
join (select ordem_id, tanque, sum(peso_planejado_kg) as planejado_kg
      from v_ordem_itens_planejado group by 1,2) p
  on p.ordem_id = ot.ordem_id and p.tanque = ot.tanque;

-- tempos por ordem
create or replace view v_ordem_tempos as
with ev as (
  select ordem_id,
         min(ts) filter (where tipo='inicio') as ini,
         max(ts) filter (where tipo='fim')    as fim
  from ordem_eventos group by 1),
par as (
  select p.ordem_id,
    sum(extract(epoch from (coalesce(p.fim, now()) - p.inicio)))                                    as par_total,
    sum(extract(epoch from (coalesce(p.fim, now()) - p.inicio))) filter (where m.tipo='Planejada')   as par_plan,
    sum(extract(epoch from (coalesce(p.fim, now()) - p.inicio))) filter (where m.tipo='Nao planejada') as par_nplan
  from ordem_paradas p join motivos_parada m on m.id = p.motivo_id group by 1)
select o.id as ordem_id, o.numero, o.maquina_id, o.data_prog, o.turno_id, o.peso_t,
  ev.ini, ev.fim,
  extract(epoch from (coalesce(ev.fim, now()) - ev.ini))                     as bruto_s,
  coalesce(par.par_total,0)                                                  as paradas_s,
  coalesce(par.par_plan,0)                                                   as paradas_plan_s,
  coalesce(par.par_nplan,0)                                                  as paradas_nplan_s,
  extract(epoch from (coalesce(ev.fim, now()) - ev.ini)) - coalesce(par.par_total,0) as liquido_s,
  o.peso_t / m.capacidade_th * 3600                                          as planejado_s
from v_ordens o
join maquinas m on m.id = o.maquina_id
left join ev  on ev.ordem_id = o.id
left join par on par.ordem_id = o.id
where ev.ini is not null;

-- ocupação por máquina e dia
create or replace view v_ocupacao as
select o.maquina_id, o.data_prog,
       sum(o.peso_t)                                        as programado_t,
       m.capacidade_th * (select sum(horas) from turnos)     as capacidade_t,
       sum(o.peso_t) / (m.capacidade_th * (select sum(horas) from turnos)) * 100 as ocupacao_pct
from v_ordens o join maquinas m on m.id = o.maquina_id
where o.maquina_id is not null
group by 1,2, m.capacidade_th;

-- balanço de demanda (pedidos aprovados − estoque − ordens abertas)
create or replace view v_balanco_demanda as
with ult_ped as (select id from cargas_demanda where tipo='pedidos' order by criada_em desc limit 1),
     ult_est as (select id from cargas_demanda where tipo='estoque' order by criada_em desc limit 1),
ped as (select cultivar, tratamento, embalagem,
               sum(bags) filter (where aprovado)     as ped_aprov,
               sum(bags) filter (where not aprovado) as ped_pend
        from pedidos_venda where carga_id = (select id from ult_ped) group by 1,2,3),
est as (select cultivar, tratamento, embalagem, sum(bags) as est_bags
        from estoque_pa where carga_id = (select id from ult_est) group by 1,2,3),
abe as (select o.cultivar, r.nome as tratamento, o.embalagem, sum(o.bags) as abertas
        from ordens o join receitas r on r.id = o.receita_id
        where o.status <> 'Apontada' group by 1,2,3)
select coalesce(p.cultivar, e.cultivar, a.cultivar)       as cultivar,
       coalesce(p.tratamento, e.tratamento, a.tratamento) as tratamento,
       coalesce(p.embalagem, e.embalagem, a.embalagem)    as embalagem,
       coalesce(p.ped_aprov,0) as pedido_aprovado,
       coalesce(p.ped_pend,0)  as pedido_pendente,
       coalesce(e.est_bags,0)  as estoque_pa,
       coalesce(a.abertas,0)   as ordens_abertas,
       coalesce(p.ped_aprov,0) - coalesce(e.est_bags,0) - coalesce(a.abertas,0) as saldo,
       exists(select 1 from receitas r where r.nome = coalesce(p.tratamento,e.tratamento,a.tratamento))
         as receita_cadastrada
from ped p
full join est e on (e.cultivar,e.tratamento,e.embalagem) = (p.cultivar,p.tratamento,p.embalagem)
full join abe a on (a.cultivar,a.tratamento,a.embalagem) = (coalesce(p.cultivar,e.cultivar),
                                                            coalesce(p.tratamento,e.tratamento),
                                                            coalesce(p.embalagem,e.embalagem));

-- ------------------------------------------------------------
-- 6b. VIEWS RESPEITAM O RLS DE QUEM CHAMA
-- Por padrão uma view no PostgreSQL executa com os privilégios de quem a
-- CRIOU, e não de quem a consulta — o que faria estas views devolverem dados
-- passando por cima do RLS das tabelas de baixo. Como elas ficam expostas na
-- API REST, `anon` conseguiria ler a produção inteira via v_ordens mesmo com
-- a tabela `ordens` protegida. security_invoker inverte isso: a consulta
-- aplica o RLS do usuário autenticado.
-- ------------------------------------------------------------
alter view v_ordens                set (security_invoker = true);
alter view v_ordem_itens_planejado set (security_invoker = true);
alter view v_ordem_tanque_consumo  set (security_invoker = true);
alter view v_ordem_tempos          set (security_invoker = true);
alter view v_ocupacao              set (security_invoker = true);
alter view v_balanco_demanda       set (security_invoker = true);

-- ============================================================
-- 7. REGRAS NO BANCO (defesa em profundidade — o app também valida)
-- ============================================================

-- recurso único: uma ordem em andamento por máquina
create unique index ordem_unica_por_maquina
  on ordens (maquina_id)
  where status in ('Em producao','Parada');

-- não iniciar sem peso inicial em todos os tanques e sem o lote de semente
-- baixado (o controle de lote de QUÍMICO saiu do escopo em 05/08/2026)
create or replace function fn_valida_inicio() returns trigger as $$
declare falta int;
begin
  if new.status = 'Em producao' and old.status <> 'Em producao' then
    select count(*) into falta from ordem_tanques t
      where t.ordem_id = new.id and t.peso_inicial is null;
    if falta > 0 then raise exception 'Peso inicial pendente em % tanque(s)', falta; end if;

    if (select status from lotes_semente where id = new.lote_id) = 'Em estoque' then
      raise exception 'Lote de semente nao baixado pelo estoque';
    end if;
  end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;
create trigger tg_valida_inicio before update on ordens
  for each row execute function fn_valida_inicio();

-- não finalizar sem peso inicial e sem a quantidade produzida.
-- O peso FINAL saiu daqui (decisão de 05/08/2026): o operador anota no papel
-- e o PCP digita na tela AGROTIS — o lançamento é que exige (fn_valida_agrotis).
create or replace function fn_valida_fim() returns trigger as $$
declare falta int;
begin
  if new.status = 'Finalizada' and old.status <> 'Finalizada' then
    select count(*) into falta from ordem_tanques t
      where t.ordem_id = new.id and t.peso_inicial is null;
    if falta > 0 then raise exception 'Peso inicial pendente em % tanque(s)', falta; end if;
    if new.bags_produzidos is null then
      raise exception 'Informe a quantidade produzida (bags) para finalizar';
    end if;
  end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;
create trigger tg_valida_fim before update on ordens
  for each row execute function fn_valida_fim();

-- estorno de lote bloqueado se alguma ordem dele já iniciou
create or replace function fn_valida_estorno() returns trigger as $$
begin
  if new.status = 'Em estoque' and old.status = 'Baixado' then
    if exists (select 1 from ordens o where o.lote_id = new.id
               and o.status in ('Em producao','Parada','Finalizada','Qualidade apontada','Apontada')) then
      raise exception 'Estorno bloqueado: lote ja consumido por ordem iniciada';
    end if;
  end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;
create trigger tg_valida_estorno before update on lotes_semente
  for each row execute function fn_valida_estorno();

-- ordem iniciada/finalizada é registro histórico: não altera nem exclui
create or replace function fn_ordem_imutavel() returns trigger as $$
begin
  if old.status in ('Em producao','Parada','Finalizada','Qualidade apontada','Apontada') then
    if tg_op = 'DELETE' then
      raise exception 'Ordem % nao pode ser excluida (status %)', old.numero, old.status;
    end if;
    -- permite apenas transições de fluxo e campos de encerramento
    if new.cultivar <> old.cultivar or new.receita_id <> old.receita_id
       or new.embalagem <> old.embalagem or new.bags <> old.bags
       or new.lote_id <> old.lote_id or new.maquina_id is distinct from old.maquina_id
       or new.data_prog is distinct from old.data_prog then
      raise exception 'Ordem % em andamento/finalizada nao pode ser editada', old.numero;
    end if;
  end if;
  -- em trigger de DELETE o NEW e' NULL: retornar NULL num BEFORE DELETE cancelaria
  -- a exclusao silenciosamente, bloqueando ordens que a matriz permite excluir
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;
create trigger tg_ordem_imutavel before update or delete on ordens
  for each row execute function fn_ordem_imutavel();

-- quem decide se a ordem pode sumir é a HISTÓRIA, não o status: o Cancelar
-- início devolve o rótulo 'Programada', e sem esta trava uma ordem com testes
-- de qualidade voltava a ser excluível em cascata (decisão de 05/08/2026).
-- Tanques/pesos sem confirmação não bloqueiam (preparação é descartável);
-- auditoria também não (ordem cancelada continua excluível).
create or replace function fn_ordem_sem_historia() returns trigger as $$
begin
  if exists (select 1 from qualidade_checks  q where q.ordem_id = old.id)
     or exists (select 1 from ordem_conferencias c where c.ordem_id = old.id)
     or exists (select 1 from ordem_eventos  e where e.ordem_id = old.id)
     or exists (select 1 from ordem_paradas  p where p.ordem_id = old.id) then
    raise exception
      'Ordem % tem historia (producao/qualidade/conferencia) e nao pode ser excluida',
      old.numero;
  end if;
  return old;
end $$ language plpgsql set search_path = tsi, public;
create trigger tg_ordem_sem_historia before delete on ordens
  for each row execute function fn_ordem_sem_historia();

-- turno derivado do horário real do início (até 17:30 = T1)
create or replace function fn_turno_do_inicio() returns trigger as $$
begin
  if new.tipo = 'inicio' then
    update ordens set turno_id =
      case when (new.ts at time zone 'America/Sao_Paulo')::time
                between time '07:30' and time '17:30' then 1 else 2 end
    where id = new.ordem_id;
  end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;
create trigger tg_turno_do_inicio after insert on ordem_eventos
  for each row execute function fn_turno_do_inicio();

-- ============================================================
-- 8. RLS — espelha a matriz de perfis
-- ============================================================
alter table ordens              enable row level security;
alter table ordem_eventos       enable row level security;
alter table ordem_paradas       enable row level security;
alter table ordem_tanques       enable row level security;
alter table ordem_qualidade     enable row level security;
alter table lotes_semente       enable row level security;
alter table pedidos_venda       enable row level security;
alter table estoque_pa          enable row level security;
alter table lote_movimentos     enable row level security;

-- SECURITY DEFINER: lê `usuarios` ignorando o RLS da própria tabela, o que
-- evita recursão infinita nas políticas. O search_path fixo é obrigatório
-- aqui — sem ele, um search_path manipulado poderia apontar `usuarios` para
-- outra tabela e forjar o perfil de quem chama.
create or replace function meu_perfil() returns perfil_tipo as $$
  select perfil from tsi.usuarios where id = auth.uid() and ativo;
$$ language sql stable security definer set search_path = tsi, public;

-- leitura: todo usuário ativo
create policy ler_ordens on ordens for select using (meu_perfil() is not null);
create policy ler_lotes  on lotes_semente for select using (meu_perfil() is not null);
create policy ler_ped    on pedidos_venda for select using (meu_perfil() is not null);
create policy ler_est    on estoque_pa for select using (meu_perfil() is not null);
create policy ler_ev     on ordem_eventos for select using (meu_perfil() is not null);
create policy ler_par    on ordem_paradas for select using (meu_perfil() is not null);
create policy ler_tq     on ordem_tanques for select using (meu_perfil() is not null);
create policy ler_qual   on ordem_qualidade for select using (meu_perfil() is not null);
create policy ler_mov    on lote_movimentos for select using (meu_perfil() is not null);

-- PCP/Gestor: ordens e demanda
create policy pcp_ordens on ordens for all
  using (meu_perfil() in ('PCP','Gestor')) with check (meu_perfil() in ('PCP','Gestor'));
create policy pcp_ped on pedidos_venda for all
  using (meu_perfil() in ('PCP','Gestor')) with check (meu_perfil() in ('PCP','Gestor'));
create policy pcp_est on estoque_pa for all
  using (meu_perfil() in ('PCP','Gestor')) with check (meu_perfil() in ('PCP','Gestor'));

-- Logística/Gestor: baixa de lote
create policy log_lotes on lotes_semente for update
  using (meu_perfil() in ('Logistica','Gestor')) with check (meu_perfil() in ('Logistica','Gestor'));

-- PCP/Gestor: carga dos lotes vinda do upload da planilha de Saldos.
-- O upload é do PCP (tela Ordens), então sem estas políticas a importação falha.
-- Obs.: a exclusividade da BAIXA (mudança de status) pela Logística é garantida
-- pelo app e pelo trigger de estorno — RLS não distingue qual coluna mudou.
create policy pcp_lotes_ins on lotes_semente for insert
  with check (meu_perfil() in ('PCP','Gestor'));
create policy pcp_lotes_upd on lotes_semente for update
  using (meu_perfil() in ('PCP','Gestor')) with check (meu_perfil() in ('PCP','Gestor'));
create policy log_mov on lote_movimentos for insert
  with check (meu_perfil() in ('Logistica','Gestor'));

-- Produção/Gestor: apontamento
create policy prod_ev on ordem_eventos for insert with check (meu_perfil() in ('Producao','Gestor'));
create policy prod_par on ordem_paradas for all
  using (meu_perfil() in ('Producao','Gestor')) with check (meu_perfil() in ('Producao','Gestor'));
create policy prod_tq on ordem_tanques for all
  using (meu_perfil() in ('Producao','Gestor')) with check (meu_perfil() in ('Producao','Gestor'));

-- Qualidade/Gestor
create policy qual_ap on ordem_qualidade for all
  using (meu_perfil() in ('Qualidade','Gestor')) with check (meu_perfil() in ('Qualidade','Gestor'));

-- ------------------------------------------------------------
-- 8b. RLS DOS CADASTROS E DEMAIS TABELAS
-- No Supabase, tabela SEM row level security fica legivel e gravavel por
-- qualquer portador da chave anonima (que vai no bundle do front-end).
-- Toda tabela exposta na API precisa de RLS explicito.
-- ------------------------------------------------------------
alter table usuarios           enable row level security;
alter table perfil_permissoes  enable row level security;
alter table maquinas           enable row level security;
alter table turnos             enable row level security;
alter table embalagens         enable row level security;
alter table produtos_quimicos  enable row level security;
alter table receitas           enable row level security;
alter table receita_itens      enable row level security;
alter table motivos_parada     enable row level security;
alter table cargas_demanda     enable row level security;
alter table ordem_auditoria    enable row level security;

-- leitura dos cadastros: todo usuario ativo (a operacao precisa das receitas e doses)
create policy ler_usuarios on usuarios for select using (meu_perfil() is not null);
create policy ler_perm     on perfil_permissoes for select using (meu_perfil() is not null);
create policy ler_maq      on maquinas for select using (meu_perfil() is not null);
create policy ler_tur      on turnos for select using (meu_perfil() is not null);
create policy ler_emb      on embalagens for select using (meu_perfil() is not null);
create policy ler_quim     on produtos_quimicos for select using (meu_perfil() is not null);
create policy ler_rec      on receitas for select using (meu_perfil() is not null);
create policy ler_ri       on receita_itens for select using (meu_perfil() is not null);
create policy ler_mot      on motivos_parada for select using (meu_perfil() is not null);
create policy ler_cargas   on cargas_demanda for select using (meu_perfil() is not null);
create policy ler_aud      on ordem_auditoria for select using (meu_perfil() is not null);

-- manutencao dos cadastros: PCP/Gestor (tela Cadastros da matriz de perfis)
create policy pcp_maq  on maquinas for all
  using (meu_perfil() in ('PCP','Gestor')) with check (meu_perfil() in ('PCP','Gestor'));
create policy pcp_tur  on turnos for all
  using (meu_perfil() in ('PCP','Gestor')) with check (meu_perfil() in ('PCP','Gestor'));
create policy pcp_emb  on embalagens for all
  using (meu_perfil() in ('PCP','Gestor')) with check (meu_perfil() in ('PCP','Gestor'));
create policy pcp_quim on produtos_quimicos for all
  using (meu_perfil() in ('PCP','Gestor')) with check (meu_perfil() in ('PCP','Gestor'));
create policy pcp_rec  on receitas for all
  using (meu_perfil() in ('PCP','Gestor')) with check (meu_perfil() in ('PCP','Gestor'));
create policy pcp_ri   on receita_itens for all
  using (meu_perfil() in ('PCP','Gestor')) with check (meu_perfil() in ('PCP','Gestor'));
create policy pcp_mot  on motivos_parada for all
  using (meu_perfil() in ('PCP','Gestor')) with check (meu_perfil() in ('PCP','Gestor'));
create policy pcp_cargas on cargas_demanda for all
  using (meu_perfil() in ('PCP','Gestor')) with check (meu_perfil() in ('PCP','Gestor'));

-- usuarios e matriz de permissoes: so o Gestor administra (tela de administracao)
create policy gestor_usuarios on usuarios for all
  using (meu_perfil() = 'Gestor') with check (meu_perfil() = 'Gestor');
create policy gestor_perm on perfil_permissoes for all
  using (meu_perfil() = 'Gestor') with check (meu_perfil() = 'Gestor');

-- auditoria: qualquer usuario ativo registra; ninguem altera nem apaga
create policy grava_aud on ordem_auditoria for insert
  with check (meu_perfil() is not null);

-- ------------------------------------------------------------
-- 8c. GRANTS DO SCHEMA tsi
-- Expor o schema na API não basta: os papéis do PostgREST precisam de
-- permissão no schema, senão toda chamada volta "permission denied".
-- Quem restringe de fato é o RLS acima — o grant só abre a porta para ele.
-- `anon` recebe acesso porque é o papel usado antes do login, mas todas as
-- políticas exigem meu_perfil() não nulo, que é nulo para quem não é usuário.
-- ------------------------------------------------------------
grant usage on schema tsi to anon, authenticated, service_role;

grant all on all tables    in schema tsi to anon, authenticated, service_role;
grant all on all sequences in schema tsi to anon, authenticated, service_role;
grant all on all functions in schema tsi to anon, authenticated, service_role;

-- objetos criados depois deste script herdam os mesmos grants
alter default privileges in schema tsi
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema tsi
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema tsi
  grant all on functions to anon, authenticated, service_role;

-- ============================================================
-- 9. SEED MÍNIMO
-- ============================================================
insert into maquinas (id,nome,capacidade_th,qtd_tanques) values
  ('TSI1','TSI 1',12,5), ('TSI2','TSI 2',12,5);

insert into turnos (id,nome,inicio,fim,horas) values
  (1,'Turno 1','07:30','17:30',10.00),
  (2,'Turno 2','17:30','03:00',9.50);

insert into embalagens (codigo,codigo_ext,descricao,sementes,fator_peso) values
  ('BG5M','BB5M','Bag 5 milhoes de sementes',5000000,5),
  ('MEIOBAG','BMB','Meio bag (2,5 milhoes)',2500000,2.5);

insert into motivos_parada (descricao,tipo) values
  ('Setup / troca de receita','Planejada'),
  ('Limpeza de maquina','Planejada'),
  ('Refeicao / troca de turno','Planejada'),
  ('Manutencao preventiva','Planejada'),
  ('Quebra de equipamento','Nao planejada'),
  ('Falta de lote de semente','Nao planejada'),
  ('Falta de produto quimico','Nao planejada'),
  ('Falta de embalagem','Nao planejada'),
  ('Entupimento / obstrucao','Nao planejada'),
  ('Queda de energia','Nao planejada');

-- ATENÇÃO: produtos_quimicos, receitas e receita_itens devem ser carregados com os
-- dados REAIS (densidades da FISPQ). O protótipo usa valores fictícios plausíveis.

-- ============================================================
-- 10. ETAPAS DA ORDEM (05/08/2026)
-- Qualidade em 2 tempos + conferência da logística + visão geral.
-- O checklist SUBSTITUI o Aprovado/Reprovado + amostra da ordem_qualidade,
-- que fica sem uso (remover na limpeza geral). Espelho de etapas.sql.
-- ============================================================

create table qualidade_checks (
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
create index on qualidade_checks (ordem_id);
create unique index qualidade_final_unica
  on qualidade_checks (ordem_id) where etapa = 'final';

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
create trigger tg_valida_qualidade_check before insert on qualidade_checks
  for each row execute function fn_valida_qualidade_check();

create table ordem_conferencias (
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
create trigger tg_valida_conferencia before insert or update on ordem_conferencias
  for each row execute function fn_valida_conferencia();

-- SECURITY DEFINER: o perfil Qualidade não tem UPDATE em ordens pelo RLS,
-- então o flip Finalizada → Qualidade apontada precisa vir por aqui.
create or replace function apontar_qualidade_final(
  p_ordem uuid, p_recobrimento int, p_umidade_ok boolean, p_po_ok boolean, p_obs text
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

-- AGROTIS exige a conferência da logística: a qualidade final já é garantida
-- pelo fluxo de status, mas a conferência não muda status — cadeado próprio.
create or replace function fn_valida_agrotis() returns trigger as $$
declare falta int;
begin
  if new.status = 'Apontada' and old.status is distinct from 'Apontada' then
    if not exists (select 1 from ordem_conferencias c where c.ordem_id = new.id) then
      raise exception 'Lancamento no AGROTIS exige a conferencia de estoque da logistica';
    end if;
    -- pesos finais sao digitados pelo PCP na propria tela AGROTIS (05/08/2026)
    select count(*) into falta from ordem_tanques t
      where t.ordem_id = new.id and t.peso_final is null;
    if falta > 0 then
      raise exception 'Lancamento no AGROTIS exige o peso final de todos os tanques (% pendente(s))', falta;
    end if;
  end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;
create trigger tg_valida_agrotis before update on ordens
  for each row execute function fn_valida_agrotis();

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
alter view v_ordem_etapas set (security_invoker = true);

alter table qualidade_checks   enable row level security;
alter table ordem_conferencias enable row level security;
create policy ler_qc on qualidade_checks for select using (meu_perfil() is not null);
-- checklist é trilha: insere, não edita nem apaga
create policy qual_qc on qualidade_checks for insert
  with check (meu_perfil() in ('Qualidade','Gestor'));
create policy ler_conf on ordem_conferencias for select using (meu_perfil() is not null);
-- conferência pode ser corrigida (recontagem) pela própria logística
create policy log_conf on ordem_conferencias for all
  using (meu_perfil() in ('Logistica','Gestor'))
  with check (meu_perfil() in ('Logistica','Gestor'));
