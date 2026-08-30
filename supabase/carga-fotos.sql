-- ============================================================
-- Carga montada: FOTOS da carga/placa — 30/08/2026
-- Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- O croqui de papel tem o quadro "Foto carga/placa" pra colar foto. No app,
-- a Balança fotografa a carga pronta e a placa pelo tablet e fica tudo no
-- registro digital da expedição — mesma receita das fotos da Qualidade
-- (bucket privado, redução a 1600 px no navegador, a linha guarda só o
-- caminho).
-- ============================================================

set search_path = tsi, public;

alter table cargas_montadas add column if not exists fotos text[] not null default '{}';

comment on column cargas_montadas.fotos is
  'Caminhos no bucket `cargas` do Storage — foto da carga pronta e da placa (até 4).';

alter table cargas_montadas drop constraint if exists carga_ate_4_fotos;
alter table cargas_montadas add constraint carga_ate_4_fotos
  check (array_length(fotos, 1) is null or array_length(fotos, 1) <= 4);

-- bucket privado: registro interno da expedição, não vai para a web aberta
insert into storage.buckets (id, name, public)
values ('cargas', 'cargas', false)
on conflict (id) do nothing;

-- leitura: qualquer usuário logado do TSI (PCP e Direção precisam ver)
drop policy if exists cargas_fotos_ler on storage.objects;
create policy cargas_fotos_ler on storage.objects for select
  using (bucket_id = 'cargas' and auth.uid() is not null);

-- gravação/remoção: quem monta carga (Balança, Logística, Gestor)
drop policy if exists cargas_fotos_gravar on storage.objects;
create policy cargas_fotos_gravar on storage.objects for insert
  with check (bucket_id = 'cargas' and tsi.tem_acao('mapa','montar_carga'));

drop policy if exists cargas_fotos_apagar on storage.objects;
create policy cargas_fotos_apagar on storage.objects for delete
  using (bucket_id = 'cargas' and tsi.tem_acao('mapa','montar_carga'));

-- ============================================================
-- Conferência
-- ============================================================
-- select column_name from information_schema.columns
--   where table_schema='tsi' and table_name='cargas_montadas' and column_name='fotos';
-- select id, public from storage.buckets where id = 'cargas';  -- public = false
