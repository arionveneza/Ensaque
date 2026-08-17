/**
 * Balanço de demanda, por cultivar + tratamento + embalagem.
 *
 *   saldo = pedidos_APROVADOS − estoque_PA − ordens_abertas
 *
 * Ordem "aberta" é qualquer uma com status diferente de 'Apontada': ao ser
 * lançada no AGROTIS ela sai do balanço e reaparece no estoque do próximo
 * upload. Os avisos são fortes, mas NUNCA bloqueiam — a decisão é do PCP.
 */

import type { LinhaDemanda, PedidoVenda } from './tipos'

export interface Balanco {
  pedidoAprovado: number
  /** Integrado mas aguardando aprovação financeira: visível, fora do cálculo. */
  pedidoPendente: number
  estoquePa: number
  ordensAbertas: number
  saldo: number
}

export interface ChaveDemanda {
  cultivar: string
  tratamento: string
  embalagem: string
}

const mesmaChave = (a: ChaveDemanda, b: ChaveDemanda) =>
  a.cultivar === b.cultivar &&
  a.tratamento === b.tratamento &&
  a.embalagem === b.embalagem

const soma = (linhas: { bags: number }[]) =>
  linhas.reduce((total, l) => total + l.bags, 0)

export function balanco(
  chave: ChaveDemanda,
  pedidos: PedidoVenda[],
  estoquePa: LinhaDemanda[],
  ordensAbertas: LinhaDemanda[],
): Balanco {
  const doGrupo = pedidos.filter((p) => mesmaChave(p, chave))
  const pedidoAprovado = soma(doGrupo.filter((p) => p.aprovado))
  const pedidoPendente = soma(doGrupo.filter((p) => !p.aprovado))
  const estoque = soma(estoquePa.filter((e) => mesmaChave(e, chave)))
  const abertas = soma(ordensAbertas.filter((o) => mesmaChave(o, chave)))
  return {
    pedidoAprovado,
    pedidoPendente,
    estoquePa: estoque,
    ordensAbertas: abertas,
    saldo: pedidoAprovado - estoque - abertas,
  }
}

export type TipoAviso =
  | 'sem-pedido'
  | 'estoque-cobre'
  | 'ja-planejado'
  | 'excede-saldo'
  | 'estoque-parado'
  | 'receita-nao-cadastrada'

export interface Aviso {
  tipo: TipoAviso
  mensagem: string
  /** Nenhum aviso bloqueia a criação da ordem, exceto receita não cadastrada. */
  bloqueia: boolean
}

export interface AnaliseDemanda {
  balanco: Balanco
  avisos: Aviso[]
}

/**
 * Avisos ao criar/editar uma ordem.
 *
 * Único caso bloqueante: código de tratamento sem receita cadastrada. A demanda
 * existe e entra no balanço, mas sem receita não há como produzir.
 */
/** Mesma normalização usada na importação (simpleagro.ts) — tolera acento/caixa/espaço. */
export const ehSemTsi = (tratamento: string) =>
  tratamento
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toUpperCase() === 'SEM TSI'

export function analisaDemanda(
  chave: ChaveDemanda,
  bagsNovos: number,
  pedidos: PedidoVenda[],
  estoquePa: LinhaDemanda[],
  ordensAbertas: LinhaDemanda[],
  receitaCadastrada: boolean,
): AnaliseDemanda {
  const b = balanco(chave, pedidos, estoquePa, ordensAbertas)
  const avisos: Aviso[] = []

  if (!receitaCadastrada) {
    avisos.push({
      tipo: 'receita-nao-cadastrada',
      mensagem: `Tratamento ${chave.tratamento} não tem receita cadastrada — a demanda entra no balanço, mas a ordem não pode ser criada.`,
      bloqueia: true,
    })
  }

  // SEM TSI é semente branca (ensaque sem tratamento): a importação da
  // SimpleAgro descarta esses pedidos de propósito ("SEM TSI → excluir, não
  // gera trabalho de TSI") e o estoque correspondente vira lotes_semente,
  // nunca estoque_pa. `pedidos`/`estoquePa` NUNCA vão ter linha pra essa
  // combinação — os avisos abaixo dariam "sem pedido" toda vez, pra toda
  // ordem SEM TSI, sem sinal real nenhum por trás.
  if (!ehSemTsi(chave.tratamento)) {
    if (b.pedidoAprovado === 0) {
      avisos.push({
        tipo: 'sem-pedido',
        mensagem: `Sem pedido de venda aprovado para ${chave.cultivar} + ${chave.tratamento} + ${chave.embalagem}.`,
        bloqueia: false,
      })
    } else if (b.estoquePa >= b.pedidoAprovado) {
      avisos.push({
        tipo: 'estoque-cobre',
        mensagem: `Estoque já cobre o pedido: ${b.estoquePa} bg em estoque para ${b.pedidoAprovado} bg pedidos.`,
        bloqueia: false,
      })
    } else if (b.saldo <= 0 && b.ordensAbertas > 0) {
      avisos.push({
        tipo: 'ja-planejado',
        mensagem: `Já planejado: ${b.ordensAbertas} bg em ordens abertas atendem o pedido de ${b.pedidoAprovado} bg (estoque ${b.estoquePa} bg).`,
        bloqueia: false,
      })
    } else if (bagsNovos > b.saldo) {
      avisos.push({
        tipo: 'excede-saldo',
        mensagem: `Excede a necessidade: saldo descoberto é ${Math.max(0, b.saldo)} bg e a ordem tem ${bagsNovos} bg.`,
        bloqueia: false,
      })
    }
  }

  // Estoque parado: mesmo cultivar + tratamento, em embalagem sem pedido de venda.
  const parado = estoquePa.filter(
    (e) =>
      e.cultivar === chave.cultivar &&
      e.tratamento === chave.tratamento &&
      e.bags > 0 &&
      !pedidos.some(
        (p) =>
          p.cultivar === e.cultivar &&
          p.tratamento === e.tratamento &&
          p.embalagem === e.embalagem,
      ),
  )
  for (const e of parado) {
    avisos.push({
      tipo: 'estoque-parado',
      mensagem: `Estoque parado: ${e.bags} bg de ${e.cultivar} + ${e.tratamento} em ${e.embalagem}, sem nenhum pedido nessa embalagem.`,
      bloqueia: false,
    })
  }

  return { balanco: b, avisos }
}

