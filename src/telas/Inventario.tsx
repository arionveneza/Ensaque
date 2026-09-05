/**
 * Inventário de sementes (04/09/2026) — contagem física × estoque do SAP.
 *
 * FORA do mapa, de propósito (pedido do Arion): nenhum saldo é ajustado —
 * a tela só responde "bate ou não bate?". O fluxo:
 *
 * 1. O PCP cria o inventário e INSERE o estoque do SAP nele (upload da
 *    mesma planilha do mapa) — a lista fica congelada no inventário.
 * 2. O operador (Logística/Produção) conta contra a lista: acha o lote e
 *    lança ENDEREÇO (Armazém/Bloco/Quadra) + QUANTIDADE — um lançamento
 *    por endereço; a conferência soma. Contagem CEGA: a quantidade do SAP
 *    não aparece aqui, só na conferência.
 * 3. Achou algo fora da lista → lançamento manual completo (cultivar SÓ da
 *    planilha do SAP; tratamento do cadastro de receitas; embalagem do
 *    cadastro) — vira "Fora do SAP".
 * 4. Fechar congela a comparação no servidor (inventario_resultados);
 *    reabrir descongela.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import readXlsxFile from 'read-excel-file/browser'
import { useAuth } from '@/auth/AuthProvider'
import * as api from '@/dados/api-inventario'
import { listarEmbalagens, listarReceitas } from '@/dados/api-gestao'
import { useRealtime } from '@/dados/useRealtime'
import {
  SEM_TSI, converterEstoqueInventario, ehRelatorioMapa,
  type ResultadoEstoqueInventario,
} from '@/dominio/importacao/mapa'
import type { Linha } from '@/dominio/importacao/simpleagro'
import {
  ROTULO_SITUACAO, chaveInventario, compararInventario, loteBaseMaiusculo,
  type LinhaInventario, type SituacaoInventario,
} from '@/dominio/inventario'
import {
  Aviso, Botao, Cartao, Erro, Pagina, Tabela, Tag, Vazio,
  dataHoraCurta, enderecoLote, exportarCsv, inteiro,
} from '@/componentes/ui'

const INPUT =
  'w-full rounded-md border border-stone-300 px-2 py-2 text-sm sm:py-1.5 dark:border-stone-700 dark:bg-stone-800'

const ROTULO_CAMPO = 'mb-1 block text-xs font-medium text-stone-500 dark:text-stone-400'

const fmtBg = (v: number | null): string =>
  v == null ? '—' : v.toLocaleString('pt-BR', { maximumFractionDigits: 2 })

/**
 * Quantidade digitada: inteiro ou até 2 casas com vírgula/ponto. Formato de
 * milhar é RECUSADO de propósito — Number('1.000'.replace(',','.')) viraria
 * 1 bag em silêncio (varredura de 04/09/2026); null = inválido.
 */
const parseBags = (texto: string): number | null => {
  const t = texto.trim()
  if (!/^\d+([.,]\d{1,2})?$/.test(t)) return null
  return Number(t.replace(',', '.'))
}

const fmtDif = (v: number): string =>
  `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}`

const COR_SITUACAO: Record<SituacaoInventario, 'ok' | 'alerta' | 'perigo' | 'info'> = {
  bate: 'ok',
  sobra: 'perigo',
  falta: 'perigo',
  nao_contado: 'alerta',
  fora_do_sap: 'info',
}

const ORDEM_CHIPS: SituacaoInventario[] = [
  'falta', 'sobra', 'fora_do_sap', 'nao_contado', 'bate',
]

const tituloSugerido = (): string => {
  const d = new Date()
  const p2 = (v: number) => String(v).padStart(2, '0')
  return `Inventário ${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`
}

