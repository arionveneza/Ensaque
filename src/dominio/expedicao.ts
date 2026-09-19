/**
 * Expedição: o que está agendado × o que existe para carregar.
 *
 * Desde 12/09/2026 a fonte é o relatório "pedidos agendados" da SimpleAgro
 * (`converterAgendados`): cada linha é um item de pedido com QTD AGENDADA,
 * DATA AGENDADA e TIPO VENDA. O conversor da "montagem de carga"
 * (`converterMontagemCarga`) continua aqui porque a tabela `carregamentos`
 * ficou como histórico. A pergunta que nenhum dos dois relatórios responde
 * sozinho é a que importa: **o estoque atende o que está agendado?**
 *
 * O cruzamento tem uma sutileza de negócio: agendamento `SEM TSI` é semente
 * branca, que sai do estoque de LOTES; agendamento com tratamento real sai
 * do estoque de PRODUTO ACABADO, e pode ainda contar com a produção
 * programada até a data. São dois estoques diferentes — somar tudo num
 * número só esconderia exatamente a falta que se quer enxergar.
 */

import {
  EMBALAGEM_DEPARA, FILIAL_CASA, nomeCurtoFilial, normaliza, normalizaCultivar, normalizaFilial,
  type Linha,
} from './importacao/simpleagro'

/**
 * O pedido precisa de transferência de saldo? Só quando a filial é
 * conhecida E não é a matriz (`FILIAL_CASA`). Sem filial não se afirma nada
 * — a tela mostra "filial não informada" (13/09/2026).
 */
export function transferenciaDe(filial: string | null | undefined): {
  precisa: boolean
  filial: string | null
  /** Nome curto para etiqueta (TUPACIGUARA, MATRIZ…). */
  curto: string | null
} {
  const f = filial ? normalizaFilial(filial) : null
  if (!f) return { precisa: false, filial: null, curto: null }
  return { precisa: f !== FILIAL_CASA, filial: f, curto: nomeCurtoFilial(f) }
}

const txt = (v: unknown): string => (v == null ? '' : String(v).trim())

const num = (v: unknown): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const n = parseFloat(txt(v).replace(/\./g, '').replace(',', '.'))
  return Number.isNaN(n) ? 0 : n
}

/** Data da carga em ISO (só o dia). O leitor de xlsx devolve Date. */
const dia = (v: unknown): string | null => {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10)
  const s = txt(v)
  // dd/mm/aaaa — formato que o export usa quando a célula é texto
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s)
  if (m) return `${m[3]}-${m[2]}-${m[1]}`
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  return null
}

export interface CarregamentoConvertido {
  carga: number
  status: string
  data: string | null
  pedido: string
  cliente: string
  cultivar: string
  /** `SEM TSI` = semente branca; código real = produto tratado. */
  tratamento: string
  embalagem: string
  bags: number
  transportadora: string | null
  motorista: string | null
  placa: string | null
}

export interface ResumoCarregamentos {
  totalLinhas: number
  aproveitadas: number
  semData: number
  semQuantidade: number
  /** Embalagens sem de-para → bags (a linha entra mesmo assim, com o código cru). */
  embalagemDesconhecida: Record<string, number>
  /** Status distintos vistos → linhas (é deles que a tela monta o filtro). */
  porStatus: Record<string, number>
}

/**
 * Normaliza o retorno do leitor de xlsx. Arquivo com aba NOMEADA (o export
 * da montagem de carga vem numa aba chamada `relatorio`) faz o read-excel-file
 * devolver `[{ sheet, data }]` em vez das linhas diretas — e aí `rows[0]` não
 * é uma linha, é um objeto, e a importação quebrava com
 * "(e[0] ?? []).map is not a function".
 *
 * `aceita` escolhe a aba certa quando o arquivo tem várias: sem isso, uma
 * aba de capa antes da `relatorio` faria um arquivo válido ser rejeitado.
 */
export function normalizaLinhasXlsx(
  bruto: unknown,
  aceita?: (rows: Linha[]) => boolean,
): Linha[] {
  const arr = bruto as ({ sheet?: string; data?: Linha[] } | Linha)[]
  if (arr.length > 0 && !Array.isArray(arr[0])) {
    const abas = arr.filter(
      (x): x is { sheet?: string; data: Linha[] } =>
        Array.isArray((x as { data?: unknown })?.data),
    )
    if (abas.length === 0) return []
    if (aceita) {
      const certa = abas.find((a) => aceita(a.data))
      if (certa) return certa.data
    }
    return abas[0].data
  }
  return arr as Linha[]
}

export const ehRelatorioMontagemCarga = (rows: Linha[]): boolean => {
  const h = (rows[0] ?? []).map(txt)
  return h.includes('Carga') && h.includes('Qtd Agendada') && h.includes('Status Carga')
}

/**
 * Converte o relatório de montagem de carga. As colunas são achadas pelo
 * NOME no cabeçalho — a posição varia entre exports, o nome não.
 *
 * Linha sem quantidade não vira carregamento (é cabeçalho de carga vazia ou
 * lixo de export); linha sem data entra mesmo assim, marcada — o PCP decide
 * o que fazer com um agendamento sem dia, mas escondê-lo seria pior.
 */
