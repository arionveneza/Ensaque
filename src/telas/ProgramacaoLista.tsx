import { Fragment, type ReactNode } from 'react'
import type { OrdemVisao } from '@/dados/api-gestao'
import { Cartao, Tabela, Tag, Vazio, corDoStatus, diaCurto, n } from '@/componentes/ui'
import { tempoPlanejadoS } from '@/dominio/calculos'
import { ehConcluida, ordenarQuadroDoDia, posicoesDeExibicao, type CampoQuadro } from '@/dominio/quadroDoDia'
import type { Ordenacao } from '@/dominio/ordenacao'
import { jaIniciada } from '@/dominio/status'
import type { StatusEfetivo } from '@/dominio/tipos'

/**
 * Quadro do dia em LISTA, uma tabela por máquina (19/09/2026, pedido do
 * Arion: "a tela de programação está ruim de olhar, tem como colocar uma
 * visão em lista, por máquina? onde eu possa classificar por cultivar,
 * tratamento e tonelada? […] Quase como um Excel").
 *
 * Só apresentação: a fila chega por seq (a ordem REAL), o agrupamento e a
 * ordenação vêm do domínio (`quadroDoDia`), e as ações (prioridade, mover,
 * urgente, ▲▼, abrir) são callbacks da Programação — a mesma lógica dos
 * cartões, sem duplicar; mexer num modo reflete no outro porque os dois
 * leem a mesma fila. Ordenar pelo cabeçalho é só visão: a coluna Seq
 * continua mostrando a posição real da fila, calculada da fila padrão e não
 * do índice da tabela ordenada, e o seq gravado não muda. As setas ▲▼ só
 * funcionam na ordem padrão (numa tabela ordenada por cultivar, "subir" uma
 * linha seria ambíguo) — a mesma trava que os cartões têm com o filtro.
 *
 * Duas ordens padrão: POR STATUS (como os cartões: rodando → pronto →
 * aguardando → programada → produzidas) ou PELA SEQUÊNCIA (a fila como a
 * máquina vai rodar, produzidas no fim) — a segunda é a que mostra a
 * sequência otimizada de ponta a ponta ("Otimizar sem status").
 */
export interface PropsListaMaquinaDia {
  titulo: ReactNode
  acoes?: ReactNode
  /** Resumo da máquina no dia (programado, setup, ocupação, falta produzir) — o mesmo do cartão. */
  resumo: ReactNode
  /** Fila da máquina no dia, por seq. */
  fila: OrdemVisao[]
  /** t/h da máquina — dá o tempo planejado de cada ordem (0 = sem capacidade). */
  capacidadeTh: number
  /** Filtro de status do quadro (o mesmo dos cartões). */
  visivel: (o: OrdemVisao) => boolean
  filtroAtivo: boolean
  onLimparFiltro: () => void
  /** Ordenação DESTA máquina (cada tabela tem a sua — pedido do Arion). */
  ordenacao: Ordenacao<CampoQuadro>
  onOrdenar: (campo: CampoQuadro) => void
  /** Nº de itens por receita — a coluna Tratamento ordena por família e base antes das derivações. */
  itensPorReceita?: ReadonlyMap<string, number>
  /** Ordem padrão: por status (cartões) ou pela sequência gravada. */
  porStatus: boolean
  onAlternarPorStatus: () => void
  podeProgramar: boolean
  /** Ação ordens/priorizar — o botão "urgente". */
  podeMarcarUrgente: boolean
  onAbrir: (id: string) => void
  abrindoId: string | null
  onPrioridade: (ord: OrdemVisao) => void
  onAlternarUrgente: (ord: OrdemVisao) => void
  /** ▲▼: posição da ordem no seu grupo (do status, ou a fila inteira sem status). */
  posicaoNoGrupo: (ord: OrdemVisao) => { pos: number; tamanho: number }
  onSubir: (ord: OrdemVisao) => void
  onDescer: (ord: OrdemVisao) => void
  movendoId: string | null
  onAlternarMover: (ord: OrdemVisao) => void
  /** O PainelMover da Programação, aberto numa linha extra abaixo da ordem. */
  painelMover: (ord: OrdemVisao) => ReactNode
}

/** Colunas visíveis fora de `lg` (Emb. e Lote somem) — as linhas especiais precisam somar isto. */
const COLUNAS_SEMPRE = 11
const COLUNAS_SO_LG = 2

const BOTAO = 'rounded border px-3 py-2 text-xs uppercase tracking-wide lg:px-1.5 lg:py-0.5 lg:text-[10px]'

