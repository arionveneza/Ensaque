import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '@/dados/api'
import type { LinhaMaquina, LinhaOrdem } from '@/dados/api'
import {
  mapaMotivos,
  paraOrdemDominio,
  pesoOrdemKg,
  tanquesDaReceita,
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

  const porMaquina = useCallback(
    (m: string) =>
      ordens
        .filter((o) => o.maquina_id === m)
        .sort(
          (a, b) =>
            (a.prioridade === 'Urgente' ? 0 : 1) - (b.prioridade === 'Urgente' ? 0 : 1) ||
            (a.seq ?? 999) - (b.seq ?? 999),
        ),
    [ordens],
  )

  async function iniciar(o: LinhaOrdem) {
    try {
      setErro(null)
      // "Iniciar" apenas PREPARA: monta os tanques e abre a ordem.
      // O cronômetro só dispara no Confirmar início.
      await api.prepararTanques(o.id, tanquesDaReceita(o))
      await recarregar()
      setAberta(o.id)
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
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
                <th className="px-3 py-2">Seq</th>
                <th className="px-3 py-2">Ordem</th>
                <th className="px-3 py-2">Cultivar</th>
                <th className="px-3 py-2">Tratamento</th>
                <th className="px-3 py-2">Lote</th>
                <th className="px-3 py-2 text-right">Bags</th>
                <th className="px-3 py-2 text-right">Peso</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2"></th>
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
}: {
  nome: string
  lista: LinhaOrdem[]
  podeApontar: boolean
  onIniciar: (o: LinhaOrdem) => void
  onAbrir: (id: string) => void
}) {
  const totalT = lista.reduce((a, o) => a + pesoOrdemKg(o) / 1000, 0)
  return (
    <>
      <tr className="bg-stone-100/70 dark:bg-stone-800/40">
        <td colSpan={6} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide">
          {nome}
        </td>
        <td className="num-tabular px-3 py-1.5 text-right text-xs font-semibold">
          {num(totalT, 1)} t
        </td>
        <td colSpan={2}></td>
      </tr>
      {lista.map((o) => {
        const status = statusEfetivo(paraOrdemDominio(o), o.lotes_semente.status)
        return (
          <tr
            key={o.id}
            className="border-t border-stone-100 hover:bg-stone-50 dark:border-stone-800/60 dark:hover:bg-stone-800/30"
          >
            <td className="px-3 py-2 text-stone-400">{o.seq ?? '—'}</td>
            <td className="px-3 py-2 font-medium">
              {o.numero}
              {o.prioridade === 'Urgente' && (
                <span className="ml-1.5 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-red-700 dark:bg-red-950 dark:text-red-300">
                  urgente
                </span>
              )}
            </td>
            <td className="px-3 py-2">{o.cultivar}</td>
            <td className="px-3 py-2">{o.receitas.nome}</td>
            <td className="px-3 py-2 font-medium">{o.lote_id}</td>
            <td className="num-tabular px-3 py-2 text-right">{o.bags}</td>
            <td className="num-tabular px-3 py-2 text-right">
              {num(pesoOrdemKg(o) / 1000, 1)} t
            </td>
            <td className="px-3 py-2">
              <span className={`rounded px-2 py-0.5 text-xs font-medium ${CORES_STATUS[status]}`}>
                {status}
              </span>
            </td>
            <td className="px-3 py-2 text-right whitespace-nowrap">
              {podeApontar && status === 'Pronto para produzir' && (
                <button
                  onClick={() => onIniciar(o)}
                  className="rounded-md bg-stone-900 px-3 py-1 text-xs font-medium text-white dark:bg-stone-100 dark:text-stone-900"
                >
                  Iniciar
                </button>
              )}
              {(o.ordem_tanques.length > 0 || status !== 'Pronto para produzir') && (
                <button
                  onClick={() => onAbrir(o.id)}
                  className="ml-1.5 rounded-md border border-stone-300 px-3 py-1 text-xs dark:border-stone-700"
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

  const tempos = atual ? temposOrdem(paraOrdemDominio(atual), motivos, agora) : null
  const planejado = atual
    ? tempoPlanejadoS(pesoOrdemKg(atual) / 1000, maquina.capacidade_th)
    : null

  return (
    <div
      className={`rounded-lg border p-4 ${
        !atual
          ? 'border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900'
          : atual.status === 'Parada'
            ? 'border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/30'
            : 'border-emerald-300 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30'
      }`}
    >
      <div className="flex items-baseline justify-between">
        <h3 className="font-semibold text-stone-900 dark:text-stone-100">{maquina.nome}</h3>
        <span className="text-xs text-stone-500 dark:text-stone-400">
          {maquina.capacidade_th} t/h · {maquina.qtd_tanques} tanques
        </span>
      </div>

      {!atual ? (
        <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">
          Livre — nenhuma ordem em andamento.
        </p>
      ) : (
        <>
          <button
            onClick={() => onAbrir(atual.id)}
            className="mt-2 text-left text-sm font-medium text-stone-900 underline-offset-2 hover:underline dark:text-stone-100"
          >
            Ordem {atual.numero} · {atual.cultivar} · {atual.receitas.nome}
          </button>
          <p className="text-xs text-stone-500 dark:text-stone-400">
            Lote {atual.lote_id} · {atual.bags} bags · {num(pesoOrdemKg(atual) / 1000, 1)} t
          </p>

          <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
            <div>
              <dt className="text-[10px] uppercase tracking-wide text-stone-500">Planejado</dt>
              <dd className="num-tabular text-sm font-medium">
                {planejado == null ? '—' : formataHms(planejado)}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wide text-stone-500">Decorrido</dt>
              <dd className="num-tabular text-sm font-medium">
                {tempos ? formataHms(tempos.brutoS) : '—'}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wide text-stone-500">Paradas</dt>
              <dd className="num-tabular text-sm font-medium">
                {tempos ? formataHms(tempos.paradasS) : '—'}
              </dd>
            </div>
          </dl>

          {parada && (
            <p className="mt-3 rounded-md bg-red-100 px-3 py-2 text-xs text-red-800 dark:bg-red-950/60 dark:text-red-300">
              <b>Parada agora:</b> {motivoAtual?.descricao ?? '—'} (
              {motivoAtual?.tipo === 'Planejada' ? 'planejada' : 'não planejada'}) há{' '}
              {formataHms((agora - new Date(parada.inicio).getTime()) / 1000)}
            </p>
          )}
        </>
      )}
    </div>
  )
}
