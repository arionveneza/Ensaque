import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '@/dados/api'
import * as g from '@/dados/api-gestao'
import type { LoteSementeLinha, MovimentoLote, OrdemVisao } from '@/dados/api-gestao'
import { jaIniciada } from '@/dominio/status'
import type { StatusEfetivo } from '@/dominio/tipos'
import { useRealtime } from '@/dados/useRealtime'
import { useAuth } from '@/auth/AuthProvider'
import {
  Aviso, Botao, Cartao, Erro, Pagina, Tabela, Tag, Vazio,
  corDoStatus, dataHoraCurta, diaCurto, enderecoLote, exportarCsv, inteiro, n, somaDias,
} from '@/componentes/ui'

type Periodo = 'dia' | 'semana' | 'mes'

/**
 * Um lote com as ordens que dependem dele — o que a tela lista.
 *
 * A liberação é POR ORDEM desde 10/08/2026 (não mais um flag do lote
 * inteiro): `aLiberar` é o que falta liberar AGORA (o botão "Baixar"
 * cobre só essas), `liberadas` é o que já foi liberado e pode ser
 * estornado. Uma ordem nova do mesmo lote de outra já liberada entra
 * em `aLiberar`, mesmo que o lote já tenha sido baixado antes.
 *
 * `abertas` exige CONFIRMAÇÃO do PCP desde 11/08/2026 (`Aguardando lote`
 * ou `Pronto para produzir` — nunca `Programada`): dar máquina/dia a uma
 * ordem não deveria já expor ela para a Logística baixar o lote sem
 * revisão nenhuma do PCP. `iniciadas` é separado, para o badge "já
 * iniciada(s)" continuar contando certo mesmo com `abertas` mais estreito.
 */
type LoteAgregado = {
  lote: LoteSementeLinha
  dependentes: OrdemVisao[]
  abertas: OrdemVisao[]
  iniciadas: OrdemVisao[]
  aLiberar: OrdemVisao[]
  liberadas: OrdemVisao[]
  bagsNecessarios: number
  pesoT: number
  critico: boolean
  orfao: boolean
}

