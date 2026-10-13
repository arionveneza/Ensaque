import { describe, expect, it } from 'vitest'
import {
  alocacoesDaContagem, chaveInventario, compararInventario, conferenciaArmazens,
  inventarioPorArmazem, planoAplicacao, resumoConferenciaArmazens, situacaoDe,
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

describe('conferenciaArmazens (relatorio dos armazens x SAP, 13/10/2026)', () => {
  const saldos = [
    { lote: 'SV1', tratamento: 'SEM TSI', embalagem: 'BG5M', cultivar: 'X', bags: 30 },
    { lote: 'SV2', tratamento: 'FTZ60', embalagem: 'BG5M', cultivar: 'Y', bags: 10 },
    { lote: 'SV3', tratamento: 'SEM TSI', embalagem: 'BG5M', cultivar: 'Z', bags: 5 },
  ]
  const contagens = [
    { lote: 'SV1-1', tratamento: 'SEM TSI', embalagem: 'BG5M', armazem: 'A', bags: 20 },
    { lote: 'SV1', tratamento: 'SEM TSI', embalagem: 'BG5M', armazem: 'a', bags: 4 },
    { lote: 'SV1', tratamento: 'SEM TSI', embalagem: 'BG5M', armazem: 'B', bags: 6 },
    { lote: 'SV2', tratamento: 'FTZ60', embalagem: 'BG5M', armazem: 'C', bags: 7 },
    { lote: 'NOVO', tratamento: 'SEM TSI', embalagem: 'BG5M', armazem: 'B', bags: 2, descarte: true, cultivar: 'W' },
  ]

  it('soma por armazem e compara o total com o SAP', () => {
    const r = conferenciaArmazens(contagens, saldos)
    const sv1 = r.find((l) => l.lote === 'SV1')!
    expect(sv1.porArmazem).toEqual({ A: 24, B: 6 })
    expect(sv1).toMatchObject({ contado: 30, sistema: 30, situacao: 'bate', descarte: 0 })
    expect(r.find((l) => l.lote === 'SV2')).toMatchObject({ porArmazem: { C: 7 }, diferenca: -3, situacao: 'falta' })
    expect(r.find((l) => l.lote === 'SV3')).toMatchObject({ porArmazem: {}, contado: null, situacao: 'nao_contado' })
    expect(r.find((l) => l.lote === 'NOVO')).toMatchObject({ porArmazem: { B: 2 }, descarte: 2, situacao: 'fora_do_sap', cultivar: 'W' })
  })

  it('resumo: bags por situacao, por armazem e geral', () => {
    const res = resumoConferenciaArmazens(conferenciaArmazens(contagens, saldos))
    expect(res.porArmazem).toEqual({ A: 24, B: 8, C: 7 })
    expect(res).toMatchObject({ contado: 39, sistema: 45, diferenca: -6 })
    expect(res.porSituacao.bate).toEqual({ linhas: 1, bags: 30 })
    expect(res.porSituacao.falta).toEqual({ linhas: 1, bags: 3 })
    expect(res.porSituacao.nao_contado).toEqual({ linhas: 1, bags: 5 })
    expect(res.porSituacao.fora_do_sap).toEqual({ linhas: 1, bags: 2 })
  })

  it('inventarioPorArmazem: o mais recente COM lancamento vence o vazio mais novo', () => {
    const invs = [
      { id: 'a-vazio', armazem: 'A', criado_em: '2026-10-13T14:00:00Z', lancamentos: 0 },
      { id: 'a-contado', armazem: 'A', criado_em: '2026-10-13T11:00:00Z', lancamentos: 71 },
      { id: 'b-vazio', armazem: 'B', criado_em: '2026-10-13T15:00:00Z', lancamentos: 0 },
      { id: 'galpao', armazem: null, criado_em: '2026-10-13T16:00:00Z', lancamentos: 9 },
    ]
    expect(inventarioPorArmazem(invs, ['A', 'B', 'C'])).toEqual({ A: 'a-contado', B: 'b-vazio', C: null })
  })
})

describe('alocacoesDaContagem (grade do armazem de inventario, 13/10/2026)', () => {
  it('soma lancamentos do mesmo endereco, separa enderecos e ignora contagem zero', () => {
    const r = alocacoesDaContagem([
      { lote: 'sv1-1', tratamento: 'sem tsi', cultivar: 'X', embalagem: 'bg5m', armazem: 'c', bloco: '40', quadra: '19', bags: 5 },
      { lote: 'SV1', tratamento: 'SEM TSI', cultivar: null, embalagem: 'BG5M', armazem: 'C', bloco: '40', quadra: '19', bags: 2 },
      { lote: 'SV1', tratamento: 'SEM TSI', cultivar: 'X', embalagem: 'BG5M', armazem: 'C', bloco: '3', quadra: '2', bags: 4 },
      { lote: 'SV2', tratamento: 'SEM TSI', cultivar: 'Y', embalagem: 'BG5M', armazem: 'C', bloco: '1', quadra: '1', bags: 0 },
      { lote: 'SV3', tratamento: 'FTZ60', cultivar: 'Z', embalagem: 'BG5M', armazem: 'C', bloco: '2', quadra: '2', bags: 1, descarte: true },
    ])
    expect(r.map((a) => `${a.lote} ${a.bloco}·${a.quadra}=${a.bags}`)).toEqual([
      'SV3 2·2=1', 'SV1 3·2=4', 'SV1 40·19=7',
    ])
    expect(r.find((a) => a.bloco === '40')).toMatchObject({ cultivar: 'X', bagsCombinacao: 11, descarte: false })
    expect(r[0].descarte).toBe(true)
  })

  it('sem endereco completo nao vira celula', () => {
    expect(alocacoesDaContagem([
      { lote: 'A', tratamento: 'SEM TSI', embalagem: 'BG5M', armazem: 'C', bloco: null, quadra: '1', bags: 3 },
    ])).toEqual([])
  })
})

describe('planoAplicacao (aplicar no mapa = so enderecos)', () => {
  const mapa = [
    { lote: 'SV001', tratamento: 'SEM TSI' },
    { lote: 'SV002', tratamento: 'FTZ60' },
    { lote: 'SV003', tratamento: 'SEM TSI' },
  ]

  it('contada no mapa vira substituicao de enderecos, somando por endereco', () => {
    const p = planoAplicacao(
      [{ lote: 'SV001', tratamento: 'SEM TSI', bags_contados: 100 }],
      [
        { lote: 'SV001', tratamento: 'SEM TSI', armazem: 'A', bloco: 'B1', quadra: '4', bags: 60 },
        { lote: 'sv001-1', tratamento: 'sem tsi', armazem: 'a', bloco: 'b1', quadra: '4', bags: 30 },
        { lote: 'SV001', tratamento: 'SEM TSI', armazem: 'B', bloco: '', quadra: '', bags: 10 },
      ],
      mapa,
    )
    expect(p.enderecar).toHaveLength(1)
    const e = p.enderecar[0].enderecos
    expect(e).toHaveLength(2)
    expect(e.find((x) => x.armazem === 'A')!.bags).toBe(90)
    expect(e.find((x) => x.armazem === 'B')!.bags).toBe(10)
  })

  it('contada SEM linha no mapa vai pra semMapa; nao contada pra naoEncontrados', () => {
    const p = planoAplicacao(
      [
        { lote: 'SV999', tratamento: 'SEM TSI', bags_contados: 5 },
        { lote: 'SV003', tratamento: 'SEM TSI', bags_contados: null },
      ],
      [{ lote: 'SV999', tratamento: 'SEM TSI', armazem: 'A', bloco: null, quadra: null, bags: 5 }],
      mapa,
    )
    expect(p.semMapa).toEqual([{ lote: 'SV999', tratamento: 'SEM TSI' }])
    expect(p.naoEncontrados).toEqual([{ lote: 'SV003', tratamento: 'SEM TSI' }])
    expect(p.enderecar).toHaveLength(0)
  })

  it('lancamento com contagem zero nao vira endereco', () => {
    const p = planoAplicacao(
      [{ lote: 'SV002', tratamento: 'FTZ60', bags_contados: 0 }],
      [{ lote: 'SV002', tratamento: 'FTZ60', armazem: 'C', bloco: 'B2', quadra: '1', bags: 0 }],
      mapa,
    )
    expect(p.enderecar).toHaveLength(1)
    expect(p.enderecar[0].enderecos).toHaveLength(0)
  })

  it('contada numa embalagem e nao contada em outra fica nas DUAS listas (10/09/2026)', () => {
    // achada so e achada batendo lote+tratamento+EMBALAGEM: a parte contada
    // e enderecada E a combinacao segue marcada pela parte nao achada
    const p = planoAplicacao(
      [
        { lote: 'SV001', tratamento: 'SEM TSI', bags_contados: 50 },
        { lote: 'SV001', tratamento: 'SEM TSI', bags_contados: null },
      ],
      [{ lote: 'SV001', tratamento: 'SEM TSI', armazem: 'A', bloco: 'B1', quadra: '2', bags: 50 }],
      mapa,
    )
    expect(p.enderecar).toHaveLength(1)
    expect(p.naoEncontrados).toEqual([{ lote: 'SV001', tratamento: 'SEM TSI' }])
  })

  it('nao contada fora do mapa nao aparece em lugar nenhum (nada a marcar)', () => {
    const p = planoAplicacao(
      [{ lote: 'SVX', tratamento: 'V&P', bags_contados: null }],
      [],
      mapa,
    )
    expect(p.naoEncontrados).toHaveLength(0)
    expect(p.semMapa).toHaveLength(0)
  })
})
