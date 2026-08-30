import { describe, expect, it } from 'vitest'
import { converterLotesMapa, ehRelatorioMapa, SEM_TSI } from './mapa'
import type { Linha } from './simpleagro'

// espelho do export real (SAP.xlsx, 28/08/2026)
const CAB: Linha = [
  'Nº do item', 'Nº do Lote', 'Descrição do Item', 'Cultivar', 'Classificação de Qualidade',
  'Categoria do Lote', 'Peneira', 'PMS (g)', 'Peso Bruto', 'Cód. Embalagem', 'Embalagem',
  'UM Base', 'UM Estoque', 'Tratamento (TSI)', 'Destinação', 'Data de Entrada',
  'Data de Criação (sistema)', 'Validade', 'Dias p/ Vencer', 'Depósito', 'Qtd em Estoque', 'Situação',
]
const linha = (opts: {
  lote: string
  cultivar?: string
  classif?: string | null
  pms?: number | null
  pesoBruto?: number | null
  emb?: string
  trat?: string | null
  dest?: string | null
  dep?: string
  qtd?: number
}): Linha => [
  'SOJ00002', opts.lote, 'SS X BB5M', opts.cultivar ?? 'NEO680 IPRO', opts.classif ?? 'Classe C',
  'C1', 'P 6.0 mm', opts.pms === undefined ? 150 : opts.pms,
  opts.pesoBruto === undefined ? 750 : opts.pesoBruto, opts.emb ?? 'BB5M', opts.emb ?? 'BB5M',
  'BB5M', 'BB5M', opts.trat ?? null, opts.dest ?? null, new Date('2026-02-27'),
  new Date('2026-02-27'), null, null, opts.dep ?? 'VEN_GER', opts.qtd ?? 27, 'COM SALDO',
]

describe('ehRelatorioMapa', () => {
  it('reconhece o export com Destinação e Depósito', () => {
    expect(ehRelatorioMapa([CAB])).toBe(true)
  })

  it('não confunde com o saldo antigo, sem Destinação', () => {
    expect(ehRelatorioMapa([['CULTIVAR', 'Nº DO LOTE', 'TRATAMENTO (TSI)', 'QTD EM ESTOQUE']])).toBe(false)
  })
})

describe('converterLotesMapa', () => {
  it('branca vira lote; tratada vira ENRIQUECIMENTO (a ordem de produção cria o lote)', () => {
    // modelo de 30/08/2026: o upload só substitui semente branca; o lote
    // tratado entra no mapa pela ordem "Qualidade apontada", e o upload
    // apenas carimba destinação/classe
    const r = converterLotesMapa([
      CAB,
      linha({ lote: 'A', trat: null, qtd: 10 }),
      linha({ lote: 'A', trat: 'FTZ60', qtd: 5, dest: 'COMIGO' }),
    ])
    expect(r.lotes.map((l) => [l.lote, l.tratamento, l.bags])).toEqual([['A', SEM_TSI, 10]])
    expect(r.enriquecimentos).toEqual([
      { lote: 'A', tratamento: 'FTZ60', destinacao: 'COMIGO', classificacao: 'Classe C' },
    ])
    expect(r.brancos).toBe(1)
    expect(r.tratados).toBe(1)
  })

  it('branca sufixada também entra pelo número base, somando os sub-lotes', () => {
    const r = converterLotesMapa([
      CAB,
      linha({ lote: 'A', trat: null, qtd: 10 }),
      linha({ lote: 'A-1', trat: null, qtd: 7 }),
    ])
    expect(r.lotes.map((l) => [l.lote, l.bags])).toEqual([['A', 17]])
    expect(r.brancos).toBe(1)
  })

  it('o sufixo do SAP morre na entrada: -1/-2 do mesmo base agregam destinações', () => {
    const r = converterLotesMapa([
      CAB,
      linha({ lote: 'A-1', trat: 'FTZ60', dest: 'COMIGO' }),
      linha({ lote: 'A-2', trat: 'FTZ60', dest: 'Multiplicação' }),
      linha({ lote: 'A-3', trat: 'V&P', dest: null }),
    ])
    expect(r.lotes).toHaveLength(0)
    expect(r.enriquecimentos.map((e) => [e.lote, e.tratamento, e.destinacao])).toEqual([
      ['A', 'FTZ60', 'COMIGO / Multiplicação'],
      ['A', 'V&P', null],
    ])
  })

  it('tratamento vazio e "SEM TSI" viram a mesma combinação branca', () => {
    const r = converterLotesMapa([
      CAB,
      linha({ lote: 'A', trat: null, qtd: 10 }),
      linha({ lote: 'A', trat: 'SEM TSI', qtd: 7 }),
    ])
    expect(r.lotes).toHaveLength(1)
    expect(r.lotes[0].tratamento).toBe(SEM_TSI)
    expect(r.lotes[0].bags).toBe(17)
  })

  it('aplica o de-para de tratamento do SAP (VeP → V&P) no enriquecimento', () => {
    const r = converterLotesMapa([CAB, linha({ lote: 'A', trat: 'VeP' })])
    expect(r.enriquecimentos[0].tratamento).toBe('V&P')
  })

  it('só VEN_GER entra; outros depósitos são contados fora', () => {
    const r = converterLotesMapa([
      CAB,
      linha({ lote: 'A' }),
      linha({ lote: 'B', dep: 'VTP_GER' }),
    ])
    expect(r.lotes).toHaveLength(1)
    expect(r.outrosDepositos).toBe(1)
  })

  it('lote zerado fica fora (some do mapa)', () => {
    const r = converterLotesMapa([CAB, linha({ lote: 'A', qtd: 0 })])
    expect(r.lotes).toHaveLength(0)
    expect(r.zerados).toBe(1)
  })

  it('mesma combinação em duas linhas soma bags e mantém o primeiro não-vazio', () => {
    const r = converterLotesMapa([
      CAB,
      linha({ lote: 'A', qtd: 10, dest: null }),
      linha({ lote: 'A', qtd: 5, dest: 'COMIGO' }),
    ])
    expect(r.lotes).toHaveLength(1)
    expect(r.lotes[0].bags).toBe(15)
    expect(r.lotes[0].destinacao).toBe('COMIGO')
  })

  it('peso do bag vem do Peso Bruto; sem ele, PMS × fator da embalagem', () => {
    const r = converterLotesMapa([
      CAB,
      linha({ lote: 'A', pesoBruto: 885, pms: 177 }),
      linha({ lote: 'B', pesoBruto: null, pms: 170, emb: 'BMB' }),
    ])
    expect(r.lotes[0].peso_bag_kg).toBe(885)
    expect(r.lotes[1].peso_bag_kg).toBe(425) // 170 × 2,5
    expect(r.lotes[1].embalagem).toBe('MEIOBAG')
  })

  it('destinação preenchida é contada e preservada — é ela que dispara o aviso', () => {
    const r = converterLotesMapa([
      CAB,
      linha({ lote: 'A', dest: 'Multiplicação' }),
      linha({ lote: 'B' }),
    ])
    expect(r.comDestinacao).toBe(1)
    expect(r.lotes[0].destinacao).toBe('Multiplicação')
    expect(r.lotes[1].destinacao).toBeNull()
  })

  it('granel (embalagem desconhecida) fica fora, contado', () => {
    const r = converterLotesMapa([CAB, linha({ lote: 'A', emb: 'PRE-LOTE' })])
    expect(r.lotes).toHaveLength(0)
    expect(r.granel).toBe(1)
  })
})
