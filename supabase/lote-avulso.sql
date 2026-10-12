-- ============================================================
-- Lote AVULSO na ordem de produção (12/10/2026, pedido do Arion:
-- "preciso, na tela de ordem de produção, poder criar ordens com lotes
-- que não estão no SAP; colocar todas as informações de forma avulsa,
-- mas de maneira que não gere confusão com o sistema atual").
--
-- O lote avulso é um lotes_semente com origem_manual = true (a mesma marca
-- do cadastro manual de Cadastros ▸ Lotes, 11/09/2026), criado direto do
-- formulário da ordem. Para não confundir com o SAP:
--   * o upload do SAP nunca zera lote avulso (já era assim);
--   * QUANDO O SAP TROUXER O MESMO NÚMERO, o lote passa a ser do SAP
--     (origem_manual = false) — antes ele ficava "manual" pra sempre e nunca
--     mais era zerado, mesmo saindo do SAP depois. As ordens continuam
--     apontando pro mesmo id, então nada quebra;
--   * quem criou e quando ficam na linha (criado_por/criado_em) — a tela
--     mostra no detalhe do lote avulso.
-- O resto é do front: etiqueta "avulso" onde o lote aparece e a Expedição
-- fora (o saldo de semente branca dela é o do SAP).
-- Base de importar_lotes_semente: lotes-semente-zerar-ausentes.sql (a única
-- definição; conferido por grep em supabase/).
-- ============================================================

set search_path = tsi, public;

alter table lotes_semente
  add column if not exists criado_por uuid references usuarios(id),
  add column if not exists criado_em timestamptz;
-- default só pra linha NOVA: a carga antiga fica sem data (não sabemos)
alter table lotes_semente alter column criado_em set default now();
alter table lotes_semente alter column criado_por set default auth.uid();

comment on column lotes_semente.origem_manual is
  'Lote fora do SAP: cadastro manual (Cadastros) ou lote AVULSO criado na ordem (12/10/2026). O upload do SAP nunca o zera; se o SAP trouxer o mesmo número, ele passa a ser do SAP (origem_manual = false).';

create or replace function importar_lotes_semente(p_lotes jsonb)
returns jsonb
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_ids text[];
  v_importados integer;
  v_zerados integer;
  v_assumidos integer;
begin
  -- mesma regra das policies de INSERT/UPDATE de lotes_semente
  if not (tem_acao('ordens','criar') or tem_acao('cadastros','editar')) then
    raise exception 'Perfil sem permissão para importar lotes';
  end if;
  if p_lotes is null or jsonb_array_length(p_lotes) = 0 then
    raise exception 'planilha sem lote nenhum — nada foi importado (evita zerar tudo por engano)';
  end if;

  select array_agg(x.id) into v_ids
    from jsonb_to_recordset(p_lotes) as x(id text);

  -- lote avulso/manual que o SAP passou a trazer: vira lote do SAP (12/10/2026)
  select count(*) into v_assumidos
    from lotes_semente
   where origem_manual and id = any(v_ids);

  insert into lotes_semente
    (id, cultivar, tratamento, pms, peso_bag_kg, bags_disp, peneira, categoria, atualizado_em)
  select
    x.id, x.cultivar, x.tratamento, x.pms, x.peso_bag_kg, x.bags_disp, x.peneira, x.categoria, now()
    from jsonb_to_recordset(p_lotes) as x(
      id text, cultivar text, tratamento text, pms numeric,
      peso_bag_kg numeric, bags_disp numeric, peneira text, categoria text
    )
  on conflict (id) do update
     set cultivar      = excluded.cultivar,
         tratamento    = excluded.tratamento,
         pms           = excluded.pms,
         peso_bag_kg   = excluded.peso_bag_kg,
         bags_disp     = excluded.bags_disp,
         peneira       = excluded.peneira,
         categoria     = excluded.categoria,
         origem_manual = false,
         atualizado_em = now();
  get diagnostics v_importados = row_count;

  -- sumiu da planilha nova: zera o saldo mostrado (preserva a linha,
  -- status e histórico); lote manual/avulso nunca é tocado aqui
  update lotes_semente
     set bags_disp = 0, atualizado_em = now()
   where origem_manual = false
     and coalesce(bags_disp, 0) <> 0
     and not (id = any(v_ids));
  get diagnostics v_zerados = row_count;

  return jsonb_build_object('importados', v_importados, 'zerados', v_zerados, 'assumidos', v_assumidos);
end $$;

revoke execute on function importar_lotes_semente(jsonb) from public, anon;
grant execute on function importar_lotes_semente(jsonb) to authenticated, service_role;

-- Conferência
select json_build_object(
  'colunas', (select json_agg(column_name order by column_name) from information_schema.columns
               where table_schema = 'tsi' and table_name = 'lotes_semente'
                 and column_name in ('criado_por', 'criado_em', 'origem_manual')),
  'assume_no_upload', (select position('origem_manual = false,' in pg_get_functiondef('tsi.importar_lotes_semente(jsonb)'::regprocedure)) > 0),
  'manuais', (select count(*) from tsi.lotes_semente where origem_manual)
) as conferencia;
