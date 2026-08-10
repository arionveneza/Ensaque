import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '@/dados/api'
import type { LinhaMaquina, LinhaOrdem } from '@/dados/api'
import * as g from '@/dados/api-gestao'
import { mapaMotivos, paraOrdemDominio, pesoOrdemKg } from '@/dados/adaptadores'
import {
  calculaOee, checkFinalAprovado, diaDeProducao, formataHms,
  tempoPlanejadoS, temposOrdem,
} from '@/dominio/calculos'
import { statusEfetivo } from '@/dominio/status'
import { useRealtime } from '@/dados/useRealtime'

/**
 * Painel de produção — modo TV. Fica aberto o turno inteiro numa tela grande
 * no chão de fábrica, então: escuro fixo (não pisca com o tema), números
 * enormes legíveis de longe, zero interação além de sair. Atualiza sozinho
 * pelo realtime (uma máquina que para em qualquer computador aparece aqui) e
 * por um relógio de 1s para o cronômetro correr.
 */
export default function Painel({ onSair }: { onSair: () => void }) {
  const [dia, setDia] = useState(() => diaDeProducao(new Date()))
  const [cadastros, setCadastros] =
    useState<Awaited<ReturnType<typeof api.carregarCadastros>> | null>(null)
  const [ordens, setOrdens] = useState<LinhaOrdem[]>([])
  const [checks, setChecks] = useState<g.ChecklistQualidade[]>([])
  const [agora, setAgora] = useState(() => Date.now())
  const [erro, setErro] = useState<string | null>(null)

  const recarregar = useCallback(async () => {
    try {
      setErro(null)
      const [o, c] = await Promise.all([api.carregarOrdens(dia), g.listarChecksQualidade()])
      setOrdens(o)
      setChecks(c)
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }, [dia])

  // cadastros (nomes de máquina, motivos): sem isto não há cards. O erro NÃO
  // pode ser engolido — o painel de TV ficava preso em "Carregando…" para
  // sempre num tropeço de rede. Aqui ele mostra o erro e continua tentando.
  const carregarCad = useCallback(async () => {
    try {
      setCadastros(await api.carregarCadastros())
      setErro(null)
    } catch (e) {
      setErro(`cadastros: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [])

  useEffect(() => {
    void carregarCad()
    void recarregar()
  }, [carregarCad, recarregar])

  useRealtime(['ordens', 'ordem_eventos', 'ordem_paradas', 'ordem_tanques', 'qualidade_checks'], recarregar)

  // relógio: o cronômetro corre; à meia-noite o dia de produção vira sozinho
  useEffect(() => {
    const t = setInterval(() => {
      setAgora(Date.now())
      setDia((d) => {
        const atual = diaDeProducao(new Date())
        return atual === d ? d : atual
      })
    }, 1000)
    return () => clearInterval(t)
  }, [])

  // rede de segurança: numa TV sempre ligada, se o websocket do realtime cair
  // os dados congelariam enquanto o cronômetro sobe. A cada 30s recarrega, e
  // insiste nos cadastros enquanto eles não vieram.
  useEffect(() => {
    const t = setInterval(() => {
      void recarregar()
      if (!cadastros) void carregarCad()
    }, 30_000)
    return () => clearInterval(t)
  }, [recarregar, carregarCad, cadastros])

  // aba dormindo congela o timer e o realtime; ao voltar, resincroniza tudo
  useEffect(() => {
    const resync = () => {
      if (document.visibilityState === 'visible') {
        setAgora(Date.now())
        setDia(diaDeProducao(new Date()))
        void recarregar()
        if (!cadastros) void carregarCad()
      }
    }
    document.addEventListener('visibilitychange', resync)
    return () => document.removeEventListener('visibilitychange', resync)
  }, [recarregar, carregarCad, cadastros])

  const motivos = useMemo(() => mapaMotivos(cadastros?.motivos ?? []), [cadastros])

  /** Resumo do dia: ordens finalizadas, bags produzidos, toneladas e OEE. */
  const doDia = useMemo(() => {
    const aprovado = new Map<string, boolean>()
    for (const c of checks) {
      if (c.etapa === 'final' && !aprovado.has(c.ordem_id)) {
        aprovado.set(c.ordem_id, checkFinalAprovado(c))
      }
    }
    const FINALIZADAS = ['Finalizada', 'Qualidade apontada', 'Apontada']
    let ordensFin = 0
    let bags = 0
    let pesoT = 0
    let bruto = 0
    let liquido = 0
    let planejadas = 0
    let planejado = 0
    let avaliadas = 0
    let aprovadas = 0
    const capDe = (id: string | null) =>
      cadastros?.maquinas.find((m) => m.id === id)?.capacidade_th ?? 12
    for (const o of ordens) {
      const st = statusEfetivo(paraOrdemDominio(o))
      if (!FINALIZADAS.includes(st)) continue
      ordensFin++
      // tonelagem pelos bags PRODUZIDOS, para casar com o card ao lado (e não
      // pelos planejados, que pesoOrdemKg usa). Ideal p/ o OEE também segue o
      // que foi produzido, não o que foi planejado.
      const bagsReais = o.bags_produzidos ?? o.bags
      bags += bagsReais
      const t = (bagsReais * o.lotes_semente.peso_bag_kg) / 1000
      pesoT += t
      /**
       * O OEE inteiro sai da MESMA população: só ordens com qualidade final
       * apontada — a regra que o Indicadores documenta ("três denominadores
       * diferentes num número só, que mente"). Antes o Painel somava
       * disponibilidade/performance de todas as finalizadas e qualidade só
       * das inspecionadas, e a TV mostrava um OEE diferente do Indicadores
       * para o mesmo dia. Os contadores de produção (ordens/bags/toneladas)
       * continuam sobre todas — produzir é fato, OEE é medição.
       */
      if (aprovado.has(o.id)) {
        avaliadas++
        if (aprovado.get(o.id)) aprovadas++
        const tempos = temposOrdem(paraOrdemDominio(o), motivos, agora)
        if (tempos) {
          bruto += tempos.brutoS
          liquido += tempos.liquidoS
          planejadas += tempos.paradasPlanejadasS
          planejado += tempoPlanejadoS(t, capDe(o.maquina_id))
        }
      }
    }
    const oee = calculaOee({
      brutoS: bruto,
      liquidoS: liquido,
      paradasPlanejadasS: planejadas,
      planejadoS: planejado,
      qualidade: avaliadas > 0 ? aprovadas / avaliadas : null,
    })
    return { ordensFin, bags, pesoT, oee: oee?.oee ?? null }
  }, [ordens, checks, cadastros, motivos, agora])

  const relogio = new Date(agora).toLocaleTimeString('pt-BR')

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-stone-950 text-stone-100">
      {/* cabeçalho */}
      <header className="flex items-center gap-3 border-b border-stone-800 px-4 py-3 sm:gap-4 sm:px-6">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-sm font-bold">
          TSI
        </span>
        {/* min-w-0 + truncate: o título encolhe/corta antes de empurrar o resto */}
        <div className="min-w-0">
          <h1 className="truncate text-lg font-bold leading-tight">Painel de Produção</h1>
          <p className="truncate text-xs text-stone-400">Sementes Veneza · dia {diaLegivel(dia)}</p>
        </div>
        <span className="num-tabular ml-auto shrink-0 text-2xl font-bold tracking-tight sm:text-3xl">
          {relogio}
        </span>
        <button
          onClick={onSair}
          className="shrink-0 rounded-md border border-stone-700 px-3 py-1.5 text-sm text-stone-300 hover:bg-stone-800"
        >
          Sair
        </button>
      </header>

      {erro && (
        <div className="bg-red-900/40 px-6 py-2 text-sm text-red-300">{erro}</div>
      )}

      {/* máquinas */}
      <main className="grid flex-1 grid-cols-1 gap-4 p-4 sm:grid-cols-2">
        {(cadastros?.maquinas ?? []).map((m) => (
          <PainelMaquina
            key={m.id}
            maquina={m}
            ordens={ordens.filter((o) => o.maquina_id === m.id)}
            motivos={motivos}
            motivosLista={cadastros?.motivos ?? []}
            agora={agora}
          />
        ))}
        {(cadastros?.maquinas.length ?? 0) === 0 && (
          <p className="col-span-full self-center text-center text-stone-500">
            Carregando máquinas…
          </p>
        )}
      </main>

      {/* rodapé: resumo do dia */}
      <footer className="grid grid-cols-2 gap-px border-t border-stone-800 bg-stone-800 sm:grid-cols-4">
        <Kpi rotulo="Ordens finalizadas" valor={String(doDia.ordensFin)} />
        <Kpi rotulo="Bags produzidos" valor={doDia.bags.toLocaleString('pt-BR')} />
        <Kpi rotulo="Produzido" valor={`${doDia.pesoT.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} t`} />
        <Kpi
          rotulo="OEE do dia"
          valor={doDia.oee == null ? '—' : `${Math.round(doDia.oee * 100)}%`}
          cor={corOee(doDia.oee)}
        />
      </footer>
    </div>
  )
}

function PainelMaquina({
  maquina, ordens, motivos, motivosLista, agora,
}: {
  maquina: LinhaMaquina
  ordens: LinhaOrdem[]
  motivos: ReturnType<typeof mapaMotivos>
  motivosLista: api.LinhaMotivo[]
  agora: number
}) {
  const atual = ordens.find((o) => o.status === 'Em producao' || o.status === 'Parada')
  const emParada = atual?.status === 'Parada'
  const parada = atual?.ordem_paradas.find((p) => !p.fim)
  const motivoAtual = parada ? motivosLista.find((mm) => mm.id === parada.motivo_id) : null

  const tempos = atual ? temposOrdem(paraOrdemDominio(atual), motivos, agora) : null
  const planejado = atual ? tempoPlanejadoS(pesoOrdemKg(atual) / 1000, maquina.capacidade_th) : null
  const progresso = tempos && planejado ? Math.min(100, (tempos.brutoS / planejado) * 100) : null
  const estourou = tempos != null && planejado != null && tempos.brutoS > planejado

  const borda = !atual
    ? 'border-stone-800'
    : emParada
      ? 'border-red-600'
      : 'border-emerald-600'

  return (
    <div className={`flex flex-col rounded-2xl border-2 ${borda} bg-stone-900 p-5`}>
      <div className="flex items-center justify-between">
        <h2 className="text-3xl font-bold tracking-tight">{maquina.nome}</h2>
        {atual ? (
          <span
            className={`flex items-center gap-2 rounded-full px-3 py-1 text-sm font-bold ${
              emParada ? 'bg-red-600' : 'bg-emerald-600'
            }`}
          >
            <span className={`h-2 w-2 rounded-full bg-white ${emParada ? 'animate-pulse' : ''}`} />
            {emParada ? 'PARADA' : 'EM PRODUÇÃO'}
          </span>
        ) : (
          <span className="rounded-full bg-stone-800 px-3 py-1 text-sm font-medium text-stone-400">
            LIVRE
          </span>
        )}
      </div>

      {!atual ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-xl text-stone-600">Máquina livre</p>
        </div>
      ) : (
        <>
          <p className="mt-1 text-lg text-stone-300">
            <span className="font-semibold text-stone-100">{atual.numero}</span> ·{' '}
            {atual.cultivar} · {atual.receitas.nome}
          </p>
          <p className="text-sm text-stone-500">
            Lote {atual.lote_id} · {atual.bags} bags ·{' '}
            {(pesoOrdemKg(atual) / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} t
          </p>

          {/* cronômetro herói */}
          <div className="flex flex-1 flex-col items-center justify-center py-4">
            <p className="text-xs font-medium uppercase tracking-[0.3em] text-stone-500">
              Decorrido
            </p>
            <p
              className={`num-tabular text-7xl font-bold tracking-tight ${
                emParada ? 'text-red-400' : 'text-stone-50'
              }`}
            >
              {tempos ? formataHms(tempos.brutoS) : '—'}
            </p>
            <p className="mt-1 num-tabular text-sm text-stone-500">
              planejado {planejado == null ? '—' : formataHms(planejado)}
            </p>
            {progresso != null && (
              <div className="mt-3 h-2.5 w-full max-w-md overflow-hidden rounded-full bg-stone-800">
                <div
                  className={`h-full rounded-full transition-[width] duration-1000 ${
                    estourou ? 'bg-red-500' : 'bg-emerald-500'
                  }`}
                  style={{ width: `${progresso}%` }}
                />
              </div>
            )}
          </div>

          {parada && (
            <div className="flex items-center gap-3 rounded-xl bg-red-600 px-4 py-3 text-lg">
              <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-white" />
              <span className="min-w-0 truncate font-semibold">
                {motivoAtual?.descricao ?? 'Parada'}
              </span>
              <span className="num-tabular ml-auto shrink-0 font-bold">
                {formataHms((agora - new Date(parada.inicio).getTime()) / 1000)}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Kpi({ rotulo, valor, cor }: { rotulo: string; valor: string; cor?: string }) {
  return (
    <div className="bg-stone-950 px-6 py-4 text-center">
      <p className="text-xs font-medium uppercase tracking-widest text-stone-500">{rotulo}</p>
      <p className={`num-tabular mt-1 text-3xl font-bold ${cor ?? 'text-stone-100'}`}>{valor}</p>
    </div>
  )
}

const corOee = (v: number | null) =>
  v == null ? 'text-stone-500' : v >= 0.85 ? 'text-emerald-400' : v >= 0.6 ? 'text-amber-400' : 'text-red-400'

const diaLegivel = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
