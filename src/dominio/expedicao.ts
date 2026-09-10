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
  EMBALAGEM_DEPARA, normaliza, normalizaCultivar, type Linha,
} from './importacao/simpleagro'

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
   * STATUS ENTREGA = FINALIZADO/Finalizada: o caminhão já saiu e o upload
   * seguinte de saldos já desconta — contar de novo dobraria a falta. Fica
   * fora, contado (pedido do Arion, 12/09/2026).
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
    // antes de qualquer contador: finalizado não é demanda, é caminhão que já saiu
    const statusEntrega = txt(r[iStatusEntrega]) || 'Sem status'
    if (normaliza(statusEntrega).startsWith('FINALIZAD')) {
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
  descoberto: number
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
): { pior: number; caminhoes: AlocacaoCaminhao<T>[] } {
  const ordenada = [...fila].sort((a, b) => (a.data ?? '').localeCompare(b.data ?? ''))
  const caminhoes: AlocacaoCaminhao<T>[] = []
  let demanda = 0
  let pior = 0
  for (const c of ordenada) {
    const garantida = estoque + garantidaAte(c.data)
    const coberto = arred2(Math.min(c.bags, Math.max(0, garantida - demanda)))
    demanda += c.bags
    pior = Math.max(pior, demanda - garantida)
    caminhoes.push({ caminhao: c, data: c.data, bags: c.bags, coberto, descoberto: arred2(c.bags - coberto) })
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
      s.caminhoes = alocarFila(fila.get(k) ?? [], s.estoque, () => 0).caminhoes
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

      const { pior, caminhoes } = alocarFila(fila.get(k) ?? [], s.estoque, garantidaAte)
      s.deficitPrazo = arred2(Math.max(0, pior))
      s.caminhoes = caminhoes
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
  const novo = (): LadoTipoVenda => ({ agendado: 0, coberto: 0, descoberto: 0, caminhoes: 0, produtosEmFalta: [] })
  const r = { cooperado: novo(), outras: novo() }
  for (const s of saldos) {
    const faltaDoLado = { cooperado: 0, outras: 0 }
    for (const c of s.caminhoes) {
      const lado = ehCooperado(c.caminhao) ? 'cooperado' : 'outras'
      r[lado].agendado += c.bags
      r[lado].coberto += c.coberto
      r[lado].descoberto += c.descoberto
      r[lado].caminhoes++
      faltaDoLado[lado] += c.descoberto
    }
    for (const lado of ['cooperado', 'outras'] as const) {
      if (faltaDoLado[lado] > 0) {
        r[lado].produtosEmFalta.push({
          cultivar: s.cultivar, tratamento: s.tratamento, embalagem: s.embalagem,
          descoberto: arred2(faltaDoLado[lado]),
        })
      }
    }
  }
  for (const lado of [r.cooperado, r.outras]) {
    lado.agendado = arred2(lado.agendado)
    lado.coberto = arred2(lado.coberto)
    lado.descoberto = arred2(lado.descoberto)
    lado.produtosEmFalta.sort((a, b) => b.descoberto - a.descoberto)
  }
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
