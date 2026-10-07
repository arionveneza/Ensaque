import { describe, expect, it } from 'vitest'
import {
  AJUSTE_FICHA_ZERO, CAPACIDADE_FICHA, LAYOUTS_FICHA, LIMITE_AJUSTE_MM, MODELO_FICHA_PADRAO,
  aplicarAjusteFicha, concentracaoFicha, linhasAjusteDoModelo,
  doseFicha, fonteCelulaFicha, mmDePontos, montarFichaQuimicos, normalizarAjusteFicha, proximaRotacao,
  rotacaoSugeridaEtiqueta, type ItemFicha, type PrincipioFicha,
} from './fichaQuimicos'

const LAYOUT = LAYOUTS_FICHA.retrato

describe('aplicarAjusteFicha: ajuste por impressora somado ao padrão', () => {
  it('ajuste zero devolve o layout igual', () => {
    expect(aplicarAjusteFicha(LAYOUT, AJUSTE_FICHA_ZERO)).toEqual(LAYOUT)
  })

  it('cada seção desloca só a sua linha; x desloca todas as colunas', () => {
    const a = aplicarAjusteFicha(LAYOUT, { ...AJUSTE_FICHA_ZERO, fungicida: -2, outros: 3, receita: 1, x: -1 })
    expect(a.top).toEqual({ inseticida: 116, fungicida: 149, nematicida: 184, inoculante: 211, outros: 243 })
    expect(a.receita).toEqual({ left: 57, top: 91, largura: 48, altura: 9 })
    expect(a.biologicos).toEqual({ left: 163, top: 90, largura: 48, altura: 9 })
    expect(a.colunas.map((c) => c.left)).toEqual([9, 57, 105, 163])
    expect(a.colunasOutros.map((c) => c.left)).toEqual([7.5, 72.5, 147.5])
    // a etiqueta acompanha o x geral, sem ajuste próprio
    expect(a.etiqueta).toEqual({ left: 9, top: 14 })
    // pura: o padrão não muda
    expect(LAYOUT.top.fungicida).toBe(151)
    expect(LAYOUT.colunas[0].left).toBe(10)
  })

  it('etiqueta do lote tem vertical e horizontal próprios, somados ao x geral', () => {
    const a = aplicarAjusteFicha(LAYOUT, { ...AJUSTE_FICHA_ZERO, etiqueta: -3, etiquetaX: 2, x: 1 })
    expect(a.etiqueta).toEqual({ left: 13, top: 11 })
    // o resto não mexe com o ajuste da etiqueta
    expect(a.receita).toEqual({ left: 59, top: 90, largura: 48, altura: 9 })
    expect(a.top.inseticida).toBe(116)
  })

  it('papel sem campo de receita: o ajuste de receita não cria o campo', () => {
    const a = aplicarAjusteFicha(LAYOUTS_FICHA.paisagem, { ...AJUSTE_FICHA_ZERO, receita: 5, x: 2 })
    expect(a.receita).toBeNull()
    expect(a.biologicos.left).toBeCloseTo(171.7)
  })
})