export function converterMontagemCarga(rows: Linha[]): {
  linhas: CarregamentoConvertido[]
  resumo: ResumoCarregamentos
} {
  const cab = (rows[0] ?? []).map(txt)
  const ix = (nome: string) => cab.indexOf(nome)
  const iCarga = ix('Carga')
  const iStatus = ix('Status Carga')
  const iData = ix('Data Carga')
  const iPedido = ix('Pedido')
  const iCliente = ix('Cliente')
  const iProduto = ix('Produto')
  const iTrat = ix('Tratamento')
  const iEmb = ix('Embalagem')
  const iQtd = ix('Qtd Agendada')
  const iTransp = ix('Transportadora')
  const iMotorista = ix('Motorista')
  const iPlaca = ix('Placa Caminhão')

  if (iCarga < 0 || iQtd < 0 || iProduto < 0) {
    throw new Error(
      'A planilha não parece o relatório de montagem de carga: faltam as colunas Carga, Produto ou Qtd Agendada.',
    )
  }

  const linhas: CarregamentoConvertido[] = []
  const resumo: ResumoCarregamentos = {
    totalLinhas: Math.max(0, rows.length - 1),
    aproveitadas: 0,
    semData: 0,
    semQuantidade: 0,
    embalagemDesconhecida: {},
    porStatus: {},
  }

  for (const r of rows.slice(1)) {
    const bags = num(r[iQtd])
    if (bags <= 0) {
      resumo.semQuantidade++
      continue
    }
    const embCru = txt(r[iEmb]).toUpperCase()
    const emb = EMBALAGEM_DEPARA[embCru]?.codigo ?? embCru
    if (embCru && !EMBALAGEM_DEPARA[embCru]) {
      resumo.embalagemDesconhecida[embCru] =
        (resumo.embalagemDesconhecida[embCru] ?? 0) + bags
    }
    const data = dia(r[iData])
    if (!data) resumo.semData++
    const status = txt(r[iStatus]) || 'Sem status'
    resumo.porStatus[status] = (resumo.porStatus[status] ?? 0) + 1

    linhas.push({
      carga: num(r[iCarga]),
      status,
      data,
      pedido: txt(r[iPedido]),
      cliente: txt(r[iCliente]),
      cultivar: normalizaCultivar(txt(r[iProduto])),
      tratamento: txt(r[iTrat]).toUpperCase() || 'SEM TSI',
      embalagem: emb,
      bags,
      transportadora: txt(r[iTransp]) || null,
      motorista: txt(r[iMotorista]) || null,
      placa: txt(r[iPlaca]) || null,
    })
    resumo.aproveitadas++
  }

  return { linhas, resumo }
}

// ================================================================
// Pedidos agendados (12/09/2026) — substituiu a montagem de carga na tela
// ================================================================

/**
 * Código do tratamento como a receita grava: caixa alta, sem acento, um
 * espaço de cada lado do "+" — `FTZ60+VIC`, `ftz60 + vic` e `FTZ60 + VIC`
 * são o mesmo tratamento.
 */
export const normalizaTratamento = (s: string): string =>
  normaliza(s).replace(/\s*\+\s*/g, ' + ').replace(/\s+/g, ' ').trim()

/** IDENTIFICADOR e TIPO VENDA não existem na montagem de carga — sem ambiguidade. */
export const ehRelatorioAgendados = (rows: Linha[]): boolean => {
  const h = (rows[0] ?? []).map((c) => normaliza(txt(c)))
  return ['IDENTIFICADOR', 'TIPO VENDA', 'QTD AGENDADA', 'DATA AGENDADA'].every((n) => h.includes(n))
}

export interface AgendamentoConvertido {
  /** Coluna A — único no relatório, mas não é chave no banco. */
  identificador: string
  /** NUMERO do pedido — repete por item. */
  pedido: string
  /**
   * FILIAL do próprio relatório — vem vazia hoje (289/289 em 10/09/2026); a
   * filial de verdade sai do cruzamento com `pedidos_filial` na tela.
   */
  filial: string | null
  tipoVenda: string
  /** `tipoVenda` contém COOPERADO — mesma regra do import de pedidos. */
  cooperado: boolean
  cliente: string
  cidade: string | null
  estado: string | null
  cultivar: string
  categoria: string | null
  /** `SEM TSI` = semente branca; código real = produto tratado. */
  tratamento: string
  embalagem: string
  qtdPedido: number
  /** QTD AGENDADA — a que vale (pode ser menor que o pedido). */
  bags: number
  statusEntrega: string
  carga: string | null
  statusCarga: string | null
  data: string | null
  observacao: string | null
}

export interface ResumoAgendados {
  totalLinhas: number
  aproveitadas: number
  semQuantidade: number
  semData: number
  /** Embalagens sem de-para → bags (a linha entra mesmo assim, com o código cru). */
  embalagemDesconhecida: Record<string, number>
  porTipoVenda: Record<string, number>
  porStatusEntrega: Record<string, number>
  porStatusCarga: Record<string, number>
  bagsCooperado: number
  bagsOutras: number
  identificadorRepetido: number
  /**
   * STATUS ENTREGA = FINALIZADO/Finalizada OU STATUS CARGA = Finalizado: o
   * caminhão já saiu e o upload seguinte de saldos já desconta — contar de
   * novo dobraria a falta. Fica fora, contado (pedido do Arion, 12/09/2026;
   * STATUS CARGA incluído em 15/09/2026).
   */
  finalizados: number
}

/**
 * Converte o relatório de pedidos agendados. Colunas pelo NOME do
 * cabeçalho (normalizado: caixa/acento não importam) — a letra varia entre
 * exports, o nome não. A DATA AGENDADA vem como Date COM HORA: o
 * read-excel-file monta a Date em UTC a partir do serial do Excel, então o
 * dia certo sai dos componentes UTC (`dia()`), nunca de `getDate()` local.
 *
 * Toda linha com quantidade agendada entra — inclusive "Aguardando
 * Estoque", que é exatamente a demanda que precisa de estoque. Sem
 * quantidade não vira agendamento; sem data entra marcada.
 */
