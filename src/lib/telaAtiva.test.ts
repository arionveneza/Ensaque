import { describe, expect, it } from 'vitest'
import { resolverVistaInicial, vistaDoHash } from './telaAtiva'

const VALIDAS = ['ordens', 'execucao', 'expedicao', 'mapa', 'painel', 'chamada'] as const

describe('vistaDoHash', () => {
  it('tira o # e devolve vazio quando não há fragmento', () => {
    expect(vistaDoHash('#expedicao')).toBe('expedicao')
    expect(vistaDoHash('expedicao')).toBe('expedicao')
    expect(vistaDoHash('#')).toBe('')
    expect(vistaDoHash('')).toBe('')
  })
})

describe('resolverVistaInicial', () => {
  it('hash válido vence a vista salva', () => {
    expect(resolverVistaInicial('#mapa', 'ordens', VALIDAS)).toBe('mapa')
  })

  it('sem hash, usa a vista salva', () => {
    expect(resolverVistaInicial('', 'expedicao', VALIDAS)).toBe('expedicao')
    expect(resolverVistaInicial('#', 'expedicao', VALIDAS)).toBe('expedicao')
  })

  it('fragmento de auth do Supabase é ignorado — cai na salva', () => {
    const auth = '#access_token=abc.def.ghi&refresh_token=xyz&type=recovery'
    expect(resolverVistaInicial(auth, 'ordens', VALIDAS)).toBe('ordens')
    expect(resolverVistaInicial(auth, null, VALIDAS)).toBeNull()
  })

  it('hash e salva desconhecidos devolvem null (padrão fica com quem chama)', () => {
    expect(resolverVistaInicial('#nao-existe', 'tambem-nao', VALIDAS)).toBeNull()
    expect(resolverVistaInicial('', null, VALIDAS)).toBeNull()
    expect(resolverVistaInicial('', '', VALIDAS)).toBeNull()
  })

  it('modos de tela cheia (painel, chamada) também são vistas válidas', () => {
    expect(resolverVistaInicial('#painel', null, VALIDAS)).toBe('painel')
    expect(resolverVistaInicial('', 'chamada', VALIDAS)).toBe('chamada')
  })

  it('não aceita tela fora da lista de válidas mesmo que pareça id', () => {
    expect(resolverVistaInicial('#administracao', 'execucao', ['ordens', 'execucao'])).toBe('execucao')
  })
})
