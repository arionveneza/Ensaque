/**
 * Relatório dos armazéns × SAP (13/10/2026, pedido do Arion: "um relatório dos
 * 5 armazéns para cruzar com o relatório do SAP e verificar as divergências").
 *
 * Junta a contagem dos inventários de armazém — um por armazém, o mais recente
 * COM lançamento (trocável no seletor) — e compara o TOTAL de cada lote +
 * tratamento + embalagem com a lista do SAP, que não sabe o armazém. A lista
 * do SAP vem de um inventário que já a tenha (lista_origem = 'sap') ou da
 * planilha subida aqui, só na memória — nada é gravado por esta tela.
 */
import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import readXlsxFile from 'read-excel-file/browser'
import * as api from '@/dados/api-inventario'
import { ARMAZENS_GALPAO } from '@/dominio/endereco'
import {
  ROTULO_SITUACAO, conferenciaArmazens, inventarioPorArmazem, resumoConferenciaArmazens,
  type LinhaConferenciaArmazens, type SaldoInventario, type SituacaoInventario,
} from '@/dominio/inventario'
import { converterEstoqueInventario, ehRelatorioMapa } from '@/dominio/importacao/mapa'
import type { Linha } from '@/dominio/importacao/simpleagro'
import { exportarXlsx } from '@/lib/exportar'
import { Aviso, Botao, Cartao, Erro, Tabela, Tag, dataHoraCurta, inteiro } from '@/componentes/ui'

const fmtBg = (v: number | null | undefined): string =>
  v == null ? '—' : v.toLocaleString('pt-BR', { maximumFractionDigits: 2 })

const COR_SITUACAO: Record<SituacaoInventario, 'ok' | 'alerta' | 'perigo' | 'info' | 'neutro'> = {
  bate: 'ok',
  sobra: 'perigo',
  falta: 'perigo',
  nao_contado: 'alerta',
  fora_do_sap: 'info',
}

type FonteSap =
  | { tipo: 'inventario'; id: string }
  | { tipo: 'planilha'; nome: string; saldos: SaldoInventario[] }

type Filtro = 'todas' | 'divergentes' | SituacaoInventario

const SELECT =
  'rounded-md border border-stone-300 px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-800'

