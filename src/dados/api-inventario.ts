/**
 * Dados da tela Inventário (04/09/2026): contagem física × estoque do SAP,
 * FORA do mapa — só compara, não ajusta saldo nenhum.
 *
 * A referência é a lista do SAP que o PCP insere no próprio inventário
 * (inventario_saldos, substituição total via RPC). O operador lança
 * endereço + quantidade por combinação (inventario_itens); fechar congela
 * a comparação (inventario_resultados) — migração inventario.sql.
 */

import { supabase } from '@/lib/supabase'
import type { SaldoInventarioConvertido } from '@/dominio/importacao/mapa'

const erro = (contexto: string, e: { message: string } | null) => {
  if (e) throw new Error(`${contexto}: ${e.message}`)
}

/** Janela pré-migração (tabela ausente) — a tela avisa em vez de quebrar. */
const PRE_MIGRACAO = ['42P01', 'PGRST200', 'PGRST205']

export interface InventarioLinha {
  id: string
  titulo: string
  criado_em: string
  fechado_em: string | null
  /** Endereços aplicados no mapa — aplicado não reabre mais (08/09/2026). */
  aplicado_em: string | null
  inventario_saldos: { count: number }[]
  inventario_itens: { count: number }[]
}

export async function listarInventarios(): Promise<InventarioLinha[] | null> {
  let r = await supabase
    .from('inventarios')
    .select(
      'id, titulo, criado_em, fechado_em, aplicado_em, inventario_saldos ( count ), inventario_itens ( count )',
    )
    .order('criado_em', { ascending: false })
    .limit(100)
  if (r.error?.code === '42703') {
    // janela pré-migração inventario-mapa-ajuste-reserva.sql (sem aplicado_em)
    r = (await supabase
      .from('inventarios')
      .select(
        'id, titulo, criado_em, fechado_em, inventario_saldos ( count ), inventario_itens ( count )',
      )
      .order('criado_em', { ascending: false })
      .limit(100)) as unknown as typeof r
  }
  if (r.error) {
    if (PRE_MIGRACAO.includes(r.error.code ?? '')) return null
    throw new Error(`listar inventários: ${r.error.message}`)
  }
  return (r.data ?? []).map((i) => ({ aplicado_em: null, ...(i as object) })) as unknown as InventarioLinha[]
}

export async function criarInventario(titulo: string): Promise<string> {
  const { data, error } = await supabase
    .from('inventarios')
    .insert({ titulo })
    .select('id')
    .single()
  erro('criar inventário — a migração inventario.sql já rodou?', error)
  return (data as { id: string }).id
}

export async function excluirInventario(id: string): Promise<void> {
  const { data, error } = await supabase
    .from('inventarios')
    .delete()
    .eq('id', id)
    .select('id')
  erro('excluir inventário', error)
  // 0 linhas = RLS recusou ou já não existe — sem isto era no-op silencioso
  if ((data ?? []).length === 0) {
    throw new Error('inventário não excluído — sem permissão ou já não existe')
  }
}

/**
 * Substituição TOTAL da lista do SAP do inventário, transacional no
 * servidor (mesma semântica do upload do mapa). Devolve quantas
 * combinações a lista ficou tendo.
 */
export async function substituirSaldosInventario(
  id: string,
  saldos: SaldoInventarioConvertido[],
): Promise<number> {
  const { data, error } = await supabase.rpc('substituir_saldos_inventario', {
    p_id: id,
    p_saldos: saldos,
  })
  erro('gravar a lista do SAP — a migração inventario.sql já rodou?', error)
  return (data as number) ?? saldos.length
}

export interface SaldoInventarioLinha {
  id: string
  lote: string
  tratamento: string
  cultivar: string
  embalagem: string
  bags: number
}

export async function listarSaldosInventario(
  inventarioId: string,
): Promise<SaldoInventarioLinha[]> {
  // limit explícito: o PostgREST corta em 1000 linhas EM SILÊNCIO sem ele,
  // e o export do SAP já passa de 750 combinações
  const { data, error } = await supabase
    .from('inventario_saldos')
    .select('id, lote, tratamento, cultivar, embalagem, bags')
    .eq('inventario_id', inventarioId)
    .order('cultivar')
    .limit(10000)
  erro('listar a lista do SAP do inventário', error)
  return (data ?? []) as unknown as SaldoInventarioLinha[]
}

