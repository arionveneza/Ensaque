import { describe, expect, it } from 'vitest'
import { converterSaldoSap, ehRelatorioSaldoSap } from './sap'
import type { Linha } from './simpleagro'

const CAB_SAP = [
  'Cultivar', 'Nº do Lote', 'Tratamento (TSI)', 'Embalagem', 'PMS (g)',
  'Data de Entrada', 'UM Estoque', 'Qtd em Estoque',
]

const CAB_SAP_COMPLETO = [...CAB_SAP, 'Peneira', 'Categoria do Lote']

/** Embalagem crua igual à origem: BB5M/BMB — o de-para converte pra BG5M/MEIOBAG (mesmo código da SimpleAgro, confirmado pelo Arion). */
const linha = (
  cultivar: string, lote: string, tratamento: string, embalagem: string,
  pms: number, dataEntrada: string, um: string, qtd: number,
): Linha => [cultivar, lote, tratamento, embalagem, pms, dataEntrada, um, qtd]

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
