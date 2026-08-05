/**
 * Conversão dos dois relatórios da SimpleAgro.
 *
 * São funções puras sobre linhas (string[][]) — a leitura do .xlsx é um
 * adaptador fino em volta delas. É isso que permite testar as regras contra
 * os números conferidos sem depender de arquivo.
 */

/** Uma linha da planilha. O leitor de xlsx devolve datas como Date, não texto. */
export type Linha = (string | number | Date | boolean | null | undefined)[]

const txt = (v: unknown): string => (v == null ? '' : String(v).trim())

const num = (v: unknown): number => {
  const n = parseFloat(txt(v).replace(/\./g, '').replace(',', '.'))
  return Number.isNaN(n) ? 0 : n
}

/** De-para de embalagem: código da SimpleAgro → código do app. */
export const EMBALAGEM_DEPARA: Record<string, { codigo: string; fator: number }> = {
  BB5M: { codigo: 'BG5M', fator: 5 },
  BMB: { codigo: 'MEIOBAG', fator: 2.5 },
}

// ================================================================
// 1. Pedidos Analítico Resumido
// ================================================================

export interface PedidoConvertido {
  cultivar: string
  tratamento: string
  embalagem: string
  bags: number
  /** Coluna H = 'Aprovado'. Só aprovado entra no balanço. */
  aprovado: boolean
}

export interface ResumoPedidos {
  totalLinhas: number
  foraStatus: number
  semTsi: number
  saldoZero: number
  aproveitadas: number
  /** Códigos de tratamento sem receita cadastrada → bags. */
  semReceita: Record<string, number>
  /** Embalagens sem de-para → bags. */
  embalagemDesconhecida: Record<string, number>
  /**
   * Status Pedido descartados → linhas e bags, contando só o que seria
   * trabalho de TSI de verdade (tratamento real e saldo positivo).
   *
   * Sem esse detalhe o descarte é cego: `foraStatus` sozinho não distingue
   * "96 cancelados, tudo certo" de "a SimpleAgro renomeou o status e eu
   * joguei o arquivo inteiro fora".
   */
  porStatusFora: Record<string, { linhas: number; bags: number }>
  /** Valores distintos de Status Financeiro vistos → bags. */
  porStatusFinanceiro: Record<string, number>
}

/**
 * `Integrado` é o único Status Pedido que gera trabalho.
 *
 * A comparação ignora caixa e acento de propósito: uma renomeação na origem
 * (`INTEGRADO`, `integrado`) descartaria o arquivo inteiro e o painel mostraria
 * zero demanda — indistinguível de "não há pedido". Falha calada é pior que
 * falha barulhenta.
 */
const normaliza = (s: string): string =>
  s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim()

const STATUS_VALE = 'INTEGRADO'
/** `Não Aprovado` normaliza para `NAO APROVADO`: a igualdade exata basta. */
const FINANCEIRO_APROVADO = 'APROVADO'

export interface ResultadoPedidos {
  linhas: PedidoConvertido[]
  resumo: ResumoPedidos
  totalAprovado: number
  totalPendente: number
}

export const ehRelatorioPedidos = (rows: Linha[]): boolean => {
  const h = (rows[0] ?? []).map(txt)
  return h.includes('Status Pedido') && h.includes('Saldo a Faturar')
}

/**
 * Regras validadas contra o arquivo real de 1.196 linhas:
 * - coluna E `Status Pedido`: só `Integrado`
 * - coluna H `Status Financeiro`: `Aprovado` entra no balanço
 * - coluna BW `Saldo a Faturar` = quantidade em bags (já líquida do faturado)
 * - coluna AT `Tratamento` = código da receita; `SEM TSI` é excluído
 * - coluna AU `Embalagem`: BB5M→BG5M, BMB→MEIOBAG
 * - coluna AL `Produto` vem duplicado ("761 I2X - 761 I2X") → usar o 1º trecho
 */