export function converterAgendados(rows: Linha[]): {
  linhas: AgendamentoConvertido[]
  resumo: ResumoAgendados
} {
  const cab = (rows[0] ?? []).map((c) => normaliza(txt(c)))
  const ix = (nome: string) => cab.indexOf(normaliza(nome))
  const iId = ix('IDENTIFICADOR')
  const iPedido = ix('NUMERO')
  const iFilial = ix('FILIAL')
  const iTipo = ix('TIPO VENDA')
  const iCliente = ix('CLIENTE')
  const iCidade = ix('CIDADE')
  const iEstado = ix('ESTADO')
  const iProduto = ix('PRODUTO')
  const iCategoria = ix('CATEGORIA')
  const iTrat = ix('TRATAMENTO')
  const iEmb = ix('EMBALAGEM')
  const iQtdPedido = ix('QTD PEDIDO')
  const iStatusEntrega = ix('STATUS ENTREGA')
  const iCarga = ix('CARGA')
  const iStatusCarga = ix('STATUS CARGA')
  const iData = ix('DATA AGENDADA')
  const iQtd = ix('QTD AGENDADA')
  const iObs = ix('OBSERVACAO')

  if (iId < 0 || iProduto < 0 || iQtd < 0 || iData < 0) {
    throw new Error(
      'A planilha não parece o relatório de pedidos agendados: faltam as colunas IDENTIFICADOR, PRODUTO, QTD AGENDADA ou DATA AGENDADA.',
    )
  }

  const linhas: AgendamentoConvertido[] = []
  const resumo: ResumoAgendados = {
    totalLinhas: Math.max(0, rows.length - 1),
    aproveitadas: 0,
    semQuantidade: 0,
    semData: 0,
    embalagemDesconhecida: {},
    porTipoVenda: {},
    porStatusEntrega: {},
    porStatusCarga: {},
    bagsCooperado: 0,
    bagsOutras: 0,
    identificadorRepetido: 0,
    finalizados: 0,
  }
  const vistos = new Set<string>()
  const opcional = (i: number, r: Linha) => (i >= 0 ? txt(r[i]) || null : null)

  for (const r of rows.slice(1)) {
    const bags = num(r[iQtd])
    if (bags <= 0) {
      resumo.semQuantidade++
      continue
    }
    // antes de qualquer contador: finalizado não é demanda, é caminhão que já
    // saiu. Vale pelo STATUS ENTREGA e pelo STATUS CARGA — a carga fica
    // "Finalizado" com a entrega ainda "Aprovado" (182 linhas, 3.759 bags, na
    // carga de 15/09/2026; achado do Arion)
    const statusEntrega = txt(r[iStatusEntrega]) || 'Sem status'
    const statusCargaCru = normaliza(opcional(iStatusCarga, r) ?? '')
    if (normaliza(statusEntrega).startsWith('FINALIZAD') || statusCargaCru.startsWith('FINALIZAD')) {
      resumo.finalizados++
      continue
    }
    const embCru = normaliza(txt(r[iEmb]))
    const emb = EMBALAGEM_DEPARA[embCru]?.codigo ?? embCru
    if (embCru && !EMBALAGEM_DEPARA[embCru]) {
      resumo.embalagemDesconhecida[embCru] = (resumo.embalagemDesconhecida[embCru] ?? 0) + bags
    }
    const data = dia(r[iData])
    if (!data) resumo.semData++

    const tipoVenda = txt(r[iTipo])
    const cooperado = normaliza(tipoVenda).includes('COOPERADO')
    resumo.porTipoVenda[tipoVenda || '(vazio)'] = (resumo.porTipoVenda[tipoVenda || '(vazio)'] ?? 0) + 1
    if (cooperado) resumo.bagsCooperado += bags
    else resumo.bagsOutras += bags

    resumo.porStatusEntrega[statusEntrega] = (resumo.porStatusEntrega[statusEntrega] ?? 0) + 1
    const statusCarga = opcional(iStatusCarga, r)
    if (statusCarga) resumo.porStatusCarga[statusCarga] = (resumo.porStatusCarga[statusCarga] ?? 0) + 1

    const identificador = txt(r[iId])
    if (vistos.has(identificador)) resumo.identificadorRepetido++
    vistos.add(identificador)

    linhas.push({
      identificador,
      pedido: txt(r[iPedido]),
      filial: iFilial >= 0 ? normalizaFilial(r[iFilial]) : null,
      tipoVenda,
      cooperado,
      cliente: txt(r[iCliente]),
      cidade: opcional(iCidade, r),
      estado: opcional(iEstado, r),
      cultivar: normalizaCultivar(txt(r[iProduto])),
      categoria: opcional(iCategoria, r),
      tratamento: normalizaTratamento(txt(r[iTrat])) || SEM_TSI,
      embalagem: emb,
      qtdPedido: num(r[iQtdPedido]),
      bags,
      statusEntrega,
      carga: opcional(iCarga, r),
      statusCarga,
      data,
      observacao: opcional(iObs, r),
    })
    resumo.aproveitadas++
  }

  return { linhas, resumo }
}

// ================================================================
// Saldo dinâmico: o estoque atende o que está agendado até a data?
// ================================================================

export const SEM_TSI = 'SEM TSI'

/** Um carregamento como a tela o vê (do banco ou recém-convertido). */
export interface CarregamentoLinha {
  cultivar: string
  tratamento: string
  embalagem: string
  bags: number
  data: string | null
}

/** Lote de semente branca disponível (status Em estoque). */
export interface LoteDisponivel {
  cultivar: string
  bags: number
}

/** Estoque de produto acabado (tratado), por combinação. */
export interface EstoqueTratado {
  cultivar: string
  tratamento: string
  embalagem: string
  bags: number
}

/** Ordem aberta que ainda vai produzir, com o dia programado. */
export interface ProducaoPrevista {
  cultivar: string
  tratamento: string
  embalagem: string
  bags: number
  dataProg: string | null
  /**
   * A produção já tocou a ordem (iniciada, parada ou finalizada): o material
   * está saindo ou já saiu da máquina, garantido para qualquer caminhão.
   * Sem isto, uma ordem ADIANTADA e concluída — data programada no futuro,
   * status Finalizada — dispararia "adiante a produção" para bags que já
   * estão no galpão: o caso feliz da regra virando alarme falso.
   */
  iniciada?: boolean
  /** Só para a tela mostrar QUAL ordem cobre a linha (19/09/2026): nº e status efetivo. */
  numero?: string
  status?: string
}

/**
 * Duas casas, como o banco (numeric 12,2): 0.30+0.60 tem que empatar com
 * 0.90. O `+ 0` desfaz o −0 que o Math.round devolve para negativos ínfimos.
 */
const arred2 = (x: number) => Math.round(x * 100) / 100 + 0

/**
 * Um caminhão/agendamento dentro da fila do produto (12/09/2026): quanto
 * dele o estoque + produção garantida até a SUA data cobre, descontados os
 * caminhões que vêm antes. É a base da visão por tipo de venda — a fila é
 * uma só, cada bag de estoque é dado a um caminhão só.
 */
