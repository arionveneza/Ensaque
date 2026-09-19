import { describe, expect, it } from 'vitest'
import {
  alternarNaFaixa,
  faixaDe,
  listaAposArraste,
  moverNaFaixa,
  ordenarComPrioridades,
  semDaFaixa,
} from './prioridadesDia'

const o = (id: string, seq: number | null, prioridade_dia: number | null = null) => ({
  id,
  numero: id,
  seq,
  prioridade_dia,
})

describe('ordenar com prioridades', () => {
  it('priorizadas primeiro pela posicao, depois o resto pela sequencia', () => {
    const fila = [o('a', 1), o('b', 2, 2), o('c', 3), o('d', 4, 1)]
    expect(ordenarComPrioridades(fila).map((x) => x.id)).toEqual(['d', 'b', 'a', 'c'])
  })

  it('sem prioridade nenhuma, e a fila de sempre', () => {
    const fila = [o('b', 2), o('a', 1), o('c', null)]
    expect(ordenarComPrioridades(fila).map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('faixa devolve so as priorizadas, em ordem', () => {
    const fila = [o('a', 1), o('b', 2, 2), o('c', 3), o('d', 4, 1)]
    expect(faixaDe(fila).map((x) => x.id)).toEqual(['d', 'b'])
  })
})

describe('arraste na faixa', () => {
  it('entra no fim quando nao ha posicao', () => {
    expect(listaAposArraste(['a', 'b'], 'c', null)).toEqual(['a', 'b', 'c'])
  })

  it('entra na posicao solta', () => {
    expect(listaAposArraste(['a', 'b'], 'c', 0)).toEqual(['c', 'a', 'b'])
    expect(listaAposArraste(['a', 'b'], 'c', 1)).toEqual(['a', 'c', 'b'])
  })

  it('reordenar dentro da faixa recua o indice quando vinha de cima', () => {
    // soltar "a" logo abaixo de "b" (indice 2 na lista exibida) → a vai pra depois de b
    expect(listaAposArraste(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'a', 'c'])
    // soltar "a" em cima dela mesma nao muda nada
    expect(listaAposArraste(['a', 'b', 'c'], 'a', 0)).toEqual(['a', 'b', 'c'])
    expect(listaAposArraste(['a', 'b', 'c'], 'a', 1)).toEqual(['a', 'b', 'c'])
  })

  it('subir de baixo para cima nao recua', () => {
    expect(listaAposArraste(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
  })

  it('setas trocam com a vizinha e param nos limites', () => {
    expect(moverNaFaixa(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c'])
    expect(moverNaFaixa(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'c', 'b'])
    expect(moverNaFaixa(['a', 'b', 'c'], 'a', -1)).toEqual(['a', 'b', 'c'])
    expect(moverNaFaixa(['a', 'b', 'c'], 'c', 1)).toEqual(['a', 'b', 'c'])
  })

  it('remover tira da faixa', () => {
    expect(semDaFaixa(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
  })
})

describe('alternar na faixa (botao prioridade)', () => {
  it('fora entra no fim, dentro sai, e ida-e-volta devolve a faixa original', () => {
    expect(alternarNaFaixa(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
    expect(alternarNaFaixa(['a', 'b', 'c'], 'b')).toEqual(['a', 'c'])
    expect(alternarNaFaixa(alternarNaFaixa(['a', 'b'], 'c'), 'c')).toEqual(['a', 'b'])
  })
})
