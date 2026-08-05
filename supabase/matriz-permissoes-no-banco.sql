-- ============================================================
-- A matriz da Administração passa a mandar no banco
-- Decisão de 05/08/2026: "quem tem a ação habilitada no painel de
-- Administração consegue executá-la" — para TODAS as ações, não só a
-- baixa de lote. Também transforma os apontamentos em transações
-- (resposta à revisão adversarial: 11 achados confirmados).
--
-- Requer baixa-atomica-e-rls-apontamento.sql já aplicado.
-- Substitui endurece-rls-baixa-e-ordens.sql (nunca precisou rodar;
-- se rodou, este script remove/replace o que ele criou).
--
-- Executar no SQL Editor e PUBLICAR O APP LOGO EM SEGUIDA: até o
-- deploy terminar, o botão Baixar/Estornar do app antigo dá erro
-- claro ("so pelas funcoes baixar_lote/estornar_lote"). O resto do
-- app antigo continua funcionando durante a janela.
--
-- O que fica FORA da matriz, de propósito:
--  - Administração (usuarios/perfil_permissoes): hard-coded Gestor.
--    É a tela que conserta a matriz — não pode depender dela.
--  - Regras de negócio: histórico imutável, pesos obrigatórios,
--    AGROTIS exige conferência, estorno bloqueado por ordem iniciada.
--    Isso não é permissão de perfil; continua em trigger para todos.
--  - Leitura: todo usuário cadastrado lê tudo (as telas precisam de
--    joins entre recursos; o "ver" da matriz controla navegação).
-- ============================================================

set search_path = tsi, public;

-- ------------------------------------------------------------
-- 1. tem_acao: a mesma resolução de permissão do app
-- (permissaoEfetiva em src/dominio/permissoes.ts): linha explícita
-- em perfil_permissoes vence; célula nunca gravada cai no padrão de
-- fábrica (MATRIZ_PADRAO). SECURITY DEFINER pelo mesmo motivo de
-- meu_perfil(): ler as tabelas sem recursão de RLS.
-- ------------------------------------------------------------
create or replace function tem_acao(p_recurso text, p_acao text) returns boolean as $$
  select coalesce(
    (select permitido from tsi.perfil_permissoes
      where perfil = tsi.meu_perfil() and recurso = p_recurso and acao = p_acao),
    tsi.meu_perfil() = 'Gestor'  -- padrão do Gestor: tudo
    or exists (select 1 from (values
      -- espelho de MATRIZ_PADRAO — manter em sincronia com permissoes.ts
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
      ('Qualidade','etapas','ver'), ('Qualidade','indicadores','ver')
    ) as padrao(perfil, recurso, acao)
      where padrao.perfil = tsi.meu_perfil()::text
        and padrao.recurso = p_recurso and padrao.acao = p_acao)
  );
$$ language sql stable security definer set search_path = tsi, public;

create or replace function pode_baixar_lote() returns boolean as $$
  select tsi.tem_acao('lotes','baixar_lote');
$$ language sql stable security definer set search_path = tsi, public;

-- ------------------------------------------------------------
-- 2. Baixa/estorno: só pela RPC, para todo perfil
-- Fecha a baixa fantasma que pcp_lotes_upd ainda permitia por fora.
-- O upload de Saldos não toca status/baixado_* no upsert — segue vivo.
-- ------------------------------------------------------------
create or replace function fn_baixa_so_pela_rpc() returns trigger as $$
begin
  if (new.status is distinct from old.status
      or new.baixado_por is distinct from old.baixado_por
      or new.baixado_em is distinct from old.baixado_em)
     and coalesce(current_setting('tsi.baixa_via_rpc', true), '') <> '1' then
    raise exception 'Baixa e estorno de lote so pelas funcoes baixar_lote/estornar_lote';
  end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;
drop trigger if exists tg_baixa_so_pela_rpc on lotes_semente;
create trigger tg_baixa_so_pela_rpc before update on lotes_semente
  for each row execute function fn_baixa_so_pela_rpc();

create or replace function baixar_lote(p_lote text, p_bags numeric, p_peso_t numeric)
returns void as $$
begin
  if not pode_baixar_lote() then
    raise exception 'Perfil sem permissao para baixar lote (Administracao > Lotes > Baixar lote)';
  end if;
  if p_bags is null or p_bags <= 0 or p_bags > 100000 then
    raise exception 'Quantidade de bags invalida: %', p_bags;
  end if;
  if p_peso_t is not null and (p_peso_t < 0 or p_peso_t > 100000) then
    raise exception 'Peso invalido: % t', p_peso_t;
  end if;
  perform set_config('tsi.baixa_via_rpc', '1', true);
  update tsi.lotes_semente
     set status = 'Baixado', baixado_por = auth.uid(), baixado_em = now()
   where id = p_lote and status = 'Em estoque';
  if not found then
    raise exception 'Baixa recusada: lote % ja baixado ou inexistente', p_lote;
  end if;
  insert into tsi.lote_movimentos (lote_id, bags, peso_t, estorno, usuario_id)
  values (p_lote, p_bags, p_peso_t, false, auth.uid());
