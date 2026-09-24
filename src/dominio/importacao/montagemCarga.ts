/**
 * "Relatório montagem carga vs lotes" da SimpleAgro → o que está em ordem de
 * carregamento e AINDA NÃO FOI FATURADO (o "A carregar" do Estoque futuro).
 * Pedido do Arion, 24/09/2026.
 *
 * O relatório tem uma linha POR LOTE de cada item de agendamento, e repete a
 * `Qtd Agendada` do item em todas elas: um item de 35 bags separado em 3
 * lotes (21 + 10 + 4) vem em 3 linhas com 35 cada — somar a coluna dá 105.
 * Somar a `Quantidade Lote` também erra: com o loteamento pela metade (35
 * agendados, só 5 loteados) daria 5. **O que vale é a Qtd Agendada, uma vez
 * por item** — tenha lote, lote parcial ou nenhum lote.
 *
 * O difícil é saber onde um item termina: a MESMA carga + pedido + produto
 * pode ter VÁRIOS itens (achado nas 41 exportações no formato atual, set/2026:
 * carga 910, O790 IPRO, itens de 2, 10 e 23 bags; carga 877, dois itens de 1
 * bag cada). Não existe coluna de "item" no relatório, então o item sai da
 * ESTRUTURA da planilha. As linhas de um mesmo item costumam vir coladas, mas
 * NÃO sempre — a SimpleAgro não agrupa as linhas por carga, e em 4 das 42
 * exportações uma carga aparece em blocos separados (01/09: a carga 755 tem
 * os lotes nas linhas 18, 22 e 23, com a carga 753 no meio — a revisão
 * adversarial pegou isso; a 1ª versão, que só continuava o item na linha
 * seguinte, contava a Qtd Agendada duas vezes). Por isso as linhas são
 * AGRUPADAS pela chave completa (carga, pedido, produto, categoria,
 * tratamento, embalagem, Qtd Agendada) no arquivo inteiro, na ordem da
 * primeira aparição, e só então cada grupo é partido em itens: linha sem lote
 * é um item próprio; linhas com lote se somam ao item enquanto Σ Quantidade
 * Lote não passa da Qtd Agendada (os lotes de um item nunca passam dela
 * quando são dois ou mais — 0 casos nas 42 exportações), e a que passaria
 * abre item novo. Conferido contra as 42 exportações: em todos os 147 grupos
 * com 2+ lotes que também aparecem sem lote noutra exportação (o gabarito),
 * a contagem bate.
 *
 * Colunas pelo NOME, nunca pela letra (a mesma lição dos outros importadores
 * da SimpleAgro: a posição muda entre exports; hoje são U = Qtd Agendada,
 * V = Lote, W = Quantidade Lote). Nome repetido no cabeçalho é recusado: uma
 * cópia editada à mão com dois pares Lote/Quantidade Lote pareava o 1º Lote
 * com a quantidade do 2º par.
 */

import { EMBALAGEM_DEPARA, normaliza, normalizaCultivar, num, txt, type Linha } from './simpleagro'

/** Dia da carga em ISO. O leitor de xlsx devolve Date em UTC — o dia sai dos componentes UTC. */
const dia = (v: unknown): string | null => {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10)
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    // serial do Excel (célula de data que chegou como número)
    return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000).toISOString().slice(0, 10)
  }
  const s = txt(v)
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s)
  if (m) return `${m[3]}-${m[2]}-${m[1]}`
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  return null
}

/**
 * Status em que a nota já saiu — o SAP já baixou o estoque, então contar de
 * novo aqui subtrairia duas vezes. Lista do Arion (24/09/2026). "Faturado
 * Qualidade" NÃO está aqui de propósito: nas exportações ele aparece ANTES do
 * Faturado Fiscal (carga 856: Faturado Qualidade → Em carga → Faturado
 * Fiscal), ou seja, o produto ainda está no saldo do SAP.
 */
export const STATUS_JA_FATURADO = ['FATURADO FISCAL', 'FATURADO TRANSPORTE', 'FINALIZADO']

export const statusJaFaturado = (status: string): boolean =>
  STATUS_JA_FATURADO.includes(normaliza(status).replace(/\s+/g, ' '))

const COLUNAS_OBRIGATORIAS = [
  'CARGA', 'STATUS CARGA', 'DATA CARGA', 'PRODUTO', 'TRATAMENTO', 'EMBALAGEM',
  'QTD AGENDADA', 'LOTE', 'QUANTIDADE LOTE',
]

const cabecalhoNormalizado = (rows: Linha[]): string[] =>
  (rows[0] ?? []).map((c) => normaliza(txt(c)).replace(/\s+/g, ' '))

/** Montagem de carga COM as colunas de lote (o "vs lotes"), no formato completo. */
export const ehRelatorioMontagemVsLotes = (rows: Linha[]): boolean => {
  const h = cabecalhoNormalizado(rows)
  return COLUNAS_OBRIGATORIAS.every((c) => h.includes(c))
}

