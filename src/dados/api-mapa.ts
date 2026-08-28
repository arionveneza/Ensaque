/**
 * Dados da aba Mapa e Montagem de Carga (28/08/2026).
 *
 * A unidade é a COMBINAÇÃO lote + tratamento ('SEM TSI' = semente branca):
 * o mesmo lote existe branco e tratado ao mesmo tempo, em endereços
 * diferentes — o endereçamento físico do Arion provou (28/08/2026).
 *
 * `lotes_mapa` é outra vista do estoque, separada de `lotes_semente` de
 * propósito: TODO lote do SAP do depósito VEN_GER, com substituição total a
 * cada upload — o que não vem na carga é apagado (lote zerado some do
 * mapa), e os endereços (lote_enderecos) sobrevivem enquanto a combinação
 * existir, porque a gravação é upsert pela chave composta.
 */

import { supabase } from '@/lib/supabase'
import type { LoteMapaConvertido } from '@/dominio/importacao/mapa'

const erro = (contexto: string, e: { message: string } | null) => {
  if (e) throw new Error(`${contexto}: ${e.message}`)
}

export interface EnderecoLote {
  id: string
  armazem: string
  bloco: string
  /** Nem sempre é número (CORREDOR, SILO). Número maior = frente do bloco. */
  quadra: string
  /** Opcional — o endereçamento físico não controla bags por endereço. */
  bags: number | null
}

export interface LoteMapaLinha {
  lote: string
  /** 'SEM TSI' = semente branca. */
  tratamento: string
  cultivar: string
  embalagem: string
  pms: number | null
  peso_bag_kg: number
  bags: number
  destinacao: string | null
  classificacao: string | null
  peneira: string | null
  categoria: string | null
  lote_enderecos: EnderecoLote[]
}

/**
 * Todas as combinações do mapa, com endereços. Devolve null quando a tabela
 * ainda não existe no formato novo (migração mapa-lote-tratamento.sql
 * pendente) — a tela avisa em vez de quebrar.
 */
export async function listarLotesMapa(): Promise<LoteMapaLinha[] | null> {
  const { data, error } = await supabase
    .from('lotes_mapa')
    .select(
      'lote, tratamento, cultivar, embalagem, pms, peso_bag_kg, bags, destinacao, classificacao, peneira, categoria, lote_enderecos ( id, armazem, bloco, quadra, bags )',
    )
    .order('cultivar')
  if (error) return null
  return (data ?? []) as unknown as LoteMapaLinha[]
}

/**
 * Substituição total: upsert de tudo que veio (chave lote + tratamento), e
 * o que não veio é apagado (combinação que zerou no SAP some). O upsert
 * preserva os endereços das combinações que continuam; o delete em cascata
 * leva os endereços das que sumiram.
 */
export async function importarLotesMapa(lotes: LoteMapaConvertido[]): Promise<number> {
  const agora = new Date().toISOString()
  const registros = lotes.map((l) => ({ ...l, atualizado_em: agora }))
  for (let i = 0; i < registros.length; i += 500) {
    const { error } = await supabase.from('lotes_mapa').upsert(registros.slice(i, i + 500))
    if (error) {
      throw new Error(
        `gravar lotes do mapa: ${error.message} — a migração mapa-lote-tratamento.sql já rodou?`,
      )
    }
  }
  // o que não foi tocado nesta carga não existe mais no SAP → sai do mapa
  const del = await supabase.from('lotes_mapa').delete().lt('atualizado_em', agora)
  erro('remover lotes que sumiram do SAP', del.error)
  return registros.length
}

/** Substitui os endereços de UMA combinação lote + tratamento. */
export async function salvarEnderecos(
  lote: string,
  tratamento: string,
  enderecos: { armazem: string; bloco: string; quadra: string; bags: number | null }[],
  usuarioId: string,
): Promise<void> {
  const del = await supabase
    .from('lote_enderecos')
    .delete()
    .eq('lote', lote)
    .eq('tratamento', tratamento)
  erro('limpar endereços do lote', del.error)
  if (enderecos.length > 0) {
    const ins = await supabase.from('lote_enderecos').insert(
      enderecos.map((e) => ({ ...e, lote, tratamento, criado_por: usuarioId })),
    )
    erro('gravar endereços do lote', ins.error)
  }
}

export interface DestinoEndereco {
  armazem: string
  bloco: string
  quadra: string
}

/**
 * Movimenta um endereço — o lote INTEIRO daquele endereço (bagsAMover null)
 * ou uma parte (bagsAMover > 0). Regras (28/08/2026):
 *
 * - mover tudo: se o destino já tem um endereço da MESMA combinação, funde
 *   (bags somam quando ambos são conhecidos; qualquer desconhecido vira
 *   desconhecido) e apaga a origem; senão, só troca o endereço da linha.
 * - mover parcial: a origem perde X bags (se a contagem dela é conhecida;
 *   zerou, apaga a linha — se é desconhecida, continua desconhecida) e o
 *   destino ganha X (fundindo com endereço existente da combinação, mesma
 *   regra de soma).
 */
