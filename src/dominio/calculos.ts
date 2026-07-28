/**
 * Cálculos do domínio TSI.
 *
 * Regra central: a receita é definida por DOSE; a balança confere por PESO.
 * A densidade é o que converte uma da outra — densidade errada desloca todo o
 * planejado de balança, então ela é obrigatória para produtos em ml/kg.
 */

import type {
  Embalagem,
  ItemReceita,
  MotivoParada,
  Ordem,
  ProdutoQuimico,
  Receita,
  TanqueOrdem,
} from './tipos'

/** Peso de um bag: PMS × fator da embalagem. Ex.: PMS 171 em BB5M → 855 kg. */
export function pesoBagKg(pms: number, embalagem: Embalagem): number {
  return pms * embalagem.fatorPeso
}

/** Peso total de semente da ordem, em kg. */
export function pesoOrdemKg(bags: number, pesoBagKg: number): number {
  return bags * pesoBagKg
}

export function pesoOrdemT(bags: number, pesoBagKg: number): number {
  return pesoOrdemKg(bags, pesoBagKg) / 1000
}

/**
 * Peso de balança planejado de um item da receita, em kg.
 *
 *   ml/kg → dose × peso_semente_kg × densidade / 1000
 *   g/kg  → dose × peso_semente_kg / 1000
 */
export function pesoItemKg(
  item: ItemReceita,
  produto: ProdutoQuimico,
  pesoSementeKg: number,
): number {
  if (produto.unidade === 'ml/kg') {
    if (produto.densidade == null) {
      throw new Error(
        `Produto ${produto.codigo} está em ml/kg sem densidade: o peso de balança seria incorreto.`,
      )
    }
    return (item.dose * pesoSementeKg * produto.densidade) / 1000
  }
  return (item.dose * pesoSementeKg) / 1000
}

/** Volume planejado em litros. Só faz sentido para produtos dosados em ml/kg. */
export function volumeItemL(
  item: ItemReceita,
  produto: ProdutoQuimico,
  pesoSementeKg: number,
): number | null {
  if (produto.unidade !== 'ml/kg') return null
  return (item.dose * pesoSementeKg) / 1000
}

/** Peso total de químico da ordem, em kg. */
export function pesoQuimicoTotalKg(
  receita: Receita,
  produtos: Map<string, ProdutoQuimico>,
  pesoSementeKg: number,
): number {
  return receita.itens.reduce((total, item) => {
    const produto = produtos.get(item.produtoId)
    if (!produto) throw new Error(`Produto ${item.produtoId} não cadastrado.`)
    return total + pesoItemKg(item, produto, pesoSementeKg)
  }, 0)
}

/**
 * Peso de ensaque por bag:
 *   peso_do_bag_do_lote + (peso_químico_total_da_ordem ÷ bags_da_ordem)
 */
export function ensaquePorBagKg(
  pesoBagLoteKg: number,
  pesoQuimicoTotalKg: number,
  bags: number,
): number {
  if (bags <= 0) throw new Error('Ordem sem bags: ensaque indefinido.')
  return pesoBagLoteKg + pesoQuimicoTotalKg / bags
}

/**
 * Monta os tanques da ordem agrupando os itens da receita por tanque.
 * Só existem 5 tanques: receita com mais produtos agrupa produtos no mesmo
 * tanque, e o planejado do tanque passa a ser a SOMA dos produtos dele.
 */
export function montaTanques(receita: Receita): TanqueOrdem[] {
  const porTanque = new Map<number, ItemReceita[]>()
  for (const item of receita.itens) {
    const atual = porTanque.get(item.tanque)
    if (atual) atual.push(item)
    else porTanque.set(item.tanque, [item])
  }
  return [...porTanque.keys()]
    .sort((a, b) => a - b)
    .map((tanque) => ({
      tanque,
      itens: porTanque.get(tanque)!,
      lotesQuimico: [],
      pesoInicial: null,
      pesoFinal: null,
    }))
}

export interface ConsumoTanque {
  tanque: number
  /** Soma dos pesos de balança dos produtos do tanque (mistura inclusa). */
  planejadoKg: number
  volumeL: number
  /** peso inicial − peso final; null enquanto a pesagem não fechou. */
  realKg: number | null
  desvioPct: number | null
}

/** Real vs Planejado por tanque. Mistura compara contra a soma do tanque. */
export function consumoPorTanque(
  tanques: TanqueOrdem[],
  produtos: Map<string, ProdutoQuimico>,
  pesoSementeKg: number,
): ConsumoTanque[] {
  return tanques.map((t) => {
    let planejadoKg = 0
    let volumeL = 0
    for (const item of t.itens) {
      const produto = produtos.get(item.produtoId)
      if (!produto) throw new Error(`Produto ${item.produtoId} não cadastrado.`)
      planejadoKg += pesoItemKg(item, produto, pesoSementeKg)
      volumeL += volumeItemL(item, produto, pesoSementeKg) ?? 0
    }
    const realKg =
      t.pesoInicial != null && t.pesoFinal != null
        ? Math.max(0, t.pesoInicial - t.pesoFinal)
        : null
    const desvioPct =
      realKg == null || planejadoKg === 0
        ? null
        : ((realKg - planejadoKg) / planejadoKg) * 100
    return { tanque: t.tanque, planejadoKg, volumeL, realKg, desvioPct }
  })
}