/**
 * "Parece" o relatório (tem carga + lote + quantidade do lote), mesmo que
 * falte coluna — pra tela chamar o conversor e receber a mensagem "faltam as
 * colunas X" em vez de cair no erro genérico ou, pior, na prévia de planilha
 * de ordens (um export antigo, com EMB./QTD, passava no detector de ordens
 * com todas as linhas em erro).
 */
export const pareceMontagemVsLotes = (rows: Linha[]): boolean => {
  const h = cabecalhoNormalizado(rows)
  return ['CARGA', 'LOTE', 'QUANTIDADE LOTE'].every((c) => h.includes(c))
}

export interface ItemACarregar {
  /** Nº da carga como veio (texto — não se faz conta com ele). */
  carga: string
  status: string
  /** Dia da carga (ISO) ou null quando a coluna vem vazia. */
  dataCarga: string | null
  pedido: string
  cultivar: string
  categoria: string
  /** Tratamento como veio (caixa alta). `SEM TSI` = semente branca. */
  tratamento: string
  /** Código do app (BG5M/MEIOBAG) — ou o código cru, quando não há de-para. */
  embalagem: string
  embalagemConhecida: boolean
  /** Qtd Agendada do item — contada UMA vez. */
  bags: number
  /** Soma da Quantidade Lote das linhas do item (informativo). */
  bagsLoteados: number
  /** Quantas linhas de lote o item tinha. */
  lotes: number
}

export interface ResumoMontagem {
  totalLinhas: number
  /** Linhas em branco ou sem carga e sem produto (anotação à mão, lixo de export). */
  linhasIgnoradas: number
  /** Parte das ignoradas que tem lote/quantidade — alguém digitou fora da estrutura. */
  linhasOrfasComLote: number
  /** Linhas sem Qtd Agendada (cabeçalho de carga vazia, lixo de export). */
  semQuantidade: number
  /** Linhas que eram só mais um lote de um item já contado — não somam de novo. */
  linhasDeLoteRepetidas: number
  /** Itens (todos os status). */
  itens: number
  /** Itens que ficam (ainda não faturados) e a soma deles. */
  itensACarregar: number
  bagsACarregar: number
  /** Já faturados (fora da conta), por status. */
  jaFaturados: { itens: number; bags: number; porStatus: Record<string, { itens: number; bags: number }> }
  /** Ainda não faturados, por status. */
  porStatus: Record<string, { itens: number; bags: number }>
  semData: number
  /** Itens com lote mas loteamento pela metade (Σ lote < agendado) — contado o agendado. */
  loteParcial: number
  /** Itens com mais lote que agendado — contado o agendado. */
  sobreLoteado: number
  /** Itens a mais num grupo de chave igual (itens iguais na mesma carga). */
  itensRepetidos: number
  /** Embalagem sem de-para → bags (item entra com o código cru). */
  embalagemDesconhecida: Record<string, number>
  /** Itens de semente branca (SEM TSI) ainda a carregar — não entram no estoque de produto acabado. */
  semTsi: { itens: number; bags: number }
}

/** O que o conversor devolve — a prévia da tela de Ordens guarda isto. */
export interface ResultadoMontagem {
  itens: ItemACarregar[]
  resumo: ResumoMontagem
}

const EPS = 1e-9

interface LinhaDoGrupo {
  lote: string
  qtdLote: number
  item: Omit<ItemACarregar, 'bagsLoteados' | 'lotes'>
}

/**
 * Converte o relatório em itens de agendamento (um por item, com a Qtd
 * Agendada uma vez) e separa os já faturados. Função pura sobre as linhas.
 */