export interface AlocacaoCaminhao<T> {
  caminhao: T
  data: string | null
  bags: number
  coberto: number
  /**
   * A parte do coberto que JÁ EXISTE no galpão: só o estoque físico,
   * repartido na ordem da fila (19/09/2026). O resto do coberto depende de
   * ordem que ainda não rodou — e é exatamente isso que precisa ir para a
   * máquina. Sem separar os dois, um produto "coberto" pela produção
   * programada some da lista de prioridade.
   */
  cobertoEstoque: number
  descoberto: number
}

/** Uma ordem aberta da combinação, como o saldo a guarda — com nº e status para a tela. */
export interface OrdemPrevista {
  bags: number
  dataProg: string | null
  iniciada: boolean
  numero: string | null
  status: string | null
}

export interface SaldoExpedicao<T extends CarregamentoLinha = CarregamentoLinha> {
  cultivar: string
  tratamento: string
  /** SEM TSI agrega o cultivar inteiro: aqui vão as embalagens agendadas. */
  embalagem: string
  agendado: number
  /** Lotes (SEM TSI) ou estoque PA (tratado). */
  estoque: number
  /** Só para tratado: TODAS as ordens abertas da combinação. */
  producaoPrevista: number
  /**
   * O pior buraco da linha do tempo: quantos bags faltam, no caminhão mais
   * crítico, se NADA for adiantado — contando como garantido só o estoque,
   * as ordens já iniciadas e as programadas até a data de cada caminhão.
   * Zero = todo caminhão sai cheio sem mexer em nada. Positivo com saldo
   * total ≥ 0 = dá para atender, mas só adiantando pelo menos isso.
   */
  deficitPrazo: number
  /** estoque + produção − agendado. Negativo = falta mesmo adiantando. */
  saldo: number
  semTsi: boolean
  /**
   * A fila em ordem de data com a cobertura de cada caminhão. Σ descoberto
   * ≥ deficitPrazo — igual quando o buraco não encolhe entre caminhões
   * (produção toda depois deles, ou um caminhão só); maior quando uma ordem
   * cai entre dois caminhões e só o `deficitPrazo` (mínimo a adiantar)
   * resolveria os dois. SEM TSI: Σ descoberto = max(0, −saldo).
   */
  caminhoes: AlocacaoCaminhao<T>[]
  /**
   * As ordens abertas desta combinação (19/09/2026) — já eram calculadas
   * para a linha do tempo e se perdiam. Servem para o recorte por carga
   * dizer "já tem ordem para isso, programada para tal dia", em vez de
   * mandar abrir ordem duplicada. Vazio em SEM TSI: semente branca não
   * passa pela máquina.
   */
  producao: OrdemPrevista[]
}

/**
 * A fila do produto, caminhão a caminhão: `garantida` = estoque + o que a
 * produção garante até a data daquele caminhão; o que sobra dela depois dos
 * anteriores cobre este. `pior` é o maior buraco (base do deficitPrazo).
 * Caminhão sem data entra primeiro e só vê estoque + ordens já iniciadas.
 */
function alocarFila<T extends CarregamentoLinha>(
  fila: T[],
  estoque: number,
  garantidaAte: (dia: string | null) => number,
  desempate: (c: T) => string = () => '',
): { pior: number; caminhoes: AlocacaoCaminhao<T>[] } {
  /**
   * Desempate na MESMA data (19/09/2026): sem ele, quem leva o estoque é a
   * ordem em que o Postgres devolveu as linhas — invisível enquanto tudo
   * era somado por produto, mas veredito na tela quando se olha uma carga
   * só, e capaz de trocar de dono a cada reimportação. O padrão vazio
   * preserva o comportamento de quem não passa nada.
   */
  const ordenada = [...fila].sort(
    (a, b) => (a.data ?? '').localeCompare(b.data ?? '') || desempate(a).localeCompare(desempate(b)),
  )
  const caminhoes: AlocacaoCaminhao<T>[] = []
  let demanda = 0
  let pior = 0
  for (const c of ordenada) {
    const garantida = estoque + garantidaAte(c.data)
    const coberto = arred2(Math.min(c.bags, Math.max(0, garantida - demanda)))
    const cobertoEstoque = arred2(Math.min(c.bags, Math.max(0, estoque - demanda)))
    demanda += c.bags
    pior = Math.max(pior, demanda - garantida)
    caminhoes.push({
      caminhao: c, data: c.data, bags: c.bags, coberto, cobertoEstoque,
      descoberto: arred2(c.bags - coberto),
    })
  }
  return { pior, caminhoes }
}

/**
 * O saldo por combinação, considerando só os carregamentos já filtrados
 * pela tela (período e status são decisão de quem olha).
 *
 * - `SEM TSI` cruza com os LOTES por cultivar — a semente sai branca, e o
 *   lote não tem coluna de embalagem. Por isso o cultivar vira UMA linha,
 *   somando todas as embalagens agendadas: duas linhas contariam o mesmo
 *   pool de lotes duas vezes e cada uma diria "atende" com o total faltando.
 * - Tratado cruza com o estoque PA mais TODA a produção aberta: a data
 *   programada não corta a conta, porque produção se adianta (decisão do
 *   PCP, 07/08/2026). O aviso vem da LINHA DO TEMPO: caminhão a caminhão,
 *   em ordem de data, a demanda acumulada é comparada com o que está
 *   garantido até aquele dia — estoque, ordens já iniciadas e ordens
 *   programadas até a data (promessa vencida, `dataProg < hoje` sem
 *   iniciar, não garante nada). O pior buraco vira `deficitPrazo`.
 *
 * Caminhão sem data entra primeiro na fila: prazo desconhecido se trata
 * como "para já", nunca como "para nunca".
 */
