-- ============================================================
-- Fecha duas RPCs que ficaram executáveis por ANÔNIMO — 08/08/2026
--
-- Achado na validação do domínio novo (tsi.veneza.app.br): chamei
-- abastecer_tanque e definir_tanque_produto usando só a chave anon (sem
-- login nenhum) e as duas RODARAM — a checagem `if not tem_acao(...)`
-- não bloqueia chamador anônimo porque tem_acao() devolve NULL para quem
-- não tem perfil, e `if not null` também é NULL: o `if` não entra, e a
-- função segue em frente. A prova ficou registrada nas respostas:
-- abastecer_tanque devolveu "Tanque nao encontrado" (chegou na lógica de
-- negócio) e definir_tanque_produto devolveu erro de FK (chegou no INSERT).
--
-- Toda RPC de apontamento anterior JÁ tem `revoke execute ... from
-- public, anon` (confirmado: baixar_lote, estornar_lote, confirmar_inicio,
-- confirmar_fim, registrar_parada, retomar_producao, voltar_para_producao,
-- cancelar_inicio, apontar_qualidade_final). Estas duas são as únicas
-- criadas depois sem essa linha — o Postgres libera função nova para
-- `public` por padrão, e ninguém fechou a porta.
--
-- Alcance real do risco: RLS bloqueia leitura de `ordens` para quem não
-- tem `tsi.usuarios` (confirmado: anônimo lê `[]`), então um atacante às
-- cegas não descobre IDs de tanque/ordem por aqui. Mas a chave anon é
-- pública por natureza (vai no bundle do site) e IDs circulam em telas,
-- URLs e no tráfego de rede de qualquer usuário legítimo — não é um
-- risco teórico, é uma camada de defesa que faltou.
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- Causa raiz: tem_acao() devolve NULL para quem não tem perfil (linha
-- não encontrada em perfil_permissoes E `meu_perfil() = 'Gestor'` também
-- vira NULL quando meu_perfil() é NULL). Em PL/pgSQL `if not NULL then`
-- nunca entra no bloco — é NULL, não é `true`. Toda RPC escrita com o
-- padrão `if not tem_acao(...) then raise exception` está vulnerável
-- por padrão a partir de hoje, a menos que ESTA função sempre devolva
-- true/false e nunca NULL. Envolver em coalesce(..., false) no nível
-- mais externo é a defesa de uma linha só — nenhuma outra função precisa
-- mudar, e a próxima RPC escrita com o padrão de sempre já nasce segura.
-- ------------------------------------------------------------
create or replace function tem_acao(p_recurso text, p_acao text) returns boolean as $$
  select coalesce(
    (select permitido from tsi.perfil_permissoes
      where perfil = tsi.meu_perfil() and recurso = p_recurso and acao = p_acao),
    tsi.meu_perfil() = 'Gestor'  -- padrão do Gestor: tudo
    or exists (select 1 from (values
      ('PCP','ordens','ver'), ('PCP','ordens','criar'), ('PCP','ordens','editar'),
      ('PCP','ordens','excluir'), ('PCP','ordens','priorizar'),
      ('PCP','programacao','ver'), ('PCP','programacao','editar'),
      ('PCP','lotes','ver'), ('PCP','execucao','ver'), ('PCP','qualidade','ver'),
      ('PCP','agrotis','ver'), ('PCP','agrotis','lancar'),
      ('PCP','etapas','ver'), ('PCP','indicadores','ver'),
      ('PCP','cadastros','ver'), ('PCP','cadastros','editar'),
      ('Logistica','programacao','ver'), ('Logistica','lotes','ver'),
      ('Logistica','lotes','baixar_lote'), ('Logistica','lotes','conferir'),
      ('Logistica','etapas','ver'), ('Logistica','indicadores','ver'),
      ('Producao','programacao','ver'), ('Producao','execucao','ver'),
      ('Producao','execucao','apontar'),
      ('Producao','etapas','ver'), ('Producao','indicadores','ver'),
      ('Qualidade','execucao','ver'), ('Qualidade','qualidade','ver'),
      ('Qualidade','qualidade','qualidade'),
      ('Qualidade','etapas','ver'), ('Qualidade','indicadores','ver'),
      -- Direção: só leitura, em tudo
      ('Direcao','ordens','ver'), ('Direcao','programacao','ver'),
      ('Direcao','lotes','ver'), ('Direcao','execucao','ver'),
      ('Direcao','qualidade','ver'), ('Direcao','agrotis','ver'),
      ('Direcao','etapas','ver'), ('Direcao','indicadores','ver'),
      ('Direcao','cadastros','ver')
    ) as padrao(perfil, recurso, acao)
      where padrao.perfil = tsi.meu_perfil()::text
        and padrao.recurso = p_recurso and padrao.acao = p_acao),
    false  -- NUNCA null: chamador sem perfil (inclusive anonimo) e' sempre 'nao pode'
  );
$$ language sql stable security definer set search_path = tsi, public;

revoke execute on function abastecer_tanque(uuid, numeric) from public, anon;
grant execute on function abastecer_tanque(uuid, numeric) to authenticated;

revoke execute on function definir_tanque_produto(uuid, uuid, int) from public, anon;
grant execute on function definir_tanque_produto(uuid, uuid, int) to authenticated;

-- ------------------------------------------------------------
-- Conferência 1: as duas devem aparecer SEM 'anon' nem 'PUBLIC' na
-- lista de quem pode executar.
-- ------------------------------------------------------------
select p.proname as funcao,
       (select array_agg(grantee::text) from information_schema.role_routine_grants g
          where g.specific_name = p.proname || '_' || p.oid
            and g.privilege_type = 'EXECUTE') as pode_executar
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'tsi' and p.proname in ('abastecer_tanque', 'definir_tanque_produto');

-- ------------------------------------------------------------
-- Conferência 2: tem_acao() nunca mais devolve NULL, mesmo sem perfil
-- (roda como o próprio dono da função — não precisa estar autenticado
-- para este SELECT valer como teste; o retorno é o que importa).
-- ------------------------------------------------------------
select 'tem_acao(execucao,apontar) sem sessao — deve ser false, nunca null' as verificacao,
       tem_acao('execucao','apontar') as resultado;
