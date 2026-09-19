import { describe, expect, it } from 'vitest'
import { compararTratamentos, familiaDoTratamento } from './tratamentos'

describe('familiaDoTratamento — nomes reais do cadastro', () => {
  it('reconhece as cinco familias do Arion, com e sem derivacao', () => {
    expect(familiaDoTratamento('V&P')).toBe('V&P')
    expect(familiaDoTratamento('V&P + RAIZ')).toBe('V&P')
    expect(familiaDoTratamento('DER + LMT')).toBe('Dermacor')
    expect(familiaDoTratamento('DER + RANC + SUG')).toBe('Dermacor')
    expect(familiaDoTratamento('STANDAK TOP')).toBe('Standak')
    expect(familiaDoTratamento('STDK S + RCoMoNi')).toBe('Standak')
    expect(familiaDoTratamento('FTZ ELITE + RCoMoNi + Lli')).toBe('FTZ Elite')
    expect(familiaDoTratamento('FTZ60')).toBe('FTZ60')
    expect(familiaDoTratamento('FTZ 60 S')).toBe('FTZ60')
    expect(familiaDoTratamento('FTZ60 S + Cert N + RCoMoNi')).toBe('FTZ60')
  })

  it('fora das conhecidas, o primeiro segmento normalizado e a familia — grafias diferentes caem juntas', () => {
    expect(familiaDoTratamento('FTZ80 + RCoMoNi + Lli')).toBe('FTZ80')
    expect(familiaDoTratamento('FTZ 80 + Lli')).toBe('FTZ80')
    expect(familiaDoTratamento('ftz80')).toBe('FTZ80')
    expect(familiaDoTratamento('SEM TSI')).toBe('SEMTSI')
    expect(familiaDoTratamento('  ')).toBe('')
  })

  it('caixa e acento nao atrapalham', () => {
    expect(familiaDoTratamento('ftz élite + arv')).toBe('FTZ Elite')
    expect(familiaDoTratamento('der+lmt')).toBe('Dermacor')
  })
})

describe('compararTratamentos — base antes das derivacoes', () => {
  const t = (nome: string, itens?: number) => ({ nome, itens })

  it('dentro da familia, menos itens primeiro', () => {
    const lista = [t('FTZ60 + RCoMoNi + Lli', 8), t('FTZ60 + VIC', 6), t('FTZ60', 5), t('FTZ60 + ARV', 6)]
    expect(lista.sort(compararTratamentos).map((x) => x.nome)).toEqual([
      'FTZ60', 'FTZ60 + ARV', 'FTZ60 + VIC', 'FTZ60 + RCoMoNi + Lli',
    ])
  })

  it('familias ficam juntas, em ordem de nome', () => {
    const lista = [t('V&P', 5), t('DER + LMT', 4), t('FTZ60 + VIC', 6), t('FTZ ELITE', 6), t('FTZ60', 5), t('STDK + Lli', 5)]
    expect(lista.sort(compararTratamentos).map((x) => x.nome)).toEqual([
      'DER + LMT', 'FTZ ELITE', 'FTZ60', 'FTZ60 + VIC', 'STDK + Lli', 'V&P',
    ])
  })

  it('sem a contagem de itens, ordena pelo nome dentro da familia', () => {
    const lista = [t('FTZ60 + VIC'), t('FTZ60'), t('FTZ60 + ARV')]
    expect(lista.sort(compararTratamentos).map((x) => x.nome)).toEqual(['FTZ60', 'FTZ60 + ARV', 'FTZ60 + VIC'])
  })

  it('contagem faltando so em parte da familia: quem nao tem vai pro fim, e a saida nao depende da ordem de entrada', () => {
    // comparador PARCIAL (pular a regra quando um lado não tinha contagem) era
    // intransitivo: 6 permutações davam 3 saídas, e a receita de 8 itens saía
    // na frente da de 5 — achado da revisão adversarial, 19/09/2026
    const itens = [t('FTZ60 + RCoMoNi + Lli', 8), t('FTZ60 + VIC + Lli'), t('FTZ60 S + RCoMoNi', 5)]
    const permutacoes = (l: typeof itens): (typeof itens)[] =>
      l.length <= 1 ? [l] : l.flatMap((x, i) => permutacoes([...l.slice(0, i), ...l.slice(i + 1)]).map((p) => [x, ...p]))
    const saidas = new Set(permutacoes(itens).map((p) => [...p].sort(compararTratamentos).map((x) => x.nome).join(' | ')))
    expect([...saidas]).toEqual(['FTZ60 S + RCoMoNi | FTZ60 + RCoMoNi + Lli | FTZ60 + VIC + Lli'])
  })
})
