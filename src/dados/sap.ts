import { supabase } from '@/lib/supabase'

/**
 * Leitura do SAP Business One através da Edge Function `sap`.
 *
 * O navegador nunca fala com o Service Layer: as credenciais ficam nos secrets
 * da função. Aqui só existem as ações que a função aceita — qualquer coisa
 * fora dessa lista é recusada do outro lado.
 *
 * Esta fase é somente leitura. O apontamento continua gravando no Supabase.
 */

export interface SementeSap {
  itemCode: string
  nome: string
  estoque: number
  grupo: number | null
}

export interface LoteSap {
  numero: string
  itemCode: string
  quantidade: number
  validade: string | null
  fabricacao: string | null
}

interface Resposta<T> {
  dados?: T
  erro?: string
  permitidas?: string[]
}

async function chamar<T>(corpo: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke<Resposta<T>>('sap', {
    body: corpo,
  })

  // erro de transporte, função ausente ou status não-2xx
  if (error) {
    // a função devolve JSON com `erro` mesmo em status de falha; tenta ler
    const detalhe = await extraiMensagem(error)
    throw new Error(detalhe ?? `Falha ao chamar o SAP: ${error.message}`)
  }
  if (!data) throw new Error('O SAP não devolveu resposta.')
  if (data.erro) throw new Error(data.erro)
  if (data.dados === undefined) throw new Error('Resposta do SAP sem dados.')
  return data.dados
}

/** FunctionsHttpError carrega a resposta original; sem isso o erro vira "non-2xx". */
async function extraiMensagem(error: unknown): Promise<string | null> {
  const contexto = (error as { context?: Response }).context
  if (!contexto || typeof contexto.json !== 'function') return null
  try {
    const corpo = (await contexto.json()) as { erro?: string }
    return corpo?.erro ?? null
  } catch {
    return null
  }
}

/** Confere se a função consegue autenticar no SAP, sem trazer dados. */
export const pingSap = () => chamar<{ sap: string; base: string }>({ acao: 'ping' })

/** Itens com prefixo SOJ e saldo maior que zero. */
export const sementesComEstoque = () =>
  chamar<SementeSap[]>({ acao: 'sementesComEstoque' })

/** Lotes de um item, para rastreabilidade. */
export const lotesDoItem = (itemCode: string) =>
  chamar<LoteSap[]>({ acao: 'lotesDoItem', itemCode })

/**
 * Linha de pedido de venda em aberto, vinda da consulta salva TSI_PEDIDOS.
 * As chaves são os aliases do SQL — o SAP devolve exatamente como nomeados.
 */
export interface PedidoSap {
  PV: number | string
  DataPedido: string | null
  Safra: string | null
  Filial: string | null
  Vendedor: string | null
  CodPN: string | null
  NomePN: string | null
  CodItem: string
  DescricaoItem: string
  Quantidade: number
  QuantidadePendente: number
  /** UDF U_TP_Tratamento: o código do tratamento, língua única com o comercial. */
  Tratamento: string | null
  SituacaoPedido: string | null
  Deposito: string | null
  Status: string | null
}

/** Pedidos de venda em aberto. Exige a consulta já registrada no SAP. */
export const pedidosVenda = () => chamar<PedidoSap[]>({ acao: 'pedidosVenda' })

/**
 * Cria a consulta salva no SAP. Única operação de escrita, restrita ao
 * Gestor — é instalação, roda uma vez. Não toca dado de negócio.
 */
export const registrarConsultaPedidos = () =>
  chamar<{ registrada: boolean; codigo: string; jaExistia: boolean }>({
    acao: 'registrarConsultaPedidos',
  })
