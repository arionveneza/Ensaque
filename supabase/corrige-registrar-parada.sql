-- ============================================================
-- CORREÇÃO — o operador não consegue registrar parada
-- Execute no SQL Editor do Supabase
-- ============================================================
--
-- SINTOMA: ao escolher o motivo da parada,
--   'column "motivo_id" is of type uuid but expression is of type text'
--
-- CAUSA: `registrar_parada` recebe o motivo como `text` e insere direto em
-- `ordem_paradas.motivo_id`, que é `uuid`. O Postgres não converte texto em
-- uuid sozinho num INSERT — precisa de cast explícito.
--
-- CORREÇÃO: converter no insert. A ASSINATURA CONTINUA (uuid, text) de
-- propósito: trocar o parâmetro para uuid criaria uma SEGUNDA função com o
-- mesmo nome, e o PostgREST recusaria a chamada por ambiguidade.
-- ============================================================

set search_path = tsi, public;

create or replace function registrar_parada(p_ordem uuid, p_motivo text) returns void as $$
begin
  if not tem_acao('execucao','apontar') then
    raise exception 'Perfil sem permissao para apontar producao';
  end if;
  -- motivo precisa existir: uuid válido mas inexistente viraria FK quebrada
  if not exists (select 1 from tsi.motivos_parada where id = p_motivo::uuid) then
    raise exception 'Motivo de parada nao encontrado';
  end if;
  insert into tsi.ordem_paradas (ordem_id, motivo_id, usuario_id)
  values (p_ordem, p_motivo::uuid, auth.uid());
  update tsi.ordens set status = 'Parada'
   where id = p_ordem and status = 'Em producao';
  if not found then
    raise exception 'A ordem nao esta Em producao';
  end if;
end $$ language plpgsql security definer set search_path = tsi, public;

-- conferência: uma só função com este nome, e o cast presente
select 'registrar_parada (deve ser 1)' as item, count(*)::text as valor
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'tsi' and p.proname = 'registrar_parada'
union all
select 'faz o cast para uuid',
       (position('p_motivo::uuid' in prosrc) > 0)::text
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'tsi' and p.proname = 'registrar_parada';
