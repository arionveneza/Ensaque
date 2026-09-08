-- ============================================================
-- Inventário → Mapa: endereços, ajuste de estoque e reserva — 08/09/2026
-- Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- Decisões do Arion (07/09/2026):
-- 1. Aplicar inventário no mapa = SÓ ENDEREÇOS (o saldo continua o do SAP;
--    sobra/falta é ajuste no SAP). Não contados NÃO zeram: viram a lista
--    "Não encontrados no inventário" na tela do Mapa.
-- 2. Ajuste de estoque manual (PCP/Logística/Gestor): ± quantidade numa
--    combinação, com endereço junto e rastro (mapa_ajustes).
-- 3. Reserva contínua: ordem de produção com LOTE SELECIONADO segura a
--    branca no mapa até o APONTAMENTO — quando o débito real acontece e o
--    TRATADO entra no mapa. A trava server-side da carga passa a descontar
--    as ordens (antes só via outras cargas).
-- 4. Entrada do tratado ANTECIPA: de "Qualidade apontada" pra "Finalizada"
--    (apontamento da quantidade produzida). Nasce sem endereço; a
--    Logística endereça na própria tela de conferência.
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 1. Colunas novas
-- ------------------------------------------------------------
alter table inventarios add column if not exists aplicado_em timestamptz;
alter table inventarios add column if not exists aplicado_por uuid;
comment on column inventarios.aplicado_em is
  'Endereços aplicados no mapa (aplicar_inventario_no_mapa). Aplicado não reabre mais.';

alter table lotes_mapa add column if not exists nao_encontrado_inventario_em timestamptz;
comment on column lotes_mapa.nao_encontrado_inventario_em is
  'Estava na lista do SAP do último inventário aplicado e ninguém contou. Limpa ao endereçar (gatilho), ao ser contado numa aplicação seguinte, ou zerando por ajuste.';

-- rastro de entrada no mapa por ordem: torna gatilho e backfill idempotentes
-- e é a régua do desfazer ("Voltar para produção" só reverte o que entrou)
alter table ordens add column if not exists mapa_lancado_em timestamptz;
comment on column ordens.mapa_lancado_em is
  'Quando o apontamento desta ordem entrou no mapa (tratado criado + branca debitada). Null = ainda não entrou.';

-- ------------------------------------------------------------
-- 2. Marcos do inventário: aplicado_em/por também só mudam pelas RPCs
--    (recria a função inteira — padrão do projeto)
-- ------------------------------------------------------------
create or replace function fn_inventario_marcos() returns trigger
language plpgsql security definer set search_path = tsi, public as $$
begin
  if (new.fechado_em is distinct from old.fechado_em
      or new.fechado_por is distinct from old.fechado_por
      or new.aplicado_em is distinct from old.aplicado_em
      or new.aplicado_por is distinct from old.aplicado_por)
     and coalesce(current_setting('tsi.rpc_inventario', true), '') <> '1' then
    raise exception 'fechar/reabrir/aplicar inventário só pelas funções próprias';
  end if;
  return new;
end $$;

-- gatilho tg_inventario_marcos já existe e aponta pra esta função

-- reabrir agora recusa inventário APLICADO (o mapa foi endereçado por ele)
create or replace function reabrir_inventario(p_id uuid) returns void
language plpgsql security definer set search_path = tsi, public as $$
begin
  if not tem_acao('inventario','abrir') then
    raise exception 'Perfil sem permissão para reabrir inventário';
  end if;
  perform set_config('tsi.rpc_inventario', '1', true);

  perform 1 from inventarios where id = p_id and fechado_em is not null for update;
  if not found then
    raise exception 'inventário não encontrado ou não está fechado';
  end if;
  if exists (select 1 from inventarios where id = p_id and aplicado_em is not null) then
    raise exception 'inventário já aplicado no mapa é registro definitivo — não reabre';
  end if;
  delete from inventario_resultados where inventario_id = p_id;
  update inventarios set fechado_em = null, fechado_por = null where id = p_id;
end $$;

