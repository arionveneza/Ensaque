import { describe, expect, it } from 'vitest'
import {
  chaveBloco,
  ehQuadraNumerica,
  normalizaBloco,
  normalizarFoto,
  ordenaPorFacilidade,
  ordenaQuadras,
  ranquear,
  resumoPorBloco,
  rotuloQuadra,
  totaisEnderecamento,
  VERSAO_FOTO,
  type PosicaoPlanilha,
} from './enderecamento'

const pos = (over: Partial<PosicaoPlanilha> = {}): PosicaoPlanilha => ({
  lote: 'SV001',
  tratamento: 'SEM TRATAMENTO',
  cultivar: 'NEO700 I2X',
  classe: 'A',
  destinacao: '',
  status: '',
  armazem: 'A',
  bloco: '29A',
  quadra: '1',
  bags: 10,
  data: '20/01/2026',
  linhasSomadas: 1,
  ...over,
})

describe('quadra: numerica, rotulo e ordem', () => {
  it('so digito conta como quadra numerica', () => {
    expect(ehQuadraNumerica('4')).toBe(true)
    expect(ehQuadraNumerica(' 12 ')).toBe(true)
    expect(ehQuadraNumerica('CORREDOR')).toBe(false)
    expect(ehQuadraNumerica('')).toBe(false)
  })

  it('numerica vem primeiro, da maior pra menor; texto vai pro fim', () => {
    expect(['CORREDOR', '2', '10', 'SILO'].sort(ordenaQuadras)).toEqual(['10', '2', 'CORREDOR', 'SILO'])
  })

  it('rotulo enche com zero so quando e numero', () => {
    expect(rotuloQuadra('4')).toBe('QD04')
    expect(rotuloQuadra('12')).toBe('QD12')
    expect(rotuloQuadra('CORREDOR')).toBe('CORREDOR')
  })

  it('bloco de um digito ganha zero na frente', () => {
    expect(normalizaBloco('5D')).toBe('05D')
    expect(normalizaBloco(' 1c ')).toBe('01C')
    expect(normalizaBloco('29A')).toBe('29A')
    expect(normalizaBloco('CORREDOR ')).toBe('CORREDOR')
  })
})

describe('ranquear: quadra maior = frente do bloco', () => {
  it('empate divide a posicao e a seguinte pula', () => {
    // caso real do bloco A|29A: quadras 4, 3, 3, 2, 1
    const r = ranquear([
      pos({ lote: 'L4', quadra: '4' }),
      pos({ lote: 'L3a', quadra: '3' }),
      pos({ lote: 'L3b', quadra: '3' }),
      pos({ lote: 'L2', quadra: '2' }),
      pos({ lote: 'L1', quadra: '1' }),
    ])
    const porLote = Object.fromEntries(r.map((l) => [l.lote, l.posicaoNoBloco]))
    expect(porLote).toEqual({ L4: 1, L3a: 2, L3b: 2, L2: 4, L1: 5 })
    expect(r.find((l) => l.lote === 'L3a')?.empatados).toBe(2)
    expect(r.find((l) => l.lote === 'L4')?.empatados).toBe(1)
    expect(r[0].totalNoBloco).toBe(5)
  })

  it('quem esta na frente do bloco nao tem nada na frente', () => {
    const r = ranquear([pos({ lote: 'L4', quadra: '4' }), pos({ lote: 'L1', quadra: '1', bags: 7 })])
    expect(r.find((l) => l.lote === 'L4')?.bagsNaFrente).toBe(0)
    expect(r.find((l) => l.lote === 'L1')?.bagsNaFrente).toBe(10)
  })

  it('empatado NAO conta como material na frente do outro', () => {
    const r = ranquear([
      pos({ lote: 'La', quadra: '3', bags: 5 }),
      pos({ lote: 'Lb', quadra: '3', bags: 8 }),
    ])
    expect(r.every((l) => l.bagsNaFrente === 0)).toBe(true)
  })

  it('o proprio lote em outra quadra do mesmo bloco nao e obstaculo de si mesmo', () => {
    const r = ranquear([
      pos({ lote: 'X', tratamento: 'FTZ60', quadra: '5', bags: 30 }),
      pos({ lote: 'X', tratamento: 'FTZ60', quadra: '1', bags: 10 }),
      pos({ lote: 'Y', quadra: '4', bags: 6 }),
    ])
    const fundo = r.find((l) => l.lote === 'X' && l.quadra === '1')
    expect(fundo?.bagsNaFrente).toBe(6) // só o Y; os 30 bags dele mesmo não contam
  })

  it('bloco com um lote so: primeira posicao, nada na frente', () => {
    const r = ranquear([pos({ quadra: '7' })])
    expect(r[0].posicaoNoBloco).toBe(1)
    expect(r[0].bagsNaFrente).toBe(0)
  })

  it('quadra de texto e endereco incompleto ficam sem posicao', () => {
    const r = ranquear([
      pos({ lote: 'Lok', quadra: '2' }),
      pos({ lote: 'Ltxt', quadra: 'CORREDOR' }),
      pos({ lote: 'Lsem', quadra: '' }),
      pos({ lote: 'Lnada', armazem: '', bloco: '', quadra: '' }),
    ])
    const m = Object.fromEntries(r.map((l) => [l.lote, l]))
    expect(m.Lok.posicaoNoBloco).toBe(1)
    expect(m.Ltxt.posicaoNoBloco).toBeNull()
    expect(m.Ltxt.bagsNaFrente).toBeNull()
    expect(m.Ltxt.enderecoCompleto).toBe(true)
    expect(m.Lsem.enderecoCompleto).toBe(false)
    expect(m.Lnada.enderecoCompleto).toBe(false)
  })

  it('mesmo nome de bloco em armazens diferentes nao se mistura', () => {
    const r = ranquear([
      pos({ lote: 'A1', armazem: 'A', bloco: '01A', quadra: '1' }),
      pos({ lote: 'B9', armazem: 'B', bloco: '01A', quadra: '9' }),
    ])
    expect(r.every((l) => l.posicaoNoBloco === 1)).toBe(true)
    expect(chaveBloco(r[0])).not.toBe(chaveBloco(r[1]))
  })
})

