/**
 * MRP — necessidade de material (químico) para cobrir o que falta produzir.
 *
 *   falta produzir (balanço, em bags) × peso do bag → kg de semente
 *   kg de semente × dose da receita → kg (e litros) de cada produto químico
 *
 * Duas parcelas por combinação (pedido do Arion, 27/08/2026):
 *
 *   FIRME      = o descoberto do balanço (pedido APROVADO − estoque − ordens)
 *   AGUARDANDO = o adicional se o pedido pendente de liberação financeira
 *                aprovar. Não é o pendente inteiro: sobra de estoque acima do
 *                aprovado abate o pendente primeiro —
 *                aguardando = max(0, saldo + pendente) − max(0, saldo).
 *
 * A demanda descoberta ainda não tem lote, então não há PMS pra calcular o
 * peso do bag por sementes — usa-se peso de REFERÊNCIA fixado pelo PCP
 * (Arion, 27/08/2026): BG5M = 850 kg, MEIOBAG = 425 kg. Embalagem de peso
 * fixo (SC10/SC20) usa o próprio peso do cadastro. A conta de químico por kg
 * de semente é a MESMA da ordem (`pesoItemKg` em calculos.ts) — dose em ml
 * vira kg pela densidade.
 *
 * Isto calcula o NECESSÁRIO, não o que falta comprar: o app ainda não sabe o
 * saldo de estoque de insumo (pendência conhecida do CLAUDE.md §7).
 */

import type {
  BalancoLinha, EmbalagemLinha, EstoquePaLinha, ReceitaCompleta,
} from '@/dados/api-gestao'
import { ehSemTsi } from './balanco'
import { baseDoseKg, doseEmMl } from './calculos'

/**
 * Estoque SAP da COMBINAÇÃO cultivar + tratamento (pedido do Arion,
 * 27/08/2026): o produto JÁ TRATADO no estoque (estoque_pa, da mesma carga
 * de saldos do SAP), somando as embalagens da combinação. É informativo — o
 * balanço já desconta esse estoque do "falta produzir"; a coluna existe pra
 * enxergar quanto daquela combinação já está pronto no galpão sem ir atrás
 * da planilha.
 */
export function estoqueSapPorCombinacao(estoquePa: EstoquePaLinha[]): Map<string, number> {
  const mapa = new Map<string, number>()
  for (const e of estoquePa) {
    const chave = chaveCombinacao(e.cultivar, e.tratamento)
    mapa.set(chave, (mapa.get(chave) ?? 0) + e.bags)
  }
  return mapa
}

// JSON como chave: colisao impossivel, mesmo com espaco e "+" nos nomes
export const chaveCombinacao = (cultivar: string, tratamento: string): string =>
  JSON.stringify([cultivar, tratamento])

/** Peso de referência por bag para demanda sem lote (Arion, 27/08/2026). */
export const PESO_REF_BAG_KG: Record<string, number> = {
  BG5M: 850,
  MEIOBAG: 425,
}

export const pesoRefBagKg = (
  codigoEmbalagem: string,
  embalagens: EmbalagemLinha[],
): number | null => {
  const emb = embalagens.find((e) => e.codigo === codigoEmbalagem)
  if (emb?.peso_fixo_kg != null && emb.peso_fixo_kg > 0) return emb.peso_fixo_kg
  return PESO_REF_BAG_KG[codigoEmbalagem] ?? null
}

export interface CombinacaoMrp {
  cultivar: string
  tratamento: string
  embalagem: string
  /** Descoberto do pedido aprovado — a parcela firme (o que puxa químico). */
  bags: number
  /** Adicional se o pedido aguardando liberação financeira aprovar. */
  bagsAguardando: number
  pesoBagKg: number
  kgSemente: number
  kgSementeAguardando: number
  /**
   * As parcelas da conta, direto do balanço — a tela abre a equação
   * `falta = pedido − estoque − ordens` porque só a falta parecia número
   * errado pra quem procurava o pedido (achado do Arion, 27/08/2026:
   * "tenho de pedido firme 45 bags e aí aparece 0" — os 45 já estavam
   * cobertos por 45 em estoque).
   */
  pedidoAprovado: number
  pedidoPendente: number
  estoquePa: number
  ordensAbertas: number
}

