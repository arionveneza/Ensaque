-- ============================================================
-- O tanque sai da receita e passa a ser decisão da ORDEM
-- Execute no SQL Editor do Supabase
-- APLICAR DEPOIS de matriz-permissoes-no-banco.sql (usa tem_acao)
-- ============================================================
--
-- ⚠️ APAGA a coluna `tanque` das receitas. Não tem desfazer.
--
-- Decisão de 05/08/2026: a distribuição dos produtos nos tanques varia de
-- ordem para ordem, então a receita passa a ser só PRODUTO + DOSE. Quem
-- informa o tanque é o operador, ao preparar a ordem, antes dos pesos.
--
-- `ordem_produtos` guarda essa escolha. A chave primária (ordem, produto)
-- garante que um produto vai a UM destino só por ordem.
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 1. Alocação produto → tanque, por ordem
-- ------------------------------------------------------------
create table if not exists ordem_produtos (
  ordem_id   uuid not null references ordens(id) on delete cascade,
  produto_id uuid not null references produtos_quimicos(id),
  tanque     int  not null check (tanque between 0 and 5),  -- 0 = transferidor
  primary key (ordem_id, produto_id)
);
create index if not exists ordem_produtos_ordem on ordem_produtos (ordem_id);

-- RLS no padrão novo: quem pode apontar produção mexe na distribuição.
-- Leitura para todo usuário ativo, como nas demais tabelas da ordem.
alter table ordem_produtos enable row level security;
drop policy if exists ler_op on ordem_produtos;
create policy ler_op on ordem_produtos for select using (meu_perfil() is not null);
drop policy if exists op_all on ordem_produtos;
create policy op_all on ordem_produtos for all
  using (tem_acao('execucao','apontar'))
  with check (tem_acao('execucao','apontar'));

-- ------------------------------------------------------------
-- 2. Definir o destino de um produto.
-- Uma escolha mexe em duas tabelas: cria o tanque quando ele passa a ser
-- usado e remove o que ficou sem produto — vale junto ou nada muda.
-- SECURITY DEFINER + tem_acao, igual às demais RPCs de apontamento.
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
  -- ordem em andamento é histórico: a distribuição não muda mais
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

  -- tanque que ficou sem produto deixa de existir (leva junto a pesagem
  -- porventura digitada nele — sem produto não há o que pesar)
  delete from tsi.ordem_tanques t
   where t.ordem_id = p_ordem
     and not exists (
       select 1 from tsi.ordem_produtos op
        where op.ordem_id = p_ordem and op.tanque = t.tanque);
end $$ language plpgsql security definer set search_path = tsi, public;

-- ------------------------------------------------------------
-- 3. Não iniciar sem TODOS os produtos com destino definido.
-- Mantém as checagens que já existiam (peso inicial, lote baixado).
-- ------------------------------------------------------------
create or replace function fn_valida_inicio() returns trigger as $$
declare falta int;
begin
  if new.status = 'Em producao' and old.status <> 'Em producao' then
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
-- 4. Cancelar início descarta a distribuição junto com os tanques.
-- Mesma função de exclusao-exige-ordem-virgem.sql, com uma linha a mais.
-- ------------------------------------------------------------
create or replace function cancelar_inicio(p_ordem uuid, p_detalhe text) returns void as $$
begin
  if not tem_acao('execucao','apontar') then
    raise exception 'Perfil sem permissao para apontar producao';
  end if;
  insert into tsi.ordem_auditoria (ordem_id, acao, detalhe, usuario_id)
  values (p_ordem, 'cancelou o início', p_detalhe, auth.uid());
  -- o status volta antes dos descartes: o trigger de imutabilidade
  -- só libera a ordem depois que ela deixa de estar em andamento
  update tsi.ordens set status = 'Programada', turno_id = null, fim_pendente = false
   where id = p_ordem and status in ('Em producao','Parada');
  if not found then
    raise exception 'A ordem nao esta em andamento';
  end if;
  delete from tsi.ordem_paradas where ordem_id = p_ordem;
  delete from tsi.ordem_eventos where ordem_id = p_ordem;
  delete from tsi.ordem_tanques where ordem_id = p_ordem;
  delete from tsi.ordem_produtos where ordem_id = p_ordem;
  -- os testes de qualidade vão junto (a tela avisa) — deixá-los seria
  -- teste órfão numa ordem "nunca produzida"
  delete from tsi.qualidade_checks where ordem_id = p_ordem;
