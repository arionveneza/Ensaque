import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '@/dados/api'
import type { LinhaMaquina, LinhaOrdem } from '@/dados/api'
import * as g from '@/dados/api-gestao'
import type { ConferenciaLinha } from '@/dados/api-gestao'
import {
  mapaMotivos,
  paraOrdemDominio,
  pesoOrdemKg,
} from '@/dados/adaptadores'
import {
  diaDeProducao,
  duracaoParadaMaquinaS,
  formataHms,
  tempoPlanejadoS,
  temposOrdem,
} from '@/dominio/calculos'
import { statusEfetivo } from '@/dominio/status'
import type { StatusEfetivo } from '@/dominio/tipos'
import { useRealtime } from '@/dados/useRealtime'
import { useAuth } from '@/auth/AuthProvider'
import { ModalMotivoParada } from '@/componentes/ModalMotivoParada'
import { diaCurto } from '@/componentes/ui'
import ModalOrdem from './ModalOrdem'
import CalculadoraCalda from './CalculadoraCalda'

/**
 * O motivo do botão de um clique. Vive no cadastro como qualquer outro
 * (migração `parada-de-maquina.sql`) — a constante é só para achá-lo; se
 * alguém renomear, o botão some e o "outro motivo" continua servindo.
 */
const MOTIVO_AGUARDANDO_SEMENTE = 'Aguardando semente'

const num = (v: number, casas = 1) =>
  v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })

const CORES_STATUS: Record<StatusEfetivo, string> = {
  'Nao programada': 'bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300',
  Programada: 'bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300',
  'Aguardando lote': 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  'Pronto para produzir': 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  'Em producao': 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  Parada: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  Finalizada: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
  'Qualidade apontada': 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
  Apontada: 'bg-stone-800 text-stone-100 dark:bg-stone-200 dark:text-stone-900',
  // nunca deveria chegar aqui (ordem excluída some da Execução), mas o
  // Record precisa da entrada
  Excluida: 'bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300',
}

