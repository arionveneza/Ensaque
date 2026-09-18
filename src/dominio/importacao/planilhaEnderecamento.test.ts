import { describe, expect, it } from 'vitest'
import {
  CAMPOS_PA,
  acharCabecalho,
  converterLinhas,
  letraDaColuna,
  montarConsulta,
} from './planilhaEnderecamento'

/**
 * Topo real da aba "Lote PA" (18/09/2026), com o que ele tem de traiçoeiro:
 * quatro linhas de sujeira antes do cabeçalho (com #REF!), `Destinação do
 * lote ` com espaço no fim, e `AZ`/`saldo` repetidos lá na frente, nas
 * colunas auxiliares de fórmula.
 */
const CABECALHO = [
  'DATA', 'Produtor:', 'Destinação do lote ', 'Tratamento', '', 'CULTIVAR', '', 'LOTES', 'CLASSE',
  'Resultado Boletim', 'LIBERADO P/ TSI', 'PLANILHA TSI', 'STATUS', 'AZ', 'BLOCO', 'QUADRA',
  'Umidade de Ensaque%', 'Dano Mecânico ', 'Peneira', 'Categoria', 'PMS', 'EMBALAGEM',
  'Peso Embalagem', 'Estimativa total peso BG', 'Quantidade de BAG', 'EXPEDIDO ', 'SALDO',
  'EMPENHOS SALDO', 'BIG BAG utilizado', 'Responsável pelo Ensaque ', 'OBSERVAÇÃO ', 'BLOCOQUADRA',
  'id ', 'CONT', 'AZ', 'BL (LIN(A1)', 'QD (LIN(A1)', 'saldo', 'AZ', 'BL (LIN(A2)', 'QD (LIN(A2)', 'saldo',
]

const TOPO = [
  ['', '', '', '', '', '', '', '', '', '', '', '', 'F', '', '0586', '#REF!'],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Inventário'],
  [''],
  ['', '', '', '', '', '', '', '', '', '', '', '', 'RETORNO SG', 'ENDEREÇO', '', '', '#ERROR!'],
  CABECALHO,
]

describe('letraDaColuna', () => {
  it('converte indice em letra de coluna do Google', () => {
    expect(letraDaColuna(0)).toBe('A')
    expect(letraDaColuna(25)).toBe('Z')
    expect(letraDaColuna(26)).toBe('AA')
    expect(letraDaColuna(51)).toBe('AZ')
    expect(letraDaColuna(52)).toBe('BA')
  })
})

describe('acharCabecalho', () => {
  const cab = acharCabecalho(TOPO, CAMPOS_PA)

  it('descobre a linha do cabecalho, que nao e a primeira', () => {
    expect(cab.linha).toBe(4)
    expect(cab.faltando).toEqual([])
  })

  it('casa nome com espaco no fim e com acento', () => {
    expect(cab.colunas.destinacao).toBe(2)
  })

  it('nome repetido: vence a PRIMEIRA ocorrencia', () => {
    // AZ aparece 3x e saldo 2x; as outras são colunas auxiliares de fórmula
    expect(cab.colunas.armazem).toBe(13) // N, não a auxiliar lá na frente
    expect(cab.colunas.bags).toBe(26) // AA
  })

  it('mapeia o resto como esperado', () => {
    expect(cab.colunas).toMatchObject({
      data: 0, tratamento: 3, cultivar: 5, lote: 7, classe: 8, status: 12, bloco: 14, quadra: 15,
    })
  })

  it('a coluna auxiliar "saldo" minuscula NAO rouba o lugar da SALDO de verdade', () => {
    // `saldo` existe duas vezes nas colunas de fórmula, bem à frente da AA
    expect(cab.colunas.bags).toBe(26)
  })

  it('acusa coluna obrigatoria que sumiu, dizendo o que achou', () => {
    const semQuadra = acharCabecalho([CABECALHO.filter((c) => c !== 'QUADRA')], CAMPOS_PA)
    expect(semQuadra.faltando).toEqual(['quadra'])
    expect(semQuadra.nomesVistos).toContain('BLOCO')
  })

  it('planilha sem nada reconhecivel devolve linha -1', () => {
    expect(acharCabecalho([['a', 'b'], ['c', 'd']], CAMPOS_PA).linha).toBe(-1)
  })
})

describe('montarConsulta', () => {
  const consulta = montarConsulta(acharCabecalho(TOPO, CAMPOS_PA))

  it('sai na ordem das colunas, com o filtro no servidor', () => {
    expect(consulta.select).toBe('A,C,D,F,H,I,M,N,O,P,AA')
    expect(consulta.where).toBe('H is not null and AA > 0')
    expect(consulta.ordem[0]).toBe('data')
    expect(consulta.ordem.at(-1)).toBe('bags')
  })

  it('segunda tentativa vai sem o filtro de saldo', () => {
    const sem = montarConsulta(acharCabecalho(TOPO, CAMPOS_PA), { semFiltroSaldo: true })
    expect(sem.where).toBe('H is not null')
    expect(sem.select).toBe(consulta.select)
  })
})

