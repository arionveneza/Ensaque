import { describe, expect, it } from 'vitest'
import { converterOrdens, ehPlanilhaDeOrdens, type ContextoImportacao } from './ordens'
import type { Linha } from './simpleagro'

const CTX: ContextoImportacao = {
  lotesConhecidos: new Set(['L-4412', 'L-4418']),
  receitasConhecidas: new Set(['FTZ60', 'V&P']),
  embalagensConhecidas: new Set(['BG5M', 'MEIOBAG']),
  maquinasConhecidas: new Set(['TSI1', 'TSI2']),
}

const CAB = ['Ordem', 'Lote', 'Tratamento', 'Embalagem', 'Bags', 'Cliente', 'Obs', 'Máquina', 'Dia']
const linha = (...v: (string | number | Date | null)[]): Linha => v

/** Cabeçalho com as colunas de endereço, na ordem em que o modelo as gera. */
const CAB_END = [
  'Ordem', 'Lote', 'Tratamento', 'Embalagem', 'Bags',
  'Cliente', 'Obs', 'Armazém', 'Bloco', 'Quadra', 'Máquina', 'Dia',
]

describe('deteccao da planilha de ordens', () => {
  it('reconhece pelo conjunto minimo de colunas', () => {
    expect(ehPlanilhaDeOrdens([CAB])).toBe(true)
  })

  it('recusa planilha sem as colunas essenciais', () => {
    expect(ehPlanilhaDeOrdens([['Cliente', 'Observacao']])).toBe(false)
  })

  it('aceita cabecalho sem acento e em caixa diferente', () => {
    expect(ehPlanilhaDeOrdens([['NUMERO', 'lote', 'RECEITA', 'qtd']])).toBe(true)
  })
})

