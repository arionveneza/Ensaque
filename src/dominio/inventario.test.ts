import { describe, expect, it } from 'vitest'
import {
  chaveInventario, compararInventario, situacaoDe,
} from './inventario'

describe('chave de comparacao', () => {
  it('normaliza sufixo, caixa e espacos — com a embalagem na chave', () => {
    expect(chaveInventario(' sv089-1-2 ', ' ftz60 ', 'bg5m')).toBe('SV089|FTZ60|BG5M')
    expect(chaveInventario('SV089', 'FTZ60', 'BG5M')).toBe('SV089|FTZ60|BG5M')
  })
})

describe('situacao', () => {
  it('tolera centesimo, como as travas de saldo', () => {
    expect(situacaoDe(100, 100)).toBe('bate')
    expect(situacaoDe(100.01, 100)).toBe('bate')
    expect(situacaoDe(100.02, 100)).toBe('sobra')
    expect(situacaoDe(99.98, 100)).toBe('falta')
  })

  it('distingue nao contado de contado-zero', () => {
    expect(situacaoDe(null, 50)).toBe('nao_contado')
    expect(situacaoDe(0, 50)).toBe('falta')
    expect(situacaoDe(5, null)).toBe('fora_do_sap')
  })
})

describe('compararInventario', () => {
  const sap = [
    { lote: 'SV001', tratamento: 'SEM TSI', embalagem: 'BG5M', cultivar: '761 I2X', bags: 100 },
    { lote: 'SV002', tratamento: 'FTZ60', embalagem: 'BG5M', cultivar: 'O820 IPRO', bags: 40 },
    { lote: 'SV003', tratamento: 'SEM TSI', embalagem: 'BG5M', cultivar: '761 I2X', bags: 10 },
  ]

  it('lancamentos repetidos da mesma combinacao SOMAM (um por endereco)', () => {
    const linhas = compararInventario(
      [
        { lote: 'SV001', tratamento: 'SEM TSI', embalagem: 'BG5M', bags: 60 },
        { lote: 'sv001-1', tratamento: 'sem tsi', embalagem: 'bg5m', bags: 40 },
      ],
      sap,
    )
    const l = linhas.find((x) => x.lote === 'SV001')!
    expect(l.contado).toBe(100)
    expect(l.situacao).toBe('bate')
    expect(l.cultivar).toBe('761 I2X')
  })

  it('classifica sobra, falta, nao contado e fora do SAP', () => {
    const linhas = compararInventario(
      [
        { lote: 'SV001', tratamento: 'SEM TSI', embalagem: 'BG5M', bags: 90 },
        { lote: 'SV002', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 45 },
        { lote: 'SV999', tratamento: 'SEM TSI', embalagem: 'BG5M', cultivar: 'NEO680', bags: 5 },
      ],
      sap,
    )
    const por = (lote: string) => linhas.find((x) => x.lote === lote)!
    expect(por('SV001').situacao).toBe('falta')
    expect(por('SV001').diferenca).toBe(-10)
    expect(por('SV002').situacao).toBe('sobra')
    expect(por('SV002').diferenca).toBe(5)
    expect(por('SV003').situacao).toBe('nao_contado')
    expect(por('SV003').contado).toBeNull()
    expect(por('SV999').situacao).toBe('fora_do_sap')
    expect(por('SV999').sistema).toBeNull()
    // cultivar do lancamento manual aparece na linha fora do SAP
    expect(por('SV999').cultivar).toBe('NEO680')
  })

  it('contado zero e "contei e esta vazio", nao ausencia', () => {
    const linhas = compararInventario(
      [{ lote: 'SV003', tratamento: 'SEM TSI', embalagem: 'BG5M', bags: 0 }],
      sap,
    )
    const l = linhas.find((x) => x.lote === 'SV003')!
    expect(l.contado).toBe(0)
    expect(l.situacao).toBe('falta')
    expect(l.diferenca).toBe(-10)
  })

  it('o mesmo lote branco e tratado sao linhas separadas', () => {
    const linhas = compararInventario(
      [
        { lote: 'SV010', tratamento: 'SEM TSI', embalagem: 'BG5M', bags: 20 },
        { lote: 'SV010', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 8 },
      ],
      [
        { lote: 'SV010', tratamento: 'SEM TSI', embalagem: 'BG5M', cultivar: 'X', bags: 20 },
        { lote: 'SV010', tratamento: 'FTZ60', embalagem: 'BG5M', cultivar: 'X', bags: 10 },
      ],
    )
    expect(linhas).toHaveLength(2)
    expect(linhas.find((x) => x.tratamento === 'SEM TSI')!.situacao).toBe('bate')
    expect(linhas.find((x) => x.tratamento === 'FTZ60')!.situacao).toBe('falta')
  })

  it('embalagens diferentes do mesmo lote sao linhas separadas', () => {
    const linhas = compararInventario(
      [{ lote: 'SV020', tratamento: 'SEM TSI', embalagem: 'BG5M', bags: 10 }],
      [
        { lote: 'SV020', tratamento: 'SEM TSI', embalagem: 'BG5M', cultivar: 'X', bags: 10 },
        { lote: 'SV020', tratamento: 'SEM TSI', embalagem: 'MEIOBAG', cultivar: 'X', bags: 4 },
      ],
    )
    expect(linhas).toHaveLength(2)
    expect(linhas.find((x) => x.embalagem === 'BG5M')!.situacao).toBe('bate')
    expect(linhas.find((x) => x.embalagem === 'MEIOBAG')!.situacao).toBe('nao_contado')
  })

  it('sufixos do SAP tambem somam no base', () => {
    const linhas = compararInventario(
      [{ lote: 'SV030', tratamento: 'SEM TSI', embalagem: 'BG5M', bags: 30 }],
      [
        { lote: 'SV030-1', tratamento: 'SEM TSI', embalagem: 'BG5M', cultivar: 'X', bags: 10 },
        { lote: 'SV030-2', tratamento: 'SEM TSI', embalagem: 'BG5M', cultivar: 'X', bags: 20 },
      ],
    )
    expect(linhas).toHaveLength(1)
    expect(linhas[0].sistema).toBe(30)
    expect(linhas[0].situacao).toBe('bate')
  })

  it('divergencia vem antes de "bate" na ordenacao', () => {
    const linhas = compararInventario(
      [
        { lote: 'SV001', tratamento: 'SEM TSI', embalagem: 'BG5M', bags: 100 },
        { lote: 'SV002', tratamento: 'FTZ60', embalagem: 'BG5M', bags: 50 },
      ],
      sap,
    )
    const situacoes = linhas.map((l) => l.situacao)
    expect(situacoes.indexOf('sobra')).toBeLessThan(situacoes.indexOf('bate'))
    expect(situacoes.indexOf('nao_contado')).toBeLessThan(situacoes.indexOf('bate'))
  })
})