export default function Inventario() {
  const { permitido } = useAuth()
  const podeAbrir = permitido('inventario', 'abrir')
  const podeLancar = permitido('inventario', 'contar') || podeAbrir

  const [erro, setErro] = useState('')
  const [carregando, setCarregando] = useState(true)
  // null = migração inventario.sql pendente
  const [invs, setInvs] = useState<api.InventarioLinha[] | null>([])
  const [selId, setSelId] = useState<string | null>(null)
  const [saldos, setSaldos] = useState<api.SaldoInventarioLinha[]>([])
  const [itens, setItens] = useState<api.ItemInventario[]>([])
  const [resultados, setResultados] = useState<api.ResultadoInventario[]>([])
  const [tratamentos, setTratamentos] = useState<string[]>([SEM_TSI])
  // fallback fixo: se o cadastro não carregar, o form manual segue utilizável
  const [embalagens, setEmbalagens] = useState<string[]>(['BG5M', 'MEIOBAG', 'SC10', 'SC20'])

  const sel = invs?.find((i) => i.id === selId) ?? null
  // espelho síncrono do selId: descarta resposta de fetch que chegou DEPOIS
  // de trocar de inventário (varredura de 04/09/2026 — o inventário B novo
  // aparecia com a contagem do A)
  const selIdRef = useRef(selId)
  selIdRef.current = selId

  const recarregar = useCallback(async () => {
    try {
      const lista = await api.listarInventarios()
      setInvs(lista)
      setErro('')
    } catch (e) {
      setErro((e as Error).message)
    } finally {
      setCarregando(false)
    }
  }, [])

  // cadastros pro lançamento manual: tratamento vem das receitas, embalagem
  // do cadastro (pedido do Arion, 04/09/2026)
  useEffect(() => {
    void recarregar()
    void (async () => {
      try {
        const [receitas, embs] = await Promise.all([listarReceitas(), listarEmbalagens()])
        setTratamentos([
          SEM_TSI,
          ...receitas.map((r) => r.nome.toUpperCase()).filter((n) => n !== SEM_TSI).sort(),
        ])
        setEmbalagens(embs.map((e) => e.codigo))
      } catch {
        // sem cadastro ao alcance o form manual segue com SEM TSI e texto livre
      }
    })()
  }, [recarregar])
  useRealtime(['inventarios', 'inventario_saldos', 'inventario_itens'], recarregar)

  const fechado = sel?.fechado_em != null
  const recarregarSelecionado = useCallback(async () => {
    const id = selId
    if (!id) return
    try {
      const [ls, li, lr] = await Promise.all([
        api.listarSaldosInventario(id),
        api.listarItensInventario(id),
        fechado ? api.listarResultadosInventario(id) : Promise.resolve([]),
      ])
      // o usuário trocou de inventário no meio do fetch — resposta velha fora
      if (selIdRef.current !== id) return
      setSaldos(ls)
      setItens(li)
      setResultados(lr)
    } catch (e) {
      if (selIdRef.current === id) setErro((e as Error).message)
    }
  }, [selId, fechado])

  useEffect(() => {
    setSaldos([])
    setItens([])
    setResultados([])
    void recarregarSelecionado()
  }, [recarregarSelecionado])
  useRealtime(['inventario_saldos', 'inventario_itens'], recarregarSelecionado, {
    ativo: !!selId,
  })

  // devolve se DEU CERTO: os formulários só limpam/fecham com true — limpar
  // antes da resposta perdia o que foi digitado quando o servidor recusava
  // (varredura de 04/09/2026)
  const acao = async (fn: () => Promise<void>): Promise<boolean> => {
    try {
      setErro('')
      await fn()
      await recarregar()
      await recarregarSelecionado()
      return true
    } catch (e) {
      setErro((e as Error).message)
      return false
    }
  }

  if (carregando) {
    return (
      <Pagina titulo="Inventário">
        <p className="text-sm text-stone-500">Carregando…</p>
      </Pagina>
    )
  }

  if (invs === null) {
    return (
      <Pagina titulo="Inventário">
        <Aviso gravidade="bloqueio">
          A migração <code>supabase/inventario.sql</code> ainda não rodou no banco — rode-a no
          SQL Editor do Supabase para liberar o inventário.
        </Aviso>
      </Pagina>
    )
  }

  return (
    <Pagina
      titulo="Inventário"
      descricao="Contagem física × estoque do SAP — o PCP insere a lista, o operador conta por endereço, e a conferência mostra o que bate. Nenhum saldo é ajustado."
    >
      {erro && <Erro>{erro}</Erro>}

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <ListaInventarios
          invs={invs}
          selId={selId}
          onSelecionar={setSelId}
          podeAbrir={podeAbrir}
          onCriar={(titulo) =>
            acao(async () => {
              const id = await api.criarInventario(titulo)
              setSelId(id)
            })
          }
        />

        {!sel ? (
          <Vazio>
            {invs.length === 0
              ? podeAbrir
                ? 'Nenhum inventário ainda — crie o primeiro ao lado e insira o estoque do SAP.'
                : 'Nenhum inventário ainda — peça ao PCP para criar um.'
              : 'Escolha um inventário ao lado.'}
          </Vazio>
        ) : (
          <DetalheInventario
            key={sel.id}
            inv={sel}
            saldos={saldos}
            itens={itens}
            resultados={resultados}
            tratamentos={tratamentos}
            embalagens={embalagens}
            podeAbrir={podeAbrir}
            podeLancar={podeLancar}
            onAcao={acao}
            aoExcluir={() => setSelId(null)}
          />
        )}
      </div>
    </Pagina>
  )
}