describe('os dois papéis (25/09/2026: o novo é deitado)', () => {
  it('o antigo continua exatamente como foi calibrado em 12/09', () => {
    expect(LAYOUTS_FICHA.retrato.pagina).toEqual({ largura: 212, altura: 320 })
    expect(LAYOUTS_FICHA.retrato.colunas).toEqual([
      { left: 10, largura: 48 }, { left: 58, largura: 48 }, { left: 106, largura: 48 }, { left: 164, largura: 48 },
    ])
    expect(LAYOUTS_FICHA.retrato.colunasOutros).toEqual([
      { left: 8.5, largura: 65 }, { left: 73.5, largura: 65 }, { left: 148.5, largura: 65 },
    ])
    expect(LAYOUTS_FICHA.retrato.capacidade).toEqual(CAPACIDADE_FICHA)
  })

  it('o novo é deitado, sem receita, com 2 linhas por seção e 3 em OUTROS', () => {
    const L = LAYOUTS_FICHA.paisagem
    expect(L.pagina).toEqual({ largura: 320, altura: 212 })
    expect(L.receita).toBeNull()
    expect(L.capacidade).toEqual({ inseticida: 2, fungicida: 2, nematicida: 2, inoculante: 2, outros: 3 })
    expect(MODELO_FICHA_PADRAO).toBe('paisagem')
  })

  it('no novo tudo cabe na folha e nada se sobrepõe', () => {
    const L = LAYOUTS_FICHA.paisagem
    const secoes = ['inseticida', 'fungicida', 'nematicida', 'inoculante', 'outros'] as const
    // seções em ordem, a última linha de uma acaba antes da 1ª da seguinte
    for (let i = 0; i < secoes.length - 1; i++) {
      const fimSecao = L.top[secoes[i]] + L.capacidade[secoes[i]] * L.altura[secoes[i]]
      expect(fimSecao).toBeLessThanOrEqual(L.top[secoes[i + 1]])
    }
    const fimOutros = L.top.outros + L.capacidade.outros * L.altura.outros
    expect(fimOutros).toBeLessThanOrEqual(L.pagina.altura)
    // colunas encostadas, dentro da folha
    for (const cols of [L.colunas, L.colunasOutros]) {
      for (let i = 0; i < cols.length - 1; i++) {
        expect(cols[i].left + cols[i].largura).toBeLessThanOrEqual(cols[i + 1].left + 0.01)
      }
      const ult = cols[cols.length - 1]
      expect(ult.left + ult.largura).toBeLessThanOrEqual(L.pagina.largura)
    }
    // a etiqueta fica à esquerda da tabela
    expect(L.etiqueta.left + L.etiquetaPadrao.largura).toBeLessThan(L.colunas[0].left)
  })

  it('o painel de ajuste esconde "Receita" no papel que não tem receita', () => {
    expect(linhasAjusteDoModelo('paisagem').some((l) => l.chave === 'receita')).toBe(false)
    expect(linhasAjusteDoModelo('retrato').some((l) => l.chave === 'receita')).toBe(true)
  })

  it('a capacidade do papel novo leva nematicida/inoculante extra pra própria seção, não pra OUTROS', () => {
    const nem = (produto: string): ItemFicha => ({
      produto, unidade: 'ml/kg', dose: 1,
      principios: [{ nome: 'Abamectina', concentracao: 500, unidadeConc: 'g/L', classe: 'Nematicida' }],
    })
    const antigo = montarFichaQuimicos('R', [nem('A'), nem('B')])
    expect(antigo.secoes.nematicida.map((l) => l.produto)).toEqual(['A'])
    expect(antigo.outros.map((l) => l.produto)).toEqual(['B'])
    const novo = montarFichaQuimicos('R', [nem('A'), nem('B')], LAYOUTS_FICHA.paisagem.capacidade)
    expect(novo.secoes.nematicida.map((l) => l.produto)).toEqual(['A', 'B'])
    expect(novo.outros).toEqual([])
  })
})

describe('etiqueta do lote em PDF: medidas e giro', () => {
  it('converte pontos em mm — a etiqueta do SimpleAgro (207 × 283 pt) é 73 × 100 mm', () => {
    expect(mmDePontos(207)).toBe(73)
    expect(mmDePontos(283)).toBe(99.8)
    expect(mmDePontos(72)).toBe(25.4)
  })

  it('página de pé (etiqueta exportada girada) sugere 90°; deitada não gira', () => {
    expect(rotacaoSugeridaEtiqueta(207, 283)).toBe(90)
    expect(rotacaoSugeridaEtiqueta(283, 207)).toBe(0)
    expect(rotacaoSugeridaEtiqueta(200, 200)).toBe(0)
  })

  it('girar dá a volta completa', () => {
    expect(proximaRotacao(0)).toBe(90)
    expect(proximaRotacao(90)).toBe(180)
    expect(proximaRotacao(270)).toBe(0)
  })
})

describe('normalizarAjusteFicha: o que vem do navegador', () => {
  it('campo faltando, lixo e nulo viram 0; número em texto é aceito', () => {
    expect(normalizarAjusteFicha({ fungicida: '2', outros: 'abc', x: null })).toEqual({
      ...AJUSTE_FICHA_ZERO, fungicida: 2,
    })
    // ajuste salvo ANTES da etiqueta existir (sem as chaves novas) continua válido
    expect(normalizarAjusteFicha({ receita: 1 }).etiqueta).toBe(0)
    expect(normalizarAjusteFicha({ receita: 1 }).etiquetaX).toBe(0)
    expect(normalizarAjusteFicha(null)).toEqual(AJUSTE_FICHA_ZERO)
  })

  it('limita ao intervalo e arredonda pra mm inteiro', () => {
    const a = normalizarAjusteFicha({ inseticida: 999, receita: -999, outros: 1.6 })
    expect(a.inseticida).toBe(LIMITE_AJUSTE_MM)
    expect(a.receita).toBe(-LIMITE_AJUSTE_MM)
    expect(a.outros).toBe(2)
  })
})

