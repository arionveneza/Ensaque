-- ============================================================
-- Solução definitiva: função nova nasce SEM execução para ninguém
--
-- O Postgres tem um comportamento especial só para funções: toda função
-- criada ganha `EXECUTE` para `PUBLIC` automaticamente, a menos que algo
-- diga o contrário. É esse "a menos que" que ontem ninguém escreveu para
-- abastecer_tanque e definir_tanque_produto — e como PUBLIC vale para
-- todo mundo, `anon` (a chave pública do site) herdou a passagem livre.
--
-- ALTER DEFAULT PRIVILEGES muda o PADRÃO para objetos criados DEPOIS
-- deste comando — não toca em nada que já existe. Depois de rodar isto,
-- toda função nova no schema `tsi` (criada pela mesma sessão/role que
-- roda os scripts no SQL Editor) nasce SEM execução para ninguém, nem
-- para `authenticated`.
--
-- Consequência para quem escrever a próxima RPC: SE esquecer o
-- `grant execute ... to authenticated`, a função não vai funcionar nem
-- para o app de verdade — vai dar erro na hora de testar. Antes o
-- esquecimento era invisível (funcionava para todo mundo, inclusive
-- quem não devia); agora ele FALHA ALTO, na cara, no primeiro teste.
-- Trocar "perigoso e silencioso" por "chato e ruidoso" é a troca certa.
--
-- NÃO revoga nada de função já existente — meu_perfil(), tem_acao() e
-- as demais continuam exatamente como estão. Revogar retroativamente
-- quebraria RLS na hora (ler_ordens usa meu_perfil() dentro do próprio
-- policy, e anon precisa conseguir CHAMAR a função para a policy
-- avaliar "não pode", nem que seja para receber `false`).
-- ============================================================

alter default privileges in schema tsi
  revoke execute on functions from public;

-- ------------------------------------------------------------
-- Saúde: toda função hoje que ainda deixa PUBLIC ou anon chamarem —
-- rodar este SELECT depois de qualquer migração nova, não só hoje.
-- Esperado: meu_perfil, tem_acao e outras funções lidas por policy
-- aparecem aqui (ficam de fora de propósito, ver acima); nenhuma RPC
-- de apontamento/baixa deveria aparecer.
-- ------------------------------------------------------------
select p.proname as funcao,
       array_agg(distinct grantee::text) as quem_pode_chamar
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
join information_schema.routine_privileges g
  on g.specific_name = p.proname || '_' || p.oid and g.privilege_type = 'EXECUTE'
where n.nspname = 'tsi' and g.grantee in ('PUBLIC', 'anon')
group by p.proname
order by p.proname;
