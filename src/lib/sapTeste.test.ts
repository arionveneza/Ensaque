import { describe, expect, it } from 'vitest'
import {
  MAX_COLUNAS,
  caminhoSaldoLotes,
  entidadeDe,
  partesDoNome,
  problemaNoCaminho,
  relatorioComPedido,
  resumoItem,
  saldoLoteDe,
  tabelaDe,
  textoCelula,
} from './sapTeste'

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

describe('entidadeDe', () => {
  it('separa campos escalares de coleções aninhadas (Items com depósitos)', () => {
    const e = entidadeDe({
      ItemCode: 'SOJ00012',
      QuantityOnStock: 1997,
      'odata.etag': 'W/"x"',
      ItemWarehouseInfoCollection: [
        { WarehouseCode: 'VEN_GER', InStock: 1977, Committed: 661 },
        { WarehouseCode: '01', InStock: 0, Committed: 0 },
      ],
    })
    expect(e?.campos).toEqual([['ItemCode', 'SOJ00012'], ['QuantityOnStock', 1997]])
    expect(e?.colecoes).toHaveLength(1)
    expect(e?.colecoes[0].nome).toBe('ItemWarehouseInfoCollection')
    expect(e?.colecoes[0].tabela.colunas).toEqual(['WarehouseCode', 'InStock', 'Committed'])
    expect(e?.colecoes[0].tabela.linhas).toHaveLength(2)
  })

  it('devolve null para coleção ({ value: [...] }) — isso é trabalho do tabelaDe', () => {
    expect(entidadeDe({ value: [{ ItemCode: 'A' }] })).toBeNull()
  })

  it('devolve null para array solto, escalar ou null', () => {
    expect(entidadeDe([{ a: 1 }])).toBeNull()
    expect(entidadeDe('texto')).toBeNull()
    expect(entidadeDe(null)).toBeNull()
  })

  it('coleção vazia não aparece, mas não quebra (fica só com os campos)', () => {
    const e = entidadeDe({ ItemCode: 'A', ItemWarehouseInfoCollection: [] })
    expect(e?.campos).toEqual([['ItemCode', 'A']])
    expect(e?.colecoes).toEqual([])
  })

  it('objeto só com coleção (sem campo escalar) ainda é reconhecido', () => {
    const e = entidadeDe({ Linhas: [{ x: 1 }] })
    expect(e?.campos).toEqual([])
    expect(e?.colecoes).toHaveLength(1)
  })
})

describe('partesDoNome', () => {
  it('semente branca: "SS <cultivar> <embalagem>"', () => {
    expect(partesDoNome('SS NEO680 IPRO BB5M')).toEqual({
      cultivar: 'NEO680 IPRO',
      embalagem: 'BB5M',
      tratado: false,
    })
  })

  it('semente TRATADA termina em "TSI" — sem isso "TSI" seria lido como embalagem', () => {
    expect(partesDoNome('SS NA7337 RR BB5M TSI')).toEqual({
      cultivar: 'NA7337 RR',
      embalagem: 'BB5M',
      tratado: true,
    })
  })

  it('nome curto (2 tokens ou menos) não tem miolo — cultivar vazio, sem quebrar', () => {
    expect(partesDoNome('SS BB5M')).toEqual({ cultivar: '', embalagem: 'BB5M', tratado: false })
    expect(partesDoNome('BB5M')).toEqual({ cultivar: '', embalagem: 'BB5M', tratado: false })
  })
})