export default function Execucao() {
  const { usuario, permitido } = useAuth()
  const [dia, setDia] = useState(() => diaDeProducao(new Date()))
  const [cadastros, setCadastros] = useState<Awaited<ReturnType<typeof api.carregarCadastros>> | null>(null)
  const [ordens, setOrdens] = useState<LinhaOrdem[]>([])
  const [conferencias, setConferencias] = useState<ConferenciaLinha[]>([])
  const [embalagens, setEmbalagens] = useState<g.EmbalagemLinha[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [aberta, setAberta] = useState<string | null>(null)
  const [caldaAberta, setCaldaAberta] = useState(false)
  const [agora, setAgora] = useState(() => Date.now())
  // parada de MÁQUINA: a que acontece sem ordem nenhuma rodando, tipicamente
  // aguardando semente. Não cabia em ordem_paradas, que exige ordem, e por
  // isso esse tempo não era medido (pedido do Arion, 12/09/2026).
  const [paradasMaquina, setParadasMaquina] = useState<api.LinhaParadaMaquina[]>([])

  const podeApontar = permitido('execucao', 'apontar')

  const recarregar = useCallback(async () => {
    try {
      setErro(null)
      const [linhas, paradas] = await Promise.all([
        api.carregarOrdens(dia),
        api.carregarParadasMaquina(dia),
      ])
      setOrdens(linhas)
      setParadasMaquina(paradas)
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }, [dia])

  useEffect(() => {
    let vivo = true
    setCarregando(true)
    Promise.all([
      api.carregarCadastros(), api.carregarOrdens(dia), g.listarConferencias(), g.listarEmbalagens(),
      api.carregarParadasMaquina(dia),
    ])
      .then(([c, o, cf, e, pm]) => {
        if (!vivo) return
        setCadastros(c)
        setOrdens(o)
        setConferencias(cf)
        setEmbalagens(e)
        setParadasMaquina(pm)
      })
      .catch((e) => vivo && setErro(e instanceof Error ? e.message : String(e)))
      .finally(() => vivo && setCarregando(false))
    return () => {
      vivo = false
    }
  }, [dia])

  // o PCP e a produção olham a mesma ordem ao mesmo tempo: sem isto, uma tela mente
  useRealtime(
    ['ordens', 'ordem_eventos', 'ordem_paradas', 'ordem_tanques', 'maquina_paradas'],
    recarregar,
  )

  // relógio dos cronômetros: corre com ordem em andamento OU com máquina
  // parada sem ordem — senão o cronômetro da espera ficava congelado
  const temAndamento =
    ordens.some((o) => o.status === 'Em producao' || o.status === 'Parada') ||
    paradasMaquina.some((p) => !p.fim)
  useEffect(() => {
    if (!temAndamento) return
    const t = setInterval(() => setAgora(Date.now()), 1000)
    return () => clearInterval(t)
  }, [temAndamento])

  /**
   * Aba em segundo plano tem o timer congelado pelo navegador (sleeping
   * tabs / modo de eficiência do Edge, throttling do Chrome): o cronômetro
   * parava e só "acordava" na próxima interação. Ao voltar para a aba,
   * resincroniza o relógio E os dados — o websocket do realtime dorme
   * junto, então a tela pode ter perdido apontamentos de outro usuário.
   */
  useEffect(() => {
    const resync = () => {
      if (document.visibilityState !== 'visible') return
      setAgora(Date.now())
      void recarregar()
    }
    document.addEventListener('visibilitychange', resync)
    window.addEventListener('focus', resync)
    return () => {
      document.removeEventListener('visibilitychange', resync)
      window.removeEventListener('focus', resync)
    }
  }, [recarregar])

  const motivos = useMemo(() => mapaMotivos(cadastros?.motivos ?? []), [cadastros])

  const motivoSemente = useMemo(
    () => (cadastros?.motivos ?? []).find((m) => m.descricao === MOTIVO_AGUARDANDO_SEMENTE) ?? null,
    [cadastros],
  )

  const abrirParada = useCallback(
    async (maquinaId: string, motivoId: string) => {
      try {
        setErro(null)
        await api.abrirParadaMaquina(maquinaId, motivoId)
        await recarregar()
      } catch (e) {
        setErro(e instanceof Error ? e.message : String(e))
      }
    },
    [recarregar],
  )

  const encerrarParada = useCallback(
    async (maquinaId: string) => {
      try {
        setErro(null)
        await api.encerrarParadaMaquina(maquinaId)
        await recarregar()
      } catch (e) {
        setErro(e instanceof Error ? e.message : String(e))
      }
    },
    [recarregar],
  )

  // mesma ordem do quadro da Programação: a sequência manda, e só ela — o
  // operador precisa ver a fila exatamente como o PCP a deixou
  const porMaquina = useCallback(
    (m: string) =>
      ordens
        .filter((o) => o.maquina_id === m)
        .sort((a, b) => (a.seq ?? 9999) - (b.seq ?? 9999) || a.numero.localeCompare(b.numero)),
    [ordens],
  )

  // "Iniciar" apenas ABRE a ordem para preparação: o operador escolhe o
  // tanque de cada produto e informa os pesos. O cronômetro só dispara no
  // Confirmar início.
  function iniciar(o: LinhaOrdem) {
    setErro(null)
    setAberta(o.id)
  }

  if (carregando) {
    return <p className="p-8 text-sm text-stone-500">Carregando execução…</p>
  }

  const ordemAberta = ordens.find((o) => o.id === aberta) ?? null
  const semProgramacao = ordens.length === 0

  return (
    <div className="mx-auto max-w-[1600px] px-6 py-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-stone-900 dark:text-stone-100">Execução</h2>
          <p className="text-sm text-stone-500 dark:text-stone-400">
            Dia de produção das 07:30 às 03:00 — o turno 2 pertence ao dia que começou.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => setCaldaAberta(true)}
            className="rounded-md border border-stone-300 px-3 py-1.5 text-sm text-stone-700 hover:bg-stone-50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
            title="Quantidade de cada químico para preparar a mistura"
          >
            Calda (MIX)
          </button>
          <label className="text-sm text-stone-600 dark:text-stone-300">
            Dia
            <input
              type="date"
              value={dia}
              onChange={(e) => setDia(e.target.value)}
              className="ml-2 rounded-md border border-stone-300 px-2 py-1 dark:border-stone-700 dark:bg-stone-800"
            />
          </label>
        </div>
      </div>

      {caldaAberta && <CalculadoraCalda onFechar={() => setCaldaAberta(false)} />}

      {erro && (
        <div className="mb-5 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {erro}
        </div>
      )}

      {/* ---------- cards por máquina ---------- */}
      <div className="mb-8 grid gap-4 sm:grid-cols-2">
        {(cadastros?.maquinas ?? []).map((m) => (
          <CardMaquina
            key={m.id}
            maquina={m}
            ordens={porMaquina(m.id)}
            motivos={motivos}
            motivosLista={cadastros?.motivos ?? []}
            agora={agora}
            onAbrir={setAberta}
            podeApontar={podeApontar}
            paradaMaquina={paradasMaquina.find((p) => p.maquina_id === m.id && !p.fim) ?? null}
            motivoSemente={motivoSemente}
            onAbrirParada={abrirParada}
            onEncerrarParada={encerrarParada}
          />
        ))}
      </div>

      {/* ---------- grade ---------- */}
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-400">
        Ordens do dia
      </h3>

      {semProgramacao ? (
        <p className="rounded-md bg-stone-50 px-4 py-8 text-center text-sm text-stone-500 dark:bg-stone-800/50 dark:text-stone-400">
          Nenhuma ordem programada para este dia.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-stone-200 dark:border-stone-800">
          <table className="w-full text-sm">
            <thead className="bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500 dark:bg-stone-800/50 dark:text-stone-400">
              <tr>
                <th className="px-2 py-2 lg:px-3">Seq</th>
                <th className="px-2 py-2 lg:px-3">Ordem</th>
                {/* no tablet o botão de ação vale mais que o cultivar (que o modal mostra) */}
                <th className="hidden px-3 py-2 lg:table-cell">Cultivar</th>
                <th className="px-2 py-2 lg:px-3">Tratamento</th>
                <th className="px-2 py-2 lg:px-3">Lote</th>
                <th className="px-2 py-2 lg:px-3">Emb.</th>
                <th className="px-2 py-2 lg:px-3 text-right">Qtd</th>
                <th className="px-2 py-2 lg:px-3 text-right">Peso</th>
                <th className="px-2 py-2 lg:px-3">Status</th>
                <th className="px-2 py-2 lg:px-3"></th>
              </tr>
            </thead>
            <tbody>
              {(cadastros?.maquinas ?? []).map((m) => {
                const lista = porMaquina(m.id)
                if (lista.length === 0) return null
                return (
                  <FragmentoMaquina
                    key={m.id}
                    nome={m.nome}
                    lista={lista}
                    podeApontar={!!podeApontar}
                    onIniciar={iniciar}
                    onAbrir={setAberta}
                  />
                )
              })}
              {ordens.filter((o) => !o.maquina_id).length > 0 && (
                <FragmentoMaquina
                  nome="Sem máquina (pool)"
                  lista={ordens.filter((o) => !o.maquina_id)}
                  podeApontar={!!podeApontar}
                  onIniciar={iniciar}
                  onAbrir={setAberta}
                  numerada={false}
                />
              )}
            </tbody>
          </table>
        </div>
      )}

      {ordemAberta && cadastros && usuario && (
        <ModalOrdem
          ordem={ordemAberta}
          produtos={cadastros.produtos}
          motivos={cadastros.motivos}
          podeApontar={!!podeApontar}
          agora={agora}
          capacidadeTh={
            cadastros.maquinas.find((m) => m.id === ordemAberta.maquina_id)?.capacidade_th ?? null
          }
          conferencia={conferencias.find((c) => c.ordem_id === ordemAberta.id) ?? null}
          embalagens={embalagens}
          onFechar={() => setAberta(null)}
          onMudou={recarregar}
        />
      )}
    </div>
  )
}

function FragmentoMaquina({
  nome,
  lista,
  podeApontar,
  onIniciar,
  onAbrir,
  numerada = true,
}: {
  nome: string
  lista: LinhaOrdem[]
  podeApontar: boolean
  onIniciar: (o: LinhaOrdem) => void
  onAbrir: (id: string) => void
  /** O pool não tem sequência de execução — mostra traço no lugar. */
  numerada?: boolean
}) {
  const totalT = lista.reduce((a, o) => a + pesoOrdemKg(o) / 1000, 0)
  return (
    <>
      {/* Faixa cheia, não fundo claro: a grade é longa e rolada, e esta linha
          é a referência de onde o operador está na lista. O pool fica em
          cinza — verde é para máquina de verdade, e o pool não é uma. */}
      <tr
        className={
          numerada
            ? 'bg-green-700 text-white dark:bg-green-800'
            : 'bg-stone-600 text-white dark:bg-stone-700'
        }
      >
        {/* colSpan 6 + célula fantasma: acompanha a coluna Cultivar, que some em tela estreita */}
        <td colSpan={6} className="px-2 py-2.5 lg:px-3">
          <span className="text-lg font-bold tracking-tight">{nome}</span>
        </td>
        <td className="hidden lg:table-cell" />
        <td className="num-tabular px-2 py-2.5 text-right text-sm font-bold lg:px-3">
          {num(totalT, 1)} t
        </td>
        <td colSpan={2}></td>
      </tr>
      {lista.map((o, idx) => {
        const status = statusEfetivo(paraOrdemDominio(o))
        return (
          <tr
            key={o.id}
            className="border-t border-stone-100 hover:bg-stone-50 dark:border-stone-800/60 dark:hover:bg-stone-800/30"
          >
            {/* posição na fila, não o seq gravado: o seq herdou duplicata e
                buraco de reprogramações antigas (3,3,4,7...), e o que o
                operador precisa é a ordem de execução — igual à Programação */}
            <td className="px-2 py-2 text-stone-400 lg:px-3">{numerada ? idx + 1 : '—'}</td>
            <td className="px-2 py-2 font-medium whitespace-nowrap lg:px-3">
              {/* a etiqueta mora numa vaga de largura fixa ANTES do número, em
                  toda linha (vazia quando normal): assim o número começa
                  sempre na mesma coluna e a urgência fica alinhada, logo
                  depois da sequência (pedido do Arion, 12/09/2026) */}
              <span className="mr-1.5 inline-block w-14 align-middle">
                {o.prioridade === 'Urgente' && (
                  <span className="rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-red-700 dark:bg-red-950 dark:text-red-300">
                    urgente
                  </span>
                )}
              </span>
              {/* expedição prevista (12/09/2026): segunda vaga fixa, depois
                  da urgência e antes do número — vermelha quando a máquina
                  está programada para depois do caminhão */}
              <span className="mr-1.5 inline-block w-16 align-middle text-xs font-normal">
                {o.data_expedicao && (
                  <span
                    className={
                      o.data_prog && o.data_prog > o.data_expedicao
                        ? 'font-semibold text-red-600 dark:text-red-400'
                        : 'text-stone-500 dark:text-stone-400'
                    }
                    title={
                      o.data_prog && o.data_prog > o.data_expedicao
                        ? 'Programada para DEPOIS da data do caminhão'
                        : 'Expedição prevista'
                    }
                  >
                    exp. {diaCurto(o.data_expedicao)}
                  </span>
                )}
              </span>
              {o.numero}
            </td>
            <td className="hidden px-3 py-2 lg:table-cell">{o.cultivar}</td>
            <td className="px-2 py-2 lg:px-3">{o.receitas.nome}</td>
            <td className="px-2 py-2 font-medium lg:px-3">{o.lote_id}</td>
            <td className="px-2 py-2 lg:px-3">{o.embalagem}</td>
            <td className="num-tabular px-2 py-2 text-right lg:px-3">{o.bags}</td>
            <td className="num-tabular px-2 py-2 text-right whitespace-nowrap lg:px-3">
              {num(pesoOrdemKg(o) / 1000, 1)} t
            </td>
            <td className="px-2 py-2 lg:px-3">
              <span
                className={`inline-block min-w-36 rounded px-2 py-0.5 text-center text-xs font-medium whitespace-nowrap ${CORES_STATUS[status]}`}
              >
                {status}
              </span>
            </td>
            <td className="px-2 py-2 text-right whitespace-nowrap lg:px-3">
              <div className="inline-flex gap-2">
                {/* min-w igual nos dois: sem isso "Iniciar" ficava mais largo
                    que "Abrir" e o botão pulava de tamanho conforme a linha
                    (pedido do Arion, 25/08/2026) */}
                {podeApontar && status === 'Pronto para produzir' && (
                  <button
                    onClick={() => onIniciar(o)}
                    className="min-w-20 rounded-md bg-green-700 px-4 py-2.5 text-center text-sm font-semibold text-white transition-colors hover:bg-green-800 sm:py-2 dark:bg-green-600 dark:hover:bg-green-500"
                  >
                    Iniciar
                  </button>
                )}
                {(o.ordem_tanques.length > 0 || status !== 'Pronto para produzir') && (
                  <button
                    onClick={() => onAbrir(o.id)}
                    className="min-w-20 rounded-md border border-stone-300 px-4 py-2.5 text-center text-sm transition-colors hover:bg-stone-100 sm:py-2 dark:border-stone-700 dark:hover:bg-stone-800"
                  >
                    Abrir
                  </button>
                )}
              </div>
            </td>
          </tr>
        )
      })}
    </>
  )
}

/**
 * O painel que fica aberto no tablet do chão de fábrica o turno inteiro.
 * O decorrido é o número-herói (legível a distância de braço), a barra
 * compara com o planejado e a parada atual grita em vermelho.
 */
function CardMaquina({
  maquina,
  ordens,
  motivos,
  motivosLista,
  agora,
  onAbrir,
  podeApontar,
  paradaMaquina,
  motivoSemente,
  onAbrirParada,
  onEncerrarParada,
}: {
  maquina: LinhaMaquina
  ordens: LinhaOrdem[]
  motivos: ReturnType<typeof mapaMotivos>
  motivosLista: api.LinhaMotivo[]
  agora: number
  onAbrir: (id: string) => void
  podeApontar: boolean
  /** Parada de máquina em curso — só existe com a máquina livre. */
  paradaMaquina: api.LinhaParadaMaquina | null
  motivoSemente: api.LinhaMotivo | null
  onAbrirParada: (maquinaId: string, motivoId: string) => void
  onEncerrarParada: (maquinaId: string) => void
}) {
  const [escolhendoMotivo, setEscolhendoMotivo] = useState(false)
  const atual = ordens.find((o) => o.status === 'Em producao' || o.status === 'Parada')
  const parada = atual?.ordem_paradas.find((p) => !p.fim)
  const motivoAtual = parada ? motivosLista.find((m) => m.id === parada.motivo_id) : null
  const emParada = atual?.status === 'Parada'

  const tempos = atual ? temposOrdem(paraOrdemDominio(atual), motivos, agora) : null
  const planejado = atual
    ? tempoPlanejadoS(pesoOrdemKg(atual) / 1000, maquina.capacidade_th)
    : null
  const progresso =
    tempos && planejado ? Math.min(100, (tempos.brutoS / planejado) * 100) : null
  const estourou = tempos != null && planejado != null && tempos.brutoS > planejado

  // máquina livre: NÃO aponta a próxima — a sequência é sugestão do PCP, e é
  // o operador quem decide qual ordem vai entrar (pedido da operação, 06/08)
  const prontas = !atual
    ? ordens.filter((o) => statusEfetivo(paraOrdemDominio(o)) === 'Pronto para produzir').length
    : 0

  // parada de máquina só existe com a máquina livre; se uma ordem começou, o
  // banco já a encerrou no confirmar_inicio
  const paradaMaq = !atual ? paradaMaquina : null
  const motivoMaq = paradaMaq
    ? (motivosLista.find((m) => m.id === paradaMaq.motivo_id)?.descricao ?? 'Parada')
    : null
  const paradaMaqS = paradaMaq
    ? duracaoParadaMaquinaS(
        { motivoId: '', inicio: new Date(paradaMaq.inicio).getTime(), fim: null },
        agora,
      )
    : 0
  // aberta num dia de produção anterior: a contagem já foi cortada às 03:00,
  // então o número na tela para de subir e ninguém entende — melhor avisar
  const paradaMaqDeOntem =
    paradaMaq != null &&
    diaDeProducao(new Date(paradaMaq.inicio)) !== diaDeProducao(new Date(agora))

  return (
    <div
      className={`overflow-hidden rounded-xl border shadow-sm ${
        !atual
          ? paradaMaq
            ? 'border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30'
            : 'border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900'
          : emParada
            ? 'border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/30'
            : 'border-green-300 bg-green-50/60 dark:border-green-900 dark:bg-green-950/30'
      }`}
    >
      {/* O nome da máquina é o que identifica o cartão a distância, no tablet
          preso na coluna: precisa ser lido antes de qualquer outra coisa —
          por isso ocupa a linha inteira, em corpo grande, com o estado logo
          abaixo. Antes disputava espaço com a etiqueta de status em text-lg
          e sumia no meio do cartão. */}
      <div className="flex items-start justify-between gap-3 px-4 pt-3">
        <div className="min-w-0">
          <h3 className="text-3xl font-bold leading-none tracking-tight text-stone-900 dark:text-stone-100">
            {maquina.nome}
          </h3>
          <div className="mt-1.5">
            {atual ? (
              <span
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                  emParada
                    ? 'bg-red-600 text-white'
                    : 'bg-green-600 text-white'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full bg-white ${emParada ? 'animate-pulse' : ''}`}
                />
                {emParada ? 'PARADA' : 'EM PRODUÇÃO'}
              </span>
            ) : paradaMaq ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500 px-2.5 py-0.5 text-xs font-semibold text-white">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white" />
                PARADA · SEM ORDEM
              </span>
            ) : (
              <span className="rounded-full bg-stone-100 px-2.5 py-0.5 text-xs font-medium text-stone-500 dark:bg-stone-800 dark:text-stone-400">
                LIVRE
              </span>
            )}
          </div>
        </div>
        <span className="shrink-0 pt-1 text-right text-xs text-stone-500 dark:text-stone-400">
          {maquina.capacidade_th} t/h · {maquina.qtd_tanques} tanques
        </span>
      </div>

      {!atual ? (
        <div className="px-4 pt-4 pb-5">
          {paradaMaq ? (
            <>
              <p className="text-sm text-amber-900 dark:text-amber-200">
                <b>{motivoMaq}</b> desde{' '}
                {new Date(paradaMaq.inicio).toLocaleTimeString('pt-BR', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </p>
              <p className="num-tabular mt-1 text-4xl font-bold tabular-nums text-amber-900 dark:text-amber-200">
                {formataHms(paradaMaqS)}
              </p>
              {paradaMaqDeOntem && (
                <p className="mt-1 text-xs text-amber-800 dark:text-amber-300">
                  Aberta num dia de produção anterior — a contagem parou às 03:00. Encerre.
                </p>
              )}
              {podeApontar && (
                <button
                  onClick={() => onEncerrarParada(maquina.id)}
                  className="mt-3 rounded-md border border-amber-400 px-4 py-2.5 text-sm font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:text-amber-200 dark:hover:bg-amber-900/40"
                >
                  Encerrar parada
                </button>
              )}
            </>
          ) : (
            <>
              <p className="py-2 text-sm text-stone-500 dark:text-stone-400">
                {prontas > 0
                  ? `${prontas} ${prontas === 1 ? 'ordem pronta' : 'ordens prontas'} para produzir — escolha na lista abaixo e toque em Iniciar.`
                  : 'Nenhuma ordem em andamento nem pronta na fila.'}
              </p>
              {/* Máquina livre e nada pronto para entrar: essa hora é perda e
                  não tinha onde ser registrada, porque toda parada pertencia a
                  uma ordem. Com ordem pronta na fila o botão não aparece — aí
                  a semente está no galpão e o caminho é Iniciar. */}
              {prontas === 0 && podeApontar && (
                <div className="mt-1 flex flex-wrap items-center gap-3">
                  {motivoSemente && (
                    <button
                      onClick={() => onAbrirParada(maquina.id, motivoSemente.id)}
                      className="rounded-md bg-amber-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-amber-600"
                    >
                      Aguardando semente
                    </button>
                  )}
                  <button
                    onClick={() => setEscolhendoMotivo(true)}
                    className="text-sm text-stone-500 underline underline-offset-2 dark:text-stone-400"
                  >
                    outro motivo
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <>
          <div className="px-4 pt-1">
            <button
              onClick={() => onAbrir(atual.id)}
              className="text-left text-sm font-semibold text-stone-900 underline-offset-4 transition-colors hover:underline dark:text-stone-100"
            >
              {atual.numero} · {atual.cultivar} · {atual.receitas.nome}
            </button>
            <p className="text-xs text-stone-500 dark:text-stone-400">
              Lote {atual.lote_id} · {atual.bags} × {atual.embalagem} ·{' '}
              {num(pesoOrdemKg(atual) / 1000, 1)} t
            </p>
          </div>

          {/* o número que se lê do outro lado da máquina */}
          <div className="mt-2 px-4 text-center">
            <p className="text-[10px] font-medium uppercase tracking-widest text-stone-500">
              Decorrido
            </p>
            <p
              className={`num-tabular text-4xl font-bold tracking-tight ${
                emParada
                  ? 'text-red-700 dark:text-red-400'
                  : 'text-stone-900 dark:text-stone-100'
              }`}
            >
              {tempos ? formataHms(tempos.brutoS) : '—'}
            </p>
            {progresso != null && (
              <div className="mx-auto mt-2 h-1.5 max-w-64 overflow-hidden rounded-full bg-stone-200 dark:bg-stone-800">
                <div
                  className={`h-full rounded-full transition-[width] duration-1000 ${
                    estourou ? 'bg-red-500' : 'bg-green-600'
                  }`}
                  style={{ width: `${progresso}%` }}
                />
              </div>
            )}
          </div>

          <dl className="mt-3 grid grid-cols-2 gap-px border-t border-stone-200/70 bg-stone-200/70 dark:border-stone-800 dark:bg-stone-800">
            <div className="bg-white/70 px-4 py-2 text-center dark:bg-stone-900/60">
              <dt className="text-[10px] uppercase tracking-wide text-stone-500">Planejado</dt>
              <dd className={`num-tabular text-sm font-semibold ${estourou ? 'text-red-700 dark:text-red-400' : ''}`}>
                {planejado == null ? '—' : formataHms(planejado)}
              </dd>
            </div>
            <div className="bg-white/70 px-4 py-2 text-center dark:bg-stone-900/60">
              <dt className="text-[10px] uppercase tracking-wide text-stone-500">Paradas</dt>
              <dd className="num-tabular text-sm font-semibold">
                {tempos ? formataHms(tempos.paradasS) : '—'}
              </dd>
            </div>
          </dl>

          {parada && (
            <div className="flex items-center gap-2 bg-red-600 px-4 py-2.5 text-sm text-white">
              <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-white" />
              <span className="min-w-0 truncate">
                <b>{motivoAtual?.descricao ?? 'Parada'}</b>{' '}
                ({motivoAtual?.tipo === 'Planejada' ? 'planejada' : 'não planejada'})
              </span>
              <span className="num-tabular ml-auto shrink-0 font-semibold">
                {formataHms((agora - new Date(parada.inicio).getTime()) / 1000)}
              </span>
            </div>
          )}
        </>
      )}

      {escolhendoMotivo && (
        <ModalMotivoParada
          titulo={`Máquina ${maquina.nome} parada — motivo`}
          descricao="A máquina está livre e nenhuma ordem está pronta para entrar. O tempo daqui até o próximo início fica registrado neste motivo."
          motivos={motivosLista}
          onEscolher={(m) => {
            setEscolhendoMotivo(false)
            onAbrirParada(maquina.id, m.id)
          }}
          onCancelar={() => setEscolhendoMotivo(false)}
        />
      )}
    </div>
  )
}
