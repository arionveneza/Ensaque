import { useEffect, useMemo, useState } from 'react'
import {
  Bar, BarChart, CartesianGrid, Cell, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import * as g from '@/dados/api-gestao'
import type { OrdemVisao, ParadaDetalhe, ParadaLinha, TempoOrdem } from '@/dados/api-gestao'
import { formataHms } from '@/dominio/calculos'
import { exportarXlsx } from '@/lib/exportar'
import {
  Botao, Cartao, Erro, Pagina, Tabela, Tag, Vazio, diaCurto, exportarCsv, n, somaDias,
} from '@/componentes/ui'

type Janela = 'dia' | 'semana' | 'mes'

export default function Indicadores() {
  const hoje = new Date().toISOString().slice(0, 10)
  const [janela, setJanela] = useState<Janela>('semana')
  const [tempos, setTempos] = useState<TempoOrdem[]>([])
  const [paradas, setParadas] = useState<ParadaDetalhe[]>([])
  const [paradasDet, setParadasDet] = useState<ParadaLinha[]>([])
  const [ordens, setOrdens] = useState<OrdemVisao[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)

  const de = useMemo(
    () => (janela === 'dia' ? hoje : somaDias(hoje, janela === 'semana' ? -7 : -30)),
    [janela, hoje],
  )

  useEffect(() => {
    let vivo = true
    setCarregando(true)
    Promise.all([
      g.listarTempos(de, hoje), g.paretoParadas(de, hoje),
      g.listarParadasPeriodo(de, hoje), g.listarOrdens(),
    ])
      .then(([t, p, pd, o]) => {
        if (!vivo) return
        setTempos(t)
        setParadas(p)
        setParadasDet(pd)
        setOrdens(o)
      })
      .catch((e) => vivo && setErro(e instanceof Error ? e.message : String(e)))
      .finally(() => vivo && setCarregando(false))
    return () => { vivo = false }
  }, [de, hoje])

  /** Bags, tratamento e lote de cada ordem — a v_ordem_tempos não os carrega. */
  const ordemPorId = useMemo(() => new Map(ordens.map((o) => [o.id, o])), [ordens])

  const totais = useMemo(() => {
    const t = tempos.reduce(
      (acc, x) => ({
        pesoT: acc.pesoT + Number(x.peso_t),
        bruto: acc.bruto + Number(x.bruto_s),
        liquido: acc.liquido + Number(x.liquido_s),
        paradas: acc.paradas + Number(x.paradas_s),
        planejadas: acc.planejadas + Number(x.paradas_plan_s),
        naoPlanejadas: acc.naoPlanejadas + Number(x.paradas_nplan_s),
        planejado: acc.planejado + Number(x.planejado_s),
      }),
      { pesoT: 0, bruto: 0, liquido: 0, paradas: 0, planejadas: 0, naoPlanejadas: 0, planejado: 0 },
    )
    return {
      ...t,
      ordens: tempos.length,
      dispBruta: t.bruto > 0 ? (t.liquido / t.bruto) * 100 : null,
      dispOperacional:
        t.bruto - t.planejadas > 0 ? (t.liquido / (t.bruto - t.planejadas)) * 100 : null,
      rendimento: t.liquido > 0 ? t.pesoT / (t.liquido / 3600) : null,
    }
  }, [tempos])

  /** Produção por máquina e turno. */
  const porMaquinaTurno = useMemo(() => {
    const mapa = new Map<string, { maquina: string; t1: number; t2: number }>()
    for (const t of tempos) {
      const chave = t.maquina_id
      const atual = mapa.get(chave) ?? { maquina: chave, t1: 0, t2: 0 }
      if (t.turno_id === 2) atual.t2 += Number(t.peso_t)
      else atual.t1 += Number(t.peso_t)
      mapa.set(chave, atual)
    }
    return [...mapa.values()]
  }, [tempos])

  const paradasPlan = paradas.filter((p) => p.tipo === 'Planejada')
  const paradasNaoPlan = paradas.filter((p) => p.tipo === 'Nao planejada')

  const totalBags = useMemo(
    () => tempos.reduce((a, t) => a + (ordemPorId.get(t.ordem_id)?.bags ?? 0), 0),
    [tempos, ordemPorId],
  )

  /** Produção agrupada por tratamento (receita). */
  const porTratamento = useMemo(() => {
    const mapa = new Map<
      string,
      { tratamento: string; ordens: number; bags: number; pesoT: number; liquido: number }
    >()
    for (const t of tempos) {
      const o = ordemPorId.get(t.ordem_id)
      const chave = o?.receita_nome ?? '?'
      const atual = mapa.get(chave) ?? { tratamento: chave, ordens: 0, bags: 0, pesoT: 0, liquido: 0 }
      atual.ordens++
      atual.bags += o?.bags ?? 0
      atual.pesoT += Number(t.peso_t)
      atual.liquido += Number(t.liquido_s)
      mapa.set(chave, atual)
    }
    return [...mapa.values()].sort((a, b) => b.pesoT - a.pesoT)
  }, [tempos, ordemPorId])

  /** Produção e tempo parado por dia. */
  const porDia = useMemo(() => {
    const mapa = new Map<
      string,
      { dia: string; ordens: number; bags: number; pesoT: number; parPlan: number; parNplan: number }
    >()
    for (const t of tempos) {
      const chave = t.data_prog ?? 'sem-dia'
      const o = ordemPorId.get(t.ordem_id)
      const atual =
        mapa.get(chave) ?? { dia: chave, ordens: 0, bags: 0, pesoT: 0, parPlan: 0, parNplan: 0 }
      atual.ordens++
      atual.bags += o?.bags ?? 0
      atual.pesoT += Number(t.peso_t)
      atual.parPlan += Number(t.paradas_plan_s)
      atual.parNplan += Number(t.paradas_nplan_s)
      mapa.set(chave, atual)
    }
    return [...mapa.values()].sort((a, b) => a.dia.localeCompare(b.dia))
  }, [tempos, ordemPorId])

  /** O relatório geral: uma linha por ordem, com tudo. */
  async function exportarGeral() {
    await exportarXlsx(
      `producao-geral-${de}-a-${hoje}`,
      [
        { titulo: 'Dia', largura: 12 }, { titulo: 'Máquina', largura: 10 },
        { titulo: 'Turno', largura: 8 }, { titulo: 'Ordem', largura: 14 },
        { titulo: 'Cultivar', largura: 18 }, { titulo: 'Lote', largura: 14 },
        { titulo: 'Tratamento', largura: 18 }, { titulo: 'Embalagem', largura: 12 },
        { titulo: 'Bags', largura: 8, tipo: 'numero', casas: 0 },
        { titulo: 'Peso (t)', largura: 10, tipo: 'numero', casas: 2 },
        { titulo: 'Planejado (h)', largura: 12, tipo: 'numero', casas: 2 },
        { titulo: 'Bruto (h)', largura: 10, tipo: 'numero', casas: 2 },
        { titulo: 'Líquido (h)', largura: 10, tipo: 'numero', casas: 2 },
        { titulo: 'Paradas (h)', largura: 10, tipo: 'numero', casas: 2 },
        { titulo: 'Par. planejadas (h)', largura: 14, tipo: 'numero', casas: 2 },
        { titulo: 'Par. não planej. (h)', largura: 14, tipo: 'numero', casas: 2 },
      ],
      tempos.map((t) => {
        const o = ordemPorId.get(t.ordem_id)
        return [
          t.data_prog ?? '', t.maquina_id, t.turno_id ?? '', t.numero,
          o?.cultivar ?? '', o?.lote_id ?? '', o?.receita_nome ?? '', o?.embalagem ?? '',
          o?.bags ?? '', Number(t.peso_t),
          Number(t.planejado_s) / 3600, Number(t.bruto_s) / 3600,
          Number(t.liquido_s) / 3600, Number(t.paradas_s) / 3600,
          Number(t.paradas_plan_s) / 3600, Number(t.paradas_nplan_s) / 3600,
        ]
      }),
    )
  }

  if (carregando) return <p className="p-8 text-sm text-stone-500">Carregando indicadores…</p>

  return (
    <Pagina
      titulo="Indicadores"
      descricao="Disponibilidade bruta penaliza toda parada; a operacional desconta as planejadas."
      acoes={
        <>
          {(['dia', 'semana', 'mes'] as Janela[]).map((j) => (
            <Botao key={j} variante={janela === j ? 'primario' : 'normal'} onClick={() => setJanela(j)}>
              {j === 'dia' ? 'Hoje' : j === 'semana' ? '7 dias' : '30 dias'}
            </Botao>
          ))}
          <Botao
            disabled={tempos.length === 0}
            titulo="Uma linha por ordem produzida: dia, turno, tratamento, bags, tempos e paradas"
            onClick={() => exportarGeral().catch((e) => setErro(String(e)))}
          >
            Relatório geral (.xlsx)
          </Botao>
        </>
      }
    >
      {erro && <Erro>{erro}</Erro>}

      {tempos.length === 0 ? (
        <Vazio>Nenhuma ordem com apontamento de início no período.</Vazio>
      ) : (
        <>
          <div className="mb-5 grid gap-3 sm:grid-cols-4 lg:grid-cols-7">
            <Indicador rotulo="Ordens" valor={String(totais.ordens)} />
            <Indicador rotulo="Bags" valor={String(totalBags)} />
            <Indicador rotulo="Produzido" valor={`${n(totais.pesoT, 1)} t`} />
            <Indicador rotulo="Tempo líquido" valor={formataHms(totais.liquido)} />
            <Indicador
              rotulo="Disp. bruta"
              valor={totais.dispBruta == null ? '—' : `${n(totais.dispBruta, 1)}%`}
            />
            <Indicador
              rotulo="Disp. operacional"
              valor={totais.dispOperacional == null ? '—' : `${n(totais.dispOperacional, 1)}%`}
            />
            <Indicador
              rotulo="Rendimento"
              valor={totais.rendimento == null ? '—' : `${n(totais.rendimento, 1)} t/h`}
            />
          </div>

          <Cartao titulo="Produção por máquina e turno" className="mb-5">
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={porMaquinaTurno}>
                  <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.15} />
                  <XAxis dataKey="maquina" fontSize={12} />
                  <YAxis fontSize={12} unit=" t" />
                  <Tooltip
                    formatter={(v) => `${n(Number(v), 1)} t`}
                    contentStyle={{ fontSize: 12 }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="t1" name="Turno 1" fill="#0ea5e9" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="t2" name="Turno 2" fill="#8b5cf6" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Cartao>

          <div className="mb-5 grid gap-5 lg:grid-cols-2">
            <Cartao titulo="Produção por tratamento">
              <Tabela cabecalho={['Tratamento', '#Ordens', '#Bags', '#Peso', '#Líquido']}>
                {porTratamento.map((t) => (
                  <tr key={t.tratamento} className="border-t border-stone-100 dark:border-stone-800/60">
                    <td className="px-2 py-1.5 font-medium">{t.tratamento}</td>
                    <td className="num-tabular px-2 py-1.5 text-right">{t.ordens}</td>
                    <td className="num-tabular px-2 py-1.5 text-right">{t.bags}</td>
                    <td className="num-tabular px-2 py-1.5 text-right">{n(t.pesoT, 1)} t</td>
                    <td className="num-tabular px-2 py-1.5 text-right">{formataHms(t.liquido)}</td>
                  </tr>
                ))}
              </Tabela>
            </Cartao>

            <Cartao titulo="Produção e paradas por dia">
              <Tabela cabecalho={['Dia', '#Ordens', '#Bags', '#Peso', '#Par. planej.', '#Par. não planej.']}>
                {porDia.map((d) => (
                  <tr key={d.dia} className="border-t border-stone-100 dark:border-stone-800/60">
                    <td className="px-2 py-1.5 font-medium">
                      {d.dia === 'sem-dia' ? '—' : diaCurto(d.dia)}
                    </td>
                    <td className="num-tabular px-2 py-1.5 text-right">{d.ordens}</td>
                    <td className="num-tabular px-2 py-1.5 text-right">{d.bags}</td>
                    <td className="num-tabular px-2 py-1.5 text-right">{n(d.pesoT, 1)} t</td>
                    <td className="num-tabular px-2 py-1.5 text-right">{formataHms(d.parPlan)}</td>
                    <td className="num-tabular px-2 py-1.5 text-right font-medium text-red-600 dark:text-red-400">
                      {d.parNplan > 0 ? formataHms(d.parNplan) : '—'}
                    </td>
                  </tr>
                ))}
              </Tabela>
            </Cartao>
          </div>

          <Cartao
            titulo="Pareto de paradas"
            acoes={
              <Botao
                disabled={paradas.length === 0}
                onClick={() =>
                  exportarCsv('paradas', [
                    ['Motivo', 'Tipo', 'Ocorrências', 'Tempo (h)'],
                    ...paradas.map((p) => [p.motivo, p.tipo, p.ocorrencias, p.segundos / 3600]),
                  ])
                }
              >
                Exportar
              </Botao>
            }
            className="mb-5"
          >
            {paradas.length === 0 ? (
              <Vazio>Nenhuma parada registrada no período.</Vazio>
            ) : (
              <>
                <p className="mb-3 text-sm text-stone-500">
                  Planejadas: {formataHms(paradasPlan.reduce((a, p) => a + p.segundos, 0))} ·
                  Não planejadas:{' '}
                  <b>{formataHms(paradasNaoPlan.reduce((a, p) => a + p.segundos, 0))}</b>
                </p>
                <div className="h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={paradas.map((p) => ({ ...p, horas: p.segundos / 3600 }))}
                      layout="vertical"
                      margin={{ left: 40 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="currentColor" opacity={0.15} />
                      <XAxis type="number" fontSize={12} unit=" h" />
                      <YAxis type="category" dataKey="motivo" fontSize={11} width={150} />
                      <Tooltip
                        formatter={(v) => `${n(Number(v), 2)} h`}
                        contentStyle={{ fontSize: 12 }}
                      />
                      <Bar dataKey="horas" radius={[0, 3, 3, 0]}>
                        {paradas.map((p, i) => (
                          <Cell key={i} fill={p.tipo === 'Planejada' ? '#0ea5e9' : '#ef4444'} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <p className="mt-2 text-xs text-stone-500">
                  Azul: parada planejada, descontada da disponibilidade operacional. Vermelho:
                  não planejada, perda real.
                </p>
              </>
            )}
          </Cartao>

          <Cartao
            titulo={`Paradas no período (${paradasDet.length})`}
            acoes={
              <Botao
                disabled={paradasDet.length === 0}
                onClick={() =>
                  exportarCsv('paradas-detalhadas', [
                    ['Dia', 'Ordem', 'Máquina', 'Turno', 'Início', 'Fim', 'Duração (min)',
                      'Motivo', 'Tipo'],
                    ...paradasDet.map((p) => [
                      p.data_prog ?? '', p.ordem_numero, p.maquina_id, p.turno_id ?? '',
                      new Date(p.inicio).toLocaleString('pt-BR'),
                      p.fim ? new Date(p.fim).toLocaleString('pt-BR') : 'em aberto',
                      Math.round(p.segundos / 60), p.motivo, p.tipo,
                    ]),
                  ])
                }
              >
                Exportar
              </Botao>
            }
            className="mb-5"
          >
            {paradasDet.length === 0 ? (
              <Vazio>Nenhuma parada registrada no período.</Vazio>
            ) : (
              <Tabela cabecalho={['Dia', 'Ordem', 'Máq.', 'Turno', 'Motivo', 'Tipo', '#Duração']}>
                {paradasDet.map((p, i) => (
                  <tr key={i} className="border-t border-stone-100 dark:border-stone-800/60">
                    <td className="px-2 py-1.5">{diaCurto(p.data_prog)}</td>
                    <td className="px-2 py-1.5 font-medium">{p.ordem_numero}</td>
                    <td className="px-2 py-1.5">{p.maquina_id}</td>
                    <td className="px-2 py-1.5">{p.turno_id ?? '—'}</td>
                    <td className="px-2 py-1.5">{p.motivo}</td>
                    <td className="px-2 py-1.5">
                      <Tag cor={p.tipo === 'Planejada' ? 'info' : 'perigo'}>{p.tipo}</Tag>
                    </td>
                    <td className="num-tabular px-2 py-1.5 text-right">
                      {formataHms(p.segundos)}{!p.fim && ' (em aberto)'}
                    </td>
                  </tr>
                ))}
              </Tabela>
            )}
          </Cartao>

          <Cartao
            titulo="Planejado vs realizado por ordem"
            acoes={
              <Botao
                onClick={() =>
                  exportarCsv('producao-por-ordem', [
                    ['Ordem', 'Máquina', 'Dia', 'Turno', 'Peso (t)', 'Planejado (s)',
                      'Bruto (s)', 'Líquido (s)', 'Paradas (s)'],
                    ...tempos.map((t) => [
                      t.numero, t.maquina_id, t.data_prog ?? '', t.turno_id ?? '',
                      t.peso_t, Math.round(t.planejado_s), Math.round(t.bruto_s),
                      Math.round(t.liquido_s), Math.round(t.paradas_s),
                    ]),
                  ])
                }
              >
                Exportar
              </Botao>
            }
          >
            <Tabela
              cabecalho={['Ordem', 'Máq.', 'Turno', '#Peso', '#Planejado', '#Bruto',
                '#Líquido', '#Paradas', 'Aderência']}
            >
              {tempos.map((t) => {
                const aderencia =
                  Number(t.liquido_s) > 0 ? (Number(t.planejado_s) / Number(t.liquido_s)) * 100 : null
                return (
                  <tr key={t.ordem_id} className="border-t border-stone-100 dark:border-stone-800/60">
                    <td className="px-2 py-1.5 font-medium">{t.numero}</td>
                    <td className="px-2 py-1.5">{t.maquina_id}</td>
                    <td className="px-2 py-1.5">{t.turno_id ?? '—'}</td>
                    <td className="num-tabular px-2 py-1.5 text-right">{n(Number(t.peso_t), 1)} t</td>
                    <td className="num-tabular px-2 py-1.5 text-right">{formataHms(Number(t.planejado_s))}</td>
                    <td className="num-tabular px-2 py-1.5 text-right">{formataHms(Number(t.bruto_s))}</td>
                    <td className="num-tabular px-2 py-1.5 text-right">{formataHms(Number(t.liquido_s))}</td>
                    <td className="num-tabular px-2 py-1.5 text-right">{formataHms(Number(t.paradas_s))}</td>
                    <td className="px-2 py-1.5 text-right">
                      {aderencia == null ? (
                        '—'
                      ) : (
                        <Tag cor={aderencia >= 90 ? 'ok' : aderencia >= 70 ? 'alerta' : 'perigo'}>
                          {n(aderencia, 0)}%
                        </Tag>
                      )}
                    </td>
                  </tr>
                )
              })}
            </Tabela>
          </Cartao>
        </>
      )}
    </Pagina>
  )
}

function Indicador({ rotulo, valor }: { rotulo: string; valor: string }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-3 dark:border-stone-800 dark:bg-stone-900">
      <p className="text-[10px] uppercase tracking-wide text-stone-500">{rotulo}</p>
      <p className="num-tabular mt-1 text-lg font-semibold">{valor}</p>
    </div>
  )
}
