-- ============================================================
-- Correções da VARREDURA do mapa/carregamento — 30/08/2026
-- Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- Varredura adversarial (39 agentes) confirmou falhas; as de banco:
-- 1. salvar_carga_montada editava carga CARREGADA/FINALIZADA (corrompia o
--    desconto do mapa) e não validava saldo — corrida de dois loteamentos
--    simultâneos passava; autoria vinha do cliente.
-- 2. Desfazer "carregada" devolvia MAIS do que o desconto clampado tirou.
-- 3. Ordem apontada em embalagem diferente somava bags de unidades
--    diferentes na mesma linha do mapa.
-- 4. Dava pra "finalizar" carga sem carregada (e desfazer carregada de
--    carga finalizada) — sem invariante no banco.
-- 5. Substituição total da branca comparava relógio do TABLET com now()
--    do servidor gravado por gatilhos — lote fantasma/perdido.
-- 6. Logística tinha UPDATE irrestrito em cargas_montadas (era só pra
--    fotos) — inclusive carregada_em, que movimenta estoque via gatilho.
-- 7. tem_acao sem mapa/mrp no padrão de fábrica: "Restaurar padrão" da
--    Administração quebrava fotos e permissões do mapa em silêncio.
-- 8. RPCs novas nasceram com EXECUTE pra anon (padrão do Supabase).
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 1. RPC de gravação: guarda de marcos + trava de saldo + autoria
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

  return v_id;
end $$;

-- ------------------------------------------------------------
-- 2. Desconto do Carregada SIMÉTRICO: sem clamp — o desfazer devolve
--    exatamente o que o marco tirou (saldo pode ficar negativo no banco;
--    a tela só mostra bags > 0, e o upload/produção corrigem)
-- ------------------------------------------------------------
create or replace function fn_carga_carregada_desconta_mapa() returns trigger
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_sinal numeric;
  r record;
begin
  if old.carregada_em is null and new.carregada_em is not null then
    v_sinal := -1;
  elsif old.carregada_em is not null and new.carregada_em is null then
    v_sinal := 1;
  else
    return new;
  end if;
  for r in
    select i.lote_id, p.tratamento, i.bags
      from carga_montada_produtos p
      join carga_montada_itens i on i.produto_id = p.id
     where p.carga_id = new.id
  loop
    update lotes_mapa
       set bags = bags + v_sinal * r.bags,
           atualizado_em = now()
     where lote = r.lote_id and tratamento = r.tratamento;
  end loop;
  return new;
end $$;

-- ------------------------------------------------------------
-- 3. Ordem apontada em EMBALAGEM diferente: soma convertida pelo peso do
--    bag (20 MEIOBAG não viram 20 bags de linha BG5M)
-- ------------------------------------------------------------
create or replace function fn_lote_tratado_no_mapa() returns trigger
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_receita text;
  v_ls      lotes_semente%rowtype;
  v_emb     embalagens%rowtype;
  v_peso    numeric;
  v_bags    numeric;
