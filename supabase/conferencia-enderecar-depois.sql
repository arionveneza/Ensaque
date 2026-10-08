-- ============================================================
-- Conferência com "ENDEREÇAR" (07/10/2026, pedido do Arion: "na aba
-- logística, às vezes os operadores não endereçam, e aí não tem como eu
-- lançar as ordens na rotina AGROTIS; tem como criar um endereço chamado
-- ENDEREÇAR?").
--
-- A conferência da ordem TRATADA exigia armazém/bloco/quadra, e sem
-- conferência o AGROTIS não lança (fn_agrotis exige a linha em
-- ordem_conferencias). Agora o operador pode escolher ENDEREÇAR: a
-- conferência grava normal (o AGROTIS fica liberado) com a marca
-- `enderecar_depois`, e a ordem vai pro cartão "A endereçar" da Logística
-- até alguém dizer onde o lote está.
--
-- ENDEREÇAR NÃO é um endereço no mapa: lote_enderecos continua só com
-- armazém A–E, bloco 1–44 e quadra 1–20 (CHECK de 04/10/2026). A pendência
-- mora na conferência.
-- ============================================================

alter table tsi.ordem_conferencias
  add column if not exists enderecar_depois boolean not null default false,
  add column if not exists enderecado_em timestamptz,
  add column if not exists enderecado_por uuid references tsi.usuarios(id);

comment on column tsi.ordem_conferencias.enderecar_depois is
  'Conferida com ENDEREÇAR (07/10/2026): o operador não disse onde guardou o lote; fica no cartão "A endereçar" da Logística até enderecado_em.';

-- Endereça a pendência numa transação só: soma os bags contados no
-- endereço do mapa (mesma conta do somarEndereco do front: endereço
-- existente com bags nulo continua nulo) e dá baixa na pendência. Com
-- armazém nulo só dá baixa ("já endereçado pelo Mapa"). A trava `for
-- update` + `enderecado_em is null` impede o duplo clique de somar duas
-- vezes. SECURITY INVOKER: valem as policies de lote_enderecos (mapa) e
-- de ordem_conferencias (lotes/conferir), como no caminho de hoje.
create or replace function tsi.enderecar_conferencia(
  p_ordem uuid,
  p_armazem text,
  p_bloco text,
  p_quadra text
) returns void
language plpgsql security invoker set search_path = tsi, public as $$
declare
  v_lote text;
  v_trat text;
  v_bags integer;
begin
  select regexp_replace(upper(btrim(o.lote_id)), '(-\d+)+$', ''), r.nome, c.bags_contados
    into v_lote, v_trat, v_bags
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
  end if;

  update ordem_conferencias
     set enderecado_em = now(), enderecado_por = auth.uid()
   where ordem_id = p_ordem;
end $$;

grant execute on function tsi.enderecar_conferencia(uuid, text, text, text) to authenticated;

-- Conferência
select json_build_object(
  'colunas', (select json_agg(column_name order by column_name) from information_schema.columns
               where table_schema = 'tsi' and table_name = 'ordem_conferencias'
                 and column_name in ('enderecar_depois', 'enderecado_em', 'enderecado_por')),
  'funcao', (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'tsi' and p.proname = 'enderecar_conferencia'),
  'invoker', (select not prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'tsi' and p.proname = 'enderecar_conferencia'),
  'pendentes', (select count(*) from tsi.ordem_conferencias where enderecar_depois and enderecado_em is null),
  'realtime', (select count(*) from pg_publication_tables
                where pubname = 'supabase_realtime' and schemaname = 'tsi'
                  and tablename = 'ordem_conferencias')
) as conferencia;