export function RelatorioArmazens({
  invs, onFechar,
}: {
  invs: api.InventarioLinha[]
  onFechar: () => void
}) {
  const lancamentosDe = (i: api.InventarioLinha) => i.inventario_itens?.[0]?.count ?? 0
  const saldosDe = (i: api.InventarioLinha) => i.inventario_saldos?.[0]?.count ?? 0

  // um inventário por armazém: o mais recente com lançamento, trocável
  const [escolha, setEscolha] = useState<Record<string, string | null>>(() =>
    inventarioPorArmazem(
      invs.map((i) => ({ id: i.id, armazem: i.armazem, criado_em: i.criado_em, lancamentos: lancamentosDe(i) })),
      ARMAZENS_GALPAO,
    ),
  )
  const [itensPor, setItensPor] = useState<Record<string, api.ItemInventario[]>>({})

  // lista do SAP: o inventário mais recente que já tem a planilha, senão upload
  const comSap = useMemo(
    () => invs.filter((i) => i.lista_origem === 'sap' && saldosDe(i) > 0),
    [invs],
  )
  const [fonte, setFonte] = useState<FonteSap | null>(() =>
    comSap[0] ? { tipo: 'inventario', id: comSap[0].id } : null,
  )
  const [saldosInv, setSaldosInv] = useState<SaldoInventario[]>([])
  const [filtro, setFiltro] = useState<Filtro>('divergentes')
  const [busca, setBusca] = useState('')
  const [erro, setErro] = useState('')
  const [carregando, setCarregando] = useState(0)

  // contagem dos inventários escolhidos (cache por id — trocar e voltar não refaz)
  useEffect(() => {
    const faltam = Object.values(escolha).filter((id): id is string => !!id && !(id in itensPor))
    if (faltam.length === 0) return
    let vivo = true
    setCarregando((c) => c + 1)
    Promise.all(faltam.map(async (id) => [id, await api.listarItensInventario(id)] as const))
      .then((pares) => {
        if (vivo) setItensPor((atual) => ({ ...atual, ...Object.fromEntries(pares) }))
      })
      .catch((e) => {
        if (vivo) setErro((e as Error).message)
      })
      // sempre decrementa: no StrictMode o efeito roda, limpa e roda de novo —
      // com o guard de 'vivo' o contador ficava preso em 1 ('carregando…')
      .finally(() => setCarregando((c) => c - 1))
    return () => {
      vivo = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [escolha])

  useEffect(() => {
    if (fonte?.tipo !== 'inventario') return
    let vivo = true
    setCarregando((c) => c + 1)
    api
      .listarSaldosInventario(fonte.id)
      .then((ls) => {
        if (vivo) setSaldosInv(ls)
      })
      .catch((e) => {
        if (vivo) setErro((e as Error).message)
      })
      // sempre decrementa: no StrictMode o efeito roda, limpa e roda de novo —
      // com o guard de 'vivo' o contador ficava preso em 1 ('carregando…')
      .finally(() => setCarregando((c) => c - 1))
    return () => {
      vivo = false
    }
  }, [fonte])

  async function lerPlanilha(ev: ChangeEvent<HTMLInputElement>) {
    const arquivo = ev.target.files?.[0]
    ev.target.value = ''
    if (!arquivo) return
    setErro('')
    try {
      const bruto = (await readXlsxFile(arquivo)) as unknown
      const arr = bruto as { data?: Linha[] }[]
      const linhas =
        Array.isArray(arr) && arr.length > 0 && !Array.isArray(arr[0]) && Array.isArray(arr[0]?.data)
          ? (arr[0].data as Linha[])
          : (bruto as Linha[])
      if (!ehRelatorioMapa(linhas)) {
        throw new Error(
          'Não parece o export de saldo do SAP — esperava as colunas "Nº do Lote", "Qtd em Estoque", "Destinação" e "Depósito" (a mesma planilha do Mapa).',
        )
      }
      const r = converterEstoqueInventario(linhas)
      setFonte({ tipo: 'planilha', nome: arquivo.name, saldos: r.saldos })
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }

  const saldos: SaldoInventario[] = useMemo(
    () => (fonte?.tipo === 'planilha' ? fonte.saldos : fonte ? saldosInv : []),
    [fonte, saldosInv],
  )
  const contagens = useMemo(
    () =>
      ARMAZENS_GALPAO.flatMap((a) => {
        const id = escolha[a]
        if (!id) return []
        return (itensPor[id] ?? []).map((i) => ({
          lote: i.lote,
          tratamento: i.tratamento,
          embalagem: i.embalagem,
          cultivar: i.cultivar,
          bags: i.bags,
          armazem: a,
          descarte: i.descarte,
        }))
      }),
    [escolha, itensPor],
  )
  const linhas = useMemo(() => conferenciaArmazens(contagens, saldos), [contagens, saldos])
  const resumo = useMemo(() => resumoConferenciaArmazens(linhas), [linhas])

  const visiveis = useMemo(() => {
    const q = busca.trim().toUpperCase()
    return linhas.filter(
      (l) =>
        (filtro === 'todas' ||
          (filtro === 'divergentes' ? l.situacao !== 'bate' : l.situacao === filtro)) &&
        (!q ||
          l.lote.includes(q) ||
          (l.cultivar ?? '').toUpperCase().includes(q) ||
          l.tratamento.includes(q)),
    )
  }, [linhas, filtro, busca])

  const invDe = (id: string | null) => (id ? invs.find((i) => i.id === id) ?? null : null)
  const semInventario = ARMAZENS_GALPAO.filter((a) => !escolha[a])
  const emContagem = ARMAZENS_GALPAO.filter((a) => {
    const i = invDe(escolha[a])
    return i && !i.fechado_em
  })
  const fonteInv = fonte?.tipo === 'inventario' ? invDe(fonte.id) : null

  const colunasExport = [
    { titulo: 'Cultivar', largura: 16 },
    { titulo: 'Lote', largura: 20 },
    { titulo: 'Tratamento', largura: 18 },
    { titulo: 'Embalagem', largura: 10 },
    ...ARMAZENS_GALPAO.map((a) => ({ titulo: `Armazém ${a}`, tipo: 'numero' as const, casas: 2, largura: 11 })),
    { titulo: 'Contado', tipo: 'numero' as const, casas: 2, largura: 10 },
    { titulo: 'SAP', tipo: 'numero' as const, casas: 2, largura: 10 },
    { titulo: 'Diferença', tipo: 'numero' as const, casas: 2, largura: 11 },
    { titulo: 'Situação', largura: 14 },
    { titulo: 'Descarte', tipo: 'numero' as const, casas: 2, largura: 10 },
  ]
  const exportar = () =>
    exportarXlsx(
      `armazens-x-sap-${new Date().toISOString().slice(0, 10)}${filtro === 'todas' ? '' : `-${filtro}`}`,
      colunasExport,
      visiveis.map((l) => [
        l.cultivar ?? '',
        l.lote,
        l.tratamento,
        l.embalagem,
        ...ARMAZENS_GALPAO.map((a) => l.porArmazem[a] ?? null),
        l.contado,
        l.sistema,
        l.diferenca,
        ROTULO_SITUACAO[l.situacao],
        l.descarte > 0 ? l.descarte : null,
      ]),
    ).catch((e) => setErro((e as Error).message))

  const chips: { id: Filtro; rotulo: string; n: number }[] = [
    { id: 'divergentes', rotulo: 'Divergentes', n: linhas.filter((l) => l.situacao !== 'bate').length },
    ...(Object.keys(ROTULO_SITUACAO) as SituacaoInventario[]).map((s) => ({
      id: s as Filtro,
      rotulo: ROTULO_SITUACAO[s],
      n: resumo.porSituacao[s].linhas,
    })),
    { id: 'todas', rotulo: 'Todas', n: linhas.length },
  ]

  return (
    <div className="space-y-4">
      <Cartao
        titulo="Relatório dos armazéns × SAP"
        acoes={
          <div className="flex flex-wrap gap-2">
            <Botao variante="primario" disabled={visiveis.length === 0} onClick={() => void exportar()}>
              Exportar .xlsx ({inteiro(visiveis.length)})
            </Botao>
            <Botao onClick={onFechar}>Fechar</Botao>
          </div>
        }
      >
        <p className="text-xs text-stone-500 dark:text-stone-400">
          A contagem de cada armazém vem do inventário escolhido abaixo; o total de cada lote +
          tratamento + embalagem é comparado com a lista do SAP (que não sabe o armazém). Nada é
          gravado por aqui — é só pra ver e exportar.
        </p>
        {erro && <div className="mt-3"><Erro>{erro}</Erro></div>}

        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <div>
            <p className="mb-1 text-xs font-medium text-stone-500 dark:text-stone-400">Contagem por armazém</p>
            <div className="space-y-1.5">
              {ARMAZENS_GALPAO.map((a) => {
                const opcoes = invs
                  .filter((i) => i.armazem === a)
                  .sort((x, y) => y.criado_em.localeCompare(x.criado_em))
                const inv = invDe(escolha[a])
                return (
                  <div key={a} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="w-24 font-semibold">Armazém {a}</span>
                    <select
                      className={SELECT}
                      value={escolha[a] ?? ''}
                      onChange={(e) => setEscolha({ ...escolha, [a]: e.target.value || null })}
                    >
                      <option value="">— sem inventário —</option>
                      {opcoes.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.titulo} · {inteiro(lancamentosDe(i))} lançamento(s)
                          {i.fechado_em ? '' : ' · em contagem'}
                        </option>
                      ))}
                    </select>
                    {inv && (
                      <Tag cor={inv.aplicado_em ? 'ok' : inv.fechado_em ? 'info' : 'alerta'}>
                        {inv.aplicado_em ? 'substituído' : inv.fechado_em ? 'fechado' : 'em contagem'}
                      </Tag>
                    )}
                    {inv && (
                      <span className="num-tabular text-stone-500 dark:text-stone-400">
                        {fmtBg(resumo.porArmazem[a] ?? 0)} bags
                      </span>
                    )}
                  </div>
                )
              })}
            </div>
          </div>

          <div>
            <p className="mb-1 text-xs font-medium text-stone-500 dark:text-stone-400">Lista do SAP</p>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <select
                className={SELECT}
                value={fonte?.tipo === 'inventario' ? fonte.id : fonte ? 'planilha' : ''}
                onChange={(e) => {
                  const v = e.target.value
                  if (v && v !== 'planilha') setFonte({ tipo: 'inventario', id: v })
                  else if (!v) setFonte(null)
                }}
              >
                <option value="">— escolha —</option>
                {comSap.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.titulo} · {inteiro(saldosDe(i))} combinação(ões)
                  </option>
                ))}
                {fonte?.tipo === 'planilha' && <option value="planilha">{fonte.nome}</option>}
              </select>
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800">
                Subir a planilha do SAP (.xlsx)
                <input type="file" accept=".xlsx,.xls" className="hidden" onChange={lerPlanilha} />
              </label>
            </div>
            <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              {fonte?.tipo === 'planilha'
                ? `Planilha "${fonte.nome}": ${inteiro(fonte.saldos.length)} combinação(ões) do VEN_GER (só nesta tela — não grava em inventário nenhum).`
                : fonteInv
                  ? `Lista do SAP inserida no "${fonteInv.titulo}" (criado em ${dataHoraCurta(fonteInv.criado_em)}): ${inteiro(saldos.length)} combinação(ões).`
                  : 'Sem lista do SAP: escolha um inventário que já tenha a planilha ou suba o export de saldo do SAP.'}
            </p>
          </div>
        </div>

        {(semInventario.length > 0 || emContagem.length > 0) && (
          <div className="mt-3 space-y-2">
            {semInventario.length > 0 && (
              <Aviso>
                Sem inventário escolhido para o(s) armazém(ns) <b>{semInventario.join(', ')}</b>: o que
                está lá não entra no contado, então aparece como "não contado" ou "falta" contra o SAP.
              </Aviso>
            )}
            {emContagem.length > 0 && (
              <Aviso>
                Inventário ainda <b>em contagem</b> no(s) armazém(ns) <b>{emContagem.join(', ')}</b> — o
                número ainda muda.
              </Aviso>
            )}
          </div>
        )}
      </Cartao>

      <Cartao
        titulo={`Conferência — ${inteiro(linhas.length)} combinação(ões)${carregando > 0 ? ' · carregando…' : ''}`}
        acoes={
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="lote, cultivar ou tratamento"
            className={`${SELECT} w-56`}
          />
        }
      >
        <div className="mb-3 flex flex-wrap gap-2 text-sm">
          {chips.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setFiltro(c.id)}
              className={`rounded-full border px-3 py-1 ${
                filtro === c.id
                  ? 'border-green-700 bg-green-700 text-white'
                  : 'border-stone-300 hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800'
              }`}
            >
              {c.rotulo} <span className="num-tabular">({inteiro(c.n)})</span>
            </button>
          ))}
        </div>
        <div className="mb-3 grid gap-2 text-sm sm:grid-cols-3 lg:grid-cols-6">
          {(Object.keys(ROTULO_SITUACAO) as SituacaoInventario[]).map((s) => (
            <div key={s} className="rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-700">
              <Tag cor={COR_SITUACAO[s]}>{ROTULO_SITUACAO[s]}</Tag>
              <p className="num-tabular mt-1">
                <b>{fmtBg(resumo.porSituacao[s].bags)}</b> bags · {inteiro(resumo.porSituacao[s].linhas)} linha(s)
              </p>
            </div>
          ))}
          <div className="rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-700">
            <p className="text-xs text-stone-500 dark:text-stone-400">Contado × SAP</p>
            <p className="num-tabular mt-1">
              <b>{fmtBg(resumo.contado)}</b> × {fmtBg(resumo.sistema)} ·{' '}
              <span className={resumo.diferenca === 0 ? '' : 'font-semibold text-red-700 dark:text-red-400'}>
                {resumo.diferenca > 0 ? '+' : ''}
                {fmtBg(resumo.diferenca)}
              </span>
            </p>
          </div>
        </div>

        {visiveis.length === 0 ? (
          <p className="text-sm text-stone-500 dark:text-stone-400">
            {linhas.length === 0 ? 'Nada pra comparar ainda — escolha os inventários e a lista do SAP.' : 'Nenhuma linha neste filtro.'}
          </p>
        ) : (
          <Tabela
            cabecalho={[
              'Cultivar', 'Lote', 'Trat.', 'Emb.',
              ...ARMAZENS_GALPAO.map((a) => ({ texto: a, className: 'text-right' })),
              { texto: 'Contado', className: 'text-right' },
              { texto: 'SAP', className: 'text-right' },
              { texto: 'Dif.', className: 'text-right' },
              'Situação',
            ]}
            rodape={
              <tr className="font-semibold">
                <td className="px-3 py-2" colSpan={4}>Total ({inteiro(visiveis.length)})</td>
                {ARMAZENS_GALPAO.map((a) => (
                  <td key={a} className="num-tabular px-3 py-2 text-right">
                    {fmtBg(visiveis.reduce((s, l) => s + (l.porArmazem[a] ?? 0), 0))}
                  </td>
                ))}
                <td className="num-tabular px-3 py-2 text-right">{fmtBg(visiveis.reduce((s, l) => s + (l.contado ?? 0), 0))}</td>
                <td className="num-tabular px-3 py-2 text-right">{fmtBg(visiveis.reduce((s, l) => s + (l.sistema ?? 0), 0))}</td>
                <td className="num-tabular px-3 py-2 text-right">{fmtBg(visiveis.reduce((s, l) => s + l.diferenca, 0))}</td>
                <td />
              </tr>
            }
          >
            {visiveis.map((l) => (
              <LinhaRelatorio key={`${l.lote}|${l.tratamento}|${l.embalagem}`} l={l} />
            ))}
          </Tabela>
        )}
      </Cartao>
    </div>
  )
}

