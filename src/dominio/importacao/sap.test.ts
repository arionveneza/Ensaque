import { describe, expect, it } from 'vitest'
import { converterSaldoSap, ehRelatorioSaldoSap } from './sap'
import type { Linha } from './simpleagro'

const CAB_SAP = [
  'Cultivar', 'Nº do Lote', 'Tratamento (TSI)', 'Embalagem', 'PMS (g)',
  'Data de Entrada', 'UM Estoque', 'Qtd em Estoque',
]

const CAB_SAP_COMPLETO = [...CAB_SAP, 'Peneira', 'Categoria do Lote']

/** Export real: a coluna "Peso Bruto" (peso do bag em kg) vem logo depois do PMS. */
const CAB_SAP_PB = [
  'Cultivar', 'Nº do Lote', 'Tratamento (TSI)', 'Embalagem', 'PMS (g)', 'Peso Bruto',
  'Data de Entrada', 'UM Estoque', 'Qtd em Estoque',
]

/** Embalagem crua igual à origem: BB5M/BMB — o de-para converte pra BG5M/MEIOBAG (mesmo código da SimpleAgro, confirmado pelo Arion). */
const linha = (
  cultivar: string, lote: string, tratamento: string, embalagem: string,
  pms: unknown, dataEntrada: string, um: string, qtd: number,
): Linha => [cultivar, lote, tratamento, embalagem, pms, dataEntrada, um, qtd] as Linha

/** Mesma linha, com a coluna "Peso Bruto" preenchida. */
const linhaPb = (
  lote: string, embalagem: string, pms: unknown, pesoBruto: unknown, qtd: number,
): Linha =>
  ['761 I2X', lote, 'SEM TSI', embalagem, pms, pesoBruto, '2026-02-10', 'SC', qtd] as Linha

/** Como o leitor de xlsx entrega uma célula formatada como data (UTC). */
const celulaData = (iso: string) => new Date(`${iso}T00:00:00Z`)

describe('deteccao do relatorio de saldos do SAP', () => {
  it('reconhece pelo cabecalho', () => {
    expect(ehRelatorioSaldoSap([CAB_SAP])).toBe(true)
    expect(ehRelatorioSaldoSap([['Outra', 'Coisa']])).toBe(false)
  })
})