/** "1h25", "0h40" — horas e minutos, sem segundos (a lista é planejamento). */
const hm = (segundos: number): string => {
  if (!Number.isFinite(segundos)) return '—'
  const min = Math.round(segundos / 60)
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}`
}

export function ListaMaquinaDia({
  titulo, acoes, resumo, fila, capacidadeTh, visivel, filtroAtivo, onLimparFiltro, ordenacao, onOrdenar,
  itensPorReceita, porStatus, onAlternarPorStatus, podeProgramar, podeMarcarUrgente, onAbrir, abrindoId,
  onPrioridade, onAlternarUrgente, posicaoNoGrupo, onSubir, onDescer, movendoId, onAlternarMover, painelMover,
}: PropsListaMaquinaDia) {
  const posicao = posicoesDeExibicao(fila, porStatus)
  const linhas = ordenarQuadroDoDia(fila, ordenacao, itensPorReceita, porStatus).filter(visivel)
  const seta = (c: CampoQuadro) => (ordenacao?.campo === c ? ordenacao.dir : undefined)
  const col = (texto: string, campo: CampoQuadro, className?: string) => ({
    texto, className, onClick: () => onOrdenar(campo), ordem: seta(campo),
  })
  const tempo = (pesoT: number) => (capacidadeTh > 0 ? hm(tempoPlanejadoS(pesoT, capacidadeTh)) : '—')
  const totBags = linhas.reduce((a, o) => a + o.bags, 0)
  const totT = linhas.reduce((a, o) => a + o.peso_t, 0)
  const setasTravadas = ordenacao != null || filtroAtivo
  const dicaSetas = ordenacao != null
    ? 'Volte à ordem padrão (clique de novo no cabeçalho) para reordenar com as setas'
    : filtroAtivo
      ? 'Limpe o filtro para reordenar com as setas'
      : undefined

  return (
    <Cartao titulo={titulo} acoes={acoes}>
      {resumo}
      <div className="mb-2 flex flex-wrap items-center gap-1 text-xs text-stone-500 dark:text-stone-400">
        <span className="mr-1">Ordem da fila:</span>
        {(
          [
            [true, 'por status', 'Rodando → pronta → aguardando lote → programada → produzidas (como os cartões)'],
            [false, 'pela sequência', 'A fila como a máquina vai rodar — a sequência otimizada de ponta a ponta; produzidas no fim'],
          ] as const
        ).map(([valor, rotulo, dica]) => (
          <button
            key={rotulo}
            type="button"
            title={dica}
            onClick={() => porStatus !== valor && onAlternarPorStatus()}
            className={`rounded-md border px-2 py-1 ${
              porStatus === valor
                ? 'border-green-600 bg-green-50 font-medium text-green-800 dark:bg-green-950 dark:text-green-300'
                : 'border-stone-300 text-stone-600 dark:border-stone-700 dark:text-stone-300'
            }`}
          >
            {rotulo}
          </button>
        ))}
      </div>
      {fila.length === 0 ? (
        <Vazio>Nenhuma ordem programada.</Vazio>
      ) : linhas.length === 0 ? (
        <p className="py-3 text-center text-sm text-stone-500">
          Nenhuma ordem com o status filtrado nesta máquina.{' '}
          <button type="button" onClick={onLimparFiltro} className="underline">ver todas</button>
        </p>
      ) : (
        /* larguraFixa: são várias tabelas SEPARADAS, uma por máquina,
           empilhadas — sem table-fixed cada uma calcula as colunas pelo
           próprio conteúdo e Bags/Peso da TSI 1 não ficam embaixo dos da
           TSI 2 (o achado do Arion de 26/08/2026 na Logística). TODA coluna
           tem largura (com folga pro cabeçalho em maiúsculas + a seta):
           deixar Cultivar/Tratamento "com o que sobra" as esmagava a 23 px
           num monitor de 1280, porque table-fixed + w-full não deixa a
           tabela crescer; com largura própria a tabela passa da caixa e
           rola de lado, que é o comportamento da lista de Ordens. */
        <Tabela
          larguraFixa
          cabecalho={[
            { texto: '#Seq', className: 'w-12' },
            { texto: 'Ordem', className: 'w-24' },
            col('Cultivar', 'cultivar', 'w-28'),
            col('Tratamento', 'tratamento', 'w-28'),
            { texto: 'Emb.', className: 'hidden w-20 lg:table-cell' },
            { texto: 'Lote', className: 'hidden w-36 lg:table-cell' },
            col('#Bags', 'bags', 'w-20'),
            col('#Peso', 'peso', 'w-20'),
            { texto: '#Tempo', className: 'w-16' },
            col('Expedição', 'expedicao', 'w-24'),
            { texto: 'Urgente', className: 'w-20' },
            col('Status', 'status', 'w-52'),
            { texto: '', className: 'w-60' },
          ]}
          rodape={
            <tr className="border-t border-stone-300 text-xs dark:border-stone-700">
              <td colSpan={4} className="px-2 py-1.5 font-medium uppercase tracking-wide text-stone-500">
                Total · {linhas.length} {linhas.length === 1 ? 'ordem' : 'ordens'}
                {filtroAtivo && ' (filtro ativo)'}
              </td>
              <td className="hidden lg:table-cell" colSpan={COLUNAS_SO_LG} />
              <td className="num-tabular px-2 py-1.5 text-right font-semibold">{n(totBags, 0)}</td>
              <td className="num-tabular px-2 py-1.5 text-right font-semibold whitespace-nowrap">{n(totT, 1)} t</td>
              <td className="num-tabular px-2 py-1.5 text-right font-semibold whitespace-nowrap">{tempo(totT)}</td>
              <td colSpan={4} />
            </tr>
          }
        >
          {linhas.map((ord) => {
            const concluida = ehConcluida(ord.status_efetivo)
            const movivel = podeProgramar && !jaIniciada(ord.status_efetivo as StatusEfetivo)
            const atrasada = !!ord.data_expedicao && !!ord.data_prog && ord.data_prog > ord.data_expedicao
            const { pos, tamanho } = posicaoNoGrupo(ord)
            const urgente = ord.prioridade === 'Urgente'
            return (
              <Fragment key={ord.id}>
                {/* já produzida: fundo verde (pedido do Arion, 19/09/2026), não apagada */}
                <tr
                  className={`border-t border-stone-100 dark:border-stone-800/60 ${
                    concluida ? 'bg-green-50 dark:bg-green-950/30' : ''
                  }`}
                  data-ordem={ord.id}
                >
                  <td className="num-tabular px-2 py-1.5 text-right align-middle text-stone-400">
                    {posicao.get(ord.id)}
                  </td>
                  <td className="px-2 py-1.5 align-middle font-medium">
                    {/* o nº fica e só apaga enquanto carrega: trocar o texto
                        mexeria na largura da coluna a cada clique. nowrap: o
                        ↷n não pode cair pra linha de baixo quando a tabela aperta */}
                    <span className="whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() => onAbrir(ord.id)}
                        disabled={abrindoId === ord.id}
                        title="Abrir a ordem (tempos, tanques, impressão)"
                        className="underline-offset-4 hover:underline disabled:cursor-wait disabled:opacity-50"
                      >
                        {ord.numero}
                      </button>
                      {!!ord.reprogramacoes && ord.reprogramacoes > 0 && (
                        <span
                          className="ml-1 cursor-help text-xs font-normal text-amber-700 dark:text-amber-400"
                          title={`Reprogramada ${ord.reprogramacoes}× — estava para ${diaCurto(ord.data_prog_original ?? null)}`}
                        >
                          ↷{ord.reprogramacoes}
                        </span>
                      )}
                    </span>
                    {/* no tablet, emb. e lote somem como coluna e aparecem aqui (padrão da lista de Ordens) */}
                    <p className="text-xs font-normal text-stone-500 lg:hidden">
                      {ord.embalagem} · lote {ord.lote_id}
                    </p>
                  </td>
                  <td className="px-2 py-1.5 align-middle">{ord.cultivar}</td>
                  <td className="px-2 py-1.5 align-middle">{ord.receita_nome}</td>
                  <td className="hidden px-2 py-1.5 align-middle lg:table-cell">{ord.embalagem}</td>
                  <td className="hidden px-2 py-1.5 align-middle font-medium lg:table-cell">{ord.lote_id}</td>
                  <td className="num-tabular px-2 py-1.5 text-right align-middle">{ord.bags}</td>
                  <td className="num-tabular px-2 py-1.5 text-right align-middle whitespace-nowrap">{n(ord.peso_t, 1)} t</td>
                  <td
                    className="num-tabular px-2 py-1.5 text-right align-middle whitespace-nowrap text-stone-600 dark:text-stone-300"
                    title={`Tempo planejado desta ordem: ${n(ord.peso_t, 1)} t ÷ ${n(capacidadeTh, 1)} t/h (sem setup)`}
                  >
                    {tempo(ord.peso_t)}
                  </td>
                  <td
                    className={`num-tabular px-2 py-1.5 align-middle text-xs whitespace-nowrap ${
                      atrasada ? 'font-semibold text-red-600 dark:text-red-400' : 'text-stone-500'
                    }`}
                    title={atrasada ? 'A máquina está programada para DEPOIS da data do caminhão' : 'Expedição prevista'}
                  >
                    {ord.data_expedicao ? diaCurto(ord.data_expedicao) : '—'}
                  </td>
                  <td className="px-2 py-1.5 align-middle">
                    {urgente ? <Tag cor="perigo">urgente</Tag> : <span className="text-xs text-stone-400">normal</span>}
                  </td>
                  <td className="px-2 py-1.5 align-middle whitespace-nowrap">
                    {/* vaga fixa do P{n} da faixa de prioridades, como no cartão */}
                    <span className="inline-flex items-center gap-2">
                      <span className="inline-block w-8 shrink-0 text-center">
                        {ord.prioridade_dia != null && (
                          <span
                            className="inline-block rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-white"
                            title="Está na faixa de prioridades do dia"
                          >
                            P{ord.prioridade_dia}
                          </span>
                        )}
                      </span>
                      <Tag cor={corDoStatus(ord.status_efetivo)} className="min-w-36 text-center">
                        {ord.status_efetivo}
                      </Tag>
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right align-middle whitespace-nowrap">
                    {/* o bloco SEMPRE ocupa o espaço (invisível quando não
                        movível): toda linha com a mesma altura */}
                    <span
                      className={`inline-flex items-center gap-2 ${movivel ? '' : 'invisible'}`}
                      aria-hidden={!movivel}
                    >
                      <button
                        type="button"
                        tabIndex={movivel ? 0 : -1}
                        onClick={() => onPrioridade(ord)}
                        title={
                          ord.prioridade_dia != null
                            ? 'Tirar da faixa de prioridades do dia'
                            : 'Pôr no fim da faixa de prioridades do dia'
                        }
                        className={`${BOTAO} hover:bg-amber-100 ${
                          ord.prioridade_dia != null
                            ? 'border-amber-500 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                            : 'border-stone-300 text-stone-500 dark:border-stone-600 dark:hover:bg-stone-700'
                        }`}
                      >
                        {ord.prioridade_dia != null ? 'priorizada' : 'prioridade'}
                      </button>
                      <button
                        type="button"
                        tabIndex={movivel ? 0 : -1}
                        onClick={() => onAlternarMover(ord)}
                        title="Mover para outro dia ou máquina"
                        className={`${BOTAO} border-stone-300 text-stone-500 hover:bg-stone-100 dark:border-stone-600 dark:hover:bg-stone-700`}
                      >
                        mover
                      </button>
                      {podeMarcarUrgente && (
                        <button
                          type="button"
                          tabIndex={movivel ? 0 : -1}
                          onClick={() => onAlternarUrgente(ord)}
                          title={urgente ? 'Voltar a normal' : 'Marcar como urgente'}
                          className={`${BOTAO} ${
                            urgente
                              ? 'border-red-400 bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-300'
                              : 'border-stone-300 text-stone-500 hover:bg-red-50 dark:border-stone-600 dark:hover:bg-stone-700'
                          }`}
                        >
                          urgente
                        </button>
                      )}
                      <span className="inline-flex flex-col">
                        <button
                          type="button"
                          tabIndex={movivel ? 0 : -1}
                          disabled={setasTravadas || pos <= 0}
                          title={dicaSetas}
                          onClick={() => onSubir(ord)}
                          className="px-1 text-sm leading-none disabled:opacity-20 lg:text-xs"
                        >
                          ▲
                        </button>
                        <button
                          type="button"
                          tabIndex={movivel ? 0 : -1}
                          disabled={setasTravadas || pos < 0 || pos >= tamanho - 1}
                          title={dicaSetas}
                          onClick={() => onDescer(ord)}
                          className="px-1 text-sm leading-none disabled:opacity-20 lg:text-xs"
                        >
                          ▼
                        </button>
                      </span>
                    </span>
                  </td>
                </tr>
                {movendoId === ord.id && (
                  <tr data-painel-mover={ord.id}>
                    <td colSpan={COLUNAS_SEMPRE} className="px-2 pb-2">{painelMover(ord)}</td>
                    <td className="hidden lg:table-cell" colSpan={COLUNAS_SO_LG} />
                  </tr>
                )}
              </Fragment>
            )
          })}
        </Tabela>
      )}
    </Cartao>
  )
}
