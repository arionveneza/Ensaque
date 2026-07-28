import { describe, expect, it } from 'vitest'
import { analisaDemanda, balanco, podeCriarOrdem } from './balanco'
import type { LinhaDemanda, PedidoVenda } from './tipos'

const CHAVE = { cultivar: '761 I2X', tratamento: 'FTZ60', embalagem: 'BG5M' }

const ped = (bags: number, aprovado = true, over: Partial<PedidoVenda> = {}): PedidoVenda => ({
  ...CHAVE, bags, aprovado, ...over,
})
const linha = (bags: number, over: Partial<LinhaDemanda> = {}): LinhaDemanda => ({
  ...CHAVE, bags, ...over,
})

describe('balanco de demanda', () => {
  it('saldo e pedido aprovado menos estoque menos ordens abertas', () => {
    const b = balanco(CHAVE, [ped(150)], [linha(20)], [linha(45)])
    expect(b.saldo).toBe(85)
  })

  it('pedido nao aprovado fica visivel mas fora do calculo', () => {
    const b = balanco(CHAVE, [ped(150), ped(35, false)], [], [])
    expect(b.pedidoAprovado).toBe(150)
    expect(b.pedidoPendente).toBe(35)
    expect(b.saldo).toBe(150)
  })

  it('so soma a combinacao exata de cultivar, tratamento e embalagem', () => {
    const b = balanco(
      CHAVE,
      [ped(150), ped(999, true, { embalagem: 'MEIOBAG' }), ped(999, true, { cultivar: 'OUTRO' })],
      [],
      [],
    )
    expect(b.pedidoAprovado).toBe(150)
  })

  it('combinacao sem nada da zero, nao erro', () => {
    const b = balanco(CHAVE, [], [], [])
    expect(b.saldo).toBe(0)
  })
})

describe('avisos: fortes, nunca bloqueantes', () => {
  it('avisa quando nao existe pedido de venda', () => {
    const a = analisaDemanda(CHAVE, 40, [], [], [], true)
    expect(a.avisos.map((x) => x.tipo)).toContain('sem-pedido')
    expect(podeCriarOrdem(a)).toBe(true)
  })

  it('avisa quando o estoque ja cobre o pedido', () => {
    const a = analisaDemanda(CHAVE, 10, [ped(22)], [linha(25)], [], true)
    expect(a.avisos.map((x) => x.tipo)).toContain('estoque-cobre')
    expect(podeCriarOrdem(a)).toBe(true)
  })

  it('avisa quando ja esta planejado em ordens abertas', () => {
    const a = analisaDemanda(CHAVE, 10, [ped(100)], [linha(20)], [linha(80)], true)
    expect(a.avisos.map((x) => x.tipo)).toContain('ja-planejado')
    expect(podeCriarOrdem(a)).toBe(true)
  })

  it('avisa quando a ordem excede o saldo descoberto', () => {
    const a = analisaDemanda(CHAVE, 200, [ped(100)], [], [], true)
    expect(a.avisos.map((x) => x.tipo)).toContain('excede-saldo')
    expect(podeCriarOrdem(a)).toBe(true)
  })

  it('avisa estoque parado em embalagem sem pedido', () => {
    const a = analisaDemanda(
      CHAVE, 10, [ped(150)],
      [linha(40, { embalagem: 'MEIOBAG' })], [], true,
    )
    const parado = a.avisos.find((x) => x.tipo === 'estoque-parado')
    expect(parado?.mensagem).toMatch(/MEIOBAG/)
    expect(podeCriarOrdem(a)).toBe(true)
  })
})

describe('receita nao cadastrada', () => {
  it('a demanda entra no balanco mesmo sem receita', () => {
    const a = analisaDemanda(CHAVE, 40, [ped(150)], [], [], false)
    expect(a.balanco.pedidoAprovado).toBe(150)
  })

  it('mas a ordem nao pode ser criada', () => {
    const a = analisaDemanda(CHAVE, 40, [ped(150)], [], [], false)
    expect(a.avisos.some((x) => x.tipo === 'receita-nao-cadastrada' && x.bloqueia)).toBe(true)
    expect(podeCriarOrdem(a)).toBe(false)
  })
})