function ListaInventarios({
  invs, selId, onSelecionar, podeAbrir, onCriar,
}: {
  invs: api.InventarioLinha[]
  selId: string | null
  onSelecionar: (id: string) => void
  podeAbrir: boolean
  onCriar: (titulo: string) => void
}) {
  const [titulo, setTitulo] = useState('')
  return (
    <Cartao titulo="Inventários" semPadding className="self-start">
      {podeAbrir && (
        <form
          className="flex gap-2 border-b border-stone-200 p-3 dark:border-stone-800"
          onSubmit={(e) => {
            e.preventDefault()
            onCriar(titulo.trim() || tituloSugerido())
            setTitulo('')
          }}
        >
          <input
            value={titulo}
            onChange={(e) => setTitulo(e.target.value)}
            placeholder={tituloSugerido()}
            className={INPUT}
          />
          <Botao tipo="submit" variante="primario">Novo</Botao>
        </form>
      )}
      {invs.length === 0 ? (
        <p className="p-4 text-sm text-stone-500">Nenhum inventário criado.</p>
      ) : (
        <ul className="divide-y divide-stone-100 dark:divide-stone-800/60">
          {invs.map((i) => (
            <li key={i.id}>
              <button
                onClick={() => onSelecionar(i.id)}
                className={`flex w-full flex-col gap-1 px-3 py-2.5 text-left text-sm transition-colors ${
                  selId === i.id
                    ? 'bg-green-50 dark:bg-green-950/40'
                    : 'hover:bg-stone-50 dark:hover:bg-stone-800/60'
                }`}
              >
                <span className="font-medium">{i.titulo}</span>
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-500 dark:text-stone-400">
                  {dataHoraCurta(i.criado_em)}
                  <Tag cor={i.fechado_em ? 'ok' : 'alerta'}>
                    {i.fechado_em ? 'fechado' : 'em contagem'}
                  </Tag>
                  <span>
                    {inteiro(i.inventario_saldos?.[0]?.count ?? 0)} do SAP ·{' '}
                    {inteiro(i.inventario_itens?.[0]?.count ?? 0)} lançados
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Cartao>
  )
}

function DetalheInventario({
  inv, saldos, itens, resultados, tratamentos, embalagens, podeAbrir, podeLancar, onAcao, aoExcluir,
}: {
  inv: api.InventarioLinha
  saldos: api.SaldoInventarioLinha[]
  itens: api.ItemInventario[]
  resultados: api.ResultadoInventario[]
  tratamentos: string[]
  embalagens: string[]
  podeAbrir: boolean
  podeLancar: boolean
  onAcao: (fn: () => Promise<void>) => Promise<boolean>
  aoExcluir: () => void
}) {
  const aberto = inv.fechado_em == null

  /**
   * Aberto: comparação AO VIVO (contagem × lista do SAP). Fechado: a foto
   * congelada em inventario_resultados, reapresentada pelo MESMO
   * cruzamento — um caminho de código só.
   */
  const linhas = useMemo<LinhaInventario[]>(() => {
    if (aberto) return compararInventario(itens, saldos)
    return compararInventario(
      resultados
        .filter((r) => r.bags_contados != null)
        .map((r) => ({
          lote: r.lote, tratamento: r.tratamento, embalagem: r.embalagem,
          cultivar: r.cultivar, bags: r.bags_contados!,
        })),
      resultados
        .filter((r) => r.bags_sistema != null)
        .map((r) => ({
          lote: r.lote, tratamento: r.tratamento, embalagem: r.embalagem,
          cultivar: r.cultivar, bags: r.bags_sistema!,
        })),
    )
  }, [aberto, itens, saldos, resultados])

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Cartao
        titulo={
          <span className="flex items-center gap-2">
            {inv.titulo}
            <Tag cor={aberto ? 'alerta' : 'ok'}>{aberto ? 'em contagem' : 'fechado'}</Tag>
          </span>
        }
        acoes={
          podeAbrir ? (
            <>
              {aberto ? (
                <Botao
                  variante="primario"
                  disabled={itens.length === 0}
                  titulo="Congela a comparação com a lista e a contagem de agora — vira registro"
                  onClick={() =>
                    onAcao(async () => {
                      if (
                        !confirm(
                          'Fechar o inventário congela a comparação deste momento como registro. Fechar?',
                        )
                      )
                        return
                      await api.fecharInventario(inv.id)
                    })
                  }
                >
                  Fechar inventário
                </Botao>
              ) : (
                <Botao
                  titulo="Apaga o resultado congelado e libera a contagem de novo"
                  onClick={() =>
                    onAcao(async () => {
                      if (!confirm('Reabrir apaga o resultado congelado. Reabrir?')) return
                      await api.reabrirInventario(inv.id)
                    })
                  }
                >
                  Reabrir
                </Botao>
              )}
              <Botao
                variante="perigo"
                onClick={() =>
                  onAcao(async () => {
                    if (
                      !confirm(
                        `Excluir "${inv.titulo}" apaga a lista do SAP e a contagem inteira (${itens.length} lançamento(s)). Excluir?`,
                      )
                    )
                      return
                    await api.excluirInventario(inv.id)
                    aoExcluir()
                  })
                }
              >
                Excluir
              </Botao>
            </>
          ) : undefined
        }
      >
        <p className="text-xs text-stone-500 dark:text-stone-400">
          Criado em {dataHoraCurta(inv.criado_em)}
          {inv.fechado_em && ` · fechado em ${dataHoraCurta(inv.fechado_em)}`}
          {` · lista do SAP com ${inteiro(saldos.length)} combinação(ões)`}
        </p>
      </Cartao>

      {aberto && podeAbrir && (
        <EstoqueSapCartao inv={inv} saldos={saldos} onAcao={onAcao} />
      )}

      {aberto && podeLancar && (
        <ContagemCartao
          inv={inv}
          saldos={saldos}
          itens={itens}
          tratamentos={tratamentos}
          embalagens={embalagens}
          podeAbrir={podeAbrir}
          onAcao={onAcao}
        />
      )}

      <ConferenciaCartao inv={inv} linhas={linhas} aberto={aberto} />
    </div>
  )
}

// ================================================================
// Estoque do SAP (ação `abrir`): upload da mesma planilha do mapa
// ================================================================

function EstoqueSapCartao({
  inv, saldos, onAcao,
}: {
  inv: api.InventarioLinha
  saldos: api.SaldoInventarioLinha[]
  onAcao: (fn: () => Promise<void>) => Promise<boolean>
}) {
  const [previa, setPrevia] = useState<ResultadoEstoqueInventario | null>(null)
  const [erroLocal, setErroLocal] = useState('')
  const [gravando, setGravando] = useState(false)
  const itensExistem = (inv.inventario_itens?.[0]?.count ?? 0) > 0

  async function lerPlanilha(ev: ChangeEvent<HTMLInputElement>) {
    const arquivo = ev.target.files?.[0]
    ev.target.value = ''
    if (!arquivo) return
    setErroLocal('')
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
          'Não parece o export de saldo do SAP — esperava as colunas "Nº do Lote", "Qtd em Estoque", "Destinação" e "Depósito" (a mesma planilha do Mapa).',
        )
      }
      setPrevia(converterEstoqueInventario(linhas))
    } catch (e) {
      setErroLocal(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Cartao
      titulo="Estoque do SAP (a referência da contagem)"
      acoes={
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-stone-300 px-3 py-2 text-sm font-medium hover:bg-stone-100 sm:py-1.5 dark:border-stone-700 dark:hover:bg-stone-800">
          Inserir planilha do SAP (.xlsx)
          <input type="file" accept=".xlsx,.xls" className="hidden" onChange={lerPlanilha} />
        </label>
      }
    >
      {erroLocal && <Erro>{erroLocal}</Erro>}
      {previa ? (
        <>
          <Aviso gravidade="alerta">
            <b>Prévia — nada foi gravado ainda.</b> {inteiro(previa.saldos.length)} combinação(ões)
            do VEN_GER ({inteiro(previa.brancos)} branca(s) + {inteiro(previa.tratados)} tratada(s),{' '}
            {fmtBg(previa.totalBags)} bags)
            {saldos.length > 0 && (
              <> — <b>substitui</b> a lista atual de {inteiro(saldos.length)} combinação(ões)</>
            )}
            . Fora: {inteiro(previa.outrosDepositos)} de outros depósitos, {inteiro(previa.zerados)}{' '}
            zerados, {inteiro(previa.granel)} granel/pré-lote
            {previa.negativos > 0 && (
              <>
                {' '}
                e <b className="text-red-700 dark:text-red-400">{inteiro(previa.negativos)} com
                saldo NEGATIVO no SAP</b> (anomalia — confira lá)
              </>
            )}
            .
          </Aviso>
          {itensExistem && (
            <div className="mt-2">
              <Aviso>
                Já existem lançamentos de contagem neste inventário — eles NÃO são apagados;
                combinação lançada que sair da lista nova passa a aparecer como “Fora do SAP”
                na conferência.
              </Aviso>
            </div>
          )}
          <div className="mt-3 flex gap-2">
            <Botao
              variante="primario"
              disabled={gravando}
              onClick={() => {
                setGravando(true)
                void onAcao(async () => {
                  await api.substituirSaldosInventario(inv.id, previa.saldos)
                  setPrevia(null)
                }).finally(() => setGravando(false))
              }}
            >
              {gravando ? 'Gravando…' : 'Confirmar e gravar a lista'}
            </Botao>
            <Botao onClick={() => setPrevia(null)}>Cancelar</Botao>
          </div>
        </>
      ) : saldos.length === 0 ? (
        <p className="text-sm text-stone-500 dark:text-stone-400">
          Nenhuma lista inserida ainda — suba o export de saldo do SAP (a mesma planilha do
          Mapa). A contagem só começa depois disso.
        </p>
      ) : (
        <p className="text-sm text-stone-500 dark:text-stone-400">
          Lista inserida: <b>{inteiro(saldos.length)}</b> combinação(ões) lote + tratamento +
          embalagem. Subir a planilha de novo <b>substitui</b> a lista inteira.
        </p>
      )}
    </Cartao>
  )
}

// ================================================================
// Contagem (ação `contar`): lançamentos por endereço, contagem cega
// ================================================================

interface FormLancamento {
  lote: string
  tratamento: string
  cultivar: string
  embalagem: string
  armazem: string
  bloco: string
  quadra: string
  bags: string
}

const FORM_VAZIO: FormLancamento = {
  lote: '', tratamento: SEM_TSI, cultivar: '', embalagem: '',
  armazem: '', bloco: '', quadra: '', bags: '',
}

function ContagemCartao({
  inv, saldos, itens, tratamentos, embalagens, podeAbrir, onAcao,
}: {
  inv: api.InventarioLinha
  saldos: api.SaldoInventarioLinha[]
  itens: api.ItemInventario[]
  tratamentos: string[]
  embalagens: string[]
  podeAbrir: boolean
  onAcao: (fn: () => Promise<void>) => Promise<boolean>
}) {
  const [busca, setBusca] = useState('')
  // combinação da lista escolhida pra lançar (chave), ou 'manual'
  const [lancandoEm, setLancandoEm] = useState<string | null>(null)
  const [editando, setEditando] = useState<api.ItemInventario | null>(null)

  const lancamentosPor = useMemo(() => {
    const c = new Map<string, number>()
    for (const i of itens) {
      const chave = chaveInventario(i.lote, i.tratamento, i.embalagem)
      c.set(chave, (c.get(chave) ?? 0) + 1)
    }
    return c
  }, [itens])

  // cultivares do lançamento manual: SÓ os da planilha do SAP inserida
  // (pedido do Arion, 04/09/2026)
  const cultivares = useMemo(
    () => [...new Set(saldos.map((s) => s.cultivar).filter(Boolean))].sort(),
    [saldos],
  )

  const visiveis = useMemo(() => {
    const q = busca.trim().toLowerCase()
    if (!q) return saldos
    return saldos.filter((s) =>
      [s.cultivar, s.lote, s.tratamento, s.embalagem].some((v) =>
        v.toLowerCase().includes(q),
      ),
    )
  }, [saldos, busca])

  if (saldos.length === 0) {
    return (
      <Cartao titulo="Contagem">
        <Aviso>
          A lista do SAP ainda não foi inserida neste inventário
          {podeAbrir ? ' — suba a planilha no cartão acima.' : ' — peça ao PCP para inserir.'}{' '}
          A contagem começa depois disso.
        </Aviso>
      </Cartao>
    )
  }

  const salvarLancamento = async (
    item: api.NovoItemInventario,
    idEdicao: string | null,
  ): Promise<boolean> => {
    const ok = await onAcao(async () => {
      if (idEdicao) await api.atualizarItemInventario(idEdicao, item)
      else await api.adicionarItemInventario(inv.id, item)
    })
    if (ok) setEditando(null)
    return ok
  }

  return (
    <Cartao titulo={`Contagem — ${itens.length} lançamento(s)`}>
      <p className="mb-3 text-xs text-stone-500 dark:text-stone-400">
        Ache a combinação na lista e lance <b>endereço + quantidade</b> — um lançamento por
        endereço; a conferência soma. Contagem cega: a quantidade do SAP não aparece aqui.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar cultivar, lote, tratamento…"
          className={`${INPUT} max-w-sm`}
        />
        <Botao
          onClick={() => {
            setEditando(null)
            setLancandoEm(lancandoEm === 'manual' ? null : 'manual')
          }}
          titulo="Achou no galpão algo que não está na lista do SAP"
        >
          Não está na lista
        </Botao>
      </div>

      {lancandoEm === 'manual' && !editando && (
        <div className="mt-3">
          <FormLancamentoManual
            tratamentos={tratamentos}
            cultivares={cultivares}
            embalagens={embalagens}
            aoSalvar={async (item) => {
              const ok = await salvarLancamento(item, null)
              if (ok) setLancandoEm(null)
              return ok
            }}
            aoCancelar={() => setLancandoEm(null)}
          />
        </div>
      )}

      <div className="mt-3 max-h-80 overflow-y-auto rounded-lg border border-stone-200 dark:border-stone-800">
        <ul className="divide-y divide-stone-100 dark:divide-stone-800/60">
          {visiveis.map((s) => {
            const chave = chaveInventario(s.lote, s.tratamento, s.embalagem)
            const qtd = lancamentosPor.get(chave) ?? 0
            const abertoAqui = lancandoEm === chave
            return (
              <li key={s.id}>
                <button
                  onClick={() => {
                    setEditando(null)
                    setLancandoEm(abertoAqui ? null : chave)
                  }}
                  className={`flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-sm transition-colors ${
                    abertoAqui
                      ? 'bg-green-50 dark:bg-green-950/40'
                      : 'hover:bg-stone-50 dark:hover:bg-stone-800/60'
                  }`}
                >
                  <span className="font-medium">{s.cultivar}</span>
                  <span className="font-mono text-xs">{s.lote}</span>
                  <Tag cor={s.tratamento === SEM_TSI ? 'neutro' : 'info'}>{s.tratamento}</Tag>
                  <span className="text-xs text-stone-500">{s.embalagem}</span>
                  {qtd > 0 && (
                    <Tag cor="ok" className="ml-auto">✓ {qtd} lançamento(s)</Tag>
                  )}
                </button>
                {abertoAqui && !editando && (
                  <div className="border-t border-stone-100 bg-stone-50/60 px-3 py-3 dark:border-stone-800/60 dark:bg-stone-800/30">
                    <FormEnderecoQuantidade
                      aoSalvar={(campos) =>
                        salvarLancamento(
                          {
                            lote: loteBaseMaiusculo(s.lote),
                            tratamento: s.tratamento.trim().toUpperCase(),
                            cultivar: s.cultivar,
                            embalagem: s.embalagem.trim().toUpperCase(),
                            fora_da_lista: false,
                            ...campos,
                          },
                          null,
                        )
                      }
                    />
                  </div>
                )}
              </li>
            )
          })}
          {visiveis.length === 0 && (
            <li className="px-3 py-4 text-center text-sm text-stone-500">
              Nada na lista do SAP com essa busca — se achou no galpão, use “Não está na lista”.
            </li>
          )}
        </ul>
      </div>

      {editando && (
        <div className="mt-3">
          {editando.fora_da_lista ? (
            // key: trocar de item em edição REMONTA o formulário — sem isso
            // ele mantinha os valores do item anterior e salvava no novo id
            // (varredura de 04/09/2026)
            <FormLancamentoManual
              key={editando.id}
              titulo={`Editando lançamento fora da lista — ${editando.lote}`}
              tratamentos={tratamentos}
              cultivares={cultivares}
              embalagens={embalagens}
              inicial={editando}
              aoSalvar={(item) => salvarLancamento(item, editando.id)}
              aoCancelar={() => setEditando(null)}
            />
          ) : (
            <Cartao
              titulo={`Editando lançamento — ${editando.cultivar ?? ''} · ${editando.lote} · ${editando.tratamento}`}
            >
              <FormEnderecoQuantidade
                key={editando.id}
                inicial={editando}
                rotuloSalvar="Salvar alterações"
                aoCancelar={() => setEditando(null)}
                aoSalvar={(campos) =>
                  salvarLancamento(
                    {
                      lote: editando.lote,
                      tratamento: editando.tratamento,
                      cultivar: editando.cultivar,
                      embalagem: editando.embalagem,
                      fora_da_lista: false,
                      ...campos,
                    },
                    editando.id,
                  )
                }
              />
            </Cartao>
          )}
        </div>
      )}

      {itens.length > 0 && (
        <div className="mt-4">
          <Tabela cabecalho={['Lote', 'Tratamento', 'Emb.', 'Endereço', '#Bags', 'Hora', '']}>
            {itens.map((i) => (
              <tr key={i.id} className="border-t border-stone-100 dark:border-stone-800/60">
                <td className="px-2 py-1.5 font-mono text-xs">
                  {i.lote}
                  {i.fora_da_lista && (
                    <Tag cor="info" className="ml-1.5">fora da lista</Tag>
                  )}
                </td>
                <td className="px-2 py-1.5">{i.tratamento}</td>
                <td className="px-2 py-1.5 text-xs">{i.embalagem}</td>
                <td className="px-2 py-1.5 text-xs">{enderecoLote(i)}</td>
                <td className="px-2 py-1.5 text-right">{fmtBg(i.bags)}</td>
                <td className="px-2 py-1.5 text-xs text-stone-500">{dataHoraCurta(i.criado_em)}</td>
                <td className="px-2 py-1.5">
                  <div className="flex justify-end gap-1">
                    <button
                      onClick={() => {
                        setLancandoEm(null)
                        setEditando(i)
                      }}
                      title="Editar este lançamento"
                      className="rounded px-2 py-1 text-xs text-stone-500 underline-offset-2 hover:underline dark:text-stone-400"
                    >
                      editar
                    </button>
                    {/* por extenso e em vermelho: o "×" cinza passava batido
                        e o Arion achou que excluir não existia (05/09/2026) */}
                    <button
                      onClick={() =>
                        onAcao(async () => {
                          if (!confirm(`Excluir o lançamento de ${i.lote} (${fmtBg(i.bags)} bg)?`)) return
                          await api.removerItemInventario(i.id)
                          if (editando?.id === i.id) setEditando(null)
                        })
                      }
                      title="Excluir este lançamento"
                      className="rounded px-2 py-1 text-xs text-red-600 underline-offset-2 hover:underline dark:text-red-400"
                    >
                      excluir
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </Tabela>
        </div>
      )}
    </Cartao>
  )
}

/** Endereço (Armazém/Bloco/Quadra, como no mapa) + quantidade. */
function FormEnderecoQuantidade({
  inicial, rotuloSalvar = 'Adicionar', aoSalvar, aoCancelar,
}: {
  inicial?: { armazem: string | null; bloco: string | null; quadra: string | null; bags: number }
  rotuloSalvar?: string
  aoSalvar: (campos: {
    armazem: string | null
    bloco: string | null
    quadra: string | null
    bags: number
  }) => Promise<boolean>
  aoCancelar?: () => void
}) {
  const [armazem, setArmazem] = useState(inicial?.armazem ?? '')
  const [bloco, setBloco] = useState(inicial?.bloco ?? '')
  const [quadra, setQuadra] = useState(inicial?.quadra ?? '')
  const [bags, setBags] = useState(inicial ? String(inicial.bags).replace('.', ',') : '')
  const [salvando, setSalvando] = useState(false)

  const bagsNum = parseBags(bags)
  const valido = armazem.trim() !== '' && bagsNum != null

  return (
    <form
      className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_110px_auto]"
      onSubmit={(e) => {
        e.preventDefault()
        if (!valido || salvando) return
        setSalvando(true)
        void (async () => {
          // limpa SÓ depois do servidor confirmar — limpar antes perdia a
          // digitação quando a gravação era recusada (varredura 04/09/2026)
          const ok = await aoSalvar({
            armazem: armazem.trim().toUpperCase(),
            bloco: bloco.trim().toUpperCase() || null,
            quadra: quadra.trim().toUpperCase() || null,
            bags: bagsNum!,
          })
          setSalvando(false)
          if (ok && !inicial) {
            setBloco('')
            setQuadra('')
            setBags('')
          }
        })()
      }}
    >
      <div>
        <label className={ROTULO_CAMPO}>Armazém *</label>
        <input value={armazem} onChange={(e) => setArmazem(e.target.value)} className={INPUT} />
      </div>
      <div>
        <label className={ROTULO_CAMPO}>Bloco</label>
        <input value={bloco} onChange={(e) => setBloco(e.target.value)} className={INPUT} />
      </div>
      <div>
        <label className={ROTULO_CAMPO}>Quadra</label>
        <input value={quadra} onChange={(e) => setQuadra(e.target.value)} className={INPUT} />
      </div>
      <div>
        <label className={ROTULO_CAMPO}>Bags *</label>
        <input
          value={bags}
          onChange={(e) => setBags(e.target.value)}
          inputMode="decimal"
          placeholder="0"
          title="Inteiro ou com vírgula (até 2 casas) — sem ponto de milhar"
          className={INPUT}
        />
      </div>
      <div className="flex items-end gap-2">
        <Botao tipo="submit" variante="primario" disabled={!valido || salvando}>
          {salvando ? 'Gravando…' : rotuloSalvar}
        </Botao>
        {aoCancelar && <Botao onClick={aoCancelar}>Cancelar</Botao>}
      </div>
    </form>
  )
}

/** Lançamento manual completo — achado no galpão fora da lista do SAP. */
function FormLancamentoManual({
  titulo = 'Fora da lista do SAP — lançamento manual',
  tratamentos, cultivares, embalagens, inicial, aoSalvar, aoCancelar,
}: {
  titulo?: string
  tratamentos: string[]
  cultivares: string[]
  embalagens: string[]
  inicial?: api.ItemInventario
  aoSalvar: (item: api.NovoItemInventario) => Promise<boolean>
  aoCancelar: () => void
}) {
  const [f, setF] = useState<FormLancamento>(
    inicial
      ? {
          lote: inicial.lote,
          tratamento: inicial.tratamento,
          cultivar: inicial.cultivar ?? '',
          embalagem: inicial.embalagem,
          armazem: inicial.armazem ?? '',
          bloco: inicial.bloco ?? '',
          quadra: inicial.quadra ?? '',
          bags: String(inicial.bags).replace('.', ','),
        }
      : { ...FORM_VAZIO, embalagem: embalagens[0] ?? '' },
  )
  const [salvando, setSalvando] = useState(false)
  const muda = (campo: keyof FormLancamento) => (v: string) =>
    setF((atual) => ({ ...atual, [campo]: v }))

  const bagsNum = parseBags(f.bags)
  const valido =
    f.lote.trim() !== '' && f.tratamento.trim() !== '' && f.cultivar.trim() !== '' &&
    f.embalagem.trim() !== '' && f.armazem.trim() !== '' && bagsNum != null

  return (
    <Cartao titulo={titulo}>
      <form
        className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault()
          if (!valido || salvando) return
          setSalvando(true)
          // quem fecha o cartão no sucesso é o dono (aoSalvar devolve ok);
          // em erro o formulário fica como está, sem perder a digitação
          void aoSalvar({
            lote: loteBaseMaiusculo(f.lote),
            tratamento: f.tratamento.trim().toUpperCase(),
            cultivar: f.cultivar.trim(),
            embalagem: f.embalagem.trim().toUpperCase(),
            armazem: f.armazem.trim().toUpperCase(),
            bloco: f.bloco.trim().toUpperCase() || null,
            quadra: f.quadra.trim().toUpperCase() || null,
            bags: bagsNum!,
            fora_da_lista: true,
          }).finally(() => setSalvando(false))
        }}
      >
        <div>
          <label className={ROTULO_CAMPO}>Lote *</label>
          <input
            value={f.lote}
            onChange={(e) => muda('lote')(e.target.value)}
            placeholder="SV0891056060482"
            className={INPUT}
          />
        </div>
        <div>
          <label className={ROTULO_CAMPO}>Cultivar * (da planilha do SAP)</label>
          <select
            value={f.cultivar}
            onChange={(e) => muda('cultivar')(e.target.value)}
            className={INPUT}
          >
            <option value="">—</option>
            {cultivares.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className={ROTULO_CAMPO}>Tratamento * (do cadastro)</label>
          <select
            value={f.tratamento}
            onChange={(e) => muda('tratamento')(e.target.value)}
            className={INPUT}
          >
            {tratamentos.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className={ROTULO_CAMPO}>Embalagem *</label>
          <select
            value={f.embalagem}
            onChange={(e) => muda('embalagem')(e.target.value)}
            className={INPUT}
          >
            <option value="">—</option>
            {embalagens.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className={ROTULO_CAMPO}>Armazém *</label>
          <input value={f.armazem} onChange={(e) => muda('armazem')(e.target.value)} className={INPUT} />
        </div>
        <div>
          <label className={ROTULO_CAMPO}>Bloco</label>
          <input value={f.bloco} onChange={(e) => muda('bloco')(e.target.value)} className={INPUT} />
        </div>
        <div>
          <label className={ROTULO_CAMPO}>Quadra</label>
          <input value={f.quadra} onChange={(e) => muda('quadra')(e.target.value)} className={INPUT} />
        </div>
        <div>
          <label className={ROTULO_CAMPO}>Bags *</label>
          <input
            value={f.bags}
            onChange={(e) => muda('bags')(e.target.value)}
            inputMode="decimal"
            placeholder="0"
            className={INPUT}
          />
        </div>
        <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
          <Botao tipo="submit" variante="primario" disabled={!valido || salvando}>
            {salvando ? 'Gravando…' : inicial ? 'Salvar alterações' : 'Adicionar fora da lista'}
          </Botao>
          <Botao onClick={aoCancelar}>Cancelar</Botao>
        </div>
      </form>
    </Cartao>
  )
}

// ================================================================
// Conferência: contado × SAP, com filtro por situação e CSV
// ================================================================

function ConferenciaCartao({
  inv, linhas, aberto,
}: {
  inv: api.InventarioLinha
  linhas: LinhaInventario[]
  aberto: boolean
}) {
  const [busca, setBusca] = useState('')
  const [filtro, setFiltro] = useState<Set<SituacaoInventario>>(new Set())

  const porSituacao = useMemo(() => {
    const c = new Map<SituacaoInventario, number>()
    for (const l of linhas) c.set(l.situacao, (c.get(l.situacao) ?? 0) + 1)
    return c
  }, [linhas])

  const contadas = linhas.filter((l) => l.contado != null)
  const acuracidade =
    contadas.length === 0
      ? null
      : Math.round((contadas.filter((l) => l.situacao === 'bate').length / contadas.length) * 100)

  const visiveis = linhas.filter((l) => {
    if (filtro.size > 0 && !filtro.has(l.situacao)) return false
    const q = busca.trim().toLowerCase()
    if (!q) return true
    return [l.cultivar ?? '', l.lote, l.tratamento, l.embalagem].some((v) =>
      v.toLowerCase().includes(q),
    )
  })

  const alternarChip = (s: SituacaoInventario) =>
    setFiltro((f) => {
      const novo = new Set(f)
      if (novo.has(s)) novo.delete(s)
      else novo.add(s)
      return novo
    })

  return (
    <Cartao
      titulo={
        aberto
          ? 'Conferência — ao vivo (contagem × lista do SAP até agora)'
          : 'Conferência — resultado congelado no fechamento'
      }
      acoes={
        <Botao
          disabled={linhas.length === 0}
          onClick={() =>
            exportarCsv(`inventario-${inv.titulo.replace(/[^\p{L}\p{N}]+/gu, '-')}`, [
              ['Situação', 'Cultivar', 'Lote', 'Tratamento', 'Embalagem', 'Contado (bg)', 'SAP (bg)', 'Diferença (bg)'],
              ...linhas.map((l) => [
                ROTULO_SITUACAO[l.situacao],
                l.cultivar ?? '',
                l.lote,
                l.tratamento,
                l.embalagem,
                l.contado ?? '',
                l.sistema ?? '',
                l.diferenca,
              ]),
            ])
          }
        >
          Exportar CSV
        </Botao>
      }
    >
      {linhas.length === 0 ? (
        <Vazio>Nada pra comparar ainda — insira a lista do SAP e lance a contagem.</Vazio>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {ORDEM_CHIPS.map((s) => {
              const qtd = porSituacao.get(s) ?? 0
              const ativo = filtro.has(s)
              return (
                <button
                  key={s}
                  onClick={() => alternarChip(s)}
                  // chip ATIVO nunca desabilita: se a situação zerar com o
                  // filtro ligado, ainda dá pra desligá-lo (varredura 04/09)
                  disabled={qtd === 0 && !ativo}
                  title="Clique pra filtrar por esta situação"
                  className={`rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${
                    ativo
                      ? 'border-green-700 bg-green-900 text-white dark:bg-green-700'
                      : 'border-stone-300 hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800'
                  }`}
                >
                  {ROTULO_SITUACAO[s]} <b>{qtd}</b>
                </button>
              )
            })}
            {acuracidade != null && (
              <span className="ml-auto text-xs text-stone-500 dark:text-stone-400">
                Acuracidade das contadas: <b>{acuracidade}%</b>
              </span>
            )}
          </div>

          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar cultivar, lote, tratamento…"
            className={`${INPUT} mb-3 max-w-sm`}
          />

          <Tabela
            cabecalho={['Situação', 'Cultivar', 'Lote', 'Tratamento', 'Emb.', '#Contado', '#SAP', '#Diferença']}
          >
            {visiveis.map((l) => (
              <tr
                key={`${l.lote}|${l.tratamento}|${l.embalagem}`}
                className="border-t border-stone-100 dark:border-stone-800/60"
              >
                <td className="px-2 py-1.5">
                  <Tag cor={COR_SITUACAO[l.situacao]}>{ROTULO_SITUACAO[l.situacao]}</Tag>
                </td>
                <td className="px-2 py-1.5">{l.cultivar ?? '—'}</td>
                <td className="px-2 py-1.5 font-mono text-xs">{l.lote}</td>
                <td className="px-2 py-1.5">{l.tratamento}</td>
                <td className="px-2 py-1.5 text-xs">{l.embalagem}</td>
                <td className="px-2 py-1.5 text-right">{fmtBg(l.contado)}</td>
                <td className="px-2 py-1.5 text-right">{fmtBg(l.sistema)}</td>
                <td
                  className={`px-2 py-1.5 text-right font-medium ${
                    l.situacao === 'bate'
                      ? 'text-stone-400'
                      : l.situacao === 'nao_contado'
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-red-600 dark:text-red-400'
                  }`}
                >
                  {fmtDif(l.diferenca)}
                </td>
              </tr>
            ))}
          </Tabela>
          {visiveis.length === 0 && (
            <p className="mt-3 text-center text-sm text-stone-500">
              Nenhuma linha com esse filtro.
            </p>
          )}
        </>
      )}
    </Cartao>
  )
}
