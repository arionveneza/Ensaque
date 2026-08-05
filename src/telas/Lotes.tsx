import { useCallback, useEffect, useMemo, useState } from 'react'
import * as g from '@/dados/api-gestao'
import type { LoteSementeLinha, MovimentoLote, OrdemVisao } from '@/dados/api-gestao'
import { jaIniciada, podeEstornarLote } from '@/dominio/status'
import type { StatusEfetivo } from '@/dominio/tipos'
import { useAuth } from '@/auth/AuthProvider'
import {
  Aviso, Botao, Cartao, Erro, Pagina, Tabela, Tag, Vazio,
  corDoStatus, diaCurto, enderecoLote, exportarCsv, inteiro, n, somaDias,
} from '@/componentes/ui'

type Periodo = 'dia' | 'semana' | 'mes'

export default function Lotes() {
  const { usuario, permitido } = useAuth()
  const podeBaixar = permitido('lotes', 'baixar_lote')

  const [lotes, setLotes] = useState<LoteSementeLinha[]>([])
  const [ordens, setOrdens] = useState<OrdemVisao[]>([])
  const [movimentos, setMovimentos] = useState<MovimentoLote[]>([])
  const [periodo, setPeriodo] = useState<Periodo>('semana')
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)

  const desde = useMemo(() => {
    const hoje = new Date().toISOString().slice(0, 10)
    return periodo === 'dia' ? hoje : somaDias(hoje, periodo === 'semana' ? -7 : -30)
  }, [periodo])

  const recarregar = useCallback(async () => {
    try {
      setErro(null)
      const [l, o, m] = await Promise.all([
        g.listarLotes(),
        g.listarOrdens(),
        g.listarMovimentos(`${desde}T00:00:00Z`),
      ])
      setLotes(l)
      setOrdens(o)
      setMovimentos(m)
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }, [desde])

  useEffect(() => {
    setCarregando(true)
    recarregar().finally(() => setCarregando(false))
  }, [recarregar])

  /** Agrega cada lote com as ordens que dependem dele. */
  const agregado = useMemo(() => {
    return lotes
      .map((l) => {
        const dependentes = ordens.filter((o) => o.lote_id === l.id)
        const abertas = dependentes.filter(
          (o) => !jaIniciada(o.status_efetivo as StatusEfetivo),
        )
        const bagsNecessarios = abertas.reduce((a, o) => a + o.bags, 0)
        const pesoT = abertas.reduce((a, o) => a + o.peso_t, 0)
        const temUrgente = abertas.some((o) => o.prioridade === 'Urgente')
        return {
          lote: l,
          dependentes,
          abertas,
          bagsNecessarios,
          pesoT,
          /** Trava ordem urgente: lote ainda em estoque com ordem urgente esperando. */
          critico: l.status === 'Em estoque' && temUrgente,
          /** Baixado e sem nenhuma ordem: devolver ao estoque. */
          orfao: l.status === 'Baixado' && dependentes.length === 0,
        }
      })
      .sort(
        (a, b) =>
          Number(b.critico) - Number(a.critico) || b.bagsNecessarios - a.bagsNecessarios,
      )
  }, [lotes, ordens])

  const aBaixar = agregado.filter((a) => a.lote.status === 'Em estoque' && a.abertas.length > 0)
  const orfaos = agregado.filter((a) => a.orfao)
  const criticos = agregado.filter((a) => a.critico)

  async function comErro(fn: () => Promise<void>) {
    try {
      setErro(null)
      await fn()
      await recarregar()
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }

  if (carregando) return <p className="p-8 text-sm text-stone-500">Carregando lotes…</p>

  return (
    <Pagina
      titulo="Lotes a baixar"
      descricao="A baixa é do lote, não da ordem: baixar um lote libera todas as ordens que dependem dele."
    >
      {erro && <Erro>{erro}</Erro>}

      {criticos.length > 0 && (
        <div className="mb-5">
          <Aviso gravidade="bloqueio">
            <b>{criticos.length} lote(s) crítico(s)</b> — travam ordem urgente:{' '}
            {criticos.map((c) => c.lote.id).join(', ')}
          </Aviso>
        </div>
      )}

      {/* -------- cards de lotes a baixar -------- */}
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-stone-500">
        A baixar ({aBaixar.length})
      </h3>

      {aBaixar.length === 0 ? (
        <Vazio>Nenhum lote pendente de baixa — todas as ordens abertas já têm lote liberado.</Vazio>
      ) : (
        <div className="mb-6 grid gap-4 sm:grid-cols-2">
          {aBaixar.map((a) => (
            <Cartao
              key={a.lote.id}
              titulo={`${a.lote.id} · ${a.lote.cultivar}`}
              acoes={
                podeBaixar ? (
                  <Botao
                    variante="primario"
                    onClick={() =>
                      comErro(() =>
                        g.baixarLote(a.lote.id, a.bagsNecessarios, a.pesoT, usuario!.id),
                      )
                    }
                  >
                    Baixar {a.bagsNecessarios} bags
                  </Botao>
                ) : undefined
              }
              className={a.critico ? 'border-red-300 dark:border-red-900' : ''}
            >
              {a.critico && (
                <div className="mb-3">
                  <Aviso gravidade="bloqueio">Trava ordem urgente.</Aviso>
                </div>
              )}
              <dl className="mb-3 grid grid-cols-3 gap-2 text-center text-sm">
                <div>
                  <dt className="text-[10px] uppercase text-stone-500">Bags</dt>
                  <dd className="num-tabular font-semibold">{a.bagsNecessarios}</dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase text-stone-500">Peso</dt>
                  <dd className="num-tabular font-semibold">{n(a.pesoT, 1)} t</dd>
                </div>
                <div>
                  <dt className="text-[10px] uppercase text-stone-500">Peso/bag</dt>
                  <dd className="num-tabular font-semibold">{n(a.lote.peso_bag_kg, 0)} kg</dd>
                </div>
              </dl>
              <Tabela cabecalho={['Ordem', 'Tratamento', 'Endereço', 'Dia', '#Bags', 'Status']}>
                {a.abertas.map((o) => (
                  <tr key={o.id} className="border-t border-stone-100 dark:border-stone-800/60">
                    <td className="px-2 py-1.5">
                      {o.numero}
                      {o.prioridade === 'Urgente' && (
                        <span className="ml-1">
                          <Tag cor="perigo">urgente</Tag>
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">{o.receita_nome}</td>
                    {/* é a informação que a separação usa: onde ir buscar */}
                    <td className="px-2 py-1.5 font-medium">
                      {o.armazem || o.bloco || o.quadra ? (
                        enderecoLote(o)
                      ) : (
                        <span className="text-xs font-normal text-amber-600 dark:text-amber-400">
                          sem endereço
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1.5">{diaCurto(o.data_prog)}</td>
                    <td className="num-tabular px-2 py-1.5 text-right">{o.bags}</td>
                    <td className="px-2 py-1.5">
                      <Tag cor={corDoStatus(o.status_efetivo)}>{o.status_efetivo}</Tag>
                    </td>
                  </tr>
                ))}
              </Tabela>
            </Cartao>
          ))}
        </div>
      )}

      {/* -------- baixados sem ordem -------- */}
      {orfaos.length > 0 && (
        <Cartao
          titulo={`Baixados sem ordem — devolver (${orfaos.length})`}
          className="mb-6 border-amber-300 dark:border-amber-900"
        >
          <p className="mb-3 text-sm text-stone-500">
            Estes lotes foram baixados e ficaram sem nenhuma ordem dependente. Devolva ao
            estoque para não distorcer o saldo.
          </p>
          <Tabela cabecalho={['Lote', 'Cultivar', '#Peso/bag', '']}>
            {orfaos.map((a) => {
              const permissao = podeEstornarLote(
                a.dependentes.map((o) => ({ status: o.status_efetivo as StatusEfetivo })),
              )
              return (
                <tr key={a.lote.id} className="border-t border-stone-100 dark:border-stone-800/60">
                  <td className="px-2 py-2 font-medium">{a.lote.id}</td>
                  <td className="px-2 py-2">{a.lote.cultivar}</td>
                  <td className="num-tabular px-2 py-2 text-right">
                    {n(a.lote.peso_bag_kg, 0)} kg
                  </td>
                  <td className="px-2 py-2 text-right">
                    {podeBaixar && (
                      <Botao
                        variante="perigo"
                        disabled={!permissao.permitido}
                        titulo={permissao.motivo}
                        onClick={() =>
                          comErro(() =>
                            g.estornarLote(a.lote.id, a.lote.bags_disp ?? 0, usuario!.id),
                          )
                        }
                      >
                        Estornar
                      </Botao>
                    )}
                  </td>
                </tr>
              )
            })}
          </Tabela>
        </Cartao>
      )}

      {/* -------- relatório de baixas -------- */}
      <Cartao
        titulo="Relatório de baixas"
        acoes={
          <>
            {(['dia', 'semana', 'mes'] as Periodo[]).map((p) => (
              <Botao
                key={p}
                variante={periodo === p ? 'primario' : 'normal'}
                onClick={() => setPeriodo(p)}
              >
                {p === 'dia' ? 'Hoje' : p === 'semana' ? '7 dias' : '30 dias'}
              </Botao>
            ))}
            <Botao
              disabled={movimentos.length === 0}
              onClick={() =>
                exportarCsv(`baixas-${periodo}`, [
                  ['Data', 'Lote', 'Bags', 'Peso (t)', 'Tipo'],
                  ...movimentos.map((m) => [
                    new Date(m.ts).toLocaleString('pt-BR'),
                    m.lote_id,
                    m.bags,
                    m.peso_t ?? '',
                    m.estorno ? 'Estorno' : 'Baixa',
                  ]),
                ])
              }
            >
              Exportar
            </Botao>
          </>
        }
      >
        {movimentos.length === 0 ? (
          <Vazio>Nenhuma movimentação no período.</Vazio>
        ) : (
          <>
            <p className="mb-3 text-sm text-stone-500">
              {movimentos.filter((m) => !m.estorno).length} baixa(s) ·{' '}
              {movimentos.filter((m) => m.estorno).length} estorno(s) ·{' '}
              {inteiro(movimentos.reduce((a, m) => a + m.bags, 0))} bags líquidos
            </p>
            <Tabela cabecalho={['Data', 'Lote', '#Bags', '#Peso', 'Tipo']}>
              {movimentos.map((m) => (
                <tr key={m.id} className="border-t border-stone-100 dark:border-stone-800/60">
                  <td className="px-2 py-1.5">{new Date(m.ts).toLocaleString('pt-BR')}</td>
                  <td className="px-2 py-1.5 font-medium">{m.lote_id}</td>
                  <td className="num-tabular px-2 py-1.5 text-right">{m.bags}</td>
                  <td className="num-tabular px-2 py-1.5 text-right">
                    {m.peso_t == null ? '—' : `${n(m.peso_t, 1)} t`}
                  </td>
                  <td className="px-2 py-1.5">
                    <Tag cor={m.estorno ? 'alerta' : 'ok'}>{m.estorno ? 'Estorno' : 'Baixa'}</Tag>
                  </td>
                </tr>
              ))}
            </Tabela>
          </>
        )}
      </Cartao>
    </Pagina>
  )
}
