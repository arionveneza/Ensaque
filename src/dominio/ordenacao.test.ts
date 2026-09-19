import { describe, expect, it } from 'vitest'
import { alternarOrdenacao, comDirecao, emCascata, ordenarPor, porNome, porNumero, type Ordenacao } from './ordenacao'

describe('porNome — texto em pt-BR e numerico', () => {
  it('numero dentro do texto conta como numero', () => {
    expect(porNome('NEO680 IPRO', 'NEO1000 IPRO')).toBeLessThan(0)
    expect(porNome('P9', 'P10')).toBeLessThan(0)
    expect(porNome('SC10', 'SC20')).toBeLessThan(0)
  })

  it('acentuada fica junto da sem acento, nao jogada pro fim (acento e caixa ainda DISTINGUEM)', () => {
    expect(['b', 'Á', 'a'].sort(porNome)).toEqual(['a', 'Á', 'b'])
    expect(porNome('Ávila', 'Avila')).not.toBe(0)
    expect(porNome('neo680', 'NEO680')).not.toBe(0)
  })
})

describe('alternarOrdenacao — o ciclo do clique no cabecalho', () => {
  it('nulo → asc → desc → nulo', () => {
    const a = alternarOrdenacao<'x' | 'y'>(null, 'x')
    expect(a).toEqual({ campo: 'x', dir: 'asc' })
    const d = alternarOrdenacao(a, 'x')
    expect(d).toEqual({ campo: 'x', dir: 'desc' })
    expect(alternarOrdenacao(d, 'x')).toBeNull()
  })

  it('outro campo comeca em asc, seja qual for o estado', () => {
    const d: Ordenacao<'x' | 'y'> = { campo: 'x', dir: 'desc' }
    expect(alternarOrdenacao(d, 'y')).toEqual({ campo: 'y', dir: 'asc' })
  })
})

describe('ordenarPor', () => {
  type L = { nome: string; peso: number; n: string }
  const lista: L[] = [
    { nome: 'B', peso: 5, n: '2' },
    { nome: 'A', peso: 5, n: '3' },
    { nome: 'C', peso: 1, n: '1' },
  ]
  const cmp = {
    nome: (a: L, b: L) => porNome(a.nome, b.nome),
    peso: (a: L, b: L) => porNumero(a.peso, b.peso),
  }
  const desempate = (a: L, b: L) => porNome(a.n, b.n)

  it('nulo devolve copia na ordem recebida', () => {
    const r = ordenarPor(lista, null, cmp, desempate)
    expect(r.map((x) => x.n)).toEqual(['2', '3', '1'])
    expect(r).not.toBe(lista)
  })

  it('asc e desc invertem so a chave principal; o empate fica SEMPRE em asc', () => {
    expect(ordenarPor(lista, { campo: 'peso', dir: 'asc' }, cmp, desempate).map((x) => x.n)).toEqual(['1', '2', '3'])
    expect(ordenarPor(lista, { campo: 'peso', dir: 'desc' }, cmp, desempate).map((x) => x.n)).toEqual(['2', '3', '1'])
  })

  it('por nome', () => {
    expect(ordenarPor(lista, { campo: 'nome', dir: 'desc' }, cmp, desempate).map((x) => x.nome)).toEqual(['C', 'B', 'A'])
  })

  it('nao altera a lista de entrada', () => {
    const antes = lista.map((x) => x.n)
    ordenarPor(lista, { campo: 'nome', dir: 'asc' }, cmp, desempate)
    expect(lista.map((x) => x.n)).toEqual(antes)
  })

  it('emCascata e comDirecao: o primeiro que desempata decide, e desc so inverte o sinal', () => {
    const c = emCascata<L>(cmp.peso, cmp.nome)
    expect(c(lista[0], lista[1])).toBeGreaterThan(0)
    expect(comDirecao(c, 'desc')(lista[0], lista[1])).toBeLessThan(0)
    expect(comDirecao(c, 'desc')(lista[0], lista[0])).toBe(0)
  })
})
