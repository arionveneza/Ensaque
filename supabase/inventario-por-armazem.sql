-- ============================================================
-- Inventário POR ARMAZÉM e esvaziar armazém no mapa (13/10/2026, pedido do
-- Arion: "preciso habilitar o inventário por armazém e também a opção de
-- deletar todos os lotes de um armazém"). Decisões dele: a referência do
-- inventário de um armazém é O QUE O MAPA TEM NAQUELE ARMAZÉM (não o SAP,
-- que não diz o armazém); o esvaziar fica no Mapa, no cabeçalho do armazém.
--
-- 1. inventarios.armazem (A–E; nulo = galpão inteiro, como sempre). Exige
--    alimenta_mapa (a lista é o mapa e a contagem volta pro mapa). Não muda
--    depois que há contagem — a mesma trava do alimenta_mapa.
-- 2. inventario_itens.armazem tem de ser o do inventário (gatilho).
-- 3. inserir_mapa_no_inventario(p_id): a lista (inventario_saldos) nasce do
--    mapa — uma linha por combinação endereçada no armazém, com os bags que
--    o mapa tem LÁ. O upload do SAP é recusado nesse inventário.
-- 4. inventario_mapa_poe (base: definição VIVA, pg_get_functiondef — a de
--    inventario-descarte.sql): a 1ª contagem de uma combinação num inventário
--    de armazém SÓ substitui os endereços daquele armazém e o saldo vira
--    (o que o mapa tem nos OUTROS armazéns) + contado. Hoje ela apagava TODOS
--    os endereços e o saldo virava só o contado — um lote em A e E contado no
--    inventário de E perderia o A. Galpão inteiro continua como era.
-- 5. esvaziar_armazem_mapa(p_armazem, p_motivo): tira todos os endereços do
--    armazém e desconta dos lotes o que estava lá (lote que só estava lá fica
--    zerado, como o excluir_lote_mapa); rastro em mapa_ajustes por combinação.
--    Não mexe no inventário (registro).
-- ============================================================

set search_path = tsi, public;

-- ---------- 1. coluna ----------
alter table inventarios add column if not exists armazem text;
alter table inventarios drop constraint if exists inventarios_armazem_valido;
alter table inventarios add constraint inventarios_armazem_valido
  check (armazem is null or armazem in ('A','B','C','D','E'));
alter table inventarios drop constraint if exists inventarios_armazem_alimenta;
alter table inventarios add constraint inventarios_armazem_alimenta
  check (armazem is null or alimenta_mapa);

comment on column inventarios.armazem is
  'Inventário de UM armazém (13/10/2026): a lista vem do mapa daquele armazém, a contagem só aceita esse armazém e a 1ª contagem só substitui os endereços dele. Nulo = galpão inteiro.';

-- ligar/desligar alimenta_mapa OU trocar o armazém com contagem lançada
-- desalinha mapa e inventário: só na criação
create or replace function tsi.fn_inventario_alimenta_fixo()
returns trigger
language plpgsql security definer set search_path = tsi, public as $$
begin
  if (new.alimenta_mapa is distinct from old.alimenta_mapa
      or new.armazem is distinct from old.armazem)
     and coalesce(current_setting('tsi.rpc_inventario', true), '') <> '1'
     and exists (select 1 from inventario_itens where inventario_id = new.id) then
    raise exception 'o inventário já tem contagem — não dá pra mudar o armazém nem se ele alimenta o mapa';
  end if;
  return new;
end $$;

-- ---------- 2. a contagem é do armazém do inventário ----------
create or replace function tsi.fn_inventario_item_armazem()
returns trigger
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_arm text;
begin
  select armazem into v_arm from inventarios where id = new.inventario_id;
  if v_arm is not null and upper(btrim(coalesce(new.armazem, ''))) <> v_arm then
    raise exception 'este inventário é só do armazém % — o lançamento veio com armazém "%"',
      v_arm, coalesce(new.armazem, '');
  end if;
  return new;
end $$;

drop trigger if exists tg_inventario_item_armazem on inventario_itens;
create trigger tg_inventario_item_armazem
  before insert or update on inventario_itens
  for each row execute function tsi.fn_inventario_item_armazem();

-- ---------- 3. a lista vem do mapa do armazém ----------
-- Bags da combinação NO armazém: a soma dos endereços de lá; se algum
-- endereço de lá está sem quantidade, o que o mapa não consegue pôr em
-- outro armazém (saldo − bags conhecidos fora daqui).
create or replace function tsi.inserir_mapa_no_inventario(p_id uuid)
returns integer
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_arm text;
  v_qtd integer;
begin
  if not tem_acao('inventario','abrir') then
    raise exception 'Perfil sem permissão para inserir a lista do inventário';
  end if;
  select armazem into v_arm from inventarios
   where id = p_id and fechado_em is null for update;
  if not found then
    raise exception 'inventário não encontrado ou já fechado';
  end if;
  if v_arm is null then
    raise exception 'este inventário é do galpão inteiro — a lista dele é a planilha do SAP';
  end if;

  delete from inventario_saldos where inventario_id = p_id;

  insert into inventario_saldos (inventario_id, lote, tratamento, cultivar, embalagem, bags,
                                 pms, peso_bag_kg, destinacao, classificacao, peneira, categoria)
  select p_id, m.lote, m.tratamento, coalesce(m.cultivar, ''), m.embalagem,
         case when bool_and(e.bags is not null) then sum(e.bags)
              else greatest(m.bags - coalesce((select sum(o.bags) from lote_enderecos o
                                                where o.lote = m.lote and o.tratamento = m.tratamento
                                                  and o.armazem <> v_arm), 0), 0)
         end,
         m.pms, m.peso_bag_kg, m.destinacao, m.classificacao, m.peneira, m.categoria
    from lotes_mapa m
    join lote_enderecos e on e.lote = m.lote and e.tratamento = m.tratamento
   where e.armazem = v_arm and m.bags > 0
   group by m.lote, m.tratamento, m.cultivar, m.embalagem, m.bags, m.pms, m.peso_bag_kg,
            m.destinacao, m.classificacao, m.peneira, m.categoria;

  get diagnostics v_qtd = row_count;
  return v_qtd;
end $$;

revoke execute on function tsi.inserir_mapa_no_inventario(uuid) from public, anon;
grant execute on function tsi.inserir_mapa_no_inventario(uuid) to authenticated, service_role;

-- o upload do SAP não serve ao inventário de armazém (base: definição viva)
CREATE OR REPLACE FUNCTION tsi.substituir_saldos_inventario(p_id uuid, p_saldos jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'tsi', 'public'
AS $function$
declare
  v_qtd integer;
  v_arm text;
begin
  select armazem into v_arm from inventarios where id = p_id and fechado_em is null for update;
  if not found then
    raise exception 'inventário não encontrado, sem permissão ou já fechado';
  end if;
  if v_arm is not null then
    raise exception 'inventário do armazém %: a lista vem do mapa (botão "Inserir o mapa do armazém"), não do SAP', v_arm;
  end if;

  delete from inventario_saldos where inventario_id = p_id;

  insert into inventario_saldos (inventario_id, lote, tratamento, cultivar, embalagem, bags,
                                 pms, peso_bag_kg, destinacao, classificacao, peneira, categoria)
  select p_id,
         upper(btrim(s->>'lote')),
         upper(btrim(s->>'tratamento')),
         btrim(s->>'cultivar'),
         upper(btrim(s->>'embalagem')),
         (s->>'bags')::numeric,
         nullif(s->>'pms', '')::numeric,
         nullif(s->>'peso_bag_kg', '')::numeric,
         nullif(btrim(s->>'destinacao'), ''),
         nullif(btrim(s->>'classificacao'), ''),
         nullif(btrim(s->>'peneira'), ''),
         nullif(btrim(s->>'categoria'), '')
    from jsonb_array_elements(coalesce(p_saldos, '[]'::jsonb)) s;

  get diagnostics v_qtd = row_count;
  return v_qtd;
end $function$;

-- ---------- 4. 1ª contagem restrita ao armazém (base: definição viva) ----------
CREATE OR REPLACE FUNCTION tsi.inventario_mapa_poe(i tsi.inventario_itens)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tsi', 'public'
AS $function$
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
  v_arm   text;
  v_fora  numeric;
begin
  if coalesce(i.bags, 0) > 0
     and (i.armazem is null or i.bloco is null or i.quadra is null) then
    raise exception 'informe armazém, bloco e quadra — a contagem vai para o mapa';
  end if;

  select armazem into v_arm from inventarios where id = i.inventario_id;
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
    if v_primeira and v_arm is not null then
      -- inventário de UM armazém (13/10/2026): a contagem é a verdade só
      -- deste armazém. O que o mapa sabe que está nos OUTROS fica: soma dos
      -- endereços de fora (se algum está sem quantidade, o que o mapa não
      -- consegue pôr aqui: saldo − bags conhecidos daqui).
      select case when bool_and(o.bags is not null) then coalesce(sum(o.bags), 0)
                  else greatest(v_lm.bags - coalesce((select sum(a.bags) from lote_enderecos a
                                                        where a.lote = v_lote and a.tratamento = v_trat
                                                          and a.armazem = v_arm), 0), 0)
             end
        into v_fora
        from lote_enderecos o
       where o.lote = v_lote and o.tratamento = v_trat and o.armazem <> v_arm;
      v_fora := coalesce(v_fora, 0);
      delete from lote_enderecos where lote = v_lote and tratamento = v_trat and armazem = v_arm;
      update lotes_mapa
         set bags = v_fora + v_qtd,
             peso_bag_kg = case when peso_bag_kg > 0 then peso_bag_kg else v_peso end,
             nao_encontrado_inventario_em = null,
             atualizado_em = now()
       where lote = v_lote and tratamento = v_trat;
    elsif v_primeira then
      -- galpão inteiro: a contagem é a verdade — saldo e endereços passam a ser os dela
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
end $function$;

-- ---------- 5. esvaziar um armazém do mapa ----------
create or replace function tsi.esvaziar_armazem_mapa(p_armazem text, p_motivo text)
returns jsonb
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_arm text := upper(btrim(coalesce(p_armazem, '')));
  r record;
  v_novo numeric;
  v_combinacoes integer := 0;
  v_zerados integer := 0;
  v_retirados numeric := 0;
  v_aqui numeric;
  v_fora numeric;
  v_fora_desconhecido boolean;
  v_enderecos_fora integer;
begin
  if not tem_acao('mapa','ajustar') then
    raise exception 'Perfil sem permissão para ajustar o estoque do mapa';
  end if;
  if v_arm not in ('A','B','C','D','E') then
    raise exception 'armazém inválido: "%"', p_armazem;
  end if;
  if coalesce(btrim(p_motivo), '') = '' then
    raise exception 'o motivo é obrigatório';
  end if;

  -- trava a linha do mapa (FOR UPDATE não aceita GROUP BY: os totais dos
  -- endereços saem numa consulta à parte, já com a linha travada)
  for r in
    select m.lote, m.tratamento, m.bags as saldo
      from lotes_mapa m
     where exists (select 1 from lote_enderecos x
                    where x.lote = m.lote and x.tratamento = m.tratamento and x.armazem = v_arm)
     for update of m
  loop
    select sum(e.bags) filter (where e.armazem = v_arm),
           sum(e.bags) filter (where e.armazem <> v_arm),
           coalesce(bool_or(e.bags is null) filter (where e.armazem <> v_arm), false),
           count(*) filter (where e.armazem <> v_arm)
      into v_aqui, v_fora, v_fora_desconhecido, v_enderecos_fora
      from lote_enderecos e
     where e.lote = r.lote and e.tratamento = r.tratamento;

    v_combinacoes := v_combinacoes + 1;
    if v_enderecos_fora = 0 then
      -- só estava aqui (ou o resto nem tem endereço): sai inteiro do mapa
      v_novo := 0;
    elsif not v_fora_desconhecido then
      -- o que o mapa sabe que está nos outros armazéns fica
      v_novo := coalesce(v_fora, 0);
    else
      -- há endereço fora sem quantidade: desconta só o que se sabe que estava aqui
      v_novo := greatest(r.saldo - coalesce(v_aqui, 0), 0);
    end if;

    delete from lote_enderecos where lote = r.lote and tratamento = r.tratamento and armazem = v_arm;
    update lotes_mapa
       set bags = v_novo,
           nao_encontrado_inventario_em = case when v_novo <= 0 then null else nao_encontrado_inventario_em end,
           atualizado_em = now()
     where lote = r.lote and tratamento = r.tratamento;

    if v_novo <> r.saldo then
      insert into mapa_ajustes (lote, tratamento, delta, motivo, armazem, saldo_depois)
      values (r.lote, r.tratamento, v_novo - r.saldo,
              'Armazém ' || v_arm || ' esvaziado: ' || btrim(p_motivo), v_arm, v_novo);
      v_retirados := v_retirados + (r.saldo - v_novo);
    end if;
    if v_novo <= 0 then v_zerados := v_zerados + 1; end if;
  end loop;

  return jsonb_build_object('combinacoes', v_combinacoes, 'zerados', v_zerados,
                            'bags_retirados', v_retirados);
end $$;

revoke execute on function tsi.esvaziar_armazem_mapa(text, text) from public, anon;
grant execute on function tsi.esvaziar_armazem_mapa(text, text) to authenticated, service_role;

-- ---------- 6. endereço órfão de lote zerado ----------
-- 38 combinações com saldo 0 ainda tinham endereço em 13/10 (inventario_mapa_tira
-- só apaga o endereço quando a quantidade dele bate; endereço sem quantidade
-- ficava). O mapa esconde lote zerado, então o endereço é lixo — e entrava
-- na conta do armazém (a lista do E vinha com 20 combinações a menos do que
-- os endereços sugeriam). Mesma limpeza da mapa-excluir-lote.sql.
delete from lote_enderecos e
 using lotes_mapa lm
 where lm.lote = e.lote and lm.tratamento = e.tratamento and lm.bags <= 0.0001;

-- Conferência
select json_build_object(
  'enderecos_de_lote_zerado', (select count(*) from lote_enderecos e join lotes_mapa lm
              on lm.lote = e.lote and lm.tratamento = e.tratamento where lm.bags <= 0.0001),
  'coluna', (select count(*) from information_schema.columns
              where table_schema = 'tsi' and table_name = 'inventarios' and column_name = 'armazem'),
  'gatilho_item', (select count(*) from pg_trigger where tgname = 'tg_inventario_item_armazem'),
  'funcoes', (select json_agg(p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'tsi' and p.proname in ('inserir_mapa_no_inventario', 'esvaziar_armazem_mapa')),
  'poe_por_armazem', (select position('v_arm is not null' in pg_get_functiondef('tsi.inventario_mapa_poe(tsi.inventario_itens)'::regprocedure)) > 0),
  'sap_recusa_armazem', (select position('vem do mapa' in pg_get_functiondef('tsi.substituir_saldos_inventario(uuid, jsonb)'::regprocedure)) > 0),
  'grants_esvaziar', (select json_agg(grantee::text) from information_schema.routine_privileges
                       where routine_schema = 'tsi' and routine_name = 'esvaziar_armazem_mapa')
) as conferencia;
