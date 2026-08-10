-- ============================================================
-- AUDITORIA DE RPC — rodar DEPOIS de toda migração que cria função
--
-- Por que não confiamos no "padrão fecha sozinho": no Supabase deste
-- projeto, funções nascem com EXECUTE para PUBLIC embutido, e nem
-- ALTER DEFAULT PRIVILEGES ... REVOKE ... FROM PUBLIC suprimiu isso
-- (testado à exaustão em 08/08/2026). Então a defesa que FUNCIONA é
-- por função: cada RPC que muda dado leva, na própria migração,
--
--   revoke execute on function tsi.nome(args) from public, anon;
--   grant  execute on function tsi.nome(args) to authenticated;
--
-- Esta consulta é o cinto de segurança: lista toda função do schema
-- que um ANÔNIMO consegue executar. O que PODE aparecer aqui sem
-- perigo (são chamadas por policies de RLS e não mudam dado):
--   meu_perfil, tem_acao, pode_baixar_lote
-- (a mesma lista de 3 que trancar-rpc-anon.sql preserva — as duas
-- listas TÊM que andar juntas: pode_baixar_lote é chamada pelas
-- policies de lotes_semente/lote_movimentos, e revogá-la de anon faz
-- a avaliação da policy dar ERRO em vez de devolver vazio, derrubando
-- baixa, estorno e o upload de Saldos para todos os perfis.)
-- QUALQUER OUTRA função nesta lista que grave/altere dado é um furo —
-- falta o revoke dela. Corrija antes de considerar a migração pronta.
-- ============================================================

select
  p.proname as funcao,
  pg_get_function_identity_arguments(p.oid) as argumentos,
  case
    when p.proname in ('meu_perfil', 'tem_acao', 'pode_baixar_lote') then 'ok (helper de RLS)'
    else 'REVISAR — anon nao deveria executar isto'
  end as veredito
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'tsi'
  and has_function_privilege('anon', p.oid, 'execute')
order by veredito desc, p.proname;
