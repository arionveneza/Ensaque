import { useCallback, useEffect, useRef, useState } from 'react'
import * as v from '@/dados/api-veiculos'
import { useRealtime } from '@/dados/useRealtime'
import { dataHoraCurta } from '@/componentes/ui'

const LIMITE = 8

/** Toca um bipe curto via Web Audio (sem arquivo de áudio nenhum). */
function tocarBip() {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const ganho = ctx.createGain()
    osc.frequency.value = 880
    osc.connect(ganho)
    ganho.connect(ctx.destination)
    ganho.gain.setValueAtTime(0.2, ctx.currentTime)
    osc.start()
    osc.stop(ctx.currentTime + 0.3)
    osc.onended = () => void ctx.close()
  } catch {
    /* sem Web Audio: a leitura por voz e o texto grande na tela ainda avisam */
  }
}

function falar(texto: string) {
  if (!('speechSynthesis' in window)) return
  try {
    const u = new SpeechSynthesisUtterance(texto)
    u.lang = 'pt-BR'
    window.speechSynthesis.speak(u)
  } catch {
    /* sem speechSynthesis: o texto grande na tela ainda avisa */
  }
}

/**
 * Painel de chamada — modo TV pro pátio, mesmo espírito do Painel de
 * Produção: escuro fixo, texto enorme, atualiza sozinho (realtime + poll de
 * 30s + resync no visibilitychange, a mesma rede de segurança do outro
 * painel). O que muda é o anúncio: toda chamada NOVA toca um bipe e lê o
 * motorista/placa/motivo em voz alta — os navegadores bloqueiam áudio até um
 * gesto do usuário, então a tela abre com um overlay "toque para ativar o
 * som" (cobre TV ligada sem ninguém ter tocado ainda).
 */
export default function PainelChamada({ onSair }: { onSair: () => void }) {
  const [chamadas, setChamadas] = useState<v.ChamadaMotorista[]>([])
  const [agora, setAgora] = useState(() => Date.now())
  const [erro, setErro] = useState<string | null>(null)
  const [somAtivo, setSomAtivo] = useState(false)

  const ultimoAnunciado = useRef<string | null>(null)
  const primeiraCarga = useRef(true)

  const recarregar = useCallback(async () => {
    try {
      setErro(null)
      setChamadas(await v.listarChamadas(LIMITE))
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => { void recarregar() }, [recarregar])

  useRealtime(['chamadas_motorista'], recarregar)

  // relógio, só para o cabeçalho
  useEffect(() => {
    const t = setInterval(() => setAgora(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // rede de segurança: TV sempre ligada, se o websocket cair a tela congela
  useEffect(() => {
    const t = setInterval(() => void recarregar(), 30_000)
    return () => clearInterval(t)
  }, [recarregar])

  // aba dormindo congela o realtime; ao voltar, resincroniza
  useEffect(() => {
    const resync = () => {
      if (document.visibilityState === 'visible') void recarregar()
    }
    document.addEventListener('visibilitychange', resync)
    return () => document.removeEventListener('visibilitychange', resync)
  }, [recarregar])

  // anuncia só chamadas NOVAS — a primeira carga vira só a linha de base,
  // senão toda vez que o painel abre ele lê a última chamada de novo
  useEffect(() => {
    if (chamadas.length === 0) return
    const topo = chamadas[0]
    if (primeiraCarga.current) {
      primeiraCarga.current = false
      ultimoAnunciado.current = topo.id
      return
    }
    if (topo.id !== ultimoAnunciado.current) {
      ultimoAnunciado.current = topo.id
      if (somAtivo) {
        tocarBip()
        falar(`Motorista ${topo.motorista}, placa ${topo.placa}. ${topo.motivo}.`)
      }
    }
  }, [chamadas, somAtivo])

  const relogio = new Date(agora).toLocaleTimeString('pt-BR')
  const atual = chamadas[0] ?? null
  const anteriores = chamadas.slice(1)

  return (
    <div className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-stone-950 text-stone-100">
      <header className="flex items-center gap-3 border-b border-stone-800 px-4 py-3 sm:gap-4 sm:px-6">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-sm font-bold">
          TSI
        </span>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-bold leading-tight">Painel de Chamada</h1>
          <p className="truncate text-xs text-stone-400">Sementes Veneza · pátio</p>
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

      {erro && <div className="bg-red-900/40 px-6 py-2 text-sm text-red-300">{erro}</div>}

      <main className="flex flex-1 flex-col items-center gap-8 overflow-y-auto p-6">
        {atual ? (
          <div className="mt-4 w-full max-w-3xl rounded-2xl border-2 border-emerald-600 bg-stone-900 p-8 text-center">
            <p className="text-sm font-medium uppercase tracking-[0.3em] text-stone-500">
              Chamando agora
            </p>
            <p className="mt-3 text-5xl font-bold tracking-tight sm:text-6xl">{atual.motorista}</p>
            <p className="num-tabular mt-2 text-3xl text-stone-300">{atual.placa}</p>
            <p className="mt-4 text-2xl font-semibold text-emerald-400">{atual.motivo}</p>
            {atual.observacao && <p className="mt-2 text-stone-400">{atual.observacao}</p>}
          </div>
        ) : (
          <p className="mt-16 text-2xl text-stone-600">Nenhuma chamada ainda</p>
        )}

        {anteriores.length > 0 && (
          <div className="w-full max-w-3xl">
            <p className="mb-2 text-xs font-medium uppercase tracking-widest text-stone-500">
              Chamadas anteriores
            </p>
            <div className="space-y-1.5">
              {anteriores.map((c) => (
                <div
                  key={c.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-stone-900 px-4 py-2"
                >
                  <span className="font-medium text-stone-100">{c.motorista}</span>
                  <span className="num-tabular text-stone-400">{c.placa}</span>
                  <span className="text-stone-400">{c.motivo}</span>
                  <span className="num-tabular ml-auto text-xs text-stone-600">
                    {dataHoraCurta(c.chamado_em)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      {!somAtivo && (
        <button
          onClick={() => {
            setSomAtivo(true)
            tocarBip()
          }}
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-stone-950/95 text-center"
        >
          <span className="text-2xl font-bold">Toque para ativar o som</span>
          <span className="max-w-xs text-sm text-stone-400">
            O navegador só toca áudio sozinho depois de um toque na tela.
          </span>
        </button>
      )}
    </div>
  )
}