end $$ language plpgsql security definer set search_path = tsi, public;

create or replace function estornar_lote(p_lote text, p_bags numeric)
returns void as $$
begin
  if not pode_baixar_lote() then
    raise exception 'Perfil sem permissao para estornar lote (Administracao > Lotes > Baixar lote)';
  end if;
  if p_bags is null or p_bags < 0 or p_bags > 100000 then
    raise exception 'Quantidade de bags invalida: %', p_bags;
  end if;
  perform set_config('tsi.baixa_via_rpc', '1', true);
  -- tg_valida_estorno continua bloqueando se alguma ordem do lote já iniciou
  update tsi.lotes_semente
     set status = 'Em estoque', baixado_por = null, baixado_em = null, devolver = false
   where id = p_lote and status = 'Baixado';
  if not found then
    raise exception 'Estorno recusado: lote % nao esta baixado ou inexistente', p_lote;
  end if;
  insert into tsi.lote_movimentos (lote_id, bags, estorno, usuario_id)
  values (p_lote, -p_bags, true, auth.uid());
end $$ language plpgsql security definer set search_path = tsi, public;

-- movimento vira trilha append-only escrita só pelas RPCs
drop policy if exists log_lotes on lotes_semente;
drop policy if exists log_mov on lote_movimentos;

-- ------------------------------------------------------------
-- 3. Apontamento vira transação (mesma classe de bug da baixa:
-- 2-3 escritas do cliente; queda no meio deixava evento órfão,
-- parada fechada sem reabrir, pesos velhos reaproveitados).
-- As RPCs se auto-curam de órfãos de tentativas interrompidas e
-- o unique index impede eventos duplicados para sempre.
-- ------------------------------------------------------------

-- limpa órfãos que sobraram antes do índice (mantém o mais recente)
with duplicados as (
  select id, row_number() over (partition by ordem_id, tipo order by ts desc) as n
  from ordem_eventos
)
delete from ordem_eventos e using duplicados d where e.id = d.id and d.n > 1;
create unique index if not exists uq_ordem_evento_por_tipo
  on ordem_eventos (ordem_id, tipo);

create or replace function confirmar_inicio(p_ordem uuid) returns void as $$
begin
  if not tem_acao('execucao','apontar') then
    raise exception 'Perfil sem permissao para apontar producao';
  end if;
  -- sobra de tentativa interrompida: descarta antes de gravar o real
  delete from tsi.ordem_eventos where ordem_id = p_ordem and tipo = 'inicio';
  insert into tsi.ordem_eventos (ordem_id, tipo, usuario_id)
  values (p_ordem, 'inicio', auth.uid());
  -- tg_valida_inicio segue exigindo pesos iniciais e lote baixado
  update tsi.ordens set status = 'Em producao'
   where id = p_ordem and status in ('Nao programada','Programada');
  if not found then
    raise exception 'Ordem nao esta em estado de iniciar';
  end if;
end $$ language plpgsql security definer set search_path = tsi, public;

create or replace function registrar_parada(p_ordem uuid, p_motivo text) returns void as $$
begin
  if not tem_acao('execucao','apontar') then
    raise exception 'Perfil sem permissao para apontar producao';
  end if;
  insert into tsi.ordem_paradas (ordem_id, motivo_id, usuario_id)
  values (p_ordem, p_motivo, auth.uid());
  update tsi.ordens set status = 'Parada'
   where id = p_ordem and status = 'Em producao';
  if not found then
    raise exception 'A ordem nao esta Em producao';
  end if;
end $$ language plpgsql security definer set search_path = tsi, public;

create or replace function retomar_producao(p_ordem uuid) returns void as $$
begin
  if not tem_acao('execucao','apontar') then
    raise exception 'Perfil sem permissao para apontar producao';
  end if;
  update tsi.ordem_paradas set fim = now()
   where ordem_id = p_ordem and fim is null;
  update tsi.ordens set status = 'Em producao'
   where id = p_ordem and status = 'Parada';
  if not found then
    raise exception 'A ordem nao esta Parada';
  end if;