const p = (
  nome: string,
  classe: PrincipioFicha['classe'],
  concentracao: number | null = 25,
  unidadeConc: PrincipioFicha['unidadeConc'] = 'g/L',
): PrincipioFicha => ({ nome, classe, concentracao, unidadeConc })

const item = (produto: string, principios: PrincipioFicha[], dose = 2, unidade: ItemFicha['unidade'] = 'ml/kg'): ItemFicha =>
  ({ produto, principios, dose, unidade })

describe('doseFicha: sempre na base de 100 kg de semente', () => {
  it('ml/kg e g/kg multiplicam por 100', () => {
    expect(doseFicha(2, 'ml/kg')).toBe('200 mL/100 kg')
    expect(doseFicha(1.5, 'g/kg')).toBe('150 g/100 kg')
  })

  it('ml/100kg e g/100kg passam direto', () => {
    expect(doseFicha(200, 'ml/100kg')).toBe('200 mL/100 kg')
    expect(doseFicha(150, 'g/100kg')).toBe('150 g/100 kg')
  })

  it('formata em pt-BR, até 2 casas', () => {
    expect(doseFicha(0.125, 'ml/kg')).toBe('12,5 mL/100 kg')
  })
})

describe('concentracaoFicha', () => {
  it('mesma unidade junta os valores e põe a unidade uma vez', () => {
    expect(concentracaoFicha([p('A', 'Fungicida', 25), p('B', 'Fungicida', 10)])).toBe('25 + 10 g/L')
  })

  it('unidades diferentes: cada uma com a sua', () => {
    expect(
      concentracaoFicha([p('A', 'Fungicida', 25, 'g/L'), p('B', 'Fungicida', 40, '%')]),
    ).toBe('25 g/L + 40 %')
  })

  it('sem concentração cadastrada fica vazio', () => {
    expect(concentracaoFicha([p('A', 'Fungicida', null)])).toBe('')
  })
})