export function converterMontagemVsLotes(rows: Linha[]): ResultadoMontagem {
  const cab = cabecalhoNormalizado(rows)
  const faltando = COLUNAS_OBRIGATORIAS.filter((c) => !cab.includes(c))
  if (faltando.length > 0) {
    throw new Error(
      `A planilha não parece o "relatório montagem carga vs lotes" completo: faltam as colunas ${faltando.join(', ')}. ` +
        'Exporte de novo da SimpleAgro com todas as colunas.',
    )
  }
  const repetidas = COLUNAS_OBRIGATORIAS.filter((c) => cab.indexOf(c) !== cab.lastIndexOf(c))
  if (repetidas.length > 0) {
    throw new Error(
      `A planilha tem coluna repetida no cabeçalho (${repetidas.join(', ')}) — parece uma cópia editada à mão. ` +
        'Exporte de novo da SimpleAgro, sem editar.',
    )
  }
  const ix = (nome: string) => cab.indexOf(nome)
  const I = {
    carga: ix('CARGA'), status: ix('STATUS CARGA'), data: ix('DATA CARGA'), pedido: ix('PEDIDO'),
    produto: ix('PRODUTO'), categoria: ix('CATEGORIA'), trat: ix('TRATAMENTO'), emb: ix('EMBALAGEM'),
    qtd: ix('QTD AGENDADA'), lote: ix('LOTE'), qtdLote: ix('QUANTIDADE LOTE'),
  }

  const resumo: ResumoMontagem = {
    totalLinhas: Math.max(0, rows.length - 1),
    linhasIgnoradas: 0,
    linhasOrfasComLote: 0,
    semQuantidade: 0,
    linhasDeLoteRepetidas: 0,
    itens: 0,
    itensACarregar: 0,
    bagsACarregar: 0,
    jaFaturados: { itens: 0, bags: 0, porStatus: {} },
    porStatus: {},
    semData: 0,
    loteParcial: 0,
    sobreLoteado: 0,
    itensRepetidos: 0,
    embalagemDesconhecida: {},
    semTsi: { itens: 0, bags: 0 },
  }

  // 1. agrupa pela chave completa, na ordem da primeira aparição
  const grupos = new Map<string, LinhaDoGrupo[]>()
  for (const r of rows.slice(1)) {
    const carga = txt(r[I.carga])
    const produtoCru = txt(r[I.produto])
    if (!carga && !produtoCru) {
      resumo.linhasIgnoradas++
      if (txt(r[I.lote]) || num(r[I.qtdLote]) > 0) resumo.linhasOrfasComLote++
      continue
    }
    const qtd = num(r[I.qtd])
    if (qtd <= 0) {
      resumo.semQuantidade++
      continue
    }
    const pedido = I.pedido >= 0 ? txt(r[I.pedido]) : ''
    const categoria = I.categoria >= 0 ? txt(r[I.categoria]).toUpperCase() : ''
    const tratamento = txt(r[I.trat]).toUpperCase() || 'SEM TSI'
    const embCru = normaliza(txt(r[I.emb]))
    const lote = txt(r[I.lote])
    const qtdLote = lote ? num(r[I.qtdLote]) : 0
    const chave = [
      carga, pedido, normaliza(produtoCru), categoria, normaliza(tratamento).replace(/\s+/g, ' '), embCru, qtd,
    ].join('|')
    const de = EMBALAGEM_DEPARA[embCru]
    const linha: LinhaDoGrupo = {
      lote,
      qtdLote,
      item: {
        carga,
        status: txt(r[I.status]) || 'Sem status',
        dataCarga: dia(r[I.data]),
        pedido,
        cultivar: normalizaCultivar(produtoCru.split(' - ')[0]),
        categoria,
        tratamento,
        embalagem: de?.codigo ?? embCru,
        embalagemConhecida: !!de,
        bags: qtd,
      },
    }
    const g = grupos.get(chave)
    if (g) g.push(linha)
    else grupos.set(chave, [linha])
  }

  // 2. parte cada grupo em itens
  const todos: ItemACarregar[] = []
  for (const linhas of grupos.values()) {
    const antes = todos.length
    let atual: ItemACarregar | null = null
    for (const l of linhas) {
      const qtd = l.item.bags
      if (l.lote && atual && atual.bagsLoteados + l.qtdLote <= qtd + EPS) {
        atual.bagsLoteados += l.qtdLote
        atual.lotes++
        resumo.linhasDeLoteRepetidas++
        continue
      }
      const item: ItemACarregar = { ...l.item, bagsLoteados: l.qtdLote, lotes: l.lote ? 1 : 0 }
      todos.push(item)
      // linha sem lote é item fechado: o lote seguinte da mesma chave é outro item
      atual = l.lote ? item : null
    }
    resumo.itensRepetidos += Math.max(0, todos.length - antes - 1)
  }

  // 3. separa os já faturados e soma o resto
  const itens: ItemACarregar[] = []
  const soma = (m: Record<string, { itens: number; bags: number }>, k: string, bags: number) => {
    const e = m[k] ?? { itens: 0, bags: 0 }
    e.itens++
    e.bags += bags
    m[k] = e
  }
  for (const it of todos) {
    resumo.itens++
    if (it.lotes > 0 && it.bagsLoteados < it.bags - EPS) resumo.loteParcial++
    if (it.lotes > 0 && it.bagsLoteados > it.bags + EPS) resumo.sobreLoteado++
    if (statusJaFaturado(it.status)) {
      resumo.jaFaturados.itens++
      resumo.jaFaturados.bags += it.bags
      soma(resumo.jaFaturados.porStatus, it.status, it.bags)
      continue
    }
    itens.push(it)
    resumo.itensACarregar++
    resumo.bagsACarregar += it.bags
    soma(resumo.porStatus, it.status, it.bags)
    if (!it.dataCarga) resumo.semData++
    if (!it.embalagemConhecida) {
      const k = it.embalagem || '?'
      resumo.embalagemDesconhecida[k] = (resumo.embalagemDesconhecida[k] ?? 0) + it.bags
    }
    if (normaliza(it.tratamento) === 'SEM TSI') {
      resumo.semTsi.itens++
      resumo.semTsi.bags += it.bags
    }
  }

  return { itens, resumo }
}
