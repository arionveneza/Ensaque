-- ============================================================
-- TSI 3 (DM) — terceira máquina de tratamento (19/09/2026)
-- ============================================================
-- Pedido do Arion: "precisamos criar a máquina TSI 3; iremos produzir volumes
-- menores nesta máquina". Decisão dele: mesmo requisito das outras — 5
-- tanques, mesmos turnos, 12 t/h de partida (ajustável em Cadastros ▸
-- Máquinas), setup 20/40 min (os defaults de setup-por-maquina.sql — por
-- isso as colunas de setup ficam fora do insert: o script roda tanto num
-- banco só com schema.sql quanto num já migrado). O nome leva "(DM)" porque
-- é a máquina da Difusão de Mercado, que ensaca volumes pequenos.
--
-- O id fica SEM espaço ('TSI3', como 'TSI1'/'TSI2'): é ele que a planilha de
-- ordens usa na coluna Máquina e que o `.order('id')` do front ordena. O
-- importador também aceita o nome do cadastro ("TSI 3 (DM)").
--
-- Idempotente: rodar de novo não duplica nem sobrescreve o que o Gestor já
-- tiver ajustado no cadastro. Se já existir um TSI3 com OUTRO nome (criado
-- pela tela antes do script), o bloco final avisa em vez de passar calado.
set search_path = tsi, public;

insert into maquinas (id, nome, capacidade_th, qtd_tanques, ativa)
values ('TSI3', 'TSI 3 (DM)', 12, 5, true)
on conflict (id) do nothing;

-- ---- conferência: falha alto se o que está no banco não é o esperado ----
do $$
declare
  v_nome text;
  v_ativas int;
begin
  select nome into v_nome from maquinas where id = 'TSI3';
  if v_nome is null then
    raise exception 'TSI3 não existe depois do insert';
  end if;
  if v_nome <> 'TSI 3 (DM)' then
    raise exception 'TSI3 já existia com o nome "%" — o script não sobrescreve; ajuste em Cadastros ▸ Máquinas se for o caso', v_nome;
  end if;
  select count(*) into v_ativas from maquinas where ativa;
  raise notice 'TSI3 ok · % máquinas ativas', v_ativas;
end $$;