export async function moverEndereco(params: {
  origem: EnderecoLote
  lote: string
  tratamento: string
  bagsAMover: number | null
  destino: DestinoEndereco
  enderecosDaCombinacao: EnderecoLote[]
  usuarioId: string
}): Promise<void> {
  const { origem, lote, tratamento, bagsAMover, destino, enderecosDaCombinacao, usuarioId } = params
  const destinoExistente = enderecosDaCombinacao.find(
    (e) =>
      e.id !== origem.id &&
      e.armazem === destino.armazem &&
      e.bloco === destino.bloco &&
      e.quadra === destino.quadra,
  )

  const atualizar = async (id: string, campos: Record<string, unknown>) => {
    const { error } = await supabase.from('lote_enderecos').update(campos).eq('id', id)
    erro('mover endereço', error)
  }
  const apagar = async (id: string) => {
    const { error } = await supabase.from('lote_enderecos').delete().eq('id', id)
    erro('mover endereço (limpar origem)', error)
  }
  const inserir = async (campos: Record<string, unknown>) => {
    const { error } = await supabase
      .from('lote_enderecos')
      .insert({ lote, tratamento, criado_por: usuarioId, ...campos })
    erro('mover endereço (criar destino)', error)
  }

  const movendoTudo =
    bagsAMover == null || (origem.bags != null && bagsAMover >= origem.bags)

  if (movendoTudo) {
    if (destinoExistente) {
      const bags =
        destinoExistente.bags != null && origem.bags != null
          ? destinoExistente.bags + origem.bags
          : null
      await atualizar(destinoExistente.id, { bags })
      await apagar(origem.id)
    } else {
      await atualizar(origem.id, { ...destino })
    }
    return
  }

  // parcial
  if (origem.bags != null) {
    const resto = origem.bags - bagsAMover
    if (resto > 0) await atualizar(origem.id, { bags: resto })
    else await apagar(origem.id)
  }
  // origem com contagem desconhecida continua desconhecida — não inventamos número
  if (destinoExistente) {
    const bags = destinoExistente.bags != null ? destinoExistente.bags + bagsAMover : null
    await atualizar(destinoExistente.id, { bags })
  } else {
    await inserir({ ...destino, bags: bagsAMover })
  }
}

export interface NovaCargaMontada {
  numero: string
  cultivar: string
  /** 'SEM TSI' = semente branca. */
  tratamento: string
  bags_solicitados: number
  peso_total_kg: number
  /** Placa/cliente/tara: saem na ordem de carregamento impressa (28/08/2026). */
  placa: string | null
  cliente: string | null
  tara_kg: number | null
}

export interface ItemCargaMontada {
  lote_id: string
  bags: number
  peso_kg: number
  /** Foto da destinação do SAP no momento — o aviso fica registrado. */
  destinacao: string | null
}

/**
 * placa/cliente/tara nasceram depois (carga-placa-cliente.sql): na janela
 * entre publicar o front e rodar o SQL, grava sem eles em vez de travar —
 * mesmo padrão do cooperado em importarPedidos.
 */
const semCamposNovos = (c: NovaCargaMontada) => {
  const { placa: _p, cliente: _c, tara_kg: _t, ...resto } = c
  return resto
}

export async function criarCargaMontada(
  carga: NovaCargaMontada,
  itens: ItemCargaMontada[],
  usuarioId: string,
): Promise<string> {
  let ins = await supabase
    .from('cargas_montadas')
    .insert({ ...carga, criada_por: usuarioId })
    .select('id')
    .single()
  if (ins.error?.code === 'PGRST204') {
    ins = await supabase
      .from('cargas_montadas')
      .insert({ ...semCamposNovos(carga), criada_por: usuarioId })
      .select('id')
      .single()
  }
  erro('criar carga montada', ins.error)
  const cargaId = (ins.data as { id: string }).id
  const itensIns = await supabase
    .from('carga_montada_itens')
    .insert(itens.map((i) => ({ ...i, carga_id: cargaId })))
  erro('gravar itens da carga', itensIns.error)
  return cargaId
}

/** Edita uma carga salva: atualiza o cabeçalho e SUBSTITUI os itens. */
export async function atualizarCargaMontada(
  id: string,
  carga: NovaCargaMontada,
  itens: ItemCargaMontada[],
): Promise<void> {
  let up = await supabase.from('cargas_montadas').update(carga).eq('id', id)
  if (up.error?.code === 'PGRST204') {
    up = await supabase.from('cargas_montadas').update(semCamposNovos(carga)).eq('id', id)
  }
  erro('atualizar carga montada', up.error)
  const del = await supabase.from('carga_montada_itens').delete().eq('carga_id', id)
  erro('limpar itens da carga', del.error)
  const ins = await supabase
    .from('carga_montada_itens')
    .insert(itens.map((i) => ({ ...i, carga_id: id })))
  erro('regravar itens da carga', ins.error)
}

export async function excluirCargaMontada(id: string): Promise<void> {
  const { error } = await supabase.from('cargas_montadas').delete().eq('id', id)
  erro('excluir carga montada', error)
}

export interface CargaMontadaLinha extends NovaCargaMontada {
  id: string
  criada_em: string
  carga_montada_itens: { lote_id: string; bags: number; peso_kg: number; destinacao: string | null }[]
}

export async function listarCargasMontadas(limite = 20): Promise<CargaMontadaLinha[]> {
  let r = await supabase
    .from('cargas_montadas')
    .select('id, numero, cultivar, tratamento, bags_solicitados, peso_total_kg, placa, cliente, tara_kg, criada_em, carga_montada_itens ( lote_id, bags, peso_kg, destinacao )')
    .order('criada_em', { ascending: false })
    .limit(limite)
  if (r.error) {
    // antes da migração carga-placa-cliente.sql as colunas novas não existem
    r = (await supabase
      .from('cargas_montadas')
      .select('id, numero, cultivar, tratamento, bags_solicitados, peso_total_kg, criada_em, carga_montada_itens ( lote_id, bags, peso_kg, destinacao )')
      .order('criada_em', { ascending: false })
      .limit(limite)) as unknown as typeof r
  }
  if (r.error) return []
  return (r.data ?? []).map((c) => ({
    placa: null,
    cliente: null,
    tara_kg: null,
    ...(c as object),
  })) as unknown as CargaMontadaLinha[]
}