describe('resumoItem', () => {
  const itemBase = {
    ItemCode: 'SOJ00012',
    ItemName: 'SS 761 I2X BB5M',
    QuantityOnStock: 1997,
    ItemWarehouseInfoCollection: [
      { WarehouseCode: 'VEN_GER', InStock: 1977, Committed: 661 },
      { WarehouseCode: 'VCS_GER', InStock: 0, Committed: 2 }, // zerado — não aparece na lista, mas soma no total
      { WarehouseCode: 'VEN_DM', InStock: 20, Committed: 0 },
    ],
  }

  it('separa depósitos com saldo e soma o Committed de TODOS (até o zerado) pro total em pedidos', () => {
    const r = resumoItem(itemBase)
    expect(r?.cultivar).toBe('761 I2X')
    expect(r?.porArmazem).toEqual([
      { armazem: 'VEN_GER', saldo: 1977, comprometido: 661 },
      { armazem: 'VEN_DM', saldo: 20, comprometido: 0 },
    ])
    expect(r?.totalPedidos).toBe(663) // 661 + 2 (do zerado) + 0 — não é só a soma dos que aparecem na lista
    expect(r?.saldoTotal).toBe(1997)
    expect(r?.saldoFinal).toBe(1334) // 1997 - 663
  })

  it('sem nenhum depósito comprometido, saldo final = saldo total', () => {
    const item = { ...itemBase, ItemWarehouseInfoCollection: [{ WarehouseCode: 'X', InStock: 50, Committed: 0 }] }
    const r = resumoItem(item)
    expect(r?.totalPedidos).toBe(0)
    expect(r?.saldoFinal).toBe(r?.saldoTotal)
  })

  it('sem ItemWarehouseInfoCollection, ainda reconhece o item (só sem depósitos)', () => {
    const r = resumoItem({ ItemCode: 'X', ItemName: 'SS X BB5M', QuantityOnStock: 10 })
    expect(r?.porArmazem).toEqual([])
    expect(r?.totalPedidos).toBe(0)
    expect(r?.saldoFinal).toBe(10)
  })

  it('devolve null se não reconhecer um ItemCode na resposta', () => {
    expect(resumoItem({ foo: 'bar' })).toBeNull()
    expect(resumoItem('texto')).toBeNull()
    expect(resumoItem(null)).toBeNull()
  })
})

describe('relatorioComPedido', () => {
  const comPedidoBB5M = {
    ItemCode: 'SOJ00012',
    ItemName: 'SS 761 I2X BB5M',
    QuantityOnStock: 1997,
    ItemWarehouseInfoCollection: [{ WarehouseCode: 'VEN_GER', InStock: 1977, Committed: 754 }],
  }
  const semPedido = {
    ItemCode: 'SOJ00009',
    ItemName: 'SS O790 IPRO BB5M',
    QuantityOnStock: 500,
    ItemWarehouseInfoCollection: [{ WarehouseCode: 'VEN_GER', InStock: 500, Committed: 0 }],
  }
  // achado real de 09/08/2026: item de granel, "embalagem" não é BB5M/BMB
  const granelComPedido = {
    ItemCode: 'SOJ00001',
    ItemName: 'SOJA GRAO ORIUNDO DO CAMPO DE SEMENTES/DESTINADO SEMENTES',
    QuantityOnStock: 27340586.02,
    ItemWarehouseInfoCollection: [{ WarehouseCode: 'VEN_GER', InStock: 27340586.02, Committed: 18711 }],
  }

  it('só lista item com pedido (Committed > 0) e embalagem reconhecida, ordenado do maior déficit', () => {
    const outroComPedido = {
      ItemCode: 'SOJ00002',
      ItemName: 'SS NEO680 IPRO BB5M',
      QuantityOnStock: 754,
      ItemWarehouseInfoCollection: [{ WarehouseCode: 'VEN_GER', InStock: 754, Committed: 909 }], // saldoFinal -155
    }
    const r = relatorioComPedido([comPedidoBB5M, semPedido, granelComPedido, outroComPedido], 'SOJ')
    expect(r.totalLido).toBe(4)
    expect(r.itens.map((i) => i.itemCode)).toEqual(['SOJ00002', 'SOJ00012']) // -155 antes de +1243
    expect(r.ignorados).toBe(1) // o granel tinha pedido mas embalagem não reconhecida
  })

  it('item de granel com pedido é contado em ignorados, não aparece na lista', () => {
    const r = relatorioComPedido([granelComPedido], 'SOJ')
    expect(r.itens).toEqual([])
    expect(r.ignorados).toBe(1)
  })

  it('sem nenhum item com pedido, lista vazia e ignorados zero', () => {
    const r = relatorioComPedido([semPedido], 'SOJ')
    expect(r.itens).toEqual([])
    expect(r.ignorados).toBe(0)
    expect(r.totalLido).toBe(1)
  })

  it('item não reconhecível (resumoItem devolveria null) não entra em totalLido nem quebra', () => {
    const r = relatorioComPedido([comPedidoBB5M, { foo: 'bar' }, 'texto'], 'SOJ')
    expect(r.totalLido).toBe(1)
    expect(r.itens).toHaveLength(1)
  })
})

