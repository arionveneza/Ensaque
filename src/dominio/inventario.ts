/**
 * Inventário de sementes (04/09/2026): contagem física × estoque do SAP.
 *
 * O inventário é FORA do mapa de propósito (pedido do Arion): a referência
 * é a lista do SAP que o PCP INSERE no próprio inventário (upload da mesma
 * planilha do mapa, guardada em `inventario_saldos`), e nenhum saldo é
 * ajustado — a conferência só responde "bate ou não bate?".
 *
 * A unidade é lote + tratamento + EMBALAGEM ('SEM TSI' = semente branca):
 * bag de BB5M e de BMB não podem somar juntos. O contador lança endereço +
 * quantidade, uma vez por endereço — a conferência SOMA os lançamentos.
 *
 * A normalização daqui é ESPELHO da RPC fechar_inventario (inventario.sql
 * — mudou um, mude o outro): lote BASE maiúsculo (sufixos -1/-2 morrem),
 * tratamento e embalagem maiúsculos, soma por combinação.
 */

import { loteBase } from '@/dominio/importacao/mapa'

export interface ContagemInventario {
  lote: string
  tratamento: string
  embalagem: string
  /** Preenchido nos lançamentos manuais ("não está na lista"). */
  cultivar?: string | null
  bags: number
}

export interface SaldoInventario {
  lote: string
  tratamento: string
  embalagem: string
  cultivar: string | null
  bags: number
}

export type SituacaoInventario =
  | 'bate'
  | 'sobra'
  | 'falta'
  | 'nao_contado'
  | 'fora_do_sap'

export interface LinhaInventario {
  lote: string
  tratamento: string
  embalagem: string
  cultivar: string | null
  /** null = combinação do SAP que ninguém contou. */
  contado: number | null
  /** null = contada mas não está na lista do SAP. */
  sistema: number | null
  diferenca: number
  situacao: SituacaoInventario
}

export const ROTULO_SITUACAO: Record<SituacaoInventario, string> = {
  bate: 'Bate',
  sobra: 'Sobra',
  falta: 'Falta',
  nao_contado: 'Não contado',
  fora_do_sap: 'Fora do SAP',
}

/** Número BASE maiúsculo — a forma canônica do lote em todo o inventário. */
export const loteBaseMaiusculo = (lote: string): string =>
  loteBase(lote.trim()).toUpperCase()

/** Chave de comparação: lote BASE + tratamento + embalagem, maiúsculos. */
export const chaveInventario = (
  lote: string,
  tratamento: string,
  embalagem: string,
): string =>
  `${loteBaseMaiusculo(lote)}|${tratamento.trim().toUpperCase()}|${embalagem.trim().toUpperCase()}`

/**
 * Bags fracionários existem (meio bag na frente do box), então a igualdade
 * tem tolerância de centésimo — mesma régua das travas de saldo da carga.
 */
export function situacaoDe(
  contado: number | null,
  sistema: number | null,
): SituacaoInventario {
  if (contado == null) return 'nao_contado'
  if (sistema == null) return 'fora_do_sap'
  // arredonda ao centésimo ANTES de comparar — 100,01 − 100 dá
  // 0,01000000000000512 em ponto flutuante e estouraria a tolerância
  const dif = Math.round((contado - sistema) * 100) / 100
  if (Math.abs(dif) <= 0.01) return 'bate'
  return dif > 0 ? 'sobra' : 'falta'
}

/** Divergência primeiro: é o que o inventário existe pra achar. */
const PESO_SITUACAO: Record<SituacaoInventario, number> = {
  fora_do_sap: 0,
  sobra: 1,
  falta: 2,
  nao_contado: 3,
  bate: 4,
}

/**
 * Cruza a contagem com a lista do SAP. Lançamentos repetidos da mesma
 * combinação SOMAM (um por endereço); combinação contada com 0 bags é
 * "contei e está vazio" — compara como zero, não como ausente. O cultivar
 * vem do SAP; na linha fora da lista, do que o contador digitou.
 */
export function compararInventario(
  contagens: ContagemInventario[],
  saldos: SaldoInventario[],
): LinhaInventario[] {
  const contadoPor = new Map<
    string,
    { lote: string; tratamento: string; embalagem: string; cultivar: string | null; bags: number }
  >()
  for (const c of contagens) {
    const chave = chaveInventario(c.lote, c.tratamento, c.embalagem)
    const atual = contadoPor.get(chave)
    if (atual) {
      atual.bags += c.bags
      atual.cultivar = atual.cultivar ?? c.cultivar ?? null
    } else
      contadoPor.set(chave, {
        lote: loteBaseMaiusculo(c.lote),
        tratamento: c.tratamento.trim().toUpperCase(),
        embalagem: c.embalagem.trim().toUpperCase(),
        cultivar: c.cultivar ?? null,
        bags: c.bags,
      })
  }

  const sistemaPor = new Map<
    string,
    { lote: string; tratamento: string; embalagem: string; cultivar: string | null; bags: number }
  >()
  for (const s of saldos) {
    const chave = chaveInventario(s.lote, s.tratamento, s.embalagem)
    const atual = sistemaPor.get(chave)
    if (atual) {
      atual.bags += s.bags
      atual.cultivar = atual.cultivar ?? s.cultivar
    } else
      sistemaPor.set(chave, {
        lote: loteBaseMaiusculo(s.lote),
        tratamento: s.tratamento.trim().toUpperCase(),
        embalagem: s.embalagem.trim().toUpperCase(),
        cultivar: s.cultivar,
        bags: s.bags,
      })
  }

  const chaves = new Set([...contadoPor.keys(), ...sistemaPor.keys()])
  const linhas: LinhaInventario[] = []
  for (const chave of chaves) {
    const c = contadoPor.get(chave) ?? null
    const s = sistemaPor.get(chave) ?? null
    const contado = c ? c.bags : null
    const sistema = s ? s.bags : null
    linhas.push({
      lote: (s ?? c)!.lote,
      tratamento: (s ?? c)!.tratamento,
      embalagem: (s ?? c)!.embalagem,
      cultivar: s?.cultivar ?? c?.cultivar ?? null,
      contado,
      sistema,
      diferenca: (contado ?? 0) - (sistema ?? 0),
      situacao: situacaoDe(contado, sistema),
    })
  }

  return linhas.sort(
    (a, b) =>
      PESO_SITUACAO[a.situacao] - PESO_SITUACAO[b.situacao] ||
      (a.cultivar ?? '').localeCompare(b.cultivar ?? '') ||
      a.lote.localeCompare(b.lote) ||
      a.tratamento.localeCompare(b.tratamento) ||
      a.embalagem.localeCompare(b.embalagem),
  )
}

