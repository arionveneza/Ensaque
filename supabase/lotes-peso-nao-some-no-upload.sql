-- ============================================================
-- Upload do SAP sem PMS/Peso Bruto não apaga o peso que o lote já tinha
-- (14/10/2026, achado do Arion: "o lote final CB024 está sem o peso").
--
-- O MS19K05B3CB024 (71KA72, 15 bg) entrou em 12/10 com PMS 118 (a ordem
-- FAZENDA VENEZA01 foi pro mapa com 590 kg/bag), e o upload de 13/10 veio
-- com a coluna PMS vazia e sem Peso Bruto pra ele: `importar_lotes_semente`
-- fazia `pms = excluded.pms` no conflito e sobrescreveu o peso bom por
-- vazio — a ordem passou a 0 t e a ficha a 0 kg. Mais 11 lotes com saldo
-- perderam o peso do mesmo jeito (NEO751 CE 26B65C0162/0163, que eram
-- manuais com 770/950 kg, o CB189 do 73KA72, os NEO821 61526763P…).
--
-- 1. No conflito, PMS e peso do SAP só entram quando VÊM: vazio/zero mantém
--    o que o lote já tinha (o lote manual assumido pelo SAP também não
--    perde mais o peso digitado). SAP com valor continua mandando.
-- 2. Devolve o peso dos lotes com saldo que o mapa ainda guarda: a linha
--    tratada (pms/peso copiados do lote no dia do apontamento) ou a branca
--    com peso (pms = peso ÷ fator da embalagem). Sem fonte, fica como está
--    — corrige-se na tela Cadastros ▸ Lotes ("corrigir peso").
-- ============================================================

set search_path = tsi, public;

-- ---------- 1. importador: vazio não apaga (base: definição viva) ----------
CREATE OR REPLACE FUNCTION tsi.importar_lotes_semente(p_lotes jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tsi', 'public'
AS $function$
declare
  v_ids text[];
  v_importados integer;
  v_zerados integer;
  v_assumidos integer;
begin
  -- mesma regra das policies de INSERT/UPDATE de lotes_semente
  if not (tem_acao('ordens','criar') or tem_acao('cadastros','editar')) then
    raise exception 'Perfil sem permissão para importar lotes';
  end if;
  if p_lotes is null or jsonb_array_length(p_lotes) = 0 then
    raise exception 'planilha sem lote nenhum — nada foi importado (evita zerar tudo por engano)';
  end if;

  select array_agg(x.id) into v_ids
    from jsonb_to_recordset(p_lotes) as x(id text);

  -- lote avulso/manual que o SAP passou a trazer: vira lote do SAP (12/10/2026)
  select count(*) into v_assumidos
    from lotes_semente
   where origem_manual and id = any(v_ids);

  insert into lotes_semente
    (id, cultivar, tratamento, pms, peso_bag_kg, bags_disp, peneira, categoria, atualizado_em)
  select
    x.id, x.cultivar, x.tratamento, nullif(x.pms, 0), coalesce(x.peso_bag_kg, 0), x.bags_disp,
    x.peneira, x.categoria, now()
    from jsonb_to_recordset(p_lotes) as x(
      id text, cultivar text, tratamento text, pms numeric,
      peso_bag_kg numeric, bags_disp numeric, peneira text, categoria text
    )
  on conflict (id) do update
     set cultivar      = excluded.cultivar,
         tratamento    = excluded.tratamento,
         -- PMS/peso vazios no SAP não apagam o que o lote já tinha (14/10/2026)
         pms           = coalesce(nullif(excluded.pms, 0), lotes_semente.pms),
         peso_bag_kg   = case when coalesce(excluded.peso_bag_kg, 0) > 0
                              then excluded.peso_bag_kg else lotes_semente.peso_bag_kg end,
         bags_disp     = excluded.bags_disp,
         peneira       = excluded.peneira,
         categoria     = excluded.categoria,
         origem_manual = false,
         atualizado_em = now();
  get diagnostics v_importados = row_count;

  -- sumiu da planilha nova: zera o saldo mostrado (preserva a linha,
  -- status e histórico); lote manual/avulso nunca é tocado aqui
  update lotes_semente
     set bags_disp = 0, atualizado_em = now()
   where origem_manual = false
     and coalesce(bags_disp, 0) <> 0
     and not (id = any(v_ids));
  get diagnostics v_zerados = row_count;

  return jsonb_build_object('importados', v_importados, 'zerados', v_zerados, 'assumidos', v_assumidos);
end $function$;

-- ---------- 2. devolve o peso que o mapa ainda guarda ----------
-- fonte por lote (número BASE): a combinação do mapa com pms > 0; senão a com
-- peso > 0 em embalagem conhecida, pms = peso ÷ fator
create temp table tmp_peso_fonte on commit drop as
select ls.id,
       coalesce(
         (select m.pms from lotes_mapa m
           where m.lote = regexp_replace(upper(btrim(ls.id)), '(-\d+)+$', '') and m.pms > 0
           order by m.atualizado_em desc limit 1),
         (select m.peso_bag_kg / e.fator_peso from lotes_mapa m
             join embalagens e on e.codigo = m.embalagem and e.fator_peso > 0
           where m.lote = regexp_replace(upper(btrim(ls.id)), '(-\d+)+$', '') and m.peso_bag_kg > 0
           order by m.atualizado_em desc limit 1)
       ) as pms,
       coalesce(
         (select m.peso_bag_kg from lotes_mapa m
           where m.lote = regexp_replace(upper(btrim(ls.id)), '(-\d+)+$', '') and m.pms > 0
           order by m.atualizado_em desc limit 1),
         (select m.peso_bag_kg from lotes_mapa m
             join embalagens e on e.codigo = m.embalagem and e.fator_peso > 0
           where m.lote = regexp_replace(upper(btrim(ls.id)), '(-\d+)+$', '') and m.peso_bag_kg > 0
           order by m.atualizado_em desc limit 1)
       ) as peso
  from lotes_semente ls
 where (ls.pms is null or ls.pms = 0) and coalesce(ls.peso_bag_kg, 0) = 0
   and coalesce(ls.bags_disp, 0) > 0;

update lotes_semente ls
   set pms = round(f.pms, 3), peso_bag_kg = f.peso, atualizado_em = now()
  from tmp_peso_fonte f
 where f.id = ls.id and f.pms > 0 and f.pms < 1000 and f.peso > 0;

-- Conferência
select json_build_object(
  'importador_preserva', position('coalesce(nullif(excluded.pms, 0), lotes_semente.pms)' in pg_get_functiondef('tsi.importar_lotes_semente(jsonb)'::regprocedure)) > 0,
  'devolvidos', (select json_agg(json_build_object('id', f.id, 'pms', round(f.pms, 1), 'peso', f.peso) order by f.id) from tmp_peso_fonte f where f.pms > 0 and f.pms < 1000 and f.peso > 0),
  'ainda_sem_peso_com_saldo', (select json_agg(json_build_object('id', l.id, 'cultivar', l.cultivar, 'bags', l.bags_disp) order by l.id) from tsi.lotes_semente l where (l.pms is null or l.pms = 0) and coalesce(l.peso_bag_kg, 0) = 0 and l.bags_disp > 0),
  'cb024', (select json_build_object('pms', pms, 'peso', peso_bag_kg) from tsi.lotes_semente where id = 'MS19K05B3CB024'),
  'ordem_cb024_peso_kg', (select peso_kg from tsi.v_ordens where lote_id = 'MS19K05B3CB024' limit 1)
) as conferencia;