export function converterPedidos(
  rows: Linha[],
  receitasCadastradas: string[] = [],
): ResultadoPedidos {
  const cabecalho = (rows[0] ?? []).map(txt)
  const ix = (nome: string) => cabecalho.indexOf(nome)
  const iStatus = ix('Status Pedido')
  const iFin = ix('Status Financeiro')
  const iProduto = ix('Produto')
  const iTrat = ix('Tratamento')
  const iEmb = ix('Embalagem')
  const iSaldo = ix('Saldo a Faturar')

  const receitas = new Set(receitasCadastradas.map((r) => r.toUpperCase()))
  const agregado = new Map<string, PedidoConvertido>()
  const resumo: ResumoPedidos = {
    totalLinhas: Math.max(0, rows.length - 1),
    foraStatus: 0,
    semTsi: 0,
    saldoZero: 0,
    aproveitadas: 0,
    semReceita: {},
    embalagemDesconhecida: {},
    porStatusFora: {},
    porStatusFinanceiro: {},
  }

  for (const r of rows.slice(1)) {
    const statusRaw = txt(r[iStatus])
    const tratamento = txt(r[iTrat])
    const bags = num(r[iSaldo])

    if (normaliza(statusRaw) !== STATUS_VALE) {
      resumo.foraStatus++
      // só reporta o descarte que era trabalho de TSI de verdade: cancelado
      // de SEM TSI ou com saldo zerado é ruído, não perda
      if (tratamento && normaliza(tratamento) !== 'SEM TSI' && bags > 0) {
        const k = statusRaw || '(vazio)'
        const a = resumo.porStatusFora[k] ?? { linhas: 0, bags: 0 }
        a.linhas++
        a.bags += bags
        resumo.porStatusFora[k] = a
      }
      continue
    }
    if (!tratamento || normaliza(tratamento) === 'SEM TSI') {
      resumo.semTsi++
      continue
    }
    if (bags <= 0) {
      resumo.saldoZero++
      continue
    }
    const embRaw = txt(r[iEmb])
    const emb = EMBALAGEM_DEPARA[embRaw]
    if (!emb) {
      resumo.embalagemDesconhecida[embRaw || '?'] =
        (resumo.embalagemDesconhecida[embRaw || '?'] ?? 0) + bags
      continue
    }
    // Código sem receita cadastrada NÃO é descartado: a demanda existe.
    // O painel marca a combinação como "receita não cadastrada".
    if (receitas.size > 0 && !receitas.has(tratamento.toUpperCase())) {
      resumo.semReceita[tratamento] = (resumo.semReceita[tratamento] ?? 0) + bags
    }
    const cultivar = txt(r[iProduto]).split(' - ')[0].trim()
    const finRaw = txt(r[iFin])
    resumo.porStatusFinanceiro[finRaw || '(vazio)'] =
      (resumo.porStatusFinanceiro[finRaw || '(vazio)'] ?? 0) + bags
    // aprovação financeira NÃO filtra a importação: define só quem conta no
    // saldo. O não aprovado entra visível, fora da conta
    const aprovado = normaliza(finRaw) === FINANCEIRO_APROVADO
    const chave = [cultivar, tratamento, emb.codigo, aprovado ? 'A' : 'P'].join('|')

    const atual = agregado.get(chave)
    if (atual) atual.bags += bags
    else
      agregado.set(chave, {
        cultivar,
        tratamento,
        embalagem: emb.codigo,
        bags,
        aprovado,
      })
    resumo.aproveitadas++
  }

  const linhas = [...agregado.values()].sort(
    (a, b) =>
      a.cultivar.localeCompare(b.cultivar) ||
      a.tratamento.localeCompare(b.tratamento) ||
      a.embalagem.localeCompare(b.embalagem),
  )

  return {
    linhas,
    resumo,
    totalAprovado: linhas.filter((l) => l.aprovado).reduce((a, l) => a + l.bags, 0),
    totalPendente: linhas.filter((l) => !l.aprovado).reduce((a, l) => a + l.bags, 0),
  }
}

// ================================================================
// 2. Saldos — uma fonte, dois destinos
// ================================================================

export interface LoteConvertido {
  id: string
  cultivar: string
  /** Coluna LOTE TRATAMENTO da origem. Aqui é sempre a faixa `SEM TSI`. */
  tratamento: string
  pms: number
  pesoBagKg: number
  bags: number
}