function LinhaRelatorio({ l }: { l: LinhaConferenciaArmazens }) {
  return (
    <tr>
      <td className="px-3 py-1.5">{l.cultivar || '—'}</td>
      <td className="num-tabular px-3 py-1.5">{l.lote}</td>
      <td className="px-3 py-1.5">
        {l.tratamento === 'SEM TSI' ? <Tag cor="neutro">SEM TSI</Tag> : l.tratamento}
      </td>
      <td className="px-3 py-1.5">{l.embalagem}</td>
      {ARMAZENS_GALPAO.map((a) => (
        <td key={a} className="num-tabular px-3 py-1.5 text-right">
          {a in l.porArmazem ? fmtBg(l.porArmazem[a]) : <span className="text-stone-300 dark:text-stone-600">—</span>}
        </td>
      ))}
      <td className="num-tabular px-3 py-1.5 text-right font-semibold">{fmtBg(l.contado)}</td>
      <td className="num-tabular px-3 py-1.5 text-right">{fmtBg(l.sistema)}</td>
      <td
        className={`num-tabular px-3 py-1.5 text-right ${
          l.situacao === 'bate' ? '' : 'font-semibold text-red-700 dark:text-red-400'
        }`}
      >
        {l.diferenca > 0 ? '+' : ''}
        {fmtBg(l.diferenca)}
      </td>
      <td className="px-3 py-1.5">
        <Tag cor={COR_SITUACAO[l.situacao]}>{ROTULO_SITUACAO[l.situacao]}</Tag>
        {l.descarte > 0 && (
          <Tag cor="perigo" className="ml-1">descarte {fmtBg(l.descarte)}</Tag>
        )}
      </td>
    </tr>
  )
}