-- ------------------------------------------------------------
-- 3. Aplicar inventário no mapa: SÓ ENDEREÇOS + marca de não encontrado.
--    SECURITY DEFINER com guarda própria: lote_enderecos só aceita escrita
--    da Logística (policy log_lote_end), mas quem aplica é o PCP — mesmo
--    padrão do salvar_fotos_carga.
-- ------------------------------------------------------------
create or replace function aplicar_inventario_no_mapa(p_id uuid) returns jsonb
language plpgsql security definer set search_path = tsi, public as $$
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

  -- lock: dois cliques não aplicam duas vezes
  perform 1 from inventarios
    where id = p_id and fechado_em is not null and aplicado_em is null
    for update;
  if not found then
    raise exception 'inventário não encontrado, ainda aberto, ou já aplicado';
  end if;

  -- CONTADAS (bate/sobra/falta — bags_contados not null), por combinação
  -- do MAPA (lote + tratamento; a embalagem fica fora da chave):
  for r in
    select lote, tratamento
      from inventario_resultados
     where inventario_id = p_id and bags_contados is not null
     group by lote, tratamento
  loop
    if exists (select 1 from lotes_mapa where lote = r.lote and tratamento = r.tratamento) then
      -- endereços contados SUBSTITUEM os do mapa, com quantidade por
      -- endereço (o inventário sempre conta onde; soma lançamentos do
      -- mesmo lugar). Contagem 0 num lugar = nada ali: não vira endereço.
      delete from lote_enderecos where lote = r.lote and tratamento = r.tratamento;
      insert into lote_enderecos (lote, tratamento, armazem, bloco, quadra, bags, criado_por)
      select r.lote, r.tratamento,
             upper(btrim(i.armazem)), coalesce(upper(btrim(i.bloco)), ''),
             coalesce(upper(btrim(i.quadra)), ''), sum(i.bags), auth.uid()
        from inventario_itens i
       where i.inventario_id = p_id
         and upper(btrim(regexp_replace(i.lote, '(-\d+)+$', ''))) = r.lote
         and upper(btrim(i.tratamento)) = r.tratamento
         and coalesce(btrim(i.armazem), '') <> ''
       group by upper(btrim(i.armazem)), coalesce(upper(btrim(i.bloco)), ''),
                coalesce(upper(btrim(i.quadra)), '')
      having sum(i.bags) > 0;

      update lotes_mapa set nao_encontrado_inventario_em = null
       where lote = r.lote and tratamento = r.tratamento;
      v_enderecados := v_enderecados + 1;
    else
      -- contada mas sem linha no mapa (fora do SAP): o saldo é do SAP —
      -- não cria; resolve-se depois pelo Ajuste de estoque
      v_sem_mapa := v_sem_mapa || (r.lote || ' · ' || r.tratamento);
    end if;
  end loop;

  -- NÃO CONTADAS: só a marca — saldo e endereços intactos
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
end $$;

-- ------------------------------------------------------------
-- 4. Endereçar = "achei": limpa a marca de não encontrado
-- ------------------------------------------------------------
create or replace function fn_endereco_achado() returns trigger
language plpgsql security definer set search_path = tsi, public as $$
begin
  update lotes_mapa set nao_encontrado_inventario_em = null
   where lote = new.lote and tratamento = new.tratamento
     and nao_encontrado_inventario_em is not null;
  return new;
end $$;

drop trigger if exists tg_endereco_achado on lote_enderecos;
create trigger tg_endereco_achado
  after insert on lote_enderecos
  for each row execute function fn_endereco_achado();

-- ------------------------------------------------------------
-- 5. Ajuste de estoque manual, com rastro
-- ------------------------------------------------------------
create table if not exists mapa_ajustes (
  id           uuid primary key default gen_random_uuid(),
  lote         text not null,
  tratamento   text not null,
  delta        numeric(12,2) not null check (delta <> 0),
  motivo       text not null,
  armazem      text,
  bloco        text,
  quadra       text,
  saldo_depois numeric(12,2) not null,
  criado_em    timestamptz not null default now(),
  criado_por   uuid default auth.uid()
);

