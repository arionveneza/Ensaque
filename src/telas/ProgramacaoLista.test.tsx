import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { OrdemVisao } from '@/dados/api-gestao'
import { exibicaoDoDia, grupoMovel } from '@/dominio/quadroDoDia'
import { ListaMaquinaDia, type PropsListaMaquinaDia } from './ProgramacaoLista'

/**
 * A Programação exige login e o preview não vê a tela montada — este teste é
 * a conferência estrutural da lista: a coluna Seq numera pela fila padrão e
 * NÃO muda quando a tabela é ordenada por cultivar; concluída apagada;
 * urgente/normal; expedição atrasada em vermelho; total; cliques; setas.
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
  ordem({ id: 'F', seq: 5, status_efetivo: 'Programada', cultivar: 'NEO680 IPRO', data_expedicao: '2026-09-25' }),
  ordem({ id: 'E', seq: 6, status_efetivo: 'Finalizada', cultivar: 'SS NEO700 I2X', bags: 5, peso_t: 4 }),
]

function montar(extra: Partial<PropsListaMaquinaDia> = {}) {
  const { grupos } = exibicaoDoDia(fila)
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
    podeMarcarUrgente: true,
    onAbrir: vi.fn(),
    abrindoId: null,
    onPrioridade: vi.fn(),
    onAlternarUrgente: vi.fn(),
    posicaoNoGrupo: (o) => {
      const g = grupoMovel(grupos, o)
      return { pos: g.indexOf(o), tamanho: g.length }
    },
    onSubir: vi.fn(),
    onDescer: vi.fn(),
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
  const linha = (id: string) => r.container.querySelector<HTMLTableRowElement>(`tr[data-ordem="${id}"]`)!
  const setas = (id: string) => {
    const bs = [...linha(id).cells[11].querySelectorAll('button')]
    return { subir: bs.find((b) => b.textContent === '▲')!, descer: bs.find((b) => b.textContent === '▼')! }
  }
  return { ...r, props, linhas, linha, setas }
}

describe('ListaMaquinaDia', () => {
  it('sem ordenacao, segue a exibicao dos cartoes e numera 1..n', () => {
    const { linhas } = montar()
    expect(linhas().map((l) => `${l.id}:${l.seq}`)).toEqual(['C:1', 'A:2', 'B:3', 'D:4', 'F:5', 'E:6'])
  })

  it('ordenar por cultivar reordena as linhas mas NAO renumera a fila', () => {
    const { linhas } = montar({ ordenacao: { campo: 'cultivar', dir: 'asc' } })
    // 0820 < NEO680 (D, F pelo nº) < NEO1000 < O790 < SS NEO700 (numérico, pt-BR)
    expect(linhas().map((l) => `${l.id}:${l.seq}`)).toEqual(['C:1', 'D:4', 'F:5', 'B:3', 'A:2', 'E:6'])
  })

  it('concluida fica apagada; urgente e normal; P1 na vaga do status', () => {
    const { linhas } = montar()
    expect(linhas().find((l) => l.id === 'E')?.classes).toContain('opacity-70')
    expect(linhas().find((l) => l.id === 'A')?.classes).not.toContain('opacity-70')
    expect(screen.getAllByText('urgente')).toHaveLength(1 + 6) // a Tag da A + o botão de cada linha
    expect(screen.getAllByText('normal')).toHaveLength(5)
    expect(screen.getByText('P1')).toBeInTheDocument()
  })

  it('expedicao anterior ao dia programado sai em vermelho; sem expedicao e um traco', () => {
    const { linha } = montar()
    const celA = linha('A').cells[8]
    expect(celA.textContent).toBe('18/09')
    expect(celA.className).toContain('text-red-600')
    expect(linha('D').cells[8].textContent).toBe('—')
  })

  it('marca de reprogramacao e total de bags e toneladas', () => {
    montar()
    expect(screen.getByText('↷2')).toBeInTheDocument()
    const rodape = document.querySelector('tfoot')!
    expect(rodape.textContent).toContain('Total · 6 ordens')
    expect(rodape.textContent).toContain('65') // 20 + 10 + 10 + 10 + 10 + 5
    expect(rodape.textContent).toContain('55,0 t') // 17 + 8,5 × 4 + 4
  })

  it('clique no cabecalho ordena (inclusive Expedicao e Status); clique no numero abre a ordem', () => {
    const { props } = montar()
    fireEvent.click(screen.getByText('Cultivar'))
    fireEvent.click(screen.getByText('Expedição'))
    fireEvent.click(screen.getByText('Status'))
    expect(props.onOrdenar).toHaveBeenNthCalledWith(1, 'cultivar')
    expect(props.onOrdenar).toHaveBeenNthCalledWith(2, 'expedicao')
    expect(props.onOrdenar).toHaveBeenNthCalledWith(3, 'status')
    fireEvent.click(screen.getByRole('button', { name: 'B' }))
    expect(props.onAbrir).toHaveBeenCalledWith('B')
  })

  it('setas: so dentro do grupo de status, e travadas com ordenacao ou filtro', () => {
    const { props, setas } = montar()
    // D é a 1ª das duas Programadas: só desce; F é a última: só sobe
    expect(setas('D').subir.disabled).toBe(true)
    expect(setas('D').descer.disabled).toBe(false)
    expect(setas('F').subir.disabled).toBe(false)
    expect(setas('F').descer.disabled).toBe(true)
    fireEvent.click(setas('D').descer)
    expect(props.onDescer).toHaveBeenCalledWith(expect.objectContaining({ id: 'D' }))
    fireEvent.click(setas('F').subir)
    expect(props.onSubir).toHaveBeenCalledWith(expect.objectContaining({ id: 'F' }))
  })

  it('setas travadas quando a tabela esta ordenada por coluna', () => {
    const { setas } = montar({ ordenacao: { campo: 'cultivar', dir: 'asc' } })
    expect(setas('D').descer.disabled).toBe(true)
    expect(setas('D').descer.title).toMatch(/ordem padrão/)
  })

  it('botao urgente alterna; some sem a acao priorizar', () => {
    const { props, linha } = montar()
    const btn = [...linha('D').cells[11].querySelectorAll('button')].find((b) => b.textContent === 'urgente')!
    fireEvent.click(btn)
    expect(props.onAlternarUrgente).toHaveBeenCalledWith(expect.objectContaining({ id: 'D' }))
    montar({ podeMarcarUrgente: false })
    expect(screen.getAllByText('urgente')).toHaveLength(1 + 6 + 1) // primeira montagem + só a Tag na segunda
  })

  it('painel de mover so na linha da ordem escolhida; acoes invisiveis na iniciada', () => {
    const { container, linha } = montar({ movendoId: 'D' })
    expect(container.querySelectorAll('tr[data-painel-mover]')).toHaveLength(1)
    expect(container.querySelector('tr[data-painel-mover="D"]')?.textContent).toContain('PAINEL')
    expect(linha('C').cells[11].firstElementChild!.className).toContain('invisible')
    expect(linha('D').cells[11].firstElementChild!.className).not.toContain('invisible')
  })

  it('filtro de status que esconde tudo oferece "ver todas"; fila vazia diz que nao ha ordem', () => {
    const { props } = montar({ visivel: () => false, filtroAtivo: true })
    fireEvent.click(screen.getByText('ver todas'))
    expect(props.onLimparFiltro).toHaveBeenCalled()
    montar({ fila: [] })
    expect(screen.getByText('Nenhuma ordem programada.')).toBeInTheDocument()
  })
})
