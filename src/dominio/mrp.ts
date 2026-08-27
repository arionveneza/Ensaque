/**
 * MRP — necessidade de material (químico) para cobrir o que falta produzir.
 *
 *   falta produzir (balanço, em bags) × peso do bag → kg de semente
 *   kg de semente × dose da receita → kg (e litros) de cada produto químico
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

import type { BalancoLinha, EmbalagemLinha, ReceitaCompleta } from '@/dados/api-gestao'
import { bagsFaltando, ehSemTsi } from './balanco'
import { baseDoseKg, doseEmMl } from './calculos'

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
  bags: number
  pesoBagKg: number
  kgSemente: number
}

export interface NecessidadeProduto {
  codigo: string
  nome: string
  unidade: string
  densidade: number | null
  /** Peso de balança total, em kg — soma de todas as combinações. */
  totalKg: number
  /** Volume total em litros — só para produto dosado em ml. */
  totalL: number | null
  combinacoes: (CombinacaoMrp & { kg: number })[]
}

export interface ResultadoMrp {
  /** Uma linha por produto químico, do maior consumo para o menor. */
  produtos: NecessidadeProduto[]
  /** As combinações descobertas que entraram na conta. */
  combinacoes: CombinacaoMrp[]
  totais: {
    bags: number
    kgSemente: number
    kgQuimico: number
  }
  /** Descobertas SEM receita cadastrada — fora da conta, listadas pra ninguém esquecer. */
  semReceita: { cultivar: string; tratamento: string; embalagem: string; bags: number }[]
  /** Embalagem sem peso de referência nem peso fixo — fora da conta. */
  semPesoRef: { cultivar: string; tratamento: string; embalagem: string; bags: number }[]
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
    const bags = bagsFaltando(b)
    if (bags <= 0) continue
    // SEM TSI é semente branca: não consome químico e o balanço de pedidos
    // nem a rastreia (importação descarta) — não entra no MRP
    if (ehSemTsi(b.tratamento)) continue

    const receita = porNome.get(b.tratamento)
    if (!receita || !b.receita_cadastrada) {
      semReceita.push({ cultivar: b.cultivar, tratamento: b.tratamento, embalagem: b.embalagem, bags })
      continue
    }

    const pesoBag = pesoRefBagKg(b.embalagem, embalagens)
    if (pesoBag == null) {
      semPesoRef.push({ cultivar: b.cultivar, tratamento: b.tratamento, embalagem: b.embalagem, bags })
      continue
    }

    const kgSemente = bags * pesoBag
    const combo: CombinacaoMrp = {
      cultivar: b.cultivar,
      tratamento: b.tratamento,
      embalagem: b.embalagem,
      bags,
      pesoBagKg: pesoBag,
      kgSemente,
    }
    combinacoes.push(combo)

    for (const item of receita.receita_itens) {
      const p = item.produtos_quimicos
      const base = baseDoseKg(p.unidade)
      // mesma fórmula de pesoItemKg (calculos.ts) — dose em ml exige densidade;
      // produto sem densidade não derruba o painel inteiro: cai como 0 kg e a
      // tela avisa pelo próprio cadastro (o produto aparece com densidade nula)
      const kg = doseEmMl(p.unidade)
        ? p.densidade != null
          ? (item.dose * kgSemente * p.densidade) / 1000 / base
          : 0
        : (item.dose * kgSemente) / 1000 / base
      const litros = doseEmMl(p.unidade) ? (item.dose * kgSemente) / 1000 / base : null

      let acc = produtos.get(p.codigo)
      if (!acc) {
        acc = {
          codigo: p.codigo,
          nome: p.nome,
          unidade: p.unidade,
          densidade: p.densidade,
          totalKg: 0,
          totalL: doseEmMl(p.unidade) ? 0 : null,
          combinacoes: [],
        }
        produtos.set(p.codigo, acc)
      }
      acc.totalKg += kg
      if (acc.totalL != null && litros != null) acc.totalL += litros
      acc.combinacoes.push({ ...combo, kg })
    }
  }

  const lista = [...produtos.values()].sort((a, b) => b.totalKg - a.totalKg)
  for (const p of lista) p.combinacoes.sort((a, b) => b.kg - a.kg)

  return {
    produtos: lista,
    combinacoes: combinacoes.sort((a, b) => b.kgSemente - a.kgSemente),
    totais: {
      bags: combinacoes.reduce((s, c) => s + c.bags, 0),
      kgSemente: combinacoes.reduce((s, c) => s + c.kgSemente, 0),
      kgQuimico: lista.reduce((s, p) => s + p.totalKg, 0),
    },
    semReceita: semReceita.sort((a, b) => b.bags - a.bags),
    semPesoRef,
  }
}
