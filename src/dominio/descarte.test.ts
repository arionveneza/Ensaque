import { describe, expect, it } from 'vitest'
import { candidatosDescarte, ehDescarte, resumoDescarte, type LoteDescartavel } from './descarte'

const l = (p: Partial<LoteDescartavel> & Pick<LoteDescartavel, 'lote'>): LoteDescartavel => ({
  tratamento: 'SEM TSI',
  cultivar: 'NEO680 IPRO',
  bags: 5,
  destinacao: null,
  descarte_em: null,
  ...p,
})

describe('descarte no mapa (03/11/2026)', () => {
  it('reconhece descarte em qualquer grafia e só nela', () => {
    expect(ehDescarte('DESCARTE')).toBe(true)
    expect(ehDescarte(' Descarte ')).toBe(true)
    expect(ehDescarte('Restrito')).toBe(false)
    expect(ehDescarte(null)).toBe(false)
    expect(ehDescarte(undefined)).toBe(false)
  })

  it('candidatos: com saldo, não descarte, não escolhidos, casando a busca sem acento', () => {
    const lotes = [
      l({ lote: 'SV1', cultivar: 'NEO680 IPRO' }),
      l({ lote: 'SV2', tratamento: 'FTZ60', cultivar: 'O790 IPRO' }),
      l({ lote: 'SV3', destinacao: 'DESCARTE' }),
      l({ lote: 'SV4', bags: 0 }),
      l({ lote: 'SV5', tratamento: 'V&P', cultivar: 'Ólimpo 1' }),
    ]
    expect(candidatosDescarte(lotes, '', []).map((x) => x.lote)).toEqual(['SV1', 'SV2', 'SV5'])
    expect(candidatosDescarte(lotes, 'ftz', []).map((x) => x.lote)).toEqual(['SV2'])
    expect(candidatosDescarte(lotes, 'olimpo', []).map((x) => x.lote)).toEqual(['SV5'])
    expect(candidatosDescarte(lotes, '', [{ lote: 'SV1', tratamento: 'SEM TSI' }]).map((x) => x.lote)).toEqual(['SV2', 'SV5'])
    // o mesmo lote com outro tratamento é outra combinação
    expect(candidatosDescarte(lotes, 'sv2', [{ lote: 'SV2', tratamento: 'SEM TSI' }]).map((x) => x.lote)).toEqual(['SV2'])
    expect(candidatosDescarte(lotes, '', [], 2)).toHaveLength(2)
  })

  it('resumo conta só quem tem saldo e separa as marcadas à mão', () => {
    const r = resumoDescarte([
      l({ lote: 'A', bags: 10, destinacao: 'DESCARTE', descarte_em: '2026-11-03T10:00:00Z' }),
      l({ lote: 'B', bags: 2.5, destinacao: 'Descarte' }),
      l({ lote: 'C', bags: 0, destinacao: 'DESCARTE' }),
      l({ lote: 'D', bags: 7, destinacao: 'Restrito' }),
    ])
    expect(r).toEqual({ lotes: 2, bags: 12.5, manuais: 1 })
  })
})