/** Uma ordem só pode ser criada se nenhum aviso for bloqueante. */
export function podeCriarOrdem(analise: AnaliseDemanda): boolean {
  return !analise.avisos.some((a) => a.bloqueia)
}

// ================================================================
// Leitura do balanço: o que falta produzir e o que vai sobrar
// ================================================================

/**
 * O `saldo` do balanço é ambíguo para quem olha a tabela: positivo é demanda
 * ainda descoberta (trabalho a fazer), negativo é bag que vai sobrar no
 * estoque sem comprador. São situações opostas e a segunda é a que ninguém
 * quer descobrir depois de tratar.
 */
export type SituacaoDemanda = 'descoberto' | 'coberto' | 'sobra' | 'sem-pedido'

/**
 * O recorte do balanço que classifica a situação — vem da v_balanco_demanda.
 *
 * NÃO sabe o tratamento da linha, então não sabe filtrar SEM TSI sozinha:
 * quem chama com uma lista de `v_balanco_demanda` (que tem `tratamento`)
 * precisa excluir as linhas `ehSemTsi(tratamento)` ANTES de passar aqui —
 * senão toda ordem SEM TSI programada aparece como `sem-pedido`, alarme
 * falso (essa demanda é rastreada por `lotes_semente`, nunca por
 * `pedidos_venda`/`estoque_pa`). Ver `PainelDemanda` em `Ordens.tsx`.
 */
export interface LinhaBalanco {
  pedido_aprovado: number
  estoque_pa: number
  ordens_abertas: number
  saldo: number
}

/**
 * `sem-pedido` é separado de `sobra` de propósito: sobra é excesso sobre um
 * pedido que existe, enquanto sem-pedido é produzir ou estocar algo que
 * ninguém comprou — 100% de excesso, e o caso mais grave.
 */
export function situacaoDemanda(l: LinhaBalanco): SituacaoDemanda {
  if (l.pedido_aprovado <= 0)
    return l.estoque_pa + l.ordens_abertas > 0 ? 'sem-pedido' : 'coberto'
  if (l.saldo > 0) return 'descoberto'
  if (l.saldo < 0) return 'sobra'
  return 'coberto'
}

/** Bags que faltam produzir para cobrir o pedido aprovado. */
export const bagsFaltando = (l: LinhaBalanco): number => Math.max(0, l.saldo)

/** Bags que passam do pedido aprovado: estoque + programado que vai sobrar. */
export const bagsSobrando = (l: LinhaBalanco): number => Math.max(0, -l.saldo)

export interface ResumoBalanco {
  /** Combinações e bags que faltam produzir. */
  faltando: number
  combosFaltando: number
  /** Combinações e bags que vão sobrar, incluindo as sem pedido nenhum. */
  sobrando: number
  combosSobrando: number
  /** Subconjunto do que sobra: sem nenhum pedido aprovado. */
  semPedido: number
  combosSemPedido: number
}

/**
 * Totais do painel. O que sobra soma tudo que passa do pedido, e as linhas sem
 * pedido nenhum aparecem também no próprio contador — é o mesmo bag contado nos
 * dois lugares, de propósito, porque um é o total e o outro é o alerta.
 */
export function resumoBalanco(linhas: LinhaBalanco[]): ResumoBalanco {
  const r: ResumoBalanco = {
    faltando: 0, combosFaltando: 0,
    sobrando: 0, combosSobrando: 0,
    semPedido: 0, combosSemPedido: 0,
  }
  for (const l of linhas) {
    const falta = bagsFaltando(l)
    const sobra = bagsSobrando(l)
    if (falta > 0) { r.faltando += falta; r.combosFaltando++ }
    if (sobra > 0) { r.sobrando += sobra; r.combosSobrando++ }
    if (situacaoDemanda(l) === 'sem-pedido') {
      r.semPedido += l.estoque_pa + l.ordens_abertas
      r.combosSemPedido++
    }
  }
  return r
}
