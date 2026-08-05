-- ============================================================
-- Baixa de lote atômica + RLS alinhado com a tela Administração
-- Motivado por caso real de 05/08/2026: um PCP com "Baixar lote"
-- concedido na Administração baixou o SV0101036060345 — o UPDATE
-- do lote passou (policy pcp_lotes_upd) mas o INSERT do movimento
-- foi recusado (log_mov só aceitava Logistica/Gestor). Resultado:
-- lote Baixado sem registro no relatório, e as ordens liberadas
-- sem a logística ter separado nada.
--
-- Executar no SQL Editor do Supabase (projeto ztwmrhfloelqxhhpdmoz),
-- ANTES de publicar o app que chama baixar_lote/estornar_lote via RPC.
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 1. Quem decide quem baixa é a matriz da Administração
--
-- A tabela perfil_permissoes guarda só o que o gestor MEXEU; o padrão de
-- fábrica (Logistica/Gestor) fica em src/dominio/permissoes.ts. Esta função
-- espelha essa leitura: linha explícita manda, ausência segue o padrão.
-- SECURITY DEFINER pelo mesmo motivo de meu_perfil(): ler a tabela sem
-- recursão de RLS. search_path fixo obrigatório.
-- ------------------------------------------------------------
create or replace function pode_baixar_lote() returns boolean as $$
  select coalesce(
    (select permitido from tsi.perfil_permissoes
      where perfil = tsi.meu_perfil() and recurso = 'lotes' and acao = 'baixar_lote'),
    tsi.meu_perfil() in ('Logistica','Gestor')   -- padrão de fábrica (MATRIZ_PADRAO)
  );
$$ language sql stable security definer set search_path = tsi, public;

-- as duas metades da baixa passam a obedecer à MESMA regra
drop policy if exists log_lotes on lotes_semente;
create policy log_lotes on lotes_semente for update
  using (pode_baixar_lote()) with check (pode_baixar_lote());
-- (pcp_lotes_upd continua existindo para o upload da planilha de Saldos)

drop policy if exists log_mov on lote_movimentos;
create policy log_mov on lote_movimentos for insert
  with check (pode_baixar_lote());

-- ------------------------------------------------------------
-- 2. Baixa e estorno numa transação só (RPC)
--
-- Sem transação, browser fechado entre as duas escritas deixa meia baixa.
-- SECURITY INVOKER: o RLS acima continua valendo dentro da função.
-- O "where status =" também elimina a corrida de dois usuários baixando
-- o mesmo lote ao mesmo tempo.
-- ------------------------------------------------------------
create or replace function baixar_lote(p_lote text, p_bags numeric, p_peso_t numeric)
returns void as $$
begin
  update tsi.lotes_semente
     set status = 'Baixado', baixado_por = auth.uid(), baixado_em = now()
   where id = p_lote and status = 'Em estoque';
  if not found then
    raise exception 'Baixa recusada: lote % ja baixado, inexistente ou perfil sem permissao', p_lote;
  end if;
  insert into tsi.lote_movimentos (lote_id, bags, peso_t, estorno, usuario_id)
  values (p_lote, p_bags, p_peso_t, false, auth.uid());
end $$ language plpgsql security invoker set search_path = tsi, public;

create or replace function estornar_lote(p_lote text, p_bags numeric)
returns void as $$
begin
  -- tg_valida_estorno continua bloqueando se alguma ordem do lote já iniciou
  update tsi.lotes_semente
     set status = 'Em estoque', baixado_por = null, baixado_em = null, devolver = false
   where id = p_lote and status = 'Baixado';
  if not found then
    raise exception 'Estorno recusado: lote % nao esta baixado, inexistente ou perfil sem permissao', p_lote;
  end if;
  insert into tsi.lote_movimentos (lote_id, bags, estorno, usuario_id)
  values (p_lote, -p_bags, true, auth.uid());
end $$ language plpgsql security invoker set search_path = tsi, public;

-- ------------------------------------------------------------
-- 3. Produção consegue apontar (lacuna descoberta na mesma revisão)
--
-- A única policy de UPDATE em `ordens` era do PCP/Gestor. Como UPDATE
-- barrado por RLS afeta 0 linhas SEM erro, o apontamento da Produção
-- "funcionava" na tela e não gravava nada: evento de início órfão,
-- parada sem status, ordem que nunca finaliza. Os triggers
-- (tg_ordem_imutavel, tg_valida_inicio/fim) continuam garantindo o
-- que pode mudar e quando.
-- ------------------------------------------------------------
drop policy if exists prod_ordens_upd on ordens;
create policy prod_ordens_upd on ordens for update
  using (meu_perfil() = 'Producao') with check (meu_perfil() = 'Producao');

-- Cancelar início descarta os eventos da ordem, mas não havia policy de
-- DELETE em ordem_eventos: o descarte falhava em silêncio e o evento
-- 'inicio' antigo ficava — inflando o tempo bruto do próximo início
-- (calculos.ts usa o PRIMEIRO 'inicio'). Caso real: ordem 131104.
drop policy if exists prod_ev_del on ordem_eventos;
create policy prod_ev_del on ordem_eventos for delete
  using (meu_perfil() in ('Producao','Gestor'));

-- ------------------------------------------------------------
-- 4. Reparos dos dados que os bugs acima deixaram para trás
-- ------------------------------------------------------------

-- 4a. Movimento que faltou para a baixa fantasma do SV0101036060345
--     (bags e peso derivados da própria ordem; ts = hora real da baixa)
insert into lote_movimentos (lote_id, bags, peso_t, estorno, usuario_id, ts)
select l.id, o.bags, o.bags * l.peso_bag_kg / 1000.0, false, l.baixado_por, l.baixado_em
from lotes_semente l
join ordens o on o.lote_id = l.id
where l.id = 'SV0101036060345'
  and l.status = 'Baixado'
  and not exists (select 1 from lote_movimentos m where m.lote_id = l.id);

-- 4b. Eventos 'inicio' duplicados (sobrou do cancelamento que não apagava):
--     mantém o MAIS RECENTE — o anterior era da tentativa cancelada.
with duplicados as (
  select id, row_number() over (partition by ordem_id order by ts desc) as n
  from ordem_eventos where tipo = 'inicio'
)
delete from ordem_eventos e using duplicados d
where e.id = d.id and d.n > 1;

-- ------------------------------------------------------------
-- Conferência: tudo deve voltar vazio/coerente
-- ------------------------------------------------------------
select 'lotes baixados sem movimento' as verificacao, count(*) as qtd
from lotes_semente l
where l.status = 'Baixado'
  and not exists (select 1 from lote_movimentos m where m.lote_id = l.id)
union all
select 'eventos inicio duplicados', count(*)
from (select ordem_id from ordem_eventos where tipo = 'inicio'
      group by ordem_id having count(*) > 1) t;
