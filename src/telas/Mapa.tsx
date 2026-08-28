import { useEffect, useMemo, useState, type ChangeEvent } from 'react'
import readXlsxFile from 'read-excel-file/browser'
import * as m from '@/dados/api-mapa'
import type { CargaMontadaLinha, EnderecoLote, LoteMapaLinha } from '@/dados/api-mapa'
import {
  converterLotesMapa, DEPOSITO_MAPA, ehRelatorioMapa, type ResultadoLotesMapa,
} from '@/dominio/importacao/mapa'
import type { Linha } from '@/dominio/importacao/simpleagro'
import { useAuth } from '@/auth/AuthProvider'
import { useRealtime } from '@/dados/useRealtime'
import { useRascunho } from '@/lib/useRascunho'
import {
  Aviso, Botao, Cartao, Erro, Pagina, Tabela, Tag, Vazio, dataHoraCurta, inteiro, n,
} from '@/componentes/ui'

/**
 * Mapa e Montagem de Carga (28/08/2026).
 *
 * TODO lote do SAP (semente branca E tratada) do depósito VEN_GER, com:
 * - fila de endereçamento: lote novo aparece "sem localização" e a
 *   Logística dá um ou mais endereços (Armazém + Bloco + Quadra + bags);
 * - mapa esquemático: por armazém, cada bloco é uma fileira de quadras —
 *   quadra de número MAIOR fica na frente (acesso mais fácil); filtros de
 *   cultivar/tratamento/embalagem acendem os lotes que casam;
 * - montagem de carga (Balança): nº da ordem de carregamento + cultivar +
 *   tratamento + bags; aviso quando o lote tem Destinação no SAP; peso
 *   total acumulado. A carga fica gravada; o saldo é sempre o do SAP.
 */

const rotuloTratamento = (t: string | null) => t ?? 'SEM TSI (branca)'
/** Sentinela do select de tratamento: string vazia não serve (é o "todos"). */
const BRANCA = '§branca§'

const INPUT =
  'rounded-lg border border-stone-300 px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-800'

interface ItemCargaForm {
  loteId: string
  bags: string
}

