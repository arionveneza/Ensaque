import { describe, expect, it } from 'vitest'
import {
  bagsDeVolta, ehEstorno, ehExclusao, enderecoSugerido, filtrarAjustes, intervaloDoDiaLocal,
  podeEstornar, rotuloSugestao, type AjusteEstornavel,
} from './estornoAjuste'

const ajuste = (p: Partial<AjusteEstornavel> & Pick<AjusteEstornavel, 'id' | 'delta' | 'motivo'>): AjusteEstornavel => ({
  lote: 'SV1',
  tratamento: 'SEM TSI',
  armazem: null,
  bloco: null,
  quadra: null,
  criado_em: '2026-10-19T12:00:00Z',
  estornado_em: null,
  estorno_de: null,
  ...p,
})

describe('estorno de baixas do mapa (20/10/2026)', () => {
  const exclusao = ajuste({ id: 'e1', delta: -5, motivo: 'Excluído do mapa: Carregado — saiu do galpão' })
  const baixaComEnd = ajuste({ id: 'a1', delta: -8, motivo: 'CARGA 1217', armazem: 'A', bloco: '20', quadra: '5' })
  const esvaziado = ajuste({ id: 'a2', delta: -3, motivo: 'Armazém B esvaziado: inventário', armazem: 'B' })
  const jaEstornada = ajuste({ id: 'a3', delta: -2, motivo: 'OC 1', estornado_em: '2026-10-20T10:00:00Z' })
  const estorno = ajuste({ id: 's1', delta: 2, motivo: 'Estorno de 19/10 12:00 (OC 1): engano', estorno_de: 'a3' })

  it('classifica exclusão, estorno e o que ainda pode ser estornado', () => {
    expect(ehExclusao(exclusao)).toBe(true)
    expect(ehExclusao(baixaComEnd)).toBe(false)
    expect(ehEstorno(estorno)).toBe(true)
    expect(podeEstornar(exclusao)).toBe(true)
    expect(podeEstornar(jaEstornada)).toBe(false)
    expect(podeEstornar(estorno)).toBe(false)
  })

  it('filtra por tipo sem perder ninguém', () => {
    const todos = [exclusao, baixaComEnd, esvaziado, jaEstornada, estorno]
    expect(filtrarAjustes(todos, 'todos')).toHaveLength(5)
    expect(filtrarAjustes(todos, 'exclusoes').map((a) => a.id)).toEqual(['e1'])
    expect(filtrarAjustes(todos, 'ajustes').map((a) => a.id)).toEqual(['a1', 'a2', 'a3'])
    expect(filtrarAjustes(todos, 'estornos').map((a) => a.id)).toEqual(['s1'])
  })

  it('sugere o endereço do próprio ajuste, senão o do inventário, senão nenhum', () => {
    expect(enderecoSugerido(baixaComEnd, { armazem: 'B', bloco: '1', quadra: '1', bags: 1, em: '2026-10-18T19:00:00Z' }))
      .toEqual({ armazem: 'A', bloco: '20', quadra: '5', origem: 'ajuste' })
    expect(enderecoSugerido(exclusao, { armazem: 'B', bloco: '22', quadra: '03', bags: 5, em: '2026-10-18T19:19:00Z' }))
      .toEqual({ armazem: 'B', bloco: '22', quadra: '3', origem: 'inventario', em: '2026-10-18T19:19:00Z' })
    // só a letra (rastro de "esvaziado") não é endereço — cai no inventário ou em nada
    expect(enderecoSugerido(esvaziado, null)).toBeNull()
    expect(enderecoSugerido(exclusao, { armazem: 'TSI SAIDA', bloco: '0', quadra: '0', bags: 1, em: 'x' })).toBeNull()
    expect(rotuloSugestao({ armazem: 'B', bloco: '22', quadra: '3', origem: 'inventario', em: 'x' })).toBe('B 22 Q03')
    expect(rotuloSugestao(null)).toBe('sem endereço — vai pra Sem localização')
  })

  it('intervalo do dia local e bags de volta', () => {
    const i = intervaloDoDiaLocal('2026-10-19')!
    expect(new Date(i.ate).getTime() - new Date(i.de).getTime()).toBe(24 * 3600 * 1000)
    expect(new Date(i.de).getDate()).toBe(19)
    expect(new Date(i.de).getHours()).toBe(0)
    expect(intervaloDoDiaLocal('')).toBeNull()
    expect(intervaloDoDiaLocal('19/10/2026')).toBeNull()
    expect(bagsDeVolta([exclusao, baixaComEnd, ajuste({ id: 'p', delta: 0.5, motivo: 'x' })])).toBe(12.5)
  })
})