export interface ItemInventario {
  id: string
  lote: string
  tratamento: string
  cultivar: string | null
  embalagem: string
  armazem: string | null
  bloco: string | null
  quadra: string | null
  bags: number
  fora_da_lista: boolean
  criado_em: string
}

export interface NovoItemInventario {
  lote: string
  tratamento: string
  cultivar: string | null
  embalagem: string
  armazem: string | null
  bloco: string | null
  quadra: string | null
  bags: number
  fora_da_lista: boolean
}

export async function listarItensInventario(
  inventarioId: string,
): Promise<ItemInventario[]> {
  const { data, error } = await supabase
    .from('inventario_itens')
    .select(
      'id, lote, tratamento, cultivar, embalagem, armazem, bloco, quadra, bags, fora_da_lista, criado_em',
    )
    .eq('inventario_id', inventarioId)
    .order('criado_em', { ascending: false })
    .limit(10000)
  erro('listar a contagem', error)
  return (data ?? []) as unknown as ItemInventario[]
}

export async function adicionarItemInventario(
  inventarioId: string,
  item: NovoItemInventario,
): Promise<void> {
  const { error } = await supabase
    .from('inventario_itens')
    .insert({ ...item, inventario_id: inventarioId })
  erro('lançar a contagem', error)
}

export async function atualizarItemInventario(
  id: string,
  item: NovoItemInventario,
): Promise<void> {
  const { data, error } = await supabase
    .from('inventario_itens')
    .update(item)
    .eq('id', id)
    .select('id')
  erro('editar o lançamento', error)
  if ((data ?? []).length === 0) {
    throw new Error('o lançamento mudou por baixo — recarregue e tente de novo')
  }
}

export async function removerItemInventario(id: string): Promise<void> {
  const { data, error } = await supabase
    .from('inventario_itens')
    .delete()
    .eq('id', id)
    .select('id')
  erro('remover o lançamento', error)
  if ((data ?? []).length === 0) {
    throw new Error('o lançamento mudou por baixo — recarregue e tente de novo')
  }
}

/**
 * Fechar congela a comparação em inventario_resultados, NO SERVIDOR
 * (transacional, contra a lista e a contagem daquele instante). Devolve
 * quantas linhas o resultado tem.
 */
export async function fecharInventario(id: string): Promise<number> {
  const { data, error } = await supabase.rpc('fechar_inventario', { p_id: id })
  erro('fechar o inventário — a migração inventario.sql já rodou?', error)
  return (data as number) ?? 0
}

/** Reabrir apaga o resultado congelado e libera a contagem de novo. */
export async function reabrirInventario(id: string): Promise<void> {
  const { error } = await supabase.rpc('reabrir_inventario', { p_id: id })
  erro('reabrir o inventário', error)
}

export interface ResumoAplicacao {
  enderecados: number
  nao_encontrados: number
  sem_mapa: string[]
}

/**
 * Aplica os ENDEREÇOS do inventário no mapa (08/09/2026) — o saldo continua
 * o do SAP. Uma vez só; inventário aplicado não reabre mais. Transacional
 * no servidor (RPC com guarda própria).
 */
export async function aplicarInventarioNoMapa(id: string): Promise<ResumoAplicacao> {
  const { data, error } = await supabase.rpc('aplicar_inventario_no_mapa', { p_id: id })
  erro(
    'aplicar o inventário no mapa — a migração inventario-mapa-ajuste-reserva.sql já rodou?',
    error,
  )
  return data as ResumoAplicacao
}

export interface ResultadoInventario {
  lote: string
  tratamento: string
  cultivar: string | null
  embalagem: string
  bags_contados: number | null
  bags_sistema: number | null
}

export async function listarResultadosInventario(
  inventarioId: string,
): Promise<ResultadoInventario[]> {
  const { data, error } = await supabase
    .from('inventario_resultados')
    .select('lote, tratamento, cultivar, embalagem, bags_contados, bags_sistema')
    .eq('inventario_id', inventarioId)
    .limit(10000)
  erro('listar o resultado do inventário', error)
  return (data ?? []) as unknown as ResultadoInventario[]
}
