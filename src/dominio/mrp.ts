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
 * ORDENS ABERTAS (12/10/2026, achado na auditoria pedida pelo Arion: "os
 * cálculos de MRP estão corretos?"): o balanço TIRA as ordens abertas do
 * "falta produzir", e o MRP só olhava o falta produzir — o químico das ordens
 * já criadas sumia da necessidade, embora ainda não tenha saído do estoque do
 * SAP. Agora entra o químico de TODA ordem não apontada (decisão dele: o SAP
 * baixa o químico no lançamento AGROTIS, então até a Qualidade apontada o
 * estoque do SAP ainda conta o que a ordem gastou), pelo peso REAL da ordem
 * (`v_ordens.peso_kg` — com lote e kg a tratar). Inclui ordem fora do estoque
 * (sacaria): não vira estoque vendável, mas gasta químico igual.
 *
 * Peso do bag da demanda sem lote: desde 12/10/2026 é o PMS médio dos lotes
 * brancos em estoque DO CULTIVAR × fator da embalagem (`pmsReferencia`);
 * cultivar sem lote cai na média geral dos lotes, e sem lote nenhum, no peso
 * de referência do PCP (Arion, 27/08/2026): BG5M = 850 kg, MEIOBAG = 425 kg —
 * que superestimava (média real das ordens desde agosto: 812 kg o BAG, 388 o
 * meio bag). Embalagem de peso fixo (SC10/SC20) usa o peso do cadastro. A
 * conta de químico por kg de semente é a MESMA da ordem (`pesoItemKg` em
 * calculos.ts) — dose em ml vira kg pela densidade.
 */

import type {
  BalancoLinha, EmbalagemLinha, EstoquePaLinha, ReceitaCompleta,
} from '@/dados/api-gestao'
import { ehSemTsi } from './balanco'
import { baseDoseKg, doseEmMl } from './calculos'
import { normalizaCultivar } from './importacao/simpleagro'

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

/** PMS de referência da demanda sem lote: por cultivar e o geral (12/10/2026). */
export interface PmsReferencia {
  porCultivar: Map<string, number>
  geral: number | null
}

/**
 * PMS médio dos lotes brancos em estoque, por cultivar e geral. Média
 * ponderada pelas SEMENTES (Σ kg ÷ Σ kg/PMS): é a que converte contagem de
 * sementes em peso — ponderar por bag misturaria saco de 200 mil com bag de 5
 * milhões. Só lote com saldo, PMS e peso.
 */
export function pmsReferencia(
  lotes: { cultivar: string; pms: number | null; peso_bag_kg: number; bags_disp: number | null }[],
): PmsReferencia {
  const acc = new Map<string, { kg: number; milSementes: number }>()
  let kgGeral = 0
  let milGeral = 0
  for (const l of lotes) {
    const bags = l.bags_disp ?? 0
    if (!(bags > 0) || !(l.pms != null && l.pms > 0) || !(l.peso_bag_kg > 0)) continue
    const kg = bags * l.peso_bag_kg
    const mil = kg / (l.pms / 1000) // milhares de sementes
    const chave = normalizaCultivar(l.cultivar)
    const a = acc.get(chave) ?? { kg: 0, milSementes: 0 }
    a.kg += kg
    a.milSementes += mil
    acc.set(chave, a)
    kgGeral += kg
    milGeral += mil
  }
  const porCultivar = new Map<string, number>()
  for (const [c, a] of acc) porCultivar.set(c, (a.kg / a.milSementes) * 1000)
  return { porCultivar, geral: milGeral > 0 ? (kgGeral / milGeral) * 1000 : null }
}

export type OrigemPesoBag = 'peso fixo' | 'lotes do cultivar' | 'média dos lotes' | 'referência fixa'

/**
 * Peso do bag da demanda (ainda sem lote): peso fixo da embalagem → PMS dos
 * lotes do cultivar × fator → PMS médio geral × fator → referência fixa.
 */
export function pesoBagDaDemanda(
  cultivar: string,
  codigoEmbalagem: string,
  embalagens: EmbalagemLinha[],
  pms?: PmsReferencia,
): { kg: number; origem: OrigemPesoBag; pms: number | null } | null {
  const emb = embalagens.find((e) => e.codigo === codigoEmbalagem)
  if (emb?.peso_fixo_kg != null && emb.peso_fixo_kg > 0) {
    return { kg: emb.peso_fixo_kg, origem: 'peso fixo', pms: null }
  }
  const fator = emb?.fator_peso ?? null
  if (pms && fator != null && fator > 0) {
    const doCultivar = pms.porCultivar.get(normalizaCultivar(cultivar))
    if (doCultivar != null) {
      return { kg: Math.round(doCultivar * fator * 10) / 10, origem: 'lotes do cultivar', pms: doCultivar }
    }
    if (pms.geral != null) {
      return { kg: Math.round(pms.geral * fator * 10) / 10, origem: 'média dos lotes', pms: pms.geral }
    }
  }
  const ref = pesoRefBagKg(codigoEmbalagem, embalagens)
  return ref == null ? null : { kg: ref, origem: 'referência fixa', pms: null }
}

/** Ordem aberta (não apontada) que ainda vai gastar químico — ou gastou e o SAP ainda não baixou. */
export interface OrdemMrp {
  numero: string
  receita_id: string
  /** kg de semente da ordem (`v_ordens.peso_kg`: bags × peso do bag do lote, ou os kg a tratar). */
  peso_kg: number
  status: string
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
  /** De onde saiu o peso do bag (a demanda ainda não tem lote). */
  origemPeso: OrigemPesoBag
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
  /** Peso de balança das ORDENS ABERTAS (não apontadas), em kg (12/10/2026). */
  totalKgOrdens: number
  /** Volume das ordens abertas em litros — só para produto dosado em ml. */
  totalLOrdens: number | null
  /** As ordens abertas que usam o produto, com a parte de cada uma. */
  ordens: { numero: string; status: string; kgSemente: number; kg: number; litros: number | null }[]
  /** litros/litrosAguardando: null pra produto dosado em g (pó). */
  combinacoes: (CombinacaoMrp & {
    kg: number
    kgAguardando: number
    litros: number | null
    litrosAguardando: number | null
  })[]
}

/**
 * A necessidade na unidade NATIVA do produto — a mesma do estoque do SAP:
 * líquido (dose em ml) em LITROS, pó (dose em g) em KG. Pedido do Arion,
 * 27/08/2026: "se for litro é litro, se for kg é kg" — sem conversão por
 * densidade no meio do caminho do MRP.
 */
export function necessidadeNativa(p: NecessidadeProduto): {
  unidade: 'L' | 'kg'
  /** Químico das ordens abertas (não apontadas). */
  ordens: number
  /** Químico do que falta produzir com pedido aprovado. */
  firme: number
  aguardando: number
  /** ordens + firme + aguardando. */
  total: number
} {
  const emMl = p.unidade.startsWith('ml')
  const ordens = emMl ? (p.totalLOrdens ?? 0) : p.totalKgOrdens
  const firme = emMl ? (p.totalL ?? 0) : p.totalKg
  const aguardando = emMl ? (p.totalLAguardando ?? 0) : p.totalKgAguardando
  return { unidade: emMl ? 'L' : 'kg', ordens, firme, aguardando, total: ordens + firme + aguardando }
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
  /** O que falta comprar pro confirmado: ordens abertas + falta produzir firme. */
  faltaFirme: number
  /** O que falta comprar pra ordens + firme + aguardando. */
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

/** Sufixo do nome no SAP que só diz a embalagem: "L 1906 1000L", "500 L", "5 L BRA", "12X1L". */
const SUFIXO_EMBALAGEM = /^(?:(?:L\s?\d+|\d+(?:[.,]\d+)?\s?(?:L|LT|LTS|KG|ML|G)|\d+X\d+\s?(?:L|KG)|BRA)(?:\s+|$))+$/

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

  // o SAP lista o MESMO produto em mais de uma embalagem ("DISCO BLACK L 1906
  // 1000L", "DISCO BLACK L1905 500 L", "CRUISER 600 FS 1000L BRA"): sufixo só
  // de embalagem soma no nível 1, junto do nome exato (12/10/2026 — 1.500 L de
  // Disco Black ficavam de fora). Sufixo que não é embalagem ("F PLUS",
  // "(inativo)") continua só nos níveis seguintes.
  const ehEmbalagem = (sufixo: string) => SUFIXO_EMBALAGEM.test(sufixo)
  const niveis: ((nomeSap: string) => boolean)[] = [
    (n) => n === alvo || (n.startsWith(alvo + ' ') && ehEmbalagem(n.slice(alvo.length + 1))),
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

  // ordens abertas entram nas duas contas: o químico delas ainda está (ou vai
  // estar até o AGROTIS) no estoque do SAP (12/10/2026)
  const nat = necessidadeNativa(p)
  const necessarioFirme = nat.ordens + nat.firme
  const necessarioTotal = nat.total

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
    /** Ordens abertas (não apontadas) com receita que entraram na conta. */
    ordens: number
    kgSementeOrdens: number
    kgQuimicoOrdens: number
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
  opcoes: {
    /** Ordens não apontadas — o químico delas soma à necessidade (12/10/2026). */
    ordens?: OrdemMrp[]
    /** PMS dos lotes em estoque — peso do bag da demanda por cultivar (12/10/2026). */
    pms?: PmsReferencia
  } = {},
): ResultadoMrp {
  const porNome = new Map(receitas.map((r) => [r.nome, r]))
  const porId = new Map(receitas.map((r) => [r.id, r]))
  const produtos = new Map<string, NecessidadeProduto>()
  /** kg e litros de um item da receita por kg de semente — a fórmula de pesoItemKg. */
  const porKgSemente = (item: ReceitaCompleta['receita_itens'][number]) => {
    const p = item.produtos_quimicos
    const base = baseDoseKg(p.unidade)
    // dose em ml exige densidade; produto sem densidade não derruba o painel
    // inteiro: cai como 0 kg e a tela avisa pelo próprio cadastro
    const kg = doseEmMl(p.unidade)
      ? p.densidade != null
        ? (item.dose * p.densidade) / 1000 / base
        : 0
      : item.dose / 1000 / base
    const litros = doseEmMl(p.unidade) ? item.dose / 1000 / base : null
    return { kg, litros }
  }
  const produtoDe = (item: ReceitaCompleta['receita_itens'][number]): NecessidadeProduto => {
    const p = item.produtos_quimicos
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
        totalKgOrdens: 0,
        totalLOrdens: doseEmMl(p.unidade) ? 0 : null,
        ordens: [],
        combinacoes: [],
      }
      produtos.set(p.codigo, acc)
    }
    return acc
  }
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

    const peso = pesoBagDaDemanda(b.cultivar, b.embalagem, embalagens, opcoes.pms)
    if (peso == null) {
      semPesoRef.push({
        cultivar: b.cultivar, tratamento: b.tratamento, embalagem: b.embalagem,
        bags, bagsAguardando,
      })
      continue
    }

    const pesoBag = peso.kg
    const kgSemente = bags * pesoBag
    const kgSementeAguardando = bagsAguardando * pesoBag
    const combo: CombinacaoMrp = {
      cultivar: b.cultivar,
      tratamento: b.tratamento,
      embalagem: b.embalagem,
      bags,
      bagsAguardando,
      pesoBagKg: pesoBag,
      origemPeso: peso.origem,
      kgSemente,
      kgSementeAguardando,
      pedidoAprovado: b.pedido_aprovado,
      pedidoPendente: b.pedido_pendente,
      estoquePa: b.estoque_pa,
      ordensAbertas: b.ordens_abertas,
    }
    combinacoes.push(combo)

    for (const item of receita.receita_itens) {
      const { kg: kgPorKgSemente, litros: litrosPorKgSemente } = porKgSemente(item)
      const kg = kgPorKgSemente * kgSemente
      const kgAguardando = kgPorKgSemente * kgSementeAguardando
      const litros = litrosPorKgSemente != null ? litrosPorKgSemente * kgSemente : null
      const litrosAguardando =
        litrosPorKgSemente != null ? litrosPorKgSemente * kgSementeAguardando : null

      const acc = produtoDe(item)
      acc.totalKg += kg
      acc.totalKgAguardando += kgAguardando
      if (litrosPorKgSemente != null) {
        acc.totalL! += litrosPorKgSemente * kgSemente
        acc.totalLAguardando! += litrosPorKgSemente * kgSementeAguardando
      }
      acc.combinacoes.push({ ...combo, kg, kgAguardando, litros, litrosAguardando })
    }
  }

  // ordens abertas: o químico da receita pelo peso real da ordem (12/10/2026)
  let ordensNaConta = 0
  let kgSementeOrdens = 0
  for (const o of opcoes.ordens ?? []) {
    const receita = porId.get(o.receita_id)
    const kgSemente = Number(o.peso_kg) || 0
    if (!receita || !(kgSemente > 0) || receita.receita_itens.length === 0) continue
    ordensNaConta++
    kgSementeOrdens += kgSemente
    for (const item of receita.receita_itens) {
      const { kg: kgPorKgSemente, litros: litrosPorKgSemente } = porKgSemente(item)
      const acc = produtoDe(item)
      const kg = kgPorKgSemente * kgSemente
      const litros = litrosPorKgSemente != null ? litrosPorKgSemente * kgSemente : null
      acc.totalKgOrdens += kg
      if (litros != null) acc.totalLOrdens = (acc.totalLOrdens ?? 0) + litros
      acc.ordens.push({ numero: o.numero, status: o.status, kgSemente, kg, litros })
    }
  }

  const peso = (p: NecessidadeProduto) => p.totalKgOrdens + p.totalKg + p.totalKgAguardando
  const lista = [...produtos.values()].sort((a, b) => peso(b) - peso(a))
  for (const p of lista) {
    p.combinacoes.sort((a, b) => b.kg + b.kgAguardando - (a.kg + a.kgAguardando))
    p.ordens.sort((a, b) => b.kg - a.kg)
  }

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
      ordens: ordensNaConta,
      kgSementeOrdens,
      kgQuimicoOrdens: lista.reduce((s, p) => s + p.totalKgOrdens, 0),
    },
    semReceita: semReceita.sort(
      (a, b) => b.bags + b.bagsAguardando - (a.bags + a.bagsAguardando),
    ),
    semPesoRef,
  }
}
