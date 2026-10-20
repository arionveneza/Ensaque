-- Estorno de baixas do mapa — ajustes e exclusões (20/10/2026, pedido do
-- Arion: "foram realizadas diversas baixas de estoque direto no mapa do dia
-- 19/10, precisamos de uma forma de realizar o estorno destas baixas, pois
-- foram executadas de maneira incorreta. O saldo excluído do lote com
-- tratamento e quantidade de BIGBAGS deve ser retornado").
--
-- Toda baixa manual deixa UMA linha em mapa_ajustes (ajustar_saldo_mapa,
-- excluir_lote_mapa, esvaziar_armazem_mapa, substituir_armazem_pelo_inventario)
-- — e esse rastro é a ÚNICA fonte do desfazer: o estorno soma o delta de
-- volta na mesma combinação, devolve o endereço informado (o do próprio
-- ajuste, ou o último contado no inventário — a tela sugere), grava uma
-- linha nova apontando pra original (estorno_de) e carimba a original
-- (estornado_em/por) pra não estornar duas vezes. A exclusão APAGOU os
-- endereços e não guardou onde estavam; por isso o endereço de volta vem de
-- fora (tela) e é opcional — sem ele, só o saldo volta e a combinação cai em
-- "Sem localização". Decisões dele: quem estorna é quem já ajusta
-- (mapa/ajustar: PCP, Logística, Gestor); ele escolhe na tela o que estornar.
set search_path = tsi, public;

-- ---------- 1. colunas de rastro ----------
alter table mapa_ajustes add column if not exists estorno_de uuid references mapa_ajustes(id);
alter table mapa_ajustes add column if not exists estornado_em timestamptz;
alter table mapa_ajustes add column if not exists estornado_por uuid;
create index if not exists mapa_ajustes_estorno_de on mapa_ajustes (estorno_de);
comment on column mapa_ajustes.estorno_de is
  'Preenchido na linha de ESTORNO: o ajuste original que ela desfaz (20/10/2026).';
comment on column mapa_ajustes.estornado_em is
  'Preenchido na linha ORIGINAL quando foi estornada — uma vez só.';

-- ---------- 2. RPC estornar_ajuste_mapa ----------
create or replace function tsi.estornar_ajuste_mapa(
  p_ajuste uuid, p_motivo text, p_armazem text, p_bloco text, p_quadra text
)
returns numeric
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_a      mapa_ajustes%rowtype;
  v_lm     lotes_mapa%rowtype;
  v_delta  numeric;
  v_novo   numeric;
  v_arm    text;
  v_bloco  text;
  v_quadra text;
  v_end    lote_enderecos%rowtype;
begin
  if not tem_acao('mapa','ajustar') then
    raise exception 'Perfil sem permissão para ajustar estoque do mapa';
  end if;
  if coalesce(btrim(p_motivo), '') = '' then
    raise exception 'o motivo do estorno é obrigatório';
  end if;

  select * into v_a from mapa_ajustes where id = p_ajuste for update;
  if not found then
    raise exception 'ajuste não encontrado';
  end if;
  if v_a.estorno_de is not null then
    raise exception 'esta linha já é um estorno — não se estorna um estorno';
  end if;
  if v_a.estornado_em is not null then
    raise exception 'ajuste já estornado em %',
      to_char(v_a.estornado_em at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI');
  end if;

  -- a exclusão zera a linha do mapa, não a apaga; se alguém apagou de vez
  -- (upload da branca, por exemplo), não há onde devolver — não se cria lote
  select * into v_lm from lotes_mapa
   where lote = v_a.lote and tratamento = v_a.tratamento
   for update;
  if not found then
    raise exception 'combinação % · % não está mais no mapa', v_a.lote, v_a.tratamento;
  end if;

  v_delta := -v_a.delta;
  v_novo  := v_lm.bags + v_delta;
  if v_novo < -0.01 then
    raise exception 'o estorno deixaria o saldo negativo (atual: % bg, estorno: % bg)', v_lm.bags, v_delta;
  end if;

  update lotes_mapa
     set bags = v_novo, atualizado_em = now()
   where lote = v_a.lote and tratamento = v_a.tratamento;

  -- endereço de volta: só A–E completo (bloco 1–44, quadra 1–20) — o rastro
  -- de "Armazém X esvaziado" só tem a letra, e aí só o saldo muda; nunca TSI
  v_arm    := upper(btrim(coalesce(p_armazem, '')));
  v_bloco  := numero_endereco(p_bloco, 44);
  v_quadra := numero_endereco(p_quadra, 20);
  if v_arm not in ('A','B','C','D','E') or v_bloco is null or v_quadra is null then
    v_arm := null; v_bloco := null; v_quadra := null;
  end if;
  if v_arm is not null then
    -- mesma régua do ajustar_saldo_mapa: soma no endereço que existe (contagem
    -- desconhecida continua desconhecida), cria quando devolve, apaga quando
    -- zera — comparando na escala da coluna (2 casas; lição de 16/10/2026)
    select * into v_end from lote_enderecos
     where lote = v_a.lote and tratamento = v_a.tratamento
       and armazem = v_arm and bloco = v_bloco and quadra = v_quadra
     limit 1;
    if found then
      if v_end.bags is null then
        null;
      elsif round(v_end.bags + v_delta, 2) > 0 then
        update lote_enderecos set bags = round(v_end.bags + v_delta, 2) where id = v_end.id;
      else
        delete from lote_enderecos where id = v_end.id;
      end if;
    elsif round(v_delta, 2) > 0 then
      insert into lote_enderecos (lote, tratamento, armazem, bloco, quadra, bags, criado_por)
      values (v_a.lote, v_a.tratamento, v_arm, v_bloco, v_quadra, round(v_delta, 2), auth.uid());
    end if;
  end if;

  insert into mapa_ajustes (lote, tratamento, delta, motivo, armazem, bloco, quadra, saldo_depois, estorno_de)
  values (
    v_a.lote, v_a.tratamento, v_delta,
    'Estorno de ' || to_char(v_a.criado_em at time zone 'America/Sao_Paulo', 'DD/MM HH24:MI')
      || ' (' || v_a.motivo || '): ' || btrim(p_motivo),
    v_arm, v_bloco, v_quadra, v_novo, v_a.id
  );
  update mapa_ajustes
     set estornado_em = now(), estornado_por = auth.uid()
   where id = v_a.id;

  return v_novo;
end $$;

revoke execute on function tsi.estornar_ajuste_mapa(uuid, text, text, text, text) from public, anon;
grant execute on function tsi.estornar_ajuste_mapa(uuid, text, text, text, text) to authenticated, service_role;

-- ---------- 3. conferência ----------
select json_build_object(
  'colunas', (select json_agg(column_name order by column_name) from information_schema.columns
               where table_schema = 'tsi' and table_name = 'mapa_ajustes'
                 and column_name in ('estorno_de','estornado_em','estornado_por')),
  'funcao', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'tsi' and p.proname = 'estornar_ajuste_mapa'),
  'estorno_de_estorno', (select count(*) from mapa_ajustes e join mapa_ajustes o on o.id = e.estorno_de
                          where o.estorno_de is not null),
  'ajustes_total', (select count(*) from mapa_ajustes),
  'dia_19_estornaveis', (select count(*) from mapa_ajustes
                          where (criado_em at time zone 'America/Sao_Paulo')::date = date '2026-10-19'
                            and estornado_em is null and estorno_de is null)
) as conferencia;