export function saldosExpedicao<T extends CarregamentoLinha>(
  carregamentos: T[],
  lotes: LoteDisponivel[],
  estoquePa: EstoqueTratado[],
  producao: ProducaoPrevista[],
  hoje?: string | null,
  /** Chave de desempate entre caminhões da MESMA data — ver alocarFila. */
  desempate?: (c: T) => string,
): SaldoExpedicao<T>[] {
  // SEM TSI agrega por cultivar (o estoque é um pool só); tratado, pela tripla
  const chave = (c: { cultivar: string; tratamento: string; embalagem: string }) =>
    c.tratamento === SEM_TSI ? `${c.cultivar}|${SEM_TSI}` : `${c.cultivar}|${c.tratamento}|${c.embalagem}`

  const linhas = new Map<string, SaldoExpedicao<T>>()
  const embalagens = new Map<string, Set<string>>()
  const fila = new Map<string, T[]>()
  for (const c of carregamentos) {
    const k = chave(c)
    const atual =
      linhas.get(k) ??
      ({
        cultivar: c.cultivar,
        tratamento: c.tratamento,
        embalagem: c.embalagem,
        agendado: 0,
        estoque: 0,
        producaoPrevista: 0,
        deficitPrazo: 0,
        saldo: 0,
        semTsi: c.tratamento === SEM_TSI,
        caminhoes: [],
        producao: [],
      } satisfies SaldoExpedicao<T>)
    atual.agendado += c.bags
    linhas.set(k, atual)
    embalagens.set(k, (embalagens.get(k) ?? new Set()).add(c.embalagem))
    fila.set(k, [...(fila.get(k) ?? []), c])
  }

  // lotes somados por cultivar uma vez só — não por linha de saldo
  const lotesPorCultivar = new Map<string, number>()
  for (const l of lotes) {
    const c = normalizaCultivar(l.cultivar)
    lotesPorCultivar.set(c, (lotesPorCultivar.get(c) ?? 0) + l.bags)
  }

  for (const [k, s] of linhas.entries()) {
    s.embalagem = [...(embalagens.get(k) ?? [])].sort().join(' + ')

    if (s.semTsi) {
      s.estoque = lotesPorCultivar.get(s.cultivar) ?? 0
      // branca não passa pela produção: a fila só vê o estoque (deficitPrazo
      // continua 0 — `saldo` já diz a falta), mas cada caminhão ganha a sua
      // cobertura pra visão por tipo de venda
      s.caminhoes = alocarFila(fila.get(k) ?? [], s.estoque, () => 0, desempate).caminhoes
    } else {
      // tratamento normalizado nos dois lados: `FTZ60+VIC` na receita e
      // `FTZ60 + VIC` no relatório são o mesmo produto (12/09/2026)
      const trat = normalizaTratamento(s.tratamento)
      s.estoque = estoquePa
        .filter(
          (e) =>
            normalizaCultivar(e.cultivar) === s.cultivar &&
            normalizaTratamento(e.tratamento) === trat &&
            e.embalagem === s.embalagem,
        )
        .reduce((a, e) => a + e.bags, 0)

      const daCombinacao = producao.filter(
        (p) =>
          normalizaCultivar(p.cultivar) === s.cultivar &&
          normalizaTratamento(p.tratamento) === trat &&
          p.embalagem === s.embalagem,
      )
      s.producaoPrevista = daCombinacao.reduce((a, p) => a + p.bags, 0)

      /**
       * A linha do tempo. Um prazo único (o último caminhão) deixaria os
       * anteriores sem proteção: caminhões em 08 e 12/08 com a produção
       * toda em 11/08 mostrariam verde — e o de 08/08 voltaria vazio.
       */
      const garantidaAte = (dia: string | null) =>
        daCombinacao
          .filter(
            (p) =>
              p.iniciada ||
              (p.dataProg != null &&
                (hoje == null || p.dataProg >= hoje) &&
                (dia == null ? false : p.dataProg <= dia)),
          )
          .reduce((a, p) => a + p.bags, 0)

      const { pior, caminhoes } = alocarFila(fila.get(k) ?? [], s.estoque, garantidaAte, desempate)
      s.deficitPrazo = arred2(Math.max(0, pior))
      s.caminhoes = caminhoes
      s.producao = daCombinacao.map((p) => ({
        bags: p.bags,
        dataProg: p.dataProg,
        iniciada: p.iniciada === true,
        numero: p.numero ?? null,
        status: p.status ?? null,
      }))
    }
    s.saldo = arred2(s.estoque + s.producaoPrevista - s.agendado)
    s.agendado = arred2(s.agendado)
    s.estoque = arred2(s.estoque)
    s.producaoPrevista = arred2(s.producaoPrevista)
  }

  // faltas primeiro: é a linha que muda a semana de alguém
  return [...linhas.values()].sort((a, b) => a.saldo - b.saldo)
}

export type SituacaoSaldo = 'falta' | 'adiantar' | 'aguardando-producao' | 'atende'

/**
 * O rótulo da linha. **"Atende" é reservado a estoque físico**: combinação
 * coberta só por produção futura fica em "aguardando produção" mesmo com
 * tudo no prazo — bag programado não é bag no galpão, e a tela dizia
 * "atende" para material que ainda nem existia (pedido do PCP, 07/08/2026).
 */
export function situacaoSaldo(s: SaldoExpedicao<CarregamentoLinha>): SituacaoSaldo {
  if (s.saldo < 0) return 'falta'
  if (s.deficitPrazo > 0) return 'adiantar'
  if (!s.semTsi && s.estoque < s.agendado) return 'aguardando-producao'
  return 'atende'
}

/** Ordem que já saiu da máquina: os bags existem, só não estão no saldo do SAP ainda. */
export const STATUS_PRODUZIDO: readonly string[] = ['Finalizada', 'Qualidade apontada']

/**
 * Bags das ordens da linha que JÁ FORAM PRODUZIDAS e ainda não viraram
 * estoque no SAP (19/09/2026). Caso real: a 148734 (O790 IPRO · FTZ ELITE)
 * estava com qualidade apontada, 19 bags no galpão, e a tela dizia
 * "aguardando produção — 2 bg a produzir" porque o saldo do SAP ainda não
 * a enxergava. O rótulo certo é "produzido, falta apontar".
 */
export function bagsProduzidosSemApontar(s: SaldoExpedicao<CarregamentoLinha>): number {
  return arred2(
    s.producao
      .filter((p) => p.status != null && STATUS_PRODUZIDO.includes(p.status))
      .reduce((t, p) => t + p.bags, 0),
  )
}