end $$ language plpgsql security definer set search_path = tsi, public;

create or replace function confirmar_fim(p_ordem uuid) returns void as $$
begin
  if not tem_acao('execucao','apontar') then
    raise exception 'Perfil sem permissao para apontar producao';
  end if;
  update tsi.ordem_paradas set fim = now()
   where ordem_id = p_ordem and fim is null;
  delete from tsi.ordem_eventos where ordem_id = p_ordem and tipo = 'fim';
  insert into tsi.ordem_eventos (ordem_id, tipo, usuario_id)
  values (p_ordem, 'fim', auth.uid());
  -- tg_valida_fim segue exigindo peso final em todos os tanques
  update tsi.ordens set status = 'Finalizada', fim_pendente = false
   where id = p_ordem and status in ('Em producao','Parada');
  if not found then
    raise exception 'A ordem nao esta em producao';
  end if;
end $$ language plpgsql security definer set search_path = tsi, public;

-- Desiste da finalização e volta a produzir. Os pesos finais digitados
-- são DESCARTADOS: a produção continuou, a pesagem velha não vale mais
-- (achado da revisão: peso obsoleto validava o próximo Confirmar).
create or replace function voltar_para_producao(p_ordem uuid) returns void as $$
begin
  if not tem_acao('execucao','apontar') then
    raise exception 'Perfil sem permissao para apontar producao';
  end if;
  update tsi.ordens set fim_pendente = false
   where id = p_ordem and fim_pendente and status in ('Em producao','Parada');
  if not found then
    raise exception 'A ordem nao esta com a pesagem final aberta';
  end if;
  update tsi.ordem_tanques set peso_final = null where ordem_id = p_ordem;
end $$ language plpgsql security definer set search_path = tsi, public;

create or replace function cancelar_inicio(p_ordem uuid, p_detalhe text) returns void as $$
begin
  if not tem_acao('execucao','apontar') then
    raise exception 'Perfil sem permissao para apontar producao';
  end if;
  insert into tsi.ordem_auditoria (ordem_id, acao, detalhe, usuario_id)
  values (p_ordem, 'cancelou o início', p_detalhe, auth.uid());
  -- o status volta antes dos descartes: o trigger de imutabilidade
  -- só libera a ordem depois que ela deixa de estar em andamento
  update tsi.ordens set status = 'Programada', turno_id = null, fim_pendente = false
   where id = p_ordem and status in ('Em producao','Parada');
  if not found then
    raise exception 'A ordem nao esta em andamento';
  end if;
  delete from tsi.ordem_paradas where ordem_id = p_ordem;
  delete from tsi.ordem_eventos where ordem_id = p_ordem;
  delete from tsi.ordem_tanques where ordem_id = p_ordem;
end $$ language plpgsql security definer set search_path = tsi, public;

-- a qualidade final passa a obedecer à matriz também
create or replace function apontar_qualidade_final(
  p_ordem uuid, p_recobrimento int, p_umidade_ok boolean, p_po_ok boolean, p_obs text
) returns void as $$
begin
  if not tem_acao('qualidade','qualidade') then
    raise exception 'Perfil sem permissao para apontar qualidade';
  end if;
  insert into qualidade_checks
    (ordem_id, etapa, recobrimento, umidade_ok, po_ok, observacao, inspetor_id)
  values
    (p_ordem, 'final', p_recobrimento, p_umidade_ok, p_po_ok,
     nullif(trim(coalesce(p_obs,'')), ''), auth.uid());
  update ordens set status = 'Qualidade apontada'
   where id = p_ordem and status = 'Finalizada';
end $$ language plpgsql security definer set search_path = tsi, public;

do $$
declare f text;
begin
  foreach f in array array[
    'baixar_lote(text,numeric,numeric)', 'estornar_lote(text,numeric)',
    'confirmar_inicio(uuid)', 'registrar_parada(uuid,text)',
    'retomar_producao(uuid)', 'confirmar_fim(uuid)',
    'voltar_para_producao(uuid)', 'cancelar_inicio(uuid,text)'
  ] loop
    execute format('revoke execute on function tsi.%s from public, anon', f);
    execute format('grant execute on function tsi.%s to authenticated', f);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 4. Policies de escrita passam a ler a matriz
-- ------------------------------------------------------------

-- ordens: o portão grosso é "tem alguma ação de escrita sobre ordens";
-- o trigger da seção 5 confere ação por grupo de coluna.
drop policy if exists pcp_ordens on ordens;
drop policy if exists prod_ordens_upd on ordens;
create policy ordens_ins on ordens for insert
  with check (tem_acao('ordens','criar'));