begin
  select nome into v_receita from receitas where id = new.receita_id;
  if v_receita is null or upper(trim(v_receita)) = 'SEM TSI' then
    return new;
  end if;

  select * into v_ls from lotes_semente where id = new.lote_id;
  if not found then
    return new;
  end if;
  select * into v_emb from embalagens where codigo = new.embalagem;

  v_peso := coalesce(
    nullif(v_emb.peso_fixo_kg, 0),
    v_ls.pms * v_emb.fator_peso,
    v_ls.peso_bag_kg,
    0
  );
  v_bags := coalesce(new.bags_produzidos, new.bags);

  insert into lotes_mapa
    (lote, tratamento, cultivar, embalagem, pms, peso_bag_kg, bags,
     destinacao, classificacao, peneira, categoria, atualizado_em)
  values
    (new.lote_id, v_receita, v_ls.cultivar, new.embalagem, v_ls.pms,
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
       set bags = greatest(0, bags - (v_bags * v_peso / v_ls.peso_bag_kg)),
           atualizado_em = now()
     where lote = new.lote_id and tratamento = 'SEM TSI';
  end if;

  return new;
end $$;

-- ------------------------------------------------------------
-- 4. Invariante dos marcos: finalizada implica carregada (impede
--    finalizar sem carregar E desfazer carregada de carga finalizada)
-- ------------------------------------------------------------
alter table cargas_montadas drop constraint if exists carga_marco_ordem;
alter table cargas_montadas add constraint carga_marco_ordem
  check (finalizada_em is null or carregada_em is not null);

-- ------------------------------------------------------------
-- 5. Substituição total da BRANCA no servidor: por CONJUNTO, sem relógio
--    (o delete por timestamp do cliente perdia/preservava lote errado
--    quando um gatilho tocava a linha no meio do upload)
-- ------------------------------------------------------------
create or replace function substituir_brancas_mapa(p_lotes jsonb) returns integer
language plpgsql set search_path = tsi, public as $$
declare
  v_n integer := 0;
  r record;
begin
  for r in select value from jsonb_array_elements(coalesce(p_lotes, '[]'::jsonb)) loop
    insert into lotes_mapa
      (lote, tratamento, cultivar, embalagem, pms, peso_bag_kg, bags,
       destinacao, classificacao, peneira, categoria, atualizado_em)
    values
      (r.value->>'lote', 'SEM TSI', r.value->>'cultivar', r.value->>'embalagem',
       nullif(r.value->>'pms', '')::numeric,
       coalesce(nullif(r.value->>'peso_bag_kg', '')::numeric, 0),
       coalesce(nullif(r.value->>'bags', '')::numeric, 0),
       nullif(r.value->>'destinacao', ''), nullif(r.value->>'classificacao', ''),
       nullif(r.value->>'peneira', ''), nullif(r.value->>'categoria', ''), now())
    on conflict (lote, tratamento) do update
      set cultivar = excluded.cultivar,
          embalagem = excluded.embalagem,
          pms = excluded.pms,
          peso_bag_kg = excluded.peso_bag_kg,
          bags = excluded.bags,
          destinacao = excluded.destinacao,
          classificacao = excluded.classificacao,
          peneira = excluded.peneira,
          categoria = excluded.categoria,
          atualizado_em = now();
    v_n := v_n + 1;
  end loop;

  delete from lotes_mapa
   where tratamento = 'SEM TSI'
     and lote not in (
       select value->>'lote' from jsonb_array_elements(coalesce(p_lotes, '[]'::jsonb))
     );
  return v_n;
end $$;

-- ------------------------------------------------------------
-- 6. Fotos por RPC dedicada (só a coluna fotos, com a permissão certa) —
--    a policy de UPDATE irrestrito da Logística sai de cena
-- ------------------------------------------------------------
create or replace function salvar_fotos_carga(p_id uuid, p_fotos text[]) returns void
language plpgsql security definer set search_path = tsi, public as $$
begin
  if not (tem_acao('mapa','montar_carga') or tem_acao('mapa','enderecar')) then
    raise exception 'Perfil sem permissão para fotos da carga';
  end if;
  if coalesce(array_length(p_fotos, 1), 0) > 4 then
    raise exception 'No máximo 4 fotos por carga';
  end if;
  update cargas_montadas set fotos = coalesce(p_fotos, '{}') where id = p_id;
  if not found then
    raise exception 'carga não encontrada';
  end if;
end $$;

drop policy if exists log_fotos_cargas on cargas_montadas;

-- ------------------------------------------------------------
-- 7. tem_acao com mapa e mrp no padrão de fábrica (espelho de
--    MATRIZ_PADRAO em src/dominio/permissoes.ts — mudou um, mude o outro;
--    recria a função inteira: é o padrão deste projeto)
-- ------------------------------------------------------------
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
      ('PCP','veiculos','ver'), ('PCP','veiculos','chamar'), ('PCP','veiculos','checklist'),
      ('Logistica','programacao','ver'), ('Logistica','lotes','ver'),
      ('Logistica','lotes','baixar_lote'), ('Logistica','lotes','conferir'),
      ('Logistica','etapas','ver'), ('Logistica','indicadores','ver'),
      ('Logistica','expedicao','ver'), ('Logistica','expedicao','importar'),
      ('Logistica','mapa','ver'), ('Logistica','mapa','importar'), ('Logistica','mapa','enderecar'),
      ('Logistica','veiculos','ver'), ('Logistica','veiculos','chamar'), ('Logistica','veiculos','checklist'),
      ('Producao','programacao','ver'), ('Producao','execucao','ver'),
      ('Producao','execucao','apontar'),
      ('Producao','etapas','ver'), ('Producao','indicadores','ver'),
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
-- 8. Tranca as RPCs do mapa pra anônimo (o Supabase dá EXECUTE a PUBLIC
--    em toda função nova — padrão do projeto: revogar por função)
-- ------------------------------------------------------------
revoke execute on function salvar_carga_montada(uuid, jsonb, jsonb, uuid) from public, anon;
revoke execute on function enriquecer_tratados(jsonb) from public, anon;
revoke execute on function substituir_brancas_mapa(jsonb) from public, anon;
revoke execute on function salvar_fotos_carga(uuid, text[]) from public, anon;
grant execute on function salvar_carga_montada(uuid, jsonb, jsonb, uuid) to authenticated, service_role;
grant execute on function enriquecer_tratados(jsonb) to authenticated, service_role;
grant execute on function substituir_brancas_mapa(jsonb) to authenticated, service_role;
grant execute on function salvar_fotos_carga(uuid, text[]) to authenticated, service_role;

-- ============================================================
-- Conferência
-- ============================================================
-- select 'guarda de marcos', position('registro histórico' in prosrc) > 0
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname='tsi' and p.proname='salvar_carga_montada';
-- select 'tem_acao com mapa', position('mapa' in prosrc) > 0
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname='tsi' and p.proname='tem_acao';
-- select conname from pg_constraint where conname = 'carga_marco_ordem';
