/**
 * Importador da aba Mapa — export de saldo do SAP (SAP.xlsx), o MESMO
 * arquivo do saldo de lotes, mas lido pra outra vista: TODO lote (semente
 * branca E tratada) do depósito VEN_GER, com a coluna Destinação (o aviso
 * da montagem de carga vem dela).
 *
 * A unidade é a COMBINAÇÃO lote + tratamento (o endereçamento físico do
 * Arion, 28/08/2026, provou que o mesmo lote existe branco e tratado ao
 * mesmo tempo, em endereços diferentes). Semente branca = tratamento
 * 'SEM TSI' (mesma convenção de lotes_semente).
 *
 * Diferenças do converterSaldoSap (sap.ts):
 * - não separa lote de estoque PA: tudo é lote no mapa;
 * - SÓ depósito VEN_GER (decisão do Arion, 28/08/2026 — o mapa é da UBS);
 * - lote zerado fica FORA (some do mapa na substituição);
 * - sem corte por data de entrada: o mapa mostra o que existe fisicamente.
 *
 * A mesma combinação pode vir em mais de uma linha (classe/validade
 * diferentes) — agrega somando bags e mantendo o primeiro valor não-vazio
 * dos demais campos.
 */

import { EMBALAGEM_DEPARA, normaliza, num, txt, type Linha } from './simpleagro'
import { corrigeTratamentoSap } from './sap'

export const DEPOSITO_MAPA = 'VEN_GER'
/** Tratamento da semente branca — mesma convenção de lotes_semente. */
export const SEM_TSI = 'SEM TSI'

export interface LoteMapaConvertido {
  lote: string
  /** 'SEM TSI' = semente branca (tratamento vazio ou SEM TSI no export). */
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
}

/**
 * Linha TRATADA do export: não cria lote no mapa (quem cria é a ordem de
 * produção, decisão de 30/08/2026) — só carimba destinação/classe na
 * combinação de número BASE (o sufixo -1/-2/-3 do SAP morre aqui).
 */
export interface EnriquecimentoTratado {
  /** Número BASE do lote (sem o sufixo do SAP). */
  lote: string
  tratamento: string
  /** Destinações distintas dos sub-lotes viram "A / B". */
  destinacao: string | null
  classificacao: string | null
}

export interface ResultadoLotesMapa {
  /** Só semente branca — substituição total no mapa. */
  lotes: LoteMapaConvertido[]
  /** Tratados do SAP, agregados por base + tratamento — só enriquecem. */
  enriquecimentos: EnriquecimentoTratado[]
  /** Linhas de dados lidas. */
  totalLinhas: number
  outrosDepositos: number
  zerados: number
  granel: number
  /** Combinações tratadas vs brancas — conferência visual. */
  tratados: number
  brancos: number
  comDestinacao: number
  /** Bags das brancas (o que efetivamente entra no saldo do mapa). */
  totalBags: number
}

/** Número base do lote — remove os sufixos -1/-2/-3 que só o SAP conhece. */
export const loteBase = (lote: string): string => lote.replace(/(-\d+)+$/, '')

/**
 * Estoque do SAP pro INVENTÁRIO (04/09/2026): a MESMA planilha, mas toda
 * linha vira saldo COM quantidade — branca E tratada (diferente do
 * converterLotesMapa, que joga o tratado fora sem bags: lá quem cria lote
 * tratado é a ordem de produção; aqui a lista é a referência da contagem
 * física). Agrega por lote BASE + tratamento + embalagem — bag de BB5M e
 * de BMB não podem somar juntos.
 */
export interface SaldoInventarioConvertido {
  lote: string
  /** 'SEM TSI' = semente branca. */
  tratamento: string
  cultivar: string
  embalagem: string
  bags: number
}

export interface ResultadoEstoqueInventario {
  saldos: SaldoInventarioConvertido[]
  totalLinhas: number
  outrosDepositos: number
  zerados: number
  /** Saldo NEGATIVO no SAP — fora da lista, mas reportado (não some calado). */
  negativos: number
  granel: number
  /** Combinações por tipo — conferência visual da prévia. */
  brancos: number
  tratados: number
  totalBags: number
}

