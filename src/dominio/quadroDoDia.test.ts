import { describe, expect, it } from 'vitest'
import { ehConcluida, exibicaoDoDia, ordenarQuadroDoDia, posicoesDeExibicao } from './quadroDoDia'

const o = (id: string, status_efetivo: string, extra: Partial<{ cultivar: string; receita_nome: string; bags: number; peso_t: number }> = {}) => ({
  id,
  numero: id,
  status_efetivo,
  cultivar: 'NEO680 IPRO',
  receita_nome: 'FTZ60',
  bags: 10,
  peso_t: 8.5,
  ...extra,
})

// a fila como vem do banco: por seq, misturando estágios
const fila = [
  o('1', 'Programada'),
  o('2', 'Finalizada'),
  o('3', 'Em producao'),
  o('4', 'Aguardando lote'),
  o('5', 'Pronto para produzir'),
  o('6', 'Parada'),
  o('7', 'Apontada'),
]

describe('exibicaoDoDia', () => {
  it('rodando → pronto → aguardando → programada → concluidas, cada grupo na ordem da fila', () => {
    const { exibicao, inicioConcluidas, grupos } = exibicaoDoDia(fila)
    expect(exibicao.map((x) => x.id)).toEqual(['3', '6', '5', '4', '1', '2', '7'])
    expect(inicioConcluidas).toBe(5)
    expect(grupos.rodando.map((x) => x.id)).toEqual(['3', '6'])
    expect(grupos.concluidas.map((x) => x.id)).toEqual(['2', '7'])
  })

  it('status desconhecido nao some da celula: cai no grupo das programadas', () => {
    const { exibicao, grupos } = exibicaoDoDia([o('a', 'Nao programada'), o('b', 'Programada')])
    expect(exibicao.map((x) => x.id)).toEqual(['a', 'b'])
    expect(grupos.programada.map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('fila vazia', () => {
    const r = exibicaoDoDia([])
    expect(r.exibicao).toEqual([])
    expect(r.inicioConcluidas).toBe(0)
  })

  it('ehConcluida cobre os tres status finais', () => {
    expect(['Finalizada', 'Qualidade apontada', 'Apontada'].every(ehConcluida)).toBe(true)
    expect(ehConcluida('Em producao')).toBe(false)
  })
})

describe('posicoesDeExibicao', () => {
  it('numera pela exibicao, nao pelo seq: a que esta rodando e a 1, mesmo com seq 3', () => {
    const p = posicoesDeExibicao(fila)
    expect(p.get('3')).toBe(1)
    expect(p.get('6')).toBe(2)
    expect(p.get('1')).toBe(5)
    expect(p.get('7')).toBe(7)
  })
})

describe('ordenarQuadroDoDia', () => {
  it('nulo e a exibicao padrao', () => {
    expect(ordenarQuadroDoDia(fila, null).map((x) => x.id)).toEqual(['3', '6', '5', '4', '1', '2', '7'])
  })

  it('por cultivar mistura concluidas e ativas (Excel puro), numerico em pt-BR, empate pelo numero', () => {
    const lista = [
      o('20', 'Finalizada', { cultivar: 'NEO1000 IPRO' }),
      o('3', 'Em producao', { cultivar: 'O790 IPRO' }),
      o('10', 'Programada', { cultivar: 'NEO680 IPRO' }),
      o('9', 'Programada', { cultivar: 'NEO680 IPRO' }),
    ]
    expect(ordenarQuadroDoDia(lista, { campo: 'cultivar', dir: 'asc' }).map((x) => x.id)).toEqual(['9', '10', '20', '3'])
    expect(ordenarQuadroDoDia(lista, { campo: 'cultivar', dir: 'desc' }).map((x) => x.id)).toEqual(['3', '20', '9', '10'])
  })

  it('por peso desc, empate pelo numero em asc', () => {
    const lista = [o('b', 'Programada', { peso_t: 5 }), o('a', 'Programada', { peso_t: 5 }), o('c', 'Programada', { peso_t: 9 })]
    expect(ordenarQuadroDoDia(lista, { campo: 'peso', dir: 'desc' }).map((x) => x.id)).toEqual(['c', 'a', 'b'])
  })

  it('tratamento usa o nome da receita; bags e numerico', () => {
    const lista = [
      o('1', 'Programada', { receita_nome: 'V&P', bags: 3 }),
      o('2', 'Programada', { receita_nome: 'DER + LMT', bags: 25 }),
      o('3', 'Programada', { receita_nome: 'FTZ60', bags: 9 }),
    ]
    expect(ordenarQuadroDoDia(lista, { campo: 'tratamento', dir: 'asc' }).map((x) => x.id)).toEqual(['2', '3', '1'])
    expect(ordenarQuadroDoDia(lista, { campo: 'bags', dir: 'asc' }).map((x) => x.id)).toEqual(['1', '3', '2'])
  })

  it('nao altera a fila recebida', () => {
    const antes = fila.map((x) => x.id)
    ordenarQuadroDoDia(fila, { campo: 'cultivar', dir: 'desc' })
    expect(fila.map((x) => x.id)).toEqual(antes)
  })
})
