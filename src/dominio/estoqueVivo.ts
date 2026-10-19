import { ARMAZENS_GALPAO, TSI_ENTRADA, TSI_SAIDA, ehArmazemTsi, rotuloEndereco } from './endereco'
import { emCascata, porNome } from './ordenacao'

/**
 * Estoque VIVO do mapa (19/10/2026, pedido do Arion: "preciso que seja
 * possível extrair um relatório de estoque vivo do mapa").
 *
 * É a foto do que o mapa diz que existe AGORA — `lotes_mapa` com saldo, uma
 * linha por combinação lote + tratamento, com o saldo repartido por armazém
 * (A–E, TSI Entrada, TSI Saída) e o que está sem endereço conhecido. Não é o
 * inventário (contagem congelada) nem o SAP: é o mapa como ele está, pra
 * exportar e cruzar com o que quiser. Nada é gravado.
 *
 * A repartição por armazém usa as MESMAS alocações da grade (`alocar` do
 * Mapa: contagem explícita vale, o resto rateia entre os endereços sem
 * contagem) — a planilha bate com o que a tela mostra, posição a posição.
 */

export interface EnderecoAlocado {
  armazem: string
  bloco: string
  quadra: string
  bags: number | null
}

/** O que o relatório precisa de cada combinação (`LoteMapaLinha` serve). */
export interface LoteEstoque {
  lote: string
  tratamento: string
  cultivar: string
  embalagem: string
  pms: number | null
  peso_bag_kg: number
  bags: number
  destinacao: string | null
  classificacao: string | null
  peneira: string | null
  categoria: string | null
  nao_encontrado_inventario_em: string | null
  lote_enderecos: EnderecoAlocado[]
}

/** Uma alocação da grade: a combinação num endereço com os bags rateados. */
export interface AlocacaoEstoque {
  lote: LoteEstoque
  endereco: EnderecoAlocado
  bags: number
  estimado: boolean
}

export interface LinhaEstoqueVivo {
  cultivar: string
  lote: string
  tratamento: string
  embalagem: string
  pms: number | null
  pesoBagKg: number
  /** Saldo da combinação no mapa (bags). */
  saldo: number
  /** saldo × peso do bag. */
  kg: number
  /** Bags em cada armazém do galpão (A–E), já rateados. */
  porArmazem: Record<string, number>
  tsiEntrada: number
  tsiSaida: number
  /** Saldo que nenhum endereço explica (sem endereço, ou endereços somam menos). */
  semEndereco: number
  /** Algum endereço da combinação é rateio/estimativa, não contagem. */
  estimado: boolean
  /** Endereços como a tela mostra: "A 3 Q05: 10 · B 11 Q03: ~5". */
  enderecos: string
  destinacao: string | null
  classificacao: string | null
  peneira: string | null
  categoria: string | null
  /** Marcada como não encontrada no último inventário aplicado (fora da grade). */
  aguardandoContagem: boolean
}

export interface ResumoEstoqueVivo {
  combinacoes: number
  bags: number
  kg: number
  /** Bags por armazém do galpão (A–E), sempre as cinco chaves. */
  porArmazem: Record<string, number>
  tsiEntrada: number
  tsiSaida: number
  semEndereco: number
  /** Bags de semente branca (SEM TSI) e de tratado. */
  branca: number
  tratada: number
  aguardandoContagem: number
}

const SEM_TSI = 'SEM TSI'
const arred2 = (v: number) => Math.round(v * 100) / 100

const chaveDe = (lote: string, tratamento: string) => `${lote}\u0000${tratamento}`

/** Branca primeiro, depois os tratamentos em ordem pt-BR. */
const porTratamento = (a: string, b: string): number =>
  a === b ? 0 : a === SEM_TSI ? -1 : b === SEM_TSI ? 1 : porNome(a, b)

const compararLinhas = emCascata<LinhaEstoqueVivo>(
  (a, b) => porNome(a.cultivar, b.cultivar),
  (a, b) => porTratamento(a.tratamento, b.tratamento),
  (a, b) => porNome(a.lote, b.lote),
)

/** Texto de um endereço com os bags: "A 3 Q05: 10", "~" quando é rateio. */
const textoEndereco = (a: AlocacaoEstoque): string =>
  `${rotuloEndereco(a.endereco)}: ${a.estimado ? '~' : ''}${formataBags(a.bags)}`

