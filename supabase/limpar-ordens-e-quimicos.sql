-- ============================================================
-- LIMPEZA: ordens, produtos químicos e lotes de químico
-- Execute no SQL Editor do Supabase
-- ============================================================
--
-- ⚠️ APAGA DEFINITIVAMENTE. Não tem desfazer.
--
-- O que sai:
--   · TODAS as ordens e seus apontamentos (eventos, paradas, tanques,
--     lotes de químico usados, qualidade, conferências, auditoria)
--   · TODOS os produtos químicos e lotes de químico
--   · os ITENS das receitas — a dose aponta para o produto, então vai
--     junto. Os NOMES das receitas ficam: redosar ao recadastrar os
--     químicos reais (FISPQ).
--
-- O que fica:
--   · lotes de semente (baixados voltam a "Em estoque")
--   · pedidos de venda, estoque PA e cargas de demanda
--   · receitas (só o cabeçalho), máquinas, turnos, embalagens, motivos
--   · usuários e permissões
-- ============================================================

set search_path = tsi, public;

-- antes
select 'ordens' as tabela, count(*) from ordens
union all select 'produtos_quimicos', count(*) from produtos_quimicos
union all select 'lotes_quimico',     count(*) from lotes_quimico
union all select 'receita_itens',     count(*) from receita_itens
union all select 'receitas',          count(*) from receitas
order by 1;

begin;

-- 0. a trava de imutabilidade recusa excluir ordem iniciada/apontada —
--    é a proteção certa em produção, mas aqui o objetivo é justamente
--    apagar o histórico de teste. Desliga só dentro desta transação.
alter table ordens disable trigger tg_ordem_imutavel;

-- 1. ordens e tudo que pende delas (filho antes de pai)
delete from ordem_auditoria;
delete from ordem_qualidade;
delete from qualidade_checks;
delete from ordem_conferencias;
delete from ordem_tanque_lotes;
delete from ordem_tanques;
delete from ordem_paradas;
delete from ordem_eventos;
delete from ordens;

-- religa a trava
alter table ordens enable trigger tg_ordem_imutavel;

-- 2. lote de semente baixado nos testes volta a ficar disponível,
--    e o log de baixas dos testes sai junto
delete from lote_movimentos;
update lotes_semente set status = 'Em estoque', baixado_por = null,
                         baixado_em = null, devolver = false;

-- 3. químicos: as doses das receitas apontam para os produtos, saem antes
delete from receita_itens;
delete from lotes_quimico;
delete from produtos_quimicos;

commit;

-- depois: ordens e químicos zerados, receitas só de cabeçalho
select 'ordens' as tabela, count(*) from ordens
union all select 'produtos_quimicos', count(*) from produtos_quimicos
union all select 'lotes_quimico',     count(*) from lotes_quimico
union all select 'receita_itens',     count(*) from receita_itens
union all select 'receitas',          count(*) from receitas
union all select 'lotes_semente',     count(*) from lotes_semente
union all select 'usuarios',          count(*) from usuarios
order by 1;
