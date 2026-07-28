import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  Aviso, Tag, Vazio, corDoStatus, diaCurto, diaSemana, inteiro, n, somaDias,
} from './ui'

describe('formatacao numerica em pt-BR', () => {
  it('usa virgula decimal', () => {
    expect(n(1234.5, 1)).toBe('1.234,5')
  })

  it('respeita as casas pedidas', () => {
    expect(n(1.239, 2)).toBe('1,24')
  })

  it('nulo e NaN viram travessao, nao zero', () => {
    expect(n(null)).toBe('—')
    expect(n(undefined)).toBe('—')
    expect(n(Number.NaN)).toBe('—')
  })

  it('zero continua sendo zero', () => {
    expect(n(0, 1)).toBe('0,0')
  })

  it('inteiro nao inventa casas decimais', () => {
    expect(inteiro(16865)).toBe('16.865')
    expect(inteiro(null)).toBe('—')
  })
})

describe('datas', () => {
  it('dia curto mostra dia e mes', () => {
    expect(diaCurto('2026-07-28')).toBe('28/07')
  })

  it('dia curto lida com nulo', () => {
    expect(diaCurto(null)).toBe('—')
  })

  it('dia da semana em portugues', () => {
    expect(diaSemana('2026-07-28')).toBe('ter')
  })

  it('soma dias atravessando o mes', () => {
    expect(somaDias('2026-07-30', 3)).toBe('2026-08-02')
  })

  it('soma dias para tras', () => {
    expect(somaDias('2026-08-02', -3)).toBe('2026-07-30')
  })
})

describe('cor do status', () => {
  it('em producao e verde, parada e vermelha', () => {
    expect(corDoStatus('Em producao')).toBe('ok')
    expect(corDoStatus('Parada')).toBe('perigo')
  })

  it('aguardando lote alerta, pronto informa', () => {
    expect(corDoStatus('Aguardando lote')).toBe('alerta')
    expect(corDoStatus('Pronto para produzir')).toBe('info')
  })

  it('status desconhecido cai no neutro em vez de quebrar', () => {
    expect(corDoStatus('qualquer coisa')).toBe('neutro')
  })
})

describe('componentes', () => {
  it('Tag mostra o conteudo', () => {
    render(<Tag cor="ok">Aprovado</Tag>)
    expect(screen.getByText('Aprovado')).toBeInTheDocument()
  })

  it('Vazio comunica ausencia de dados', () => {
    render(<Vazio>Nenhuma ordem</Vazio>)
    expect(screen.getByText('Nenhuma ordem')).toBeInTheDocument()
  })

  it('Aviso de bloqueio se distingue do de alerta', () => {
    const { container: bloqueio } = render(<Aviso gravidade="bloqueio">parou</Aviso>)
    const { container: alerta } = render(<Aviso gravidade="alerta">cuidado</Aviso>)
    expect(bloqueio.firstElementChild?.className).not.toBe(
      alerta.firstElementChild?.className,
    )
  })
})
