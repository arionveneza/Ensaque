-- ============================================================
-- Armazéns "TSI Entrada" e "TSI Saída" (14/10/2026, pedido do Arion: "crie um
-- armazém chamado TSI Entrada e TSI Saída; todo lote branco a ser tratado
-- será enviado ao TSI Entrada, e todo lote apontado como produzido
-- automaticamente vai para o TSI Saída, permitindo que o PCP lance as ordens
-- no AGROTIS mesmo sem a conferência da Logística — hoje a conferência é um
-- gargalo"). Decisões dele: a branca vai pro TSI Entrada NA BAIXA da
-- Logística, só os bags das ordens liberadas; a conferência continua
-- (contar + endereçar = tirar do TSI Saída) mas não trava mais o AGROTIS;
-- lote em TSI Saída pode ser loteado em carga.
--
-- 1. lote_enderecos aceita os dois armazéns de sistema (bloco/quadra '0').
-- 2. mapa_movimentos_tsi: rastro por ordem (base do estorno e da auditoria).
-- 3. baixar_lote: os bags DO LOTE que cada ordem liberada vai consumir saem
--    do(s) endereço(s) A–E da branca e entram no TSI ENTRADA.
-- 4. estornar_liberacao: devolve pelo rastro.
-- 5. fn_lote_tratado_no_mapa: o tratado nasce no TSI SAIDA; a branca
--    consumida sai do TSI ENTRADA; o "Voltar para produção" desfaz.
-- 6. fn_valida_agrotis: não exige mais a conferência (só os pesos finais).
-- 7. conferir_e_enderecar: conferência + endereço numa transação, tirando
--    do TSI SAIDA; enderecar_conferencia (A endereçar) idem.
-- 8. fn_endereco_achado ignora endereço TSI.
-- 9. Backfill: tratado com saldo e sem endereço vira TSI SAIDA.
-- Bases: definições VIVAS (pg_get_functiondef) de 14/10/2026.
-- ============================================================

set search_path = tsi, public;

-- ---------- 1. endereço de sistema ----------
alter table lote_enderecos drop constraint if exists lote_enderecos_endereco_valido;
alter table lote_enderecos add constraint lote_enderecos_endereco_valido check (
  (armazem in ('A','B','C','D','E')
     and bloco ~ '^([1-9]|[1-3][0-9]|4[0-4])$'
     and quadra ~ '^([1-9]|1[0-9]|20)$')
  or (armazem in ('TSI ENTRADA','TSI SAIDA') and bloco = '0' and quadra = '0')
);
comment on constraint lote_enderecos_endereco_valido on lote_enderecos is
  'A–E/1–44/1–20 pra endereço físico; TSI ENTRADA/TSI SAIDA (bloco e quadra 0) são os armazéns do sistema (14/10/2026) — só o banco grava.';

-- ---------- 2. rastro ----------
create table if not exists mapa_movimentos_tsi (
  id uuid primary key default gen_random_uuid(),
  ordem_id uuid references ordens(id) on delete set null,
  lote text not null,
  tratamento text not null,
  -- entrada: branca → TSI ENTRADA (baixa) · estorno: volta · consumo: branca
  -- sai do TSI ENTRADA (Finalizada) · saida: tratado → TSI SAIDA · enderecado:
  -- tratado sai do TSI SAIDA (conferência) · desfeito: Voltar para produção
  sentido text not null check (sentido in ('entrada','estorno','consumo','saida','enderecado','desfeito')),
  de_armazem text, de_bloco text, de_quadra text,
  para_armazem text, para_bloco text, para_quadra text,
  bags numeric(12,3) not null,
  usuario_id uuid references usuarios(id),
  ts timestamptz not null default now()
);
create index if not exists mapa_movimentos_tsi_lote on mapa_movimentos_tsi (lote, tratamento);
create index if not exists mapa_movimentos_tsi_ordem on mapa_movimentos_tsi (ordem_id);
alter table mapa_movimentos_tsi enable row level security;
drop policy if exists ler_mov_tsi on mapa_movimentos_tsi;
create policy ler_mov_tsi on mapa_movimentos_tsi for select using (tem_acao('mapa','ver'));
-- escrita só pelas funções DEFINER
revoke insert, update, delete, truncate, references, trigger on mapa_movimentos_tsi from anon, authenticated;
grant select on mapa_movimentos_tsi to authenticated;

-- ---------- helper: soma/subtrai bags num armazém TSI (apaga quando zera) ----------
create or replace function tsi.mapa_tsi_somar(p_lote text, p_trat text, p_tsi text, p_delta numeric)
returns numeric
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_id uuid;
  v_bags numeric;
begin
  if p_delta is null or p_delta = 0 then return null; end if;
  -- o endereço tem FK pro mapa: combinação que não está lá não ganha TSI
  if not exists (select 1 from lotes_mapa where lote = p_lote and tratamento = p_trat) then
    return null;
  end if;
  select id, bags into v_id, v_bags from lote_enderecos
   where lote = p_lote and tratamento = p_trat and armazem = p_tsi and bloco = '0' and quadra = '0'
   for update;
  if not found then
    if p_delta <= 0 then return 0; end if;
    insert into lote_enderecos (lote, tratamento, armazem, bloco, quadra, bags, criado_por)
    values (p_lote, p_trat, p_tsi, '0', '0', p_delta, auth.uid());
    return p_delta;
  end if;
  v_bags := coalesce(v_bags, 0) + p_delta;
  if v_bags <= 0.0001 then
    delete from lote_enderecos where id = v_id;
    return 0;
  end if;
  update lote_enderecos set bags = v_bags where id = v_id;
  return v_bags;
end $$;
revoke execute on function tsi.mapa_tsi_somar(text, text, text, numeric) from public, anon, authenticated;

-- ---------- 3. baixar_lote: branca → TSI ENTRADA ----------
CREATE OR REPLACE FUNCTION tsi.baixar_lote(p_lote text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tsi', 'public'
AS $function$
declare
  v_bags numeric := 0;
  v_peso_t numeric := 0;
  v_ls lotes_semente%rowtype;
  v_lote_base text;
  v_tem_branca boolean;
  r record;
  e record;
  v_kg numeric;
  v_n numeric;
  v_rest numeric;
  v_take numeric;
  v_de_arm text; v_de_bloco text; v_de_quadra text;
begin
  if not pode_baixar_lote() then
    raise exception 'Perfil sem permissao para baixar lote';
  end if;

  select * into v_ls from lotes_semente where id = p_lote;
  if not found then
    raise exception 'Lote % nao encontrado', p_lote;
  end if;
  v_lote_base := regexp_replace(upper(btrim(p_lote)), '(-\d+)+$', '');
  v_tem_branca := exists (select 1 from lotes_mapa where lote = v_lote_base and tratamento = 'SEM TSI');

  for r in
    update tsi.ordens
       set lote_liberado_em = now(), lote_liberado_por = auth.uid()
     where lote_id = p_lote
       and lote_liberado_em is null
       and maquina_id is not null
       and confirmada_em is not null
       and status not in ('Em producao','Parada','Finalizada','Qualidade apontada','Apontada')
    returning id, bags, embalagem, peso_semente_kg
  loop
    select coalesce(r.peso_semente_kg,
             r.bags * coalesce(nullif(emb.peso_fixo_kg, 0), nullif(v_ls.pms * emb.fator_peso, 0), v_ls.peso_bag_kg))
      into v_kg
      from tsi.embalagens emb where emb.codigo = r.embalagem;
    v_kg := coalesce(v_kg, 0);
    v_bags := v_bags + r.bags;
    v_peso_t := v_peso_t + v_kg / 1000.0;

    -- TSI Entrada (14/10/2026): os bags DO LOTE que a ordem vai consumir
    -- saem do(s) endereço(s) A–E da branca (do maior pro menor, só os com
    -- quantidade — endereço sem contagem fica, o rateio da tela ajusta) e
    -- entram no TSI ENTRADA. O saldo do mapa não muda: a branca ainda está
    -- no galpão, só mudou de lugar.
    v_n := case when coalesce(v_ls.peso_bag_kg, 0) > 0 then v_kg / v_ls.peso_bag_kg else 0 end;
    v_de_arm := null; v_de_bloco := null; v_de_quadra := null;
    if v_tem_branca and v_n > 0 then
      v_rest := v_n;
      for e in
        select id, armazem, bloco, quadra, bags from lote_enderecos
         where lote = v_lote_base and tratamento = 'SEM TSI'
           and armazem not in ('TSI ENTRADA','TSI SAIDA')
           and bags is not null and bags > 0
         order by bags desc
      loop
        exit when v_rest <= 0.0001;
        v_take := least(e.bags, v_rest);
        if e.bags - v_take <= 0.0001 then
          delete from lote_enderecos where id = e.id;
        else
          update lote_enderecos set bags = bags - v_take where id = e.id;
        end if;
        v_rest := v_rest - v_take;
        if v_de_arm is null then
          v_de_arm := e.armazem; v_de_bloco := e.bloco; v_de_quadra := e.quadra;
        end if;
      end loop;
      if v_de_arm is null then
        select armazem, bloco, quadra into v_de_arm, v_de_bloco, v_de_quadra from lote_enderecos
         where lote = v_lote_base and tratamento = 'SEM TSI'
           and armazem not in ('TSI ENTRADA','TSI SAIDA')
         order by bags desc nulls last limit 1;
      end if;
      perform mapa_tsi_somar(v_lote_base, 'SEM TSI', 'TSI ENTRADA', v_n);
    end if;
    insert into mapa_movimentos_tsi
      (ordem_id, lote, tratamento, sentido, de_armazem, de_bloco, de_quadra, para_armazem, para_bloco, para_quadra, bags, usuario_id)
    values
      (r.id, v_lote_base, 'SEM TSI', 'entrada', v_de_arm, v_de_bloco, v_de_quadra, 'TSI ENTRADA', '0', '0', v_n, auth.uid());
  end loop;

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

-- ---------- 4. estornar_liberacao: devolve pelo rastro ----------
CREATE OR REPLACE FUNCTION tsi.estornar_liberacao(p_ordem uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tsi', 'public'
AS $function$
declare
  v_lote text;
  v_bags numeric;
  r record;
begin
  if not pode_baixar_lote() then
    raise exception 'Perfil sem permissao para estornar liberacao';
  end if;

  update tsi.ordens
     set lote_liberado_em = null, lote_liberado_por = null
   where id = p_ordem
     and lote_liberado_em is not null
     and status not in ('Em producao','Parada','Finalizada','Qualidade apontada','Apontada')
  returning lote_id, bags into v_lote, v_bags;

  if v_lote is null then
    raise exception 'Ordem nao esta liberada (ou ja foi iniciada) — nao ha o que estornar';
  end if;

  -- tg_baixa_so_pela_rpc (matriz-permissoes-no-banco.sql) recusa qualquer
  -- update de status/baixado_* em lotes_semente fora desta flag de sessao.
  perform set_config('tsi.baixa_via_rpc', '1', true);

  -- o lote só volta a 'Em estoque' se NENHUMA outra ordem dele continuar
  -- liberada — senão ele continua fazendo sentido estar 'Baixado'.
  update tsi.lotes_semente
     set status = 'Em estoque', baixado_por = null, baixado_em = null, devolver = false
   where id = v_lote
     and not exists (
       select 1 from tsi.ordens where lote_id = v_lote and lote_liberado_em is not null
     );

  insert into tsi.lote_movimentos (lote_id, bags, estorno, usuario_id)
  values (v_lote, -v_bags, true, auth.uid());

  -- TSI Entrada (14/10/2026): o que a baixa desta ordem moveu volta pro
  -- endereço de origem (ou fica só no saldo, sem endereço, se a origem
  -- não se sabe); a linha de rastro 'entrada' vira 'estorno'
  for r in
    select * from mapa_movimentos_tsi where ordem_id = p_ordem and sentido = 'entrada' and bags > 0
  loop
    perform mapa_tsi_somar(r.lote, 'SEM TSI', 'TSI ENTRADA', -r.bags);
    if r.de_armazem is not null
       and exists (select 1 from lotes_mapa where lote = r.lote and tratamento = 'SEM TSI') then
      insert into lote_enderecos (lote, tratamento, armazem, bloco, quadra, bags, criado_por)
      values (r.lote, 'SEM TSI', r.de_armazem, r.de_bloco, r.de_quadra, r.bags, auth.uid())
      on conflict (lote, tratamento, armazem, bloco, quadra) do update
        set bags = case when lote_enderecos.bags is null then null
                        else lote_enderecos.bags + excluded.bags end;
    end if;
    insert into mapa_movimentos_tsi
      (ordem_id, lote, tratamento, sentido, de_armazem, de_bloco, de_quadra, para_armazem, para_bloco, para_quadra, bags, usuario_id)
    values
      (p_ordem, r.lote, 'SEM TSI', 'estorno', 'TSI ENTRADA', '0', '0', r.de_armazem, r.de_bloco, r.de_quadra, r.bags, auth.uid());
    delete from mapa_movimentos_tsi where id = r.id;
  end loop;
end $function$;

-- ---------- 5. fn_lote_tratado_no_mapa: tratado → TSI SAIDA, branca sai do TSI ENTRADA ----------
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
  v_peso_mapa numeric;
  v_bags_mapa numeric;
  v_branca_bags numeric;
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
  -- bags NA UNIDADE da linha do mapa (embalagem diferente converte pelo peso)
  select peso_bag_kg into v_peso_mapa from lotes_mapa where lote = v_lote and tratamento = v_receita;
  v_bags_mapa := case when coalesce(v_peso_mapa, 0) > 0 and v_peso > 0 and v_peso_mapa <> v_peso
                      then v_bags * v_peso / v_peso_mapa else v_bags end;
  v_branca_bags := case when v_ls.peso_bag_kg > 0 and v_kg > 0 then v_kg / v_ls.peso_bag_kg else 0 end;

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

    -- 1b. TSI Saída (14/10/2026): o produzido nasce com endereço de sistema —
    --     a Logística tira de lá quando confere e endereça
    perform mapa_tsi_somar(v_lote, v_receita, 'TSI SAIDA', v_bags_mapa);
    insert into mapa_movimentos_tsi (ordem_id, lote, tratamento, sentido, para_armazem, para_bloco, para_quadra, bags, usuario_id)
    values (v_row.id, v_lote, v_receita, 'saida', 'TSI SAIDA', '0', '0', v_bags_mapa, auth.uid());

    -- 2. a BRANCA consumida sai do mapa (em bags DO LOTE), sem clamp
    if v_branca_bags > 0 then
      update lotes_mapa
         set bags = bags - v_branca_bags,
             atualizado_em = now()
       where lote = v_lote and tratamento = 'SEM TSI';
      -- 2b. e sai do TSI ENTRADA (o que a baixa pôs lá); sobra fica pra
      --     Logística devolver ao armazém
      perform mapa_tsi_somar(v_lote, 'SEM TSI', 'TSI ENTRADA', -v_branca_bags);
      insert into mapa_movimentos_tsi (ordem_id, lote, tratamento, sentido, de_armazem, de_bloco, de_quadra, bags, usuario_id)
      values (v_row.id, v_lote, 'SEM TSI', 'consumo', 'TSI ENTRADA', '0', '0', v_branca_bags, auth.uid());
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
    perform mapa_tsi_somar(v_lote, v_receita, 'TSI SAIDA', -v_bags_mapa);

    if v_branca_bags > 0 then
      update lotes_mapa
         set bags = bags + v_branca_bags,
             atualizado_em = now()
       where lote = v_lote and tratamento = 'SEM TSI';
      perform mapa_tsi_somar(v_lote, 'SEM TSI', 'TSI ENTRADA', v_branca_bags);
    end if;
    insert into mapa_movimentos_tsi (ordem_id, lote, tratamento, sentido, de_armazem, de_bloco, de_quadra, bags, usuario_id)
    values (v_row.id, v_lote, v_receita, 'desfeito', 'TSI SAIDA', '0', '0', v_bags_mapa, auth.uid());

    delete from ordem_mapa_lancado where ordem_id = v_row.id;
  end if;

  return new;
end $function$;

-- ---------- 6. AGROTIS não espera mais a conferência ----------
CREATE OR REPLACE FUNCTION tsi.fn_valida_agrotis()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'tsi', 'public'
AS $function$
declare falta int;
begin
  if new.status = 'Apontada' and old.status is distinct from 'Apontada' then
    -- 14/10/2026 (decisão do Arion): a conferência da Logística deixou de
    -- ser pré-requisito — o produzido já está no mapa, em TSI SAIDA; a
    -- Logística confere e endereça no tempo dela. Fica só o peso final.
    select count(*) into falta from ordem_tanques t
      where t.ordem_id = new.id and t.peso_final is null;
    if falta > 0 then
      raise exception 'Lancamento no AGROTIS exige o peso final de todos os tanques (% pendente(s))', falta;
    end if;
  end if;
  return new;
end $function$;

-- ---------- 7. conferência + endereço numa transação, tirando do TSI SAIDA ----------
create or replace function tsi.conferir_e_enderecar(
  p_ordem uuid,
  p_bags integer,
  p_obs text,
  p_armazem text,
  p_bloco text,
  p_quadra text,
  p_enderecar_depois boolean
) returns void
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_o ordens%rowtype;
  v_receita text;
  v_lote text;
  v_tratado boolean;
  v_prod numeric;
begin
  if not tem_acao('lotes','conferir') then
    raise exception 'Perfil sem permissão para conferir estoque';
  end if;
  if p_bags is null or p_bags < 0 then
    raise exception 'Informe a quantidade de bags contados (0 ou mais)';
  end if;
  select * into v_o from ordens where id = p_ordem for update;
  if not found then
    raise exception 'ordem não encontrada';
  end if;
  if v_o.status not in ('Finalizada','Qualidade apontada','Apontada') then
    raise exception 'a ordem ainda não foi finalizada pela produção';
  end if;
  select nome into v_receita from receitas where id = v_o.receita_id;
  v_tratado := v_receita is not null and upper(trim(v_receita)) <> 'SEM TSI';
  v_lote := regexp_replace(upper(btrim(v_o.lote_id)), '(-\d+)+$', '');

  insert into ordem_conferencias (ordem_id, bags_contados, observacao, conferido_por, ts, enderecar_depois)
  values (p_ordem, p_bags, p_obs, auth.uid(), now(), v_tratado and p_enderecar_depois and p_bags > 0)
  on conflict (ordem_id) do update
    set bags_contados = excluded.bags_contados,
        observacao = excluded.observacao,
        conferido_por = excluded.conferido_por,
        ts = excluded.ts,
        enderecar_depois = excluded.enderecar_depois;

  -- endereçamento embutido: o tratado sai do TSI SAIDA (o que a produção
  -- apontou) e entra no endereço contado; ordem SEM TSI não endereça
  if v_tratado and p_bags > 0 and not p_enderecar_depois then
    if nullif(btrim(coalesce(p_armazem, '')), '') is null then
      raise exception 'informe armazém, bloco e quadra — ou marque ENDEREÇAR pra endereçar depois';
    end if;
    if exists (select 1 from lotes_mapa where lote = v_lote and tratamento = v_receita) then
      insert into lote_enderecos (lote, tratamento, armazem, bloco, quadra, bags, criado_por)
      values (v_lote, v_receita, p_armazem, p_bloco, p_quadra, p_bags, auth.uid())
      on conflict (lote, tratamento, armazem, bloco, quadra) do update
        set bags = case when lote_enderecos.bags is null then null
                        else lote_enderecos.bags + excluded.bags end;
      v_prod := coalesce(v_o.bags_produzidos, v_o.bags);
      perform mapa_tsi_somar(v_lote, v_receita, 'TSI SAIDA', -v_prod);
      insert into mapa_movimentos_tsi
        (ordem_id, lote, tratamento, sentido, de_armazem, de_bloco, de_quadra, para_armazem, para_bloco, para_quadra, bags, usuario_id)
      values
        (p_ordem, v_lote, v_receita, 'enderecado', 'TSI SAIDA', '0', '0', upper(btrim(p_armazem)), p_bloco, p_quadra, v_prod, auth.uid());
    end if;
  end if;
end $$;
revoke execute on function tsi.conferir_e_enderecar(uuid, integer, text, text, text, text, boolean) from public, anon;
grant execute on function tsi.conferir_e_enderecar(uuid, integer, text, text, text, text, boolean) to authenticated;

-- A endereçar (ENDEREÇAR na conferência): mesma saída do TSI SAIDA. Vira
-- DEFINER com a checagem explícita (antes INVOKER pelas policies, que dão o
-- mesmo resultado: lotes/conferir) — o helper do TSI é só do dono.
CREATE OR REPLACE FUNCTION tsi.enderecar_conferencia(p_ordem uuid, p_armazem text, p_bloco text, p_quadra text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tsi', 'public'
AS $function$
declare
  v_lote text;
  v_trat text;
  v_bags integer;
  v_prod numeric;
begin
  if not tem_acao('lotes','conferir') then
    raise exception 'Perfil sem permissão para endereçar a conferência';
  end if;
  select regexp_replace(upper(btrim(o.lote_id)), '(-\d+)+$', ''), r.nome, c.bags_contados,
         coalesce(o.bags_produzidos, o.bags)
    into v_lote, v_trat, v_bags, v_prod
    from ordem_conferencias c
    join ordens o on o.id = c.ordem_id
    join receitas r on r.id = o.receita_id
   where c.ordem_id = p_ordem
     and c.enderecar_depois
     and c.enderecado_em is null
     for update of c;
  if not found then
    raise exception 'Esta ordem não está mais pendente de endereço (outra pessoa já endereçou?)';
  end if;

  if nullif(btrim(coalesce(p_armazem, '')), '') is not null and v_bags > 0 then
    -- o gatilho tg_endereco_normaliza roda antes do teste de conflito,
    -- então "06" e "6" caem no mesmo endereço
    insert into lote_enderecos (lote, tratamento, armazem, bloco, quadra, bags, criado_por)
    values (v_lote, v_trat, p_armazem, p_bloco, p_quadra, v_bags, auth.uid())
    on conflict (lote, tratamento, armazem, bloco, quadra) do update
      set bags = case when lote_enderecos.bags is null then null
                      else lote_enderecos.bags + excluded.bags end;
    perform mapa_tsi_somar(v_lote, v_trat, 'TSI SAIDA', -v_prod);
    insert into mapa_movimentos_tsi
      (ordem_id, lote, tratamento, sentido, de_armazem, de_bloco, de_quadra, para_armazem, para_bloco, para_quadra, bags, usuario_id)
    values
      (p_ordem, v_lote, v_trat, 'enderecado', 'TSI SAIDA', '0', '0', upper(btrim(p_armazem)), p_bloco, p_quadra, v_prod, auth.uid());
  end if;

  update ordem_conferencias
     set enderecado_em = now(), enderecado_por = auth.uid()
   where ordem_id = p_ordem;
end $function$;
revoke execute on function tsi.enderecar_conferencia(uuid, text, text, text) from public, anon;
grant execute on function tsi.enderecar_conferencia(uuid, text, text, text) to authenticated;

-- ---------- 8. endereço TSI não "acha" lote marcado no inventário ----------
CREATE OR REPLACE FUNCTION tsi.fn_endereco_achado()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tsi', 'public'
AS $function$
declare
  v_pendente boolean;
begin
  -- TSI ENTRADA/TSI SAIDA (14/10/2026) são endereço do sistema, não do físico
  if new.armazem in ('TSI ENTRADA','TSI SAIDA') then
    return new;
  end if;
  -- mesma régua do recontar_inventario, mas sem o id do resultado à mão
  -- (o gatilho só vê lote+tratamento do endereço) — usa o inventário
  -- APLICADO mais recente como referência.
  select exists (
    select 1
      from inventario_resultados ir
     where ir.inventario_id = (
             select id from inventarios
              where aplicado_em is not null
              order by aplicado_em desc
              limit 1
           )
       and ir.lote = new.lote and ir.tratamento = new.tratamento
       and ir.bags_contados is null
  ) into v_pendente;

  if not v_pendente then
    update lotes_mapa set nao_encontrado_inventario_em = null
     where lote = new.lote and tratamento = new.tratamento
       and nao_encontrado_inventario_em is not null;
  end if;
  return new;
end $function$;

-- ---------- 9. backfill: tratado com saldo e sem endereço → TSI SAIDA ----------
create temp table tmp_backfill on commit drop as
select m.lote, m.tratamento, m.bags
  from lotes_mapa m
 where m.tratamento <> 'SEM TSI' and m.bags > 0
   and not exists (select 1 from lote_enderecos e where e.lote = m.lote and e.tratamento = m.tratamento);
insert into lote_enderecos (lote, tratamento, armazem, bloco, quadra, bags)
select lote, tratamento, 'TSI SAIDA', '0', '0', bags from tmp_backfill;

-- Conferência
select json_build_object(
  'check', (select pg_get_constraintdef(oid) from pg_constraint where conname = 'lote_enderecos_endereco_valido'),
  'funcoes', (select json_agg(p.proname order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'tsi' and p.proname in ('mapa_tsi_somar','conferir_e_enderecar','enderecar_conferencia','baixar_lote','estornar_liberacao','fn_lote_tratado_no_mapa','fn_valida_agrotis','fn_endereco_achado')),
  'agrotis_sem_conferencia', position('ordem_conferencias' in pg_get_functiondef('tsi.fn_valida_agrotis()'::regprocedure)) = 0,
  'backfill_tsi_saida', (select json_build_object('combinacoes', count(*), 'bags', coalesce(sum(bags), 0)) from tmp_backfill),
  'em_tsi', (select json_agg(json_build_object('armazem', armazem, 'n', n, 'bags', bags)) from (select armazem, count(*) n, sum(bags) bags from tsi.lote_enderecos where armazem like 'TSI %' group by armazem) x),
  'tratados_sem_endereco_depois', (select count(*) from tsi.lotes_mapa m where m.tratamento <> 'SEM TSI' and m.bags > 0 and not exists (select 1 from tsi.lote_enderecos e where e.lote = m.lote and e.tratamento = m.tratamento)),
  'rastro_tabela', (select count(*) from information_schema.tables where table_schema = 'tsi' and table_name = 'mapa_movimentos_tsi')
) as conferencia;