create policy ordens_del on ordens for delete
  using (tem_acao('ordens','excluir'));
create policy ordens_upd on ordens for update
  using (tem_acao('ordens','editar') or tem_acao('execucao','apontar')
      or tem_acao('ordens','priorizar') or tem_acao('programacao','editar')
      or tem_acao('agrotis','lancar'))
  with check (tem_acao('ordens','editar') or tem_acao('execucao','apontar')
      or tem_acao('ordens','priorizar') or tem_acao('programacao','editar')
      or tem_acao('agrotis','lancar'));

-- apontamento: as RPCs (definer) já checam a matriz; estas policies
-- existem para o app ANTIGO continuar vivo até o deploy e para os
-- pesos de tanque, que seguem gravados direto pela tela.
drop policy if exists prod_ev on ordem_eventos;
drop policy if exists prod_ev_del on ordem_eventos;
create policy ev_ins on ordem_eventos for insert
  with check (tem_acao('execucao','apontar'));
create policy ev_del on ordem_eventos for delete
  using (tem_acao('execucao','apontar') and exists (
    select 1 from ordens o where o.id = ordem_id
      and o.status in ('Nao programada','Programada','Em producao','Parada')));
drop policy if exists prod_par on ordem_paradas;
create policy par_all on ordem_paradas for all
  using (tem_acao('execucao','apontar')) with check (tem_acao('execucao','apontar'));
drop policy if exists prod_tq on ordem_tanques;
create policy tq_all on ordem_tanques for all
  using (tem_acao('execucao','apontar')) with check (tem_acao('execucao','apontar'));

-- qualidade e conferência
drop policy if exists qual_qc on qualidade_checks;
create policy qc_ins on qualidade_checks for insert
  with check (tem_acao('qualidade','qualidade'));
drop policy if exists log_conf on ordem_conferencias;
create policy conf_all on ordem_conferencias for all
  using (tem_acao('lotes','conferir')) with check (tem_acao('lotes','conferir'));

-- lotes: cadastro manual (tela Cadastros) e upload de Saldos (tela Ordens)
drop policy if exists pcp_lotes_ins on lotes_semente;
drop policy if exists pcp_lotes_upd on lotes_semente;
create policy lotes_ins on lotes_semente for insert
  with check (tem_acao('ordens','criar') or tem_acao('cadastros','editar'));
create policy lotes_upd on lotes_semente for update
  using (tem_acao('ordens','criar') or tem_acao('cadastros','editar'))
  with check (tem_acao('ordens','criar') or tem_acao('cadastros','editar'));

-- demanda (uploads da tela Ordens criam trabalho => ordens/criar)
drop policy if exists pcp_ped on pedidos_venda;
drop policy if exists pcp_est on estoque_pa;
drop policy if exists pcp_cargas on cargas_demanda;
create policy ped_all on pedidos_venda for all
  using (tem_acao('ordens','criar')) with check (tem_acao('ordens','criar'));
create policy est_all on estoque_pa for all
  using (tem_acao('ordens','criar')) with check (tem_acao('ordens','criar'));
create policy cargas_all on cargas_demanda for all
  using (tem_acao('ordens','criar')) with check (tem_acao('ordens','criar'));

-- cadastros
drop policy if exists pcp_maq on maquinas;
drop policy if exists pcp_tur on turnos;
drop policy if exists pcp_emb on embalagens;
drop policy if exists pcp_quim on produtos_quimicos;
drop policy if exists pcp_rec on receitas;
drop policy if exists pcp_ri on receita_itens;
drop policy if exists pcp_mot on motivos_parada;
create policy maq_all on maquinas for all
  using (tem_acao('cadastros','editar')) with check (tem_acao('cadastros','editar'));
create policy tur_all on turnos for all
  using (tem_acao('cadastros','editar')) with check (tem_acao('cadastros','editar'));
create policy emb_all on embalagens for all
  using (tem_acao('cadastros','editar')) with check (tem_acao('cadastros','editar'));
create policy quim_all on produtos_quimicos for all
  using (tem_acao('cadastros','editar')) with check (tem_acao('cadastros','editar'));
create policy rec_all on receitas for all
  using (tem_acao('cadastros','editar')) with check (tem_acao('cadastros','editar'));
create policy ri_all on receita_itens for all
  using (tem_acao('cadastros','editar')) with check (tem_acao('cadastros','editar'));
create policy mot_all on motivos_parada for all
  using (tem_acao('cadastros','editar')) with check (tem_acao('cadastros','editar'));

-- Administração NÃO entra na matriz (gestor_usuarios/gestor_perm ficam)