const formataBags = (v: number): string => {
  const r = arred2(v)
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace('.', ',')
}

export function estoqueVivo(
  lotes: LoteEstoque[],
  alocacoes: AlocacaoEstoque[],
): { linhas: LinhaEstoqueVivo[]; resumo: ResumoEstoqueVivo } {
  const porChave = new Map<string, AlocacaoEstoque[]>()
  for (const a of alocacoes) {
    const k = chaveDe(a.lote.lote, a.lote.tratamento)
    const lista = porChave.get(k)
    if (lista) lista.push(a)
    else porChave.set(k, [a])
  }

  const linhas: LinhaEstoqueVivo[] = []
  for (const l of lotes) {
    const alocs = porChave.get(chaveDe(l.lote, l.tratamento)) ?? []
    const porArmazem: Record<string, number> = Object.fromEntries(ARMAZENS_GALPAO.map((a) => [a, 0]))
    let tsiEntrada = 0
    let tsiSaida = 0
    let alocado = 0
    let estimado = false
    for (const a of alocs) {
      alocado += a.bags
      if (a.estimado) estimado = true
      const arm = a.endereco.armazem
      if (arm === TSI_ENTRADA) tsiEntrada += a.bags
      else if (arm === TSI_SAIDA) tsiSaida += a.bags
      else if (!ehArmazemTsi(arm)) porArmazem[arm] = (porArmazem[arm] ?? 0) + a.bags
    }
    for (const k of Object.keys(porArmazem)) porArmazem[k] = arred2(porArmazem[k])
    const semEndereco = arred2(Math.max(0, l.bags - alocado))
    linhas.push({
      cultivar: l.cultivar,
      lote: l.lote,
      tratamento: l.tratamento,
      embalagem: l.embalagem,
      pms: l.pms,
      pesoBagKg: l.peso_bag_kg,
      saldo: arred2(l.bags),
      kg: arred2(l.bags * (l.peso_bag_kg || 0)),
      porArmazem,
      tsiEntrada: arred2(tsiEntrada),
      tsiSaida: arred2(tsiSaida),
      semEndereco,
      estimado,
      enderecos: alocs
        .slice()
        .sort((a, b) => porNome(rotuloEndereco(a.endereco), rotuloEndereco(b.endereco)))
        .map(textoEndereco)
        .join(' · '),
      destinacao: l.destinacao,
      classificacao: l.classificacao,
      peneira: l.peneira,
      categoria: l.categoria,
      aguardandoContagem: !!l.nao_encontrado_inventario_em,
    })
  }
  linhas.sort(compararLinhas)

  const resumo: ResumoEstoqueVivo = {
    combinacoes: linhas.length,
    bags: 0,
    kg: 0,
    porArmazem: Object.fromEntries(ARMAZENS_GALPAO.map((a) => [a, 0])),
    tsiEntrada: 0,
    tsiSaida: 0,
    semEndereco: 0,
    branca: 0,
    tratada: 0,
    aguardandoContagem: 0,
  }
  for (const r of linhas) {
    resumo.bags += r.saldo
    resumo.kg += r.kg
    for (const a of ARMAZENS_GALPAO) resumo.porArmazem[a] += r.porArmazem[a] ?? 0
    resumo.tsiEntrada += r.tsiEntrada
    resumo.tsiSaida += r.tsiSaida
    resumo.semEndereco += r.semEndereco
    if (r.tratamento === SEM_TSI) resumo.branca += r.saldo
    else resumo.tratada += r.saldo
    if (r.aguardandoContagem) resumo.aguardandoContagem += 1
  }
  resumo.bags = arred2(resumo.bags)
  resumo.kg = arred2(resumo.kg)
  for (const a of ARMAZENS_GALPAO) resumo.porArmazem[a] = arred2(resumo.porArmazem[a])
  resumo.tsiEntrada = arred2(resumo.tsiEntrada)
  resumo.tsiSaida = arred2(resumo.tsiSaida)
  resumo.semEndereco = arred2(resumo.semEndereco)
  resumo.branca = arred2(resumo.branca)
  resumo.tratada = arred2(resumo.tratada)
  return { linhas, resumo }
}
