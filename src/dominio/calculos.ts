/**
 * Cálculos do domínio TSI.
 *
 * Regra central: a receita é definida por DOSE; a balança confere por PESO.
 * A densidade é o que converte uma da outra — densidade errada desloca todo o
 * planejado de balança, então ela é obrigatória para produtos em ml/kg.
 */

import type {
  AlocacaoProduto,
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

/** O recorte da embalagem da ordem que decide o peso do bag. */
export interface EmbalagemPeso {
  fator_peso: number | null
  /** Embalagem por peso (saco de 10/20 kg): vence o PMS × fator (24/08/2026). */
  peso_fixo_kg: number | null
}

/**
 * Peso do bag DA ORDEM, na precedência (idêntica à v_ordens no banco):
 *
 *   peso_fixo_kg (>0)  →  PMS × fator_peso (ambos >0)  →  peso_bag_kg do lote
 *
 * Embalagem de peso fixo (saco de 10/20 kg, 24/08/2026) pesa o mesmo em
 * qualquer lote — o PMS só muda quantas sementes cabem no saco. As por
 * sementes (BG5M/MEIOBAG) seguem `PMS × fator da embalagem escolhida NA
 * ORDEM` — não o peso_bag_kg herdado do lote, congelado com o fator da
 * embalagem ORIGINAL dele na importação: ordem MEIOBAG de lote big bag saía
 * com o dobro de peso em tudo (13/08/2026). Fallback final: sem PMS no
 * cadastro do lote (coluna nullable) não há como recalcular — vale o peso
 * do lote, o comportamento antigo.
 */
export function pesoBagDaOrdemKg(
  pms: number | null,
  embalagem: EmbalagemPeso | null | undefined,
  pesoBagLoteKg: number,
): number {
  if (embalagem?.peso_fixo_kg != null && embalagem.peso_fixo_kg > 0) return embalagem.peso_fixo_kg
  return pms != null && pms > 0 && embalagem?.fator_peso != null && embalagem.fator_peso > 0
    ? pms * embalagem.fator_peso
    : pesoBagLoteKg
}

/** Peso total de semente da ordem, em kg. */
export function pesoOrdemKg(bags: number, pesoBagKg: number): number {
  return bags * pesoBagKg
}

export function pesoOrdemT(bags: number, pesoBagKg: number): number {
  return pesoOrdemKg(bags, pesoBagKg) / 1000
}

/** Dose em volume (exige densidade) ou já em peso? */
export const doseEmMl = (unidade: ProdutoQuimico['unidade']): boolean =>
  unidade.startsWith('ml')

/** Quantos kg de semente a dose referencia: 1 (por kg) ou 100 (por 100 kg). */
export const baseDoseKg = (unidade: ProdutoQuimico['unidade']): number =>
  unidade.endsWith('/100kg') ? 100 : 1

/**
 * Peso de balança planejado de um item da receita, em kg.
 *
 *   ml → dose × peso_semente_kg × densidade / 1000 ÷ base
 *   g  → dose × peso_semente_kg / 1000 ÷ base
 *
 * `base` = 1 (dose por kg) ou 100 (dose por 100 kg, o padrão das bulas).
 */
export function pesoItemKg(
  item: ItemReceita,
  produto: ProdutoQuimico,
  pesoSementeKg: number,
): number {
  const base = baseDoseKg(produto.unidade)
  if (doseEmMl(produto.unidade)) {
    if (produto.densidade == null) {
      throw new Error(
        `Produto ${produto.codigo} está em ${produto.unidade} sem densidade: o peso de balança seria incorreto.`,
      )
    }
    return (item.dose * pesoSementeKg * produto.densidade) / 1000 / base
  }
  return (item.dose * pesoSementeKg) / 1000 / base
}

/** Volume planejado em litros. Só faz sentido para produtos dosados em ml. */
export function volumeItemL(
  item: ItemReceita,
  produto: ProdutoQuimico,
  pesoSementeKg: number,
): number | null {
  if (!doseEmMl(produto.unidade)) return null
  return (item.dose * pesoSementeKg) / 1000 / baseDoseKg(produto.unidade)
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
 * Margem do ensaque sobre o peso do bag (decisão de 05/08/2026):
 * cada bag leva +0,5% do peso do bag além da parcela de químico.
 */
export const MARGEM_ENSAQUE = 0.005

/**
 * Peso de ensaque por bag:
 *   peso_do_bag_DA_ORDEM × (1 + margem) + (peso_químico_total_da_ordem ÷ bags_da_ordem)
 *
 * O peso é o da embalagem DA ORDEM (CLAUDE.md §1) — o parâmetro se chamava
 * `pesoBagLoteKg` por herança de antes da correção de 13/08/2026, mas os
 * chamadores sempre passam `pesoBagOrdemKg(ordem)`.
 */
export function ensaquePorBagKg(
  pesoBagOrdemKg: number,
  pesoQuimicoTotalKg: number,
  bags: number,
): number {
  if (bags <= 0) throw new Error('Ordem sem bags: ensaque indefinido.')
  return pesoBagOrdemKg * (1 + MARGEM_ENSAQUE) + pesoQuimicoTotalKg / bags
}

/**
 * Monta os tanques da ordem agrupando os itens da receita pelo destino que
 * o OPERADOR escolheu. Produto sem destino ainda não entra em tanque nenhum.
 *
 * Só existem 5 tanques: mais de um produto no mesmo destino é mistura, e o
 * planejado do tanque passa a ser a SOMA dos produtos dele. O destino 0 é o
 * transferidor (pó secante) — aparece primeiro e pesa como os tanques.
 */
export function montaTanques(
  receita: Receita,
  alocacao: AlocacaoProduto[],
): TanqueOrdem[] {
  const destino = new Map(alocacao.map((a) => [a.produtoId, a.tanque]))
  const porTanque = new Map<number, ItemReceita[]>()
  for (const item of receita.itens) {
    const tanque = destino.get(item.produtoId)
    if (tanque == null) continue
    const atual = porTanque.get(tanque)
    if (atual) atual.push(item)
    else porTanque.set(tanque, [item])
  }
  return [...porTanque.keys()]
    .sort((a, b) => a - b)
    .map((tanque) => ({
      tanque,
      itens: porTanque.get(tanque)!,
      pesoInicial: null,
      pesoFinal: null,
      abastecidoKg: 0,
    }))
}

/** Produtos da receita que o operador ainda não destinou a nenhum tanque. */
export function produtosSemDestino(
  receita: Receita,
  alocacao: AlocacaoProduto[],
): string[] {
  const destinados = new Set(alocacao.map((a) => a.produtoId))
  return receita.itens
    .filter((i) => !destinados.has(i.produtoId))
    .map((i) => i.produtoId)
}

export interface ConsumoTanque {
  tanque: number
  /** Soma dos pesos de balança dos produtos do tanque (mistura inclusa). */
  planejadoKg: number
  volumeL: number
  /** inicial + abastecido − final; null enquanto a pesagem não fechou. */
  realKg: number | null
  /** O que foi acrescentado depois do peso inicial (0 quando não houve). */
  abastecidoKg: number
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
    /**
     * O produto pode acabar no meio da ordem e ser completado: 100 kg no
     * início, mais 100 durante, 50 sobrando no fim = 150 consumidos. Só
     * `inicial − final` daria 50 e a ordem apareceria como economia recorde.
     */
    const abastecidoKg = t.abastecidoKg ?? 0
    const realKg =
      t.pesoInicial != null && t.pesoFinal != null
        ? Math.max(0, t.pesoInicial + abastecidoKg - t.pesoFinal)
        : null
    const desvioPct =
      realKg == null || planejadoKg === 0
        ? null
        : ((realKg - planejadoKg) / planejadoKg) * 100
    return { tanque: t.tanque, planejadoKg, volumeL, realKg, abastecidoKg, desvioPct }
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
    // nunca negativa: relógios diferentes (cliente x servidor) já geraram
    // parada com fim ANTES do início, e o líquido saía maior que o bruto
    const duracao = Math.max(0, ((parada.fim ?? agora) - parada.inicio) / 1000)
    // motivo desconhecido (ex.: desativado no cadastro, mas ainda referenciado)
    // conta como NÃO planejada — o conservador. NUNCA lançar: isto roda no
    // render da Execução e do Painel TV, e um throw viraria tela branca.
    const motivo = motivos.get(parada.motivoId)
    if (motivo?.tipo === 'Planejada') planejadasS += duracao
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

// ----------------------------------------------------------------
// OEE (Overall Equipment Effectiveness) = Disponibilidade × Performance × Qualidade
// ----------------------------------------------------------------

/**
 * Nota mínima de "qualidade geral do tratamento" (recobrimento, 1–5) para o
 * checklist final contar como aprovado no OEE. O checklist NUNCA bloqueia a
 * ordem — este limite existe só para transformar a inspeção informativa num
 * número de qualidade. Ajustar aqui se a operação definir outro corte.
 */
export const RECOBRIMENTO_MINIMO_OEE = 3

/** Um checklist final "passa" com umidade e pó OK e recobrimento no mínimo. */
export function checkFinalAprovado(c: {
  recobrimento: number
  umidade_ok: boolean
  po_ok: boolean
}): boolean {
  return c.umidade_ok && c.po_ok && c.recobrimento >= RECOBRIMENTO_MINIMO_OEE
}

export interface Oee {
  /** Fração 0–1. Líquido ÷ (bruto − paradas planejadas); null se a base é 0. */
  disponibilidade: number | null
  /** Fração 0–1. Tempo ideal ÷ tempo líquido, teto em 1 (ganho não vira >100%). */
  performance: number
  /** Fração 0–1. % de ordens com checklist final aprovado; null se nenhuma teve. */
  qualidade: number | null
  /** Produto dos três; null quando falta a qualidade para fechar a conta. */
  oee: number | null
}

/**
 * OEE a partir dos tempos agregados de um período/máquina.
 * - Disponibilidade = líquido ÷ (bruto − paradas planejadas). Segue o padrão
 *   da indústria (Nakajima): parada planejada — setup, limpeza, refeição — NÃO
 *   conta como indisponibilidade; só a parada não planejada penaliza. É a
 *   mesma "disponibilidade operacional" que o resto do app já usa.
 * - Performance     = min(1, planejado ÷ líquido)  (produzir mais rápido que a
 *   capacidade nominal não infla o número — o padrão trava em 100%)
 * - Qualidade vem de fora (fração de checklists finais aprovados), porque nada
 *   é refugado neste processo: o checklist é informativo, então a "qualidade"
 *   do OEE é a taxa de aprovação da inspeção final, não peça boa ÷ peça ruim.
 */
export function calculaOee(input: {
  brutoS: number
  liquidoS: number
  paradasPlanejadasS: number
  planejadoS: number
  qualidade: number | null
}): Oee | null {
  const { brutoS, liquidoS, paradasPlanejadasS, planejadoS, qualidade } = input
  if (brutoS <= 0) return null
  const base = brutoS - paradasPlanejadasS // tempo que a máquina deveria produzir
  const disponibilidade = base > 0 ? Math.min(1, Math.max(0, liquidoS / base)) : null
  const performance = liquidoS > 0 ? Math.min(1, planejadoS / liquidoS) : 0
  const q = qualidade == null ? null : Math.min(1, Math.max(0, qualidade))
  return {
    disponibilidade,
    performance,
    qualidade: q,
    oee: q == null || disponibilidade == null ? null : disponibilidade * performance * q,
  }
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