describe('conversao de saldos do SAP', () => {
  it('SEM TSI vira lote de semente, com o peso do bag pelo PMS x fator da embalagem', () => {
    const r = converterSaldoSap([
      CAB_SAP,
      linha('761 I2X', 'SV001', 'SEM TSI', 'BB5M', 171, '2026-02-10', 'SC', 20),
    ])
    expect(r.lotes).toHaveLength(1)
    expect(r.lotes[0]).toMatchObject({ id: 'SV001', cultivar: '761 I2X', pesoBagKg: 855, bags: 20 })
    expect(r.estoquePa).toHaveLength(0)
  })

  it('BMB vira MEIOBAG com fator 2,5', () => {
    const r = converterSaldoSap([
      CAB_SAP,
      linha('761 I2X', 'SV002', 'SEM TSI', 'BMB', 171, '2026-02-10', 'SC', 10),
    ])
    expect(r.lotes[0].pesoBagKg).toBe(Math.round(171 * 2.5))
  })

  it('tratamento vazio tambem conta como SEM TSI', () => {
    const r = converterSaldoSap([
      CAB_SAP,
      linha('761 I2X', 'SV999', '', 'BB5M', 171, '2026-02-10', 'SC', 8),
    ])
    expect(r.lotes).toHaveLength(1)
    expect(r.lotes[0].tratamento).toBe('SEM TSI')
  })

  it('tratamento real vira estoque de produto acabado (BB5M -> BG5M)', () => {
    const r = converterSaldoSap([
      CAB_SAP,
      linha('761 I2X', 'SV003', 'FTZ60', 'BB5M', 171, '2026-02-10', 'SC', 15),
    ])
    expect(r.estoquePa).toHaveLength(1)
    expect(r.estoquePa[0]).toMatchObject({
      cultivar: '761 I2X', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 15,
    })
    expect(r.lotes).toHaveLength(0)
  })

  it('agrega o mesmo lote espalhado em varias linhas', () => {
    const r = converterSaldoSap([
      CAB_SAP,
      linha('761 I2X', 'SV004', 'SEM TSI', 'BB5M', 171, '2026-02-10', 'SC', 10),
      linha('761 I2X', 'SV004', 'SEM TSI', 'BB5M', 171, '2026-03-01', 'SC', 5),
    ])
    expect(r.lotes).toHaveLength(1)
    expect(r.lotes[0].bags).toBe(15)
  })

  it('ignora lote com entrada antes do corte de 01/01/2026', () => {
    const r = converterSaldoSap([
      CAB_SAP,
      linha('761 I2X', 'SV005', 'SEM TSI', 'BB5M', 171, '2025-12-31', 'SC', 20),
    ])
    expect(r.lotes).toHaveLength(0)
    expect(r.resumo.antesDoCorte).toBe(1)
  })

  it('ignora e reporta separadamente linha sem data de entrada legivel', () => {
    const r = converterSaldoSap([
      CAB_SAP,
      linha('761 I2X', 'SV006', 'SEM TSI', 'BB5M', 171, '', 'SC', 20),
    ])
    expect(r.lotes).toHaveLength(0)
    expect(r.resumo.dataInvalida).toBe(1)
    expect(r.resumo.antesDoCorte).toBe(0)
  })

  it('le data no formato brasileiro dia/mes/ano, nao mes/dia', () => {
    // 15/03/2026 tem dia > 12: se o parser confundisse mes/dia isso quebraria
    const depoisDoCorte = converterSaldoSap([
      CAB_SAP,
      linha('761 I2X', 'SV012', 'SEM TSI', 'BB5M', 171, '15/03/2026', 'SC', 20),
    ])
    expect(depoisDoCorte.lotes).toHaveLength(1)
    expect(depoisDoCorte.resumo.dataInvalida).toBe(0)

    const antesDoCorte = converterSaldoSap([
      CAB_SAP,
      linha('761 I2X', 'SV013', 'SEM TSI', 'BB5M', 171, '15/03/2025', 'SC', 20),
    ])
    expect(antesDoCorte.lotes).toHaveLength(0)
    expect(antesDoCorte.resumo.antesDoCorte).toBe(1)
    expect(antesDoCorte.resumo.dataInvalida).toBe(0)
  })

  it('ignora granel/pre-lote sem embalagem reconhecida', () => {
    const r = converterSaldoSap([
      CAB_SAP,
      linha('761 I2X', 'SV007', 'SEM TSI', '', 171, '2026-02-10', 'KG', 500),
    ])
    expect(r.lotes).toHaveLength(0)
    expect(r.resumo.granel).toBe(1)
  })

  it('saldo negativo fica de fora mas e reportado', () => {
    const r = converterSaldoSap([
      CAB_SAP,
      linha('761 I2X', 'SV008', 'SEM TSI', 'BB5M', 171, '2026-02-10', 'SC', -3),
    ])
    expect(r.lotes).toHaveLength(0)
    expect(r.resumo.negativos).toEqual([{ lote: 'SV008', bags: -3 }])
  })

  it('sinaliza lote sem PMS', () => {
    const r = converterSaldoSap([
      CAB_SAP,
      linha('761 I2X', 'SV009', 'SEM TSI', 'BB5M', 0, '2026-02-10', 'SC', 20),
    ])
    expect(r.resumo.semPms).toBe(1)
    expect(r.lotes[0].pesoBagKg).toBe(0)
  })

  it('PMS com 3 casas decimais (texto do SAP) não vira milhar', () => {
    // achado do Arion, 12/09/2026: "150.150" (a coluna do banco é
    // numeric(8,3), o SAP às vezes manda 3 casas) virava 150150 pelo
    // num() genérico e estourava a importação inteira
    const r = converterSaldoSap([
      CAB_SAP,
      ['761 I2X', 'SV019', 'SEM TSI', 'BB5M', '150.150', '2026-02-10', 'SC', 20],
    ])
    expect(r.lotes[0].pms).toBeCloseTo(150.15)
    expect(r.resumo.semPms).toBe(0)
  })

  it('PMS implausível (origem corrompida) é tratado como ausente, não estoura a importação', () => {
    const r = converterSaldoSap([
      CAB_SAP,
      linha('761 I2X', 'SV020', 'SEM TSI', 'BB5M', 150150, '2026-02-10', 'SC', 20),
    ])
    expect(r.lotes[0].pms).toBe(0)
    expect(r.lotes[0].pesoBagKg).toBe(0)
    expect(r.resumo.semPms).toBe(1)
  })

  // 12/09/2026 — o export do SAP manda a coluna PMS em formatos misturados
  // (texto, número, data, vazio) e 6 lotes com saldo entraram sem peso. O
  // peso do bag também vem pronto em "Peso Bruto", que bateu com PMS × fator
  // em 100% das 1.137 linhas do export de 10/09/2026.
  describe('PMS ilegível na coluna própria', () => {
    it('célula em formato de data vira PMS pelo serial do Excel', () => {
      const r = converterSaldoSap([
        CAB_SAP,
        linha('761 I2X', 'SV021', 'SEM TSI', 'BB5M', celulaData('1900-07-19'), '2026-02-10', 'SC', 21),
      ])
      expect(r.lotes[0].pms).toBe(201)
      expect(r.lotes[0].pesoBagKg).toBe(1005)
      expect(r.resumo.semPms).toBe(0)
      expect(r.resumo.pmsRecuperado).toBe(0)
    })

    it('número fora de escala cai no Peso Bruto e é contado como recuperado', () => {
      // A267672319-2: célula 1208880, Peso Bruto 604,44 -> PMS 120,888
      const r = converterSaldoSap([CAB_SAP_PB, linhaPb('SV022', 'BB5M', 1208880, 604.44, 7)])
      expect(r.lotes[0].pms).toBeCloseTo(120.888)
      expect(r.lotes[0].pesoBagKg).toBe(604)
      expect(r.resumo.semPms).toBe(0)
      expect(r.resumo.pmsRecuperado).toBe(1)
    })

    it('célula vazia também cai no Peso Bruto', () => {
      const r = converterSaldoSap([CAB_SAP_PB, linhaPb('SV023', 'BB5M', null, 1013, 5)])
      expect(r.lotes[0].pms).toBeCloseTo(202.6)
      expect(r.resumo.pmsRecuperado).toBe(1)
    })

    it('Peso Bruto vale em MEIOBAG, com o fator 2,5', () => {
      const r = converterSaldoSap([CAB_SAP_PB, linhaPb('SV024', 'BMB', '', 512.5, 4)])
      expect(r.lotes[0].pms).toBeCloseTo(205)
      expect(r.lotes[0].pesoBagKg).toBe(513)
    })

    it('PMS legível manda: o Peso Bruto é só a rede', () => {
      const r = converterSaldoSap([CAB_SAP_PB, linhaPb('SV025', 'BB5M', '171', 855, 3)])
      expect(r.lotes[0].pms).toBe(171)
      expect(r.resumo.pmsRecuperado).toBe(0)
    })

    it('Peso Bruto que daria PMS implausível não é usado', () => {
      const r = converterSaldoSap([CAB_SAP_PB, linhaPb('SV026', 'BB5M', 0, 9_000_000, 3)])
      expect(r.lotes[0].pms).toBe(0)
      expect(r.lotes[0].pesoBagKg).toBe(0)
      expect(r.resumo.semPms).toBe(1)
    })

    it('sem PMS e sem Peso Bruto continua sendo lote sem peso', () => {
      const r = converterSaldoSap([CAB_SAP_PB, linhaPb('SV027', 'BB5M', '', '', 3)])
      expect(r.lotes[0].pesoBagKg).toBe(0)
      expect(r.resumo.semPms).toBe(1)
      expect(r.resumo.pmsRecuperado).toBe(0)
    })
  })

  it('registra as unidades vistas, pra alertar se misturar bag e kg', () => {
    const r = converterSaldoSap([
      CAB_SAP,
      linha('761 I2X', 'SV010', 'SEM TSI', 'BB5M', 171, '2026-02-10', 'SC', 10),
      linha('761 I2X', 'SV011', 'SEM TSI', 'BB5M', 171, '2026-02-10', 'KG', 10),
    ])
    expect(r.resumo.unidades).toEqual({ SC: 1, KG: 1 })
  })

  it('corrige tratamento grafado diferente no SAP (VeP -> V&P), senao nunca casa com o pedido', () => {
    const r = converterSaldoSap([
      CAB_SAP,
      linha('761 I2X', 'SV014', 'VeP', 'BB5M', 171, '2026-02-10', 'SC', 12),
    ])
    expect(r.estoquePa).toHaveLength(1)
    expect(r.estoquePa[0].tratamento).toBe('V&P')
  })

  it('grava peneira e categoria do lote quando as colunas existem (etiqueta DM)', () => {
    const r = converterSaldoSap([
      CAB_SAP_COMPLETO,
      [...linha('761 I2X', 'SV017', 'SEM TSI', 'BB5M', 171, '2026-02-10', 'SC', 20), 'P 6.75 mm', 'S2'],
    ])
    expect(r.lotes[0]).toMatchObject({ peneira: 'P 6.75 mm', categoria: 'S2' })
  })

  it('sem as colunas de peneira/categoria (export antigo), ficam null', () => {
    const r = converterSaldoSap([
      CAB_SAP,
      linha('761 I2X', 'SV018', 'SEM TSI', 'BB5M', 171, '2026-02-10', 'SC', 20),
    ])
    expect(r.lotes[0]).toMatchObject({ peneira: null, categoria: null })
  })

  it('tolera caixa diferente na correcao de tratamento (vep, VEP)', () => {
    const r = converterSaldoSap([
      CAB_SAP,
      linha('761 I2X', 'SV015', 'vep', 'BB5M', 171, '2026-02-10', 'SC', 5),
      linha('761 I2X', 'SV016', 'VEP', 'BB5M', 171, '2026-02-10', 'SC', 5),
    ])
    // mesma combinacao apos a correcao: agrega numa linha so
    expect(r.estoquePa).toHaveLength(1)
    expect(r.estoquePa[0]).toMatchObject({ tratamento: 'V&P', bags: 10 })
  })
})
