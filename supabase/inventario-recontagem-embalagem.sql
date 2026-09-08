-- ============================================================
-- Achada só sai da lista quando TODA embalagem foi achada — 11/09/2026
-- Execute no SQL Editor do Supabase (idempotente)
-- ============================================================
--
-- Achado ao validar a tela de Pendências com o Arion: a marca de "não
-- encontrado" é por lote+tratamento (o mapa não distingue embalagem),
-- mas a contagem é por lote+tratamento+EMBALAGEM (BB5M e MEIOBAG não
-- somam — mesma regra de inventario-marca-por-embalagem.sql). Duas
-- funções limpavam a marca olhando SÓ lote+tratamento, ignorando se
-- outra embalagem da MESMA combinação ainda estava sem contar:
--   - recontar_inventario: contar o BB5M limpava a marca do MEIOBAG
--     junto, mesmo ele continuando não encontrado;
--   - fn_endereco_achado (dispara em QUALQUER insert em lote_enderecos,
--     inclusive o somarEndereco chamado pela recontagem): mesmo bug por
--     outra porta.
-- Fix: as duas só limpam quando NENHUMA outra embalagem da combinação
-- (no inventário aplicado) ainda estiver com bags_contados nulo.
-- ============================================================

set search_path = tsi, public;

create or replace function recontar_inventario(p_resultado uuid, p_bags numeric)
returns void
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_r inventario_resultados%rowtype;
  v_pendente boolean;
begin
  if not tem_acao('inventario','contar') then
    raise exception 'Perfil sem permissão para recontar';
  end if;
  if p_bags is null or p_bags < 0 then
    raise exception 'informe a quantidade recontada (0 vale: recontei e está vazio)';
  end if;

  select * into v_r from inventario_resultados where id = p_resultado for update;
  if not found then
    raise exception 'linha da conferência não encontrada';
  end if;

  update inventario_resultados
     set bags_primeira_contagem = coalesce(bags_primeira_contagem, bags_contados),
         bags_contados = p_bags,
         recontado_em  = now(),
         recontado_por = auth.uid()
   where id = p_resultado;

  -- recontou e ACHOU alguma coisa: só sai da lista de não encontrados
  -- quando NENHUMA outra embalagem do MESMO lote+tratamento, neste
  -- mesmo inventário, continuar sem contagem — achar o BB5M não pode
  -- arrastar o MEIOBAG que continua sumido pra fora da lista.
  if p_bags > 0 then
    select exists (
      select 1 from inventario_resultados ir
       where ir.inventario_id = v_r.inventario_id
         and ir.lote = v_r.lote and ir.tratamento = v_r.tratamento
         and ir.bags_contados is null
         and ir.id <> v_r.id
    ) into v_pendente;

    if not v_pendente then
      update lotes_mapa set nao_encontrado_inventario_em = null
       where lote = v_r.lote and tratamento = v_r.tratamento
         and nao_encontrado_inventario_em is not null;
    end if;
  end if;
end $$;

-- CREATE OR REPLACE preserva os grants/revokes já configurados

create or replace function fn_endereco_achado() returns trigger
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_pendente boolean;
begin
  -- mesma régua do recontar_inventario, mas sem o id do resultado à mão
  -- (o gatilho só vê lote+tratamento do endereço) — usa o inventário
  -- APLICADO mais recente como referência.
  select exists (
    select 1
      from inventario_resultados ir
     where ir.inventario_id = (
             select id from inventarios
              where aplicado_em is not null
              order by aplicado_em desc
              limit 1
           )
       and ir.lote = new.lote and ir.tratamento = new.tratamento
       and ir.bags_contados is null
  ) into v_pendente;

  if not v_pendente then
    update lotes_mapa set nao_encontrado_inventario_em = null
     where lote = new.lote and tratamento = new.tratamento
       and nao_encontrado_inventario_em is not null;
  end if;
  return new;
end $$;

-- trigger já existe (tg_endereco_achado on lote_enderecos) — CREATE OR
-- REPLACE da função basta, não precisa recriar o gatilho

-- ============================================================
-- Conferência
-- ============================================================
-- select 'recontar respeita embalagem', position('ir.id <> v_r.id' in prosrc) > 0
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname='tsi' and p.proname='recontar_inventario';
-- select 'endereco_achado respeita embalagem', position('bags_contados is null' in prosrc) > 0
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname='tsi' and p.proname='fn_endereco_achado';