describe('montarFichaQuimicos', () => {
  it('cada produto cai na seção da classe do princípio, com dose por 100 kg', () => {
    const f = montarFichaQuimicos('FTZ60', [
      item('FORTENZA', [p('Ciantraniliprole', 'Inseticida', 600)]),
      item('MAXIM XL', [p('Fludioxonil', 'Fungicida', 25), p('Metalaxil-M', 'Fungicida', 10)], 1),
    ])
    expect(f.receita).toBe('FTZ60')
    expect(f.secoes.inseticida).toEqual([
      { produto: 'FORTENZA', principio: 'Ciantraniliprole', concentracao: '600 g/L', dosagem: '200 mL/100 kg' },
    ])
    expect(f.secoes.fungicida).toEqual([
      { produto: 'MAXIM XL', principio: 'Fludioxonil + Metalaxil-M', concentracao: '25 + 10 g/L', dosagem: '100 mL/100 kg' },
    ])
    expect(f.outros).toEqual([])
    expect(f.biologicos).toBe('NÃO')
  })

  it('produto com duas classes aparece nas duas seções, cada uma com os seus princípios', () => {
    const f = montarFichaQuimicos('STK', [
      item('STANDAK TOP', [
        p('Fipronil', 'Inseticida', 250),
        p('Piraclostrobina', 'Fungicida', 25),
        p('Tiofanato-metílico', 'Fungicida', 225),
      ]),
    ])
    expect(f.secoes.inseticida).toHaveLength(1)
    expect(f.secoes.inseticida[0].principio).toBe('Fipronil')
    expect(f.secoes.fungicida).toHaveLength(1)
    expect(f.secoes.fungicida[0].principio).toBe('Piraclostrobina + Tiofanato-metílico')
    expect(f.secoes.fungicida[0].concentracao).toBe('25 + 225 g/L')
  })

  it('biológico dá SIM e vai pra OUTROS com o rótulo da classe', () => {
    const f = montarFichaQuimicos('BIO', [item('RIZOLIQ', [p('Bradyrhizobium', 'Biologico', null)])])
    expect(f.biologicos).toBe('SIM')
    expect(f.outros).toEqual([{ produto: 'RIZOLIQ', informacoes: 'Biológico · Bradyrhizobium', dosagem: '200 mL/100 kg' }])
  })

  it('inoculante fica na seção INOCULANTE e marca BIOLÓGICOS: SIM (Rizoliq)', () => {
    const f = montarFichaQuimicos('R', [
      item('RIZOLIQ LLI', [p('Bradyrhizobium 7×10⁹ UFC/mL', 'Inoculante', null)], 250, 'ml/100kg'),
    ])
    expect(f.secoes.inoculante).toEqual([
      { produto: 'RIZOLIQ LLI', principio: 'Bradyrhizobium 7×10⁹ UFC/mL', concentracao: '', dosagem: '250 mL/100 kg' },
    ])
    expect(f.biologicos).toBe('SIM')
  })

  it('nematicida biológico (Bacillus) NÃO marca SIM — só inoculante e classe Biologico', () => {
    const f = montarFichaQuimicos('L', [item('LUMIALZA', [p('Bacillus amyloliquefaciens', 'Nematicida', 270)])])
    expect(f.secoes.nematicida).toHaveLength(1)
    expect(f.biologicos).toBe('NÃO')
  })

  it('classe Outros vai pra OUTROS sem rótulo redundante', () => {
    const f = montarFichaQuimicos('X', [item('GRAFITE', [p('Grafite', 'Outros', null)], 100, 'g/100kg')])
    expect(f.outros[0].informacoes).toBe('Grafite')
    expect(f.outros[0].dosagem).toBe('100 g/100 kg')
  })

  it('estourou a seção (papel só tem 1 linha de nematicida) → excedente vai pra OUTROS com a classe', () => {
    const f = montarFichaQuimicos('N', [
      item('NEMA A', [p('Abamectina', 'Nematicida', 500)]),
      item('NEMA B', [p('Fluopiram', 'Nematicida', 500)]),
    ])
    expect(f.secoes.nematicida.map((l) => l.produto)).toEqual(['NEMA A'])
    expect(f.outros).toEqual([
      { produto: 'NEMA B', informacoes: 'Nematicida · Fluopiram 500 g/L', dosagem: '200 mL/100 kg' },
    ])
  })

  it('sem princípio cadastrado: OUTROS sem informação e entra no aviso', () => {
    const f = montarFichaQuimicos('X', [item('MISTERIO', [])])
    expect(f.semPrincipio).toEqual(['MISTERIO'])
    expect(f.outros).toEqual([{ produto: 'MISTERIO', informacoes: '', dosagem: '200 mL/100 kg' }])
  })

  it('OUTROS também tem limite (o papel tem 5 linhas): o que passa vira aviso, não some calado', () => {
    const n = CAPACIDADE_FICHA.outros
    const itens = Array.from({ length: n + 2 }, (_, i) => item(`P${i}`, [p(`X${i}`, 'Outros', null)]))
    const f = montarFichaQuimicos('X', itens)
    expect(n).toBe(5)
    expect(f.outros).toHaveLength(n)
    expect(f.naoCouberam).toEqual([`P${n}`, `P${n + 1}`])
  })
})

