/**
 * Helpers puros da aba "SAP (teste)" — separados da tela para ganharem teste
 * de unidade. A validação de caminho espelha a da Edge Function `sap-teste`:
 * recusar aqui dá feedback imediato, mas a barreira que vale é a de lá.
 */

/** Só quem está nesta lista vê a aba; a Edge Function usa a mesma. */
export const USUARIOS_SAP_TESTE = ['arion.pereira@sementesveneza.com.br']

/**
 * Feedback imediato na tela; a barreira que vale é a `resolveCaminho` da
 * Edge Function. Recusa `%` e `\` além de `..`: o parser de URL colapsa
 * `%2e%2e`/`\` em `..`, então checar só o literal deixaria escapar do
 * /b1s/v1 (o servidor recusa de novo, mas erra cedo é melhor).
 */
export function problemaNoCaminho(caminho: string): string | null {
  const c = caminho.trim()
  if (!c) return 'Informe o caminho OData.'
  if (c.includes('://')) return 'Só caminho relativo — sem http(s)://.'
  if (c.includes('..')) return 'Caminho não pode conter "..".'
  if (c.includes('%') || c.includes('\\')) return 'Sem "%" ou "\\" no caminho.'
  if (c.startsWith('/')) return 'Sem a barra inicial — ex.: Items?$top=1'
  if (!/^[A-Za-z$]/.test(c)) return 'O caminho começa com letra (ou $).'
  return null
}

export interface TabelaSap {
  colunas: string[]
  linhas: Record<string, unknown>[]
  /** true se houve mais colunas do que MAX_COLUNAS e o resto foi cortado. */
  colunasCortadas: boolean
}

/** Teto de colunas exibidas: `Orders` sem `$select` traz ~300 campos e
 *  renderizar todas trava a aba. O aviso na tela conta o corte. */
export const MAX_COLUNAS = 40

/**
 * Converte a resposta do Service Layer em linhas de tabela, quando ela tem
 * essa cara: coleção OData ({ value: [...] }) ou array puro. Resposta de
 * entidade única ou escalar devolve null — a tela mostra o JSON cru.
 *
 * As colunas são a UNIÃO das chaves de TODAS as linhas (consulta SQL omite
 * campo nulo em algumas linhas; olhar só as primeiras perderia colunas e a
 * coluna sumiria do CSV também). Metadados `odata.*` e propriedades de
 * navegação (arrays/objetos aninhados, ex.: DocumentLines) ficam de fora —
 * inchariam a tabela e a célula viraria um JSON gigante.
 */
export function tabelaDe(dados: unknown): TabelaSap | null {
  const corpo = dados as { value?: unknown } | null
  const lista = Array.isArray(dados)
    ? dados
    : Array.isArray(corpo?.value)
      ? corpo.value
      : null
  if (!lista) return null

  const linhas = lista.filter(
    (l): l is Record<string, unknown> => typeof l === 'object' && l !== null,
  )
  const todas: string[] = []
  for (const linha of linhas) {
    for (const [chave, valor] of Object.entries(linha)) {
      if (chave.startsWith('odata.')) continue
      // navegação aninhada (DocumentLines etc.) não vira coluna de tabela
      if (valor !== null && typeof valor === 'object') continue
      if (!todas.includes(chave)) todas.push(chave)
    }
  }
  const colunas = todas.slice(0, MAX_COLUNAS)
  return { colunas, linhas, colunasCortadas: todas.length > MAX_COLUNAS }
}

export interface EntidadeSap {
  /** campos escalares do próprio objeto — nome + valor bruto (passa por textoCelula na tela). */
  campos: [string, unknown][]
  /** coleções aninhadas (ex.: ItemWarehouseInfoCollection, DocumentLines), já como tabela. */
  colecoes: { nome: string; tabela: TabelaSap }[]
}

/**
 * Converte resposta de ENTIDADE ÚNICA (`Items('X')`, `Orders(4404)`...) em
 * campos escalares + coleções aninhadas como sub-tabelas — em vez do JSON
 * cru, que escondia dados úteis como `ItemWarehouseInfoCollection` (estoque
 * e comprometido por depósito) atrás de uma parede de texto.
 *
 * Devolve null para coleção ({ value: [...] }, já cobertas por `tabelaDe`)
 * e para valor escalar/array solto — só entidade única (objeto) tem esta forma.
 */
