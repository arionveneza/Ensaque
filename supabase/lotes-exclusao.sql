-- ============================================================
-- Exclusão de lotes de semente pela tela
-- Execute no SQL Editor do Supabase
-- ============================================================
--
-- Um lote não pode ser apagado se alguma ordem aponta para ele, nem se tem
-- movimento de baixa registrado — apagar quebraria o histórico. Mas lote
-- importado por engano, ou que nunca foi usado, precisa poder sair.
--
-- Esta função apaga de uma vez todos os lotes SEM USO. Ela existe como função
-- porque o filtro é um "não existe ordem apontando para este lote", que a API
-- REST não sabe expressar — pelo cliente seria uma requisição por lote.
--
-- Roda com os privilégios de quem chama (SECURITY INVOKER, o padrão), então o
-- RLS continua valendo. A checagem de perfil é só para dar erro legível em vez
-- de apagar zero linhas silenciosamente.
-- ============================================================

set search_path = tsi, public;

create or replace function excluir_lotes_sem_uso()
returns integer as $$
declare
  removidos integer;
begin
  if meu_perfil() not in ('PCP', 'Gestor') then
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

comment on function excluir_lotes_sem_uso() is
  'Apaga lotes de semente que nenhuma ordem e nenhum movimento referenciam. Devolve a quantidade removida.';

/** Quantos lotes dá para apagar, para a tela mostrar antes de perguntar. */
create or replace function contar_lotes_sem_uso()
returns integer as $$
  select count(*)::integer from lotes_semente l
  where not exists (select 1 from ordens o where o.lote_id = l.id)
    and not exists (select 1 from lote_movimentos m where m.lote_id = l.id);
$$ language sql stable;

grant execute on function excluir_lotes_sem_uso() to authenticated;
grant execute on function contar_lotes_sem_uso() to authenticated;

select contar_lotes_sem_uso() as lotes_sem_uso;
