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
}

export interface SaldoExpedicao {
  cultivar: string
  tratamento: string
  embalagem: string
  agendado: number
  /** Lotes (SEM TSI) ou estoque PA (tratado). */
  estoque: number
  /** Só para tratado: ordens abertas com dia programado até a data fim. */
  producaoPrevista: number
  /** estoque + produção − agendado. Negativo = falta. */
  saldo: number
  semTsi: boolean
}

/**
 * O saldo por combinação, considerando só os carregamentos já filtrados
 * pela tela (período e status são decisão de quem olha).
 *
 * - `SEM TSI` cruza com os LOTES por cultivar — a semente sai branca, e o
 *   lote não tem coluna de embalagem, então o corte é o cultivar inteiro.
 * - Tratado cruza com o estoque PA e soma a produção programada até
 *   `ateData` (inclusive). Ordem sem dia programado só entra sem filtro de
 *   data: promessa sem prazo não cobre carregamento com prazo.
 */
export function saldosExpedicao(
  carregamentos: CarregamentoLinha[],
  lotes: LoteDisponivel[],
  estoquePa: EstoqueTratado[],
  producao: ProducaoPrevista[],
  ateData?: string | null,
): SaldoExpedicao[] {
  const chave = (c: { cultivar: string; tratamento: string; embalagem: string }) =>
    `${c.cultivar}|${c.tratamento}|${c.embalagem}`

  const agendado = new Map<string, SaldoExpedicao>()
  for (const c of carregamentos) {
    const k = chave(c)
    const atual =
      agendado.get(k) ??
      ({
        cultivar: c.cultivar,
        tratamento: c.tratamento,
        embalagem: c.embalagem,
        agendado: 0,
        estoque: 0,
        producaoPrevista: 0,
        saldo: 0,
        semTsi: c.tratamento === SEM_TSI,
      } satisfies SaldoExpedicao)
    atual.agendado += c.bags
    agendado.set(k, atual)
  }

  // lotes somados por cultivar uma vez só — não por linha de saldo
  const lotesPorCultivar = new Map<string, number>()
  for (const l of lotes) {
    const c = normalizaCultivar(l.cultivar)
    lotesPorCultivar.set(c, (lotesPorCultivar.get(c) ?? 0) + l.bags)
  }

  for (const s of agendado.values()) {
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
      s.producaoPrevista = producao
        .filter(
          (p) =>
            normalizaCultivar(p.cultivar) === s.cultivar &&
            p.tratamento.toUpperCase() === s.tratamento &&
            p.embalagem === s.embalagem &&
            (ateData ? p.dataProg != null && p.dataProg <= ateData : true),
        )
        .reduce((a, p) => a + p.bags, 0)
    }
    s.saldo = s.estoque + s.producaoPrevista - s.agendado
  }

  // faltas primeiro: é a linha que muda a semana de alguém
  return [...agendado.values()].sort((a, b) => a.saldo - b.saldo)
}
