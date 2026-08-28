/**
 * Dados da aba Mapa e Montagem de Carga (28/08/2026).
 *
 * `lotes_mapa` é outra vista do estoque, separada de `lotes_semente` de
 * propósito: TODO lote do SAP (branco e tratado) do depósito VEN_GER, com
 * substituição total a cada upload — o que não vem na carga é apagado
 * (lote zerado some do mapa), e os endereços (lote_enderecos) sobrevivem
 * enquanto o lote existir, porque a gravação é upsert por id.
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
  /** Quanto MAIOR, mais fácil o acesso dentro do bloco. */
  quadra: number
  bags: number
}

export interface LoteMapaLinha {
  id: string
  cultivar: string
  tratamento: string | null
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
 * Todos os lotes do mapa, com endereços. Devolve null quando a tabela ainda
 * não existe (migração mapa-montagem-carga.sql pendente) — a tela avisa em
 * vez de quebrar.
 */
export async function listarLotesMapa(): Promise<LoteMapaLinha[] | null> {
  const { data, error } = await supabase
    .from('lotes_mapa')
    .select(
      'id, cultivar, tratamento, embalagem, pms, peso_bag_kg, bags, destinacao, classificacao, peneira, categoria, lote_enderecos ( id, armazem, bloco, quadra, bags )',
    )
    .order('cultivar')
  if (error) return null
  return (data ?? []) as unknown as LoteMapaLinha[]
}

/**
 * Substituição total: upsert de tudo que veio, e o que não veio é apagado
 * (lote que zerou no SAP some do mapa). O upsert preserva os endereços dos
 * lotes que continuam existindo; o delete em cascata leva os endereços dos
 * que sumiram.
 */
export async function importarLotesMapa(lotes: LoteMapaConvertido[]): Promise<number> {
  const agora = new Date().toISOString()
  const registros = lotes.map((l) => ({ ...l, atualizado_em: agora }))
  for (let i = 0; i < registros.length; i += 500) {
    const { error } = await supabase.from('lotes_mapa').upsert(registros.slice(i, i + 500))
    if (error) {
      throw new Error(
        `gravar lotes do mapa: ${error.message} — a migração mapa-montagem-carga.sql já rodou?`,
      )
    }
  }
  // o que não foi tocado nesta carga não existe mais no SAP → sai do mapa
  const del = await supabase.from('lotes_mapa').delete().lt('atualizado_em', agora)
  erro('remover lotes que sumiram do SAP', del.error)
  return registros.length
}

/** Substitui os endereços de UM lote (mesmo padrão de receita_itens). */
export async function salvarEnderecos(
  loteId: string,
  enderecos: { armazem: string; bloco: string; quadra: number; bags: number }[],
  usuarioId: string,
): Promise<void> {
  const del = await supabase.from('lote_enderecos').delete().eq('lote_id', loteId)
  erro('limpar endereços do lote', del.error)
  if (enderecos.length > 0) {
    const ins = await supabase.from('lote_enderecos').insert(
      enderecos.map((e) => ({ ...e, lote_id: loteId, criado_por: usuarioId })),
    )
    erro('gravar endereços do lote', ins.error)
  }
}

export interface NovaCargaMontada {
  numero: string
  cultivar: string
  tratamento: string | null
  bags_solicitados: number
  peso_total_kg: number
}

export interface ItemCargaMontada {
  lote_id: string
  bags: number
  peso_kg: number
  /** Foto da destinação do SAP no momento — o aviso fica registrado. */
  destinacao: string | null
}

export async function criarCargaMontada(
  carga: NovaCargaMontada,
  itens: ItemCargaMontada[],
  usuarioId: string,
): Promise<string> {
  const ins = await supabase
    .from('cargas_montadas')
    .insert({ ...carga, criada_por: usuarioId })
    .select('id')
    .single()
  erro('criar carga montada', ins.error)
  const cargaId = (ins.data as { id: string }).id
  const itensIns = await supabase
    .from('carga_montada_itens')
    .insert(itens.map((i) => ({ ...i, carga_id: cargaId })))
  erro('gravar itens da carga', itensIns.error)
  return cargaId
}

export interface CargaMontadaLinha extends NovaCargaMontada {
  id: string
  criada_em: string
  carga_montada_itens: { lote_id: string; bags: number; peso_kg: number; destinacao: string | null }[]
}

export async function listarCargasMontadas(limite = 20): Promise<CargaMontadaLinha[]> {
  const { data, error } = await supabase
    .from('cargas_montadas')
    .select('id, numero, cultivar, tratamento, bags_solicitados, peso_total_kg, criada_em, carga_montada_itens ( lote_id, bags, peso_kg, destinacao )')
    .order('criada_em', { ascending: false })
    .limit(limite)
  if (error) return []
  return (data ?? []) as unknown as CargaMontadaLinha[]
}
