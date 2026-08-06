import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '@/dados/api'
import * as g from '@/dados/api-gestao'
import type { OrdemVisao } from '@/dados/api-gestao'
import { capacidadeDiaT, diaDeProducao } from '@/dominio/calculos'
import {
  autoProgramar,
  checklistDoDia,
  horasDoDia,
  melhorSlot,
  otimizarSequencia,
  rebalancearDia,
  reprogramarCascata,
  rotuloTurnos,
  type CapacidadeDia,
  type OrdemProgramavel,
  type TurnosDoDia,
} from '@/dominio/programacao'
import { useRealtime } from '@/dados/useRealtime'
import { jaIniciada } from '@/dominio/status'
import type { StatusEfetivo } from '@/dominio/tipos'
import { useAuth } from '@/auth/AuthProvider'
import {
  Aviso, Botao, Cartao, Erro, Pagina, Tag, Vazio,
  corDoStatus, diaCurto, diaSemana, n, somaDias,
} from '@/componentes/ui'

const HORAS_TURNOS = [10, 9.5]
/** Até onde a cascata pode empurrar. */
const DIAS_CASCATA = 30

/** As quatro combinações possíveis, com o código que vai no `select`. */
const OPCOES_TURNO: { valor: string; rotulo: string; turnos: TurnosDoDia }[] = [
  { valor: '12', rotulo: '1º e 2º turno', turnos: { t1: true, t2: true } },
  { valor: '1', rotulo: 'só 1º turno', turnos: { t1: true, t2: false } },
  { valor: '2', rotulo: 'só 2º turno', turnos: { t1: false, t2: true } },
  { valor: '0', rotulo: 'sem produção', turnos: { t1: false, t2: false } },
]

const codigoTurnos = (t: TurnosDoDia) => `${t.t1 ? '1' : ''}${t.t2 ? '2' : ''}` || '0'

/** Onde a ordem arrastada vai cair: célula e posição na fila (null = no fim). */
type Alvo = { maq: string; dia: string; pos: number | null } | null