export interface EstoquePaConvertido {
  cultivar: string
  tratamento: string
  embalagem: string
  bags: number
}

export interface ResumoSaldos {
  totalLinhas: number
  /** PRE-LOTE / granel: sem embalagem no nome, é matéria-prima em kg. */
  granel: number
  saldoZeroOuNegativo: number
  /** Saldo negativo na origem: ignorado, mas reportado. */
  negativos: { lote: string; bags: number }[]
  semPms: number
}

export interface ResultadoSaldos {
  lotes: LoteConvertido[]
  estoquePa: EstoquePaConvertido[]
  resumo: ResumoSaldos
  totalBagsLotes: number
  totalBagsEstoque: number
}

export const ehRelatorioSaldos = (rows: Linha[]): boolean => {
  const h = (rows[0] ?? []).map((c) => txt(c).toUpperCase())
  return h.includes('LOTE TRATAMENTO') && h.includes('SALDO') && h.includes('CULTIVAR')
}

/**
 * Um arquivo, dois destinos:
 * - com embalagem + tratamento `SEM TSI` → lotes de semente (entrada do TSI),
 *   agregando o mesmo lote espalhado em vários endereços
 * - com embalagem + tratamento real     → estoque de produto acabado
 * - PRE-LOTE / granel (sem embalagem)   → ignorado
 *
 * Peso do bag = PMS × 5 (BB5M) ou × 2,5 (BMB).
 * O cabeçalho real traz `LOTE PME`, não PMS — daí a busca tolerante.
 */
export function converterSaldos(rows: Linha[]): ResultadoSaldos {
  const h = (rows[0] ?? []).map((c) => txt(c).toUpperCase())
  const ix = (nome: string) => h.indexOf(nome)
  const iNome = ix('NOME PRODUTO')
  const iCult = ix('CULTIVAR')
  const iLote = ix('LOTE')
  const iTrat = ix('LOTE TRATAMENTO')
  const iSaldo = ix('SALDO')
  const iPms = h.findIndex((x) => x.includes('PME') || x.includes('PMS'))

  const lotes = new Map<string, LoteConvertido>()
  const estoque = new Map<string, EstoquePaConvertido>()
  const resumo: ResumoSaldos = {
    totalLinhas: Math.max(0, rows.length - 1),
    granel: 0,
    saldoZeroOuNegativo: 0,
    negativos: [],
    semPms: 0,
  }

  for (const r of rows.slice(1)) {
    const nome = txt(r[iNome])
    const ultimoToken = nome.split(/\s+/).pop() ?? ''
    const emb = EMBALAGEM_DEPARA[ultimoToken]
    if (!emb) {
      resumo.granel++
      continue
    }
    const bags = num(r[iSaldo])
    if (bags < 0) resumo.negativos.push({ lote: txt(r[iLote]) || '?', bags })
    if (bags <= 0) {
      resumo.saldoZeroOuNegativo++
      continue
    }
    const cultivar = txt(r[iCult])
    const tratamento = txt(r[iTrat])
    const pms = iPms >= 0 ? num(r[iPms]) : 0

    if (tratamento.toUpperCase() === 'SEM TSI') {
      const id = txt(r[iLote])
      if (!id) continue
      if (!pms) resumo.semPms++
      const atual = lotes.get(id)
      if (atual) atual.bags += bags
      else
        lotes.set(id, {
          id,
          cultivar,
          tratamento,
          pms,
          pesoBagKg: Math.round(pms * emb.fator),
          bags,
        })
    } else {
      const chave = [cultivar, tratamento, emb.codigo].join('|')
      const atual = estoque.get(chave)
      if (atual) atual.bags += bags
      else
        estoque.set(chave, { cultivar, tratamento, embalagem: emb.codigo, bags })
    }
  }

  return {
    lotes: [...lotes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    estoquePa: [...estoque.values()].sort(
      (a, b) => a.cultivar.localeCompare(b.cultivar) || a.tratamento.localeCompare(b.tratamento),
    ),
    resumo,
    totalBagsLotes: [...lotes.values()].reduce((a, l) => a + l.bags, 0),
    totalBagsEstoque: [...estoque.values()].reduce((a, e) => a + e.bags, 0),
  }
}
