-- ============================================================
-- Reset do MAPA (03/10/2026) — pedido do Arion: "eu preciso apagar todos
-- os lotes do mapa, iremos fazer inventário e endereçar os lotes novamente".
--
-- O mapa estava 67% acima do SAP (16.829 × 10.087 bags em 02/10): a carga
-- feita pela SimpleAgro nunca dava baixa e 379 combinações zeradas no SAP
-- seguiam no mapa com endereço. Recomeça do zero com inventário + endereço.
--
-- Antes de apagar, COPIA as duas tabelas para o schema `arquivo` (fora da
-- API do app: o PostgREST só expõe public/tsi) e confere a cópia; se a
-- contagem não bater, nada é apagado. Tudo numa transação só.
--
-- NÃO mexe em: ordem_mapa_lancado (ordem já lançada não entra de novo),
-- cargas_montadas/itens, inventários, mapa_ajustes (vazio).
--
-- Desfazer (se precisar):
--   insert into tsi.lotes_mapa select * from arquivo.lotes_mapa_20261003;
--   insert into tsi.lote_enderecos select * from arquivo.lote_enderecos_20261003;
-- ============================================================

begin;

create schema if not exists arquivo;
revoke all on schema arquivo from public;
revoke all on schema arquivo from anon, authenticated;

create table arquivo.lotes_mapa_20261003 as table tsi.lotes_mapa;
create table arquivo.lote_enderecos_20261003 as table tsi.lote_enderecos;

do $$
begin
  if (select count(*) from arquivo.lotes_mapa_20261003) <> (select count(*) from tsi.lotes_mapa)
  or (select count(*) from arquivo.lote_enderecos_20261003) <> (select count(*) from tsi.lote_enderecos) then
    raise exception 'cópia de segurança não bate com as tabelas — nada foi apagado';
  end if;
end $$;

-- endereços primeiro (a FK já apagaria em cascata, mas assim fica explícito)
delete from tsi.lote_enderecos;
delete from tsi.lotes_mapa;

commit;

-- ============================================================
-- Conferência: mapa vazio, cópia guardada
-- ============================================================
select 'lotes_mapa (agora)' as item, count(*)::text as valor from tsi.lotes_mapa
union all select 'lote_enderecos (agora)', count(*)::text from tsi.lote_enderecos
union all select 'cópia: lotes_mapa', count(*)::text from arquivo.lotes_mapa_20261003
union all select 'cópia: soma de bags (> 0)', coalesce(sum(bags), 0)::text from arquivo.lotes_mapa_20261003 where bags > 0
union all select 'cópia: lote_enderecos', count(*)::text from arquivo.lote_enderecos_20261003
union all select 'schema arquivo acessível ao app (anon)', has_schema_privilege('anon', 'arquivo', 'usage')::text
union all select 'schema arquivo acessível ao app (authenticated)', has_schema_privilege('authenticated', 'arquivo', 'usage')::text;