describe('conversao de ordens', () => {
  it('converte uma linha completa', () => {
    const r = converterOrdens(
      [CAB, linha('79500-1', 'L-4412', 'FTZ60', 'BG5M', 45, 'Fulano', 'SEM GRAFITE', 'TSI1', '2026-07-28')],
      CTX,
    )
    expect(r.problemas).toHaveLength(0)
    expect(r.ordens[0]).toEqual({
      numero: '79500-1',
      loteId: 'L-4412',
      tratamento: 'FTZ60',
      embalagem: 'BG5M',
      bags: 45,
      cliente: 'Fulano',
      observacao: 'SEM GRAFITE',
      armazem: null,
      bloco: null,
      quadra: null,
      maquinaId: 'TSI1',
      dataProg: '2026-07-28',
      dataExpedicao: null,
      urgente: false,
    })
  })

  // 12/09/2026: as duas colunas novas do formulário também entram pela planilha
  describe('expedição prevista e urgente', () => {
    const CAB_EXP = [...CAB, 'Expedição', 'Urgente']
    const base = ['1', 'L-4412', 'FTZ60', 'BG5M', 10, '', '', '', ''] as const

    it('le a data de expedicao nos mesmos formatos do Dia', () => {
      const r = converterOrdens(
        [CAB_EXP,
          linha(...base, '30/09/2026', ''),
          linha('2', 'L-4412', 'FTZ60', 'BG5M', 10, '', '', '', '', '2026-10-01', ''),
          linha('3', 'L-4412', 'FTZ60', 'BG5M', 10, '', '', '', '', new Date(Date.UTC(2026, 9, 2)), '')],
        CTX,
      )
      expect(r.problemas).toHaveLength(0)
      expect(r.ordens.map((o) => o.dataExpedicao)).toEqual(['2026-09-30', '2026-10-01', '2026-10-02'])
    })

    it('expedicao ilegivel e erro da linha, nao silencio', () => {
      const r = converterOrdens([CAB_EXP, linha(...base, 'semana que vem', '')], CTX)
      expect(r.ordens).toHaveLength(0)
      expect(r.problemas[0].motivo).toMatch(/expedição/)
    })

    it('SIM, X, 1 e URGENTE marcam urgente; vazio, NAO e NORMAL nao', () => {
      const marca = ['SIM', 'x', 1, 'Urgente', 'sim ']
      const naoMarca = ['', 'NÃO', 'nao', 0, 'Normal', null]
      for (const v of marca) {
        expect(converterOrdens([CAB_EXP, linha(...base, '', v)], CTX).ordens[0].urgente).toBe(true)
      }
      for (const v of naoMarca) {
        expect(converterOrdens([CAB_EXP, linha(...base, '', v)], CTX).ordens[0].urgente).toBe(false)
      }
    })

    it('sem as colunas, a ordem entra normal e sem expedicao', () => {
      const r = converterOrdens([CAB, linha('1', 'L-4412', 'FTZ60', 'BG5M', 10)], CTX)
      expect(r.ordens[0]).toMatchObject({ dataExpedicao: null, urgente: false })
    })

    it('aceita os nomes Data Exp e Prioridade no cabecalho', () => {
      const cab = [...CAB, 'Data Exp', 'Prioridade']
      const r = converterOrdens([cab, linha(...base, '2026-10-05', 'urgente')], CTX)
      expect(r.ordens[0]).toMatchObject({ dataExpedicao: '2026-10-05', urgente: true })
    })
  })

  it('aceita data no formato brasileiro', () => {
    const r = converterOrdens(
      [CAB, linha('1', 'L-4412', 'FTZ60', 'BG5M', 10, '', '', '', '28/07/2026')],
      CTX,
    )
    expect(r.ordens[0].dataProg).toBe('2026-07-28')
  })

  it('aceita Date vinda do leitor de xlsx', () => {
    const r = converterOrdens(
      // como o leitor devolve: meia-noite UTC, não local
      [CAB, linha('1', 'L-4412', 'FTZ60', 'BG5M', 10, '', '', '', new Date(Date.UTC(2026, 6, 28)))],
      CTX,
    )
    expect(r.ordens[0].dataProg).toBe('2026-07-28')
  })

  // em UTC-3 o getDate() local de 2026-09-30T00:00Z era 29 — o dia ANTERIOR
  it('Date em UTC nao cai um dia para tras no fuso do Brasil', () => {
    const r = converterOrdens(
      [CAB, linha('1', 'L-4412', 'FTZ60', 'BG5M', 10, '', '', '', new Date('2026-09-30T00:00:00Z'))],
      CTX,
    )
    expect(r.ordens[0].dataProg).toBe('2026-09-30')
  })

  it('rejeita lote que nao existe, em vez de criar ordem orfa', () => {
    const r = converterOrdens([CAB, linha('1', 'L-9999', 'FTZ60', 'BG5M', 10)], CTX)
    expect(r.ordens).toHaveLength(0)
    expect(r.problemas[0].motivo).toMatch(/L-9999/)
  })

  it('rejeita tratamento sem receita cadastrada', () => {
    const r = converterOrdens([CAB, linha('1', 'L-4412', 'DESCONHECIDO', 'BG5M', 10)], CTX)
    expect(r.problemas[0].motivo).toMatch(/sem receita/)
  })

  it('rejeita embalagem desconhecida', () => {
    const r = converterOrdens([CAB, linha('1', 'L-4412', 'FTZ60', 'BIGBAG', 10)], CTX)
    expect(r.problemas[0].motivo).toMatch(/BIGBAG/)
  })

  it('rejeita bags zerado ou negativo', () => {
    const r = converterOrdens(
      [CAB, linha('1', 'L-4412', 'FTZ60', 'BG5M', 0), linha('2', 'L-4412', 'FTZ60', 'BG5M', -5)],
      CTX,
    )
    expect(r.ordens).toHaveLength(0)
    expect(r.problemas).toHaveLength(2)
  })

  it('reporta o numero da linha do problema, contando o cabecalho', () => {
    const r = converterOrdens(
      [CAB, linha('1', 'L-4412', 'FTZ60', 'BG5M', 10), linha('2', 'L-XXXX', 'FTZ60', 'BG5M', 10)],
      CTX,
    )
    expect(r.problemas[0].linha).toBe(3)
  })

  it('acumula varios erros da mesma linha', () => {
    const r = converterOrdens([CAB, linha('', 'L-XXXX', '', 'BIGBAG', 0)], CTX)
    expect(r.problemas[0].motivo.split(' · ').length).toBeGreaterThan(3)
  })

  it('ignora linha totalmente vazia sem virar erro', () => {
    const r = converterOrdens([CAB, linha('', '', '', '', ''), linha('1', 'L-4412', 'FTZ60', 'BG5M', 10)], CTX)
    expect(r.ordens).toHaveLength(1)
    expect(r.problemas).toHaveLength(0)
  })

  it('detecta duplicata dentro do proprio arquivo', () => {
    const r = converterOrdens(
      [CAB, linha('1', 'L-4412', 'FTZ60', 'BG5M', 10), linha('1', 'L-4412', 'FTZ60', 'BG5M', 20)],
      CTX,
    )
    expect(r.ordens).toHaveLength(1)
    expect(r.duplicadasNoArquivo).toHaveLength(1)
  })

  it('mesma ordem em embalagem diferente nao e duplicata', () => {
    const r = converterOrdens(
      [CAB, linha('1', 'L-4412', 'FTZ60', 'BG5M', 10), linha('1', 'L-4412', 'FTZ60', 'MEIOBAG', 20)],
      CTX,
    )
    expect(r.ordens).toHaveLength(2)
    expect(r.duplicadasNoArquivo).toHaveLength(0)
  })

  it('maquina e opcional: sem ela a ordem vai para o pool', () => {
    const r = converterOrdens([CAB, linha('1', 'L-4412', 'FTZ60', 'BG5M', 10)], CTX)
    expect(r.ordens[0].maquinaId).toBeNull()
    expect(r.ordens[0].dataProg).toBeNull()
  })

  it('reconhece a maquina ignorando caixa e espaco', () => {
    const r = converterOrdens([CAB, linha('1', 'L-4412', 'FTZ60', 'BG5M', 10, '', '', 'tsi 1')], CTX)
    expect(r.ordens[0].maquinaId).toBe('TSI1')
  })

  it('aceita bags com virgula decimal', () => {
    const r = converterOrdens([CAB, linha('1', 'L-4412', 'FTZ60', 'BG5M', '10,5')], CTX)
    expect(r.ordens[0].bags).toBe(10.5)
  })
})