export interface NecessidadeProduto {
  codigo: string
  nome: string
  unidade: string
  densidade: number | null
  /** Peso de balança da parcela firme, em kg — soma de todas as combinações. */
  totalKg: number
  /** Peso de balança adicional se o aguardando aprovar, em kg. */
  totalKgAguardando: number
  /** Volume da parcela firme em litros — só para produto dosado em ml. */
  totalL: number | null
  /** Volume adicional do aguardando, em litros. */
  totalLAguardando: number | null
  combinacoes: (CombinacaoMrp & { kg: number; kgAguardando: number })[]
}

/** Um item do estoque de químicos importado (agregado por item do SAP). */
export interface EstoqueQuimicoItem {
  codigo_sap: string
  nome: string
  /** LT | KG | DOSES | CAIXA | UN — como veio do SAP. */
  unidade: string
  quantidade: number
  lotes: number
}

export interface EstoqueCruzado {
  /** Disponível na unidade de comparação — null quando nenhum item do SAP casou. */
  disponivel: number | null
  /** 'L' pra produto dosado em ml (estoque LT), 'kg' pra dosado em g (estoque KG). */
  unidadeComparacao: 'L' | 'kg'
  /** Nome(s) do SAP que casaram — pra conferência visual. */
  nomesSap: string[]
  /** O que falta comprar pra parcela firme. */
  faltaFirme: number
  /** O que falta comprar pra firme + aguardando. */
  faltaTotal: number
  /**
   * Saldo COM SINAL (estoque − necessário): positivo sobra, negativo falta —
   * a outra face do "falta comprar" (pedido do Arion, 27/08/2026). Null
   * quando nenhum item do SAP casou.
   */
  saldoFirme: number | null
  saldoTotal: number | null
  /** Achou o item, mas a unidade do SAP não é comparável (ex.: DOSES). */
  incompativel: boolean
}

const normNome = (v: string): string =>
  v
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()

/**
 * Casa a necessidade de UM produto com o estoque de químicos do SAP e diz o
 * que falta comprar.
 *
 * O casamento é por NOME, nunca por código: o código do item no SAP não
 * bate com o cadastrado no app em vários produtos (INS00004 é RIZOLIQ LLI
 * lá e KELMAX aqui — conferido no export real de 27/08/2026). Três níveis,
 * o primeiro que casar vence e os seguintes nem são olhados:
 *
 *   1. nome igual                          (DISCO BLACK = DISCO BLACK)
 *   2. o do SAP COMEÇA com o do app        (RANCONA T ← RANCONA,
 *                                           ACRESCENT RAIZ F PLUS ← ACRESCENT RAIZ F)
 *   3. o do app COMEÇA com o do SAP        (FORTENZA 600 FS ← FORTENZA,
 *                                           KELMAX RN BR ← KELMAX RN)
 *
 * Sempre com fronteira de palavra — "ACRESCENT RAIZ" (outro produto) não
 * casa com "ACRESCENT RAIZ F" no nível 2 porque o nível 2 já achou o PLUS,
 * e no 3 exigiria "ACRESCENT RAIZ F..." começar com "ACRESCENT RAIZ " (tem,
 * mas o nível 3 só roda se 1 e 2 falharem). A comparação de quantidade é na
 * unidade natural do produto: dosado em ml compara LITROS (estoque LT),
 * dosado em g compara KG (estoque KG).
 */
export function cruzarEstoqueQuimico(
  p: NecessidadeProduto,
  estoque: EstoqueQuimicoItem[],
): EstoqueCruzado {
  const emMl = p.unidade.startsWith('ml')
  const unidadeComparacao: 'L' | 'kg' = emMl ? 'L' : 'kg'
  const unidadeSap = emMl ? 'LT' : 'KG'

  const alvo = normNome(p.nome)
  const comFronteira = (maior: string, menor: string) =>
    maior === menor || maior.startsWith(menor + ' ')

  const niveis: ((nomeSap: string) => boolean)[] = [
    (n) => n === alvo,
    (n) => comFronteira(n, alvo),
    (n) => comFronteira(alvo, n),
  ]
  let casados: EstoqueQuimicoItem[] = []
  for (const nivel of niveis) {
    casados = estoque.filter((e) => nivel(normNome(e.nome)))
    if (casados.length > 0) break
  }

  const compativeis = casados.filter((e) => e.unidade.toUpperCase() === unidadeSap)
  const disponivel =
    casados.length === 0
      ? null
      : compativeis.reduce((s, e) => s + e.quantidade, 0)

  const necessarioFirme = emMl ? (p.totalL ?? 0) : p.totalKg
  const necessarioTotal = emMl
    ? (p.totalL ?? 0) + (p.totalLAguardando ?? 0)
    : p.totalKg + p.totalKgAguardando

  return {
    disponivel,
    unidadeComparacao,
    nomesSap: casados.map((e) => e.nome),
    faltaFirme: Math.max(0, necessarioFirme - (disponivel ?? 0)),
    faltaTotal: Math.max(0, necessarioTotal - (disponivel ?? 0)),
    saldoFirme: disponivel == null ? null : disponivel - necessarioFirme,
    saldoTotal: disponivel == null ? null : disponivel - necessarioTotal,
    incompativel: casados.length > 0 && compativeis.length === 0,
  }
}

