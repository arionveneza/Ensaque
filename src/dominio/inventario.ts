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
// Relatório dos armazéns × SAP (13/10/2026, pedido do Arion: "um relatório
// dos 5 armazéns para cruzar com o relatório do SAP e verificar as
// divergências"). Junta a contagem dos inventários de armazém — um por
// armazém — e compara o TOTAL com a lista do SAP (que não sabe o armazém),
// mostrando quanto cada armazém contou de cada combinação.
// ================================================================

export interface ContagemPorArmazem extends ContagemInventario {
  armazem: string | null
  descarte?: boolean
}

export interface LinhaConferenciaArmazens extends LinhaInventario {
  /** Bags contados em cada armazém (só os que lançaram a combinação). */
  porArmazem: Record<string, number>
  /** Bags da combinação marcados como descarte na contagem. */
  descarte: number
}

export function conferenciaArmazens(
  contagens: ContagemPorArmazem[],
  saldos: SaldoInventario[],
): LinhaConferenciaArmazens[] {
  const extra = new Map<string, { porArmazem: Record<string, number>; descarte: number }>()
  for (const c of contagens) {
    const chave = chaveInventario(c.lote, c.tratamento, c.embalagem)
    const e = extra.get(chave) ?? { porArmazem: {}, descarte: 0 }
    const arm = (c.armazem ?? '').trim().toUpperCase() || '?'
    e.porArmazem[arm] = (e.porArmazem[arm] ?? 0) + c.bags
    if (c.descarte) e.descarte += c.bags
    extra.set(chave, e)
  }
  return compararInventario(contagens, saldos).map((l) => {
    const e = extra.get(chaveInventario(l.lote, l.tratamento, l.embalagem))
    return { ...l, porArmazem: e?.porArmazem ?? {}, descarte: e?.descarte ?? 0 }
  })
}

export interface ResumoConferenciaArmazens {
  porSituacao: Record<SituacaoInventario, { linhas: number; bags: number }>
  contado: number
  sistema: number
  diferenca: number
  porArmazem: Record<string, number>
}

/** Totais do relatório: bags por situação (a diferença, em módulo), por armazém e geral. */
export function resumoConferenciaArmazens(linhas: LinhaConferenciaArmazens[]): ResumoConferenciaArmazens {
  const porSituacao = Object.fromEntries(
    (Object.keys(ROTULO_SITUACAO) as SituacaoInventario[]).map((s) => [s, { linhas: 0, bags: 0 }]),
  ) as Record<SituacaoInventario, { linhas: number; bags: number }>
  const porArmazem: Record<string, number> = {}
  let contado = 0
  let sistema = 0
  for (const l of linhas) {
    porSituacao[l.situacao].linhas += 1
    porSituacao[l.situacao].bags += l.situacao === 'bate' ? l.contado ?? 0 : Math.abs(l.diferenca)
    contado += l.contado ?? 0
    sistema += l.sistema ?? 0
    for (const [a, b] of Object.entries(l.porArmazem)) porArmazem[a] = (porArmazem[a] ?? 0) + b
  }
  return { porSituacao, contado, sistema, diferenca: contado - sistema, porArmazem }
}

export interface InventarioEscolhivel {
  id: string
  armazem: string | null
  criado_em: string
  lancamentos: number
}

/**
 * Qual inventário representa cada armazém no relatório: o mais recente COM
 * lançamento (o "Inventário armazém A" criado vazio às 14:00 não pode
 * esconder o "INVENTARIO A" contado); sem nenhum contado, o mais recente.
 */
export function inventarioPorArmazem(
  invs: InventarioEscolhivel[],
  armazens: readonly string[],
): Record<string, string | null> {
  const escolha: Record<string, string | null> = {}
  for (const a of armazens) {
    const doArmazem = invs
      .filter((i) => i.armazem === a)
      .sort((x, y) => y.criado_em.localeCompare(x.criado_em))
    escolha[a] = (doArmazem.find((i) => i.lancamentos > 0) ?? doArmazem[0])?.id ?? null
  }
  return escolha
}

// ================================================================
// Grade do "armazém X inventário" (13/10/2026): a contagem desenhada como
// o mapa — uma célula por lote × endereço, somando lançamentos repetidos
// no mesmo endereço; contagem zero não ocupa quadra.
// ================================================================

export interface AlocacaoContagem {
  lote: string
  tratamento: string
  cultivar: string | null
  embalagem: string
  armazem: string
  bloco: string
  quadra: string
  bags: number
  /** Bags da combinação no inventário inteiro (todos os endereços). */
  bagsCombinacao: number
  descarte: boolean
}

export function alocacoesDaContagem(
  itens: {
    lote: string
    tratamento: string
    cultivar?: string | null
    embalagem: string
    armazem: string | null
    bloco: string | null
    quadra: string | null
    bags: number
    descarte?: boolean
  }[],
): AlocacaoContagem[] {
  const por = new Map<string, AlocacaoContagem>()
  const total = new Map<string, number>()
  for (const i of itens) {
    if (!(i.bags > 0) || !i.armazem || !i.bloco || !i.quadra) continue
    const lote = loteBaseMaiusculo(i.lote)
    const tratamento = i.tratamento.trim().toUpperCase()
    const chaveComb = `${lote}|${tratamento}`
    total.set(chaveComb, (total.get(chaveComb) ?? 0) + i.bags)
    const armazem = i.armazem.trim().toUpperCase()
    const bloco = i.bloco.trim().toUpperCase()
    const quadra = i.quadra.trim().toUpperCase()
    const chave = `${chaveComb}|${armazem}|${bloco}|${quadra}`
    const atual = por.get(chave)
    if (atual) {
      atual.bags += i.bags
      atual.descarte = atual.descarte || !!i.descarte
      atual.cultivar = atual.cultivar ?? i.cultivar ?? null
    } else {
      por.set(chave, {
        lote, tratamento, cultivar: i.cultivar ?? null, embalagem: i.embalagem.trim().toUpperCase(),
        armazem, bloco, quadra, bags: i.bags, bagsCombinacao: 0, descarte: !!i.descarte,
      })
    }
  }
  for (const a of por.values()) a.bagsCombinacao = total.get(`${a.lote}|${a.tratamento}`) ?? a.bags
  return [...por.values()].sort(
    (a, b) =>
      a.armazem.localeCompare(b.armazem) ||
      a.bloco.localeCompare(b.bloco, undefined, { numeric: true }) ||
      a.quadra.localeCompare(b.quadra, undefined, { numeric: true }) ||
      a.lote.localeCompare(b.lote),
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
    else chavesNao.set(chave, { lote, tratamento })
  }
  // achada SÓ batendo lote+tratamento+EMBALAGEM (decisão do Arion,
  // 10/09/2026): contada em outra embalagem NÃO tira a combinação dos não
  // encontrados — ela pode aparecer nas duas listas (endereça a parte
  // contada E fica marcada pela parte que ninguém achou)

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
