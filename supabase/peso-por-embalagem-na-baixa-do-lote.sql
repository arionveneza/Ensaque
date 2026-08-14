-- ============================================================
-- baixar_lote passa a pesar cada ordem pela SUA embalagem (13/08/2026)
--
-- peso-por-embalagem-da-ordem.sql corrigiu o peso da ordem (v_ordens) mas
-- deixou baixar_lote de propósito, com a justificativa "a logística move
-- os bags físicos do lote". Só que a conta ali NUNCA foi "bags físicos do
-- lote" — é `sum(ordens.bags) × peso_bag_kg do LOTE`, e `ordens.bags` é a
-- contagem de bags da ORDEM, na embalagem DELA. Um lote big bag (5
-- milhões) com uma ordem MEIOBAG confirmada: 1 bag dessa ordem consome
-- METADE de um bag do lote (2,5 milhões de sementes num bag de 5 milhões
-- de sementes) — e 2 bags MEIOBAG consomem 1 bag do lote inteiro (relato
-- do Arion, 13/08/2026). A fórmula antiga contava cada bag MEIOBAG como se
-- fosse um bag do lote inteiro: dobrava o peso baixado.
--
-- Fórmula nova, por ordem liberada: `bags × (pms_do_lote × fator_peso da
-- EMBALAGEM DA ORDEM)` — mesma conta de v_ordens.peso_kg, somada entre as
-- ordens liberadas nesta chamada. Fallback quando o lote não tem PMS:
-- peso_bag_kg do lote, igual antes.
--
-- `ordens.bags` (contagem crua) continua igual — é só um contador
-- informativo no relatório de baixas, não uma conta de peso.
--
-- estornar_liberacao NÃO muda: já não recomputava peso nenhum (a coluna
-- peso_t do estorno já ficava null antes desta correção) — o "Peso
-- baixado" do relatório já soma só as baixas (not estorno), então não há
-- regressão aqui. Fica registrado como lacuna pré-existente, à parte.
--
-- Sem backfill de lote_movimentos: uma linha de baixa agrega várias
-- ordens sem guardar QUAIS — não dá pra recalcular com segurança o
-- histórico já gravado. A correção vale só das próximas baixas em diante.
--
-- Execute no SQL Editor do Supabase
-- ============================================================

set search_path = tsi, public;

create or replace function baixar_lote(p_lote text) returns void as $$
declare
  v_bags numeric;
  v_peso_t numeric;
begin
  if not pode_baixar_lote() then
    raise exception 'Perfil sem permissao para baixar lote';
  end if;

  with liberadas as (
    update tsi.ordens
       set lote_liberado_em = now(), lote_liberado_por = auth.uid()
     where lote_id = p_lote
       and lote_liberado_em is null
       and maquina_id is not null
       and confirmada_em is not null
       and status not in ('Em producao','Parada','Finalizada','Qualidade apontada','Apontada')
    returning bags, embalagem
  )
  select
    coalesce(sum(l.bags), 0),
    coalesce(sum(l.bags * coalesce(ls.pms * e.fator_peso, ls.peso_bag_kg)), 0) / 1000.0
    into v_bags, v_peso_t
  from liberadas l
  join tsi.lotes_semente ls on ls.id = p_lote
  join tsi.embalagens e     on e.codigo = l.embalagem;

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
end $$ language plpgsql security definer set search_path = tsi, public;

revoke execute on function baixar_lote(text) from public, anon;
grant execute on function baixar_lote(text) to authenticated;

-- ============================================================
-- Conferência: lotes com ordem confirmada aguardando liberação onde a
-- fórmula ANTIGA e a NOVA dariam pesos diferentes (só acontece quando há
-- ordem de embalagem diferente da conta anterior — tipicamente MEIOBAG
-- num lote grande). Se a lista vier vazia, nenhuma baixa pendente hoje
-- seria afetada — a correção só vale pra baixas futuras.
-- ============================================================
select
  o.lote_id,
  count(*)                                                              as ordens_pendentes,
  sum(o.bags)                                                           as bags_pendentes,
  round(sum(o.bags) * ls.peso_bag_kg / 1000.0, 3)                       as peso_t_formula_antiga,
  round(sum(o.bags * coalesce(ls.pms * e.fator_peso, ls.peso_bag_kg)) / 1000.0, 3) as peso_t_formula_nova
from ordens o
join lotes_semente ls on ls.id = o.lote_id
join embalagens e     on e.codigo = o.embalagem
where o.lote_liberado_em is null
  and o.maquina_id is not null
  and o.confirmada_em is not null
  and o.status not in ('Em producao','Parada','Finalizada','Qualidade apontada','Apontada')
group by o.lote_id, ls.peso_bag_kg
having round(sum(o.bags) * ls.peso_bag_kg / 1000.0, 3)
    <> round(sum(o.bags * coalesce(ls.pms * e.fator_peso, ls.peso_bag_kg)) / 1000.0, 3)
order by 1;