export function entidadeDe(dados: unknown): EntidadeSap | null {
  if (dados === null || typeof dados !== 'object' || Array.isArray(dados)) return null
  const obj = dados as Record<string, unknown>
  if (Array.isArray(obj.value)) return null // é coleção — tabelaDe cobre

  const campos: [string, unknown][] = []
  const colecoes: { nome: string; tabela: TabelaSap }[] = []
  for (const [chave, valor] of Object.entries(obj)) {
    if (chave.startsWith('odata.')) continue
    if (Array.isArray(valor) && valor.some((v) => v !== null && typeof v === 'object')) {
      const tabela = tabelaDe(valor)
      if (tabela) colecoes.push({ nome: chave, tabela })
      continue
    }
    if (valor !== null && typeof valor === 'object') continue // objeto aninhado raro: ignora
    campos.push([chave, valor])
  }
  return campos.length === 0 && colecoes.length === 0 ? null : { campos, colecoes }
}

/**
 * Cultivar + embalagem a partir do `ItemName` do SAP — mesma regra do
 * importador da SimpleAgro (`src/dominio/importacao/simpleagro.ts`,
 * "SS <cultivar> <embalagem>", miolo entre o primeiro e o último token) e do
 * CLAUDE.md §4. Diferença: item TRATADO no SAP termina em "TSI"
 * (`SS NA7337 RR BB5M TSI`, confirmado em 09/08/2026) — remove esse token
 * antes de achar a embalagem, senão "TSI" seria lido como se fosse o código
 * de embalagem e a embalagem de verdade entraria no cultivar.
 */
export function partesDoNome(itemName: string): {
  cultivar: string
  embalagem: string
  tratado: boolean
} {
  let tokens = itemName.trim().split(/\s+/).filter(Boolean)
  let tratado = false
  if (tokens[tokens.length - 1]?.toUpperCase() === 'TSI') {
    tratado = true
    tokens = tokens.slice(0, -1)
  }
  if (tokens.length <= 2) return { cultivar: '', embalagem: tokens.at(-1) ?? '', tratado }
  return {
    cultivar: tokens.slice(1, -1).join(' '),
    embalagem: tokens[tokens.length - 1],
    tratado,
  }
}

export interface ResumoItem {
  itemCode: string
  itemName: string
  cultivar: string
  embalagem: string
  tratado: boolean
  saldoTotal: number
  /** só os depósitos com saldo diferente de zero — o pedido era "não quero ver os zerados" */
  porArmazem: { armazem: string; saldo: number; comprometido: number }[]
  totalPedidos: number
  saldoFinal: number
}

/**
 * Resumo de UM item a partir de `Items('CODIGO')` — uma chamada só.
 *
 * O "total em pedidos" NÃO vem de somar `Orders` na mão: testado em
 * 09/08/2026, `$expand=DocumentLines` em `Orders` dá
 * `400 "Cannot expand invalid navigation property 'DocumentLines' for
 * entity type 'Document'"` nesta versão do Service Layer — não tem jeito de
 * pedir isso ao SAP. Em vez de brigar com a API, usa o que o próprio SAP já
 * calcula: `ItemWarehouseInfoCollection[].Committed` é a quantidade já
 * reservada em pedidos de venda **abertos**, por depósito — soma-se ela em
 * vez de recalcular. `Committed` entra na soma mesmo de depósito com saldo
 * zerado (pode haver reserva sem estoque físico — não contar subestimaria).
 *
 * Devolve null se `itemJson` não for uma entidade de item reconhecível.
 */