end $$ language plpgsql security definer set search_path = tsi, public;

-- ------------------------------------------------------------
-- 5. A receita deixa de ter tanque
--
-- Duas views leem `receita_itens.tanque` e precisam sair antes da coluna.
-- Recriadas logo abaixo lendo o tanque de `ordem_produtos`.
-- ------------------------------------------------------------
drop view if exists v_ordem_tanque_consumo;
drop view if exists v_ordem_itens_planejado;

alter table receita_itens drop column if exists tanque;

-- O tanque agora vem da escolha do operador. Produto ainda sem destino não
-- aparece — igual ao domínio, que só monta tanque do que foi destinado.
--
-- A conta da unidade também estava velha aqui: testava só `= 'ml/kg'`, então
-- produto em ml/100kg caía no ramo de grama — 100× errado e sem densidade.
-- Agora o prefixo decide se usa densidade e o sufixo decide a base (1 ou 100).
create view v_ordem_itens_planejado as
select o.id as ordem_id, op.tanque, ri.produto_id, pq.codigo, pq.nome, pq.unidade,
       pq.densidade, ri.dose,
       case when pq.unidade::text like 'ml%'
            then ri.dose * o.peso_kg * coalesce(pq.densidade,1) / 1000.0
            else ri.dose * o.peso_kg / 1000.0
       end / (case when pq.unidade::text like '%/100kg' then 100 else 1 end)
         as peso_planejado_kg,
       case when pq.unidade::text like 'ml%'
            then ri.dose * o.peso_kg / 1000.0
                 / (case when pq.unidade::text like '%/100kg' then 100 else 1 end)
       end as volume_planejado_l
from v_ordens o
join receita_itens ri on ri.receita_id = o.receita_id
join ordem_produtos op on op.ordem_id = o.id and op.produto_id = ri.produto_id
join produtos_quimicos pq on pq.id = ri.produto_id;

-- Real vs Planejado por tanque (mistura = soma dos produtos do tanque)
create view v_ordem_tanque_consumo as
select ot.ordem_id, ot.tanque, ot.peso_inicial, ot.peso_final,
       p.planejado_kg,
       case when ot.peso_inicial is not null and ot.peso_final is not null
            then greatest(0, ot.peso_inicial - ot.peso_final) end as real_kg,
       case when ot.peso_inicial is not null and ot.peso_final is not null and p.planejado_kg > 0
            then (greatest(0, ot.peso_inicial - ot.peso_final) - p.planejado_kg)
                 / p.planejado_kg * 100 end as desvio_pct
from ordem_tanques ot
join (select ordem_id, tanque, sum(peso_planejado_kg) as planejado_kg
      from v_ordem_itens_planejado group by 1,2) p
  on p.ordem_id = ot.ordem_id and p.tanque = ot.tanque;

-- view recriada volta sem security_invoker: sem isto ela roda com os
-- privilégios de quem criou e passa por cima do RLS
alter view v_ordem_itens_planejado set (security_invoker = true);
alter view v_ordem_tanque_consumo  set (security_invoker = true);

-- ------------------------------------------------------------
-- 5b. Densidade obrigatória para QUALQUER dose em ml
--
-- O check antigo era `unidade <> 'ml/kg'`, então produto em ml/100kg
-- passava sem densidade — o app validava, o banco não.
-- ------------------------------------------------------------
alter table produtos_quimicos drop constraint if exists dens_obrigatoria;
alter table produtos_quimicos add constraint dens_obrigatoria
  check (unidade::text not like 'ml%' or densidade is not null);

-- ------------------------------------------------------------
-- 6. Realtime
-- ------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table ordem_produtos;
exception when others then null; end $$;

-- conferência
select 'ordem_produtos (linhas)' as item, count(*)::text as valor from ordem_produtos
union all
select 'receita_itens ainda tem tanque (deve ser 0)', count(*)::text
  from information_schema.columns
 where table_schema='tsi' and table_name='receita_itens' and column_name='tanque'
union all
select 'policies em ordem_produtos', count(*)::text
  from pg_policies where schemaname='tsi' and tablename='ordem_produtos'
union all
select 'views com security_invoker (deve ser 2)', count(*)::text
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname='tsi' and c.relkind='v'
   and c.relname in ('v_ordem_itens_planejado','v_ordem_tanque_consumo')
   and c.reloptions::text like '%security_invoker=true%';
