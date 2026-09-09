import { describe, expect, it } from 'vitest'
import {
  CAPACIDADE_FICHA, concentracaoFicha, doseFicha, montarFichaQuimicos, type ItemFicha,
  type PrincipioFicha,
} from './fichaQuimicos'

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
