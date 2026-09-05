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
