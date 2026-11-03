-- Marcar lote como DESCARTE direto no mapa (03/11/2026, pedido do Arion:
-- "preciso marcar alguns lotes como descarte, no mapa, como podemos fazer?").
-- Até aqui o único caminho era o lançamento "fora da lista" do inventário com
-- "É DESCARTE" — que só serve pra lote achado na contagem. Agora quem ajusta o
-- mapa (mapa/ajustar: PCP, Logística, Gestor) marca e desmarca na própria
-- tela, com motivo.
--
-- A marca é a destinação 'DESCARTE' — a mesma do inventário, então tudo que já
-- reage a destinação (vermelho no detalhe, aviso forte no loteamento de carga,
-- filtro "Destinação", coluna do estoque vivo, snapshot da carga) vale sem
-- mudar nada — mais o carimbo de quem/quando/por quê e a destinação que o lote
-- tinha antes, pra devolver no "Tirar do descarte".
--
-- Três funções apagariam a marca e foram protegidas (bases: definições VIVAS):
-- enriquecer_tratados e substituir_brancas_mapa (upload do SAP regravam a
-- destinação; agora guardam a do SAP em destinacao_antes_descarte) e
-- inventario_mapa_tira (tirar o último descarte da contagem devolvia a
-- destinação do SAP; agora não mexe em descarte marcado à mão).
set search_path = tsi, public;
-- a tabela do mapa é muito usada (realtime, tablets): não esperar bloqueio pra sempre
set lock_timeout = '10s';

-- ---------- 1. colunas ----------
alter table lotes_mapa add column if not exists descarte_em timestamptz;
alter table lotes_mapa add column if not exists descarte_por uuid;
alter table lotes_mapa add column if not exists descarte_motivo text;
alter table lotes_mapa add column if not exists destinacao_antes_descarte text;
comment on column lotes_mapa.descarte_em is
  'Marcado como DESCARTE à mão no mapa (03/11/2026): a destinação vira DESCARTE e o upload do SAP/inventário não tira.';
comment on column lotes_mapa.destinacao_antes_descarte is
  'Destinação que o lote tinha (ou que o SAP mandou depois) — volta quando tiram do descarte.';

-- ---------- 2. rastro ----------
create table if not exists mapa_descartes (
  id              uuid primary key default gen_random_uuid(),
  lote            text not null,
  tratamento      text not null,
  acao            text not null check (acao in ('marcar','desmarcar')),
  motivo          text not null,
  destinacao_antes text,
  bags            numeric(12,2),
  criado_em       timestamptz not null default now(),
  criado_por      uuid default auth.uid()
);
create index if not exists mapa_descartes_lote on mapa_descartes (lote, tratamento);
alter table mapa_descartes enable row level security;
drop policy if exists ler_mapa_descartes on mapa_descartes;
create policy ler_mapa_descartes on mapa_descartes for select using (tem_acao('mapa','ver'));
revoke insert, update, delete, truncate, references, trigger on mapa_descartes from anon, authenticated;
grant select on mapa_descartes to authenticated;

-- ---------- 3. RPCs ----------
create or replace function tsi.marcar_descarte_mapa(p_lote text, p_tratamento text, p_motivo text)
returns void
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_lm lotes_mapa%rowtype;
begin
  if not tem_acao('mapa','ajustar') then
    raise exception 'Perfil sem permissão para ajustar o estoque do mapa';
  end if;
  if coalesce(btrim(p_motivo), '') = '' then
    raise exception 'o motivo do descarte é obrigatório';
  end if;
  select * into v_lm from lotes_mapa where lote = p_lote and tratamento = p_tratamento for update;
  if not found then
    raise exception 'combinação % · % não existe no mapa', p_lote, p_tratamento;
  end if;
  if v_lm.descarte_em is not null then
    raise exception '% · % já está marcado como descarte', p_lote, p_tratamento;
  end if;

  update lotes_mapa
     set destinacao_antes_descarte =
           case when upper(btrim(coalesce(destinacao, ''))) = 'DESCARTE' then null else destinacao end,
         destinacao = 'DESCARTE',
         descarte_em = now(),
         descarte_por = auth.uid(),
         descarte_motivo = btrim(p_motivo),
         atualizado_em = now()
   where lote = p_lote and tratamento = p_tratamento;

  insert into mapa_descartes (lote, tratamento, acao, motivo, destinacao_antes, bags)
  values (p_lote, p_tratamento, 'marcar', btrim(p_motivo), v_lm.destinacao, v_lm.bags);