export function converterEstoqueInventario(rows: Linha[]): ResultadoEstoqueInventario {
  const h = (rows[0] ?? []).map((c) => txt(c).toUpperCase())
  const iLote = idx(h, 'Nº DO LOTE')
  const iCult = idx(h, 'CULTIVAR')
  const iTrat = idx(h, 'TRATAMENTO (TSI)')
  const iEmb = idx(h, 'EMBALAGEM')
  const iSaldo = idx(h, 'QTD EM ESTOQUE')
  const iDep = idx(h, 'DEPÓSITO')
  if (iLote < 0 || iCult < 0 || iEmb < 0 || iSaldo < 0 || iDep < 0) {
    throw new Error(
      'Não achei as colunas "Nº do Lote", "Cultivar", "Embalagem", "Qtd em Estoque" e "Depósito" — é o export de saldo do SAP?',
    )
  }

  const saldos = new Map<string, SaldoInventarioConvertido>()
  const r: ResultadoEstoqueInventario = {
    saldos: [],
    totalLinhas: Math.max(0, rows.length - 1),
    outrosDepositos: 0,
    zerados: 0,
    negativos: 0,
    granel: 0,
    brancos: 0,
    tratados: 0,
    totalBags: 0,
  }

  for (const linha of rows.slice(1)) {
    const lote = txt(linha[iLote])
    if (!lote) continue
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
    if (bags < 0) {
      // negativo é anomalia do SAP: fica fora da lista, mas CONTADO — a
      // prévia avisa em vez de sumir calado (varredura de 04/09/2026)
      r.negativos++
      continue
    }
    if (bags === 0) {
      r.zerados++
      continue
    }

    const tratBruto = txt(linha[iTrat])
    const tratamento =
      !tratBruto || normaliza(tratBruto) === SEM_TSI ? SEM_TSI : corrigeTratamentoSap(tratBruto)
    const base = loteBase(lote)
    const chave = `${base}|${tratamento}|${emb.codigo}`
    const acc = saldos.get(chave)
    if (acc) acc.bags += bags
    else
      saldos.set(chave, {
        lote: base,
        tratamento,
        cultivar: txt(linha[iCult]),
        embalagem: emb.codigo,
        bags,
      })
  }

  r.saldos = [...saldos.values()].sort(
    (a, b) =>
      a.cultivar.localeCompare(b.cultivar) ||
      a.lote.localeCompare(b.lote) ||
      a.tratamento.localeCompare(b.tratamento),
  )
  for (const s of r.saldos) {
    if (s.tratamento === SEM_TSI) r.brancos++
    else r.tratados++
    r.totalBags += s.bags
  }
  r.totalBags = Math.round(r.totalBags * 100) / 100
  return r
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
  const tratados = new Map<string, EnriquecimentoTratado & { destinacoes: Set<string> }>()
  const r: ResultadoLotesMapa = {
    lotes: [],
    enriquecimentos: [],
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
    const lote = txt(linha[iLote])
    if (!lote) continue
    if (txt(linha[iDep]).toUpperCase() !== DEPOSITO_MAPA) {
      r.outrosDepositos++
      continue
    }

    const tratBruto = txt(linha[iTrat])
    const tratamento =
      !tratBruto || normaliza(tratBruto) === SEM_TSI ? SEM_TSI : corrigeTratamentoSap(tratBruto)

    if (tratamento !== SEM_TSI) {
      // TRATADO não cria lote no mapa (quem cria é a ordem de produção,
      // 30/08/2026): a linha só carrega destinação/classe pra combinação
      // de número BASE — o sufixo -1/-2/-3 do SAP morre aqui
      const base = loteBase(lote)
      const chave = `${base} ${tratamento}`
      const dest = txt(linha[iDest])
      const classif = iClassif >= 0 ? txt(linha[iClassif]) || null : null
      const acc = tratados.get(chave)
      if (acc) {
        if (dest) acc.destinacoes.add(dest)
        acc.classificacao ??= classif
      } else {
        tratados.set(chave, {
          lote: base,
          tratamento,
          destinacao: null,
          classificacao: classif,
          destinacoes: new Set(dest ? [dest] : []),
        })
      }
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

    const pms = iPms >= 0 ? num(linha[iPms]) || null : null
    const pesoBruto = iPesoBruto >= 0 ? num(linha[iPesoBruto]) : 0
    const pesoBag = pesoBruto > 0 ? pesoBruto : pms != null ? pms * emb.fator : 0

    // branca também entra pelo número BASE: o SAP sufixa branca em
    // reentrada/desdobramento, e a produção (ordens, endereçamento) só
    // conhece o número base (achado do Arion, 30/08/2026)
    const base = loteBase(lote)
    const chave = `${base} ${tratamento}`
    const acc = lotes.get(chave)
    if (acc) {
      // mesma combinação em mais de uma linha (classe/validade): soma bags,
      // mantém o primeiro valor não-vazio dos demais campos
      acc.bags += bags
      acc.destinacao ??= txt(linha[iDest]) || null
      acc.classificacao ??= iClassif >= 0 ? txt(linha[iClassif]) || null : null
    } else {
      lotes.set(chave, {
        lote: base,
        tratamento,
        cultivar: txt(linha[iCult]),
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

  r.lotes = [...lotes.values()].sort(
    (a, b) => a.lote.localeCompare(b.lote) || a.tratamento.localeCompare(b.tratamento),
  )
  r.enriquecimentos = [...tratados.values()]
    .map(({ destinacoes, ...e }) => ({
      ...e,
      destinacao: destinacoes.size > 0 ? [...destinacoes].sort().join(' / ') : null,
    }))
    .sort((a, b) => a.lote.localeCompare(b.lote) || a.tratamento.localeCompare(b.tratamento))
  r.brancos = r.lotes.length
  r.tratados = r.enriquecimentos.length
  for (const l of r.lotes) {
    if (l.destinacao) r.comDestinacao++
    r.totalBags += l.bags
  }
  for (const e of r.enriquecimentos) {
    if (e.destinacao) r.comDestinacao++
  }
  r.totalBags = Math.round(r.totalBags * 100) / 100
  return r
}
