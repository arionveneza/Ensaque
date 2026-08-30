-- ============================================================
-- Mapa: montar carga/lotear é do PCP; Logística endereça e fotografa
-- 30/08/2026 — Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- Decisão do Arion (30/08/2026):
-- - montar carga e lotear: SÓ PCP e Gestor (a Balança perde a ação e
--   segue vendo o mapa e as cargas);
-- - Logística: endereça, movimenta, filtra, sobe planilha e TIRA FOTO da
--   carga/placa — mas não monta nem loteia.
--
-- A matriz padrão do front mudou junto (permissoes.ts); aqui entram os
-- overrides em perfil_permissoes (valem no front e no tem_acao do banco —
-- o fallback embutido do tem_acao é anterior ao recurso `mapa`), as
-- políticas do bucket de fotos e o RLS das tabelas de carga.
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 1. Overrides da matriz (a tela de administração pode mudar depois)
-- ------------------------------------------------------------
insert into perfil_permissoes (perfil, recurso, acao, permitido) values
  ('PCP',       'mapa', 'ver',          true),
  ('PCP',       'mapa', 'importar',     true),
  ('PCP',       'mapa', 'montar_carga', true),
  ('PCP',       'mapa', 'enderecar',    false),
  ('Logistica', 'mapa', 'ver',          true),
  ('Logistica', 'mapa', 'importar',     true),
  ('Logistica', 'mapa', 'enderecar',    true),
  ('Logistica', 'mapa', 'montar_carga', false),
  ('Balanca',   'mapa', 'ver',          true),
  ('Balanca',   'mapa', 'importar',     false),
  ('Balanca',   'mapa', 'enderecar',    false),
  ('Balanca',   'mapa', 'montar_carga', false),
  ('Direcao',   'mapa', 'ver',          true)
on conflict (perfil, recurso, acao) do update set permitido = excluded.permitido;

-- ------------------------------------------------------------
-- 2. Fotos da carga: quem monta (PCP/Gestor) OU quem endereça (Logística)
-- ------------------------------------------------------------
drop policy if exists cargas_fotos_gravar on storage.objects;
create policy cargas_fotos_gravar on storage.objects for insert
  with check (
    bucket_id = 'cargas'
    and (tsi.tem_acao('mapa','montar_carga') or tsi.tem_acao('mapa','enderecar'))
  );

drop policy if exists cargas_fotos_apagar on storage.objects;
create policy cargas_fotos_apagar on storage.objects for delete
  using (
    bucket_id = 'cargas'
    and (tsi.tem_acao('mapa','montar_carga') or tsi.tem_acao('mapa','enderecar'))
  );

-- ------------------------------------------------------------
-- 3. RLS das cargas: escrita geral PCP/Gestor; Logística só UPDATE
--    (o app dela só mexe na coluna fotos — o formulário de montagem e o
--    lotear nem aparecem sem a ação montar_carga)
-- ------------------------------------------------------------
drop policy if exists bal_cargas_mont on cargas_montadas;
drop policy if exists pcp_cargas_mont on cargas_montadas;
create policy pcp_cargas_mont on cargas_montadas for all
  using (meu_perfil() in ('PCP','Gestor'))
  with check (meu_perfil() in ('PCP','Gestor'));
drop policy if exists log_fotos_cargas on cargas_montadas;
create policy log_fotos_cargas on cargas_montadas for update
  using (meu_perfil() = 'Logistica')
  with check (meu_perfil() = 'Logistica');

drop policy if exists bal_carga_prod on carga_montada_produtos;
drop policy if exists pcp_carga_prod on carga_montada_produtos;
create policy pcp_carga_prod on carga_montada_produtos for all
  using (meu_perfil() in ('PCP','Gestor'))
  with check (meu_perfil() in ('PCP','Gestor'));

drop policy if exists bal_carga_itens on carga_montada_itens;
drop policy if exists pcp_carga_itens on carga_montada_itens;
create policy pcp_carga_itens on carga_montada_itens for all
  using (meu_perfil() in ('PCP','Gestor'))
  with check (meu_perfil() in ('PCP','Gestor'));

-- ============================================================
-- Conferência
-- ============================================================
-- select perfil, acao, permitido from perfil_permissoes
--   where recurso = 'mapa' order by perfil, acao;
-- select policyname from pg_policies where tablename = 'cargas_montadas';
--   -- ler_cargas_mont, pcp_cargas_mont, log_fotos_cargas
