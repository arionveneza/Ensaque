import { describe, expect, it } from 'vitest'
import { ehConcluida, exibicaoDoDia, filaSemStatus, grupoMovel, ordenarQuadroDoDia, posicoesDeExibicao } from './quadroDoDia'

const o = (
  id: string,
  status_efetivo: string,
  extra: Partial<{ cultivar: string; receita_id: string; receita_nome: string; bags: number; peso_t: number; data_expedicao: string | null }> = {},
) => ({
  id,
  numero: id,
  status_efetivo,
  cultivar: 'NEO680 IPRO',
  receita_id: 'r-ftz60',
  receita_nome: 'FTZ60',
  bags: 10,
  peso_t: 8.5,
  data_expedicao: null as string | null,
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

  it('grupoMovel: as setas so trocam dentro do proprio status; rodando e concluida nao se movem', () => {
    const { grupos } = exibicaoDoDia(fila)
    expect(grupoMovel(grupos, fila[4]).map((x) => x.id)).toEqual(['5'])
    expect(grupoMovel(grupos, fila[0]).map((x) => x.id)).toEqual(['1'])
    expect(grupoMovel(grupos, fila[2])).toEqual([])
    expect(grupoMovel(grupos, fila[1])).toEqual([])
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

  it('por cultivar ordena SO as ativas; as ja produzidas ficam no fim, na ordem da fila', () => {
    const lista = [
      o('20', 'Finalizada', { cultivar: '0000 IPRO' }),
      o('3', 'Em producao', { cultivar: 'O790 IPRO' }),
      o('10', 'Programada', { cultivar: 'NEO680 IPRO' }),
      o('9', 'Programada', { cultivar: 'NEO680 IPRO' }),
      o('30', 'Apontada', { cultivar: '0001 IPRO' }),
    ]
    expect(ordenarQuadroDoDia(lista, { campo: 'cultivar', dir: 'asc' }).map((x) => x.id)).toEqual(['9', '10', '3', '20', '30'])
    expect(ordenarQuadroDoDia(lista, { campo: 'cultivar', dir: 'desc' }).map((x) => x.id)).toEqual(['3', '9', '10', '20', '30'])
  })

  it('por peso desc, empate pelo numero em asc', () => {
    const lista = [o('b', 'Programada', { peso_t: 5 }), o('a', 'Programada', { peso_t: 5 }), o('c', 'Programada', { peso_t: 9 })]
    expect(ordenarQuadroDoDia(lista, { campo: 'peso', dir: 'desc' }).map((x) => x.id)).toEqual(['c', 'a', 'b'])
  })

  it('tratamento: por familia, base (menos itens) antes das derivacoes; bags e numerico', () => {
    const itens = new Map([['r-vic', 6], ['r-ftz60', 5], ['r-der', 4], ['r-lli', 8]])
    const lista = [
      o('1', 'Programada', { receita_id: 'r-lli', receita_nome: 'FTZ60 + RCoMoNi + Lli', bags: 3 }),
      o('2', 'Programada', { receita_id: 'r-der', receita_nome: 'DER + LMT', bags: 25 }),
      o('3', 'Programada', { receita_id: 'r-vic', receita_nome: 'FTZ60 + VIC', bags: 9 }),
      o('4', 'Programada', { receita_id: 'r-ftz60', receita_nome: 'FTZ60', bags: 1 }),
    ]
    expect(ordenarQuadroDoDia(lista, { campo: 'tratamento', dir: 'asc' }, itens).map((x) => x.id)).toEqual(['2', '4', '3', '1'])
    expect(ordenarQuadroDoDia(lista, { campo: 'bags', dir: 'asc' }).map((x) => x.id)).toEqual(['4', '1', '3', '2'])
  })

  it('expedicao: por data, quem nao tem data no fim das ativas, e as produzidas depois', () => {
    const lista = [
      o('semB', 'Programada'),
      o('fim', 'Finalizada', { data_expedicao: '2026-09-10' }),
      o('21', 'Programada', { data_expedicao: '2026-09-21' }),
      o('semA', 'Programada'),
      o('18', 'Programada', { data_expedicao: '2026-09-18' }),
    ]
    expect(ordenarQuadroDoDia(lista, { campo: 'expedicao', dir: 'asc' }).map((x) => x.id)).toEqual(['18', '21', 'semA', 'semB', 'fim'])
    expect(ordenarQuadroDoDia(lista, { campo: 'expedicao', dir: 'desc' }).map((x) => x.id)).toEqual(['21', '18', 'semA', 'semB', 'fim'])
  })

  it('status: na ordem do ciclo de vida, nao alfabetica; desconhecido por ultimo entre as ativas', () => {
    const lista = [o('f', 'Finalizada'), o('x', 'Zzz'), o('e', 'Em producao'), o('p', 'Programada'), o('a', 'Aguardando lote')]
    expect(ordenarQuadroDoDia(lista, { campo: 'status', dir: 'asc' }).map((x) => x.id)).toEqual(['p', 'a', 'e', 'x', 'f'])
    expect(ordenarQuadroDoDia(lista, { campo: 'status', dir: 'desc' }).map((x) => x.id)).toEqual(['x', 'e', 'a', 'p', 'f'])
  })

  it('nao altera a fila recebida', () => {
    const antes = fila.map((x) => x.id)
    ordenarQuadroDoDia(fila, { campo: 'cultivar', dir: 'desc' })
    ordenarQuadroDoDia(fila, { campo: 'expedicao', dir: 'desc' })
    expect(fila.map((x) => x.id)).toEqual(antes)
  })
})

describe('sem status (a fila como a maquina vai rodar)', () => {
  it('filaSemStatus: ativas na sequencia gravada, produzidas no fim', () => {
    expect(filaSemStatus(fila).map((x) => x.id)).toEqual(['1', '3', '4', '5', '6', '2', '7'])
  })

  it('posicoes e ordenacao nula seguem a fila pura quando porStatus e falso', () => {
    const p = posicoesDeExibicao(fila, false)
    expect(p.get('1')).toBe(1)
    expect(p.get('3')).toBe(2)
    expect(p.get('2')).toBe(6)
    expect(ordenarQuadroDoDia(fila, null, undefined, false).map((x) => x.id)).toEqual(['1', '3', '4', '5', '6', '2', '7'])
    // ordenar por coluna não depende do modo
    expect(ordenarQuadroDoDia(fila, { campo: 'status', dir: 'asc' }, undefined, false).map((x) => x.id)).toEqual(
      ordenarQuadroDoDia(fila, { campo: 'status', dir: 'asc' }).map((x) => x.id),
    )
  })
})