// ================================================================
// Aplicação no MAPA (08/09/2026): SÓ ENDEREÇOS — o saldo continua o do
// SAP; sobra/falta é ajuste lá (e depois Ajuste de estoque no mapa).
// Esta prévia é o ESPELHO da RPC aplicar_inventario_no_mapa
// (inventario-mapa-ajuste-reserva.sql — mudou um, mude o outro).
// ================================================================

export interface EnderecoAplicacao {
  armazem: string
  bloco: string
  quadra: string
  bags: number
}

export interface CombinacaoAplicacao {
  lote: string
  tratamento: string
  enderecos: EnderecoAplicacao[]
}

export interface PlanoAplicacao {
  /** Combinações contadas que existem no mapa: endereços serão SUBSTITUÍDOS. */
  enderecar: CombinacaoAplicacao[]
  /** Na lista do SAP, ninguém contou: só ganham a marca no mapa. */
  naoEncontrados: { lote: string; tratamento: string }[]
  /** Contadas mas sem linha no mapa: nada muda — resolve-se pelo Ajuste. */
  semMapa: { lote: string; tratamento: string }[]
}

interface ItemAplicacao {
  lote: string
  tratamento: string
  armazem: string | null
  bloco: string | null
  quadra: string | null
  bags: number
}

/**
 * Prévia da aplicação: cruza o resultado congelado com os lançamentos e o
 * mapa atual. Chave = (lote, tratamento) — a chave do MAPA; a embalagem
 * fica de fora (a linha do mapa tem uma só). Lançamentos do mesmo endereço
 * somam; contagem 0 num lugar não vira endereço.
 */
export function planoAplicacao(
  resultados: { lote: string; tratamento: string; bags_contados: number | null }[],
  itens: ItemAplicacao[],
  lotesMapa: { lote: string; tratamento: string }[],
): PlanoAplicacao {
  const noMapa = new Set(lotesMapa.map((l) => `${l.lote}|${l.tratamento}`))

  const chavesContadas = new Map<string, { lote: string; tratamento: string }>()
  const chavesNao = new Map<string, { lote: string; tratamento: string }>()
  for (const r of resultados) {
    const lote = loteBaseMaiusculo(r.lote)
    const tratamento = r.tratamento.trim().toUpperCase()
    const chave = `${lote}|${tratamento}`
    if (r.bags_contados != null) chavesContadas.set(chave, { lote, tratamento })
    else if (!chavesContadas.has(chave)) chavesNao.set(chave, { lote, tratamento })
  }
  // a mesma combinação pode ter uma embalagem contada e outra não —
  // contada em qualquer embalagem = contada
  for (const chave of chavesContadas.keys()) chavesNao.delete(chave)

  const enderecosPor = new Map<string, Map<string, EnderecoAplicacao>>()
  for (const i of itens) {
    const chave = `${loteBaseMaiusculo(i.lote)}|${i.tratamento.trim().toUpperCase()}`
    if (!chavesContadas.has(chave)) continue
    const armazem = (i.armazem ?? '').trim().toUpperCase()
    if (!armazem) continue
    const bloco = (i.bloco ?? '').trim().toUpperCase()
    const quadra = (i.quadra ?? '').trim().toUpperCase()
    const chaveEnd = `${armazem}|${bloco}|${quadra}`
    const porEnd = enderecosPor.get(chave) ?? new Map<string, EnderecoAplicacao>()
    const atual = porEnd.get(chaveEnd)
    if (atual) atual.bags += i.bags
    else porEnd.set(chaveEnd, { armazem, bloco, quadra, bags: i.bags })
    enderecosPor.set(chave, porEnd)
  }

  const plano: PlanoAplicacao = { enderecar: [], naoEncontrados: [], semMapa: [] }
  for (const [chave, c] of chavesContadas) {
    if (noMapa.has(chave)) {
      plano.enderecar.push({
        ...c,
        enderecos: [...(enderecosPor.get(chave)?.values() ?? [])].filter((e) => e.bags > 0),
      })
    } else {
      plano.semMapa.push(c)
    }
  }
  for (const [chave, c] of chavesNao) {
    if (noMapa.has(chave)) plano.naoEncontrados.push(c)
  }

  const porLote = (a: { lote: string }, b: { lote: string }) => a.lote.localeCompare(b.lote)
  plano.enderecar.sort(porLote)
  plano.naoEncontrados.sort(porLote)
  plano.semMapa.sort(porLote)
  return plano
}