describe('converterLinhas', () => {
  const consulta = montarConsulta(acharCabecalho(TOPO, CAMPOS_PA))
  // ordem: data, destinacao, tratamento, cultivar, lote, classe, status, armazem, bloco, quadra, bags
  const linha = (c: string[]) => c.map((x) => `"${x}"`).join(',')

  it('converte a linha real, com numero em pt-BR', () => {
    const { posicoes } = converterLinhas(
      linha(['20/01/2026', '', 'FTZ60 + VIC', 'NEO700 I2X', 'SV0011036060002', 'A', '', 'A', '29A', '1', '27']),
      consulta,
    )
    expect(posicoes).toHaveLength(1)
    expect(posicoes[0]).toMatchObject({
      lote: 'SV0011036060002', tratamento: 'FTZ60 + VIC', cultivar: 'NEO700 I2X',
      armazem: 'A', bloco: '29A', quadra: '1', bags: 27, data: '20/01/2026',
    })
  })

  it('linha SEM data entra (o filtro e lote + saldo, nunca data)', () => {
    // foi exatamente isso que escondeu 3 lotes do 1º relatório (18/09/2026)
    const { posicoes } = converterLinhas(
      linha(['', '', 'SEM TRATAMENTO', 'NEO 680 IPRO', '11149P1630', '', '', 'C', '20C', '4', '14']),
      consulta,
    )
    expect(posicoes.map((p) => p.lote)).toEqual(['11149P1630'])
  })

  it('lote vazio sai; saldo zerado sai mas e contado', () => {
    const csv = [
      linha(['20/01/2026', '', '', '', '', '', '', 'A', '01A', '1', '10']),
      linha(['20/01/2026', '', '', '', 'SV002', '', '', 'A', '01A', '2', '0']),
      linha(['20/01/2026', '', '', '', 'SV003', '', '', 'A', '01A', '3', '5']),
    ].join('\n')
    const { posicoes, zeradas } = converterLinhas(csv, consulta)
    expect(posicoes.map((p) => p.lote)).toEqual(['SV003'])
    expect(zeradas).toBe(1)
  })

  it('incluirZerados traz o saldo zero de volta', () => {
    const csv = linha(['', '', '', '', 'SV002', '', '', 'A', '01A', '2', '0'])
    expect(converterLinhas(csv, consulta, { incluirZerados: true }).posicoes).toHaveLength(1)
  })

  it('numero brasileiro: ponto e milhar, virgula e decimal', () => {
    const csv = linha(['', '', '', '', 'SV004', '', '', 'A', '01A', '1', '1.234'])
    expect(converterLinhas(csv, consulta).posicoes[0].bags).toBe(1234)
  })

  it('saldo ilegivel vira problema, nao linha', () => {
    const csv = linha(['', '', '', '', 'SV005', '', '', 'A', '01A', '1', '#REF!'])
    const { posicoes, problemas } = converterLinhas(csv, consulta)
    expect(posicoes).toHaveLength(0)
    expect(problemas[0].motivo).toContain('saldo ilegível')
  })

  it('bloco 5D e 05D caem no mesmo bloco; espaco sobrando some', () => {
    const csv = [
      linha(['', '', '', '', 'SVa', '', '', 'D ', '5D', '1', '10']),
      linha(['', '', '', '', 'SVb', '', '', 'd', ' 05D ', '2', '10']),
    ].join('\n')
    const { posicoes } = converterLinhas(csv, consulta)
    expect(posicoes.map((p) => p.bloco)).toEqual(['05D', '05D'])
    expect(posicoes.map((p) => p.armazem)).toEqual(['D', 'D'])
  })

  it('linha identica repetida soma os bags e vira problema', () => {
    const l = linha(['', '', 'FTZ60', '', 'SV006', '', '', 'A', '01A', '1', '10'])
    const { posicoes, problemas } = converterLinhas([l, l].join('\n'), consulta)
    expect(posicoes).toHaveLength(1)
    expect(posicoes[0].bags).toBe(20)
    expect(posicoes[0].linhasSomadas).toBe(2)
    expect(problemas.some((p) => p.motivo.includes('repetida'))).toBe(true)
  })

  it('mesmo lote em enderecos diferentes continua sendo duas linhas', () => {
    const csv = [
      linha(['', '', 'FTZ60', '', 'SV007', '', '', 'A', '01A', '1', '10']),
      linha(['', '', 'FTZ60', '', 'SV007', '', '', 'B', '02B', '3', '7']),
    ].join('\n')
    expect(converterLinhas(csv, consulta).posicoes).toHaveLength(2)
  })

  it('endereco incompleto e quadra de texto viram problema nomeado', () => {
    const csv = [
      linha(['', '', '', '', 'SV008', '', '', '', '', '', '7']),
      linha(['', '', '', '', 'SV009', '', '', 'D', 'CORREDOR', 'CORREDOR', '9']),
    ].join('\n')
    const { problemas } = converterLinhas(csv, consulta)
    expect(problemas.find((p) => p.lote === 'SV008')?.motivo).toContain('armazém')
    expect(problemas.find((p) => p.lote === 'SV009')?.motivo).toContain('não é número')
  })
})