export interface ResultadoMrp {
  /** Uma linha por produto químico, do maior consumo para o menor. */
  produtos: NecessidadeProduto[]
  /** As combinações que entraram na conta. */
  combinacoes: CombinacaoMrp[]
  totais: {
    bags: number
    bagsAguardando: number
    kgSemente: number
    kgSementeAguardando: number
    kgQuimico: number
    kgQuimicoAguardando: number
  }
  /** Sem receita cadastrada — fora da conta, listadas pra ninguém esquecer. */
  semReceita: {
    cultivar: string
    tratamento: string
    embalagem: string
    bags: number
    bagsAguardando: number
  }[]
  /** Embalagem sem peso de referência nem peso fixo — fora da conta. */
  semPesoRef: {
    cultivar: string
    tratamento: string
    embalagem: string
    bags: number
    bagsAguardando: number
  }[]
}

export interface ConferenciaCadastro {
  /** Receitas cadastradas sem NENHUM pedido (aprovado ou pendente) na carga vigente. */
  receitasSemPedido: string[]
  /** Tratamentos com pedido na carga, sem receita cadastrada — agregado por tratamento. */
  pedidosSemReceita: {
    tratamento: string
    bagsAprovado: number
    bagsPendente: number
    combinacoes: number
  }[]
}

/**
 * Cruzamento cadastro × pedidos, nos dois sentidos (pedido do Arion,
 * 27/08/2026): receita parada (cadastrada mas ninguém comprou — candidata a
 * revisão ou só fora de época) e pedido órfão (o comercial vendeu um código
 * que a produção não sabe fazer — ESTE é o urgente, o balanço não vira ordem
 * enquanto a receita não existir). SEM TSI fica fora dos dois lados: semente
 * branca não passa pelo MRP.
 */
export function conferirCadastro(
  balanco: BalancoLinha[],
  receitas: ReceitaCompleta[],
): ConferenciaCadastro {
  const comPedido = new Set(
    balanco
      .filter((b) => b.pedido_aprovado > 0 || b.pedido_pendente > 0)
      .map((b) => b.tratamento),
  )

  const receitasSemPedido = receitas
    .map((r) => r.nome)
    .filter((nome) => !ehSemTsi(nome) && !comPedido.has(nome))
    .sort((a, b) => a.localeCompare(b))

  const cadastradas = new Set(receitas.map((r) => r.nome))
  const orfaos = new Map<string, ConferenciaCadastro['pedidosSemReceita'][number]>()
  for (const b of balanco) {
    if (b.pedido_aprovado <= 0 && b.pedido_pendente <= 0) continue
    if (ehSemTsi(b.tratamento) || cadastradas.has(b.tratamento)) continue
    let acc = orfaos.get(b.tratamento)
    if (!acc) {
      acc = { tratamento: b.tratamento, bagsAprovado: 0, bagsPendente: 0, combinacoes: 0 }
      orfaos.set(b.tratamento, acc)
    }
    acc.bagsAprovado += b.pedido_aprovado
    acc.bagsPendente += b.pedido_pendente
    acc.combinacoes += 1
  }

  return {
    receitasSemPedido,
    pedidosSemReceita: [...orfaos.values()].sort(
      (a, b) => b.bagsAprovado + b.bagsPendente - (a.bagsAprovado + a.bagsPendente),
    ),
  }
}

