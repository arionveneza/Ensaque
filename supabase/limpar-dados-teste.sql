-- ============================================================
-- LIMPAR OS DADOS DE TESTE — para entrar em produção limpo
-- Execute no SQL Editor do Supabase
-- ============================================================
--
-- ⚠️ APAGA DADOS DE FORMA DEFINITIVA. Não tem desfazer.
--
-- São três níveis. Rode só até onde precisar: **descomente** o nível desejado.
-- Por segurança, tudo começa comentado.
--
-- O que NUNCA é apagado, em nenhum nível:
--   · usuarios e perfil_permissoes — você perderia o próprio acesso
--   · maquinas, turnos, embalagens  — cadastro estrutural, não é dado de teste
--
-- A ordem das exclusões respeita as chaves estrangeiras: filho antes de pai.
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- Antes: veja o que existe hoje
-- ------------------------------------------------------------
select 'ordens' as tabela, count(*) from ordens
union all select 'ordem_eventos',      count(*) from ordem_eventos
union all select 'ordem_paradas',      count(*) from ordem_paradas
union all select 'ordem_tanques',      count(*) from ordem_tanques
union all select 'ordem_tanque_lotes', count(*) from ordem_tanque_lotes
union all select 'ordem_qualidade',    count(*) from ordem_qualidade
union all select 'qualidade_checks',   count(*) from qualidade_checks
union all select 'ordem_conferencias', count(*) from ordem_conferencias
union all select 'ordem_auditoria',    count(*) from ordem_auditoria
union all select 'lote_movimentos',    count(*) from lote_movimentos
union all select 'lotes_semente',      count(*) from lotes_semente
union all select 'pedidos_venda',      count(*) from pedidos_venda
union all select 'estoque_pa',         count(*) from estoque_pa
union all select 'cargas_demanda',     count(*) from cargas_demanda
union all select 'lotes_quimico',      count(*) from lotes_quimico
union all select 'receitas',           count(*) from receitas
union all select 'produtos_quimicos',  count(*) from produtos_quimicos
union all select 'usuarios',           count(*) from usuarios
order by 1;


-- ============================================================
-- NÍVEL 1 — só o movimento: ordens, apontamentos e demanda
-- ============================================================
-- Mantém lotes de semente, lotes de químico, receitas e produtos.
-- É o que você quer se a intenção é zerar a operação de teste e continuar
-- com os cadastros que já estão certos.
--
-- begin;
--   delete from ordem_auditoria;
--   delete from ordem_qualidade;
--   delete from qualidade_checks;
--   delete from ordem_conferencias;
--   delete from ordem_tanque_lotes;
--   delete from ordem_tanques;
--   delete from ordem_paradas;
--   delete from ordem_eventos;
--   delete from ordens;
--
--   delete from lote_movimentos;
--   -- lote baixado durante os testes volta a ficar disponível
--   update lotes_semente set status = 'Em estoque', baixado_por = null,
--                            baixado_em = null, devolver = false;
--
--   delete from pedidos_venda;
--   delete from estoque_pa;
--   delete from cargas_demanda;
-- commit;


-- ============================================================
-- NÍVEL 2 — nível 1 + os lotes
-- ============================================================
-- Use quando os lotes importados nos testes também são descartáveis.
-- Rode DEPOIS do nível 1, senão as ordens seguram os lotes.
--
-- begin;
--   delete from lotes_semente;
--   delete from lotes_quimico;
-- commit;


-- ============================================================
-- NÍVEL 3 — tudo, inclusive receitas e químicos
-- ============================================================
-- Zera o cadastro químico por completo. Use se as densidades de teste
-- (fictícias) devem sair para dar lugar às FISPQ reais, e for mais simples
-- recomeçar do zero do que corrigir uma por uma.
--
-- ATENÇÃO: sem receitas não é possível criar ordem. Recadastre antes de operar.
--
-- begin;
--   delete from receita_itens;
--   delete from receitas;
--   delete from lotes_quimico;
--   delete from produtos_quimicos;
-- commit;


-- ------------------------------------------------------------
-- Depois: confira o resultado
-- ------------------------------------------------------------
-- Rode de novo a consulta de contagem lá em cima.
--
-- Sanidade final: seu usuário tem que continuar lá, senão você perde o acesso.
select id, nome, perfil, ativo from usuarios order by nome;