-- ------------------------------------------------------------
-- 5. Em `ordens`, cada grupo de coluna exige a ação certa
-- Substitui o tg_producao_so_aponta do script anterior (perfil fixo).
-- Colunas novas caem no grupo "resto" (exigem ordens/editar) por padrão.
-- ------------------------------------------------------------
drop trigger if exists tg_producao_so_aponta on ordens;
drop function if exists fn_producao_so_aponta();

create or replace function fn_ordens_por_acao() returns trigger as $$
declare
  ignorar constant text[] := array[
    'status','turno_id','fim_pendente',
    'prioridade','prioridade_por','prioridade_em',
    'maquina_id','data_prog','seq',
    'agrotis_num','agrotis_por','agrotis_em'];
begin
  if new.status is distinct from old.status then
    if new.status = 'Apontada' then
      if not tem_acao('agrotis','lancar') then
        raise exception 'Encerrar no AGROTIS exige a acao Lancar (Administracao)';
      end if;
    elsif new.status = 'Qualidade apontada' then
      if not tem_acao('qualidade','qualidade') then
        raise exception 'Apontar qualidade exige a acao Qualidade (Administracao)';
      end if;
    elsif old.status in ('Nao programada','Programada','Em producao','Parada')
      and new.status in ('Nao programada','Programada','Em producao','Parada','Finalizada') then
      if not tem_acao('execucao','apontar') then
        raise exception 'Apontar producao exige a acao Apontar (Administracao)';
      end if;
    else
      -- transição fora do fluxo (ex.: reabrir Finalizada): só quem edita ordens
      if not tem_acao('ordens','editar') then
        raise exception 'Transicao de status fora do fluxo exige a acao Editar ordens';
      end if;
    end if;
  end if;
  if (new.turno_id is distinct from old.turno_id
      or new.fim_pendente is distinct from old.fim_pendente)
     and not tem_acao('execucao','apontar') then
    raise exception 'Apontar producao exige a acao Apontar (Administracao)';
  end if;
  if (new.prioridade is distinct from old.prioridade
      or new.prioridade_por is distinct from old.prioridade_por
      or new.prioridade_em is distinct from old.prioridade_em)
     and not tem_acao('ordens','priorizar') then
    raise exception 'Priorizar exige a acao Priorizar (Administracao)';
  end if;
  if (new.maquina_id is distinct from old.maquina_id
      or new.data_prog is distinct from old.data_prog
      or new.seq is distinct from old.seq)
     and not (tem_acao('programacao','editar') or tem_acao('ordens','editar')) then
    raise exception 'Programar exige a acao Editar programacao (Administracao)';
  end if;
  if (new.agrotis_num is distinct from old.agrotis_num
      or new.agrotis_por is distinct from old.agrotis_por
      or new.agrotis_em is distinct from old.agrotis_em)
     and not tem_acao('agrotis','lancar') then
    raise exception 'Encerrar no AGROTIS exige a acao Lancar (Administracao)';
  end if;
  if (to_jsonb(new) - ignorar) <> (to_jsonb(old) - ignorar)
     and not tem_acao('ordens','editar') then
    raise exception 'Editar a ordem exige a acao Editar (Administracao)';
  end if;
  return new;
end $$ language plpgsql set search_path = tsi, public;
drop trigger if exists tg_ordens_por_acao on ordens;
create trigger tg_ordens_por_acao before update on ordens
  for each row execute function fn_ordens_por_acao();

-- ------------------------------------------------------------
-- Conferência: deve voltar 8 funções, 0 policies antigas, 1 índice
-- ------------------------------------------------------------
select 'funcoes rpc' as verificacao, count(*)::text as resultado
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'tsi' and p.proname in
  ('tem_acao','baixar_lote','estornar_lote','confirmar_inicio','registrar_parada',
   'retomar_producao','confirmar_fim','voltar_para_producao','cancelar_inicio')
union all
select 'policies antigas (deve ser 0)', count(*)::text
from pg_policies where schemaname = 'tsi'
  and policyname in ('pcp_ordens','prod_ordens_upd','prod_ev','prod_ev_del','prod_par',
    'prod_tq','qual_qc','log_conf','pcp_lotes_ins','pcp_lotes_upd','log_lotes','log_mov',
    'pcp_ped','pcp_est','pcp_cargas','pcp_maq','pcp_tur','pcp_emb','pcp_quim','pcp_rec',
    'pcp_ri','pcp_mot')
union all
select 'indice unico de eventos', count(*)::text
from pg_indexes where schemaname = 'tsi' and indexname = 'uq_ordem_evento_por_tipo';
