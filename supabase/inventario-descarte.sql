-- ============================================================
-- Inventário: lançamento fora da lista pode ser DESCARTE, e tem observações
-- (04/10/2026, pedido do Arion: "quando não estiver na lista do SAP e o
-- operador clicar em Não está na lista, abrir uma caixa para ele informar
-- que é DESCARTE e também um campo de OBSERVAÇÕES").
--
-- No mapa (inventário que monta o mapa), o descarte entra como qualquer
-- contagem — ocupa lugar no galpão e a Logística precisa achá-lo para tirar —,
-- mas com DESTINAÇÃO = 'DESCARTE': o mapa já pinta de vermelho e avisa forte
-- no loteamento de carga todo lote com destinação, então ninguém carrega
-- descarte por engano. Desmarcar/excluir o último lançamento de descarte da
-- combinação devolve a destinação que o SAP tinha (ou nenhuma).
--
-- Base das funções: inventario-implantacao-mapa.sql (a versão vigente); só
-- os trechos de descarte são novos.
-- ============================================================

alter table tsi.inventario_itens
  add column if not exists descarte boolean not null default false,
  add column if not exists observacao text;

create or replace function tsi.inventario_mapa_tira(i tsi.inventario_itens)
returns void
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_lote text := regexp_replace(upper(btrim(i.lote)), '(-\d+)+$', '');
  v_trat text := upper(btrim(i.tratamento));
  v_lm   lotes_mapa%rowtype;
  v_peso numeric;
  v_qtd  numeric;
begin
  -- era o último descarte da combinação neste inventário: a destinação
  -- volta à do SAP (o poe do mesmo UPDATE remarca se continuar descarte)
  if i.descarte and not exists (
       select 1 from inventario_itens x
        where x.inventario_id = i.inventario_id and x.id <> i.id and x.descarte
          and regexp_replace(upper(btrim(x.lote)), '(-\d+)+$', '') = v_lote
          and upper(btrim(x.tratamento)) = v_trat) then
    update lotes_mapa
       set destinacao = (select s.destinacao from inventario_saldos s
                          where s.inventario_id = i.inventario_id and s.lote = v_lote
                            and s.tratamento = v_trat and s.destinacao is not null limit 1),
           atualizado_em = now()
     where lote = v_lote and tratamento = v_trat and destinacao = 'DESCARTE';
  end if;

  if coalesce(i.bags, 0) <= 0 then
    return;
  end if;
  select * into v_lm from lotes_mapa where lote = v_lote and tratamento = v_trat for update;
  if not found then
    return;
  end if;

  -- embalagem diferente da linha do mapa: converte pelo peso (igual à produção)
  v_peso := inventario_item_peso(i.inventario_id, v_lote, v_trat, upper(btrim(i.embalagem)));
  v_qtd := case when v_lm.peso_bag_kg > 0 and v_peso > 0 and v_lm.peso_bag_kg <> v_peso
                then round(i.bags * v_peso / v_lm.peso_bag_kg, 3) else i.bags end;

  update lotes_mapa set bags = greatest(bags - v_qtd, 0), atualizado_em = now()
   where lote = v_lote and tratamento = v_trat;

  if i.armazem is not null and i.bloco is not null and i.quadra is not null then
    delete from lote_enderecos
     where lote = v_lote and tratamento = v_trat
       and armazem = i.armazem and bloco = i.bloco and quadra = i.quadra
       and bags is not null and bags <= v_qtd + 0.0001;
    update lote_enderecos set bags = bags - v_qtd
     where lote = v_lote and tratamento = v_trat
       and armazem = i.armazem and bloco = i.bloco and quadra = i.quadra
       and bags is not null and bags > v_qtd + 0.0001;
  end if;
end $$;

create or replace function tsi.inventario_mapa_poe(i tsi.inventario_itens)
returns void
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_lote  text := regexp_replace(upper(btrim(i.lote)), '(-\d+)+$', '');
  v_trat  text := upper(btrim(i.tratamento));
  v_emb   text := upper(btrim(i.embalagem));
  v_lm    lotes_mapa%rowtype;
  v_s     inventario_saldos%rowtype;
  v_ls    lotes_semente%rowtype;
  v_peso  numeric;
  v_qtd   numeric;
  v_primeira boolean;
begin
  if coalesce(i.bags, 0) > 0
     and (i.armazem is null or i.bloco is null or i.quadra is null) then
    raise exception 'informe armazém, bloco e quadra — a contagem vai para o mapa';
  end if;

  v_peso := inventario_item_peso(i.inventario_id, v_lote, v_trat, v_emb);

  -- 1ª contagem desta combinação neste inventário?
  insert into inventario_mapa_assumido (inventario_id, lote, tratamento, bags_antes)
  values (i.inventario_id, v_lote, v_trat,
          (select bags from lotes_mapa where lote = v_lote and tratamento = v_trat))
  on conflict do nothing;
  v_primeira := found;

  select * into v_lm from lotes_mapa where lote = v_lote and tratamento = v_trat for update;
  if not found then
    if coalesce(i.bags, 0) <= 0 then
      return;  -- contou zero de lote que nem existe no mapa: nada a criar
    end if;
    -- o lote NASCE no mapa: dados do saldo do SAP do inventário (mesma
    -- embalagem primeiro), senão do lote de semente
    select * into v_s from inventario_saldos s
     where s.inventario_id = i.inventario_id and s.lote = v_lote and s.tratamento = v_trat
     order by (s.embalagem = v_emb) desc limit 1;
    select * into v_ls from lotes_semente l
     where regexp_replace(upper(btrim(l.id)), '(-\d+)+$', '') = v_lote
     order by l.atualizado_em desc nulls last limit 1;

    insert into lotes_mapa
      (lote, tratamento, cultivar, embalagem, pms, peso_bag_kg, bags,
       destinacao, classificacao, peneira, categoria, atualizado_em)
    values
      (v_lote, v_trat,
       coalesce(nullif(btrim(i.cultivar), ''), v_s.cultivar, v_ls.cultivar, ''),
       v_emb,
       coalesce(v_s.pms, (select s.pms from inventario_saldos s
                           where s.inventario_id = i.inventario_id and s.lote = v_lote
                             and s.pms > 0 limit 1), nullif(v_ls.pms, 0)),
       v_peso, i.bags,
       case when i.descarte then 'DESCARTE' else v_s.destinacao end,
       v_s.classificacao,
       coalesce(v_s.peneira, v_ls.peneira), coalesce(v_s.categoria, v_ls.categoria),
       now());
  else
    v_qtd := case when v_lm.peso_bag_kg > 0 and v_peso > 0 and v_lm.peso_bag_kg <> v_peso
                  then round(i.bags * v_peso / v_lm.peso_bag_kg, 3) else i.bags end;
    if v_primeira then
      -- a contagem é a verdade agora: saldo e endereços passam a ser os dela
      delete from lote_enderecos where lote = v_lote and tratamento = v_trat;
      update lotes_mapa
         set bags = v_qtd,
             peso_bag_kg = case when peso_bag_kg > 0 then peso_bag_kg else v_peso end,
             nao_encontrado_inventario_em = null,
             atualizado_em = now()
       where lote = v_lote and tratamento = v_trat;
    else
      update lotes_mapa
         set bags = bags + v_qtd,
             nao_encontrado_inventario_em = null,
             atualizado_em = now()
       where lote = v_lote and tratamento = v_trat;
    end if;
    if i.descarte then
      update lotes_mapa set destinacao = 'DESCARTE'
       where lote = v_lote and tratamento = v_trat;
    end if;
    i.bags := v_qtd;  -- endereço na unidade da linha do mapa
  end if;

  if coalesce(i.bags, 0) > 0 then
    insert into lote_enderecos (lote, tratamento, armazem, bloco, quadra, bags, criado_por)
    values (v_lote, v_trat, i.armazem, i.bloco, i.quadra, i.bags, coalesce(auth.uid(), i.criado_por))
    on conflict (lote, tratamento, armazem, bloco, quadra)
    do update set bags = coalesce(lote_enderecos.bags, 0) + excluded.bags;
  end if;
end $$;

revoke execute on function tsi.inventario_mapa_poe(tsi.inventario_itens) from public, anon, authenticated;
revoke execute on function tsi.inventario_mapa_tira(tsi.inventario_itens) from public, anon, authenticated;

-- ------------------------------------------------------------
-- Conferência numa transação à parte, desfeita (ver o script de teste da
-- sessão): aqui só confirma as colunas.
-- ------------------------------------------------------------
select json_build_object(
  'colunas', (select json_agg(column_name || ':' || data_type || ':' || coalesce(column_default, ''))
                from information_schema.columns
               where table_schema = 'tsi' and table_name = 'inventario_itens'
                 and column_name in ('descarte', 'observacao'))
) as conferencia;