export default function Lotes() {
  const { usuario, permitido } = useAuth()
  const podeBaixar = permitido('lotes', 'baixar_lote')
  const podeConferir = permitido('lotes', 'conferir')

  const [lotes, setLotes] = useState<LoteSementeLinha[]>([])
  const [ordens, setOrdens] = useState<OrdemVisao[]>([])
  const [maquinas, setMaquinas] = useState<api.LinhaMaquina[]>([])
  const [movimentos, setMovimentos] = useState<MovimentoLote[]>([])
  const [conferencias, setConferencias] = useState<g.ConferenciaLinha[]>([])
  const [nomes, setNomes] = useState<Record<string, string>>({})
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
      const [l, o, m, c, nm] = await Promise.all([
        g.listarLotes(),
        g.listarOrdens(),
        g.listarMovimentos(`${desde}T00:00:00Z`),
        g.listarConferencias(),
        g.listarNomesUsuarios(),
      ])
      setLotes(l)
      setOrdens(o)
      setMovimentos(m)
      setConferencias(c)
      setNomes(nm)
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }, [desde])

  useEffect(() => {
    setCarregando(true)
    recarregar().finally(() => setCarregando(false))
  }, [recarregar])

  // só para traduzir maquina_id em nome nos cartões; cadastro não muda no turno
  useEffect(() => {
    api
      .carregarCadastros()
      .then((c) => setMaquinas(c.maquinas))
      .catch(() => {})
  }, [])

  const nomeMaquina = useCallback(
    (id: string | null) => (id ? (maquinas.find((m) => m.id === id)?.nome ?? id) : null),
    [maquinas],
  )

  // era a única tela de operação sem realtime: a logística não via a ordem
  // finalizar (para conferir) nem a baixa feita em outro computador
  useRealtime(['lotes_semente', 'lote_movimentos', 'ordens', 'ordem_conferencias'], recarregar)

  /** Agrega cada lote com as ordens que dependem dele. */
  const agregado = useMemo<LoteAgregado[]>(() => {
    return lotes
      .map((l) => {
        const dependentes = ordens.filter((o) => o.lote_id === l.id)
        const iniciadas = dependentes.filter((o) =>
          jaIniciada(o.status_efetivo as StatusEfetivo),
        )
        // só ordem CONFIRMADA pelo PCP entra na fila da logística — uma
        // ordem só "Programada" (máquina/dia dados, PCP ainda não revisou)
        // não deveria aparecer aqui para baixar (11/08/2026)
        const abertas = dependentes.filter((o) => {
          const st = o.status_efetivo as StatusEfetivo
          return st === 'Aguardando lote' || st === 'Pronto para produzir'
        })
        // por ordem, não pelo lote inteiro: uma ordem nova nasce em
        // aLiberar mesmo que outra do mesmo lote já esteja liberada
        const aLiberar = abertas.filter((o) => !o.lote_liberado_em)
        const liberadas = abertas.filter((o) => o.lote_liberado_em)
        const bagsNecessarios = aLiberar.reduce((a, o) => a + o.bags, 0)
        const pesoT = aLiberar.reduce((a, o) => a + o.peso_t, 0)
        const temUrgente = aLiberar.some((o) => o.prioridade === 'Urgente')
        return {
          lote: l,
          dependentes,
          abertas,
          iniciadas,
          aLiberar,
          liberadas,
          bagsNecessarios,
          pesoT,
          /** Trava ordem urgente: ainda falta liberar bags para ela. */
          critico: temUrgente,
          /** Baixado e sem nenhuma ordem: devolver ao estoque. */
          orfao: l.status === 'Baixado' && dependentes.length === 0,
        }
      })
      .sort(
        (a, b) =>
          Number(b.critico) - Number(a.critico) || b.bagsNecessarios - a.bagsNecessarios,
      )
  }, [lotes, ordens])

  const aBaixar = agregado.filter((a) => a.aLiberar.length > 0)
  const orfaos = agregado.filter((a) => a.orfao)
  const criticos = agregado.filter((a) => a.critico)
  // Tem ordem liberada (e ainda não iniciada): é o único caminho para
  // desfazer uma liberação errada — sem isto ficava invisível, sem botão
  // de estorno em lugar nenhum. Pode aparecer também em "A baixar" ao
  // mesmo tempo, se outra ordem do mesmo lote ainda espera liberação.
  const baixados = agregado.filter((a) => a.liberadas.length > 0)

  // etapa da logística: conferir fisicamente o estoque das finalizadas
  const FINALIZADAS = ['Finalizada', 'Qualidade apontada', 'Apontada']
  const conferenciaDe = (id: string) => conferencias.find((c) => c.ordem_id === id)
  const aConferir = ordens.filter(
    (o) => FINALIZADAS.includes(o.status_efetivo) && !conferenciaDe(o.id),
  )
  // a contagem fecha contra o que a produção declarou; o esperado é o fallback
  const divergentes = ordens.filter((o) => {
    const c = conferenciaDe(o.id)
    return c != null && c.bags_contados !== (o.bags_produzidos ?? o.bags)
  })

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
      titulo="Logística"
      descricao="Baixa de lote e conferência de estoque. Um clique em Baixar libera de uma vez todas as ordens em aberto daquele lote — mas a liberação é registrada por ordem: uma ordem nova, criada depois, nasce sempre aguardando, mesmo que o lote já tenha sido baixado para outras. O Estornar desfaz só uma ordem por vez, sem afetar as demais do mesmo lote."
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

      {/* -------- lista de lotes a baixar -------- */}
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-stone-500">
        A baixar ({aBaixar.length})
      </h3>

      {aBaixar.length === 0 ? (
        <Vazio>Nenhum lote pendente de baixa — todas as ordens abertas já têm lote liberado.</Vazio>
      ) : (
        /* Lista, não grade de cards: com muitos lotes a tabela de ordens dentro de
           cada card enchia a tela. Cada linha resume o lote e as ordens ficam
           atrás do "ver ordens" — aberto só nos críticos. */
        <div className="mb-6 divide-y divide-stone-200 overflow-hidden rounded-lg border border-stone-200 bg-white dark:divide-stone-800 dark:border-stone-800 dark:bg-stone-900">
          {aBaixar.map((a) => (
            <LinhaLote
              key={a.lote.id}
              item={a}
              podeBaixar={podeBaixar}
              nomeMaquina={nomeMaquina}
              onBaixar={() => comErro(() => g.baixarLote(a.lote.id))}
            />
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
          <Tabela cabecalho={['Lote', 'Cultivar', '#Peso/bag', 'Baixado por', '']}>
            {orfaos.map((a) => (
              <tr key={a.lote.id} className="border-t border-stone-100 dark:border-stone-800/60">
                <td className="px-2 py-2 font-medium">{a.lote.id}</td>
                <td className="px-2 py-2">{a.lote.cultivar}</td>
                <td className="num-tabular px-2 py-2 text-right">
                  {n(a.lote.peso_bag_kg, 0)} kg
                </td>
                <td className="px-2 py-2 text-xs text-stone-500">
                  <QuemEQuando
                    usuarioId={a.lote.baixado_por}
                    quando={a.lote.baixado_em}
                    nomes={nomes}
                  />
                </td>
                <td className="px-2 py-2 text-right">
                  {podeBaixar && (
                    <Botao
                      variante="perigo"
                      onClick={() => comErro(() => g.devolverLoteOrfao(a.lote.id))}
                    >
                      Devolver
                    </Botao>
                  )}
                </td>
              </tr>
            ))}
          </Tabela>
        </Cartao>
      )}

      {/* -------- baixados, para desfazer liberação errada -------- */}
      {baixados.length > 0 && (
        <Cartao titulo={`Baixados (${baixados.length})`} className="mb-6">
          <p className="mb-3 text-sm text-stone-500">
            Ordens já liberadas para a produção. O <b>estorno</b> desfaz a liberação de{' '}
            <b>uma</b> ordem — só enquanto ela não tiver sido iniciada. As outras ordens do
            mesmo lote, liberadas ou não, não são afetadas.
          </p>
          <div className="divide-y divide-stone-200 overflow-hidden rounded-lg border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
            {baixados.map((a) => (
              <LinhaLoteBaixado
                key={a.lote.id}
                item={a}
                podeBaixar={podeBaixar}
                nomes={nomes}
                onEstornar={(o) => {
                  if (!confirm(`Estornar a liberação da ordem ${o.numero} (lote ${a.lote.id})?`)) {
                    return
                  }
                  comErro(() => g.estornarLiberacao(o.id))
                }}
              />
            ))}
          </div>
        </Cartao>
      )}

      {/* -------- conferência de estoque (etapa da logística) -------- */}
      <Cartao
        titulo={`Conferência de estoque — ordens finalizadas (${aConferir.length})`}
        className="mb-6"
      >
        {divergentes.length > 0 && (
          <div className="mb-3">
            <Aviso gravidade="bloqueio">
              <b>{divergentes.length} divergência(s) na contagem:</b>{' '}
              {divergentes
                .map((o) => `${o.numero} (produzido ${o.bags_produzidos ?? `${o.bags} planejado`}, contado ${conferenciaDe(o.id)!.bags_contados})`)
                .join(' · ')}
            </Aviso>
          </div>
        )}
        {aConferir.length === 0 ? (
          <Vazio>Nenhuma ordem finalizada aguardando conferência física.</Vazio>
        ) : (
          <div className="space-y-3">
            {aConferir.map((o) => (
              <LinhaConferencia
                key={o.id}
                ordem={o}
                podeConferir={podeConferir}
                onConferir={(bags, obs) =>
                  comErro(() => g.registrarConferencia(o.id, bags, obs, usuario!.id))
                }
              />
            ))}
          </div>
        )}
      </Cartao>

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
                  ['Data', 'Lote', 'Bags', 'Peso (t)', 'Tipo', 'Quem'],
                  ...movimentos.map((m) => [
                    new Date(m.ts).toLocaleString('pt-BR'),
                    m.lote_id,
                    m.bags,
                    m.peso_t ?? '',
                    m.estorno ? 'Estorno' : 'Baixa',
                    (m.usuario_id && nomes[m.usuario_id]) || '',
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
            {(() => {
              const baixas = movimentos.filter((m) => !m.estorno)
              const estornos = movimentos.filter((m) => m.estorno)
              const conferidasPeriodo = conferencias.filter((c) => c.ts >= `${desde}T00:00:00Z`)
              const tile = 'rounded border border-stone-200 px-3 py-2 dark:border-stone-800'
              const rot = 'text-[11px] uppercase tracking-wide text-stone-500'
              const val = 'num-tabular text-lg font-semibold'
              return (
                <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  <div className={tile}>
                    <p className={rot}>Bags baixados</p>
                    <p className={val}>{inteiro(baixas.reduce((a, m) => a + m.bags, 0))}</p>
                  </div>
                  <div className={tile}>
                    <p className={rot}>Estornados</p>
                    <p className={val}>
                      {inteiro(Math.abs(estornos.reduce((a, m) => a + m.bags, 0)))}
                    </p>
                  </div>
                  <div className={tile}>
                    <p className={rot}>Líquido</p>
                    <p className={val}>{inteiro(movimentos.reduce((a, m) => a + m.bags, 0))}</p>
                  </div>
                  <div className={tile}>
                    <p className={rot}>Peso baixado</p>
                    <p className={val}>
                      {n(baixas.reduce((a, m) => a + (m.peso_t ?? 0), 0), 1)} t
                    </p>
                  </div>
                  <div className={tile}>
                    <p className={rot}>Lotes distintos</p>
                    <p className={val}>{new Set(baixas.map((m) => m.lote_id)).size}</p>
                  </div>
                  <div className={tile}>
                    <p className={rot}>Conferências</p>
                    <p className={val}>{conferidasPeriodo.length}</p>
                  </div>
                </div>
              )
            })()}
            <p className="mb-3 text-sm text-stone-500">
              {movimentos.filter((m) => !m.estorno).length} baixa(s) ·{' '}
              {movimentos.filter((m) => m.estorno).length} estorno(s) no período
            </p>
            <Tabela cabecalho={['Data', 'Lote', '#Bags', '#Peso', 'Tipo', 'Quem']}>
              {movimentos.map((m) => (
                <tr key={m.id} className="border-t border-stone-100 dark:border-stone-800/60">
                  {/* data+hora completa não pode quebrar em 2 linhas dentro da
                      célula — melhor rolar a tabela do que espremer o texto */}
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    {new Date(m.ts).toLocaleString('pt-BR')}
                  </td>
                  <td className="px-2 py-1.5 font-medium">{m.lote_id}</td>
                  <td className="num-tabular px-2 py-1.5 text-right">{m.bags}</td>
                  <td className="num-tabular px-2 py-1.5 text-right">
                    {m.peso_t == null ? '—' : `${n(m.peso_t, 1)} t`}
                  </td>
                  <td className="px-2 py-1.5">
                    <Tag cor={m.estorno ? 'alerta' : 'ok'}>{m.estorno ? 'Estorno' : 'Baixa'}</Tag>
                  </td>
                  <td className="px-2 py-1.5 text-xs text-stone-500">
                    {(m.usuario_id && nomes[m.usuario_id]) || '—'}
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

/**
 * Quem baixou o lote e quando — o banco grava isso desde a primeira baixa
 * (RPC grava `auth.uid()` + `now()`), mas a tela nunca mostrou; "quem baixou
 * este lote?" só tinha resposta consultando o banco direto.
 */
function QuemEQuando({
  usuarioId, quando, nomes,
}: {
  usuarioId: string | null
  quando: string | null
  nomes: Record<string, string>
}) {
  if (!usuarioId) return <>—</>
  return (
    <>
      {nomes[usuarioId] ?? 'usuário removido'}
      {quando && <> · {dataHoraCurta(quando)}</>}
    </>
  )
}

/**
 * Um lote na lista de baixa. A linha carrega o que a logística precisa para
 * decidir e ir buscar — quantos bags, peso, endereço e urgência; a tabela de
 * ordens dependentes só abre quando pedida.
 */
function LinhaLote({
  item, podeBaixar, nomeMaquina, onBaixar,
}: {
  item: LoteAgregado
  podeBaixar: boolean
  nomeMaquina: (id: string | null) => string | null
  onBaixar: () => void
}) {
  const { lote, abertas, aLiberar } = item
  // o resumo (qtd/urgência/endereço/destino) é só das ordens que ESTA baixa
  // afeta — aLiberar; ordens do mesmo lote já liberadas antes não entram
  // aqui, senão a badge de urgente/endereço mistura o que já foi liberado
  // com o que este clique vai liberar agora.
  const qtd = aLiberar.length
  const urgentes = aLiberar.filter((o) => o.prioridade === 'Urgente').length
  // endereço é da ordem, não do lote: quase sempre é um só, e aí cabe na linha
  const enderecos = [...new Set(aLiberar.map((o) => enderecoLote(o, '')).filter(Boolean))]
  const semEndereco = aLiberar.filter((o) => !enderecoLote(o, '')).length
  const primeiroDia = aLiberar.map((o) => o.data_prog).filter(Boolean).sort()[0]
  // para onde levar depois de baixar: a(s) máquina(s) das ordens dependentes
  const destinos = [...new Set(aLiberar.map((o) => nomeMaquina(o.maquina_id)).filter(Boolean))] as string[]
  const semMaquina = aLiberar.filter((o) => !o.maquina_id).length

  const rot = 'text-[10px] uppercase tracking-wide text-stone-500'
  const val = 'num-tabular font-semibold'

  return (
    <div className={`px-3 py-3 sm:px-4 ${item.critico ? 'bg-red-50/70 dark:bg-red-950/20' : ''}`}>
      {/*
        Bug real de celular (achado testando no aparelho, 08/08/2026):
        flex-1 tem flex-basis:0, então o bloco de texto era ignorado no
        cálculo de "cabe numa linha?" — o texto era espremido a ~16px de
        largura (uma palavra por linha) em vez do bloco de números quebrar
        para a linha de baixo. Empilha por padrão; só fica lado a lado a
        partir de sm: (tablet/desktop), onde sempre coube.
      */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between sm:gap-x-4">
        <div className="min-w-0 sm:flex-1">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
            <span>
              {lote.id} <span className="text-stone-400">·</span> {lote.cultivar}
            </span>
            {item.critico ? (
              <Tag cor="perigo">trava ordem urgente</Tag>
            ) : (
              urgentes > 0 && <Tag cor="alerta">{urgentes} urgente(s)</Tag>
            )}
          </p>
          <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
            {qtd === 1 ? '1 ordem' : `${inteiro(qtd)} ordens`}
            {primeiroDia && <> · 1ª em {diaCurto(primeiroDia)}</>}
            {destinos.length > 0 && (
              <> · <span className="font-medium text-stone-700 dark:text-stone-300">{destinos.join(' e ')}</span></>
            )}
            {semMaquina > 0 && <> · {semMaquina} sem máquina</>}
            {enderecos.length === 1 && <> · {enderecos[0]}</>}
            {enderecos.length > 1 && <> · {enderecos.length} endereços</>}
            {semEndereco > 0 && (
              <span className="text-amber-600 dark:text-amber-400">
                {' '}· {semEndereco} sem endereço
              </span>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <div className="text-right">
            <p className={rot}>Bags</p>
            <p className={val}>{inteiro(item.bagsNecessarios)}</p>
          </div>
          <div className="text-right">
            <p className={rot}>Peso</p>
            <p className={val}>{n(item.pesoT, 1)} t</p>
          </div>
          <div className="text-right">
            <p className={rot}>Peso/bag</p>
            <p className={val}>{n(lote.peso_bag_kg, 0)} kg</p>
          </div>
          {podeBaixar && (
            <Botao variante="primario" onClick={onBaixar}>
              Baixar {item.bagsNecessarios} bags
            </Botao>
          )}
        </div>
      </div>

      <details className="mt-2" open={item.critico}>
        <summary className="cursor-pointer py-2.5 text-xs text-stone-500 sm:py-1 dark:text-stone-400">
          {abertas.length === 1
            ? 'ver a ordem dependente'
            : `ver as ${abertas.length} ordens dependentes`}
        </summary>
        <div className="mt-1">
          <Tabela cabecalho={[
            'Ordem',
            { texto: 'Tratamento', className: 'hidden lg:table-cell' },
            'Máquina', 'Endereço',
            { texto: 'Dia', className: 'hidden lg:table-cell' },
            '#Bags', 'Status',
          ]}>
            {abertas.map((o) => (
              <tr key={o.id} className="border-t border-stone-100 dark:border-stone-800/60">
                <td className="px-2 py-1.5">
                  {o.numero}
                  {o.prioridade === 'Urgente' && (
                    <span className="ml-1">
                      <Tag cor="perigo">urgente</Tag>
                    </span>
                  )}
                  <p className="text-xs font-normal text-stone-500 lg:hidden">
                    {o.receita_nome} · {diaCurto(o.data_prog)}
                  </p>
                </td>
                <td className="hidden px-2 py-1.5 lg:table-cell">{o.receita_nome}</td>
                <td className="px-2 py-1.5">{nomeMaquina(o.maquina_id) ?? '—'}</td>
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
                <td className="hidden px-2 py-1.5 lg:table-cell">{diaCurto(o.data_prog)}</td>
                <td className="num-tabular px-2 py-1.5 text-right">{o.bags}</td>
                <td className="px-2 py-1.5">
                  <Tag cor={corDoStatus(o.status_efetivo)}>{o.status_efetivo}</Tag>
                </td>
              </tr>
            ))}
          </Tabela>
        </div>
      </details>
    </div>
  )
}

/**
 * Um lote na lista de "Baixados": o estorno é por ORDEM (10/08/2026), então
 * a linha lista cada ordem liberada com seu próprio botão — estornar uma não
 * afeta as outras do mesmo lote, liberadas ou ainda aguardando.
 */
function LinhaLoteBaixado({
  item, podeBaixar, nomes, onEstornar,
}: {
  item: LoteAgregado
  podeBaixar: boolean
  nomes: Record<string, string>
  onEstornar: (ordem: OrdemVisao) => void
}) {
  const { lote, liberadas, aLiberar, iniciadas } = item
  return (
    <div className="px-3 py-3 sm:px-4">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
        <span>
          {lote.id} <span className="text-stone-400">·</span> {lote.cultivar}
        </span>
        {aLiberar.length > 0 && <Tag cor="alerta">{aLiberar.length} aguardando</Tag>}
        {iniciadas.length > 0 && (
          <Tag cor="neutro">{iniciadas.length} já iniciada(s)</Tag>
        )}
      </p>
      <p className="mt-0.5 text-xs text-stone-500 dark:text-stone-400">
        {n(lote.peso_bag_kg, 0)} kg/bag
      </p>
      <div className="mt-2">
        <Tabela cabecalho={['Ordem', '#Bags', 'Liberado por', '']}>
          {liberadas.map((o) => (
            <tr key={o.id} className="border-t border-stone-100 dark:border-stone-800/60">
              <td className="px-2 py-1.5">
                {o.numero}
                {o.prioridade === 'Urgente' && (
                  <span className="ml-1">
                    <Tag cor="perigo">urgente</Tag>
                  </span>
                )}
              </td>
              <td className="num-tabular px-2 py-1.5 text-right">{o.bags}</td>
              <td className="px-2 py-1.5 text-xs text-stone-500">
                <QuemEQuando
                  usuarioId={o.lote_liberado_por}
                  quando={o.lote_liberado_em}
                  nomes={nomes}
                />
              </td>
              <td className="px-2 py-1.5 text-right">
                {podeBaixar && (
                  <Botao variante="perigo" onClick={() => onEstornar(o)}>
                    Estornar
                  </Botao>
                )}
              </td>
            </tr>
          ))}
        </Tabela>
      </div>
    </div>
  )
}

/**
 * A contagem física de uma ordem finalizada. O campo começa VAZIO de
 * propósito (decisão de 05/08/2026): a logística informa a quantidade
 * produzida que contou, sem ver um número pré-preenchido para confirmar
 * no automático. A divergência compara com o que a produção declarou ao
 * finalizar (bags_produzidos) — ou com o planejado, se faltar.
 */
function LinhaConferencia({
  ordem, podeConferir, onConferir,
}: {
  ordem: OrdemVisao
  podeConferir: boolean
  onConferir: (bags: number, obs: string | null) => void
}) {
  const [bags, setBags] = useState('')
  const [obs, setObs] = useState('')
  const contados = parseInt(bags, 10)
  const valido = Number.isFinite(contados) && contados >= 0
  const referencia = ordem.bags_produzidos ?? ordem.bags
  const diverge = valido && contados !== referencia

  return (
    <div className="rounded-md border border-stone-200 p-3 dark:border-stone-700">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="font-medium">
            {ordem.numero} · {ordem.cultivar}{' '}
            <Tag cor={corDoStatus(ordem.status_efetivo)}>{ordem.status_efetivo}</Tag>
          </p>
          <p className="text-xs text-stone-500">
            {ordem.receita_nome} · lote {ordem.lote_id} · esperado <b>{ordem.bags} bg</b>
            {ordem.bags_produzidos != null && (
              <> · produzido <b>{ordem.bags_produzidos} bg</b></>
            )}{' '}
            · {n(ordem.peso_t, 1)} t
          </p>
        </div>
        {podeConferir && (
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-sm">
              qtd. produzida
              <input
                type="number"
                min={0}
                value={bags}
                onChange={(e) => setBags(e.target.value)}
                placeholder="contar"
                className={`w-20 rounded-md border px-2 py-1.5 text-right text-sm dark:bg-stone-800 ${
                  diverge
                    ? 'border-amber-500 dark:border-amber-600'
                    : 'border-stone-300 dark:border-stone-700'
                }`}
              />
            </label>
            <input
              value={obs}
              onChange={(e) => setObs(e.target.value)}
              placeholder={diverge ? 'motivo da diferença' : 'observação (opcional)'}
              className="w-44 rounded-md border border-stone-300 px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-800"
            />
            <Botao
              variante="primario"
              disabled={!valido}
              onClick={() => onConferir(contados, obs.trim() || null)}
            >
              Conferir
            </Botao>
          </div>
        )}
      </div>
      {diverge && (
        <p className="mt-2 text-xs font-medium text-amber-700 dark:text-amber-400">
          Divergência: {contados} contados para {referencia}{' '}
          {ordem.bags_produzidos != null ? 'produzidos' : 'esperados'} (
          {contados > referencia ? '+' : ''}{contados - referencia} bg).
        </p>
      )}
    </div>
  )
}
