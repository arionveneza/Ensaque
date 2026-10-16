-- TSI Entrada/Saída: sobra que arredonda pra 0,00 não pode ir pro banco
-- (16/10/2026, achado do Arion: "a produção não está conseguindo finalizar as
-- produções, dá erro" — "new row for relation lote_enderecos violates check
-- constraint lote_enderecos_bags_check" ao confirmar a finalização da 176532).
--
-- Causa: lote_enderecos.bags é numeric(10,2) com CHECK bags > 0. A baixa pôs
-- 412,5 ÷ 413 = 0,9988 bag no TSI ENTRADA (gravado 1,00); na Finalizada o
-- consumo tirou os mesmos 0,9988 e sobrou 0,0012 — acima do 0,0001 que o
-- mapa_tsi_somar usava pra "zerou", mas 0,00 na coluna → o UPDATE violava o
-- CHECK e a ordem não finalizava. Mesma régua no baixar_lote (sobra do
-- endereço A–E de origem).
--
-- Correção: arredondar na escala da coluna ANTES de comparar com zero, nas
-- duas funções (bases: definições VIVAS via pg_get_functiondef). Nada mais
-- muda; nenhuma view.
set search_path = tsi, public;

CREATE OR REPLACE FUNCTION tsi.mapa_tsi_somar(p_lote text, p_trat text, p_tsi text, p_delta numeric)
 RETURNS numeric
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tsi', 'public'
AS $function$
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
    -- (16/10/2026) a coluna é numeric(10,2): o que arredonda pra 0,00 não
    -- vira linha — o CHECK bags > 0 recusaria
    if round(p_delta, 2) <= 0 then return 0; end if;
    insert into lote_enderecos (lote, tratamento, armazem, bloco, quadra, bags, criado_por)
    values (p_lote, p_trat, p_tsi, '0', '0', round(p_delta, 2), auth.uid());
    return round(p_delta, 2);
  end if;
  -- (16/10/2026) arredonda na escala da coluna ANTES de comparar com zero:
  -- 1,00 − 412,5/413 = 0,0012 passava do 0,0001 e ia pro update como 0,00
  -- → "violates check constraint lote_enderecos_bags_check" na Finalizada
  v_bags := round(coalesce(v_bags, 0) + p_delta, 2);
  if v_bags <= 0 then
    delete from lote_enderecos where id = v_id;
    return 0;
  end if;
  update lote_enderecos set bags = v_bags where id = v_id;
  return v_bags;
end $function$;
revoke execute on function tsi.mapa_tsi_somar(text, text, text, numeric) from public, anon, authenticated;

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
        -- (16/10/2026) mesma régua do mapa_tsi_somar: compara na escala da
        -- coluna (2 casas) — sobra que arredonda pra 0,00 apaga a linha
        if round(e.bags - v_take, 2) <= 0 then
          delete from lote_enderecos where id = e.id;
        else
          update lote_enderecos set bags = round(bags - v_take, 2) where id = e.id;
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

-- conferência: as duas funções com a régua nova e nenhuma linha TSI/A–E com
-- sobra que arredonde pra zero
select json_build_object(
  'somar_ok', (select pg_get_functiondef(p.oid) like '%round(coalesce(v_bags, 0) + p_delta, 2)%' from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='tsi' and p.proname='mapa_tsi_somar'),
  'baixar_ok', (select pg_get_functiondef(p.oid) like '%round(e.bags - v_take, 2) <= 0%' from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname='tsi' and p.proname='baixar_lote'),
  'enderecos_zero', (select count(*) from lote_enderecos where bags is not null and bags <= 0),
  'tsi_linhas', (select count(*) from lote_enderecos where armazem in ('TSI ENTRADA','TSI SAIDA'))
) as conferencia;