// ================================================================
// Falta por produto E data (16/09/2026)
// ================================================================

export interface FaltaNaData {
  /** null = agendamento sem data (entra primeiro, como na fila). */
  data: string | null
  caminhoes: number
  agendado: number
  descoberto: number
}

export interface FaltaPorProduto {
  cultivar: string
  tratamento: string
  embalagem: string
  semTsi: boolean
  /** Situação da linha consolidada — mantém a cor da tabela de saldo. */
  situacao: SituacaoSaldo
  /** Σ descoberto do produto no período. */
  descoberto: number
  /**
   * Σ agendado do produto no recorte, TODAS as datas (19/09/2026). A grade
   * mostrava só o descoberto e o Arion leu "6 e 23" como o pedido do dia,
   * quando o pedido era 24 e 58 — agora cada célula diz "faltam X de Y".
   */
  agendado: number
  /** Só as datas em que falta (descoberto > 0), em ordem. */
  datas: FaltaNaData[]
}

/**
 * O item primeiro, e para cada item as DATAS em que vai faltar (pedido do
 * Arion, 16/09/2026: "quero ver o item e depois a data em que irá faltar,
 * dentro do range escolhido"). É a mesma fila caminhão a caminhão de
 * `saldosExpedicao`, agregada por produto × dia: nenhum bag contado duas
 * vezes — a soma das datas é o descoberto da linha consolidada. Só entram
 * produtos com falta em alguma data; do maior descoberto para o menor.
 */
export function faltaPorProduto<T extends CarregamentoLinha>(
  saldos: SaldoExpedicao<T>[],
  incluir?: (c: T) => boolean,
): FaltaPorProduto[] {
  const out: FaltaPorProduto[] = []
  for (const s of saldos) {
    const porData = new Map<string, FaltaNaData>()
    let agendado = 0
    for (const c of s.caminhoes) {
      // recorte por carga (19/09/2026): a fila já decidiu a cobertura lá em
      // cima, com TODOS os caminhões do período. Aqui só se escolhe quais
      // entram na soma — o estoque segue reservado para quem vem antes.
      if (incluir && !incluir(c.caminhao)) continue
      const k = c.data ?? ''
      const d = porData.get(k) ?? { data: c.data, caminhoes: 0, agendado: 0, descoberto: 0 }
      d.caminhoes++
      d.agendado += c.bags
      agendado += c.bags
      d.descoberto += c.descoberto
      porData.set(k, d)
    }
    const datas = [...porData.values()]
      .map((d) => ({ ...d, agendado: arred2(d.agendado), descoberto: arred2(d.descoberto) }))
      .filter((d) => d.descoberto > 0)
      .sort((a, b) => (a.data ?? '').localeCompare(b.data ?? ''))
    const descoberto = arred2(datas.reduce((t, d) => t + d.descoberto, 0))
    if (descoberto <= 0) continue
    out.push({
      cultivar: s.cultivar, tratamento: s.tratamento, embalagem: s.embalagem, semTsi: s.semTsi,
      situacao: situacaoSaldo(s), descoberto, agendado: arred2(agendado), datas,
    })
  }
  return out.sort((a, b) => b.descoberto - a.descoberto)
}

/** Como a grade "Quando vai faltar" é ordenada (19/09/2026). */
export type CriterioFalta = 'falta' | 'cultivar' | 'tratamento'

const porNome = (a: string, b: string) => a.localeCompare(b, 'pt-BR', { numeric: true })

/**
 * Ordena a saída de `faltaPorProduto` sem mudar a conta (19/09/2026, pedido
 * do Arion: "coloque uma forma de classificar por tratamento, cultivar").
 * 'falta' é o padrão de sempre (maior descoberto primeiro); 'cultivar' e
 * 'tratamento' põem junto o que a máquina faz junto. Comparação numérica
 * ("NEO680" antes de "NEO1000", "SC10" antes de "SC20") e empate sempre
 * resolvido pelas outras chaves — a mesma entrada dá sempre a mesma ordem.
 * Devolve lista nova; a recebida não muda.
 */
export function ordenarFaltaPorProduto(lista: FaltaPorProduto[], criterio: CriterioFalta): FaltaPorProduto[] {
  type Cmp = (a: FaltaPorProduto, b: FaltaPorProduto) => number
  const cultivar: Cmp = (a, b) => porNome(a.cultivar, b.cultivar)
  const tratamento: Cmp = (a, b) => porNome(a.tratamento, b.tratamento)
  const embalagem: Cmp = (a, b) => porNome(a.embalagem, b.embalagem)
  const falta: Cmp = (a, b) => b.descoberto - a.descoberto
  const chaves: Cmp[] =
    criterio === 'cultivar'
      ? [cultivar, tratamento, embalagem]
      : criterio === 'tratamento'
        ? [tratamento, cultivar, embalagem]
        : [falta, cultivar, tratamento, embalagem]
  return [...lista].sort((a, b) => {
    for (const c of chaves) {
      const r = c(a, b)
      if (r !== 0) return r
    }
    return 0
  })
}

// ================================================================
// Por tipo de venda: VENDA COOPERADO × OUTRAS (12/09/2026)
// ================================================================

export interface LadoTipoVenda {
  agendado: number
  coberto: number
  descoberto: number
  /** Quantos agendamentos (caminhões) do grupo. */
  caminhoes: number
  /** Produtos em que ESTE grupo ficou descoberto, do pior pro menor. */
  produtosEmFalta: { cultivar: string; tratamento: string; embalagem: string; descoberto: number }[]
  /**
   * TODOS os produtos agendados neste grupo (19/09/2026, pedido do Arion: "o
   * card por tipo de venda mostra a quantidade do cooperado ou multiplicador,
   * mas não quais são os produtos"): agendado, coberto e descoberto de cada
   * um só nos caminhões do grupo. Em falta primeiro, depois os maiores.
   */
  produtos: ProdutoDoLado[]
}

export interface ProdutoDoLado {
  cultivar: string
  tratamento: string
  embalagem: string
  agendado: number
  coberto: number
  descoberto: number
  /** Quantos caminhões do grupo levam este produto. */
  caminhoes: number
}

