import { describe, expect, it } from 'vitest'
import { MAX_COLUNAS, problemaNoCaminho, tabelaDe, textoCelula } from './sapTeste'

describe('problemaNoCaminho', () => {
  it('aceita caminho OData normal', () => {
    expect(problemaNoCaminho("Items?$select=ItemCode&$top=1")).toBeNull()
    expect(problemaNoCaminho("SQLQueries('TSI_SALDOS')/List")).toBeNull()
    expect(problemaNoCaminho("Orders?$filter=DocumentStatus eq 'bost_Open'")).toBeNull()
    // $crossjoin é OData válido e começa com $
    expect(problemaNoCaminho('$crossjoin(Items,Orders)')).toBeNull()
  })

  it('recusa vazio, URL absoluta, .. e barra inicial', () => {
    expect(problemaNoCaminho('')).not.toBeNull()
    expect(problemaNoCaminho('   ')).not.toBeNull()
    expect(problemaNoCaminho('https://outro.com/b1s/v1/Items')).not.toBeNull()
    expect(problemaNoCaminho('Items/../../etc')).not.toBeNull()
    expect(problemaNoCaminho('/Items')).not.toBeNull()
  })

  it('recusa bypass de path por encoding (%2e%2e) e backslash', () => {
    expect(problemaNoCaminho('Items/%2e%2e/%2e%2e/Login')).not.toBeNull()
    expect(problemaNoCaminho('Items\\..\\x')).not.toBeNull()
  })
})

describe('tabelaDe', () => {
  it('lê coleção OData ({ value: [...] })', () => {
    const t = tabelaDe({ value: [{ ItemCode: 'A', Nome: 'x' }, { ItemCode: 'B', Nome: 'y' }] })
    expect(t?.colunas).toEqual(['ItemCode', 'Nome'])
    expect(t?.linhas).toHaveLength(2)
  })

  it('lê array puro (resultado de SQLQueries)', () => {
    const t = tabelaDe([{ NumLote: 'SV1', QtdEstoque: 21 }])
    expect(t?.colunas).toEqual(['NumLote', 'QtdEstoque'])
  })

  it('colunas são a união de TODAS as linhas — campo nulo omitido lá no fim não some', () => {
    // a coluna B só aparece bem depois das 50 primeiras linhas
    const linhas = Array.from({ length: 60 }, (_, i) =>
      i === 59 ? { A: i, B: 'só na última' } : { A: i },
    )
    const t = tabelaDe({ value: linhas })
    expect(t?.colunas).toEqual(['A', 'B'])
  })

  it('ignora metadados odata.* e propriedades de navegação aninhadas', () => {
    const t = tabelaDe({
      value: [{ 'odata.etag': 'W/"x"', ItemCode: 'A', DocumentLines: [{ x: 1 }] }],
    })
    expect(t?.colunas).toEqual(['ItemCode'])
  })

  it('corta em MAX_COLUNAS e sinaliza colunasCortadas', () => {
    const larga: Record<string, number> = {}
    for (let i = 0; i < MAX_COLUNAS + 10; i++) larga[`c${i}`] = i
    const t = tabelaDe({ value: [larga] })
    expect(t?.colunas).toHaveLength(MAX_COLUNAS)
    expect(t?.colunasCortadas).toBe(true)
  })

  it('entidade única e escalar devolvem null (a tela mostra JSON cru)', () => {
    expect(tabelaDe({ ItemCode: 'A', ItemName: 'x' })).toBeNull()
    expect(tabelaDe('texto')).toBeNull()
    expect(tabelaDe(null)).toBeNull()
  })
})

describe('textoCelula', () => {
  it('null/undefined/vazio viram travessão', () => {
    expect(textoCelula(null)).toBe('—')
    expect(textoCelula(undefined)).toBe('—')
    expect(textoCelula('')).toBe('—')
  })

  it('número e texto ficam fiéis ao que o SAP mandou', () => {
    expect(textoCelula(16544.86841)).toBe('16544.86841')
    expect(textoCelula('tNO')).toBe('tNO')
  })

  it('objeto vira JSON', () => {
    expect(textoCelula({ a: 1 })).toBe('{"a":1}')
  })

  it('trunca valor gigante para não travar a renderização', () => {
    const grande = 'x'.repeat(500)
    const saida = textoCelula(grande)
    expect(saida.length).toBeLessThan(grande.length)
    expect(saida.endsWith('…')).toBe(true)
  })
})