comment on table mapa_ajustes is
  'Rastro dos ajustes manuais de saldo do mapa (08/09/2026) — quem, quando, quanto, por quê e em qual endereço. Escrita SÓ pela RPC ajustar_saldo_mapa.';

alter table mapa_ajustes enable row level security;
drop policy if exists ler_mapa_ajustes on mapa_ajustes;
create policy ler_mapa_ajustes on mapa_ajustes for select
  using (tem_acao('mapa','ver'));
-- sem policy de escrita de propósito: só a RPC (DEFINER) grava

create or replace function ajustar_saldo_mapa(
  p_lote text, p_tratamento text, p_delta numeric, p_motivo text,
  p_armazem text, p_bloco text, p_quadra text
) returns numeric
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_lm   lotes_mapa%rowtype;
  v_novo numeric;
  v_end  lote_enderecos%rowtype;
begin
  if not tem_acao('mapa','ajustar') then
    raise exception 'Perfil sem permissão para ajustar estoque do mapa';
  end if;
  if p_delta is null or p_delta = 0 then
    raise exception 'informe a quantidade a acrescentar ou subtrair';
  end if;
  if coalesce(btrim(p_motivo), '') = '' then
    raise exception 'o motivo do ajuste é obrigatório';
  end if;

  select * into v_lm from lotes_mapa
   where lote = p_lote and tratamento = p_tratamento
   for update;
  if not found then
    raise exception 'combinação % · % não existe no mapa', p_lote, p_tratamento;
  end if;

  v_novo := v_lm.bags + p_delta;
  if v_novo < -0.01 then
    raise exception 'o ajuste deixaria o saldo negativo (atual: % bg)', v_lm.bags;
  end if;

  update lotes_mapa
     set bags = v_novo, atualizado_em = now()
   where lote = p_lote and tratamento = p_tratamento;

  -- endereço junto do ajuste (opcional): soma/subtrai naquele lugar
  if coalesce(btrim(p_armazem), '') <> '' then
    select * into v_end from lote_enderecos
     where lote = p_lote and tratamento = p_tratamento
       and armazem = upper(btrim(p_armazem))
       and bloco  = coalesce(upper(btrim(p_bloco)), '')
       and quadra = coalesce(upper(btrim(p_quadra)), '')
     limit 1;
    if found then
      if v_end.bags is null then
        null; -- contagem desconhecida continua desconhecida
      elsif v_end.bags + p_delta > 0 then
        update lote_enderecos set bags = v_end.bags + p_delta where id = v_end.id;
      else
        delete from lote_enderecos where id = v_end.id;
      end if;
    elsif p_delta > 0 then
      insert into lote_enderecos (lote, tratamento, armazem, bloco, quadra, bags, criado_por)
      values (p_lote, p_tratamento, upper(btrim(p_armazem)),
              coalesce(upper(btrim(p_bloco)), ''), coalesce(upper(btrim(p_quadra)), ''),
              p_delta, auth.uid());
    end if;
    -- delta negativo sem endereço correspondente: só o saldo muda
  end if;

  insert into mapa_ajustes (lote, tratamento, delta, motivo, armazem, bloco, quadra, saldo_depois)
  values (p_lote, p_tratamento, p_delta, btrim(p_motivo),
          nullif(upper(btrim(p_armazem)), ''), nullif(upper(btrim(p_bloco)), ''),
          nullif(upper(btrim(p_quadra)), ''), v_novo);

  return v_novo;
end $$;

-- ------------------------------------------------------------
-- 6. Trava da carga passa a descontar as ORDENS não apontadas: a reserva
--    da ordem vale do lote selecionado até o apontamento (quando o gatilho
--    debita de verdade). Cópia fiel da versão de varredura-mapa-2026-08-30
--    + o segundo having. Espelho de listarConsumoOrdens no front — mudou
--    um, mude o outro.
-- ------------------------------------------------------------
create or replace function salvar_carga_montada(
  p_id       uuid,
  p_carga    jsonb,
  p_produtos jsonb,
  p_usuario  uuid
) returns uuid
language plpgsql
security invoker
set search_path = tsi, public
as $$
declare
  v_id      uuid := p_id;
  v_prod    jsonb;
  v_prod_id uuid;
  v_excesso record;
