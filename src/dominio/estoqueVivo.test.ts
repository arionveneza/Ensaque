import { describe, expect, it } from 'vitest'
import { estoqueVivo, type AlocacaoEstoque, type LoteEstoque } from './estoqueVivo'

const lote = (p: Partial<LoteEstoque> & Pick<LoteEstoque, 'lote' | 'tratamento' | 'bags'>): LoteEstoque => ({
  cultivar: 'NEO680 IPRO',
  embalagem: 'BG5M',
  pms: 171,
  peso_bag_kg: 855,
  destinacao: null,
  classificacao: null,
  peneira: null,
  categoria: null,
  nao_encontrado_inventario_em: null,
  lote_enderecos: [],
  ...p,
})

const aloc = (
  l: LoteEstoque,
  armazem: string,
  bloco: string,
  quadra: string,
  bags: number,
  estimado = false,
): AlocacaoEstoque => ({ lote: l, endereco: { armazem, bloco, quadra, bags }, bags, estimado })

describe('estoque vivo do mapa (19/10/2026)', () => {
  it('reparte o saldo por armazém, TSI e sem endereço, e soma o resumo', () => {
    const branca = lote({ lote: 'SV1', tratamento: 'SEM TSI', bags: 30 })
    const tratada = lote({ lote: 'SV1', tratamento: 'FTZ60', bags: 19, cultivar: 'NEO680 IPRO' })
    const solta = lote({ lote: 'SV2', tratamento: 'V&P', bags: 4, cultivar: 'NEO791 I2X', embalagem: 'MEIOBAG', peso_bag_kg: 375 })
    const { linhas, resumo } = estoqueVivo(
      [tratada, solta, branca],
      [
        aloc(branca, 'A', '3', '5', 10),
        aloc(branca, 'TSI ENTRADA', '0', '0', 15),
        aloc(tratada, 'TSI SAIDA', '0', '0', 19),
      ],
    )
    // ordem: cultivar → branca antes do tratado → lote
    expect(linhas.map((l) => `${l.cultivar}|${l.tratamento}|${l.lote}`)).toEqual([
      'NEO680 IPRO|SEM TSI|SV1',
      'NEO680 IPRO|FTZ60|SV1',
      'NEO791 I2X|V&P|SV2',
    ])
    const [b, t, s] = linhas
    expect(b.porArmazem).toEqual({ A: 10, B: 0, C: 0, D: 0, E: 0 })
    expect(b.tsiEntrada).toBe(15)
    expect(b.semEndereco).toBe(5) // 30 − 10 − 15
    expect(b.kg).toBe(30 * 855)
    expect(b.enderecos).toBe('A 3 Q05: 10 · TSI Entrada: 15')
    expect(t.tsiSaida).toBe(19)
    expect(t.semEndereco).toBe(0)
    expect(s.semEndereco).toBe(4)
    expect(s.enderecos).toBe('')
    expect(s.kg).toBe(1500)

    expect(resumo.combinacoes).toBe(3)
    expect(resumo.bags).toBe(53)
    expect(resumo.kg).toBe(30 * 855 + 19 * 855 + 1500)
    expect(resumo.porArmazem).toEqual({ A: 10, B: 0, C: 0, D: 0, E: 0 })
    expect(resumo.tsiEntrada).toBe(15)
    expect(resumo.tsiSaida).toBe(19)
    expect(resumo.semEndereco).toBe(9)
    expect(resumo.branca).toBe(30)
    expect(resumo.tratada).toBe(23)
    expect(resumo.aguardandoContagem).toBe(0)
  })

  it('rateio marca estimado com "~" e arredonda em 2 casas; endereço que soma mais que o saldo não vira negativo', () => {
    const l = lote({ lote: 'SV3', tratamento: 'SEM TSI', bags: 10 })
    const { linhas } = estoqueVivo(
      [l],
      [aloc(l, 'B', '11', '3', 3.3333, true), aloc(l, 'B', '12', '3', 3.3333, true), aloc(l, 'C', '1', '1', 3.3334, true)],
    )
    expect(linhas[0].estimado).toBe(true)
    expect(linhas[0].porArmazem.B).toBe(6.67)
    expect(linhas[0].porArmazem.C).toBe(3.33)
    expect(linhas[0].semEndereco).toBe(0)
    expect(linhas[0].enderecos).toBe('B 11 Q03: ~3,33 · B 12 Q03: ~3,33 · C 1 Q01: ~3,33')

    const m = lote({ lote: 'SV4', tratamento: 'SEM TSI', bags: 5 })
    const r = estoqueVivo([m], [aloc(m, 'A', '1', '1', 8)])
    expect(r.linhas[0].semEndereco).toBe(0)
  })

  it('combinação marcada como não encontrada entra sinalizada', () => {
    const l = lote({ lote: 'SV5', tratamento: 'FTZ60', bags: 2, nao_encontrado_inventario_em: '2026-10-05T10:00:00Z' })
    const { linhas, resumo } = estoqueVivo([l], [])
    expect(linhas[0].aguardandoContagem).toBe(true)
    expect(resumo.aguardandoContagem).toBe(1)
  })
})
