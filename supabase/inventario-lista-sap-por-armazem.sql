-- ============================================================
-- Lista do SAP também no inventário de armazém (13/10/2026, pedido do Arion:
-- "pra cada armazém possibilitar a inserção da lista de lotes do SAP, como já
-- era realizado antes"). O inventário de um armazém nasceu (hoje de manhã) só
-- com a lista vinda do mapa daquele armazém; agora a referência da contagem
-- pode ser qualquer uma das duas — a última inserida vale:
--   · "Inserir o mapa do armazém X"  → lista_origem = 'mapa'
--   · upload da planilha do SAP       → lista_origem = 'sap'
-- A conferência e os rótulos da tela seguem `inventarios.lista_origem`.
-- ============================================================

set search_path = tsi, public;

alter table inventarios add column if not exists lista_origem text
  check (lista_origem in ('sap', 'mapa'));
comment on column inventarios.lista_origem is
  'De onde veio a lista de referência da contagem (13/10/2026): sap = planilha do SAP, mapa = o que o mapa tinha no armazém. A última inserção vale. Nulo = ainda sem lista.';

-- quem já tem lista: galpão só pode ter vindo do SAP; armazém, do mapa
update inventarios i
   set lista_origem = case when i.armazem is null then 'sap' else 'mapa' end
 where i.lista_origem is null
   and exists (select 1 from inventario_saldos s where s.inventario_id = i.id);

-- ---------- upload do SAP: vale em qualquer inventário (base: definição viva) ----------
CREATE OR REPLACE FUNCTION tsi.substituir_saldos_inventario(p_id uuid, p_saldos jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'tsi', 'public'
AS $function$
declare
  v_qtd integer;
begin
  perform 1 from inventarios where id = p_id and fechado_em is null for update;
  if not found then
    raise exception 'inventário não encontrado, sem permissão ou já fechado';
  end if;

  delete from inventario_saldos where inventario_id = p_id;

  insert into inventario_saldos (inventario_id, lote, tratamento, cultivar, embalagem, bags,
                                 pms, peso_bag_kg, destinacao, classificacao, peneira, categoria)
  select p_id,
         upper(btrim(s->>'lote')),
         upper(btrim(s->>'tratamento')),
         btrim(s->>'cultivar'),
         upper(btrim(s->>'embalagem')),
         (s->>'bags')::numeric,
         nullif(s->>'pms', '')::numeric,
         nullif(s->>'peso_bag_kg', '')::numeric,
         nullif(btrim(s->>'destinacao'), ''),
         nullif(btrim(s->>'classificacao'), ''),
         nullif(btrim(s->>'peneira'), ''),
         nullif(btrim(s->>'categoria'), '')
    from jsonb_array_elements(coalesce(p_saldos, '[]'::jsonb)) s;

  get diagnostics v_qtd = row_count;
  update inventarios set lista_origem = 'sap' where id = p_id;
  return v_qtd;
end $function$;

-- ---------- lista do mapa do armazém: marca a origem (base: definição viva) ----------
CREATE OR REPLACE FUNCTION tsi.inserir_mapa_no_inventario(p_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tsi', 'public'
AS $function$
declare
  v_arm text;
  v_qtd integer;
begin
  if not tem_acao('inventario','abrir') then
    raise exception 'Perfil sem permissão para inserir a lista do inventário';
  end if;
  select armazem into v_arm from inventarios
   where id = p_id and fechado_em is null for update;
  if not found then
    raise exception 'inventário não encontrado ou já fechado';
  end if;
  if v_arm is null then
    raise exception 'este inventário é do galpão inteiro — a lista dele é a planilha do SAP';
  end if;

  delete from inventario_saldos where inventario_id = p_id;

  insert into inventario_saldos (inventario_id, lote, tratamento, cultivar, embalagem, bags,
                                 pms, peso_bag_kg, destinacao, classificacao, peneira, categoria)
  select p_id, m.lote, m.tratamento, coalesce(m.cultivar, ''), m.embalagem,
         case when bool_and(e.bags is not null) then sum(e.bags)
              else greatest(m.bags - coalesce((select sum(o.bags) from lote_enderecos o
                                                where o.lote = m.lote and o.tratamento = m.tratamento
                                                  and o.armazem <> v_arm), 0), 0)
         end,
         m.pms, m.peso_bag_kg, m.destinacao, m.classificacao, m.peneira, m.categoria
    from lotes_mapa m
    join lote_enderecos e on e.lote = m.lote and e.tratamento = m.tratamento
   where e.armazem = v_arm and m.bags > 0
   group by m.lote, m.tratamento, m.cultivar, m.embalagem, m.bags, m.pms, m.peso_bag_kg,
            m.destinacao, m.classificacao, m.peneira, m.categoria;

  get diagnostics v_qtd = row_count;
  update inventarios set lista_origem = 'mapa' where id = p_id;
  return v_qtd;
end $function$;

-- Conferência
select json_build_object(
  'coluna', (select count(*) from information_schema.columns
              where table_schema = 'tsi' and table_name = 'inventarios' and column_name = 'lista_origem'),
  'origens', (select json_agg(json_build_object('titulo', titulo, 'armazem', armazem, 'origem', lista_origem)
               order by criado_em desc) from tsi.inventarios),
  'sap_sem_trava', position('a lista vem do mapa' in pg_get_functiondef('tsi.substituir_saldos_inventario(uuid, jsonb)'::regprocedure)) = 0,
  'marca_sap', position('lista_origem = ''sap''' in pg_get_functiondef('tsi.substituir_saldos_inventario(uuid, jsonb)'::regprocedure)) > 0,
  'marca_mapa', position('lista_origem = ''mapa''' in pg_get_functiondef('tsi.inserir_mapa_no_inventario(uuid)'::regprocedure)) > 0
) as conferencia;
