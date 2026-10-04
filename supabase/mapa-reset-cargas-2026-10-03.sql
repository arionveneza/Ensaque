-- ============================================================
-- Reset do MAPA, parte 2 (03/10/2026) — pedido do Arion: "delete cargas
-- antigas". Cargas montadas do app (não usadas desde 08/09) ainda podiam
-- mexer no mapa novo: marcar Carregada desconta bags, desfazer a Carregada
-- devolve (gatilho tg_carga_carregada_mapa). As 9 nunca carregadas já tinham
-- sido excluídas pela tela; resta a de 30/08 (carregada em 31/08, 3 itens).
--
-- Copia as três tabelas para o schema `arquivo` (fora da API), confere e só
-- então apaga. As filhas saem em cascata (FKs on delete cascade).
--
-- Desfazer (se precisar):
--   insert into tsi.cargas_montadas        select * from arquivo.cargas_montadas_20261003;
--   insert into tsi.carga_montada_produtos select * from arquivo.carga_montada_produtos_20261003;
--   insert into tsi.carga_montada_itens    select * from arquivo.carga_montada_itens_20261003;
-- ============================================================

begin;

create schema if not exists arquivo;
revoke all on schema arquivo from public;
revoke all on schema arquivo from anon, authenticated;

create table arquivo.cargas_montadas_20261003 as table tsi.cargas_montadas;
create table arquivo.carga_montada_produtos_20261003 as table tsi.carga_montada_produtos;
create table arquivo.carga_montada_itens_20261003 as table tsi.carga_montada_itens;

do $$
begin
  if (select count(*) from arquivo.cargas_montadas_20261003) <> (select count(*) from tsi.cargas_montadas)
  or (select count(*) from arquivo.carga_montada_produtos_20261003) <> (select count(*) from tsi.carga_montada_produtos)
  or (select count(*) from arquivo.carga_montada_itens_20261003) <> (select count(*) from tsi.carga_montada_itens) then
    raise exception 'cópia de segurança não bate com as tabelas — nada foi apagado';
  end if;
end $$;

-- delete não dispara o gatilho do mapa (ele é só "after update of carregada_em")
delete from tsi.carga_montada_itens;
delete from tsi.carga_montada_produtos;
delete from tsi.cargas_montadas;

commit;

select 'cargas_montadas (agora)' as item, count(*)::text as valor from tsi.cargas_montadas
union all select 'carga_montada_produtos (agora)', count(*)::text from tsi.carga_montada_produtos
union all select 'carga_montada_itens (agora)', count(*)::text from tsi.carga_montada_itens
union all select 'cópia: cargas', count(*)::text from arquivo.cargas_montadas_20261003
union all select 'cópia: itens', count(*)::text from arquivo.carga_montada_itens_20261003
union all select 'lotes_mapa (continua vazio)', count(*)::text from tsi.lotes_mapa;