end $$;

create or replace function tsi.desmarcar_descarte_mapa(p_lote text, p_tratamento text, p_motivo text)
returns void
language plpgsql security definer set search_path = tsi, public as $$
declare
  v_lm lotes_mapa%rowtype;
begin
  if not tem_acao('mapa','ajustar') then
    raise exception 'Perfil sem permissão para ajustar o estoque do mapa';
  end if;
  if coalesce(btrim(p_motivo), '') = '' then
    raise exception 'o motivo é obrigatório';
  end if;
  select * into v_lm from lotes_mapa where lote = p_lote and tratamento = p_tratamento for update;
  if not found then
    raise exception 'combinação % · % não existe no mapa', p_lote, p_tratamento;
  end if;
  if v_lm.descarte_em is null and upper(btrim(coalesce(v_lm.destinacao, ''))) <> 'DESCARTE' then
    raise exception '% · % não está marcado como descarte', p_lote, p_tratamento;
  end if;

  -- marcado à mão volta à destinação de antes (ou à última que o SAP mandou);
  -- marcado pelo inventário/SAP fica sem destinação (o próximo upload do SAP
  -- devolve a dele)
  update lotes_mapa
     set destinacao = case when descarte_em is not null then destinacao_antes_descarte else null end,
         destinacao_antes_descarte = null,
         descarte_em = null,
         descarte_por = null,
         descarte_motivo = null,
         atualizado_em = now()
   where lote = p_lote and tratamento = p_tratamento;

  insert into mapa_descartes (lote, tratamento, acao, motivo, destinacao_antes, bags)
  values (p_lote, p_tratamento, 'desmarcar', btrim(p_motivo), v_lm.destinacao, v_lm.bags);
end $$;

revoke execute on function tsi.marcar_descarte_mapa(text, text, text) from public, anon;
grant execute on function tsi.marcar_descarte_mapa(text, text, text) to authenticated, service_role;
revoke execute on function tsi.desmarcar_descarte_mapa(text, text, text) from public, anon;
grant execute on function tsi.desmarcar_descarte_mapa(text, text, text) to authenticated, service_role;

