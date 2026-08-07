import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '@/dados/api'
import type { LinhaMaquina, LinhaOrdem } from '@/dados/api'
import {
  mapaMotivos,
  paraOrdemDominio,
  pesoOrdemKg,
} from '@/dados/adaptadores'
import { diaDeProducao, formataHms, tempoPlanejadoS, temposOrdem } from '@/dominio/calculos'
import { statusEfetivo } from '@/dominio/status'
import type { StatusEfetivo } from '@/dominio/tipos'
import { useRealtime } from '@/dados/useRealtime'
import { useAuth } from '@/auth/AuthProvider'
import ModalOrdem from './ModalOrdem'

const num = (v: number, casas = 1) =>
  v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas })

const CORES_STATUS: Record<StatusEfetivo, string> = {
  'Nao programada': 'bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300',
  Programada: 'bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300',
  'Aguardando lote': 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  'Pronto para produzir': 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
  'Em producao': 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300',
  Parada: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
  Finalizada: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
  'Qualidade apontada': 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
  Apontada: 'bg-stone-800 text-stone-100 dark:bg-stone-200 dark:text-stone-900',
}

export default function Execucao() {
  const { usuario, permitido } = useAuth()
  const [dia, setDia] = useState(() => diaDeProducao(new Date()))
  const [cadastros, setCadastros] = useState<Awaited<ReturnType<typeof api.carregarCadastros>> | null>(null)
  const [ordens, setOrdens] = useState<LinhaOrdem[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [aberta, setAberta] = useState<string | null>(null)
  const [agora, setAgora] = useState(() => Date.now())

  const podeApontar = permitido('execucao', 'apontar')

  const recarregar = useCallback(async () => {
    try {
      setErro(null)
      const linhas = await api.carregarOrdens(dia)
      setOrdens(linhas)
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }, [dia])

  useEffect(() => {
    let vivo = true
    setCarregando(true)
    Promise.all([api.carregarCadastros(), api.carregarOrdens(dia)])
      .then(([c, o]) => {
        if (!vivo) return
        setCadastros(c)
        setOrdens(o)
      })
      .catch((e) => vivo && setErro(e instanceof Error ? e.message : String(e)))
      .finally(() => vivo && setCarregando(false))
    return () => {
      vivo = false
    }
  }, [dia])

  // o PCP e a produção olham a mesma ordem ao mesmo tempo: sem isto, uma tela mente
  useRealtime(['ordens', 'ordem_eventos', 'ordem_paradas', 'ordem_tanques'], recarregar)

  // relógio dos cronômetros: só corre quando há ordem em andamento
  const temAndamento = ordens.some((o) => o.status === 'Em producao' || o.status === 'Parada')
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
    <div className="mx-auto max-w-6xl px-6 py-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-stone-900 dark:text-stone-100">Execução</h2>
          <p className="text-sm text-stone-500 dark:text-stone-400">
            Dia de produção das 07:30 às 03:00 — o turno 2 pertence ao dia que começou.
          </p>
        </div>
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
                <th className="px-2 py-2 lg:px-3 text-right">Bags</th>
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
            ? 'bg-emerald-700 text-white dark:bg-emerald-800'
            : 'bg-stone-600 text-white dark:bg-stone-700'
        }
      >
        {/* colSpan 5 + célula fantasma: acompanha a coluna Cultivar, que some em tela estreita */}
        <td colSpan={5} className="px-2 py-2.5 lg:px-3">
          <span className="text-lg font-bold tracking-tight">{nome}</span>
        </td>
        <td className="hidden lg:table-cell" />
        <td className="num-tabular px-2 py-2.5 text-right text-sm font-bold lg:px-3">
          {num(totalT, 1)} t
        </td>
        <td colSpan={2}></td>
      </tr>
      {lista.map((o, idx) => {
        const status = statusEfetivo(paraOrdemDominio(o), o.lotes_semente.status)
        return (
          <tr
            key={o.id}
            className="border-t border-stone-100 hover:bg-stone-50 dark:border-stone-800/60 dark:hover:bg-stone-800/30"
          >
            {/* posição na fila, não o seq gravado: o seq herdou duplicata e
                buraco de reprogramações antigas (3,3,4,7...), e o que o
                operador precisa é a ordem de execução — igual à Programação */}
            <td className="px-2 py-2 text-stone-400 lg:px-3">{numerada ? idx + 1 : '—'}</td>
            <td className="px-2 py-2 font-medium lg:px-3">
              {o.numero}
              {o.prioridade === 'Urgente' && (
                <span className="ml-1.5 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-red-700 dark:bg-red-950 dark:text-red-300">
                  urgente
                </span>
              )}
            </td>
            <td className="hidden px-3 py-2 lg:table-cell">{o.cultivar}</td>
            <td className="px-2 py-2 lg:px-3">{o.receitas.nome}</td>
            <td className="px-2 py-2 font-medium lg:px-3">{o.lote_id}</td>
            <td className="num-tabular px-2 py-2 text-right lg:px-3">{o.bags}</td>
            <td className="num-tabular px-2 py-2 text-right whitespace-nowrap lg:px-3">
              {num(pesoOrdemKg(o) / 1000, 1)} t
            </td>
            <td className="px-2 py-2 lg:px-3">
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap ${CORES_STATUS[status]}`}
              >
                {status}
              </span>
            </td>
            <td className="px-2 py-2 text-right whitespace-nowrap lg:px-3">
              {podeApontar && status === 'Pronto para produzir' && (
                <button
                  onClick={() => onIniciar(o)}
                  className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-emerald-800 dark:bg-emerald-600 dark:hover:bg-emerald-500"
                >
                  Iniciar
                </button>
              )}
              {(o.ordem_tanques.length > 0 || status !== 'Pronto para produzir') && (
                <button
                  onClick={() => onAbrir(o.id)}
                  className="ml-1.5 rounded-md border border-stone-300 px-4 py-2 text-sm transition-colors hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800"
                >
                  Abrir
                </button>
              )}
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
}: {
  maquina: LinhaMaquina
  ordens: LinhaOrdem[]
  motivos: ReturnType<typeof mapaMotivos>
  motivosLista: api.LinhaMotivo[]
  agora: number
  onAbrir: (id: string) => void
}) {
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
    ? ordens.filter(
        (o) =>
          statusEfetivo(paraOrdemDominio(o), o.lotes_semente.status) === 'Pronto para produzir',
      ).length
    : 0

  return (
    <div
      className={`overflow-hidden rounded-xl border shadow-sm ${
        !atual
          ? 'border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900'
          : emParada
            ? 'border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/30'
            : 'border-emerald-300 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/30'
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
                    : 'bg-emerald-600 text-white'
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 rounded-full bg-white ${emParada ? 'animate-pulse' : ''}`}
                />
                {emParada ? 'PARADA' : 'EM PRODUÇÃO'}
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
          <p className="py-2 text-sm text-stone-500 dark:text-stone-400">
            {prontas > 0
              ? `${prontas} ${prontas === 1 ? 'ordem pronta' : 'ordens prontas'} para produzir — escolha na lista abaixo e toque em Iniciar.`
              : 'Nenhuma ordem em andamento nem pronta na fila.'}
          </p>
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
              Lote {atual.lote_id} · {atual.bags} bags · {num(pesoOrdemKg(atual) / 1000, 1)} t
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
                    estourou ? 'bg-red-500' : 'bg-emerald-600'
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
    </div>
  )
}
