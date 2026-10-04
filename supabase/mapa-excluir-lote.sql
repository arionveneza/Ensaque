-- ============================================================
-- Excluir um lote do mapa (04/10/2026, pedido do Arion: "não tem como fazer
-- o ajuste no mapa, não consigo por exemplo excluir um lote"). O Ajuste de
-- estoque só existia no topo do cartão do SAP, com busca, e zerar por ele
-- deixava os endereços para trás. Esta RPC zera o saldo da combinação, apaga
-- os endereços e deixa o rastro em mapa_ajustes (delta = −saldo, com motivo),
-- como o ajuste. A linha de lotes_mapa FICA com bags 0 — a mesma convenção da
-- carga carregada: some da tela (listarLotesMapa lê bags > 0) e uma contagem
-- ou produção posterior volta a somar nela.
--
-- Não mexe no inventário: se o lote foi CONTADO errado, o certo é excluir o
-- lançamento no inventário (ele tira do mapa junto). Isto aqui é para o lote
-- que saiu do galpão ou que não devia estar no mapa.
-- ============================================================

create or replace function tsi.excluir_lote_mapa(p_lote text, p_tratamento text, p_motivo text)
returns void
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_lm lotes_mapa%rowtype;
begin
  if not tem_acao('mapa','ajustar') then
    raise exception 'Perfil sem permissão para ajustar o estoque do mapa';
  end if;
  if coalesce(btrim(p_motivo), '') = '' then
    raise exception 'o motivo da exclusão é obrigatório';
  end if;

  select * into v_lm from lotes_mapa
   where lote = p_lote and tratamento = p_tratamento
   for update;
  if not found then
    raise exception 'combinação % · % não existe no mapa', p_lote, p_tratamento;
  end if;

  if v_lm.bags <> 0 then
    insert into mapa_ajustes (lote, tratamento, delta, motivo, saldo_depois)
    values (p_lote, p_tratamento, -v_lm.bags, 'Excluído do mapa: ' || btrim(p_motivo), 0);
  end if;

  delete from lote_enderecos where lote = p_lote and tratamento = p_tratamento;
  update lotes_mapa
     set bags = 0, nao_encontrado_inventario_em = null, atualizado_em = now()
   where lote = p_lote and tratamento = p_tratamento;
end $$;

revoke execute on function tsi.excluir_lote_mapa(text, text, text) from public, anon;
grant execute on function tsi.excluir_lote_mapa(text, text, text) to authenticated, service_role;

-- Ajuste que ZERA o saldo também tira os endereços (mesmo dia): o Arion
-- zerou dois lotes pelo Ajuste e o endereço de um ficou lá — a linha some
-- da tela, mas a próxima produção do mesmo lote+tratamento reacenderia o
-- lote no endereço velho. Base: a definição vigente
-- (inventario-mapa-ajuste-reserva.sql); só o bloco "zerou" é novo.
create or replace function tsi.ajustar_saldo_mapa(p_lote text, p_tratamento text, p_delta numeric, p_motivo text, p_armazem text, p_bloco text, p_quadra text)
 returns numeric
 language plpgsql
 security definer
 set search_path to 'tsi', 'public'
as $function$
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
       and bloco  = coalesce(numero_endereco(p_bloco, 44), upper(btrim(p_bloco)), '')
       and quadra = coalesce(numero_endereco(p_quadra, 20), upper(btrim(p_quadra)), '')
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

  -- zerou: lote sem saldo não tem lugar no galpão
  if v_novo <= 0.0001 then
    delete from lote_enderecos where lote = p_lote and tratamento = p_tratamento;
  end if;

  insert into mapa_ajustes (lote, tratamento, delta, motivo, armazem, bloco, quadra, saldo_depois)
  values (p_lote, p_tratamento, p_delta, btrim(p_motivo),
          nullif(upper(btrim(p_armazem)), ''), nullif(upper(btrim(p_bloco)), ''),
          nullif(upper(btrim(p_quadra)), ''), v_novo);

  return v_novo;
end $function$;

-- limpa o endereço que ficou de lote já zerado
delete from tsi.lote_enderecos e
 using tsi.lotes_mapa lm
 where lm.lote = e.lote and lm.tratamento = e.tratamento and lm.bags <= 0.0001;

-- Conferência
select json_build_object(
  'funcao', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'tsi' and p.proname = 'excluir_lote_mapa'),
  'grants', (select json_agg(grantee::text) from information_schema.routine_privileges
              where routine_schema = 'tsi' and routine_name = 'excluir_lote_mapa'),
  'enderecos_de_lote_zerado', (select count(*) from tsi.lote_enderecos e join tsi.lotes_mapa lm
              on lm.lote = e.lote and lm.tratamento = e.tratamento where lm.bags <= 0.0001),
  'mapa', (select json_agg(json_build_object('lote', lote, 'trat', tratamento, 'bags', bags)) from tsi.lotes_mapa)
) as conferencia;