/**
 * A visão consolidada manda; os lados só detalham (decisão do Arion,
 * 12/09/2026): a fila única de cada produto já decidiu, caminhão a
 * caminhão, o que é coberto — aqui só se soma por grupo. Nenhum bag de
 * estoque é contado duas vezes, e cooperado no fim da fila absorve o
 * descoberto exatamente como a data manda.
 */
export function resumoPorTipoVenda<T extends CarregamentoLinha>(
  saldos: SaldoExpedicao<T>[],
  ehCooperado: (c: T) => boolean,
): { cooperado: LadoTipoVenda; outras: LadoTipoVenda } {
  return {
    cooperado: resumoDoGrupo(saldos, (c) => ehCooperado(c)),
    outras: resumoDoGrupo(saldos, (c) => !ehCooperado(c)),
  }
}

/**
 * Um recorte qualquer da fila já decidida: soma agendado, coberto e
 * descoberto dos caminhões que o predicado aceita, e lista os produtos em
 * que ESSE recorte ficou descoberto.
 *
 * É o motor do "por tipo de venda" e, desde 19/09/2026, do filtro por CARGA
 * da tela (pedido do Arion: "selecionar as cargas e ver a demanda daquelas
 * cargas apenas"). A propriedade que faz isso não mentir: a alocação vem de
 * cima, de uma fila só com TODOS os caminhões do período — recortar aqui
 * nunca devolve ao recorte o estoque que os caminhões de fora já levaram.
 * Somar todos os recortes de uma partição dá exatamente a linha consolidada.
 */
export function resumoDoGrupo<T extends CarregamentoLinha>(
  saldos: SaldoExpedicao<T>[],
  incluir: (c: T) => boolean,
): LadoTipoVenda {
  const r: LadoTipoVenda = { agendado: 0, coberto: 0, descoberto: 0, caminhoes: 0, produtosEmFalta: [], produtos: [] }
  for (const s of saldos) {
    const p: ProdutoDoLado = {
      cultivar: s.cultivar, tratamento: s.tratamento, embalagem: s.embalagem,
      agendado: 0, coberto: 0, descoberto: 0, caminhoes: 0,
    }
    for (const c of s.caminhoes) {
      if (!incluir(c.caminhao)) continue
      p.agendado += c.bags
      p.coberto += c.coberto
      p.descoberto += c.descoberto
      p.caminhoes++
    }
    if (p.caminhoes === 0) continue
    p.agendado = arred2(p.agendado)
    p.coberto = arred2(p.coberto)
    p.descoberto = arred2(p.descoberto)
    r.agendado += p.agendado
    r.coberto += p.coberto
    r.descoberto += p.descoberto
    r.caminhoes += p.caminhoes
    r.produtos.push(p)
    if (p.descoberto > 0) {
      r.produtosEmFalta.push({
        cultivar: p.cultivar, tratamento: p.tratamento, embalagem: p.embalagem, descoberto: p.descoberto,
      })
    }
  }
  r.agendado = arred2(r.agendado)
  r.coberto = arred2(r.coberto)
  r.descoberto = arred2(r.descoberto)
  r.produtosEmFalta.sort((a, b) => b.descoberto - a.descoberto)
  // em falta primeiro (a maior falta no topo), depois os maiores agendados
  r.produtos.sort(
    (a, b) => b.descoberto - a.descoberto || b.agendado - a.agendado || a.cultivar.localeCompare(b.cultivar),
  )
  return r
}

/** O agendado de UM produto repartido por grupo — colunas COOPERADO / OUTRAS da tabela consolidada. */
export function agendadoPorTipo<T extends CarregamentoLinha>(
  s: SaldoExpedicao<T>,
  ehCooperado: (c: T) => boolean,
): { cooperado: number; outras: number } {
  let cooperado = 0
  let outras = 0
  for (const c of s.caminhoes) {
    if (ehCooperado(c.caminhao)) cooperado += c.bags
    else outras += c.bags
  }
  return { cooperado: arred2(cooperado), outras: arred2(outras) }
}

// ================================================================
// Recorte por CARGA (19/09/2026)
// ================================================================

/**
 * Pedido do Arion: "selecionar as cargas e ver a demanda daquelas cargas
 * apenas, para dar prioridade nos materiais não produzidos".
 *
 * A regra que mantém isso honesto: a fila NÃO é recalculada. A alocação
 * vem de saldosExpedicao, com TODOS os caminhões do período disputando o
 * estoque em ordem de data — recortar aqui nunca devolve à seleção o que
 * os caminhões de fora já levaram. É a mesma mecânica do "por tipo de
 * venda" (12/09/2026), com outro predicado.
 */

/** O mínimo que uma linha agendada precisa ter para virar item do seletor. */
export interface LinhaComCarga {
  carga: string | null
  data: string | null
  bags: number
  cliente?: string | null
  statusCarga?: string | null
}

export interface CargaAgendada {
  carga: string
  /** Uma carga pode cruzar dias; todas as datas, em ordem. */
  datas: string[]
  /** Distintos, na ordem em que apareceram — 29 das 32 cargas atendem mais de um cliente. */
  clientes: string[]
  /** Distintos: nada garante um status só por carga, e escolher um calado esconderia divergência. */
  status: string[]
  linhas: number
  bags: number
}

/**
 * Agrupa os agendamentos pelas cargas montadas, para o seletor da tela.
 * Linha sem carga fica de fora da LISTA (o caminhão dela ainda não existe),
 * mas segue na fila consumindo estoque — é 82% dos bags hoje, e a tela
 * precisa dizer isso em algum lugar.
 *
 * Ordena por data e, no empate, pelo número da carga, que chega como texto
 * (localeCompare numérico: "9" antes de "10").
 */
