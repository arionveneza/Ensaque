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
  planejado: number
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
        estoque: 0, planejado: 0, aCarregar: 0, futuro: 0, cargas: [],
      }
      mapa.set(chave, l)
    }
    return l
  }

  for (const b of balanco) {
    if (normalizaTratamento(b.tratamento) === 'SEM TSI') continue
    const l = linhaDe(b)
    l.estoque = arred2(l.estoque + (b.estoque_pa || 0))
    l.planejado = arred2(l.planejado + (b.planejado_confirmado ?? 0))
  }

  const resumo: ResumoEstoqueFuturo = {
    considerados: { itens: 0, bags: 0 },
    semData: { itens: 0, bags: 0 },
    depois: { itens: 0, bags: 0 },
    semTsi: { itens: 0, bags: 0 },
    embalagemDesconhecida: { itens: 0, bags: 0, codigos: [] },
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