// ----------------------------------------------------------------
// Tempos
// ----------------------------------------------------------------

export interface TemposOrdem {
  /** fim − início, em segundos. */
  brutoS: number
  paradasS: number
  paradasPlanejadasS: number
  paradasNaoPlanejadasS: number
  /** bruto − todas as paradas. */
  liquidoS: number
  /** líquido ÷ bruto — toda parada é perda. */
  dispBruta: number | null
  /** líquido ÷ (bruto − paradas planejadas) — só perda real. */
  dispOperacional: number | null
}

/**
 * Tempos de uma ordem. `agora` permite calcular ordens em andamento sem
 * depender do relógio, o que mantém os testes determinísticos.
 */
export function temposOrdem(
  ordem: Ordem,
  motivos: Map<string, MotivoParada>,
  agora: number,
): TemposOrdem | null {
  const inicio = ordem.eventos.find((e) => e.tipo === 'inicio')
  if (!inicio) return null
  const fim = ordem.eventos.find((e) => e.tipo === 'fim')
  const brutoS = ((fim ? fim.ts : agora) - inicio.ts) / 1000

  let planejadasS = 0
  let naoPlanejadasS = 0
  for (const parada of ordem.paradas) {
    const duracao = ((parada.fim ?? agora) - parada.inicio) / 1000
    const motivo = motivos.get(parada.motivoId)
    if (!motivo) throw new Error(`Motivo de parada ${parada.motivoId} não cadastrado.`)
    if (motivo.tipo === 'Planejada') planejadasS += duracao
    else naoPlanejadasS += duracao
  }

  const paradasS = planejadasS + naoPlanejadasS
  const liquidoS = Math.max(0, brutoS - paradasS)
  const baseOperacional = brutoS - planejadasS

  return {
    brutoS,
    paradasS,
    paradasPlanejadasS: planejadasS,
    paradasNaoPlanejadasS: naoPlanejadasS,
    liquidoS,
    dispBruta: brutoS > 0 ? liquidoS / brutoS : null,
    dispOperacional: baseOperacional > 0 ? liquidoS / baseOperacional : null,
  }
}

/** Tempo planejado da ordem em segundos: peso_t ÷ capacidade_th × 3600. */
export function tempoPlanejadoS(pesoT: number, capacidadeTh: number): number {
  if (capacidadeTh <= 0) throw new Error('Capacidade da máquina deve ser positiva.')
  return (pesoT / capacidadeTh) * 3600
}

/** Rendimento em toneladas por hora sobre o tempo líquido. */
export function rendimentoTh(pesoT: number, liquidoS: number): number | null {
  if (liquidoS <= 0) return null
  return pesoT / (liquidoS / 3600)
}

export function formataHms(segundos: number): string {
  const s = Math.max(0, Math.floor(segundos))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const g = s % 60
  return [h, m, g].map((v) => String(v).padStart(2, '0')).join(':')
}

// ----------------------------------------------------------------
// Turno e dia de produção
// ----------------------------------------------------------------

const T1_INICIO_MIN = 7 * 60 + 30 // 07:30
const T1_FIM_MIN = 17 * 60 + 30 // 17:30

/**
 * O turno NÃO é programado: é derivado do horário real do apontamento de
 * início. Início até 17:30 → Turno 1; depois → Turno 2.
 */
export function turnoDoInicio(inicio: Date): 1 | 2 {
  const minutos = inicio.getHours() * 60 + inicio.getMinutes()
  return minutos >= T1_INICIO_MIN && minutos <= T1_FIM_MIN ? 1 : 2
}

/**
 * Dia de produção: das 07:30 às 03:00 do dia seguinte. O turno 2 cruza a
 * meia-noite e pertence ao dia que começou.
 */
export function diaDeProducao(momento: Date): string {
  const minutos = momento.getHours() * 60 + momento.getMinutes()
  const d = new Date(momento)
  if (minutos < T1_INICIO_MIN) d.setDate(d.getDate() - 1)
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-')
}

// ----------------------------------------------------------------
// Ocupação
// ----------------------------------------------------------------

/** Capacidade do dia por máquina: capacidade_th × horas dos dois turnos. */
export function capacidadeDiaT(capacidadeTh: number, horasTurnos: number[]): number {
  return capacidadeTh * horasTurnos.reduce((a, h) => a + h, 0)
}

export interface Ocupacao {
  programadoT: number
  capacidadeT: number
  pct: number
  alerta: 'ok' | 'ambar' | 'vermelho'
}

/** Ocupação de uma máquina num dia. Alerta acima de 85% e acima de 100%. */
export function ocupacao(programadoT: number, capacidadeT: number): Ocupacao {
  const pct = capacidadeT > 0 ? (programadoT / capacidadeT) * 100 : 0
  const alerta = pct > 100 ? 'vermelho' : pct > 85 ? 'ambar' : 'ok'
  return { programadoT, capacidadeT, pct, alerta }
}