export function resumoItem(itemJson: unknown): ResumoItem | null {
  if (itemJson === null || typeof itemJson !== 'object') return null
  const item = itemJson as Record<string, unknown>
  const itemCode = String(item.ItemCode ?? '')
  if (!itemCode) return null
  const itemName = String(item.ItemName ?? '')
  const { cultivar, embalagem, tratado } = partesDoNome(itemName)

  const armazens = Array.isArray(item.ItemWarehouseInfoCollection)
    ? (item.ItemWarehouseInfoCollection as Record<string, unknown>[])
    : []
  const totalPedidos = armazens.reduce((soma, w) => soma + Number(w.Committed ?? 0), 0)
  const porArmazem = armazens
    .map((w) => ({
      armazem: String(w.WarehouseCode ?? ''),
      saldo: Number(w.InStock ?? 0),
      comprometido: Number(w.Committed ?? 0),
    }))
    .filter((w) => w.saldo !== 0)
    .sort((a, b) => b.saldo - a.saldo)

  const saldoTotal = Number(item.QuantityOnStock ?? 0)
  return {
    itemCode,
    itemName,
    cultivar,
    embalagem,
    tratado,
    saldoTotal,
    porArmazem,
    totalPedidos,
    saldoFinal: saldoTotal - totalPedidos,
  }
}

/**
 * Embalagens que o app reconhece (mesmo de-para de
 * `src/dominio/importacao/simpleagro.ts`, `EMBALAGEM_DEPARA`). Item cujo
 * último token do nome não é uma dessas não é lote de cultivar — é matéria-
 * prima/granel (ex.: `SOJ00001`, "GRAO ORIUNDO DO CAMPO DE
 * SEMENTES/DESTINADO SEMENTES", saldo na casa de milhões) — mesma regra que
 * a SimpleAgro já usa pra jogar granel fora do balanço.
 */
const EMBALAGENS_RECONHECIDAS = new Set(['BB5M', 'BMB'])

export interface RelatorioComPedido {
  prefixo: string
  /** quantos itens do prefixo existem no SAP, antes de qualquer filtro */
  totalLido: number
  /** itens com pedido (Committed > 0) E embalagem reconhecida — a lista que a tela mostra */
  itens: ResumoItem[]
  /** tinham pedido mas embalagem não reconhecida (granel/matéria-prima) — contados, não escondidos */
  ignorados: number
}

/**
 * Resumo de TODOS os itens de um prefixo (`SOJ`, `INS`...) que têm pedido em
 * aberto, ordenado do maior déficit pro maior excedente.
 *
 * `itensJson` já vem paginado por fora (ver `buscarItensComPedido` na tela) —
 * esta função só calcula, não busca; fica testável sem rede.
 */
export function relatorioComPedido(itensJson: unknown[], prefixo: string): RelatorioComPedido {
  const todos = itensJson.map(resumoItem).filter((r): r is ResumoItem => r !== null)
  const comPedido = todos.filter((r) => r.totalPedidos > 0)
  const itens = comPedido.filter((r) => EMBALAGENS_RECONHECIDAS.has(r.embalagem))
  itens.sort((a, b) => a.saldoFinal - b.saldoFinal)
  return { prefixo, totalLido: todos.length, itens, ignorados: comPedido.length - itens.length }
}

/**
 * Caminho da `TSI_SALDOS` — a consulta salva OBTN×OBTQ (nº do lote, PMS,
 * tratamento, depósito, quantidade em estoque), a mesma do Gerador de
 * Consultas do cliente B1 apontada pelo Arion ("essa consulta traz o saldo
 * de cada lote", docs/integracao-sap.md §3.2), criada em produção via
 * `sap-criar-tsi-saldos` em 13/08/2026 (§6.9).
 *
 * SEM parâmetro de propósito: parâmetro de SQLQueries vai na query string
 * (`?updatedate='...'`) e o padrão WHATWG de URL — o que o navegador e o
 * Deno usam — codifica a aspa como `%27` na serialização, coisa que o
 * PowerShell não faz. Consulta sem parâmetro não tem query string, então
 * não depende de como o Service Layer trata `%27`. Quem chama filtra o
 * lote depois, por `Nº do Lote`.
 */
export function caminhoSaldoLotes(): string {
  return `SQLQueries('TSI_SALDOS')/List`
}

