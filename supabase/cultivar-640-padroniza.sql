-- ============================================================
-- Padroniza o cultivar 640 (14/10/2026, pedido do Arion: "padronize, o 640
-- I2X, NEO 640, tudo que houver 640 é o mesmo cultivar e devem aparecer
-- para seleção na ordem de produção").
--
-- O SAP passou a exportar o cultivar como "O640 I2X" (a coluna CULTIVAR
-- truncada, como já acontecia com "O700 I2X" = NEO700 I2X), enquanto os
-- pedidos, as ordens e o mapa usam "640 I2X": os 7 lotes com saldo entraram
-- como "O640 I2X" e o formulário da ordem, que casa lote e cultivar por
-- texto, não mostrava nenhum lote pro "640 I2X" — e o balanço abria duas
-- linhas. O nome canônico é o dos pedidos, "640 I2X" (o de-para do
-- importador, CULTIVAR_DEPARA em simpleagro.ts, passa a levar O640/NEO640
-- pra ele). Aqui: o que já está gravado.
--
-- De quebra, grafias à mão do mapa que são o mesmo cultivar com outro
-- espaçamento/sufixo ("NEO 750 IPRO", "NEO 821 I2X", "O720 i2x"…).
-- ============================================================

set search_path = tsi, public;

create temp table tmp_depara (de text, para text) on commit drop;
insert into tmp_depara values
  ('O640 I2X', '640 I2X'), ('NEO640 I2X', '640 I2X'), ('NEO 640 I2X', '640 I2X'),
  ('NEO 750 IPRO', 'NEO750 IPRO'), ('NEO 821 I2X', 'NEO821 I2X'), ('NEO821', 'NEO821 I2X'),
  ('O720 i2x', 'O720 I2X'), ('O720 I2', 'O720 I2X'), ('O790', 'O790 IPRO'),
  ('76KA72 CE- STINE 76KA72', '76KA72');

-- antes (pra conferência)
create temp table tmp_antes on commit drop as
select 'lotes_semente' as tabela, l.cultivar, count(*) n from lotes_semente l join tmp_depara d on d.de = l.cultivar group by l.cultivar
union all select 'estoque_pa', e.cultivar, count(*) from estoque_pa e join tmp_depara d on d.de = e.cultivar group by e.cultivar
union all select 'lotes_mapa', m.cultivar, count(*) from lotes_mapa m join tmp_depara d on d.de = m.cultivar group by m.cultivar
union all select 'inventario_saldos', s.cultivar, count(*) from inventario_saldos s join tmp_depara d on d.de = s.cultivar group by s.cultivar
union all select 'inventario_itens', i.cultivar, count(*) from inventario_itens i join tmp_depara d on d.de = i.cultivar group by i.cultivar
union all select 'ordens', o.cultivar, count(*) from ordens o join tmp_depara d on d.de = o.cultivar group by o.cultivar;

update lotes_semente l set cultivar = d.para, atualizado_em = now() from tmp_depara d where d.de = l.cultivar;
update estoque_pa e set cultivar = d.para from tmp_depara d where d.de = e.cultivar;
update lotes_mapa m set cultivar = d.para, atualizado_em = now() from tmp_depara d where d.de = m.cultivar;
-- inventário fechado é registro (gatilho barra): só os abertos
update inventario_saldos s set cultivar = d.para from tmp_depara d
 where d.de = s.cultivar and exists (select 1 from inventarios i where i.id = s.inventario_id and i.fechado_em is null);
update inventario_itens i set cultivar = d.para from tmp_depara d
 where d.de = i.cultivar and exists (select 1 from inventarios v where v.id = i.inventario_id and v.fechado_em is null);
-- ordens: nenhuma com grafia diferente hoje; se houver, só as não apontadas
-- (o gatilho de imutabilidade barra as tocadas pela produção — e o nº já
-- foi pro AGROTIS)
update ordens o set cultivar = d.para from tmp_depara d
 where d.de = o.cultivar and o.status in ('Nao programada', 'Programada');

select json_build_object(
  'corrigidos', (select json_agg(json_build_object('tabela', tabela, 'de', cultivar, 'n', n) order by tabela, cultivar) from tmp_antes),
  'lotes_640_com_saldo', (select json_agg(json_build_object('id', id, 'cultivar', cultivar, 'bags', bags_disp) order by id) from tsi.lotes_semente where upper(cultivar) like '%%640%%' and bags_disp > 0),
  'cultivares_mapa', (select json_agg(c order by c) from (select distinct cultivar c from tsi.lotes_mapa where bags > 0) x),
  'restantes', (select json_agg(json_build_object('tabela', t, 'cultivar', c)) from (
     select 'lotes_semente' t, cultivar c from tsi.lotes_semente where cultivar in (select de from tmp_depara)
     union all select 'estoque_pa', cultivar from tsi.estoque_pa where cultivar in (select de from tmp_depara)
     union all select 'lotes_mapa', cultivar from tsi.lotes_mapa where cultivar in (select de from tmp_depara)) r)
) as conferencia;