begin
  if v_id is null then
    insert into cargas_montadas (numero, peso_total_kg, placa, cliente, tara_kg, veiculo, criada_por)
    values (
      p_carga->>'numero',
      (p_carga->>'peso_total_kg')::numeric,
      p_carga->>'placa',
      p_carga->>'cliente',
      (p_carga->>'tara_kg')::numeric,
      p_carga->>'veiculo',
      coalesce(auth.uid(), p_usuario)   -- autoria do token, não do cliente
    )
    returning id into v_id;
  else
    -- carga carregada/finalizada é registro histórico: editar corrompia o
    -- desconto do mapa (o gatilho debita pelos itens do momento do marco)
    perform 1 from cargas_montadas
      where id = v_id and carregada_em is null and finalizada_em is null;
    if not found then
      raise exception 'Carga carregada/finalizada (ou inexistente) não pode ser editada — desfaça o marco primeiro';
    end if;
    update cargas_montadas
       set numero        = p_carga->>'numero',
           peso_total_kg = (p_carga->>'peso_total_kg')::numeric,
           placa         = p_carga->>'placa',
           cliente       = p_carga->>'cliente',
           tara_kg       = (p_carga->>'tara_kg')::numeric,
           veiculo       = p_carga->>'veiculo'
     where id = v_id;
    if not found then
      raise exception 'carga % não encontrada (ou sem permissão para editar)', v_id;
    end if;
    delete from carga_montada_itens where carga_id = v_id;
    delete from carga_montada_produtos where carga_id = v_id;
  end if;

  for v_prod in select value from jsonb_array_elements(coalesce(p_produtos, '[]'::jsonb)) loop
    insert into carga_montada_produtos (carga_id, cultivar, tratamento, bags_solicitados)
    values (
      v_id,
      v_prod->>'cultivar',
      v_prod->>'tratamento',
      coalesce((v_prod->>'bags_solicitados')::numeric, 0)
    )
    returning id into v_prod_id;

    insert into carga_montada_itens (carga_id, produto_id, lote_id, bags, peso_kg, destinacao)
    select v_id, v_prod_id, i->>'lote_id', (i->>'bags')::numeric, (i->>'peso_kg')::numeric, i->>'destinacao'
      from jsonb_array_elements(coalesce(v_prod->'itens', '[]'::jsonb)) i;
  end loop;

  -- trava de saldo NO SERVIDOR (a do front é só leitura): a soma dos itens
  -- de cargas ATIVAS de cada lote desta carga não pode passar do mapa —
  -- mata a corrida de dois loteamentos simultâneos. Lote fora do mapa não
  -- valida (carga antiga de lote que zerou continua editável).
  select i.lote_id, p.tratamento, sum(i.bags) as total, min(lm.bags) as saldo
    into v_excesso
    from carga_montada_produtos p
    join carga_montada_itens i on i.produto_id = p.id
    join cargas_montadas c on c.id = p.carga_id
    join lotes_mapa lm on lm.lote = i.lote_id and lm.tratamento = p.tratamento
   where c.carregada_em is null
     and exists (
       select 1
         from carga_montada_produtos p2
         join carga_montada_itens i2 on i2.produto_id = p2.id
        where p2.carga_id = v_id
          and i2.lote_id = i.lote_id and p2.tratamento = p.tratamento
     )
   group by i.lote_id, p.tratamento
  having sum(i.bags) > min(lm.bags) + 0.01
   limit 1;
  if found then
    raise exception 'Lote % · %: % bags em cargas ativas, mas o mapa só tem % — recarregue a tela',
      v_excesso.lote_id, v_excesso.tratamento, v_excesso.total, v_excesso.saldo;
  end if;

  -- reserva das ORDENS (08/09/2026): na semente BRANCA, cargas ativas +
  -- ordens com lote selecionado ainda não apontadas não podem passar do
  -- saldo. Régua = até 'Finalizada' (o apontamento debita o mapa de
  -- verdade); peso do bag 0/nulo não converte (lote sem peso não trava).
  select i.lote_id,
         sum(i.bags) as total,
         min(lm.bags) as saldo,
         round(coalesce((select sum(v.peso_kg) from v_ordens v
                  where v.lote_id = i.lote_id
                    and v.status not in ('Finalizada','Qualidade apontada','Apontada','Excluida')), 0)
               / nullif(min(lm.peso_bag_kg), 0), 2) as em_ordens
    into v_excesso
    from carga_montada_produtos p
    join carga_montada_itens i on i.produto_id = p.id
    join cargas_montadas c on c.id = p.carga_id
    join lotes_mapa lm on lm.lote = i.lote_id and lm.tratamento = 'SEM TSI'
   where c.carregada_em is null
     and p.tratamento = 'SEM TSI'
     and exists (
       select 1
         from carga_montada_produtos p2
         join carga_montada_itens i2 on i2.produto_id = p2.id
        where p2.carga_id = v_id
          and i2.lote_id = i.lote_id and p2.tratamento = 'SEM TSI'
     )
   group by i.lote_id
  having sum(i.bags)
       + coalesce((select sum(v.peso_kg) from v_ordens v
                    where v.lote_id = i.lote_id
                      and v.status not in ('Finalizada','Qualidade apontada','Apontada','Excluida')), 0)
         / nullif(min(lm.peso_bag_kg), 0)
       > min(lm.bags) + 0.01
   limit 1;
  if found then
    raise exception 'Lote %: % bags em cargas + % reservados por ordens de produção passam do saldo de % do mapa — ajuste a carga ou as ordens',
      v_excesso.lote_id, v_excesso.total, v_excesso.em_ordens, v_excesso.saldo;
  end if;

  return v_id;