describe('caminhoSaldoLotes', () => {
  it('é a TSI_SALDOS sem parâmetro nenhum — parâmetro na query string vira %27 no fetch', () => {
    expect(caminhoSaldoLotes()).toBe("SQLQueries('TSI_SALDOS')/List")
  })
})

describe('saldoLoteDe', () => {
  // linhas como a TSI_SALDOS devolve: colunas com os ALIASES do SQL
  const saldoDeVariosLotes = {
    value: [
      { ItemCode: 'SOJ00012', 'Nº do Lote': 'SV1', 'PMS (g)': '171.00', 'Tratamento (TSI)': null, 'Depósito': 'VEN_GER', 'Qtd em Estoque': 100 },
      { ItemCode: 'SOJ00012', 'Nº do Lote': 'SV1', 'PMS (g)': '171.00', 'Tratamento (TSI)': null, 'Depósito': 'VEN_TER1', 'Qtd em Estoque': 50 },
      { ItemCode: 'SOJ00099', 'Nº do Lote': 'SV2', 'PMS (g)': '160.00', 'Tratamento (TSI)': 'FORTENZA DUO 60', 'Depósito': 'VEN_GER', 'Qtd em Estoque': 999 },
    ],
  }

  it('filtra por Nº do Lote, soma a quantidade entre depósitos e ignora outros lotes', () => {
    const r = saldoLoteDe(saldoDeVariosLotes, 'SV1')
    expect(r).toEqual({
      loteId: 'SV1',
      encontrados: 2,
      totalLinhasSaldo: 3,
      amostraBatchNum: ['SV1', 'SV2'],
      itemCodes: ['SOJ00012'],
      quantidadeTotal: 150,
      pms: 171,
      tratamentoSap: null,
    })
  })

  it('lê PMS e tratamento das linhas do próprio lote (uma chamada só, sem BatchNumberDetails)', () => {
    const r = saldoLoteDe(saldoDeVariosLotes, 'SV2')
    expect(r.pms).toBe(160)
    expect(r.tratamentoSap).toBe('FORTENZA DUO 60')
    expect(r.quantidadeTotal).toBe(999)
  })

  it('lote sem linha na TSI_SALDOS (esgotado/inexistente): encontrados 0, sem quebrar', () => {
    const r = saldoLoteDe(saldoDeVariosLotes, 'SV-INEXISTENTE')
    expect(r.encontrados).toBe(0)
    expect(r.totalLinhasSaldo).toBe(3)
    expect(r.quantidadeTotal).toBe(0)
    expect(r.pms).toBeNull()
  })

  it('busca vazia (0 linhas no total) — diferente de "não bateu" com dados existentes', () => {
    const r = saldoLoteDe({ value: [] }, 'SV1')
    expect(r.totalLinhasSaldo).toBe(0)
    expect(r.amostraBatchNum).toEqual([])
  })

  it('resposta sem value (erro/formato inesperado) não quebra — trata como 0 linhas', () => {
    expect(saldoLoteDe(null, 'SV1').encontrados).toBe(0)
    expect(saldoLoteDe({}, 'SV1').encontrados).toBe(0)
  })

  it('fallback pros nomes crus das colunas, caso o Service Layer não aplique os aliases', () => {
    const r = saldoLoteDe(
      [{ ItemCode: 'SOJ00012', DistNumber: 'SV1', U_AGRT_PMS: '171.00', U_LoteTSI: 'SEM TSI', Quantity: 20 }],
      'SV1',
    )
    expect(r.encontrados).toBe(1)
    expect(r.quantidadeTotal).toBe(20)
    expect(r.pms).toBe(171)
    expect(r.tratamentoSap).toBe('SEM TSI')
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