-- ---------- 4. funções que apagariam a marca ----------
CREATE OR REPLACE FUNCTION tsi.enriquecer_tratados(p_itens jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'tsi', 'public'
AS $function$
declare
  v_n integer := 0;
  r record;
begin
  for r in select value from jsonb_array_elements(coalesce(p_itens, '[]'::jsonb))
  loop
    update lotes_mapa
       -- lote marcado como DESCARTE à mão (03/11/2026) não perde a marca no
       -- upload: a destinação do SAP vai pra destinacao_antes_descarte e volta
       -- quando alguém tira do descarte
       set destinacao    = case when descarte_em is not null then destinacao
                                else nullif(r.value->>'destinacao', '') end,
           destinacao_antes_descarte = case when descarte_em is not null
                                then nullif(r.value->>'destinacao', '')
                                else destinacao_antes_descarte end,
           classificacao = coalesce(nullif(r.value->>'classificacao', ''), classificacao)
     where lote = r.value->>'lote'
       and tratamento = r.value->>'tratamento';
    if found then
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $function$;

CREATE OR REPLACE FUNCTION tsi.substituir_brancas_mapa(p_lotes jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'tsi', 'public'
AS $function$
declare
  v_n integer := 0;
  r record;
begin
  for r in select value from jsonb_array_elements(coalesce(p_lotes, '[]'::jsonb)) loop
    insert into lotes_mapa
      (lote, tratamento, cultivar, embalagem, pms, peso_bag_kg, bags,
       destinacao, classificacao, peneira, categoria, atualizado_em)
    values
      (r.value->>'lote', 'SEM TSI', r.value->>'cultivar', r.value->>'embalagem',
       nullif(r.value->>'pms', '')::numeric,
       coalesce(nullif(r.value->>'peso_bag_kg', '')::numeric, 0),
       coalesce(nullif(r.value->>'bags', '')::numeric, 0),
       nullif(r.value->>'destinacao', ''), nullif(r.value->>'classificacao', ''),
       nullif(r.value->>'peneira', ''), nullif(r.value->>'categoria', ''), now())
    on conflict (lote, tratamento) do update
      set cultivar = excluded.cultivar,
          embalagem = excluded.embalagem,
          pms = excluded.pms,
          peso_bag_kg = excluded.peso_bag_kg,
          bags = excluded.bags,
          -- descarte marcado à mão (03/11/2026) continua descarte; o que o
          -- SAP diz fica guardado pra quando tirarem do descarte
          destinacao = case when lotes_mapa.descarte_em is not null
                            then lotes_mapa.destinacao else excluded.destinacao end,
          destinacao_antes_descarte = case when lotes_mapa.descarte_em is not null
                            then excluded.destinacao else lotes_mapa.destinacao_antes_descarte end,
          classificacao = excluded.classificacao,
          peneira = excluded.peneira,
          categoria = excluded.categoria,
          atualizado_em = now();
    v_n := v_n + 1;
  end loop;

  delete from lotes_mapa
   where tratamento = 'SEM TSI'
     and lote not in (
       select value->>'lote' from jsonb_array_elements(coalesce(p_lotes, '[]'::jsonb))
     );
  return v_n;
end $function$;

CREATE OR REPLACE FUNCTION tsi.inventario_mapa_tira(i tsi.inventario_itens)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'tsi', 'public'
AS $function$
declare
  v_lote text := regexp_replace(upper(btrim(i.lote)), '(-\d+)+$', '');
  v_trat text := upper(btrim(i.tratamento));
  v_lm   lotes_mapa%rowtype;
  v_peso numeric;
  v_qtd  numeric;
begin
  -- era o último descarte da combinação neste inventário: a destinação
  -- volta à do SAP (o poe do mesmo UPDATE remarca se continuar descarte)
  if i.descarte and not exists (
       select 1 from inventario_itens x
        where x.inventario_id = i.inventario_id and x.id <> i.id and x.descarte
          and regexp_replace(upper(btrim(x.lote)), '(-\d+)+$', '') = v_lote
          and upper(btrim(x.tratamento)) = v_trat) then
    update lotes_mapa
       set destinacao = (select s.destinacao from inventario_saldos s
                          where s.inventario_id = i.inventario_id and s.lote = v_lote
                            and s.tratamento = v_trat and s.destinacao is not null limit 1),
           atualizado_em = now()
     where lote = v_lote and tratamento = v_trat and destinacao = 'DESCARTE'
       -- descarte marcado à mão no mapa (03/11/2026) não sai pelo inventário
       and descarte_em is null;
  end if;

  if coalesce(i.bags, 0) <= 0 then
    return;
  end if;
  select * into v_lm from lotes_mapa where lote = v_lote and tratamento = v_trat for update;
  if not found then
    return;
  end if;

  -- embalagem diferente da linha do mapa: converte pelo peso (igual à produção)
  v_peso := inventario_item_peso(i.inventario_id, v_lote, v_trat, upper(btrim(i.embalagem)));
  v_qtd := case when v_lm.peso_bag_kg > 0 and v_peso > 0 and v_lm.peso_bag_kg <> v_peso
                then round(i.bags * v_peso / v_lm.peso_bag_kg, 3) else i.bags end;

  update lotes_mapa set bags = greatest(bags - v_qtd, 0), atualizado_em = now()
   where lote = v_lote and tratamento = v_trat;

  if i.armazem is not null and i.bloco is not null and i.quadra is not null then
    delete from lote_enderecos
     where lote = v_lote and tratamento = v_trat
       and armazem = i.armazem and bloco = i.bloco and quadra = i.quadra
       and bags is not null and bags <= v_qtd + 0.0001;
    update lote_enderecos set bags = bags - v_qtd
     where lote = v_lote and tratamento = v_trat
       and armazem = i.armazem and bloco = i.bloco and quadra = i.quadra
       and bags is not null and bags > v_qtd + 0.0001;
  end if;
end $function$;

-- ---------- 5. conferência ----------
select json_build_object(
  'colunas', (select json_agg(column_name::text order by column_name) from information_schema.columns
               where table_schema = 'tsi' and table_name = 'lotes_mapa'
                 and column_name in ('descarte_em','descarte_por','descarte_motivo','destinacao_antes_descarte')),
  'funcoes', (select json_agg(p.proname order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'tsi' and p.proname in ('marcar_descarte_mapa','desmarcar_descarte_mapa')),
  'protegidas', (select json_agg(p.proname order by p.proname) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'tsi' and p.proname in ('enriquecer_tratados','substituir_brancas_mapa','inventario_mapa_tira')
                 and p.prosrc ilike '%descarte_em%'),
  'descarte_hoje', (select count(*) from lotes_mapa where upper(btrim(coalesce(destinacao, ''))) = 'DESCARTE' and bags > 0)
) as conferencia;
