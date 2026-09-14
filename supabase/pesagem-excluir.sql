-- ============================================================
-- Pesagem: excluir carregamento — 14/09/2026
--
-- Pedido do Arion: "coloque um comando pra excluir ordem". A primeira versão
-- não tinha policy de delete (registro de conformidade). Regra adotada:
-- quem REGISTRA exclui só carregamento ainda não pesado (erro de digitação
-- da etapa 1); depois de pesado, só quem ADMINISTRA (Gestor). O front pede
-- confirmação e grava com a versão lida (concorrência otimista).
-- ============================================================
set search_path = tsi, public;

drop policy if exists exclui_pesagens on pesagens;
create policy exclui_pesagens on pesagens for delete
  using (
    tem_acao('pesagem','administrar')
    or (tem_acao('pesagem','registrar') and peso_bruto_final_kg is null)
  );

select 'politicas pesagens (4)' as item, (count(*) = 4)::text as ok
  from pg_policies where schemaname = 'tsi' and tablename = 'pesagens';