describe('endereco do lote na ordem', () => {
  it('le armazem, bloco e quadra', () => {
    const r = converterOrdens(
      [CAB_END, linha('1', 'L-4412', 'FTZ60', 'BG5M', 10, '', '', 'ARMAZEM C', 'BL01', 'QD04')],
      CTX,
    )
    expect(r.problemas).toHaveLength(0)
    expect(r.ordens[0].armazem).toBe('ARMAZEM C')
    expect(r.ordens[0].bloco).toBe('BL01')
    expect(r.ordens[0].quadra).toBe('QD04')
  })

  it('normaliza para maiusculas, para o endereco nao duplicar por caixa', () => {
    const r = converterOrdens(
      [CAB_END, linha('1', 'L-4412', 'FTZ60', 'BG5M', 10, '', '', 'armazem c', 'bl01', 'qd04')],
      CTX,
    )
    expect(r.ordens[0].armazem).toBe('ARMAZEM C')
    expect(r.ordens[0].bloco).toBe('BL01')
  })

  it('endereco e opcional: sem as colunas a ordem entra igual', () => {
    const r = converterOrdens([CAB, linha('1', 'L-4412', 'FTZ60', 'BG5M', 10)], CTX)
    expect(r.problemas).toHaveLength(0)
    expect(r.ordens[0].armazem).toBeNull()
  })

  it('endereco parcial e aceito: a logistica completa depois', () => {
    const r = converterOrdens(
      [CAB_END, linha('1', 'L-4412', 'FTZ60', 'BG5M', 10, '', '', 'ARMAZEM C', '', '')],
      CTX,
    )
    expect(r.problemas).toHaveLength(0)
    expect(r.ordens[0].armazem).toBe('ARMAZEM C')
    expect(r.ordens[0].bloco).toBeNull()
  })

  it('aceita os nomes de coluna da origem: Deposito, BL e QD', () => {
    const cab = ['Ordem', 'Lote', 'Tratamento', 'Embalagem', 'Bags', 'Deposito', 'BL', 'QD']
    const r = converterOrdens(
      [cab, linha('1', 'L-4412', 'FTZ60', 'BG5M', 10, 'ARMAZEM A', 'BL07', 'QD02')],
      CTX,
    )
    expect(r.ordens[0].armazem).toBe('ARMAZEM A')
    expect(r.ordens[0].bloco).toBe('BL07')
    expect(r.ordens[0].quadra).toBe('QD02')
  })
})
