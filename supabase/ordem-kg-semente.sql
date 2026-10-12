-- ============================================================
-- Ordem tratada em KG de semente — lote em saco (12/10/2026, pedido do
-- Arion: "eu cadastro o lote em sacaria de 200k com peso de 38,8 kg, quero
-- tratar isso e jogar em BAG ou mostrar quantos kgs tratar, pra gerar a
-- receita certa"; decisão dele: tratar TUDO, em kg).
--
-- `ordens.bags` é inteiro e 35 sacos de 200 mil sementes são 1,4 BAG: a
-- DM1210 (2 BAGs) mandava receita para 1.910 kg com 1.337 kg de semente, a
-- DM1211 (1 BAG) para 970 kg com 582. Coluna nova `ordens.peso_semente_kg`:
-- nula = como sempre (bags × peso do bag da ordem); preenchida = os kg de
-- semente a tratar (sacos × peso do saco), e é ESSE peso que vale em todo
-- cálculo — `bags` fica só como as embalagens que saem.
--
-- Onde o peso da ordem é calculado no banco (varredura de pg_views/pg_proc
-- por fator_peso/peso_bag em 12/10): v_ordens (v_ordem_tempos, v_ordem_etapas
-- e a trava de salvar_carga_montada leem dela), baixar_lote (peso do
-- movimento) e fn_lote_tratado_no_mapa (branca consumida). As três foram
-- recriadas sobre a definição VIVA do banco (pg_get_viewdef/functiondef),
-- não sobre arquivo antigo — a regra da v_balanco_demanda. fn_ordem_imutavel
-- passa a travar a coluna depois que a produção toca a ordem (entra em
-- cálculo, como bags).
-- ============================================================

set search_path = tsi, public;

alter table ordens
  add column if not exists peso_semente_kg numeric(12,3);
alter table ordens drop constraint if exists ordens_peso_semente_positivo;
alter table ordens add constraint ordens_peso_semente_positivo
  check (peso_semente_kg is null or peso_semente_kg > 0);

comment on column ordens.peso_semente_kg is
  'kg de semente a tratar quando o lote está em saco (12/10/2026): sacos × peso do saco. Nulo = bags × peso do bag da ordem. Quando preenchido, é o peso de receita, tempo, ocupação e baixa; bags vira só as embalagens que saem.';

-- 1. v_ordens: peso_kg/peso_t pelos kg a tratar quando houver; coluna nova no FIM
create or replace view v_ordens as
 SELECT o.id,
    o.numero,
    o.cultivar,
    o.receita_id,
    o.embalagem,
    o.bags,
    o.lote_id,
    o.cliente,
    o.observacao,
    o.prioridade,
    o.prioridade_por,
    o.prioridade_em,
    o.maquina_id,
    o.data_prog,
    o.seq,
    o.turno_id,
    o.status,
    o.fim_pendente,
    o.origem,
    o.agrotis_num,
    o.agrotis_por,
    o.agrotis_em,
    o.criado_em,
    o.armazem,
    o.bloco,
    o.quadra,
    o.bags_produzidos,
    o.data_prog_original,
    o.reprogramacoes,
    o.reprogramada_em,
    o.lote_liberado_em,
    o.lote_liberado_por,
    o.confirmada_em,
    o.confirmada_por,
    o.fora_balanco,
    o.destinacao,
        CASE
            WHEN o.status = ANY (ARRAY['Em producao'::tsi.status_ordem, 'Parada'::tsi.status_ordem, 'Finalizada'::tsi.status_ordem, 'Qualidade apontada'::tsi.status_ordem, 'Apontada'::tsi.status_ordem]) THEN o.status::text
            WHEN o.maquina_id IS NULL THEN 'Nao programada'::text
            WHEN o.confirmada_em IS NULL THEN 'Programada'::text
            WHEN o.lote_liberado_em IS NULL THEN 'Aguardando lote'::text
            ELSE 'Pronto para produzir'::text
        END AS status_efetivo,
    ls.peso_bag_kg,
    ls.pms,
    COALESCE(NULLIF(e.peso_fixo_kg, 0::numeric), NULLIF(ls.pms * e.fator_peso, 0::numeric), ls.peso_bag_kg) AS peso_bag_ordem_kg,
    COALESCE(o.peso_semente_kg, o.bags::numeric * COALESCE(NULLIF(e.peso_fixo_kg, 0::numeric), NULLIF(ls.pms * e.fator_peso, 0::numeric), ls.peso_bag_kg)) AS peso_kg,
    COALESCE(o.peso_semente_kg, o.bags::numeric * COALESCE(NULLIF(e.peso_fixo_kg, 0::numeric), NULLIF(ls.pms * e.fator_peso, 0::numeric), ls.peso_bag_kg)) / 1000.0 AS peso_t,
    r.nome AS receita_nome,
    o.data_expedicao,
    pd.posicao AS prioridade_dia,
    o.peso_semente_kg
   FROM tsi.ordens o
     JOIN tsi.lotes_semente ls ON ls.id = o.lote_id
     JOIN tsi.embalagens e ON e.codigo = o.embalagem
     JOIN tsi.receitas r ON r.id = o.receita_id
     LEFT JOIN tsi.ordem_prioridades_dia pd ON pd.ordem_id = o.id;

-- create or replace view ZERA as reloptions: sem isto a view roda como dono
-- (bypassrls) e a chave anon lê a produção inteira (incidente de 12/09/2026)
alter view v_ordens set (security_invoker = true);

-- 2. baixar_lote: o peso do movimento pelos kg a tratar quando houver
CREATE OR REPLACE FUNCTION tsi.baixar_lote(p_lote text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tsi', 'public'
AS $function$
declare
  v_bags numeric;
  v_peso_t numeric;
begin
  if not pode_baixar_lote() then
    raise exception 'Perfil sem permissao para baixar lote';
  end if;

  with liberadas as (
    update tsi.ordens
       set lote_liberado_em = now(), lote_liberado_por = auth.uid()
     where lote_id = p_lote
       and lote_liberado_em is null
       and maquina_id is not null
       and confirmada_em is not null
       and status not in ('Em producao','Parada','Finalizada','Qualidade apontada','Apontada')
    returning bags, embalagem, peso_semente_kg
  )
  select
    coalesce(sum(l.bags), 0),
    coalesce(sum(coalesce(l.peso_semente_kg,
      l.bags * coalesce(nullif(e.peso_fixo_kg, 0), nullif(ls.pms * e.fator_peso, 0), ls.peso_bag_kg))), 0) / 1000.0
    into v_bags, v_peso_t
  from liberadas l
  join tsi.lotes_semente ls on ls.id = p_lote
  join tsi.embalagens e     on e.codigo = l.embalagem;

  if v_bags = 0 then
    raise exception 'Nao ha ordem confirmada deste lote esperando liberacao';
  end if;

  -- tg_baixa_so_pela_rpc (matriz-permissoes-no-banco.sql) recusa qualquer
  -- update de status/baixado_* em lotes_semente fora desta flag de sessao.
  perform set_config('tsi.baixa_via_rpc', '1', true);

  update tsi.lotes_semente
     set status = 'Baixado',
         baixado_por = coalesce(baixado_por, auth.uid()),
         baixado_em = coalesce(baixado_em, now())
   where id = p_lote;

  insert into tsi.lote_movimentos (lote_id, bags, peso_t, estorno, usuario_id)
  values (p_lote, v_bags, v_peso_t, false, auth.uid());
end $function$;

-- 3. fn_lote_tratado_no_mapa: a branca consumida pelos kg a tratar quando houver
CREATE OR REPLACE FUNCTION tsi.fn_lote_tratado_no_mapa()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tsi', 'public'
AS $function$
declare
  v_row      ordens%rowtype;
  v_entrando boolean;
  v_receita  text;
  v_ls       lotes_semente%rowtype;
  v_emb      embalagens%rowtype;
  v_peso     numeric;
  v_bags     numeric;
  v_kg       numeric;
  v_lote     text;
begin
  if new.status = 'Finalizada' and old.status is distinct from new.status then
    if exists (select 1 from ordem_mapa_lancado where ordem_id = new.id) then
      return new;  -- já entrou (idempotência)
    end if;
    v_entrando := true;
    v_row := new;
  elsif old.status = 'Finalizada' and new.status in ('Em producao', 'Parada') then
    if not exists (select 1 from ordem_mapa_lancado where ordem_id = old.id) then
      return new;  -- nunca entrou (ex.: receita SEM TSI) — nada a reverter
    end if;
    -- Voltar para produção: reverte com os valores de QUANDO entrou
    v_entrando := false;
    v_row := old;
  else
    return new;
  end if;

  select nome into v_receita from receitas where id = v_row.receita_id;
  -- ensaque sem tratamento não cria tratado nem desconta branca no mapa
  if v_receita is null or upper(trim(v_receita)) = 'SEM TSI' then
    return new;
  end if;

  select * into v_ls from lotes_semente where id = v_row.lote_id;
  if not found then
    return new;
  end if;
  select * into v_emb from embalagens where codigo = v_row.embalagem;
  -- o mapa é por número BASE (os sufixos -1/-2 do SAP morrem na entrada)
  v_lote := regexp_replace(upper(btrim(v_row.lote_id)), '(-\d+)+$', '');

  -- peso do bag DA ORDEM: peso fixo → pms × fator → peso do lote
  v_peso := coalesce(
    nullif(v_emb.peso_fixo_kg, 0),
    v_ls.pms * v_emb.fator_peso,
    v_ls.peso_bag_kg,
    0
  );
  v_bags := coalesce(v_row.bags_produzidos, v_row.bags);
  -- semente consumida: os kg a tratar quando a ordem é em kg (lote em saco,
  -- 12/10/2026); senão as embalagens produzidas × peso do bag, como sempre
  v_kg := coalesce(v_row.peso_semente_kg, v_bags * v_peso);

  if v_entrando then
    -- 1. o TRATADO produzido entra no mapa (lote base + tratamento);
    --    embalagem diferente soma CONVERTIDA pelo peso do bag
    insert into lotes_mapa
      (lote, tratamento, cultivar, embalagem, pms, peso_bag_kg, bags,
       destinacao, classificacao, peneira, categoria, atualizado_em)
    values
      (v_lote, v_receita, v_ls.cultivar, v_row.embalagem, v_ls.pms,
       v_peso, v_bags, null, null, v_ls.peneira, v_ls.categoria, now())
    on conflict (lote, tratamento) do update
      set bags = lotes_mapa.bags
               + case
                   when coalesce(lotes_mapa.peso_bag_kg, 0) > 0
                    and coalesce(excluded.peso_bag_kg, 0) > 0
                    and lotes_mapa.peso_bag_kg <> excluded.peso_bag_kg
                   then excluded.bags * excluded.peso_bag_kg / lotes_mapa.peso_bag_kg
                   else excluded.bags
                 end,
          atualizado_em = now();

    -- 2. a BRANCA consumida sai do mapa (em bags DO LOTE), sem clamp
    if v_ls.peso_bag_kg > 0 and v_kg > 0 then
      update lotes_mapa
         set bags = bags - (v_kg / v_ls.peso_bag_kg),
             atualizado_em = now()
       where lote = v_lote and tratamento = 'SEM TSI';
    end if;

    insert into ordem_mapa_lancado (ordem_id) values (v_row.id)
    on conflict (ordem_id) do nothing;
  else
    -- desfazer: tratado devolve, branca volta — espelho exato da entrada
    update lotes_mapa
       set bags = bags
               - case
                   when coalesce(peso_bag_kg, 0) > 0 and v_peso > 0
                    and peso_bag_kg <> v_peso
                   then v_bags * v_peso / peso_bag_kg
                   else v_bags
                 end,
           atualizado_em = now()
     where lote = v_lote and tratamento = v_receita;

    if v_ls.peso_bag_kg > 0 and v_kg > 0 then
      update lotes_mapa
         set bags = bags + (v_kg / v_ls.peso_bag_kg),
             atualizado_em = now()
       where lote = v_lote and tratamento = 'SEM TSI';
    end if;

    delete from ordem_mapa_lancado where ordem_id = v_row.id;
  end if;

  return new;
end $function$;

-- 4. fn_ordem_imutavel: os kg a tratar entram em cálculo — travam como bags
CREATE OR REPLACE FUNCTION tsi.fn_ordem_imutavel()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'tsi', 'public'
AS $function$
begin
  if old.status in ('Em producao','Parada','Finalizada','Qualidade apontada','Apontada','Excluida') then
    if tg_op = 'DELETE' then
      raise exception 'Ordem % nao pode ser excluida (status %)', old.numero, old.status;
    end if;
    if new.cultivar <> old.cultivar or new.receita_id <> old.receita_id
       or new.embalagem <> old.embalagem or new.bags <> old.bags
       or new.peso_semente_kg is distinct from old.peso_semente_kg
       or new.lote_id <> old.lote_id or new.maquina_id is distinct from old.maquina_id
       or new.data_prog is distinct from old.data_prog then
      raise exception 'Ordem % em andamento/finalizada nao pode ser editada', old.numero;
    end if;
    if old.status in ('Apontada','Excluida') and new.numero is distinct from old.numero then
      raise exception 'Ordem % (status %) nao pode ter o numero corrigido', old.numero, old.status;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $function$;

-- Conferência
select json_build_object(
  'coluna', (select count(*) from information_schema.columns
              where table_schema = 'tsi' and table_name = 'ordens' and column_name = 'peso_semente_kg'),
  'view_tem_coluna', (select count(*) from information_schema.columns
              where table_schema = 'tsi' and table_name = 'v_ordens' and column_name = 'peso_semente_kg'),
  'security_invoker', (select coalesce(reloptions::text, '') like '%security_invoker=true%'
                        from pg_class where oid = 'tsi.v_ordens'::regclass),
  'baixa_usa_kg', (select position('peso_semente_kg' in pg_get_functiondef('tsi.baixar_lote(text)'::regprocedure)) > 0),
  'mapa_usa_kg', (select position('peso_semente_kg' in pg_get_functiondef('tsi.fn_lote_tratado_no_mapa()'::regprocedure)) > 0),
  'imutavel_trava', (select position('peso_semente_kg' in pg_get_functiondef('tsi.fn_ordem_imutavel()'::regprocedure)) > 0),
  -- nenhuma ordem existente muda de peso (a coluna nasce nula)
  'ordens_com_kg', (select count(*) from tsi.ordens where peso_semente_kg is not null)
) as conferencia;
