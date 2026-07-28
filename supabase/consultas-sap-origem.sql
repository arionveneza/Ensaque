-- ============================================================
-- Consultas criadas no B1 x consultas registradas pelo app
-- Execute no SQL Editor do Supabase, depois de consultas-sap.sql
-- ============================================================
--
-- O usuário de integração (ven040) não tem permissão para CRIAR consulta no
-- SAP — o Service Layer responde "You are not permitted to perform this
-- action". Mas uma pessoa com acesso ao cliente B1 cria normalmente.
--
-- Então passam a existir duas origens:
--
--   'sap' — a consulta foi criada no Query Manager do B1. O app só executa,
--           que é leitura. O campo `sql` aqui vira documentação: serve para
--           quem for entender ou refazer a consulta, e não é enviado a lugar
--           nenhum.
--
--   'app' — o app registra no Service Layer. Continua disponível para quando
--           o usuário de integração ganhar a permissão.
-- ============================================================

set search_path = tsi, public;

alter table consultas_sap
  add column if not exists origem text not null default 'app'
    check (origem in ('app', 'sap'));

comment on column consultas_sap.origem is
  'sap = criada no cliente B1, o app só executa. app = o app registra no Service Layer.';

-- consulta criada no B1 não passa por registro nosso: o campo de registro
-- deixa de fazer sentido e não deve bloquear a execução
create or replace function fn_consulta_sap_alterada() returns trigger as $$
begin
  new.atualizada_em := now();
  if new.origem = 'sap' then
    new.registrada_em := null;
  elsif new.sql is distinct from old.sql then
    -- mudou o SQL? então o que está no SAP não é mais esta consulta
    new.registrada_em := null;
  end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;
