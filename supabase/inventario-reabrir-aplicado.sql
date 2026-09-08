-- ============================================================
-- Reabrir inventário APLICADO — pra corrigir a contagem — 10/09/2026
-- Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- Decisão do Arion (10/09/2026): contagem errada (número de lote trocado,
-- clique duplo) precisa ser CORRIGIDA — e a trava "aplicado não reabre"
-- impedia. Reabrir agora vale também pra inventário aplicado: apaga a
-- conferência congelada E o carimbo de aplicado; corrige-se a contagem,
-- fecha-se e aplica-se de novo (a re-aplicação substitui os endereços e
-- recalcula as marcas de não encontrado). Ação continua sendo `abrir`
-- (PCP/Gestor), com aviso forte na tela.
-- ============================================================

set search_path = tsi, public;

create or replace function reabrir_inventario(p_id uuid) returns void
language plpgsql security definer set search_path = tsi, public as $$
begin
  if not tem_acao('inventario','abrir') then
    raise exception 'Perfil sem permissão para reabrir inventário';
  end if;
  perform set_config('tsi.rpc_inventario', '1', true);

  perform 1 from inventarios where id = p_id and fechado_em is not null for update;
  if not found then
    raise exception 'inventário não encontrado ou não está fechado';
  end if;
  delete from inventario_resultados where inventario_id = p_id;
  update inventarios
     set fechado_em = null, fechado_por = null,
         aplicado_em = null, aplicado_por = null
   where id = p_id;
end $$;

-- CREATE OR REPLACE preserva os grants/revokes já configurados

-- ============================================================
-- Conferência
-- ============================================================
-- select 'reabrir sem trava de aplicado',
--        position('aplicado_em = null' in prosrc) > 0
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname='tsi' and p.proname='reabrir_inventario';
