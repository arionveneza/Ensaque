-- ============================================================
-- Endurecimento do RLS — resposta à revisão adversarial de 05/08/2026
-- Requer baixa-atomica-e-rls-apontamento.sql já aplicado.
--
-- O que a revisão confirmou (tudo via chamada DIRETA à API REST, fora
-- da tela — o app em si não tem caminho para nenhum destes):
--  1. pcp_lotes_upd deixava PCP/Gestor mudarem o status do lote na mão,
--     recriando a baixa fantasma que a RPC veio eliminar.
--  2. prod_ordens_upd abria a linha inteira de ordens para a Produção:
--     dava para lançar AGROTIS, pular a qualidade ou devolver ordem
--     Finalizada para Programada (e aí editar registro histórico).
--  3. prod_ev_del sem filtro deixava apagar inicio/fim de ordem Apontada:
--     a ordem sumia dos indicadores, sem auditoria e sem volta.
--  4. O toggle "Baixar lote" da Administração virava UPDATE cru em TODAS
--     as colunas do lote (peso_bag_kg inclusive, que desloca o planejado).
--  5. As RPCs aceitavam quantidades absurdas no movimento.
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 1+4. Baixa/estorno só existem dentro das RPCs
--
-- O trigger bloqueia QUALQUER mudança de status/baixado_* que não venha
-- das funções (flag local de transação). Vale para todo perfil, PCP e
-- Gestor inclusive. O upload de Saldos não toca essas colunas no upsert
-- (importarLotes em api-gestao.ts) — segue passando.
-- ------------------------------------------------------------
create or replace function fn_baixa_so_pela_rpc() returns trigger as $$
begin
  if (new.status is distinct from old.status
      or new.baixado_por is distinct from old.baixado_por
      or new.baixado_em is distinct from old.baixado_em)
     and coalesce(current_setting('tsi.baixa_via_rpc', true), '') <> '1' then
    raise exception 'Baixa e estorno de lote so pelas funcoes baixar_lote/estornar_lote';
  end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;
drop trigger if exists tg_baixa_so_pela_rpc on lotes_semente;
create trigger tg_baixa_so_pela_rpc before update on lotes_semente
  for each row execute function fn_baixa_so_pela_rpc();

-- As RPCs viram SECURITY DEFINER com a checagem de permissão explícita:
-- a matriz da Administração continua mandando (pode_baixar_lote), mas o
-- perfil autorizado ganha SÓ a operação de baixa — não UPDATE cru na
-- tabela. Também valida as quantidades (achado 5).
create or replace function baixar_lote(p_lote text, p_bags numeric, p_peso_t numeric)
returns void as $$
begin
  if not pode_baixar_lote() then
    raise exception 'Perfil sem permissao para baixar lote (Administracao > Lotes > Baixar lote)';
  end if;
  if p_bags is null or p_bags <= 0 or p_bags > 100000 then
    raise exception 'Quantidade de bags invalida: %', p_bags;
  end if;
  if p_peso_t is not null and (p_peso_t < 0 or p_peso_t > 100000) then
    raise exception 'Peso invalido: % t', p_peso_t;
  end if;
  perform set_config('tsi.baixa_via_rpc', '1', true);
  update tsi.lotes_semente
     set status = 'Baixado', baixado_por = auth.uid(), baixado_em = now()
   where id = p_lote and status = 'Em estoque';
  if not found then
    raise exception 'Baixa recusada: lote % ja baixado ou inexistente', p_lote;
  end if;
  insert into tsi.lote_movimentos (lote_id, bags, peso_t, estorno, usuario_id)
  values (p_lote, p_bags, p_peso_t, false, auth.uid());
end $$ language plpgsql security definer set search_path = tsi, public;

create or replace function estornar_lote(p_lote text, p_bags numeric)
returns void as $$
begin
  if not pode_baixar_lote() then
    raise exception 'Perfil sem permissao para estornar lote (Administracao > Lotes > Baixar lote)';
  end if;
  if p_bags is null or p_bags < 0 or p_bags > 100000 then
    raise exception 'Quantidade de bags invalida: %', p_bags;
  end if;
  perform set_config('tsi.baixa_via_rpc', '1', true);
  -- tg_valida_estorno continua bloqueando se alguma ordem do lote já iniciou
  update tsi.lotes_semente
     set status = 'Em estoque', baixado_por = null, baixado_em = null, devolver = false
   where id = p_lote and status = 'Baixado';
  if not found then
    raise exception 'Estorno recusado: lote % nao esta baixado ou inexistente', p_lote;
  end if;
  insert into tsi.lote_movimentos (lote_id, bags, estorno, usuario_id)
  values (p_lote, -p_bags, true, auth.uid());
end $$ language plpgsql security definer set search_path = tsi, public;

revoke execute on function baixar_lote(text, numeric, numeric) from public, anon;
revoke execute on function estornar_lote(text, numeric) from public, anon;
grant execute on function baixar_lote(text, numeric, numeric) to authenticated;
grant execute on function estornar_lote(text, numeric) to authenticated;

-- Com as RPCs em definer, as policies largas perdem a razão de existir:
-- o UPDATE cru em lotes volta a ser só do PCP/Gestor (upload de Saldos,
-- pcp_lotes_upd) e movimento vira trilha append-only escrita só pela RPC.
drop policy if exists log_lotes on lotes_semente;
drop policy if exists log_mov on lote_movimentos;

-- ------------------------------------------------------------
-- 2. Produção só aponta: status, turno e pesagem final
--
-- Transições permitidas: entre Programada/Em producao/Parada e o fecho
-- em Finalizada. Ordem Finalizada/Apontada fica intocável para o perfil.
-- A comparação por jsonb protege também colunas futuras por padrão.
-- ------------------------------------------------------------
create or replace function fn_producao_so_aponta() returns trigger as $$
begin
  if meu_perfil() = 'Producao' then
    if old.status not in ('Programada','Em producao','Parada')
       or new.status not in ('Programada','Em producao','Parada','Finalizada') then
      raise exception 'Producao so transita a ordem entre Programada, Em producao, Parada e Finalizada';
    end if;
    if to_jsonb(new) - array['status','turno_id','fim_pendente']
       <> to_jsonb(old) - array['status','turno_id','fim_pendente'] then
      raise exception 'Producao so altera status, turno e pesagem final da ordem';
    end if;
  end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;
drop trigger if exists tg_producao_so_aponta on ordens;
create trigger tg_producao_so_aponta before update on ordens
  for each row execute function fn_producao_so_aponta();

-- ------------------------------------------------------------
-- 3. Descarte de eventos só em ordem que ainda não é histórico
--
-- O fluxo legítimo passa: Cancelar início devolve o status para
-- Programada ANTES dos deletes, e as compensações de confirmar
-- início/fim rodam com a ordem ainda Programada/Em producao.
-- ------------------------------------------------------------
drop policy if exists prod_ev_del on ordem_eventos;
create policy prod_ev_del on ordem_eventos for delete
  using (
    meu_perfil() in ('Producao','Gestor')
    and exists (
      select 1 from ordens o
      where o.id = ordem_id
        and o.status in ('Nao programada','Programada','Em producao','Parada')
    )
  );

-- ------------------------------------------------------------
-- Conferência
-- ------------------------------------------------------------
select 'policies de lotes/movimentos' as verificacao,
       count(*) filter (where policyname in ('log_lotes','log_mov')) as deve_ser_zero
from pg_policies where schemaname = 'tsi'
union all
select 'triggers novos', count(*)
from pg_trigger where tgname in ('tg_baixa_so_pela_rpc','tg_producao_so_aponta');