export interface SaldoLoteSap {
  loteId: string
  /** linhas da TSI_SALDOS que batem com este lote (uma por depósito) — 0 é
   *  resultado válido: a consulta só traz Quantity > 0, então lote esgotado
   *  não aparece */
  encontrados: number
  /** total de linhas devolvidas, de TODOS os lotes — 0 aqui aponta pra busca
   *  vazia (consulta não criada, paginação); >0 com `encontrados` zerado
   *  aponta pro nº do lote não bater com o formato de `lotes_semente.id` */
  totalLinhasSaldo: number
  /** alguns números de lote reais devolvidos (de qualquer lote) — só pra
   *  comparar o FORMATO visualmente quando `encontrados` zera apesar de
   *  `totalLinhasSaldo` > 0 */
  amostraBatchNum: string[]
  itemCodes: string[]
  quantidadeTotal: number
  pms: number | null
  tratamentoSap: string | null
}

function linhasDe(dados: unknown): Record<string, unknown>[] {
  const corpo = dados as { value?: unknown } | null
  if (Array.isArray(corpo?.value)) return corpo?.value as Record<string, unknown>[]
  if (Array.isArray(dados)) return dados as Record<string, unknown>[]
  return []
}

/** Colunas da TSI_SALDOS vêm com os ALIASES do SQL ("Nº do Lote", "Qtd em
 *  Estoque"…). Os fallbacks cobrem o caso de o Service Layer devolver o
 *  nome cru da coluna em vez do alias (varia entre versões). */
function campo(l: Record<string, unknown>, ...nomes: string[]): unknown {
  for (const n of nomes) if (l[n] !== undefined) return l[n]
  return undefined
}

/**
 * Converte a resposta da TSI_SALDOS num resultado exibível ao lado do total
 * programado — UMA chamada só: a consulta já traz quantidade, PMS e
 * tratamento juntos (dispensou o `BatchNumberDetails`). Ainda não converte
 * para "bags" — falta confirmar com dado real se a quantidade é diretamente
 * comparável; por ora mostra o valor cru para conferência visual (decisão
 * de 12/08/2026: teste primeiro, converter depois). Filtra por
 * `Nº do Lote === loteId` aqui — tanto faz receber o retorno inteiro ou um
 * recorte.
 */
export function saldoLoteDe(dadosSaldo: unknown, loteId: string): SaldoLoteSap {
  const alvo = loteId.trim()
  const todasSaldo = linhasDe(dadosSaldo)
  const numeroDoLote = (l: Record<string, unknown>) =>
    String(campo(l, 'Nº do Lote', 'DistNumber') ?? '').trim()
  const doLote = todasSaldo.filter((l) => numeroDoLote(l) === alvo)
  const linhaComPms = doLote.find((l) => {
    const v = campo(l, 'PMS (g)', 'U_AGRT_PMS')
    return v !== null && v !== undefined && v !== ''
  })
  const linhaComTrat = doLote.find((l) => campo(l, 'Tratamento (TSI)', 'U_LoteTSI'))

  return {
    loteId,
    encontrados: doLote.length,
    totalLinhasSaldo: todasSaldo.length,
    amostraBatchNum: [
      ...new Set(todasSaldo.map(numeroDoLote).filter(Boolean)),
    ].slice(0, 3),
    itemCodes: [...new Set(doLote.map((l) => String(l.ItemCode ?? '')).filter(Boolean))],
    quantidadeTotal: doLote.reduce(
      (soma, l) => soma + Number(campo(l, 'Qtd em Estoque', 'Quantity') ?? 0),
      0,
    ),
    pms: linhaComPms ? Number(campo(linhaComPms, 'PMS (g)', 'U_AGRT_PMS')) : null,
    tratamentoSap: linhaComTrat
      ? String(campo(linhaComTrat, 'Tratamento (TSI)', 'U_LoteTSI'))
      : null,
  }
}

/** Tamanho máximo de uma célula renderizada — trava JSON/valor gigante. */
const MAX_CELULA = 200

/** Valor de célula legível: null vira travessão, objeto vira JSON, tudo
 *  truncado para não travar a renderização com um campo enorme. */
export function textoCelula(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return s.length > MAX_CELULA ? s.slice(0, MAX_CELULA) + '…' : s
}
