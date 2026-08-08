-- ============================================================
-- Trancamento de RPC para anônimo — o mecanismo que FUNCIONA
--
-- Neste Supabase o padrão embutido dá EXECUTE a PUBLIC em toda função
-- nova, e ALTER DEFAULT PRIVILEGES não suprime isso (testado à exaustão
-- em 08/08/2026). Então a trava confiável é por função: revogar de
-- public e anon. Este script faz isso em LAÇO, para toda função do
-- schema exceto os ajudantes que o RLS precisa poder chamar — e por
-- isso pode ser REEXECUTADO como passo final de qualquer migração
-- futura que crie função. É o substituto do "fecha sozinho".
--
-- Rodar sempre DEPOIS de aplicar migrações novas; conferir com o
-- SELECT final (só os 3 ajudantes podem sobrar).
-- ============================================================

set search_path = tsi, public;

-- 1) Conserta a guarda das duas RPCs de lote: `meu_perfil() not in (...)`
--    falha ABERTA quando meu_perfil() é NULL (usuário sem perfil), igual
--    ao bug de ontem. coalesce(... , false) fecha isso.
create or replace function excluir_lotes_sem_uso()
returns integer as $$
declare
  removidos integer;
begin
  if coalesce(meu_perfil() in ('PCP','Gestor'), false) is not true then
    raise exception 'Apenas PCP ou Gestor podem excluir lotes.';
  end if;
  with apagados as (
    delete from lotes_semente l
    where not exists (select 1 from ordens o where o.lote_id = l.id)
      and not exists (select 1 from lote_movimentos m where m.lote_id = l.id)
    returning 1
  )
  select count(*) into removidos from apagados;
  return removidos;
end $$ language plpgsql;

-- contar continua read-only; a guarda evita expor a contagem a quem não deve
create or replace function contar_lotes_sem_uso()
returns integer as $$
  select case when coalesce(meu_perfil() in ('PCP','Gestor'), false)
    then (select count(*)::integer from lotes_semente l
          where not exists (select 1 from ordens o where o.lote_id = l.id)
            and not exists (select 1 from lote_movimentos m where m.lote_id = l.id))
    else 0 end;
$$ language sql stable;

grant execute on function excluir_lotes_sem_uso() to authenticated;
grant execute on function contar_lotes_sem_uso() to authenticated;

-- 2) Tranca TODA função do schema para public/anon, menos os ajudantes
--    chamados por policies de RLS (se anon perder execute neles, a
--    avaliação da policy dá ERRO em vez de devolver vazio).
do $$
declare f record;
begin
  for f in
    select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'tsi'
      and p.proname not in ('meu_perfil', 'tem_acao', 'pode_baixar_lote')
      and has_function_privilege('anon', p.oid, 'execute')
  loop
    execute format('revoke execute on function tsi.%I(%s) from public, anon',
                   f.proname, f.args);
  end loop;
end $$;

-- 3) Conferência: só os 3 ajudantes podem sobrar aqui.
select p.proname as funcao,
       pg_get_function_identity_arguments(p.oid) as argumentos
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'tsi' and has_function_privilege('anon', p.oid, 'execute')
order by p.proname;
