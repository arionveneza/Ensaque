/**
 * Conversão do export de Saldos do SAP — substituto temporário da Saldos da
 * SimpleAgro enquanto o TI não resolve o relatório de lá (achado do Arion,
 * 19/08/2026). Mesmo formato "um arquivo, dois destinos" da SimpleAgro (ver
 * `simpleagro.ts`): reaproveita os mesmos tipos de saída e o mesmo de-para
 * de embalagem — só a leitura das colunas muda, porque a origem é outra.
 */

import {
  EMBALAGEM_DEPARA, normaliza, normalizaCultivar, num, txt,
  type EstoquePaConvertido, type Linha, type LoteConvertido,
} from './simpleagro'

const paraData = (v: unknown): Date | null => {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  const s = txt(v)
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Só lote com entrada a partir daqui conta como estoque disponível — lote velho já baixado no SAP não deve reentrar (pedido do Arion, 19/08/2026). */
export const CORTE_SALDO_SAP = new Date('2026-01-01T00:00:00')

export interface ResumoSaldoSap {
  totalLinhas: number
  /** Sem embalagem reconhecida (BB5M/BMB) → ignorado (granel/pré-lote). */
  granel: number
  /** Sem Data de Entrada válida, ou anterior ao corte → ignorado. */
  antesDoCorte: number
  saldoZeroOuNegativo: number
  /** Saldo negativo na origem: ignorado, mas reportado. */
  negativos: { lote: string; bags: number }[]
  semPms: number
  /** "UM Estoque" vista em cada linha aproveitada — mais de uma chave aqui é sinal de unidade misturada (ex.: bag e kg juntos). */
  unidades: Record<string, number>
}

export interface ResultadoSaldoSap {
  lotes: LoteConvertido[]
  estoquePa: EstoquePaConvertido[]
  resumo: ResumoSaldoSap
  totalBagsLotes: number
  totalBagsEstoque: number
}

export const ehRelatorioSaldoSap = (rows: Linha[]): boolean => {
  const h = (rows[0] ?? []).map((c) => txt(c).toUpperCase())
  return h.includes('TRATAMENTO (TSI)') && h.includes('QTD EM ESTOQUE') && h.includes('Nº DO LOTE')
}

/**
 * Um arquivo, dois destinos — mesma regra da Saldos da SimpleAgro, e o
 * mesmo de-para de embalagem (BB5M→BG5M, BMB→MEIOBAG):
 * - Tratamento (TSI) = SEM TSI (ou vazio) → lotes de semente
 * - Tratamento real                       → estoque de produto acabado
 * - Sem embalagem reconhecida (granel/pré-lote) → ignorado
 *
 * Duas diferenças da SimpleAgro: (1) a Embalagem já vem numa coluna própria
 * (BB5M/BMB) — não precisa extrair do nome do produto, e por isso a
 * correção de CULTIVAR truncado (peculiaridade de lá) não se aplica aqui;
 * (2) só conta lote com Data de Entrada a partir de `CORTE_SALDO_SAP`.
 */
export function converterSaldoSap(rows: Linha[]): ResultadoSaldoSap {
  const h = (rows[0] ?? []).map((c) => txt(c).toUpperCase())
  const ix = (nome: string) => h.indexOf(nome)
  const iCult = ix('CULTIVAR')
  const iLote = ix('Nº DO LOTE')
  const iTrat = ix('TRATAMENTO (TSI)')
  const iEmb = ix('EMBALAGEM')
  const iSaldo = ix('QTD EM ESTOQUE')
  const iData = ix('DATA DE ENTRADA')
  const iUm = ix('UM ESTOQUE')
  const iPms = h.findIndex((x) => x.includes('PMS'))

  const lotes = new Map<string, LoteConvertido>()
  const estoque = new Map<string, EstoquePaConvertido>()
  const resumo: ResumoSaldoSap = {
    totalLinhas: Math.max(0, rows.length - 1),
    granel: 0,
    antesDoCorte: 0,
    saldoZeroOuNegativo: 0,
    negativos: [],
    semPms: 0,
    unidades: {},
  }

  for (const r of rows.slice(1)) {
    const embRaw = txt(r[iEmb])
    const emb = EMBALAGEM_DEPARA[normaliza(embRaw)]
    if (!emb) {
      resumo.granel++
      continue
    }
    const dataEntrada = paraData(r[iData])
    if (!dataEntrada || dataEntrada < CORTE_SALDO_SAP) {
      resumo.antesDoCorte++
      continue
    }
    const bags = num(r[iSaldo])
    if (bags < 0) resumo.negativos.push({ lote: txt(r[iLote]) || '?', bags })
    if (bags <= 0) {
      resumo.saldoZeroOuNegativo++
      continue
    }
    const um = txt(r[iUm]) || '(vazio)'
    resumo.unidades[um] = (resumo.unidades[um] ?? 0) + 1

    const cultivar = normalizaCultivar(txt(r[iCult]))
    const tratamento = txt(r[iTrat])
    const pms = iPms >= 0 ? num(r[iPms]) : 0

    if (!tratamento || tratamento.toUpperCase() === 'SEM TSI') {
      const id = txt(r[iLote])
      if (!id) continue
      if (!pms) resumo.semPms++
      const atual = lotes.get(id)
      if (atual) atual.bags += bags
      else
        lotes.set(id, {
          id,
          cultivar,
          tratamento: tratamento || 'SEM TSI',
          pms,
          pesoBagKg: Math.round(pms * emb.fator),
          bags,
        })
    } else {
      const chave = [cultivar, tratamento, emb.codigo].join('|')
      const atual = estoque.get(chave)
      if (atual) atual.bags += bags
      else
        estoque.set(chave, { cultivar, tratamento, embalagem: emb.codigo, bags })
    }
  }

  return {
    lotes: [...lotes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    estoquePa: [...estoque.values()].sort(
      (a, b) => a.cultivar.localeCompare(b.cultivar) || a.tratamento.localeCompare(b.tratamento),
    ),
    resumo,
    totalBagsLotes: [...lotes.values()].reduce((a, l) => a + l.bags, 0),
    totalBagsEstoque: [...estoque.values()].reduce((a, e) => a + e.bags, 0),
  }
}
