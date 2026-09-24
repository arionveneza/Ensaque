import { describe, expect, it } from 'vitest'
import { calcularEstoqueFuturo, type BalancoFuturo, type ItemCarregar } from './estoqueFuturo'

const EMB = new Set(['BG5M', 'MEIOBAG'])
const bal = (c: Partial<BalancoFuturo> = {}): BalancoFuturo => ({
  cultivar: 'O790 IPRO', tratamento: 'FTZ60', embalagem: 'BG5M', estoque_pa: 0, planejado_confirmado: 0, ...c,
})
const item = (c: Partial<ItemCarregar> = {}): ItemCarregar => ({
  numero_carga: '894', status_carga: 'Agendado', data_carga: '2026-09-24',
  cultivar: 'O790 IPRO', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 10, ...c,
})
const calc = (b: BalancoFuturo[], i: ItemCarregar[], ate = '') =>
  calcularEstoqueFuturo(b, i, { ate, embalagensConhecidas: EMB })

describe('estoque futuro = estoque + planejado − A carregar', () => {
  it('soma estoque e planejado e desconta o A carregar', () => {
    const { linhas } = calc([bal({ estoque_pa: 30, planejado_confirmado: 20 })], [item({ bags: 35 })])
    expect(linhas).toHaveLength(1)
    expect(linhas[0]).toMatchObject({ estoque: 30, planejado: 20, aCarregar: 35, futuro: 15 })
  })

  it('sem montagem, é o estoque + planejado de antes', () => {
    const { linhas } = calc([bal({ estoque_pa: 30, planejado_confirmado: 20 })], [])
    expect(linhas[0]).toMatchObject({ aCarregar: 0, futuro: 50, cargas: [] })
  })

  it('produto só na montagem (sem estoque nem plano) aparece negativo', () => {
    const { linhas } = calc([], [item({ cultivar: 'NEO700 I2X', bags: 12 })])
    expect(linhas).toEqual([expect.objectContaining({ cultivar: 'NEO700 I2X', futuro: -12 })])
  })

  it('casa grafias diferentes do mesmo tratamento e cultivar (FTZ60 S × FTZ 60 S, caixa)', () => {
    const { linhas } = calc(
      [bal({ tratamento: 'FTZ60 S', estoque_pa: 40 })],
      [item({ tratamento: 'ftz 60 s', cultivar: 'o790  ipro', bags: 15 })],
    )
    expect(linhas).toHaveLength(1)
    expect(linhas[0].futuro).toBe(25)
  })

  it('embalagem é estrita: MEIOBAG não abate BG5M', () => {
    const { linhas } = calc([bal({ estoque_pa: 40 })], [item({ embalagem: 'MEIOBAG', bags: 15 })])
    expect(linhas.map((l) => [l.embalagem, l.futuro]).sort()).toEqual([['BG5M', 40], ['MEIOBAG', -15]])
  })

  it('duas linhas do balanço com a mesma chave normalizada viram uma', () => {
    const { linhas } = calc(
      [bal({ tratamento: 'FTZ60 S', estoque_pa: 10 }), bal({ tratamento: 'FTZ 60 S', planejado_confirmado: 5 })],
      [],
    )
    expect(linhas).toHaveLength(1)
    expect(linhas[0]).toMatchObject({ estoque: 10, planejado: 5, futuro: 15 })
  })

  it('linha sem estoque, sem plano e sem carga não aparece', () => {
    expect(calc([bal()], []).linhas).toHaveLength(0)
  })
})

describe('estoque futuro — data da carga', () => {
  const itens = [
    item({ numero_carga: '1', data_carga: '2026-09-23', bags: 5 }),
    item({ numero_carga: '2', data_carga: '2026-09-25', bags: 7 }),
    item({ numero_carga: '3', data_carga: '2026-10-01', bags: 11 }),
    item({ numero_carga: '4', data_carga: null, bags: 2 }),
  ]

  it('sem data escolhida, conta todas as cargas', () => {
    const { linhas, resumo } = calc([bal({ estoque_pa: 100 })], itens)
    expect(linhas[0].aCarregar).toBe(25)
    expect(resumo.depois.bags).toBe(0)
  })

  it('até o dia escolhido é cumulativo (inclui o dia) e a carga sem data entra sempre', () => {
    const { linhas, resumo } = calc([bal({ estoque_pa: 100 })], itens, '2026-09-25')
    expect(linhas[0].aCarregar).toBe(14)
    expect(linhas[0].futuro).toBe(86)
    expect(resumo.depois).toEqual({ itens: 1, bags: 11 })
    expect(resumo.semData).toEqual({ itens: 1, bags: 2 })
  })

  it('lista as cargas do produto, sem data primeiro e por data', () => {
    const { linhas } = calc([bal({ estoque_pa: 100 })], itens, '2026-09-25')
    expect(linhas[0].cargas.map((c) => c.carga)).toEqual(['4', '1', '2'])
  })

  it('itens da mesma carga somam numa linha de carga', () => {
    const { linhas } = calc([], [item({ bags: 2 }), item({ bags: 10 }), item({ bags: 23 })])
    expect(linhas[0].cargas).toEqual([expect.objectContaining({ carga: '894', bags: 35 })])
  })
})

describe('estoque futuro — o que fica fora', () => {
  it('SEM TSI não entra (nem do balanço, nem da montagem)', () => {
    const { linhas, resumo } = calc(
      [bal({ tratamento: 'SEM TSI', estoque_pa: 50 })],
      [item({ tratamento: 'SEM TSI', bags: 30 })],
    )
    expect(linhas).toHaveLength(0)
    expect(resumo.semTsi).toEqual({ itens: 1, bags: 30 })
  })

  it('branca e sem de-para depois do dia não entram no "depois" (cada bag num balde só)', () => {
    const { resumo } = calc(
      [],
      [
        item({ tratamento: 'SEM TSI', data_carga: '2026-10-01', bags: 30 }),
        item({ embalagem: 'BIGBAG', data_carga: '2026-10-01', bags: 9 }),
        item({ data_carga: '2026-10-01', bags: 4 }),
      ],
      '2026-09-30',
    )
    expect(resumo.depois).toEqual({ itens: 1, bags: 4 })
    expect(resumo.semTsi.bags).toBe(0)
    expect(resumo.embalagemDesconhecida.bags).toBe(0)
  })

  it('embalagem sem de-para fica fora e é reportada', () => {
    const { linhas, resumo } = calc([], [item({ embalagem: 'BIGBAG', bags: 9 })])
    expect(linhas).toHaveLength(0)
    expect(resumo.embalagemDesconhecida).toEqual({ itens: 1, bags: 9, codigos: ['BIGBAG'] })
  })

  it('ordena por quem vai faltar primeiro', () => {
    const { linhas } = calc(
      [bal({ cultivar: 'A', estoque_pa: 50 }), bal({ cultivar: 'B', estoque_pa: 5 })],
      [item({ cultivar: 'B', bags: 20 })],
    )
    expect(linhas.map((l) => l.cultivar)).toEqual(['B', 'A'])
  })

  it('não muta as entradas', () => {
    const b = [bal({ estoque_pa: 10 })]
    const i = [item()]
    const antes = JSON.stringify([b, i])
    calc(b, i, '2026-09-30')
    expect(JSON.stringify([b, i])).toBe(antes)
  })
})
