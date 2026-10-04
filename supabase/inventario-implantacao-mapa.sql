-- ============================================================
-- Inventário de IMPLANTAÇÃO do mapa: cada contagem entra no mapa na hora
-- (04/10/2026, pedido do Arion: "eu fiz o inventário de 1 lote e não
-- apareceu no mapa"). O mapa foi zerado em 03/10 (mapa-reset-2026-10-03.sql)
-- e a operação vai recontar lote a lote, endereçando — mas a contagem só
-- vivia em inventario_itens, e o "Aplicar no mapa" (inventario-mapa-ajuste-
-- reserva.sql) só ENDEREÇA combinação que já existe no mapa: com o mapa
-- vazio, nada aparecia.
--
-- Endereço com regra fixa (mesmo pedido): ARMAZÉM A–E, BLOCO 1–44, QUADRA
-- 1–20 (quadra 1 = parede, número maior = frente). Front em
-- src/dominio/endereco.ts — mudou lá, mude aqui.
--
-- 1. tsi.numero_endereco() + gatilho que normaliza e CHECK em
--    lote_enderecos (vazia hoje) e inventario_itens (NOT VALID: o inventário
--    de 05/09 tem "06E" e é registro fechado).
-- 2. Índice único do endereço por combinação em lote_enderecos.
-- 3. inventario_saldos guarda pms/peso/destinação/classe/peneira/categoria
--    do SAP — é de onde o lote NASCE no mapa quando contado.
-- 4. inventarios.alimenta_mapa + gatilho em inventario_itens: insert/update/
--    delete mexem no mapa por DELTA. Exceção: a PRIMEIRA contagem de uma
--    combinação neste inventário SOBRESCREVE o saldo e os endereços — a
--    contagem é a verdade no momento em que é feita (o lote que a produção
--    pôs no mapa ontem, "sem localização", é o mesmo que o operador conta
--    hoje; somar dobraria). Daí em diante produção, carga e ajuste mexem
--    por delta, e editar a contagem também.
-- 5. aplicar_inventario_no_mapa recusa inventário que já alimenta o mapa.
-- 6. Inventário 03/10/2026 (a8dd87a8): reaberto, bloco "1A" → "1",
--    alimenta_mapa ligado e a contagem já feita entra no mapa.
-- ============================================================

-- 1. Normalização do endereço — espelho de numeroEndereco()
create or replace function tsi.numero_endereco(p_valor text, p_max integer)
returns text
language sql immutable
set search_path = tsi, public as $$
  select case when n between 1 and p_max then n::text end
    from (select ((regexp_match(upper(btrim(coalesce(p_valor, ''))),
                                '^0*(\d{1,3})\s*[A-Z]?$'))[1])::integer as n) x
$$;

create or replace function tsi.fn_endereco_normaliza()
returns trigger
language plpgsql
set search_path = tsi, public as $$
begin
  -- só normaliza o que dá pra ler; o resto o CHECK recusa com a mensagem
  -- do constraint (o front já não deixa chegar aqui)
  new.armazem := nullif(upper(btrim(new.armazem)), '');
  new.bloco   := coalesce(numero_endereco(new.bloco, 44), nullif(btrim(new.bloco), ''));
  new.quadra  := coalesce(numero_endereco(new.quadra, 20), nullif(btrim(new.quadra), ''));
  return new;
end $$;

drop trigger if exists tg_endereco_normaliza on tsi.lote_enderecos;
create trigger tg_endereco_normaliza
  before insert or update on tsi.lote_enderecos
  for each row execute function tsi.fn_endereco_normaliza();

drop trigger if exists tg_inventario_item_endereco on tsi.inventario_itens;
create trigger tg_inventario_item_endereco
  before insert or update on tsi.inventario_itens
  for each row execute function tsi.fn_endereco_normaliza();

alter table tsi.lote_enderecos drop constraint if exists lote_enderecos_endereco_valido;
alter table tsi.lote_enderecos add constraint lote_enderecos_endereco_valido check (
  armazem in ('A','B','C','D','E')
  and bloco ~ '^([1-9]|[1-3][0-9]|4[0-4])$'
  and quadra ~ '^([1-9]|1[0-9]|20)$'
);

alter table tsi.inventario_itens drop constraint if exists inventario_itens_endereco_valido;
alter table tsi.inventario_itens add constraint inventario_itens_endereco_valido check (
  (armazem is null or armazem in ('A','B','C','D','E'))
  and (bloco is null or bloco ~ '^([1-9]|[1-3][0-9]|4[0-4])$')
  and (quadra is null or quadra ~ '^([1-9]|1[0-9]|20)$')
) not valid;

-- 2. Um endereço por combinação (a tabela está vazia desde o reset de 03/10)
create unique index if not exists lote_enderecos_endereco_unico
  on tsi.lote_enderecos (lote, tratamento, armazem, bloco, quadra);

-- 3. Dados do SAP que fazem o lote nascer no mapa
alter table tsi.inventario_saldos
  add column if not exists pms numeric,
  add column if not exists peso_bag_kg numeric,
  add column if not exists destinacao text,
  add column if not exists classificacao text,
  add column if not exists peneira text,
  add column if not exists categoria text;

create or replace function tsi.substituir_saldos_inventario(p_id uuid, p_saldos jsonb)
returns integer
language plpgsql security invoker set search_path = tsi, public as $$
declare
  v_qtd integer;
begin
  perform 1 from inventarios where id = p_id and fechado_em is null for update;
  if not found then
    raise exception 'inventário não encontrado, sem permissão ou já fechado';
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
end $$;

-- 4. Inventário que alimenta o mapa
alter table tsi.inventarios add column if not exists alimenta_mapa boolean not null default false;

-- ligar/desligar com contagem lançada desalinha mapa e inventário: só na
-- criação (ou pelas funções próprias, com o GUC de sempre)
create or replace function tsi.fn_inventario_alimenta_fixo()
returns trigger
language plpgsql security definer set search_path = tsi, public as $$
begin
  if new.alimenta_mapa is distinct from old.alimenta_mapa
     and coalesce(current_setting('tsi.rpc_inventario', true), '') <> '1'
     and exists (select 1 from inventario_itens where inventario_id = new.id) then
    raise exception 'o inventário já tem contagem — não dá pra mudar se ele alimenta o mapa';
  end if;
  return new;
end $$;

drop trigger if exists tg_inventario_alimenta_fixo on tsi.inventarios;
create trigger tg_inventario_alimenta_fixo
  before update on tsi.inventarios
  for each row execute function tsi.fn_inventario_alimenta_fixo();

-- combinações que este inventário já "assumiu" (a 1ª contagem sobrescreveu).
-- Tabela própria porque a marca precisa sobreviver à exclusão do lançamento:
-- apagar e relançar não pode sobrescrever de novo o que a produção/carga
-- mexeu no meio.
create table if not exists tsi.inventario_mapa_assumido (
  inventario_id uuid not null references tsi.inventarios(id) on delete cascade,
  lote text not null,
  tratamento text not null,
  bags_antes numeric,
  assumido_em timestamptz not null default now(),
  primary key (inventario_id, lote, tratamento)
);
alter table tsi.inventario_mapa_assumido enable row level security;
drop policy if exists ler_inventario_mapa_assumido on tsi.inventario_mapa_assumido;
create policy ler_inventario_mapa_assumido on tsi.inventario_mapa_assumido for select
  using (tsi.tem_acao('inventario','ver'));

-- peso do bag de uma contagem: o do saldo do SAP → peso fixo da embalagem →
-- PMS × fator → peso do lote de semente
create or replace function tsi.inventario_item_peso(p_inv uuid, p_lote text, p_trat text, p_emb text)
returns numeric
language sql stable security definer set search_path = tsi, public as $$
  select coalesce(
    (select s.peso_bag_kg from inventario_saldos s
      where s.inventario_id = p_inv and s.lote = p_lote and s.tratamento = p_trat
        and s.embalagem = p_emb and s.peso_bag_kg > 0 limit 1),
    (select nullif(e.peso_fixo_kg, 0) from embalagens e where e.codigo = p_emb),
    (select coalesce(
              (select s.pms from inventario_saldos s
                where s.inventario_id = p_inv and s.lote = p_lote and s.pms > 0 limit 1),
              (select l.pms from lotes_semente l
                where regexp_replace(upper(btrim(l.id)), '(-\d+)+$', '') = p_lote and l.pms > 0
                order by l.atualizado_em desc nulls last limit 1)
            ) * e.fator_peso
       from embalagens e where e.codigo = p_emb),
    (select l.peso_bag_kg from lotes_semente l
      where regexp_replace(upper(btrim(l.id)), '(-\d+)+$', '') = p_lote and l.peso_bag_kg > 0
      order by l.atualizado_em desc nulls last limit 1),
    0
  )
$$;

-- tira do mapa o que um lançamento tinha posto (delta, nunca negativo)
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

-- põe no mapa o que um lançamento contou
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
       v_s.destinacao, v_s.classificacao,
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
    i.bags := v_qtd;  -- endereço na unidade da linha do mapa
  end if;

  if coalesce(i.bags, 0) > 0 then
    insert into lote_enderecos (lote, tratamento, armazem, bloco, quadra, bags, criado_por)
    values (v_lote, v_trat, i.armazem, i.bloco, i.quadra, i.bags, coalesce(auth.uid(), i.criado_por))
    on conflict (lote, tratamento, armazem, bloco, quadra)
    do update set bags = coalesce(lote_enderecos.bags, 0) + excluded.bags;
  end if;
end $$;

create or replace function tsi.fn_inventario_item_no_mapa()
returns trigger
language plpgsql security definer set search_path = tsi, public as $$
begin
  if tg_op in ('UPDATE', 'DELETE')
     and exists (select 1 from inventarios where id = old.inventario_id and alimenta_mapa) then
    perform inventario_mapa_tira(old);
  end if;
  if tg_op in ('INSERT', 'UPDATE')
     and exists (select 1 from inventarios where id = new.inventario_id and alimenta_mapa) then
    perform inventario_mapa_poe(new);
  end if;
  return null;
end $$;

drop trigger if exists tg_inventario_item_no_mapa on tsi.inventario_itens;
create trigger tg_inventario_item_no_mapa
  after insert or update or delete on tsi.inventario_itens
  for each row execute function tsi.fn_inventario_item_no_mapa();

revoke execute on function tsi.inventario_mapa_poe(tsi.inventario_itens) from public, anon, authenticated;
revoke execute on function tsi.inventario_mapa_tira(tsi.inventario_itens) from public, anon, authenticated;
revoke execute on function tsi.inventario_item_peso(uuid, text, text, text) from public, anon, authenticated;

-- 5. Aplicar não vale para quem já alimenta o mapa (refazeria endereços e
--    marcaria como "não encontrado" o que a produção pôs no mapa)
create or replace function tsi.aplicar_inventario_no_mapa(p_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'tsi', 'public'
as $function$
declare
  v_enderecados integer := 0;
  v_nao integer := 0;
  v_sem_mapa text[] := '{}';
  r record;
begin
  if not tem_acao('inventario','abrir') then
    raise exception 'Perfil sem permissão para aplicar inventário no mapa';
  end if;
  perform set_config('tsi.rpc_inventario', '1', true);

  if exists (select 1 from inventarios where id = p_id and alimenta_mapa) then
    raise exception 'este inventário já lança cada contagem no mapa — não há o que aplicar';
  end if;

  -- lock: dois cliques não aplicam duas vezes
  perform 1 from inventarios
    where id = p_id and fechado_em is not null and aplicado_em is null
    for update;
  if not found then
    raise exception 'inventário não encontrado, ainda aberto, ou já aplicado';
  end if;

  for r in
    select lote, tratamento
      from inventario_resultados
     where inventario_id = p_id and bags_contados is not null
     group by lote, tratamento
  loop
    if exists (select 1 from lotes_mapa where lote = r.lote and tratamento = r.tratamento) then
      delete from lote_enderecos where lote = r.lote and tratamento = r.tratamento;
      insert into lote_enderecos (lote, tratamento, armazem, bloco, quadra, bags, criado_por)
      select r.lote, r.tratamento, a, b, q, sum(bg), auth.uid()
        from (select upper(btrim(i.armazem)) a,
                     coalesce(numero_endereco(i.bloco, 44), upper(btrim(i.bloco))) b,
                     coalesce(numero_endereco(i.quadra, 20), upper(btrim(i.quadra))) q,
                     i.bags bg
                from inventario_itens i
               where i.inventario_id = p_id
                 and upper(btrim(regexp_replace(i.lote, '(-\d+)+$', ''))) = r.lote
                 and upper(btrim(i.tratamento)) = r.tratamento
                 and coalesce(btrim(i.armazem), '') <> '') x
       group by a, b, q
      having sum(bg) > 0;

      update lotes_mapa set nao_encontrado_inventario_em = null
       where lote = r.lote and tratamento = r.tratamento;
      v_enderecados := v_enderecados + 1;
    else
      v_sem_mapa := v_sem_mapa || (r.lote || ' · ' || r.tratamento);
    end if;
  end loop;

  update lotes_mapa lm
     set nao_encontrado_inventario_em = now()
   where exists (
     select 1 from inventario_resultados ir
      where ir.inventario_id = p_id
        and ir.bags_contados is null
        and ir.lote = lm.lote and ir.tratamento = lm.tratamento
   );
  get diagnostics v_nao = row_count;

  update inventarios set aplicado_em = now(), aplicado_por = auth.uid()
   where id = p_id;

  return jsonb_build_object(
    'enderecados', v_enderecados,
    'nao_encontrados', v_nao,
    'sem_mapa', to_jsonb(v_sem_mapa)
  );
end $function$;

-- 6. Inventário 03/10/2026: reabre, conserta o endereço e lança no mapa
do $$
declare
  v_inv uuid := 'a8dd87a8-6e97-475a-9762-d321ec7ee974';
  r tsi.inventario_itens%rowtype;
begin
  -- roda uma vez só: com o mapa ligado, lançar de novo dobraria a contagem
  if not exists (select 1 from tsi.inventarios
                  where id = v_inv and aplicado_em is null and not alimenta_mapa) then
    return;
  end if;
  perform set_config('tsi.rpc_inventario', '1', true);

  delete from tsi.inventario_resultados where inventario_id = v_inv;
  update tsi.inventarios set fechado_em = null, fechado_por = null where id = v_inv;

  -- saldos do SAP sem PMS/peso (inseridos antes desta migração): completa
  -- pelo mapa arquivado em 03/10 (mesmo lote+tratamento, senão o lote) e
  -- pelo lote de semente
  update tsi.inventario_saldos s
     set pms = coalesce(
           (select a.pms from arquivo.lotes_mapa_20261003 a
             where a.lote = s.lote and a.tratamento = s.tratamento and a.pms > 0 limit 1),
           (select a.pms from arquivo.lotes_mapa_20261003 a
             where a.lote = s.lote and a.pms > 0 limit 1),
           (select l.pms from tsi.lotes_semente l
             where regexp_replace(upper(btrim(l.id)), '(-\d+)+$', '') = s.lote and l.pms > 0
             order by l.atualizado_em desc nulls last limit 1)),
         destinacao = (select a.destinacao from arquivo.lotes_mapa_20261003 a
                        where a.lote = s.lote and a.tratamento = s.tratamento limit 1),
         classificacao = coalesce(
           (select a.classificacao from arquivo.lotes_mapa_20261003 a
             where a.lote = s.lote and a.tratamento = s.tratamento and a.classificacao is not null limit 1),
           (select a.classificacao from arquivo.lotes_mapa_20261003 a
             where a.lote = s.lote and a.classificacao is not null limit 1)),
         peneira = coalesce(
           (select a.peneira from arquivo.lotes_mapa_20261003 a
             where a.lote = s.lote and a.peneira is not null limit 1),
           (select l.peneira from tsi.lotes_semente l
             where regexp_replace(upper(btrim(l.id)), '(-\d+)+$', '') = s.lote and l.peneira is not null limit 1)),
         categoria = coalesce(
           (select a.categoria from arquivo.lotes_mapa_20261003 a
             where a.lote = s.lote and a.categoria is not null limit 1),
           (select l.categoria from tsi.lotes_semente l
             where regexp_replace(upper(btrim(l.id)), '(-\d+)+$', '') = s.lote and l.categoria is not null limit 1))
   where s.inventario_id = v_inv and s.pms is null;

  update tsi.inventario_saldos s
     set peso_bag_kg = coalesce(nullif(e.peso_fixo_kg, 0), round(s.pms * e.fator_peso, 3))
    from tsi.embalagens e
   where e.codigo = s.embalagem and s.inventario_id = v_inv and s.peso_bag_kg is null;

  -- "1A" → "1" (o gatilho normaliza) ANTES de ligar o mapa
  update tsi.inventario_itens set bloco = bloco, quadra = quadra where inventario_id = v_inv;

  update tsi.inventarios set alimenta_mapa = true where id = v_inv;

  for r in select * from tsi.inventario_itens where inventario_id = v_inv order by criado_em loop
    perform tsi.inventario_mapa_poe(r);
  end loop;
end $$;

-- 7. A produção põe o tratado no mapa pelo lote BASE (achado na mesma
--    conferência): o gatilho usava o lote_id da ordem, com o sufixo do SAP
--    ("SV0013026563000-1"), enquanto o importador e o inventário gravam o
--    número base — o operador contava o lote e ele aparecia DUAS vezes no
--    mapa (um com sufixo, sem localização; outro sem). E a branca consumida
--    nunca saía, porque a branca do mapa também é por número base. Base: a
--    definição vigente (inventario-mapa-ajuste-reserva.sql); só o lote mudou.
create or replace function tsi.fn_lote_tratado_no_mapa()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'tsi', 'public'
as $function$
declare
  v_row      ordens%rowtype;
  v_entrando boolean;
  v_receita  text;
  v_ls       lotes_semente%rowtype;
  v_emb      embalagens%rowtype;
  v_peso     numeric;
  v_bags     numeric;
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
    if v_ls.peso_bag_kg > 0 and v_peso > 0 then
      update lotes_mapa
         set bags = bags - (v_bags * v_peso / v_ls.peso_bag_kg),
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

    if v_ls.peso_bag_kg > 0 and v_peso > 0 then
      update lotes_mapa
         set bags = bags + (v_bags * v_peso / v_ls.peso_bag_kg),
             atualizado_em = now()
       where lote = v_lote and tratamento = 'SEM TSI';
    end if;

    delete from ordem_mapa_lancado where ordem_id = v_row.id;
  end if;

  return new;
end $function$;

-- funde no número base o que já entrou com sufixo depois do reset de 03/10
do $$
declare
  r tsi.lotes_mapa%rowtype;
  v_base text;
begin
  for r in select * from tsi.lotes_mapa where lote ~ '-\d+$' loop
    v_base := regexp_replace(r.lote, '(-\d+)+$', '');
    insert into tsi.lotes_mapa
      (lote, tratamento, cultivar, embalagem, pms, peso_bag_kg, bags,
       destinacao, classificacao, peneira, categoria, atualizado_em)
    values
      (v_base, r.tratamento, r.cultivar, r.embalagem, r.pms, r.peso_bag_kg, r.bags,
       r.destinacao, r.classificacao, r.peneira, r.categoria, now())
    on conflict (lote, tratamento) do update
      set bags = tsi.lotes_mapa.bags + excluded.bags, atualizado_em = now();
    insert into tsi.lote_enderecos (lote, tratamento, armazem, bloco, quadra, bags, criado_por)
    select v_base, e.tratamento, e.armazem, e.bloco, e.quadra, e.bags, e.criado_por
      from tsi.lote_enderecos e where e.lote = r.lote and e.tratamento = r.tratamento
    on conflict (lote, tratamento, armazem, bloco, quadra)
    do update set bags = case when tsi.lote_enderecos.bags is null or excluded.bags is null then null
                              else tsi.lote_enderecos.bags + excluded.bags end;
    delete from tsi.lotes_mapa where lote = r.lote and tratamento = r.tratamento;
  end loop;
end $$;

-- ------------------------------------------------------------
-- Conferência
-- ------------------------------------------------------------
select json_build_object(
  'numero_endereco', json_build_object(
    '06E', tsi.numero_endereco('06E', 44), '1A', tsi.numero_endereco('1A', 44),
    '0', tsi.numero_endereco('0', 44), '45', tsi.numero_endereco('45', 44),
    '20', tsi.numero_endereco('20', 20), '21', tsi.numero_endereco('21', 20)),
  'inventario', (select row_to_json(x) from (
     select titulo, fechado_em, aplicado_em, alimenta_mapa from tsi.inventarios
      where id = 'a8dd87a8-6e97-475a-9762-d321ec7ee974') x),
  'item', (select json_agg(row_to_json(x)) from (
     select lote, tratamento, embalagem, armazem, bloco, quadra, bags from tsi.inventario_itens
      where inventario_id = 'a8dd87a8-6e97-475a-9762-d321ec7ee974') x),
  'no_mapa', (select json_agg(row_to_json(x)) from (
     select lm.lote, lm.tratamento, lm.cultivar, lm.embalagem, lm.pms, lm.peso_bag_kg, lm.bags,
            (select json_agg(e.armazem || '·' || e.bloco || '·' || e.quadra || ' = ' || e.bags)
               from tsi.lote_enderecos e where e.lote = lm.lote and e.tratamento = lm.tratamento) enderecos
       from tsi.lotes_mapa lm) x),
  'saldos_com_peso', (select count(*) filter (where peso_bag_kg > 0) || ' de ' || count(*)
                        from tsi.inventario_saldos
                       where inventario_id = 'a8dd87a8-6e97-475a-9762-d321ec7ee974'),
  'gatilhos', (select json_agg(tgname order by tgname) from pg_trigger t
                 join pg_class c on c.oid = t.tgrelid
                where c.relnamespace = 'tsi'::regnamespace
                  and c.relname in ('inventario_itens', 'lote_enderecos', 'inventarios')
                  and not t.tgisinternal)
) as conferencia;
