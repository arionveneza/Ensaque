/**
 * Expedição: carregamentos agendados × o que existe para carregar.
 *
 * A planilha "montagem de carga" da SimpleAgro traz os caminhões agendados —
 * cliente, produto, quantidade e data. A pergunta que ela não responde
 * sozinha é a que importa: **o estoque atende o que está agendado?**
 *
 * O cruzamento tem uma sutileza de negócio: carregamento `SEM TSI` é semente
 * branca, que sai do estoque de LOTES; carregamento com tratamento real sai
 * do estoque de PRODUTO ACABADO, e pode ainda contar com a produção
 * programada até a data. São dois estoques diferentes — somar tudo num
 * número só esconderia exatamente a falta que se quer enxergar.
 */

import { EMBALAGEM_DEPARA, normalizaCultivar, type Linha } from './importacao/simpleagro'

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

export interface SaldoExpedicao {
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
export function saldosExpedicao(
  carregamentos: CarregamentoLinha[],
  lotes: LoteDisponivel[],
  estoquePa: EstoqueTratado[],
  producao: ProducaoPrevista[],
  hoje?: string | null,
): SaldoExpedicao[] {
  // SEM TSI agrega por cultivar (o estoque é um pool só); tratado, pela tripla
  const chave = (c: { cultivar: string; tratamento: string; embalagem: string }) =>
    c.tratamento === SEM_TSI ? `${c.cultivar}|${SEM_TSI}` : `${c.cultivar}|${c.tratamento}|${c.embalagem}`

  const linhas = new Map<string, SaldoExpedicao>()
  const embalagens = new Map<string, Set<string>>()
  const fila = new Map<string, CarregamentoLinha[]>()
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
      } satisfies SaldoExpedicao)
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
    } else {
      s.estoque = estoquePa
        .filter(
          (e) =>
            normalizaCultivar(e.cultivar) === s.cultivar &&
            e.tratamento.toUpperCase() === s.tratamento &&
            e.embalagem === s.embalagem,
        )
        .reduce((a, e) => a + e.bags, 0)

      const daCombinacao = producao.filter(
        (p) =>
          normalizaCultivar(p.cultivar) === s.cultivar &&
          p.tratamento.toUpperCase() === s.tratamento &&
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

      const ordenada = [...(fila.get(k) ?? [])].sort((a, b) =>
        (a.data ?? '').localeCompare(b.data ?? ''),
      )
      let demanda = 0
      let pior = 0
      for (const c of ordenada) {
        demanda += c.bags
        const garantida = c.data == null
          ? garantidaAte(null) // sem data: só estoque e o que já está na máquina
          : garantidaAte(c.data)
        pior = Math.max(pior, demanda - (s.estoque + garantida))
      }
      s.deficitPrazo = arred2(Math.max(0, pior))
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
export function situacaoSaldo(s: SaldoExpedicao): SituacaoSaldo {
  if (s.saldo < 0) return 'falta'
  if (s.deficitPrazo > 0) return 'adiantar'
  if (!s.semTsi && s.estoque < s.agendado) return 'aguardando-producao'
  return 'atende'
}
