-- ============================================================
-- CORREÇÃO URGENTE — aplicar assim que possível
-- Execute no SQL Editor do Supabase
-- ============================================================
--
-- Dois defeitos achados na revisão de 06/08/2026, ambos introduzidos pela
-- mudança do tanque por ordem.
--
-- 1. ORDEM EM ANDAMENTO NÃO RETOMA DE UMA PARADA
--    fn_valida_inicio exigia a distribuição em TODA entrada em 'Em producao',
--    e não só no início de verdade. Como `retomar_producao` sobe de 'Parada'
--    para 'Em producao', a trava disparava ali também: ordem iniciada antes
--    desta mudança (sem linhas em ordem_produtos) parava para o almoço e não
--    voltava. O mesmo valia para `voltar_para_producao`.
--    Correção: checar só na transição de início real
--    ('Nao programada'/'Programada' -> 'Em producao'), que é de onde o
--    confirmar_inicio sobe.
--
-- 2. TROCAR UM PRODUTO DE TANQUE APAGAVA PESO JÁ DIGITADO
--    A RPC remove o tanque que ficou sem produto. Se aquele tanque já tinha
--    leitura de balança, a leitura sumia em silêncio. Agora só some tanque
--    sem nenhum peso digitado — leitura de balança nunca é descartada como
--    efeito colateral.
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 1. A exigência de distribuição vale só no INÍCIO
-- ------------------------------------------------------------
create or replace function fn_valida_inicio() returns trigger as $$
declare falta int;
begin
  -- só o início de verdade: retomar de parada e voltar da finalização
  -- entram em 'Em producao' vindos de outros status e não passam por aqui
  if new.status = 'Em producao' and old.status in ('Nao programada','Programada') then
    select count(*) into falta
      from receita_itens ri
     where ri.receita_id = new.receita_id
       and not exists (
         select 1 from ordem_produtos op
          where op.ordem_id = new.id and op.produto_id = ri.produto_id);
    if falta > 0 then
      raise exception 'Falta definir o tanque de % produto(s)', falta;
    end if;

    select count(*) into falta from ordem_tanques t
      where t.ordem_id = new.id and t.peso_inicial is null;
    if falta > 0 then raise exception 'Peso inicial pendente em % tanque(s)', falta; end if;

    if (select status from lotes_semente where id = new.lote_id) = 'Em estoque' then
      raise exception 'Lote de semente nao baixado pelo estoque';
    end if;
  end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;

-- ------------------------------------------------------------
-- 2. Nunca descartar leitura de balança em silêncio
-- ------------------------------------------------------------
create or replace function definir_tanque_produto(
  p_ordem uuid,
  p_produto uuid,
  p_tanque int          -- null = desfaz a escolha
) returns void as $$
begin
  if not tem_acao('execucao','apontar') then
    raise exception 'Perfil sem permissao para apontar producao';
  end if;
  if (select status from tsi.ordens where id = p_ordem)
     not in ('Nao programada','Programada') then
    raise exception 'A ordem ja foi iniciada: a distribuicao nao pode mudar';
  end if;

  if p_tanque is null then
    delete from tsi.ordem_produtos
     where ordem_id = p_ordem and produto_id = p_produto;
  else
    insert into tsi.ordem_produtos (ordem_id, produto_id, tanque)
    values (p_ordem, p_produto, p_tanque)
    on conflict (ordem_id, produto_id) do update set tanque = excluded.tanque;

    insert into tsi.ordem_tanques (ordem_id, tanque)
    values (p_ordem, p_tanque)
    on conflict (ordem_id, tanque) do nothing;
  end if;

  -- tanque que ficou sem produto sai — MENOS se já tem peso digitado.
  -- Leitura de balança é dado do operador: some só se ele apagar.
  delete from tsi.ordem_tanques t
   where t.ordem_id = p_ordem
     and t.peso_inicial is null
     and t.peso_final is null
     and not exists (
       select 1 from tsi.ordem_produtos op
        where op.ordem_id = p_ordem and op.tanque = t.tanque);
end $$ language plpgsql security definer set search_path = tsi, public;

-- ------------------------------------------------------------
-- Conferência: quais ordens em andamento estão sem distribuição
-- (são as que a correção 1 destrava)
-- ------------------------------------------------------------
select o.numero, o.status::text, count(t.tanque) as tanques_montados
  from ordens o
  left join ordem_tanques t on t.ordem_id = o.id
 where o.status in ('Em producao','Parada')
   and not exists (select 1 from ordem_produtos op where op.ordem_id = o.id)
 group by o.numero, o.status
 order by o.numero;