describe('fonteCelulaFicha: a letra segue a altura da linha (07/10/2026)', () => {
  const P = LAYOUTS_FICHA.paisagem
  it('papel deitado: 8,5 pt nas seções, 6,8 em OUTROS, 10,1 no BIOLÓGICO', () => {
    expect(fonteCelulaFicha('FORTENZA 600 FS', P.colunas[0].largura, P.altura.inseticida)).toEqual({ pt: 8.5, quebra: false })
    expect(fonteCelulaFicha('KELMAX RN BR', P.colunasOutros[0].largura, P.altura.outros)).toEqual({ pt: 6.8, quebra: false })
    expect(fonteCelulaFicha('SIM', P.biologicos.largura, P.biologicos.altura)).toEqual({ pt: 10.1, quebra: false })
  })

  it('fonte menor cabe mais letra antes de quebrar; o par Fluidus + Disco Black ainda quebra em 6,7', () => {
    // 25 caracteres: a 10,5 pt quebrava (22 cabiam em 49 mm); a 8,5 cabe numa linha
    expect(fonteCelulaFicha('Bacillus amyloliquefacie', P.colunas[1].largura, P.altura.nematicida).quebra).toBe(false)
    expect(fonteCelulaFicha('FLUIDUS F047 PO SECANTE + DISCO BLACK', P.colunasOutros[0].largura, P.altura.outros))
      .toEqual({ pt: 6.7, quebra: true })
    expect(fonteCelulaFicha('700 g/100 kg + 150 mL/100 kg', P.colunasOutros[2].largura, P.altura.outros))
      .toEqual({ pt: 6.8, quebra: false })
  })

  it('papel antigo (linhas de 9 mm) continua como era: 10,5 pt e 8 pt na quebra', () => {
    const R = LAYOUTS_FICHA.retrato
    expect(fonteCelulaFicha('FORTENZA', R.colunas[0].largura, R.altura.inseticida)).toEqual({ pt: 10.5, quebra: false })
    expect(fonteCelulaFicha('Piraclostrobina + Tiofanato-metílico', R.colunas[1].largura, R.altura.fungicida))
      .toEqual({ pt: 8, quebra: true })
  })
})

describe('Disco Black na mesma linha do Fluidus F047 (07/10/2026)', () => {
  const fluidus = item('FLUIDUS F047 PO SECANTE', [], 400, 'g/100kg')
  const disco = item('DISCO BLACK', [], 150, 'ml/100kg')

  it('os dois viram uma linha só, Fluidus primeiro mesmo com o Disco Black antes na receita', () => {
    const f = montarFichaQuimicos('X', [disco, fluidus])
    expect(f.outros).toEqual([
      {
        produto: 'FLUIDUS F047 PO SECANTE + DISCO BLACK',
        informacoes: '',
        dosagem: '400 g/100 kg + 150 mL/100 kg',
      },
    ])
    // o aviso de "sem princípio" continua com os dois
    expect(f.semPrincipio).toEqual(['DISCO BLACK', 'FLUIDUS F047 PO SECANTE'])
  })

  it('receita real FTZ60 + RCoMoNi + Lli no papel deitado: cabe tudo nas 3 linhas', () => {
    const itens = [
      item('KELMAX RN BR', [], 200, 'ml/100kg'),
      item('RIZOLIQ LLI', [p('Bradyrhizobium 7×10⁹ UFC/mL', 'Inoculante', null)], 250, 'ml/100kg'),
      item('MAXIM QUATTRO', [p('Azoxistrobina', 'Fungicida'), p('Fludioxonil', 'Fungicida')], 30, 'ml/100kg'),
      item('FORTENZA 600 FS', [p('Ciantraniliprole', 'Inseticida', 600)], 60, 'ml/100kg'),
      item('CRUISER 600 FS', [p('Tiametoxam', 'Inseticida', 600)], 115, 'ml/100kg'),
      disco,
      item('PREMAX', [p('PREMAX® 7×10⁹ UFC/mL', 'Outros', null)], 50, 'ml/100kg'),
      fluidus,
    ]
    const f = montarFichaQuimicos('FTZ60 + RCoMoNi + Lli', itens, LAYOUTS_FICHA.paisagem.capacidade)
    expect(f.outros.map((l) => l.produto)).toEqual([
      'KELMAX RN BR',
      'FLUIDUS F047 PO SECANTE + DISCO BLACK',
      'PREMAX',
    ])
    expect(f.naoCouberam).toEqual([])
  })

  it('só um dos dois na receita: linha normal, nada junta', () => {
    const f = montarFichaQuimicos('X', [fluidus, item('KELMAX RN BR', [], 200, 'ml/100kg')])
    expect(f.outros.map((l) => l.produto)).toEqual(['FLUIDUS F047 PO SECANTE', 'KELMAX RN BR'])
  })

  it('casa sem acento e sem diferença de caixa', () => {
    const f = montarFichaQuimicos('X', [item('Fluidus F047 Pó Secante', [], 300, 'g/100kg'), item('Disco Black', [], 250, 'ml/100kg')])
    expect(f.outros).toHaveLength(1)
    expect(f.outros[0].produto).toBe('Fluidus F047 Pó Secante + Disco Black')
  })
})
