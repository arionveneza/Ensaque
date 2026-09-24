/**
 * Estoque futuro por produto (cultivar + tratamento + embalagem):
 *
 *   futuro = estoque do SAP + planejado confirmado − A carregar
 *
 * Pedido do Arion (22/09/2026 o estoque + planejado; 24/09/2026 o "A
 * carregar"). O "A carregar" são os itens em ordem de carregamento da
 * SimpleAgro que ainda não foram faturados (`montagemCarga.ts` já separou os
 * faturados e contou cada item uma vez) com Data Carga até o dia escolhido —
 * "ver como estará a situação neste dia". Item SEM data entra sempre:
 * caminhão sem dia é demanda de prazo desconhecido, nunca "depois".
 *
 * O casamento entre o balanço (pedidos/SAP/ordens) e a montagem é pela
 * `chaveProduto` da Expedição — cultivar e tratamento normalizados ("FTZ60 S"
 * = "FTZ 60 S"), embalagem estrita. Semente branca (SEM TSI) e embalagem sem
 * de-para ficam fora da conta, contadas no resumo: não existe estoque de
 * produto acabado para abater delas.
 *
 * O planejado é ORDEM A ORDEM, pelos status que a tela marcar (24/09/2026,
 * pedido do Arion: "às vezes a ordem em Qualidade apontada já foi lançada no
 * SAP e o estoque dá problema" — contar ela de novo seria dobrar o estoque).
 * Padrão (`STATUS_PLANEJADO_PADRAO`): toda ordem confirmada, do Aguardando
 * lote à Qualidade apontada, inclusive em produção, mais as apontadas no
 * AGROTIS depois do último saldo do SAP — que saíram do planejado e ainda não
 * estão no saldo (154 bg sumiam dos dois lados até o próximo upload). Sem a
 * lista de ordens, cai no `planejado_confirmado` da view (mesma regra, sem
 * as apontadas).
 */

import { chaveProduto, normalizaTratamento } from './expedicao'

export interface BalancoFuturo {
  cultivar: string
  tratamento: string
  embalagem: string
  estoque_pa: number
  planejado_confirmado?: number
}

export interface ItemCarregar {
  numero_carga: string
  status_carga: string
  data_carga: string | null
  cultivar: string
  tratamento: string
  embalagem: string
  bags: number
}

/** Grupo das ordens apontadas no AGROTIS depois do último saldo do SAP. */
export const STATUS_APONTADA_APOS_SALDO = 'Apontada após o saldo'

/** Os status que o seletor oferece, na ordem do ciclo de vida (valores do status_efetivo). */
export const STATUS_PLANEJAVEIS = [
  'Nao programada', 'Programada', 'Aguardando lote', 'Pronto para produzir',
  'Em producao', 'Parada', 'Finalizada', 'Qualidade apontada', STATUS_APONTADA_APOS_SALDO,
]

/** Padrão: toda ordem confirmada até a Qualidade apontada + as apontadas depois do saldo. */
export const STATUS_PLANEJADO_PADRAO = STATUS_PLANEJAVEIS.filter(
  (st) => st !== 'Nao programada' && st !== 'Programada',
)

/** Ordem candidata ao planejado, com o status que decide se conta. */
export interface OrdemPlanejavel {
  numero: string
  status: string
  cultivar: string
  tratamento: string
  embalagem: string
  bags: number
}

export interface CargaDoProduto {
  carga: string
  /** Menor data da carga para o produto (ISO) — null = sem data. */
  data: string | null
  status: string
  bags: number
}

export interface LinhaEstoqueFuturo {
  chave: string
  cultivar: string
  tratamento: string
  embalagem: string
  estoque: number
  /** Soma das ordens nos status marcados. */
  planejado: number
  /** Parte do planejado que já foi apontada depois do saldo (ainda fora do SAP). */
  apontadoPosSaldo: number
  /** Ordens que entraram no planejado (vazio quando veio da view). */
  ordensPlanejadas: { numero: string; status: string; bags: number }[]
  aCarregar: number
  futuro: number
  /** Cargas que compõem o A carregar, por data (sem data primeiro). */
  cargas: CargaDoProduto[]
}

export interface ResumoEstoqueFuturo {
  /** Itens e bags que entraram no A carregar. */
  considerados: { itens: number; bags: number }
  /** Parte dos considerados que não tem data (entram sempre). */
  semData: { itens: number; bags: number }
  /** Com data depois do dia escolhido — fora da conta. */
  depois: { itens: number; bags: number }
  /** Semente branca — fora (não é produto acabado). */
  semTsi: { itens: number; bags: number }
  /** Embalagem sem de-para no app — fora, sem onde casar. */
  embalagemDesconhecida: { itens: number; bags: number; codigos: string[] }
  /**
   * Bags por status de TODAS as ordens candidatas (marcadas ou não), já sem
   * SEM TSI e embalagem sem de-para — pra tela mostrar quanto cada status
   * pesa e o que ficou de fora.
   */
  planejadoPorStatus: Record<string, { itens: number; bags: number }>
}

const arred2 = (x: number) => Math.round(x * 100) / 100
const soma = (a: { itens: number; bags: number }, bags: number) => {
  a.itens++
  a.bags = arred2(a.bags + bags)
}