export function cargasAgendadas<T extends LinhaComCarga>(linhas: T[]): CargaAgendada[] {
  const por = new Map<string, CargaAgendada>()
  for (const l of linhas) {
    const carga = (l.carga ?? '').trim()
    if (!carga) continue
    const atual = por.get(carga) ?? { carga, datas: [], clientes: [], status: [], linhas: 0, bags: 0 }
    atual.linhas++
    atual.bags += l.bags
    if (l.data != null && !atual.datas.includes(l.data)) atual.datas.push(l.data)
    const cli = (l.cliente ?? '').trim()
    if (cli && !atual.clientes.includes(cli)) atual.clientes.push(cli)
    const st = (l.statusCarga ?? '').trim()
    if (st && !atual.status.includes(st)) atual.status.push(st)
    por.set(carga, atual)
  }
  for (const c of por.values()) {
    c.datas.sort()
    c.bags = arred2(c.bags)
  }
  return [...por.values()].sort(
    (a, b) =>
      (a.datas[0] ?? '').localeCompare(b.datas[0] ?? '') ||
      a.carga.localeCompare(b.carga, 'pt-BR', { numeric: true }),
  )
}

export interface ItemRecorte {
  cultivar: string
  tratamento: string
  embalagem: string
  semTsi: boolean
  /** Bags que ESTAS cargas pedem deste produto. */
  agendado: number
  /** Do agendado, o que já existe no galpão — estoque físico, na ordem da fila. */
  temHoje: number
  /** agendado − temHoje: o que a máquina ainda tem que entregar. É a coluna que decide. */
  aProduzir: number
  /** Ordens abertas do produto que ainda podem cobrir isso (do produto inteiro, não da seleção). */
  programado: number
  /** Menor dia programado entre essas ordens; null quando nenhuma tem dia. */
  programadoAte: string | null
  /** Alguma ordem do produto já está rodando. */
  rodando: boolean
  /** max(0, aProduzir − programado): o que não tem nem ordem aberta. */
  semOrdem: number
  /** A fila diz que nem com o programado dá tempo para estes caminhões. */
  descoberto: number
  /** O caminhão mais próximo desta seleção que pede o produto. */
  precisaAte: string | null
  /** Cargas da seleção que pedem este produto. */
  cargas: string[]
  /** Situação do PRODUTO inteiro (todas as cargas) — a tela rotula como tal. */
  situacao: SituacaoSaldo
  /** As ordens abertas do produto, com nº e status, para a coluna "Já programado". */
  ordens: OrdemPrevista[]
  /**
   * O que a fila entregou ANTES do primeiro caminhão desta seleção, para a
   * tela poder responder "para onde foi o estoque". Aproximação explicativa
   * quando a seleção se espalha por várias datas — nunca entra em conta.
   */
  antes: { outrasCargas: number; semCarga: number }
}

export interface Recorte {
  produtos: ItemRecorte[]
  agendado: number
  temHoje: number
  aProduzir: number
  descoberto: number
  /** Quantos agendamentos entraram no recorte. */
  linhas: number
}

/**
 * A lista que vai para a produção: por produto, o que estas cargas pedem,
 * o que já existe e o que falta fazer. Ordena pelo que não tem nem ordem
 * aberta, depois pelo caminhão mais próximo.
 */
export function recorteDaSelecao<T extends CarregamentoLinha>(
  saldos: SaldoExpedicao<T>[],
  incluir: (c: T) => boolean,
  cargaDe: (c: T) => string | null,
): Recorte {
  const produtos: ItemRecorte[] = []
  for (const s of saldos) {
    const meus = s.caminhoes.filter((c) => incluir(c.caminhao))
    if (meus.length === 0) continue

    // o que a fila serviu antes do primeiro caminhão desta seleção
    const primeiro = s.caminhoes.findIndex((c) => incluir(c.caminhao))
    const antes = { outrasCargas: 0, semCarga: 0 }
    for (const c of s.caminhoes.slice(0, primeiro)) {
      const temCarga = (cargaDe(c.caminhao) ?? '').trim() !== ''
      antes[temCarga ? 'outrasCargas' : 'semCarga'] += c.bags
    }

    const agendado = arred2(meus.reduce((t, c) => t + c.bags, 0))
    const temHoje = arred2(meus.reduce((t, c) => t + c.cobertoEstoque, 0))
    const aProduzir = arred2(Math.max(0, agendado - temHoje))
    const programado = arred2(s.producao.reduce((t, p) => t + p.bags, 0))
    const dias = s.producao.map((p) => p.dataProg).filter((d): d is string => d != null).sort()
    const cargas: string[] = []
    for (const c of meus) {
      const k = (cargaDe(c.caminhao) ?? '').trim()
      if (k && !cargas.includes(k)) cargas.push(k)
    }
    produtos.push({
      cultivar: s.cultivar,
      tratamento: s.tratamento,
      embalagem: s.embalagem,
      semTsi: s.semTsi,
      agendado,
      temHoje,
      aProduzir,
      programado,
      programadoAte: dias[0] ?? null,
      rodando: s.producao.some((p) => p.iniciada),
      semOrdem: arred2(Math.max(0, aProduzir - programado)),
      descoberto: arred2(meus.reduce((t, c) => t + c.descoberto, 0)),
      precisaAte: meus.map((c) => c.data).filter((d): d is string => d != null).sort()[0] ?? null,
      cargas: cargas.sort((a, b) => a.localeCompare(b, 'pt-BR', { numeric: true })),
      situacao: situacaoSaldo(s),
      ordens: s.producao,
      antes: { outrasCargas: arred2(antes.outrasCargas), semCarga: arred2(antes.semCarga) },
    })
  }
  produtos.sort(
    (a, b) =>
      b.semOrdem - a.semOrdem ||
      (a.precisaAte ?? '9999').localeCompare(b.precisaAte ?? '9999') ||
      b.aProduzir - a.aProduzir,
  )
  return {
    produtos,
    agendado: arred2(produtos.reduce((t, p) => t + p.agendado, 0)),
    temHoje: arred2(produtos.reduce((t, p) => t + p.temHoje, 0)),
    aProduzir: arred2(produtos.reduce((t, p) => t + p.aProduzir, 0)),
    descoberto: arred2(produtos.reduce((t, p) => t + p.descoberto, 0)),
    linhas: saldos.reduce((t, s) => t + s.caminhoes.filter((c) => incluir(c.caminhao)).length, 0),
  }
}