end $$;

-- ------------------------------------------------------------
-- 7. Entrada do tratado ANTECIPA pra Finalizada, com desfazer simétrico
--    ("Voltar para produção" reverte usando os valores VELHOS da ordem).
--    Sem clamp nos dois sentidos — o desfazer devolve exatamente o que o
--    marco tirou (lição da varredura de 30/08). mapa_lancado_em torna
--    gatilho e backfill idempotentes.
-- ------------------------------------------------------------
create or replace function fn_lote_tratado_no_mapa() returns trigger
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_row      ordens%rowtype;
  v_entrando boolean;
  v_receita  text;
  v_ls       lotes_semente%rowtype;
  v_emb      embalagens%rowtype;
  v_peso     numeric;
  v_bags     numeric;
begin
  if new.status = 'Finalizada' and old.status is distinct from new.status
     and new.mapa_lancado_em is null then
    v_entrando := true;
    v_row := new;
  elsif old.status = 'Finalizada' and new.status in ('Em producao', 'Parada')
     and old.mapa_lancado_em is not null then
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
      (v_row.lote_id, v_receita, v_ls.cultivar, v_row.embalagem, v_ls.pms,
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
       where lote = v_row.lote_id and tratamento = 'SEM TSI';
    end if;

    update ordens set mapa_lancado_em = now() where id = v_row.id;
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
     where lote = v_row.lote_id and tratamento = v_receita;

    if v_ls.peso_bag_kg > 0 and v_peso > 0 then
      update lotes_mapa
         set bags = bags + (v_bags * v_peso / v_ls.peso_bag_kg),
             atualizado_em = now()
       where lote = v_row.lote_id and tratamento = 'SEM TSI';
    end if;

    update ordens set mapa_lancado_em = null where id = v_row.id;
  end if;

  return new;
end $$;

drop trigger if exists tg_lote_tratado_no_mapa on ordens;
create trigger tg_lote_tratado_no_mapa
  after update of status on ordens
  for each row
  when ((new.status = 'Finalizada' and old.status is distinct from new.status)
     or (old.status = 'Finalizada' and new.status in ('Em producao', 'Parada')))
  execute function fn_lote_tratado_no_mapa();

-- ------------------------------------------------------------
-- 8. Backfill idempotente:
--    - ordens já em Qualidade apontada/Apontada entraram no mapa pela
--      regra antiga → só carimba mapa_lancado_em (sem reentrar);
--    - ordens hoje em Finalizada (ainda sem QA) NUNCA entraram → entram
--      agora, pela mesma conta do gatilho.
-- ------------------------------------------------------------
update ordens set mapa_lancado_em = coalesce(mapa_lancado_em, now())
 where status in ('Qualidade apontada', 'Apontada');

do $$
declare
  r          ordens%rowtype;
  v_receita  text;
  v_ls       lotes_semente%rowtype;
  v_emb      embalagens%rowtype;
  v_peso     numeric;
  v_bags     numeric;
begin
  for r in select * from ordens where status = 'Finalizada' and mapa_lancado_em is null
  loop
    select nome into v_receita from receitas where id = r.receita_id;
    if v_receita is null or upper(trim(v_receita)) = 'SEM TSI' then
      update ordens set mapa_lancado_em = now() where id = r.id;
      continue;
    end if;
    select * into v_ls from lotes_semente where id = r.lote_id;
    if not found then
      update ordens set mapa_lancado_em = now() where id = r.id;
      continue;
    end if;
    select * into v_emb from embalagens where codigo = r.embalagem;
    v_peso := coalesce(nullif(v_emb.peso_fixo_kg, 0), v_ls.pms * v_emb.fator_peso, v_ls.peso_bag_kg, 0);
    v_bags := coalesce(r.bags_produzidos, r.bags);

    insert into lotes_mapa
      (lote, tratamento, cultivar, embalagem, pms, peso_bag_kg, bags,
       destinacao, classificacao, peneira, categoria, atualizado_em)
    values
      (r.lote_id, v_receita, v_ls.cultivar, r.embalagem, v_ls.pms,
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

    if v_ls.peso_bag_kg > 0 and v_peso > 0 then
      update lotes_mapa
         set bags = bags - (v_bags * v_peso / v_ls.peso_bag_kg),
             atualizado_em = now()
       where lote = r.lote_id and tratamento = 'SEM TSI';
    end if;

    update ordens set mapa_lancado_em = now() where id = r.id;
  end loop;
end $$;

-- ------------------------------------------------------------
-- 9. Permissões: ação nova mapa/ajustar (PCP, Logística e Gestor) —
--    seeds + tem_acao RECRIADA inteira (espelho de MATRIZ_PADRAO em
--    src/dominio/permissoes.ts — mudou um, mude o outro)
-- ------------------------------------------------------------
insert into perfil_permissoes (perfil, recurso, acao, permitido) values
  ('PCP',       'mapa', 'ajustar', true),
  ('Logistica', 'mapa', 'ajustar', true)
on conflict (perfil, recurso, acao) do update set permitido = excluded.permitido;

create or replace function tem_acao(p_recurso text, p_acao text) returns boolean as $$
  select coalesce(
    (select permitido from tsi.perfil_permissoes
      where perfil = tsi.meu_perfil() and recurso = p_recurso and acao = p_acao),
    tsi.meu_perfil() = 'Gestor'  -- padrão do Gestor: tudo
    or exists (select 1 from (values
      ('PCP','ordens','ver'), ('PCP','ordens','criar'), ('PCP','ordens','editar'),
      ('PCP','ordens','excluir'), ('PCP','ordens','priorizar'),
      ('PCP','programacao','ver'), ('PCP','programacao','editar'),
      ('PCP','lotes','ver'), ('PCP','execucao','ver'), ('PCP','qualidade','ver'),
      ('PCP','agrotis','ver'), ('PCP','agrotis','lancar'),
      ('PCP','etapas','ver'), ('PCP','indicadores','ver'),
      ('PCP','cadastros','ver'), ('PCP','cadastros','editar'),
      ('PCP','expedicao','ver'), ('PCP','expedicao','importar'),
      ('PCP','mrp','ver'), ('PCP','mrp','importar'),
      ('PCP','mapa','ver'), ('PCP','mapa','importar'), ('PCP','mapa','montar_carga'),
      ('PCP','mapa','ajustar'),
      ('PCP','inventario','ver'), ('PCP','inventario','abrir'), ('PCP','inventario','contar'),
      ('PCP','veiculos','ver'), ('PCP','veiculos','chamar'), ('PCP','veiculos','checklist'),
      ('Logistica','programacao','ver'), ('Logistica','lotes','ver'),
      ('Logistica','lotes','baixar_lote'), ('Logistica','lotes','conferir'),
      ('Logistica','etapas','ver'), ('Logistica','indicadores','ver'),
      ('Logistica','expedicao','ver'), ('Logistica','expedicao','importar'),
      ('Logistica','mapa','ver'), ('Logistica','mapa','importar'), ('Logistica','mapa','enderecar'),
      ('Logistica','mapa','ajustar'),
      ('Logistica','inventario','ver'), ('Logistica','inventario','contar'),
      ('Logistica','veiculos','ver'), ('Logistica','veiculos','chamar'), ('Logistica','veiculos','checklist'),
      ('Producao','programacao','ver'), ('Producao','execucao','ver'),
      ('Producao','execucao','apontar'),
      ('Producao','etapas','ver'), ('Producao','indicadores','ver'),
      ('Producao','inventario','ver'), ('Producao','inventario','contar'),
      ('Qualidade','execucao','ver'), ('Qualidade','qualidade','ver'),
      ('Qualidade','qualidade','qualidade'),
      ('Qualidade','etapas','ver'), ('Qualidade','indicadores','ver'),
      -- Direção: só leitura, em tudo
      ('Direcao','ordens','ver'), ('Direcao','programacao','ver'),
      ('Direcao','lotes','ver'), ('Direcao','execucao','ver'),
      ('Direcao','qualidade','ver'), ('Direcao','agrotis','ver'),
      ('Direcao','etapas','ver'), ('Direcao','indicadores','ver'),
      ('Direcao','cadastros','ver'), ('Direcao','expedicao','ver'),
      ('Direcao','mrp','ver'), ('Direcao','mapa','ver'),
      ('Direcao','inventario','ver'),
      ('Direcao','veiculos','ver'),
      -- Balança: veículos e leitura do mapa
      ('Balanca','veiculos','ver'), ('Balanca','veiculos','chamar'), ('Balanca','veiculos','checklist'),
      ('Balanca','mapa','ver')
    ) as padrao(perfil, recurso, acao)
      where padrao.perfil = tsi.meu_perfil()::text
        and padrao.recurso = p_recurso and padrao.acao = p_acao),
    false  -- NUNCA null: chamador sem perfil (inclusive anônimo) é sempre "não pode"
  );
$$ language sql stable security definer set search_path = tsi, public;

-- ------------------------------------------------------------
-- 10. Trancas de anônimo (padrão do projeto)
-- ------------------------------------------------------------
revoke execute on function aplicar_inventario_no_mapa(uuid) from public, anon;
revoke execute on function ajustar_saldo_mapa(text, text, numeric, text, text, text, text) from public, anon;
grant execute on function aplicar_inventario_no_mapa(uuid) to authenticated, service_role;
grant execute on function ajustar_saldo_mapa(text, text, numeric, text, text, text, text) to authenticated, service_role;

-- realtime dos ajustes (a tela lista os últimos)
do $$ begin
  alter publication supabase_realtime add table mapa_ajustes;
exception when others then null; end $$;

-- ============================================================
-- Conferência
-- ============================================================
-- select column_name from information_schema.columns
--  where table_schema='tsi' and table_name='inventarios'
--    and column_name like 'aplicado%';                        -- 2 colunas
-- select count(*) from ordens where status='Finalizada' and mapa_lancado_em is null;  -- 0
-- select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--  where n.nspname='tsi' and proname in
--    ('aplicar_inventario_no_mapa','ajustar_saldo_mapa','fn_endereco_achado');  -- 3
-- select 'tem_acao com ajustar', position('ajustar' in prosrc) > 0
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname='tsi' and p.proname='tem_acao';