export function calcularMrp(
  balanco: BalancoLinha[],
  receitas: ReceitaCompleta[],
  embalagens: EmbalagemLinha[],
): ResultadoMrp {
  const porNome = new Map(receitas.map((r) => [r.nome, r]))
  const produtos = new Map<string, NecessidadeProduto>()
  const combinacoes: CombinacaoMrp[] = []
  const semReceita: ResultadoMrp['semReceita'] = []
  const semPesoRef: ResultadoMrp['semPesoRef'] = []

  for (const b of balanco) {
    const bags = Math.max(0, b.saldo)
    // sobra de estoque acima do aprovado (saldo negativo) abate o pendente
    // antes de gerar necessidade nova
    const bagsAguardando = Math.max(0, b.saldo + b.pedido_pendente) - bags
    if (bags <= 0 && bagsAguardando <= 0) continue
    // SEM TSI é semente branca: não consome químico e o balanço de pedidos
    // nem a rastreia (importação descarta) — não entra no MRP
    if (ehSemTsi(b.tratamento)) continue

    const receita = porNome.get(b.tratamento)
    if (!receita || !b.receita_cadastrada) {
      semReceita.push({
        cultivar: b.cultivar, tratamento: b.tratamento, embalagem: b.embalagem,
        bags, bagsAguardando,
      })
      continue
    }

    const pesoBag = pesoRefBagKg(b.embalagem, embalagens)
    if (pesoBag == null) {
      semPesoRef.push({
        cultivar: b.cultivar, tratamento: b.tratamento, embalagem: b.embalagem,
        bags, bagsAguardando,
      })
      continue
    }

    const kgSemente = bags * pesoBag
    const kgSementeAguardando = bagsAguardando * pesoBag
    const combo: CombinacaoMrp = {
      cultivar: b.cultivar,
      tratamento: b.tratamento,
      embalagem: b.embalagem,
      bags,
      bagsAguardando,
      pesoBagKg: pesoBag,
      kgSemente,
      kgSementeAguardando,
      pedidoAprovado: b.pedido_aprovado,
      pedidoPendente: b.pedido_pendente,
      estoquePa: b.estoque_pa,
      ordensAbertas: b.ordens_abertas,
    }
    combinacoes.push(combo)

    for (const item of receita.receita_itens) {
      const p = item.produtos_quimicos
      const base = baseDoseKg(p.unidade)
      // mesma fórmula de pesoItemKg (calculos.ts) — dose em ml exige densidade;
      // produto sem densidade não derruba o painel inteiro: cai como 0 kg e a
      // tela avisa pelo próprio cadastro (o produto aparece com densidade nula)
      const kgPorKgSemente = doseEmMl(p.unidade)
        ? p.densidade != null
          ? (item.dose * p.densidade) / 1000 / base
          : 0
        : item.dose / 1000 / base
      const litrosPorKgSemente = doseEmMl(p.unidade) ? item.dose / 1000 / base : null

      const kg = kgPorKgSemente * kgSemente
      const kgAguardando = kgPorKgSemente * kgSementeAguardando

      let acc = produtos.get(p.codigo)
      if (!acc) {
        acc = {
          codigo: p.codigo,
          nome: p.nome,
          unidade: p.unidade,
          densidade: p.densidade,
          totalKg: 0,
          totalKgAguardando: 0,
          totalL: doseEmMl(p.unidade) ? 0 : null,
          totalLAguardando: doseEmMl(p.unidade) ? 0 : null,
          combinacoes: [],
        }
        produtos.set(p.codigo, acc)
      }
      acc.totalKg += kg
      acc.totalKgAguardando += kgAguardando
      if (litrosPorKgSemente != null) {
        acc.totalL! += litrosPorKgSemente * kgSemente
        acc.totalLAguardando! += litrosPorKgSemente * kgSementeAguardando
      }
      acc.combinacoes.push({ ...combo, kg, kgAguardando })
    }
  }

  const lista = [...produtos.values()].sort(
    (a, b) => b.totalKg + b.totalKgAguardando - (a.totalKg + a.totalKgAguardando),
  )
  for (const p of lista) p.combinacoes.sort((a, b) => b.kg + b.kgAguardando - (a.kg + a.kgAguardando))

  return {
    produtos: lista,
    combinacoes: combinacoes.sort(
      (a, b) => b.kgSemente + b.kgSementeAguardando - (a.kgSemente + a.kgSementeAguardando),
    ),
    totais: {
      bags: combinacoes.reduce((s, c) => s + c.bags, 0),
      bagsAguardando: combinacoes.reduce((s, c) => s + c.bagsAguardando, 0),
      kgSemente: combinacoes.reduce((s, c) => s + c.kgSemente, 0),
      kgSementeAguardando: combinacoes.reduce((s, c) => s + c.kgSementeAguardando, 0),
      kgQuimico: lista.reduce((s, p) => s + p.totalKg, 0),
      kgQuimicoAguardando: lista.reduce((s, p) => s + p.totalKgAguardando, 0),
    },
    semReceita: semReceita.sort(
      (a, b) => b.bags + b.bagsAguardando - (a.bags + a.bagsAguardando),
    ),
    semPesoRef,
  }
}
