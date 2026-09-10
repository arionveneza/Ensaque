import { describe, expect, it } from 'vitest'
import {
  AJUSTE_FICHA_ZERO, CAPACIDADE_FICHA, LIMITE_AJUSTE_MM, aplicarAjusteFicha, concentracaoFicha,
  doseFicha, montarFichaQuimicos, normalizarAjusteFicha, type ItemFicha, type PrincipioFicha,
} from './fichaQuimicos'

const LAYOUT = {
  esquerda: 10,
  esquerdaOutros: 8.5,
  receita: { left: 58, top: 90 },
  biologicos: { left: 164, top: 90 },
  top: { inseticida: 116, fungicida: 151, nematicida: 184, inoculante: 211, outros: 240 },
  outraCoisa: 'preservada',
}

describe('aplicarAjusteFicha: ajuste por impressora somado ao padrão', () => {
  it('ajuste zero devolve o layout igual', () => {
    expect(aplicarAjusteFicha(LAYOUT, AJUSTE_FICHA_ZERO)).toEqual(LAYOUT)
  })

  it('cada seção desloca só a sua linha; x desloca todas as esquerdas', () => {
    const a = aplicarAjusteFicha(LAYOUT, { ...AJUSTE_FICHA_ZERO, fungicida: -2, outros: 3, receita: 1, x: -1 })
    expect(a.top).toEqual({ inseticida: 116, fungicida: 149, nematicida: 184, inoculante: 211, outros: 243 })
    expect(a.receita).toEqual({ left: 57, top: 91 })
    expect(a.biologicos).toEqual({ left: 163, top: 90 })
    expect(a.esquerda).toBe(9)
    expect(a.esquerdaOutros).toBe(7.5)
    expect(a.outraCoisa).toBe('preservada')
    // pura: o padrão não muda
    expect(LAYOUT.top.fungicida).toBe(151)
  })
})

describe('normalizarAjusteFicha: o que vem do navegador', () => {
  it('campo faltando, lixo e nulo viram 0; número em texto é aceito', () => {
    expect(normalizarAjusteFicha({ fungicida: '2', outros: 'abc', x: null })).toEqual({
      ...AJUSTE_FICHA_ZERO, fungicida: 2,
    })
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