export default function Mapa() {
  const { usuario, permitido } = useAuth()
  const podeImportar = permitido('mapa', 'importar')
  const podeEnderecar = permitido('mapa', 'enderecar')
  const podeMontar = permitido('mapa', 'montar_carga')

  const [lotes, setLotes] = useState<LoteMapaLinha[] | null>([])
  const [cargas, setCargas] = useState<CargaMontadaLinha[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [previa, setPrevia] = useState<ResultadoLotesMapa | null>(null)
  const [importando, setImportando] = useState(false)
  const [enderecando, setEnderecando] = useState<LoteMapaLinha | null>(null)

  const recarregar = () =>
    Promise.all([m.listarLotesMapa(), m.listarCargasMontadas()])
      .then(([l, c]) => {
        setLotes(l)
        setCargas(c)
      })
      .catch((x) => setErro(x instanceof Error ? x.message : String(x)))

  useEffect(() => {
    recarregar().finally(() => setCarregando(false))
  }, [])
  useRealtime(['lotes_mapa', 'lote_enderecos', 'cargas_montadas'], () => void recarregar())

  // -------- filtros do mapa --------
  const [fCultivar, setFCultivar] = useState('')
  const [fTratamento, setFTratamento] = useState('')
  const [fEmbalagem, setFEmbalagem] = useState('')
  const [busca, setBusca] = useState('')
  const filtroAtivo = !!(fCultivar || fTratamento || fEmbalagem || busca.trim())

  const casaFiltro = (l: LoteMapaLinha): boolean => {
    if (fCultivar && l.cultivar !== fCultivar) return false
    if (fTratamento === BRANCA && l.tratamento != null) return false
    if (fTratamento && fTratamento !== BRANCA && l.tratamento !== fTratamento) return false
    if (fEmbalagem && l.embalagem !== fEmbalagem) return false
    if (busca.trim() && !l.id.toLowerCase().includes(busca.trim().toLowerCase())) return false
    return true
  }

  const todos = useMemo(() => lotes ?? [], [lotes])
  const cultivares = useMemo(() => [...new Set(todos.map((l) => l.cultivar))].sort(), [todos])
  const tratamentos = useMemo(
    () => [...new Set(todos.map((l) => l.tratamento).filter((t): t is string => t != null))].sort(),
    [todos],
  )
  const semEndereco = todos.filter((l) => l.lote_enderecos.length === 0)

  // -------- upload --------
  async function lerPlanilha(ev: ChangeEvent<HTMLInputElement>) {
    const arquivo = ev.target.files?.[0]
    ev.target.value = ''
    if (!arquivo) return
    setErro(null)
    setMsg(null)
    setPrevia(null)
    try {
      const bruto = (await readXlsxFile(arquivo)) as unknown
      const arr = bruto as { data?: Linha[] }[]
      const linhas =
        Array.isArray(arr) && arr.length > 0 && !Array.isArray(arr[0]) && Array.isArray(arr[0]?.data)
          ? (arr[0].data as Linha[])
          : (bruto as Linha[])
      if (!ehRelatorioMapa(linhas)) {
        throw new Error(
          'Não parece o export de saldo do SAP com Destinação — esperava as colunas "Nº do Lote", "Destinação" e "Depósito".',
        )
      }
      setPrevia(converterLotesMapa(linhas))
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }

  async function confirmarImportacao() {
    if (!previa) return
    setImportando(true)
    setErro(null)
    try {
      const qtd = await m.importarLotesMapa(previa.lotes)
      setPrevia(null)
      setMsg(`${qtd} lote(s) gravados — lote que zerou no SAP saiu do mapa.`)
      await recarregar()
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    } finally {
      setImportando(false)
    }
  }

  if (carregando) return <p className="p-8 text-sm text-stone-500">Carregando mapa…</p>

  return (
    <Pagina
      titulo="Mapa e Montagem de Carga"
      descricao={`Todo lote do SAP no depósito ${DEPOSITO_MAPA} — semente branca e tratada. A Logística endereça (armazém, bloco, quadra: quanto MAIOR a quadra, mais fácil o acesso); a Balança monta a carga informando a ordem de carregamento, e o sistema avisa lote com Destinação e soma o peso.`}
    >
      {erro && <Erro>{erro}</Erro>}
      {msg && (
        <div className="mb-4">
          <Aviso gravidade="ok">{msg}</Aviso>
        </div>
      )}

      {lotes === null && (
        <div className="mb-5">
          <Aviso gravidade="bloqueio">
            A tabela do mapa ainda não existe no banco — rode a migração{' '}
            <code>supabase/mapa-montagem-carga.sql</code> no SQL Editor e recarregue.
          </Aviso>
        </div>
      )}

      {/* -------- carga do SAP -------- */}
      <Cartao
        titulo={`Saldo do SAP (${todos.length} lotes no mapa)`}
        acoes={
          podeImportar ? (
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium hover:bg-stone-100 sm:py-1.5 dark:border-stone-700 dark:hover:bg-stone-800">
              Carregar planilha (.xlsx)
              <input type="file" accept=".xlsx,.xls" className="hidden" onChange={lerPlanilha} />
            </label>
          ) : undefined
        }
        className="mb-5"
      >
        {previa ? (
          <>
            <Aviso gravidade="alerta">
              <b>Prévia — nada foi gravado ainda.</b> {previa.lotes.length} lote(s) do{' '}
              {DEPOSITO_MAPA} ({previa.brancos} branco(s), {previa.tratados} tratado(s),{' '}
              {previa.comDestinacao} com destinação · {inteiro(previa.totalBags)} bags). Fora:{' '}
              {previa.outrosDepositos} de outros depósitos, {previa.zerados} zerados,{' '}
              {previa.granel} granel. Confirmar SUBSTITUI o mapa inteiro — lote que não veio
              some (endereços dos que continuam são preservados).
            </Aviso>
            <div className="mt-3 flex gap-2">
              <Botao variante="primario" disabled={importando} onClick={confirmarImportacao}>
                {importando ? 'gravando…' : `Confirmar importação (${previa.lotes.length} lotes)`}
              </Botao>
              <Botao onClick={() => setPrevia(null)}>Cancelar</Botao>
            </div>
          </>
        ) : (
          <p className="text-sm text-stone-500 dark:text-stone-400">
            {todos.length === 0
              ? `Nenhum lote no mapa ainda. Suba o export de saldo do SAP (com as colunas Destinação e Depósito) — só o ${DEPOSITO_MAPA} entra.`
              : `${semEndereco.length} lote(s) aguardando localização · ${todos.filter((l) => l.destinacao).length} com destinação no SAP. Suba a planilha de novo pra atualizar o saldo.`}
          </p>
        )}
      </Cartao>

      {/* -------- fila de endereçamento -------- */}
      {semEndereco.length > 0 && (
        <Cartao titulo={`Sem localização (${semEndereco.length})`} className="mb-5">
          <p className="mb-3 text-sm text-stone-500 dark:text-stone-400">
            Lotes do SAP ainda sem endereço físico — a Logística informa armazém, bloco e
            quadra (pode dividir em mais de um endereço).
          </p>
          <Tabela cabecalho={['Lote', 'Cultivar', 'Tratamento', 'Emb.', '#Bags', 'Destinação', '']}>
            {semEndereco.map((l) => (
              <tr key={l.id} className="border-t border-stone-100 dark:border-stone-800/60">
                <td className="px-2 py-1.5 font-medium">{l.id}</td>
                <td className="px-2 py-1.5">{l.cultivar}</td>
                <td className="px-2 py-1.5">
                  {l.tratamento ?? <span className="text-stone-400">branca</span>}
                </td>
                <td className="px-2 py-1.5">{l.embalagem}</td>
                <td className="num-tabular px-2 py-1.5 text-right">{inteiro(l.bags)}</td>
                <td className="px-2 py-1.5">
                  {l.destinacao ? <Tag cor="perigo">{l.destinacao}</Tag> : <span className="text-stone-300">—</span>}
                </td>
                <td className="px-2 py-1.5 text-right">
                  {podeEnderecar && <Botao onClick={() => setEnderecando(l)}>Endereçar</Botao>}
                </td>
              </tr>
            ))}
          </Tabela>
        </Cartao>
      )}

      {/* -------- mapa -------- */}
      <Cartao titulo="Mapa (visão superior)" className="mb-5">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <select value={fCultivar} onChange={(e) => setFCultivar(e.target.value)} className={INPUT}>
            <option value="">todos os cultivares</option>
            {cultivares.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={fTratamento} onChange={(e) => setFTratamento(e.target.value)} className={INPUT}>
            <option value="">todos os tratamentos</option>
            <option value={BRANCA}>SEM TSI (branca)</option>
            {tratamentos.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={fEmbalagem} onChange={(e) => setFEmbalagem(e.target.value)} className={INPUT}>
            <option value="">todas as embalagens</option>
            <option value="BG5M">BG5M</option>
            <option value="MEIOBAG">MEIOBAG</option>
          </select>
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="buscar lote…"
            className={INPUT}
          />
          {filtroAtivo && (
            <button
              type="button"
              onClick={() => { setFCultivar(''); setFTratamento(''); setFEmbalagem(''); setBusca('') }}
              className="rounded-md border border-stone-300 px-3 py-1.5 text-xs text-stone-600 underline hover:bg-stone-100 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
            >
              Limpar filtros
            </button>
          )}
        </div>

        <MapaVisao
          lotes={todos}
          casaFiltro={casaFiltro}
          filtroAtivo={filtroAtivo}
          onLote={podeEnderecar ? setEnderecando : undefined}
        />
      </Cartao>

      {/* -------- montagem de carga -------- */}
      {podeMontar && (
        <MontagemCarga
          lotes={todos}
          usuarioId={usuario?.id ?? ''}
          onSalva={() => {
            setMsg('Carga gravada.')
            void recarregar()
          }}
        />
      )}

      {/* -------- cargas recentes -------- */}
      <Cartao titulo={`Cargas montadas (${cargas.length} recentes)`}>
        {cargas.length === 0 ? (
          <Vazio>Nenhuma carga montada ainda.</Vazio>
        ) : (
          <Tabela cabecalho={['Ordem', 'Cultivar', 'Tratamento', '#Bags', '#Peso (kg)', 'Lotes', 'Quando']}>
            {cargas.map((c) => (
              <tr key={c.id} className="border-t border-stone-100 dark:border-stone-800/60">
                <td className="px-2 py-1.5 font-medium">{c.numero}</td>
                <td className="px-2 py-1.5">{c.cultivar}</td>
                <td className="px-2 py-1.5">{rotuloTratamento(c.tratamento)}</td>
                <td className="num-tabular px-2 py-1.5 text-right">
                  {inteiro(c.carga_montada_itens.reduce((s, i) => s + i.bags, 0))}
                </td>
                <td className="num-tabular px-2 py-1.5 text-right">{inteiro(c.peso_total_kg)}</td>
                <td className="px-2 py-1.5 text-xs text-stone-500">
                  {c.carga_montada_itens.map((i) => `${i.lote_id} (${inteiro(i.bags)})`).join(' · ')}
                </td>
                <td className="px-2 py-1.5 text-xs text-stone-500">{dataHoraCurta(c.criada_em)}</td>
              </tr>
            ))}
          </Tabela>
        )}
      </Cartao>

      {enderecando && usuario && (
        <ModalEnderecos
          lote={enderecando}
          onFechar={() => setEnderecando(null)}
          onSalvar={async (enderecos) => {
            try {
              await m.salvarEnderecos(enderecando.id, enderecos, usuario.id)
              setEnderecando(null)
              await recarregar()
            } catch (e) {
              setErro(e instanceof Error ? e.message : String(e))
            }
          }}
        />
      )}
    </Pagina>
  )
}

/**
 * Visão superior esquemática: por armazém, cada BLOCO é uma coluna de
 * QUADRAS ordenadas da MAIOR pra menor — a maior fica na frente (acesso
 * fácil), então aparece no topo com a marca "frente". Sem planta física:
 * o desenho nasce dos endereços existentes.
 */
function MapaVisao({
  lotes, casaFiltro, filtroAtivo, onLote,
}: {
  lotes: LoteMapaLinha[]
  casaFiltro: (l: LoteMapaLinha) => boolean
  filtroAtivo: boolean
  onLote?: (l: LoteMapaLinha) => void
}) {
  // armazém → bloco → quadra → lotes naquela quadra
  const estrutura = useMemo(() => {
    const arm = new Map<string, Map<string, Map<number, { lote: LoteMapaLinha; bagsAqui: number }[]>>>()
    for (const l of lotes) {
      for (const e of l.lote_enderecos) {
        const blocos = arm.get(e.armazem) ?? new Map()
        arm.set(e.armazem, blocos)
        const quadras = blocos.get(e.bloco) ?? new Map()
        blocos.set(e.bloco, quadras)
        const itens = quadras.get(e.quadra) ?? []
        quadras.set(e.quadra, itens)
        itens.push({ lote: l, bagsAqui: e.bags })
      }
    }
    return arm
  }, [lotes])

  if (estrutura.size === 0) {
    return <Vazio>Nenhum lote endereçado ainda — o mapa aparece conforme a Logística endereça.</Vazio>
  }

  const armazens = [...estrutura.keys()].sort()
  return (
    <div className="space-y-6">
      {armazens.map((armazem) => {
        const blocos = [...estrutura.get(armazem)!.entries()].sort(([a], [b]) =>
          a.localeCompare(b, undefined, { numeric: true }),
        )
        return (
          <div key={armazem}>
            <p className="mb-2 text-sm font-semibold">Armazém {armazem}</p>
            <div className="flex flex-wrap items-start gap-3 overflow-x-auto">
              {blocos.map(([bloco, quadras]) => {
                const qs = [...quadras.entries()].sort(([a], [b]) => b - a)
                return (
                  <div
                    key={bloco}
                    className="min-w-40 rounded-lg border border-stone-300 dark:border-stone-700"
                  >
                    <p className="border-b border-stone-200 px-2 py-1 text-center text-xs font-semibold uppercase tracking-wide text-stone-500 dark:border-stone-800">
                      Bloco {bloco}
                    </p>
                    {qs.map(([quadra, itens], qi) => (
                      <div
                        key={quadra}
                        className={`border-b border-dashed border-stone-200 p-1.5 last:border-b-0 dark:border-stone-800 ${
                          qi === 0 ? 'bg-green-50/60 dark:bg-green-950/20' : ''
                        }`}
                      >
                        <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-stone-400">
                          Q{quadra}
                          {qi === 0 && <span className="ml-1 text-green-700 dark:text-green-400">· frente</span>}
                        </p>
                        <div className="flex flex-wrap gap-1">
                          {itens.map(({ lote, bagsAqui }, i) => {
                            const casa = casaFiltro(lote)
                            const apagado = filtroAtivo && !casa
                            return (
                              <button
                                key={`${lote.id}-${i}`}
                                type="button"
                                onClick={onLote ? () => onLote(lote) : undefined}
                                title={`${lote.id} · ${lote.cultivar} · ${rotuloTratamento(lote.tratamento)} · ${lote.embalagem} · ${inteiro(bagsAqui)} bg aqui (${inteiro(lote.bags)} no lote)${lote.destinacao ? ` · DESTINAÇÃO: ${lote.destinacao}` : ''}`}
                                className={`rounded px-1.5 py-0.5 text-left text-[11px] leading-tight transition-opacity ${
                                  apagado ? 'opacity-20' : ''
                                } ${
                                  filtroAtivo && casa
                                    ? 'bg-green-200 font-semibold text-green-900 ring-1 ring-green-600 dark:bg-green-900 dark:text-green-100'
                                    : lote.destinacao
                                      ? 'bg-red-50 text-red-900 ring-1 ring-red-300 dark:bg-red-950/40 dark:text-red-200'
                                      : 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-200'
                                }`}
                              >
                                {lote.cultivar}
                                <span className="ml-1 font-normal opacity-70">{inteiro(bagsAqui)}bg</span>
                              </button>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
      <p className="text-xs text-stone-500">
        Quadra de número maior = frente do bloco (acesso mais fácil). Chip vermelho = lote
        com destinação no SAP; com filtro ativo, os que casam ficam verdes e o resto apaga.
        {onLote ? ' Clique num lote pra editar os endereços dele.' : ''}
      </p>
    </div>
  )
}

/** Endereços de um lote: linhas armazém/bloco/quadra/bags, substituição total. */
function ModalEnderecos({
  lote, onFechar, onSalvar,
}: {
  lote: LoteMapaLinha
  onFechar: () => void
  onSalvar: (enderecos: { armazem: string; bloco: string; quadra: number; bags: number }[]) => Promise<void>
}) {
  const [linhas, setLinhas] = useState<{ armazem: string; bloco: string; quadra: string; bags: string }[]>(
    lote.lote_enderecos.length > 0
      ? lote.lote_enderecos.map((e: EnderecoLote) => ({
          armazem: e.armazem, bloco: e.bloco, quadra: String(e.quadra), bags: String(e.bags),
        }))
      : [{ armazem: '', bloco: '', quadra: '', bags: String(lote.bags) }],
  )
  const [salvando, setSalvando] = useState(false)

  const validas = linhas.filter(
    (l) => l.armazem.trim() && l.bloco.trim() && l.quadra.trim() !== '' && Number(l.bags) > 0,
  )
  const somaBags = linhas.reduce((s, l) => s + (Number(l.bags) || 0), 0)

  const atualizar = (i: number, campo: keyof (typeof linhas)[number], valor: string) =>
    setLinhas((ls) => ls.map((l, idx) => (idx === i ? { ...l, [campo]: valor } : l)))

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-lg bg-white p-5 dark:bg-stone-900">
        <h3 className="text-base font-semibold">
          Endereçar — {lote.id} · {lote.cultivar} · {rotuloTratamento(lote.tratamento)}
        </h3>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          {inteiro(lote.bags)} bags no SAP. Quanto maior a QUADRA, mais fácil o acesso no
          bloco. Pode dividir em mais de um endereço.
        </p>

        <div className="mt-4 space-y-2">
          {linhas.map((l, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <input value={l.armazem} onChange={(e) => atualizar(i, 'armazem', e.target.value)} placeholder="armazém" className={`${INPUT} w-28`} />
              <input value={l.bloco} onChange={(e) => atualizar(i, 'bloco', e.target.value)} placeholder="bloco" className={`${INPUT} w-24`} />
              <input type="number" min={0} value={l.quadra} onChange={(e) => atualizar(i, 'quadra', e.target.value)} placeholder="quadra" className={`${INPUT} w-24`} />
              <input type="number" min={1} value={l.bags} onChange={(e) => atualizar(i, 'bags', e.target.value)} placeholder="bags" className={`${INPUT} w-24`} />
              {linhas.length > 1 && (
                <button
                  type="button"
                  onClick={() => setLinhas((ls) => ls.filter((_, idx) => idx !== i))}
                  title="Remover"
                  className="px-1 text-lg leading-none text-stone-400 hover:text-red-600"
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setLinhas((ls) => [...ls, { armazem: ls[0]?.armazem ?? '', bloco: '', quadra: '', bags: '' }])}
          className="mt-2 text-sm text-green-800 underline dark:text-green-400"
        >
          + adicionar endereço
        </button>

        {somaBags !== lote.bags && validas.length > 0 && (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
            Endereçado {inteiro(somaBags)} de {inteiro(lote.bags)} bags — só aviso, não trava.
          </p>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <Botao onClick={onFechar}>Cancelar</Botao>
          <Botao
            variante="primario"
            disabled={salvando || validas.length === 0}
            onClick={async () => {
              setSalvando(true)
              try {
                await onSalvar(
                  validas.map((l) => ({
                    armazem: l.armazem.trim().toUpperCase(),
                    bloco: l.bloco.trim().toUpperCase(),
                    quadra: Number(l.quadra),
                    bags: Number(l.bags),
                  })),
                )
              } finally {
                setSalvando(false)
              }
            }}
          >
            {salvando ? 'salvando…' : 'Salvar endereços'}
          </Botao>
        </div>
      </div>
    </div>
  )
}

/**
 * Montagem de carga da Balança. Rascunho persistente (mesmo padrão do
 * Programar em Ordens): fechar a tela no meio não perde a carga em
 * montagem. Os candidatos saem ordenados do acesso mais fácil pro mais
 * difícil (maior quadra primeiro; sem endereço por último).
 */
function MontagemCarga({
  lotes, usuarioId, onSalva,
}: {
  lotes: LoteMapaLinha[]
  usuarioId: string
  onSalva: () => void
}) {
  const rascunho = useRascunho<{
    numero: string
    cultivar: string
    tratamento: string
    bags: string
    itens: ItemCargaForm[]
  }>('mapa.carga', { numero: '', cultivar: '', tratamento: '', bags: '', itens: [] })
  const { numero, cultivar, tratamento, bags, itens } = rascunho.valor
  const [salvando, setSalvando] = useState(false)
  const [erro, setErro] = useState<string | null>(null)

  const cultivares = useMemo(() => [...new Set(lotes.map((l) => l.cultivar))].sort(), [lotes])
  const tratamentosDoCultivar = useMemo(
    () =>
      [...new Set(
        lotes
          .filter((l) => !cultivar || l.cultivar === cultivar)
          .map((l) => l.tratamento)
          .filter((t): t is string => t != null),
      )].sort(),
    [lotes, cultivar],
  )

  const maiorQuadra = (l: LoteMapaLinha) =>
    l.lote_enderecos.length === 0 ? -1 : Math.max(...l.lote_enderecos.map((e) => e.quadra))

  const candidatos = useMemo(() => {
    if (!cultivar || !tratamento) return []
    return lotes
      .filter(
        (l) =>
          l.cultivar === cultivar &&
          (tratamento === BRANCA ? l.tratamento == null : l.tratamento === tratamento) &&
          l.bags > 0,
      )
      .sort((a, b) => maiorQuadra(b) - maiorQuadra(a))
  }, [lotes, cultivar, tratamento])

  const porId = useMemo(() => new Map(lotes.map((l) => [l.id, l])), [lotes])
  const selecionados = itens
    .map((i) => ({ ...i, lote: porId.get(i.loteId) }))
    .filter((i): i is ItemCargaForm & { lote: LoteMapaLinha } => i.lote != null)

  const totalBags = selecionados.reduce((s, i) => s + (Number(i.bags) || 0), 0)
  const totalPesoKg = selecionados.reduce(
    (s, i) => s + (Number(i.bags) || 0) * i.lote.peso_bag_kg,
    0,
  )
  const solicitados = Number(bags) || 0
  const comDestinacao = selecionados.filter((i) => i.lote.destinacao)

  const definir = rascunho.definir
  const adicionar = (l: LoteMapaLinha) => {
    if (itens.some((i) => i.loteId === l.id)) return
    const restante = Math.max(0, solicitados - totalBags)
    const sugestao = restante > 0 ? Math.min(restante, l.bags) : l.bags
    definir({ itens: [...itens, { loteId: l.id, bags: String(sugestao) }] })
  }
  const atualizarBags = (loteId: string, v: string) =>
    definir({ itens: itens.map((i) => (i.loteId === loteId ? { ...i, bags: v } : i)) })
  const remover = (loteId: string) =>
    definir({ itens: itens.filter((i) => i.loteId !== loteId) })

  async function salvar() {
    if (!numero.trim() || !cultivar || !tratamento || selecionados.length === 0) return
    setSalvando(true)
    setErro(null)
    try {
      await m.criarCargaMontada(
        {
          numero: numero.trim(),
          cultivar,
          tratamento: tratamento === BRANCA ? null : tratamento,
          bags_solicitados: solicitados || totalBags,
          peso_total_kg: Math.round(totalPesoKg * 100) / 100,
        },
        selecionados.map((i) => ({
          lote_id: i.loteId,
          bags: Number(i.bags) || 0,
          peso_kg: Math.round((Number(i.bags) || 0) * i.lote.peso_bag_kg * 100) / 100,
          destinacao: i.lote.destinacao,
        })),
        usuarioId,
      )
      rascunho.limpar()
      onSalva()
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    } finally {
      setSalvando(false)
    }
  }

  return (
    <Cartao titulo="Montagem de carga" className="mb-5">
      {erro && <Erro>{erro}</Erro>}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={numero}
          onChange={(e) => definir({ numero: e.target.value })}
          placeholder="nº da ordem de carregamento"
          className={`${INPUT} w-56`}
        />
        <select
          value={cultivar}
          onChange={(e) => definir({ cultivar: e.target.value, itens: [] })}
          className={INPUT}
        >
          <option value="">cultivar…</option>
          {cultivares.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select
          value={tratamento}
          onChange={(e) => definir({ tratamento: e.target.value, itens: [] })}
          className={INPUT}
        >
          <option value="">tratamento…</option>
          <option value={BRANCA}>SEM TSI (branca)</option>
          {tratamentosDoCultivar.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input
          type="number"
          min={1}
          value={bags}
          onChange={(e) => definir({ bags: e.target.value })}
          placeholder="bags"
          className={`${INPUT} w-24`}
        />
      </div>

      {cultivar && tratamento && (
        <>
          {/* candidatos, do acesso mais fácil pro mais difícil */}
          <p className="mt-4 mb-1 text-xs font-semibold uppercase tracking-wide text-stone-500">
            Lotes disponíveis ({candidatos.length}) — acesso mais fácil primeiro
          </p>
          {candidatos.length === 0 ? (
            <Vazio>Nenhum lote de {cultivar} · {rotuloTratamento(tratamento === BRANCA ? null : tratamento)} no mapa.</Vazio>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {candidatos.map((l) => {
                const jaSelecionado = itens.some((i) => i.loteId === l.id)
                const end = l.lote_enderecos
                  .slice()
                  .sort((a, b) => b.quadra - a.quadra)
                  .map((e) => `${e.armazem} ${e.bloco}-Q${e.quadra}`)
                  .join(' · ')
                return (
                  <button
                    key={l.id}
                    type="button"
                    disabled={jaSelecionado}
                    onClick={() => adicionar(l)}
                    title={l.destinacao ? `DESTINAÇÃO: ${l.destinacao}` : undefined}
                    className={`rounded-md border px-2 py-1 text-left text-xs transition-colors ${
                      jaSelecionado
                        ? 'border-stone-200 text-stone-300 dark:border-stone-800'
                        : l.destinacao
                          ? 'border-red-300 bg-red-50 text-red-900 hover:bg-red-100 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'
                          : 'border-stone-300 hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800'
                    }`}
                  >
                    <span className="font-medium">{l.id}</span> · {inteiro(l.bags)} bg
                    {l.destinacao && <span className="ml-1 font-semibold">· {l.destinacao}</span>}
                    <span className="block text-[10px] opacity-70">
                      {end || 'sem endereço'}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          {comDestinacao.length > 0 && (
            <div className="mt-3">
              <Aviso gravidade="bloqueio">
                <b>Atenção:</b> lote(s) com DESTINAÇÃO no SAP selecionado(s):{' '}
                {comDestinacao.map((i) => `${i.loteId} → ${i.lote.destinacao}`).join(' · ')}
              </Aviso>
            </div>
          )}

          {selecionados.length > 0 && (
            <div className="mt-3">
              <Tabela cabecalho={['Lote', 'Endereço', '#Bags', '#Peso (kg)', 'Destinação', '']}>
                {selecionados.map((i) => (
                  <tr key={i.loteId} className="border-t border-stone-100 dark:border-stone-800/60">
                    <td className="px-2 py-1.5 font-medium">{i.loteId}</td>
                    <td className="px-2 py-1.5 text-xs text-stone-500">
                      {i.lote.lote_enderecos
                        .slice()
                        .sort((a, b) => b.quadra - a.quadra)
                        .map((e) => `${e.armazem} ${e.bloco}-Q${e.quadra}`)
                        .join(' · ') || '—'}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <input
                        type="number"
                        min={1}
                        max={i.lote.bags}
                        value={i.bags}
                        onChange={(e) => atualizarBags(i.loteId, e.target.value)}
                        className={`${INPUT} w-20 py-1 text-right`}
                      />
                    </td>
                    <td className="num-tabular px-2 py-1.5 text-right">
                      {inteiro((Number(i.bags) || 0) * i.lote.peso_bag_kg)}
                    </td>
                    <td className="px-2 py-1.5">
                      {i.lote.destinacao
                        ? <Tag cor="perigo">{i.lote.destinacao}</Tag>
                        : <span className="text-stone-300">—</span>}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <button
                        type="button"
                        onClick={() => remover(i.loteId)}
                        className="text-xs text-stone-400 underline hover:text-red-600"
                      >
                        remover
                      </button>
                    </td>
                  </tr>
                ))}
              </Tabela>

              <p className={`mt-3 text-sm font-medium ${solicitados > 0 && totalBags >= solicitados ? 'text-green-700 dark:text-green-400' : 'text-stone-600 dark:text-stone-300'}`}>
                {inteiro(totalBags)}{solicitados > 0 ? ` de ${inteiro(solicitados)}` : ''} bags ·
                peso total <b>{inteiro(totalPesoKg)} kg</b> ({n(totalPesoKg / 1000, 1)} t)
              </p>

              <div className="mt-3 flex gap-2">
                <Botao
                  variante="primario"
                  disabled={salvando || !numero.trim() || selecionados.length === 0}
                  onClick={salvar}
                >
                  {salvando ? 'gravando…' : 'Salvar carga'}
                </Botao>
                <Botao onClick={() => rascunho.limpar()}>Limpar</Botao>
              </div>
            </div>
          )}
        </>
      )}
    </Cartao>
  )
}