describe('ordenaPorFacilidade', () => {
  it('menos material na frente primeiro; sem quadra por ultimo', () => {
    const r = ranquear([
      pos({ lote: 'fundo', quadra: '1' }),
      pos({ lote: 'frente', quadra: '9' }),
      pos({ lote: 'texto', quadra: 'CORREDOR' }),
    ])
    expect([...r].sort(ordenaPorFacilidade).map((l) => l.lote)).toEqual(['frente', 'fundo', 'texto'])
  })
})

describe('resumoPorBloco e totais', () => {
  it('agrupa por bloco com as quadras da frente pro fundo', () => {
    const r = ranquear([
      pos({ lote: 'L1', quadra: '1', bags: 10 }),
      pos({ lote: 'L9', quadra: '9', bags: 5 }),
      pos({ lote: 'Lc', quadra: 'CORREDOR', bags: 2 }),
    ])
    const [bloco] = resumoPorBloco(r)
    expect(bloco.quadras.map((q) => q.quadra)).toEqual(['9', '1', 'CORREDOR'])
    expect(bloco.bags).toBe(17)
    expect(bloco.linhas).toBe(3)
  })

  it('conta faceis, sem endereco e sem quadra', () => {
    const t = totaisEnderecamento(
      ranquear([
        pos({ lote: 'L1', quadra: '9' }),
        pos({ lote: 'L2', quadra: '1' }),
        pos({ lote: 'L3', armazem: 'B', bloco: '02B', quadra: '3' }),
        pos({ lote: 'L4', quadra: 'CORREDOR' }),
        pos({ lote: 'L5', armazem: '', bloco: '', quadra: '' }),
      ]),
    )
    expect(t.linhas).toBe(5)
    expect(t.lotes).toBe(5)
    expect(t.faceis).toBe(2) // L1 no bloco A|29A e L3 sozinho no B|02B
    expect(t.semQuadra).toBe(1)
    expect(t.semEndereco).toBe(1)
    expect(t.blocos).toBe(2)
  })
})

describe('normalizarFoto: o que veio do navegador', () => {
  const foto = {
    versao: VERSAO_FOTO,
    planilhaId: 'PLAN1',
    buscadoEm: '2026-09-18T12:00:00.000Z',
    posicoes: [pos()],
    problemas: [{ lote: 'SV001', motivo: 'sem quadra na planilha' }],
  }

  it('sobrevive ao ida e volta do JSON', () => {
    const f = normalizarFoto(JSON.parse(JSON.stringify(foto)), 'PLAN1')
    expect(f?.posicoes).toHaveLength(1)
    expect(f?.problemas).toHaveLength(1)
    expect(f?.buscadoEm).toBe('2026-09-18T12:00:00.000Z')
  })

  it('recusa versao diferente, planilha diferente e lixo', () => {
    expect(normalizarFoto({ ...foto, versao: 99 }, 'PLAN1')).toBeNull()
    expect(normalizarFoto({ ...foto, planilhaId: 'OUTRA' }, 'PLAN1')).toBeNull()
    expect(normalizarFoto(null, 'PLAN1')).toBeNull()
    expect(normalizarFoto('[]', 'PLAN1')).toBeNull()
    expect(normalizarFoto({ ...foto, posicoes: [] }, 'PLAN1')).toBeNull()
  })

  it('descarta a linha ruim e mantem as boas', () => {
    const f = normalizarFoto(
      { ...foto, posicoes: [pos({ lote: 'BOM' }), { lote: '', bags: 1 }, { lote: 'X' }, null] },
      'PLAN1',
    )
    expect(f?.posicoes.map((p) => p.lote)).toEqual(['BOM'])
  })
})
