/**
 * Importador da aba Mapa — export de saldo do SAP (SAP.xlsx), o MESMO
 * arquivo do saldo de lotes, mas lido pra outra vista: TODO lote (semente
 * branca E tratada) do depósito VEN_GER, com a coluna Destinação (o aviso
 * da montagem de carga vem dela).
 *
 * Diferenças do converterSaldoSap (sap.ts):
 * - não separa lote de estoque PA: tudo é lote no mapa (tratamento
 *   preenchido = tratado, vazio/SEM TSI = branco);
 * - SÓ depósito VEN_GER (decisão do Arion, 28/08/2026 — o mapa é da UBS;
 *   VTP_GER etc. ficam fora);
 * - lote zerado fica FORA (some do mapa na substituição);
 * - sem corte por data de entrada: o mapa mostra o que existe fisicamente.
 *
 * O mesmo lote pode vir em mais de uma linha (classe/validade diferentes) —
 * agrega somando bags e mantendo o primeiro valor não-vazio dos demais
 * campos (9 casos no export real de 28/08/2026).
 */

import { EMBALAGEM_DEPARA, normaliza, num, txt, type Linha } from './simpleagro'
import { corrigeTratamentoSap } from './sap'

export const DEPOSITO_MAPA = 'VEN_GER'

export interface LoteMapaConvertido {
  id: string
  cultivar: string
  /** null = semente branca (tratamento vazio ou SEM TSI no export). */
  tratamento: string | null
  embalagem: string
  pms: number | null
  peso_bag_kg: number
  bags: number
  destinacao: string | null
  classificacao: string | null
  peneira: string | null
  categoria: string | null
}

export interface ResultadoLotesMapa {
  lotes: LoteMapaConvertido[]
  totalLinhas: number
  outrosDepositos: number
  zerados: number
  granel: number
  /** Quantos lotes têm tratamento (tratados) vs brancos — conferência visual. */
  tratados: number
  brancos: number
  comDestinacao: number
  totalBags: number
}

const idx = (h: string[], nome: string) => h.indexOf(nome)

export function ehRelatorioMapa(rows: Linha[]): boolean {
  const h = (rows[0] ?? []).map((c) => txt(c).toUpperCase())
  return (
    h.includes('Nº DO LOTE') &&
    h.includes('QTD EM ESTOQUE') &&
    h.includes('DESTINAÇÃO') &&
    h.includes('DEPÓSITO')
  )
}

export function converterLotesMapa(rows: Linha[]): ResultadoLotesMapa {
  const h = (rows[0] ?? []).map((c) => txt(c).toUpperCase())
  const iLote = idx(h, 'Nº DO LOTE')
  const iCult = idx(h, 'CULTIVAR')
  const iTrat = idx(h, 'TRATAMENTO (TSI)')
  const iEmb = idx(h, 'EMBALAGEM')
  const iSaldo = idx(h, 'QTD EM ESTOQUE')
  const iDest = idx(h, 'DESTINAÇÃO')
  const iDep = idx(h, 'DEPÓSITO')
  const iPms = h.findIndex((x) => x.includes('PMS'))
  const iPesoBruto = h.findIndex((x) => x.includes('PESO BRUTO'))
  const iClassif = h.findIndex((x) => x.includes('CLASSIFICA'))
  const iPeneira = h.findIndex((x) => x.includes('PENEIRA'))
  const iCategoria = h.findIndex((x) => x.includes('CATEGORIA'))
  if (iLote < 0 || iCult < 0 || iSaldo < 0 || iDest < 0 || iDep < 0) {
    throw new Error(
      'Não achei as colunas "Nº do Lote", "Cultivar", "Qtd em Estoque", "Destinação" e "Depósito" — é o export de saldo do SAP?',
    )
  }

  const lotes = new Map<string, LoteMapaConvertido>()
  const r: ResultadoLotesMapa = {
    lotes: [],
    totalLinhas: Math.max(0, rows.length - 1),
    outrosDepositos: 0,
    zerados: 0,
    granel: 0,
    tratados: 0,
    brancos: 0,
    comDestinacao: 0,
    totalBags: 0,
  }

  for (const linha of rows.slice(1)) {
    const id = txt(linha[iLote])
    if (!id) continue
    if (txt(linha[iDep]).toUpperCase() !== DEPOSITO_MAPA) {
      r.outrosDepositos++
      continue
    }
    const emb = EMBALAGEM_DEPARA[normaliza(txt(linha[iEmb]))]
    if (!emb) {
      r.granel++
      continue
    }
    const bags = num(linha[iSaldo])
    if (bags <= 0) {
      r.zerados++
      continue
    }

    const tratBruto = txt(linha[iTrat])
    const tratamento =
      !tratBruto || normaliza(tratBruto) === 'SEM TSI' ? null : corrigeTratamentoSap(tratBruto)
    const pms = iPms >= 0 ? num(linha[iPms]) || null : null
    const pesoBruto = iPesoBruto >= 0 ? num(linha[iPesoBruto]) : 0
    const pesoBag = pesoBruto > 0 ? pesoBruto : pms != null ? pms * emb.fator : 0

    const acc = lotes.get(id)
    if (acc) {
      // mesmo lote em mais de uma linha (classe/validade): soma bags, mantém
      // o primeiro valor não-vazio dos demais campos
      acc.bags += bags
      acc.destinacao ??= txt(linha[iDest]) || null
      acc.classificacao ??= iClassif >= 0 ? txt(linha[iClassif]) || null : null
    } else {
      lotes.set(id, {
        id,
        cultivar: txt(linha[iCult]),
        tratamento,
        embalagem: emb.codigo,
        pms,
        peso_bag_kg: Math.round(pesoBag * 1000) / 1000,
        bags,
        destinacao: txt(linha[iDest]) || null,
        classificacao: iClassif >= 0 ? txt(linha[iClassif]) || null : null,
        peneira: iPeneira >= 0 ? txt(linha[iPeneira]) || null : null,
        categoria: iCategoria >= 0 ? txt(linha[iCategoria]) || null : null,
      })
    }
  }

  r.lotes = [...lotes.values()].sort((a, b) => a.id.localeCompare(b.id))
  for (const l of r.lotes) {
    if (l.tratamento) r.tratados++
    else r.brancos++
    if (l.destinacao) r.comDestinacao++
    r.totalBags += l.bags
  }
  r.totalBags = Math.round(r.totalBags * 100) / 100
  return r
}