export default function Programacao() {
  const { usuario, permitido } = useAuth()
  const podeProgramar = permitido('programacao', 'editar')

  const [inicio, setInicio] = useState(() => diaDeProducao(new Date()))
  const [diaSel, setDiaSel] = useState(() => diaDeProducao(new Date()))
  const [maquinas, setMaquinas] = useState<api.LinhaMaquina[]>([])
  const [ordens, setOrdens] = useState<OrdemVisao[]>([])
  const [pool, setPool] = useState<OrdemVisao[]>([])
  const [calendario, setCalendario] = useState<g.DiaProducao[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [arrastando, setArrastando] = useState<string | null>(null)
  const [alvo, setAlvo] = useState<Alvo>(null)
  const [movendo, setMovendo] = useState<string | null>(null)
  const [previa, setPrevia] = useState<ReturnType<typeof reprogramarCascata> | null>(null)

  const dias = useMemo(
    () => Array.from({ length: 7 }, (_, i) => somaDias(inicio, i)),
    [inicio],
  )

  /**
   * A janela carregada é bem maior que a semana à vista: a cascata precisa
   * enxergar o atraso que ficou para trás e os dias adiante para onde vai
   * empurrar. O quadro continua mostrando só os 7 dias.
   */
  const janela = useMemo(
    () => ({ de: somaDias(inicio, -14), ate: somaDias(inicio, DIAS_CASCATA + 14) }),
    [inicio],
  )

  const recarregar = useCallback(async () => {
    try {
      setErro(null)
      const [lista, poolLista, cal] = await Promise.all([
        g.listarOrdens(janela.de, janela.ate),
        g.listarPool(),
        g.listarDiasProducao(janela.de, janela.ate),
      ])
      setOrdens(lista)
      setPool(poolLista)
      setCalendario(cal)
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }, [janela])

  useEffect(() => {
    let vivo = true
    setCarregando(true)
    Promise.all([
      api.carregarCadastros(),
      g.listarOrdens(janela.de, janela.ate),
      g.listarPool(),
      g.listarDiasProducao(janela.de, janela.ate),
    ])
      .then(([c, lista, poolLista, cal]) => {
        if (!vivo) return
        setMaquinas(c.maquinas)
        setOrdens(lista)
        setPool(poolLista)
        setCalendario(cal)
      })
      .catch((e) => vivo && setErro(e instanceof Error ? e.message : String(e)))
      .finally(() => vivo && setCarregando(false))
    return () => {
      vivo = false
    }
  }, [janela])

  useRealtime(['ordens', 'lotes_semente', 'dias_producao'], recarregar)

  /** Turnos que o dia roda. Sem exceção cadastrada, roda os dois. */
  const turnosDoDia = useCallback(
    (dia: string): TurnosDoDia => {
      const c = calendario.find((x) => x.data === dia)
      return c ? { t1: c.turno1, t2: c.turno2 } : { t1: true, t2: true }
    },
    [calendario],
  )

  const capacidades = useMemo(
    () =>
      maquinas.map((m) => ({
        id: m.id,
        capacidadeDiaT: capacidadeDiaT(m.capacidade_th, HORAS_TURNOS),
      })),
    [maquinas],
  )

  /** Capacidade real do dia: cai pela metade num dia de um turno só. */
  const capDia = useCallback<CapacidadeDia>(
    (maquinaId, dia) => {
      const th = maquinas.find((m) => m.id === maquinaId)?.capacidade_th ?? 0
      return th * horasDoDia(turnosDoDia(dia), HORAS_TURNOS)
    },
    [maquinas, turnosDoDia],
  )

  const paraDominio = useCallback(
    (o: OrdemVisao): OrdemProgramavel => ({
      id: o.id,
      cultivar: o.cultivar,
      receitaId: o.receita_id,
      prioridade: o.prioridade,
      pesoT: o.peso_t,
      loteBaixado: o.status_efetivo !== 'Aguardando lote',
      maquinaId: o.maquina_id,
      dataProg: o.data_prog,
      seq: o.seq,
      iniciada: jaIniciada(o.status_efetivo as StatusEfetivo),
    }),
    [],
  )

  /** Ordens no formato do domínio de programação. Só as ainda mexíveis. */
  const programaveis = useMemo<OrdemProgramavel[]>(
    () => [...ordens, ...pool].filter((o) => !jaIniciada(o.status_efetivo as StatusEfetivo)).map(paraDominio),
    [ordens, pool, paraDominio],
  )

  /**
   * A fila do dia, na ordem em que vai rodar. Ordena SÓ pela sequência: antes
   * as urgentes vinham à força na frente, e aí arrastar uma ordem normal para
   * o topo gravava seq 1 mas a tela continuava mostrando a urgente em cima —
   * parecia que o arraste não tinha funcionado. Urgência agora aparece na
   * etiqueta e no "Otimizar sequência", que é quem reordena de propósito.
   */
  const celula = useCallback(
    (maq: string, dia: string) =>
      ordens
        .filter((o) => o.maquina_id === maq && o.data_prog === dia)
        .sort((a, b) => (a.seq ?? 9999) - (b.seq ?? 9999) || a.numero.localeCompare(b.numero)),
    [ordens],
  )

  /**
   * Só troca o alvo quando ele realmente muda: `dragover` dispara a cada
   * pixel, e um setState por evento fazia o quadro inteiro repintar durante
   * o arraste — era boa parte da sensação de que arrastar "funciona mal".
   */
  const marcarAlvo = useCallback((novo: Alvo) => {
    setAlvo((a) =>
      a && novo && a.maq === novo.maq && a.dia === novo.dia && a.pos === novo.pos ? a : novo,
    )
  }, [])

  /**
   * Reescreve o seq como posição na fila (1..n) de TODAS as ordens ainda
   * móveis da célula — não só da ordem mexida. Gravar "quantos já estão + 1"
   * colidia com buracos e duplicatas herdadas (3, 3, 4, 7, 7, 7 na Execução):
   * ordem que sai não renumerava ninguém, e a próxima entrada repetia número.
   * Ordens já iniciadas ocupam a posição delas na fila, mas ficam de fora da
   * gravação — o banco recusa reprogramar ordem tocada pela produção.
   */
  const renumerar = useCallback(
    (maq: string, dia: string, fila: OrdemVisao[]) =>
      fila
        .map((o, i) => ({ o, seq: i + 1 }))
        .filter(({ o }) => !jaIniciada(o.status_efetivo as StatusEfetivo))
        .map(({ o, seq }) => ({ ordemId: o.id, maquinaId: maq, dia, seq })),
    [],
  )

  const ocupacaoCelula = useCallback(
    (maq: string, dia: string) => {
      const cap = capDia(maq, dia)
      const ton = celula(maq, dia).reduce((a, o) => a + o.peso_t, 0)
      return { ton, cap, pct: cap > 0 ? (ton / cap) * 100 : 0 }
    },
    [capDia, celula],
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

  /**
   * Move uma ordem para (máquina, dia, posição). `pos` é o índice na fila
   * COMO ELA APARECE na tela — se a ordem já estava nessa célula acima do
   * ponto de destino, o índice recua um, senão soltar logo abaixo da posição
   * atual não sairia do lugar.
   */
  const mover = useCallback(
    async (id: string, maq: string, dia: string, pos: number | null) => {
      const movida = [...ordens, ...pool].find((o) => o.id === id)
      if (!movida) return
      if (jaIniciada(movida.status_efetivo as StatusEfetivo)) {
        throw new Error(`A ordem ${movida.numero} já foi iniciada pela produção e não pode ser movida.`)
      }
      const original = celula(maq, dia)
      const idxOriginal = original.findIndex((x) => x.id === id)
      const destino = original.filter((x) => x.id !== id)
      let p = pos == null ? destino.length : pos
      if (idxOriginal >= 0 && idxOriginal < p) p -= 1
      p = Math.max(0, Math.min(p, destino.length))
      destino.splice(p, 0, movida)

      const atribuicoes = renumerar(maq, dia, destino)
      // a célula de onde saiu fecha o buraco na numeração
      if (
        movida.maquina_id &&
        movida.data_prog &&
        (movida.maquina_id !== maq || movida.data_prog !== dia)
      ) {
        atribuicoes.push(
          ...renumerar(
            movida.maquina_id,
            movida.data_prog,
            celula(movida.maquina_id, movida.data_prog).filter((x) => x.id !== id),
          ),
        )
      }
      await g.aplicarAtribuicoes(atribuicoes)
    },
    [ordens, pool, celula, renumerar],
  )

  /** Tira a ordem do quadro e devolve ao pool. */
  const desprogramar = useCallback(
    async (id: string) => {
      const o = [...ordens, ...pool].find((x) => x.id === id)
      if (!o || !o.maquina_id || !o.data_prog) return
      if (jaIniciada(o.status_efetivo as StatusEfetivo)) {
        throw new Error(`A ordem ${o.numero} já foi iniciada e não volta para o pool.`)
      }
      const origem = { maq: o.maquina_id, dia: o.data_prog }
      await g.reprogramar(id, null, null, null)
      await g.aplicarAtribuicoes(
        renumerar(origem.maq, origem.dia, celula(origem.maq, origem.dia).filter((x) => x.id !== id)),
      )
    },
    [ordens, pool, celula, renumerar],
  )

  function soltar(maq: string, dia: string, pos: number | null) {
    const id = arrastando
    setArrastando(null)
    setAlvo(null)
    if (!id) return
    comErro(() => mover(id, maq, dia, pos))
  }

  const checklist = useMemo(
    () => checklistDoDia(programaveis, capacidades, diaSel, capDia),
    [programaveis, capacidades, diaSel, capDia],
  )

  const numeroDe = useCallback(
    (id: string) => [...ordens, ...pool].find((o) => o.id === id)?.numero ?? id.slice(0, 8),
    [ordens, pool],
  )

  if (carregando) return <p className="p-8 text-sm text-stone-500">Carregando programação…</p>

  const diasCascata = Array.from({ length: DIAS_CASCATA + 1 }, (_, i) => somaDias(diaSel, i))

  return (
    <Pagina
      titulo="Programação & Ocupação"
      descricao="Capacidade de 12 t/h por máquina. Um dia de 2 turnos rende 234 t; de 1 turno, 120 t."
      acoes={
        podeProgramar ? (
          <>
            <Botao
              variante="primario"
              titulo="Distribui as ordens do pool: urgentes primeiro, depois lote baixado, agrupando receita para reduzir setup"
              onClick={() =>
                comErro(async () => {
                  const r = autoProgramar(programaveis, capacidades, dias, capDia)
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
              titulo={`Empurra para a frente o que não foi feito até ${diaCurto(diaSel)}, respeitando a capacidade de cada dia`}
              onClick={() => {
                setErro(null)
                const r = reprogramarCascata(
                  [...ordens].map(paraDominio),
                  capacidades,
                  diasCascata,
                  diaSel,
                  capDia,
                )
                if (r.movimentos.length === 0) {
                  setErro(
                    r.naoCouberam.length > 0
                      ? `Nada a reprogramar: ${r.naoCouberam.length} ordem(ns) não cabe(m) nos próximos ${DIAS_CASCATA} dias.`
                      : 'Nada a reprogramar — todas as ordens já cabem nos dias em que estão.',
                  )
                  return
                }
                setPrevia(r)
              }}
            >
              Reprogramar cascata
            </Botao>
            <Botao
              titulo="Move ordens da máquina sobrecarregada para a que tem folga, preferindo receitas afins"
              onClick={() =>
                comErro(async () => {
                  const r = rebalancearDia(programaveis, capacidades, diaSel, capDia)
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
        <p className="mb-2 text-xs text-stone-500">
          Arraste uma ordem do quadro abaixo sobre qualquer célula para mudá-la de dia ou de máquina.
        </p>
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
                    const destacado = alvo?.maq === m.id && alvo?.dia === d
                    const cor =
                      o.cap <= 0
                        ? 'bg-stone-100 text-stone-400 dark:bg-stone-800/60 dark:text-stone-500'
                        : o.pct > 100
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
                          onDragOver={(e) => {
                            if (!podeProgramar || !arrastando) return
                            e.preventDefault()
                            marcarAlvo({ maq: m.id, dia: d, pos: null })
                          }}
                          onDragLeave={() => destacado && setAlvo(null)}
                          onDrop={(e) => {
                            e.preventDefault()
                            soltar(m.id, d, null)
                          }}
                          className={`num-tabular w-full rounded px-2 py-1.5 text-xs ${cor} ${
                            destacado ? 'ring-2 ring-emerald-500' : ''
                          }`}
                        >
                          {o.cap <= 0 ? (
                            <>
                              <span className="block font-semibold">—</span>
                              <span className="block opacity-70">
                                {o.ton > 0 ? `${n(o.ton, 0)} t!` : 'sem prod.'}
                              </span>
                            </>
                          ) : (
                            <>
                              <span className="block font-semibold">{n(o.pct, 0)}%</span>
                              <span className="block opacity-70">{n(o.ton, 0)} t</span>
                            </>
                          )}
                        </button>
                      </td>
                    )
                  })}
                </tr>
              ))}
              {/* -------- turnos de cada dia -------- */}
              <tr className="border-t border-stone-200 dark:border-stone-700">
                <td className="px-2 py-2 text-xs font-medium uppercase tracking-wide text-stone-500">
                  Turnos
                </td>
                {dias.map((d) => {
                  const t = turnosDoDia(d)
                  const cheio = t.t1 && t.t2
                  return (
                    <td key={d} className="px-1 py-1.5 text-center">
                      {podeProgramar ? (
                        <select
                          value={codigoTurnos(t)}
                          onChange={(e) => {
                            const op = OPCOES_TURNO.find((x) => x.valor === e.target.value)!
                            comErro(() =>
                              g.definirTurnosDoDia(d, op.turnos.t1, op.turnos.t2, usuario!.id),
                            )
                          }}
                          title="Quais turnos rodam neste dia — 1º tem 10 h, 2º tem 9h30, e isso muda a capacidade"
                          className={`w-full rounded border px-1 py-1 text-xs dark:bg-stone-800 ${
                            cheio
                              ? 'border-stone-200 text-stone-500 dark:border-stone-700'
                              : 'border-amber-400 font-medium text-amber-700 dark:border-amber-700 dark:text-amber-400'
                          }`}
                        >
                          {OPCOES_TURNO.map((op) => (
                            <option key={op.valor} value={op.valor}>
                              {op.rotulo}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <span
                          className={`text-xs ${cheio ? 'text-stone-400' : 'font-medium text-amber-700 dark:text-amber-400'}`}
                        >
                          {rotuloTurnos(t)}
                        </span>
                      )}
                    </td>
                  )
                })}
              </tr>
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
          const naCelula = alvo?.maq === m.id && alvo?.dia === diaSel
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
                {o.cap <= 0 ? (
                  <span className="font-medium text-amber-700 dark:text-amber-400">
                    Dia sem produção{o.ton > 0 && ` — ${n(o.ton, 1)} t ainda programadas aqui`}
                  </span>
                ) : (
                  <>
                    {n(o.ton, 1)} t de {n(o.cap, 0)} t · {n(o.pct, 0)}% de ocupação ·{' '}
                    {rotuloTurnos(turnosDoDia(diaSel))}
                  </>
                )}
              </p>

              <div
                onDragOver={(e) => {
                  if (!podeProgramar || !arrastando) return
                  e.preventDefault()
                  marcarAlvo({ maq: m.id, dia: diaSel, pos: null })
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  soltar(m.id, diaSel, alvo?.maq === m.id && alvo?.dia === diaSel ? alvo.pos : null)
                }}
                className={`min-h-24 space-y-1.5 rounded-md border border-dashed p-2 ${
                  naCelula
                    ? 'border-emerald-500 bg-emerald-50/40 dark:bg-emerald-950/20'
                    : 'border-stone-300 dark:border-stone-700'
                }`}
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
                      <div key={ord.id}>
                        {naCelula && alvo?.pos === idx && <LinhaDeInsercao />}
                        <div
                          draggable={movivel}
                          onDragStart={() => setArrastando(ord.id)}
                          onDragEnd={() => {
                            setArrastando(null)
                            setAlvo(null)
                          }}
                          onDragOver={(e) => {
                            if (!podeProgramar || !arrastando) return
                            e.preventDefault()
                            e.stopPropagation()
                            const r = e.currentTarget.getBoundingClientRect()
                            const antes = e.clientY < r.top + r.height / 2
                            marcarAlvo({ maq: m.id, dia: diaSel, pos: idx + (antes ? 0 : 1) })
                          }}
                          className={`flex items-center gap-2 rounded-md border border-stone-200 bg-white px-2.5 py-2 text-sm dark:border-stone-700 dark:bg-stone-800 ${
                            movivel ? 'cursor-grab' : ''
                          } ${arrastando === ord.id ? 'opacity-40' : ''}`}
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
                            <>
                              <button
                                onClick={() => setMovendo(movendo === ord.id ? null : ord.id)}
                                title="Mover para outro dia ou máquina (funciona no tablet, onde arrastar não funciona)"
                                className="rounded border border-stone-300 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-stone-500 hover:bg-stone-100 dark:border-stone-600 dark:hover:bg-stone-700"
                              >
                                mover
                              </button>
                              <div className="flex flex-col">
                                <button
                                  disabled={idx === 0}
                                  onClick={() =>
                                    comErro(async () => {
                                      const fila = [...lista]
                                      ;[fila[idx - 1], fila[idx]] = [fila[idx], fila[idx - 1]]
                                      await g.aplicarAtribuicoes(renumerar(m.id, diaSel, fila))
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
                                      const fila = [...lista]
                                      ;[fila[idx], fila[idx + 1]] = [fila[idx + 1], fila[idx]]
                                      await g.aplicarAtribuicoes(renumerar(m.id, diaSel, fila))
                                    })
                                  }
                                  className="text-xs leading-none disabled:opacity-20"
                                >
                                  ▼
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                        {movendo === ord.id && (
                          <PainelMover
                            maquinas={maquinas}
                            dias={dias}
                            atual={{ maq: m.id, dia: diaSel }}
                            onFechar={() => setMovendo(null)}
                            onMover={(maq, dia, inicio) => {
                              setMovendo(null)
                              comErro(() => mover(ord.id, maq, dia, inicio ? 0 : null))
                            }}
                            onPool={() => {
                              setMovendo(null)
                              comErro(() => desprogramar(ord.id))
                            }}
                          />
                        )}
                        {naCelula && alvo?.pos === idx + 1 && <LinhaDeInsercao />}
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
      <div
        onDragOver={(e) => {
          if (!podeProgramar || !arrastando) return
          e.preventDefault()
          setAlvo(null)
        }}
        onDrop={(e) => {
          e.preventDefault()
          const id = arrastando
          setArrastando(null)
          if (id) comErro(() => desprogramar(id))
        }}
      >
        <Cartao titulo={`Pool — sem máquina (${pool.length})`}>
          {pool.length === 0 ? (
            <Vazio>
              Nenhuma ordem aguardando programação.
              {podeProgramar && ' Arraste uma ordem do quadro para cá para tirá-la do dia.'}
            </Vazio>
          ) : (
            <div className="flex flex-wrap gap-2">
              {pool.map((o) => (
                <div
                  key={o.id}
                  draggable={podeProgramar}
                  onDragStart={() => setArrastando(o.id)}
                  onDragEnd={() => {
                    setArrastando(null)
                    setAlvo(null)
                  }}
                  className={`rounded-md border border-stone-200 px-3 py-2 text-sm dark:border-stone-700 ${podeProgramar ? 'cursor-grab' : ''}`}
                >
                  <p className="font-medium">
                    {o.numero} · {o.cultivar}
                  </p>
                  <p className="text-xs text-stone-500">
                    {o.receita_nome} · {n(o.peso_t, 1)} t
                  </p>
                  {podeProgramar && (
                    <div className="mt-1.5">
                      <Botao
                        titulo="Coloca só esta ordem no primeiro slot que couber, preferindo máquina com a mesma receita"
                        onClick={() =>
                          comErro(async () => {
                            const alvoOrdem = programaveis.find((p) => p.id === o.id)
                            if (!alvoOrdem) return
                            const slot = melhorSlot(alvoOrdem, programaveis, capacidades, dias, capDia)
                            if (!slot) {
                              setErro(
                                `A ordem ${o.numero} (${n(o.peso_t, 1)} t) não cabe em nenhum dia do horizonte de 7 dias.`,
                              )
                              return
                            }
                            await g.aplicarAtribuicoes(
                              renumerar(slot.maquinaId, slot.dia, [
                                ...celula(slot.maquinaId, slot.dia),
                                o,
                              ]),
                            )
                            setDiaSel(slot.dia)
                          })
                        }
                      >
                        Encaixar
                      </Botao>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Cartao>
      </div>

      {previa && (
        <PreviaCascata
          resultado={previa}
          numeroDe={numeroDe}
          apartirDe={diaSel}
          onCancelar={() => setPrevia(null)}
          onAplicar={() => {
            const r = previa
            setPrevia(null)
            comErro(() =>
              g.aplicarAtribuicoes(
                r.movimentos.map((mv) => ({
                  ordemId: mv.ordem.id,
                  maquinaId: mv.ordem.maquinaId!,
                  dia: mv.paraDia,
                  seq: mv.seq,
                })),
              ),
            )
          }}
        />
      )}
    </Pagina>
  )
}

/** Onde a ordem arrastada vai entrar. */
function LinhaDeInsercao() {
  return <div className="my-1 h-0.5 rounded-full bg-emerald-500" />
}

/**
 * Mover sem arrastar. O quadro é usado em tablet, e arrastar-e-soltar de
 * HTML não funciona em tela de toque — sem isto, no tablet só dá para
 * reordenar com as setas, nunca mudar de dia ou de máquina.
 */
function PainelMover({
  maquinas, dias, atual, onFechar, onMover, onPool,
}: {
  maquinas: api.LinhaMaquina[]
  dias: string[]
  atual: { maq: string; dia: string }
  onFechar: () => void
  onMover: (maq: string, dia: string, inicio: boolean) => void
  onPool: () => void
}) {
  const [maq, setMaq] = useState(atual.maq)
  const [dia, setDia] = useState(atual.dia)
  const [inicio, setInicio] = useState(false)
  const campo =
    'rounded border border-stone-300 bg-white px-1.5 py-1 text-xs dark:border-stone-600 dark:bg-stone-800'

  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5 rounded-md border border-stone-300 bg-stone-50 px-2 py-2 dark:border-stone-600 dark:bg-stone-800/60">
      <select value={maq} onChange={(e) => setMaq(e.target.value)} className={campo}>
        {maquinas.map((m) => (
          <option key={m.id} value={m.id}>
            {m.nome}
          </option>
        ))}
      </select>
      <select value={dia} onChange={(e) => setDia(e.target.value)} className={campo}>
        {dias.map((d) => (
          <option key={d} value={d}>
            {diaSemana(d)} {diaCurto(d)}
          </option>
        ))}
      </select>
      <select
        value={inicio ? 'inicio' : 'fim'}
        onChange={(e) => setInicio(e.target.value === 'inicio')}
        className={campo}
      >
        <option value="fim">no fim da fila</option>
        <option value="inicio">no início da fila</option>
      </select>
      <Botao variante="primario" onClick={() => onMover(maq, dia, inicio)}>
        Mover
      </Botao>
      <Botao onClick={onPool}>Tirar do dia</Botao>
      <Botao onClick={onFechar}>Cancelar</Botao>
    </div>
  )
}

/**
 * A cascata mexe em dezenas de ordens de uma vez. Mostrar antes o que vai
 * acontecer é o que separa "ferramenta" de "susto": o PCP confere e decide.
 */
function PreviaCascata({
  resultado, numeroDe, apartirDe, onCancelar, onAplicar,
}: {
  resultado: ReturnType<typeof reprogramarCascata>
  numeroDe: (id: string) => string
  apartirDe: string
  onCancelar: () => void
  onAplicar: () => void
}) {
  const porDia = new Map<string, typeof resultado.movimentos>()
  for (const mv of resultado.movimentos) {
    const k = `${mv.paraDia}|${mv.ordem.maquinaId}`
    const grupo = porDia.get(k)
    if (grupo) grupo.push(mv)
    else porDia.set(k, [mv])
  }
  const chaves = [...porDia.keys()].sort()

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-xl bg-white shadow-xl dark:bg-stone-900">
        <header className="sticky top-0 border-b border-stone-200 bg-white px-5 py-4 dark:border-stone-800 dark:bg-stone-900">
          <h2 className="text-base font-semibold">Reprogramar em cascata</h2>
          <p className="mt-0.5 text-sm text-stone-500">
            {resultado.movimentos.length} ordem(ns) mudam de lugar a partir de{' '}
            {diaCurto(apartirDe)}. Ordens já iniciadas ficam onde estão. O dia em que cada uma
            estava programada continua guardado — aparece no relatório de ordens.
          </p>
        </header>

        <div className="space-y-4 p-5">
          {resultado.excedem.length > 0 && (
            <Aviso gravidade="alerta">
              <b>{resultado.excedem.length} ordem(ns) maior(es) que um dia inteiro</b> —{' '}
              {resultado.excedem.map((o) => numeroDe(o.id)).join(', ')}. Foram alocadas mesmo
              assim, e o dia vai aparecer acima de 100%.
            </Aviso>
          )}
          {resultado.naoCouberam.length > 0 && (
            <Aviso gravidade="alerta">
              <b>{resultado.naoCouberam.length} ordem(ns) não couberam</b> no horizonte de{' '}
              {DIAS_CASCATA} dias e ficam onde estão:{' '}
              {resultado.naoCouberam.map((o) => numeroDe(o.id)).join(', ')}.
            </Aviso>
          )}

          {chaves.map((k) => {
            const [dia, maq] = k.split('|')
            const lista = porDia.get(k)!
            return (
              <div key={k}>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
                  {diaSemana(dia)} {diaCurto(dia)} · {maq}
                </h3>
                <ul className="space-y-0.5 text-sm">
                  {lista
                    .slice()
                    .sort((a, b) => a.seq - b.seq)
                    .map((mv) => (
                      <li key={mv.ordem.id} className="flex items-center gap-2">
                        <span className="w-5 text-right text-xs text-stone-400">{mv.seq}</span>
                        <span className="font-medium">{numeroDe(mv.ordem.id)}</span>
                        <span className="text-xs text-stone-500">
                          {n(mv.ordem.pesoT, 1)} t
                          {mv.deDia && mv.deDia !== mv.paraDia && (
                            <> · vinha de {diaCurto(mv.deDia)}</>
                          )}
                        </span>
                        {mv.ordem.prioridade === 'Urgente' && <Tag cor="perigo">urgente</Tag>}
                      </li>
                    ))}
                </ul>
              </div>
            )
          })}
        </div>

        <footer className="sticky bottom-0 flex justify-end gap-2 border-t border-stone-200 bg-white px-5 py-3 dark:border-stone-800 dark:bg-stone-900">
          <Botao onClick={onCancelar}>Cancelar</Botao>
          <Botao variante="primario" onClick={onAplicar}>
            Aplicar {resultado.movimentos.length} mudança(s)
          </Botao>
        </footer>
      </div>
    </div>
  )
}
