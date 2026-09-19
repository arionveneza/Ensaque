import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { OrdemVisao } from '@/dados/api-gestao'
import { ListaMaquinaDia, type PropsListaMaquinaDia } from './ProgramacaoLista'

/**
 * A Programação exige login e o preview não vê a tela montada — este teste é
 * a conferência estrutural da lista: a coluna Seq numera pela fila padrão e
 * NÃO muda quando a tabela é ordenada por cultivar; concluída apagada;
 * urgente/normal; expedição atrasada em vermelho; total; cliques.
 */
const ordem = (p: Partial<OrdemVisao> & { id: string }): OrdemVisao =>
  ({
    numero: p.id,
    cultivar: 'NEO680 IPRO',
    receita_nome: 'FTZ60',
    embalagem: 'BG5M',
    bags: 10,
    lote_id: 'SV01',
    prioridade: 'Normal',
    maquina_id: 'TSI1',
    data_prog: '2026-09-19',
    data_expedicao: null,
    seq: 1,
    prioridade_dia: null,
    status_efetivo: 'Programada',
    peso_t: 8.5,
    reprogramacoes: 0,
    ...p,
  }) as unknown as OrdemVisao

// a fila por seq, misturando estágios — como vem do banco
const fila: OrdemVisao[] = [
  ordem({ id: 'A', seq: 1, status_efetivo: 'Pronto para produzir', cultivar: 'O790 IPRO', prioridade: 'Urgente', data_expedicao: '2026-09-18', bags: 20, peso_t: 17 }),
  ordem({ id: 'B', seq: 2, status_efetivo: 'Aguardando lote', cultivar: 'NEO1000 IPRO', prioridade_dia: 1 }),
  ordem({ id: 'C', seq: 3, status_efetivo: 'Em producao', cultivar: '0820 IPRO', reprogramacoes: 2, data_prog_original: '2026-09-17' }),
  ordem({ id: 'D', seq: 4, status_efetivo: 'Programada', cultivar: 'NEO680 IPRO' }),
  ordem({ id: 'E', seq: 5, status_efetivo: 'Finalizada', cultivar: 'SS NEO700 I2X', bags: 5, peso_t: 4 }),
]

function montar(extra: Partial<PropsListaMaquinaDia> = {}) {
  const props: PropsListaMaquinaDia = {
    titulo: 'TSI 1',
    resumo: <p>resumo</p>,
    fila,
    visivel: () => true,
    filtroAtivo: false,
    onLimparFiltro: vi.fn(),
    ordenacao: null,
    onOrdenar: vi.fn(),
    podeProgramar: true,
    onAbrir: vi.fn(),
    abrindoId: null,
    onPrioridade: vi.fn(),
    movendoId: null,
    onAlternarMover: vi.fn(),
    painelMover: () => <div>PAINEL</div>,
    ...extra,
  }
  const r = render(<ListaMaquinaDia {...props} />)
  const linhas = () =>
    [...r.container.querySelectorAll<HTMLTableRowElement>('tbody tr[data-ordem]')].map((tr) => ({
      id: tr.dataset.ordem,
      seq: tr.cells[0].textContent,
      classes: tr.className,
    }))
  return { ...r, props, linhas }
}

describe('ListaMaquinaDia', () => {
  it('sem ordenacao, segue a exibicao dos cartoes e numera 1..n', () => {
    const { linhas } = montar()
    expect(linhas().map((l) => `${l.id}:${l.seq}`)).toEqual(['C:1', 'A:2', 'B:3', 'D:4', 'E:5'])
  })

  it('ordenar por cultivar reordena as linhas mas NAO renumera a fila', () => {
    const { linhas } = montar({ ordenacao: { campo: 'cultivar', dir: 'asc' } })
    // 0820 < NEO680 < NEO1000 < O790 < SS NEO700 (numérico, pt-BR)
    expect(linhas().map((l) => `${l.id}:${l.seq}`)).toEqual(['C:1', 'D:4', 'B:3', 'A:2', 'E:5'])
  })

  it('concluida fica apagada; urgente e normal; P1 na vaga do status', () => {
    const { linhas } = montar()
    expect(linhas().find((l) => l.id === 'E')?.classes).toContain('opacity-70')
    expect(linhas().find((l) => l.id === 'A')?.classes).not.toContain('opacity-70')
    expect(screen.getByText('urgente')).toBeInTheDocument()
    expect(screen.getAllByText('normal')).toHaveLength(4)
    expect(screen.getByText('P1')).toBeInTheDocument()
  })

  it('expedicao anterior ao dia programado sai em vermelho; sem expedicao e um traco', () => {
    const { container } = montar()
    const celA = container.querySelector<HTMLTableRowElement>('tr[data-ordem="A"]')!.cells[8]
    expect(celA.textContent).toBe('18/09')
    expect(celA.className).toContain('text-red-600')
    expect(container.querySelector<HTMLTableRowElement>('tr[data-ordem="D"]')!.cells[8].textContent).toBe('—')
  })

  it('marca de reprogramacao e total de bags e toneladas', () => {
    montar()
    expect(screen.getByText('↷2')).toBeInTheDocument()
    const rodape = document.querySelector('tfoot')!
    expect(rodape.textContent).toContain('Total · 5 ordens')
    expect(rodape.textContent).toContain('55') // 20 + 10 + 10 + 10 + 5
    expect(rodape.textContent).toContain('46,5 t') // 17 + 8,5 × 3 + 4
  })

  it('clique no cabecalho ordena; clique no numero abre a ordem', () => {
    const { props } = montar()
    fireEvent.click(screen.getByText('Cultivar'))
    expect(props.onOrdenar).toHaveBeenCalledWith('cultivar')
    fireEvent.click(screen.getByRole('button', { name: 'B' }))
    expect(props.onAbrir).toHaveBeenCalledWith('B')
  })

  it('painel de mover so na linha da ordem escolhida; acoes invisiveis na iniciada', () => {
    const { container } = montar({ movendoId: 'D' })
    expect(container.querySelectorAll('tr[data-painel-mover]')).toHaveLength(1)
    expect(container.querySelector('tr[data-painel-mover="D"]')?.textContent).toContain('PAINEL')
    const acoesC = container.querySelector<HTMLTableRowElement>('tr[data-ordem="C"]')!.cells[11].firstElementChild!
    expect(acoesC.className).toContain('invisible')
    const acoesD = container.querySelector<HTMLTableRowElement>('tr[data-ordem="D"]')!.cells[11].firstElementChild!
    expect(acoesD.className).not.toContain('invisible')
  })

  it('filtro de status que esconde tudo oferece "ver todas"; fila vazia diz que nao ha ordem', () => {
    const { props } = montar({ visivel: () => false, filtroAtivo: true })
    fireEvent.click(screen.getByText('ver todas'))
    expect(props.onLimparFiltro).toHaveBeenCalled()
    montar({ fila: [] })
    expect(screen.getByText('Nenhuma ordem programada.')).toBeInTheDocument()
  })
})
