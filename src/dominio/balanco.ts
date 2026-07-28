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