export function calcularEstoqueFuturo(
  balanco: BalancoFuturo[],
  itens: ItemCarregar[],
  opcoes: {
    /** Dia limite (ISO); vazio = todas as datas. */
    ate?: string
    /** Códigos de embalagem que o app conhece (BG5M, MEIOBAG…). */
    embalagensConhecidas: ReadonlySet<string>
    /** Ordens candidatas ao planejado (abertas + apontadas depois do saldo). */
    ordens?: OrdemPlanejavel[]
    /** Status que contam; sem isto, conta `STATUS_PLANEJADO_PADRAO`. */
    statusPlanejado?: ReadonlySet<string>
  },
): { linhas: LinhaEstoqueFuturo[]; resumo: ResumoEstoqueFuturo } {
  const ate = opcoes.ate || ''
  const mapa = new Map<string, LinhaEstoqueFuturo>()
  const linhaDe = (p: { cultivar: string; tratamento: string; embalagem: string }) => {
    const chave = chaveProduto(p)
    let l = mapa.get(chave)
    if (!l) {
      l = {
        chave, cultivar: p.cultivar, tratamento: p.tratamento, embalagem: p.embalagem,
        estoque: 0, planejado: 0, apontadoPosSaldo: 0, ordensPlanejadas: [], aCarregar: 0, futuro: 0, cargas: [],
      }
      mapa.set(chave, l)
    }
    return l
  }

  for (const b of balanco) {
    if (normalizaTratamento(b.tratamento) === 'SEM TSI') continue
    const l = linhaDe(b)
    l.estoque = arred2(l.estoque + (b.estoque_pa || 0))
    // com a lista de ordens o planejado sai dela (por status); sem, da view
    if (!opcoes.ordens) l.planejado = arred2(l.planejado + (b.planejado_confirmado ?? 0))
  }

  const resumo: ResumoEstoqueFuturo = {
    considerados: { itens: 0, bags: 0 },
    semData: { itens: 0, bags: 0 },
    depois: { itens: 0, bags: 0 },
    semTsi: { itens: 0, bags: 0 },
    embalagemDesconhecida: { itens: 0, bags: 0, codigos: [] },
    planejadoPorStatus: {},
  }

  // mesmo recorte do balanço: sem SEM TSI e só embalagem com de-para (SC10/SC20
  // vivem fora dos ERPs e não têm saldo no SAP pra esperar)
  const marcados = opcoes.statusPlanejado ?? new Set(STATUS_PLANEJADO_PADRAO)
  for (const o of opcoes.ordens ?? []) {
    const bags = Number(o.bags) || 0
    if (bags <= 0) continue
    if (normalizaTratamento(o.tratamento) === 'SEM TSI') continue
    if (!opcoes.embalagensConhecidas.has(o.embalagem)) continue
    const porStatus = resumo.planejadoPorStatus[o.status] ?? { itens: 0, bags: 0 }
    soma(porStatus, bags)
    resumo.planejadoPorStatus[o.status] = porStatus
    if (!marcados.has(o.status)) continue
    const l = linhaDe(o)
    l.planejado = arred2(l.planejado + bags)
    if (o.status === STATUS_APONTADA_APOS_SALDO) l.apontadoPosSaldo = arred2(l.apontadoPosSaldo + bags)
    l.ordensPlanejadas.push({ numero: o.numero, status: o.status, bags })
  }

  const cargasPorLinha = new Map<string, Map<string, CargaDoProduto>>()

  for (const it of itens) {
    const bags = Number(it.bags) || 0
    if (bags <= 0) continue
    // o que fica fora por natureza (branca, sem de-para) não entra no "depois":
    // o resumo conta cada bag num balde só, e só dentro do período escolhido
    const noPeriodo = !ate || !it.data_carga || it.data_carga <= ate
    if (normalizaTratamento(it.tratamento) === 'SEM TSI') {
      if (noPeriodo) soma(resumo.semTsi, bags)
      continue
    }
    if (!opcoes.embalagensConhecidas.has(it.embalagem)) {
      if (noPeriodo) {
        soma(resumo.embalagemDesconhecida, bags)
        if (!resumo.embalagemDesconhecida.codigos.includes(it.embalagem)) {
          resumo.embalagemDesconhecida.codigos.push(it.embalagem)
        }
      }
      continue
    }
    if (!noPeriodo) {
      soma(resumo.depois, bags)
      continue
    }
    soma(resumo.considerados, bags)
    if (!it.data_carga) soma(resumo.semData, bags)
    const l = linhaDe(it)
    l.aCarregar = arred2(l.aCarregar + bags)
    const porCarga = cargasPorLinha.get(l.chave) ?? new Map<string, CargaDoProduto>()
    cargasPorLinha.set(l.chave, porCarga)
    const c = porCarga.get(it.numero_carga)
    if (c) {
      c.bags = arred2(c.bags + bags)
      if (it.data_carga && (!c.data || it.data_carga < c.data)) c.data = it.data_carga
    } else {
      porCarga.set(it.numero_carga, {
        carga: it.numero_carga, data: it.data_carga, status: it.status_carga, bags,
      })
    }
  }

  const linhas: LinhaEstoqueFuturo[] = []
  for (const l of mapa.values()) {
    if (l.estoque <= 0 && l.planejado <= 0 && l.aCarregar <= 0) continue
    l.futuro = arred2(l.estoque + l.planejado - l.aCarregar)
    l.cargas = [...(cargasPorLinha.get(l.chave)?.values() ?? [])].sort(
      (a, b) =>
        (a.data ?? '').localeCompare(b.data ?? '') ||
        a.carga.localeCompare(b.carga, 'pt-BR', { numeric: true }),
    )
    linhas.push(l)
  }
  // padrão: quem vai faltar primeiro (futuro menor), depois cultivar/tratamento
  linhas.sort(
    (a, b) =>
      a.futuro - b.futuro ||
      a.cultivar.localeCompare(b.cultivar, 'pt-BR') ||
      a.tratamento.localeCompare(b.tratamento, 'pt-BR') ||
      a.embalagem.localeCompare(b.embalagem, 'pt-BR'),
  )
  return { linhas, resumo }
}
