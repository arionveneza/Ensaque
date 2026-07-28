import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '@/dados/api'
import * as g from '@/dados/api-gestao'
import type { OrdemVisao } from '@/dados/api-gestao'
import { capacidadeDiaT, diaDeProducao } from '@/dominio/calculos'
import {
  autoProgramar,
  checklistDoDia,
  otimizarSequencia,
  rebalancearDia,
  type OrdemProgramavel,
} from '@/dominio/programacao'
import { jaIniciada } from '@/dominio/status'
import type { StatusEfetivo } from '@/dominio/tipos'
import { useAuth } from '@/auth/AuthProvider'
import {
  Aviso, Botao, Cartao, Erro, Pagina, Tag, Vazio,
  corDoStatus, diaCurto, diaSemana, n, somaDias,
} from '@/componentes/ui'

const HORAS_TURNOS = [10, 9.5]

export default function Programacao() {
  const { usuario } = useAuth()
  const podeProgramar = usuario?.perfil === 'PCP' || usuario?.perfil === 'Gestor'

  const [inicio, setInicio] = useState(() => diaDeProducao(new Date()))
  const [diaSel, setDiaSel] = useState(() => diaDeProducao(new Date()))
  const [maquinas, setMaquinas] = useState<api.LinhaMaquina[]>([])
  const [ordens, setOrdens] = useState<OrdemVisao[]>([])
  const [pool, setPool] = useState<OrdemVisao[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [arrastando, setArrastando] = useState<string | null>(null)

  const dias = useMemo(
    () => Array.from({ length: 7 }, (_, i) => somaDias(inicio, i)),
    [inicio],
  )

  const recarregar = useCallback(async () => {
    try {
      setErro(null)
      const [lista, poolLista] = await Promise.all([
        g.listarOrdens(dias[0], dias[6]),
        g.listarPool(),
      ])
      setOrdens(lista)
      setPool(poolLista)
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }, [dias])

  useEffect(() => {
    let vivo = true
    setCarregando(true)
    Promise.all([api.carregarCadastros(), g.listarOrdens(dias[0], dias[6]), g.listarPool()])
      .then(([c, lista, poolLista]) => {
        if (!vivo) return
        setMaquinas(c.maquinas)
        setOrdens(lista)
        setPool(poolLista)
      })
      .catch((e) => vivo && setErro(e instanceof Error ? e.message : String(e)))
      .finally(() => vivo && setCarregando(false))
    return () => {
      vivo = false
    }
  }, [dias])

  const capacidades = useMemo(
    () =>
      maquinas.map((m) => ({
        id: m.id,
        capacidadeDiaT: capacidadeDiaT(m.capacidade_th, HORAS_TURNOS),
      })),
    [maquinas],
  )

  /** Ordens no formato do domínio de programação. Só as ainda mexíveis. */
  const programaveis = useMemo<OrdemProgramavel[]>(
    () =>
      [...ordens, ...pool]
        .filter((o) => !jaIniciada(o.status_efetivo as StatusEfetivo))
        .map((o) => ({
          id: o.id,
          cultivar: o.cultivar,
          receitaId: o.receita_id,
          prioridade: o.prioridade,
          pesoT: o.peso_t,
          loteBaixado: o.status_efetivo !== 'Aguardando lote',
          maquinaId: o.maquina_id,
          dataProg: o.data_prog,
          seq: o.seq,
        })),
    [ordens, pool],
  )

  const celula = useCallback(
    (maq: string, dia: string) =>
      ordens
        .filter((o) => o.maquina_id === maq && o.data_prog === dia)
        .sort(
          (a, b) =>
            (a.prioridade === 'Urgente' ? 0 : 1) - (b.prioridade === 'Urgente' ? 0 : 1) ||
            (a.seq ?? 999) - (b.seq ?? 999),
        ),
    [ordens],
  )

  const ocupacaoCelula = useCallback(
    (maq: string, dia: string) => {
      const cap = capacidades.find((c) => c.id === maq)?.capacidadeDiaT ?? 0
      const ton = celula(maq, dia).reduce((a, o) => a + o.peso_t, 0)
      return { ton, cap, pct: cap > 0 ? (ton / cap) * 100 : 0 }
    },
    [capacidades, celula],
  )

  async function comErro(fn: () => Promise<void>) {
    try {
      setErro(null)
      await fn()
      await recarregar()
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }

  const checklist = useMemo(
    () => checklistDoDia(programaveis, capacidades, diaSel),
    [programaveis, capacidades, diaSel],
  )

  if (carregando) return <p className="p-8 text-sm text-stone-500">Carregando programação…</p>

  return (
    <Pagina
      titulo="Programação & Ocupação"
      descricao="Capacidade de 12 t/h por máquina em 19,5 h de operação — 234 t por dia."
      acoes={
        podeProgramar ? (
          <>
            <Botao
              variante="primario"
              titulo="Distribui as ordens do pool: urgentes primeiro, depois lote baixado, agrupando receita para reduzir setup"
              onClick={() =>
                comErro(async () => {
                  const r = autoProgramar(programaveis, capacidades, dias)
                  if (r.atribuicoes.length === 0) {
                    setErro(
                      r.naoCouberam.length > 0
                        ? `Nenhuma ordem coube no horizonte de 7 dias (${r.naoCouberam.length} pendente(s)).`
                        : 'Nada no pool para programar.',
                    )
                    return
                  }
                  await g.aplicarAtribuicoes(r.atribuicoes)
                  if (r.naoCouberam.length > 0) {
                    setErro(
                      `${r.atribuicoes.length} ordem(ns) programada(s). ${r.naoCouberam.length} não coube(ram) no horizonte.`,
                    )
                  }
                })
              }
            >
              Programar automaticamente
            </Botao>
            <Botao
              titulo="Move ordens da máquina sobrecarregada para a que tem folga, preferindo receitas afins"
              onClick={() =>
                comErro(async () => {
                  const r = rebalancearDia(programaveis, capacidades, diaSel)
                  if (!r) {
                    setErro('O dia já está equilibrado — nenhum movimento melhora.')
                    return
                  }
                  await g.aplicarAtribuicoes(r.ordensMovidas)
                })
              }
            >
              Rebalancear o dia
            </Botao>
          </>
        ) : undefined
      }
    >
      {erro && <Erro>{erro}</Erro>}

      {/* -------- plano semanal -------- */}
      <Cartao
        titulo="Plano semanal"
        acoes={
          <>
            <Botao onClick={() => setInicio(somaDias(inicio, -7))}>← semana anterior</Botao>
            <Botao onClick={() => setInicio(diaDeProducao(new Date()))}>hoje</Botao>
            <Botao onClick={() => setInicio(somaDias(inicio, 7))}>próxima semana →</Botao>
          </>
        }
        className="mb-5"
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-stone-500">
                <th className="px-2 py-2">Máquina</th>
                {dias.map((d) => (
                  <th key={d} className="px-2 py-2 text-center">
                    <button
                      onClick={() => setDiaSel(d)}
                      className={`rounded px-2 py-0.5 ${d === diaSel ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900' : ''}`}
                    >
                      {diaSemana(d)} {diaCurto(d)}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {maquinas.map((m) => (
                <tr key={m.id} className="border-t border-stone-100 dark:border-stone-800/60">
                  <td className="px-2 py-2 font-medium">{m.nome}</td>
                  {dias.map((d) => {
                    const o = ocupacaoCelula(m.id, d)
                    const cor =
                      o.pct > 100
                        ? 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300'
                        : o.pct > 85
                          ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
                          : o.pct > 0
                            ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                            : 'text-stone-400'
                    return (
                      <td key={d} className="px-1 py-1.5 text-center">
                        <button
                          onClick={() => setDiaSel(d)}
                          className={`num-tabular w-full rounded px-2 py-1.5 text-xs ${cor}`}
                        >
                          <span className="block font-semibold">{n(o.pct, 0)}%</span>
                          <span className="block opacity-70">{n(o.ton, 0)} t</span>
                        </button>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Cartao>

      {/* -------- checklist -------- */}
      {checklist.length > 0 && (
        <div className="mb-5 space-y-2">
          {checklist.map((c, i) => (
            <Aviso key={i} gravidade={c.gravidade === 'bloqueio' ? 'bloqueio' : 'alerta'}>
              {c.mensagem}
            </Aviso>
          ))}
        </div>
      )}

      {/* -------- quadro do dia -------- */}
      <div className="mb-5 grid gap-4 sm:grid-cols-2">
        {maquinas.map((m) => {
          const lista = celula(m.id, diaSel)
          const o = ocupacaoCelula(m.id, diaSel)
          return (
            <Cartao
              key={m.id}
              titulo={`${m.nome} · ${diaSemana(diaSel)} ${diaCurto(diaSel)}`}
              acoes={
                podeProgramar && lista.length > 1 ? (
                  <Botao
                    titulo="Agrupa receitas iguais para reduzir trocas, mantendo urgentes na frente"
                    onClick={() =>
                      comErro(async () => {
                        const fila = lista
                          .filter((x) => !jaIniciada(x.status_efetivo as StatusEfetivo))
                          .map((x) => programaveis.find((p) => p.id === x.id)!)
                          .filter(Boolean)
                        await g.aplicarAtribuicoes(otimizarSequencia(fila))
                      })
                    }
                  >
                    Otimizar sequência
                  </Botao>
                ) : undefined
              }
            >
              <p className="num-tabular mb-3 text-xs text-stone-500">
                {n(o.ton, 1)} t de {n(o.cap, 0)} t · {n(o.pct, 0)}% de ocupação
              </p>

              <div
                onDragOver={(e) => podeProgramar && e.preventDefault()}
                onDrop={() =>
                  arrastando &&
                  comErro(async () => {
                    await g.reprogramar(arrastando, m.id, diaSel, lista.length + 1)
                    setArrastando(null)
                  })
                }
                className="min-h-24 space-y-1.5 rounded-md border border-dashed border-stone-300 p-2 dark:border-stone-700"
              >
                {lista.length === 0 ? (
                  <p className="py-4 text-center text-xs text-stone-400">
                    {podeProgramar ? 'Arraste ordens para cá' : 'Sem ordens'}
                  </p>
                ) : (
                  lista.map((ord, idx) => {
                    const movivel =
                      podeProgramar && !jaIniciada(ord.status_efetivo as StatusEfetivo)
                    return (
                      <div
                        key={ord.id}
                        draggable={movivel}
                        onDragStart={() => setArrastando(ord.id)}
                        className={`flex items-center gap-2 rounded-md border border-stone-200 bg-white px-2.5 py-2 text-sm dark:border-stone-700 dark:bg-stone-800 ${movivel ? 'cursor-grab' : ''}`}
                      >
                        <span className="w-5 text-xs text-stone-400">{idx + 1}</span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">
                            {ord.numero} · {ord.cultivar}
                          </p>
                          <p className="truncate text-xs text-stone-500">
                            {ord.receita_nome} · lote {ord.lote_id} · {n(ord.peso_t, 1)} t
                          </p>
                        </div>
                        {ord.prioridade === 'Urgente' && <Tag cor="perigo">urgente</Tag>}
                        <Tag cor={corDoStatus(ord.status_efetivo)}>{ord.status_efetivo}</Tag>
                        {movivel && (
                          <div className="flex flex-col">
                            <button
                              disabled={idx === 0}
                              onClick={() =>
                                comErro(async () => {
                                  const anterior = lista[idx - 1]
                                  await g.reprogramar(ord.id, m.id, diaSel, idx)
                                  await g.reprogramar(anterior.id, m.id, diaSel, idx + 1)
                                })
                              }
                              className="text-xs leading-none disabled:opacity-20"
                            >
                              ▲
                            </button>
                            <button
                              disabled={idx === lista.length - 1}
                              onClick={() =>
                                comErro(async () => {
                                  const proxima = lista[idx + 1]
                                  await g.reprogramar(ord.id, m.id, diaSel, idx + 2)
                                  await g.reprogramar(proxima.id, m.id, diaSel, idx + 1)
                                })
                              }
                              className="text-xs leading-none disabled:opacity-20"
                            >
                              ▼
                            </button>
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
              </div>
            </Cartao>
          )
        })}
      </div>

      {/* -------- pool -------- */}
      <Cartao titulo={`Pool — sem máquina (${pool.length})`}>
        {pool.length === 0 ? (
          <Vazio>Nenhuma ordem aguardando programação.</Vazio>
        ) : (
          <div className="flex flex-wrap gap-2">
            {pool.map((o) => (
              <div
                key={o.id}
                draggable={podeProgramar}
                onDragStart={() => setArrastando(o.id)}
                className={`rounded-md border border-stone-200 px-3 py-2 text-sm dark:border-stone-700 ${podeProgramar ? 'cursor-grab' : ''}`}
              >
                <p className="font-medium">
                  {o.numero} · {o.cultivar}
                </p>
                <p className="text-xs text-stone-500">
                  {o.receita_nome} · {n(o.peso_t, 1)} t
                </p>
              </div>
            ))}
          </div>
        )}
      </Cartao>
    </Pagina>
  )
}
