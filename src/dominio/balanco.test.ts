import { describe, expect, it } from 'vitest'
import {
  analisaDemanda, bagsFaltando, bagsSobrando, balanco, podeCriarOrdem,
  resumoBalanco, situacaoDemanda, type LinhaBalanco,
} from './balanco'
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

  it('SEM TSI nunca avisa "sem pedido" — a importação exclui esse tratamento de propósito', () => {
    const chaveSemTsi = { ...CHAVE, tratamento: 'SEM TSI' }
    const a = analisaDemanda(chaveSemTsi, 40, [], [], [], true)
    expect(a.avisos).toEqual([])
    expect(podeCriarOrdem(a)).toBe(true)
  })

  it('SEM TSI tambem tolera variação de caixa/acento (sem tsi, Sem Tsi)', () => {
    const a = analisaDemanda({ ...CHAVE, tratamento: 'sem tsi' }, 40, [], [], [], true)
    expect(a.avisos).toEqual([])
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

// ---------------------------------------------------------------
// Leitura do painel: falta produzir vs vai sobrar
// ---------------------------------------------------------------

/** Monta a linha como a v_balanco_demanda devolve, com o saldo já calculado. */
const bal = (pedido: number, estoque: number, abertas: number): LinhaBalanco => ({
  pedido_aprovado: pedido,
  estoque_pa: estoque,
  ordens_abertas: abertas,
  saldo: pedido - estoque - abertas,
})

describe('situacao da linha de balanco', () => {
  it('pedido maior que estoque e programado: falta produzir', () => {
    const l = bal(150, 20, 45)
    expect(situacaoDemanda(l)).toBe('descoberto')
    expect(bagsFaltando(l)).toBe(85)
    expect(bagsSobrando(l)).toBe(0)
  })

  it('estoque e programado passam do pedido: vai sobrar', () => {
    const l = bal(100, 40, 90)
    expect(situacaoDemanda(l)).toBe('sobra')
    expect(bagsSobrando(l)).toBe(30)
    expect(bagsFaltando(l)).toBe(0)
  })

  it('exatamente coberto nao e falta nem sobra', () => {
    const l = bal(100, 40, 60)
    expect(situacaoDemanda(l)).toBe('coberto')
    expect(bagsFaltando(l)).toBe(0)
    expect(bagsSobrando(l)).toBe(0)
  })

  it('programado sem nenhum pedido aprovado e o caso grave', () => {
    expect(situacaoDemanda(bal(0, 0, 60))).toBe('sem-pedido')
    expect(situacaoDemanda(bal(0, 25, 0))).toBe('sem-pedido')
  })

  it('linha vazia nao vira alerta', () => {
    expect(situacaoDemanda(bal(0, 0, 0))).toBe('coberto')
  })

  it('pedido apenas aguardando aprovacao nao cobre o programado', () => {
    // o pedido pendente nem chega aqui: a view soma só o aprovado
    expect(situacaoDemanda(bal(0, 0, 45))).toBe('sem-pedido')
  })
})

describe('resumo do balanco', () => {
  it('separa o total a produzir do total que vai sobrar', () => {
    const r = resumoBalanco([bal(150, 20, 45), bal(100, 40, 90), bal(80, 80, 0)])
    expect(r.faltando).toBe(85)
    expect(r.combosFaltando).toBe(1)
    expect(r.sobrando).toBe(30)
    expect(r.combosSobrando).toBe(1)
  })

  it('conta o sem-pedido tambem no total que sobra', () => {
    const r = resumoBalanco([bal(0, 10, 60)])
    expect(r.semPedido).toBe(70)
    expect(r.combosSemPedido).toBe(1)
    // o mesmo bag aparece nos dois: um e o total, o outro e o alerta
    expect(r.sobrando).toBe(70)
  })

  it('painel sem carga nenhuma da tudo zero', () => {
    expect(resumoBalanco([])).toEqual({
      faltando: 0, combosFaltando: 0,
      sobrando: 0, combosSobrando: 0,
      semPedido: 0, combosSemPedido: 0,
    })
  })
})
