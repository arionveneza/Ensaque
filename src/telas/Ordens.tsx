import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react'
import readXlsxFile from 'read-excel-file/browser'
import * as api from '@/dados/api'
import * as g from '@/dados/api-gestao'
import type { BalancoLinha, LoteSementeLinha, OrdemVisao, ReceitaCompleta } from '@/dados/api-gestao'
import {
  converterPedidos, converterSaldos, ehRelatorioPedidos, ehRelatorioSaldos,
  type Linha, type ResultadoPedidos, type ResultadoSaldos,
} from '@/dominio/importacao/simpleagro'
import {
  converterOrdens, ehPlanilhaDeOrdens, type ResultadoOrdens,
} from '@/dominio/importacao/ordens'
import { exportarXlsx, imprimirTabela } from '@/lib/exportar'
import { useRealtime } from '@/dados/useRealtime'
import { analisaDemanda, podeCriarOrdem } from '@/dominio/balanco'
import { pode } from '@/dominio/status'
import type { StatusEfetivo } from '@/dominio/tipos'
import { useAuth } from '@/auth/AuthProvider'
import {
  Aviso, Botao, Cartao, Erro, Pagina, Tabela, Tag, Vazio,
  corDoStatus, diaCurto, enderecoLote, inteiro, n,
} from '@/componentes/ui'

const SA_BASE = 'https://sementesveneza.painel.simpleagro.com.br:3333'
const SA_PEDIDOS = `${SA_BASE}/sales/relatorios/pedidos-analitico-resumido`
const SA_SALDOS = `${SA_BASE}/work/saldos`

/** Documentação do layout, exibida na tela e usada para gerar o modelo. */
const LAYOUT_ORDENS: { coluna: string; obrigatoria: boolean; obs: string }[] = [
  { coluna: 'Ordem', obrigatoria: true, obs: 'Nº da ordem. Aceita também Numero, Nº Ordem, Pedido ou OP.' },
  { coluna: 'Lote', obrigatoria: true, obs: 'Lote de semente já cadastrado. Define o cultivar e o peso do bag.' },
  { coluna: 'Tratamento', obrigatoria: true, obs: 'Nome da receita, exatamente como cadastrada. Aceita Receita.' },
  { coluna: 'Embalagem', obrigatoria: true, obs: 'BG5M ou MEIOBAG.' },
  { coluna: 'Bags', obrigatoria: true, obs: 'Quantidade, maior que zero. Aceita Quantidade ou Qtd.' },
  { coluna: 'Cliente', obrigatoria: false, obs: 'Só informativo, aparece na ordem.' },
  { coluna: 'Obs', obrigatoria: false, obs: 'Observação de processo, ex.: SEM GRAFITE. Aparece destacada no apontamento.' },
  { coluna: 'Armazém', obrigatoria: false, obs: 'Onde buscar o lote, ex.: ARMAZEM C. Aceita Deposito.' },
  { coluna: 'Bloco', obrigatoria: false, obs: 'Ex.: BL01. Aceita BL.' },
  { coluna: 'Quadra', obrigatoria: false, obs: 'Ex.: QD04. Aceita QD.' },
  { coluna: 'Maquina', obrigatoria: false, obs: 'TSI1 ou TSI2. Em branco, a ordem cai no pool para programar depois.' },
  { coluna: 'Dia', obrigatoria: false, obs: 'Data da programação, em 28/07/2026 ou 2026-07-28.' },
]

/**
 * Gera a planilha de exemplo com dados reais do cadastro, para o arquivo já
 * importar sem erro em vez de esbarrar em lote ou receita inexistente.
 */
async function baixarModeloOrdens(
  lotes: LoteSementeLinha[],
  receitas: ReceitaCompleta[],
  embalagens: g.EmbalagemLinha[],
  maquinas: api.LinhaMaquina[],
): Promise<void> {
  const lote = lotes[0]?.id ?? 'L-0001'
  const outroLote = lotes[1]?.id ?? lote
  const receita = receitas[0]?.nome ?? 'FTZ60'
  const emb = embalagens[0]?.codigo ?? 'BG5M'
  const maquina = maquinas[0]?.id ?? 'TSI1'
  const hoje = new Date().toISOString().slice(0, 10)

  await exportarXlsx(
    'modelo-ordens',
    LAYOUT_ORDENS.map((c) => ({
      titulo: c.coluna,
      largura: c.coluna === 'Obs' || c.coluna === 'Cliente' ? 28 : 16,
      tipo: c.coluna === 'Bags' ? 'numero' : 'texto',
      casas: 0,
    })),
    [
      // programada, com endereço completo
      ['79500-1', lote, receita, emb, 45, 'CLIENTE EXEMPLO', '',
        'ARMAZEM C', 'BL01', 'QD04', maquina, hoje],
      // no pool e sem endereço: a logística preenche na separação
      ['79500-2', outroLote, receita, emb, 30, '', 'SEM GRAFITE', '', '', '', '', ''],
    ],
  )
}

export default function Ordens() {
  const { usuario } = useAuth()
  const podeEditar = usuario?.perfil === 'PCP' || usuario?.perfil === 'Gestor'

  const [ordens, setOrdens] = useState<OrdemVisao[]>([])
  const [lotes, setLotes] = useState<LoteSementeLinha[]>([])
  const [receitas, setReceitas] = useState<ReceitaCompleta[]>([])
  const [embalagens, setEmbalagens] = useState<g.EmbalagemLinha[]>([])
  const [maquinas, setMaquinas] = useState<api.LinhaMaquina[]>([])
  const [balanco, setBalanco] = useState<BalancoLinha[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const [busca, setBusca] = useState('')
  const [filtroStatus, setFiltroStatus] = useState('')
  const [filtroMaquina, setFiltroMaquina] = useState('')

  const [previaPedidos, setPreviaPedidos] = useState<ResultadoPedidos | null>(null)
  const [previaSaldos, setPreviaSaldos] = useState<ResultadoSaldos | null>(null)
  const [previaOrdens, setPreviaOrdens] = useState<ResultadoOrdens | null>(null)

  const recarregar = useCallback(async () => {
    const [o, b] = await Promise.all([g.listarOrdens(), g.listarBalanco()])
    setOrdens(o)
    setBalanco(b)
  }, [])

  useEffect(() => {
    let vivo = true
    setCarregando(true)
    Promise.all([
      g.listarOrdens(), g.listarLotes(), g.listarReceitas(),
      g.listarEmbalagens(), api.carregarCadastros(), g.listarBalanco(),
    ])
      .then(([o, l, r, e, c, b]) => {
        if (!vivo) return
        setOrdens(o); setLotes(l); setReceitas(r)
        setEmbalagens(e); setMaquinas(c.maquinas); setBalanco(b)
      })
      .catch((x) => vivo && setErro(x instanceof Error ? x.message : String(x)))
      .finally(() => vivo && setCarregando(false))
    return () => { vivo = false }
  }, [])

  useRealtime(['ordens', 'lotes_semente', 'pedidos_venda', 'estoque_pa'], recarregar)

  async function comErro(fn: () => Promise<void>) {
    try {
      setErro(null); setMsg(null)
      await fn()
      await recarregar()
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }

  // ---------------- importação de planilha ----------------
  async function lerArquivo(ev: ChangeEvent<HTMLInputElement>) {
    const arquivo = ev.target.files?.[0]
    if (!arquivo) return
    setErro(null); setMsg(null)
    setPreviaPedidos(null); setPreviaSaldos(null); setPreviaOrdens(null)
    try {
      const bruto = (await readXlsxFile(arquivo)) as unknown
      const arr = bruto as { data?: Linha[] }[]
      const rows: Linha[] =
        Array.isArray(arr) && arr.length > 0 && !Array.isArray(arr[0]) && Array.isArray(arr[0]?.data)
          ? (arr[0].data as Linha[])
          : (bruto as Linha[])

      if (ehRelatorioPedidos(rows)) {
        setPreviaPedidos(converterPedidos(rows, receitas.map((r) => r.nome)))
      } else if (ehRelatorioSaldos(rows)) {
        setPreviaSaldos(converterSaldos(rows))
      } else if (ehPlanilhaDeOrdens(rows)) {
        setPreviaOrdens(
          converterOrdens(rows, {
            lotesConhecidos: new Set(lotes.map((l) => l.id)),
            receitasConhecidas: new Set(receitas.map((r) => r.nome.toUpperCase())),
            embalagensConhecidas: new Set(embalagens.map((e) => e.codigo)),
            maquinasConhecidas: new Set(maquinas.map((m) => m.id)),
          }),
        )
      } else {
        setErro(
          'Planilha não reconhecida. Esperado o "Pedidos Analítico Resumido", a exportação de ' +
            '"Saldos" da SimpleAgro, ou uma planilha de ordens com as colunas Ordem, Lote, ' +
            'Tratamento, Embalagem e Bags.',
        )
      }
    } catch (e) {
      setErro(`Não consegui ler o arquivo: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      ev.target.value = ''
    }
  }

  // ---------------- filtros ----------------
  const filtradas = useMemo(() => {
    const termo = busca.trim().toLowerCase()
    return ordens.filter((o) => {
      if (filtroStatus && o.status_efetivo !== filtroStatus) return false
      if (filtroMaquina && o.maquina_id !== filtroMaquina) return false
      if (!termo) return true
      return [o.numero, o.cultivar, o.receita_nome, o.lote_id, o.cliente ?? '']
        .join(' ')
        .toLowerCase()
        .includes(termo)
    })
  }, [ordens, busca, filtroStatus, filtroMaquina])

  const porDia = useMemo(() => {
    const mapa = new Map<string, OrdemVisao[]>()
    for (const o of filtradas) {
      const chave = o.data_prog ?? 'sem-dia'
      const lista = mapa.get(chave)
      if (lista) lista.push(o)
      else mapa.set(chave, [o])
    }
    return [...mapa.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [filtradas])

  const statusDisponiveis = useMemo(
    () => [...new Set(ordens.map((o) => o.status_efetivo))].sort(),
    [ordens],
  )

  if (carregando) return <p className="p-8 text-sm text-stone-500">Carregando ordens…</p>

  return (
    <Pagina
      titulo="Ordens"
      descricao="Chave anti-duplicidade: nº da ordem + cultivar + tratamento + embalagem."
      acoes={
        <>
          <a href={SA_PEDIDOS} target="_blank" rel="noreferrer">
            <Botao titulo="Abre o relatório de pedidos na SimpleAgro">SimpleAgro · Pedidos</Botao>
          </a>
          <a href={SA_SALDOS} target="_blank" rel="noreferrer">
            <Botao titulo="Abre a tela de saldos na SimpleAgro">SimpleAgro · Saldos</Botao>
          </a>
          <Botao
            disabled={filtradas.length === 0}
            onClick={() =>
              exportarXlsx(
                'ordens',
                [
                  { titulo: 'Dia', largura: 12 }, { titulo: 'Máquina', largura: 10 },
                  { titulo: 'Seq', largura: 6, tipo: 'numero', casas: 0 },
                  { titulo: 'Ordem', largura: 14 }, { titulo: 'Cultivar', largura: 18 },
                  { titulo: 'Tratamento', largura: 20 }, { titulo: 'Embalagem', largura: 12 },
                  { titulo: 'Lote', largura: 18 },
                  { titulo: 'Armazém', largura: 14 }, { titulo: 'Bloco', largura: 10 },
                  { titulo: 'Quadra', largura: 10 },
                  { titulo: 'Bags', largura: 8, tipo: 'numero', casas: 0 },
                  { titulo: 'Peso (t)', largura: 10, tipo: 'numero', casas: 2 },
                  { titulo: 'Cliente', largura: 28 }, { titulo: 'Status', largura: 20 },
                ],
                filtradas.map((o) => [
                  o.data_prog ?? '', o.maquina_id ?? '', o.seq, o.numero, o.cultivar,
                  o.receita_nome, o.embalagem, o.lote_id,
                  o.armazem ?? '', o.bloco ?? '', o.quadra ?? '',
                  o.bags, o.peso_t, o.cliente ?? '', o.status_efetivo,
                ]),
              ).catch((e) => setErro(`exportar: ${e instanceof Error ? e.message : String(e)}`))
            }
          >
            Exportar .xlsx
          </Botao>
          <Botao
            disabled={filtradas.length === 0}
            titulo="Gera uma folha para pregar no quadro do chão de fábrica"
            onClick={() =>
              imprimirTabela(
                'Ordens de tratamento',
                `${filtradas.length} ordem(ns)` +
                  (filtroStatus ? ` · status ${filtroStatus}` : '') +
                  (filtroMaquina ? ` · ${filtroMaquina}` : '') +
                  (busca.trim() ? ` · busca "${busca.trim()}"` : ''),
                ['Dia', 'Máq.', 'Seq', 'Ordem', 'Cultivar', 'Tratamento', 'Emb.',
                  'Lote', 'Endereço', 'Bags', 'Peso (t)', 'Status'],
                filtradas.map((o) => [
                  diaCurto(o.data_prog), o.maquina_id ?? '—', o.seq ?? '—', o.numero,
                  o.cultivar, o.receita_nome, o.embalagem, o.lote_id,
                  enderecoLote(o), o.bags, n(o.peso_t, 1), o.status_efetivo,
                ]),
              )
            }
          >
            Imprimir
          </Botao>
        </>
      }
    >
      {erro && <Erro>{erro}</Erro>}
      {msg && <div className="mb-4"><Aviso gravidade="ok">{msg}</Aviso></div>}

      {/* ---------------- upload ---------------- */}
      {podeEditar && (
        <Cartao titulo="Carga diária" className="mb-5">
          <p className="mb-3 text-sm text-stone-500">
            O mesmo arquivo de <b>Saldos</b> alimenta dois destinos: linhas com embalagem e
            tratamento <code>SEM TSI</code> viram lotes de semente; com tratamento real viram
            estoque de produto acabado. Pré-lote e granel são ignorados.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-stone-300 px-3 py-1.5 text-sm font-medium dark:border-stone-700">
              Carregar planilha (.xlsx)
              <input type="file" accept=".xlsx,.xls" className="hidden" onChange={lerArquivo} />
            </label>
            <Botao
              titulo="Baixa uma planilha de exemplo já com as colunas certas e duas linhas preenchidas"
              onClick={() =>
                baixarModeloOrdens(lotes, receitas, embalagens, maquinas).catch((e) =>
                  setErro(`gerar modelo: ${e instanceof Error ? e.message : String(e)}`),
                )
              }
            >
              Baixar modelo de ordens
            </Botao>
          </div>

          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-stone-600 dark:text-stone-300">
              Layout da planilha de ordens
            </summary>
            <div className="mt-2 rounded-md bg-stone-50 p-3 dark:bg-stone-800/50">
              <p className="mb-2 text-stone-600 dark:text-stone-300">
                A primeira linha é o cabeçalho. A ordem das colunas não importa, e o nome
                tolera acento e maiúsculas — <code>Nº Ordem</code>, <code>numero</code> e{' '}
                <code>OP</code> valem o mesmo.
              </p>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-stone-500">
                    <th className="py-1 pr-3">Coluna</th>
                    <th className="py-1 pr-3">Obrigatória</th>
                    <th className="py-1">Observação</th>
                  </tr>
                </thead>
                <tbody className="text-stone-600 dark:text-stone-300">
                  {LAYOUT_ORDENS.map((c) => (
                    <tr key={c.coluna} className="border-t border-stone-200 dark:border-stone-700">
                      <td className="py-1 pr-3 font-medium">{c.coluna}</td>
                      <td className="py-1 pr-3">{c.obrigatoria ? 'sim' : 'não'}</td>
                      <td className="py-1">{c.obs}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-stone-500">
                O cultivar não é coluna: vem do lote informado. Antes de importar, o sistema
                mostra uma prévia e lista linha por linha o que estiver errado — nada é gravado
                até você confirmar.
              </p>
            </div>
          </details>

          {previaPedidos && (
            <div className="mt-4 rounded-md border border-stone-200 p-4 dark:border-stone-700">
              <h4 className="text-sm font-semibold">Pedidos Analítico Resumido</h4>
              <ul className="mt-2 space-y-1 text-sm text-stone-600 dark:text-stone-300">
                <li>
                  {previaPedidos.resumo.aproveitadas} linha(s) aproveitadas →{' '}
                  <b>{previaPedidos.linhas.length}</b> combinações
                </li>
                <li>
                  <b>{inteiro(previaPedidos.totalAprovado)} bags aprovados</b> ·{' '}
                  {inteiro(previaPedidos.totalPendente)} aguardando aprovação financeira
                </li>
                <li className="text-stone-500">
                  Fora: {previaPedidos.resumo.foraStatus} não-Integrado ·{' '}
                  {previaPedidos.resumo.semTsi} SEM TSI · {previaPedidos.resumo.saldoZero} sem saldo
                </li>
              </ul>
              {Object.keys(previaPedidos.resumo.semReceita).length > 0 && (
                <div className="mt-3">
                  <Aviso>
                    <b>{Object.keys(previaPedidos.resumo.semReceita).length} código(s) sem receita
                    cadastrada.</b> A demanda entra no balanço, mas não é possível criar ordem
                    até cadastrar a receita:{' '}
                    {Object.keys(previaPedidos.resumo.semReceita).join(', ')}
                  </Aviso>
                </div>
              )}
              <div className="mt-3">
                <Botao
                  variante="primario"
                  onClick={() =>
                    comErro(async () => {
                      const qtd = await g.importarPedidos(previaPedidos.linhas, usuario!.id)
                      setPreviaPedidos(null)
                      setMsg(`${qtd} linha(s) de pedido importadas — substituição total da carga anterior.`)
                    })
                  }
                >
                  Importar pedidos (substitui a carga)
                </Botao>
              </div>
            </div>
          )}

          {previaSaldos && (
            <div className="mt-4 rounded-md border border-stone-200 p-4 dark:border-stone-700">
              <h4 className="text-sm font-semibold">Relatório de Saldos</h4>
              <ul className="mt-2 space-y-1 text-sm text-stone-600 dark:text-stone-300">
                <li>
                  <b>{previaSaldos.lotes.length} lote(s) de semente</b> ·{' '}
                  {inteiro(previaSaldos.totalBagsLotes)} bags
                </li>
                <li>
                  {previaSaldos.estoquePa.length} combinação(ões) de estoque tratado ·{' '}
                  {inteiro(previaSaldos.totalBagsEstoque)} bags
                </li>
                <li className="text-stone-500">
                  Fora: {previaSaldos.resumo.granel} linha(s) de pré-lote/granel ·{' '}
                  {previaSaldos.resumo.saldoZeroOuNegativo} sem saldo
                </li>
              </ul>
              {previaSaldos.resumo.negativos.length > 0 && (
                <div className="mt-3">
                  <Aviso>
                    <b>Saldo negativo na origem</b> (ignorado, verificar na SimpleAgro):{' '}
                    {previaSaldos.resumo.negativos.map((x) => `${x.lote} (${x.bags})`).join(', ')}
                  </Aviso>
                </div>
              )}
              {previaSaldos.resumo.semPms > 0 && (
                <div className="mt-3">
                  <Aviso gravidade="bloqueio">
                    {previaSaldos.resumo.semPms} lote(s) sem PMS — o peso do bag fica zero.
                    Corrigir na origem antes de produzir.
                  </Aviso>
                </div>
              )}
              <div className="mt-3 flex gap-2">
                <Botao
                  variante="primario"
                  onClick={() =>
                    comErro(async () => {
                      const qtd = await g.importarLotes(previaSaldos.lotes)
                      setMsg(`${qtd} lote(s) importados.`)
                      setPreviaSaldos(null)
                    })
                  }
                >
                  Importar lotes
                </Botao>
                <Botao
                  disabled={previaSaldos.estoquePa.length === 0}
                  onClick={() =>
                    comErro(async () => {
                      const qtd = await g.importarEstoquePa(previaSaldos.estoquePa, usuario!.id)
                      setMsg(`${qtd} linha(s) de estoque importadas.`)
                      setPreviaSaldos(null)
                    })
                  }
                >
                  Importar estoque
                </Botao>
              </div>
            </div>
          )}

          {previaOrdens && (
            <div className="mt-4 rounded-md border border-stone-200 p-4 dark:border-stone-700">
              <h4 className="text-sm font-semibold">Planilha de ordens</h4>
              <p className="mt-2 text-sm text-stone-600 dark:text-stone-300">
                <b>{previaOrdens.ordens.length} ordem(ns)</b> prontas para importar
                {previaOrdens.problemas.length > 0 &&
                  ` · ${previaOrdens.problemas.length} linha(s) com problema`}
              </p>

              {previaOrdens.problemas.length > 0 && (
                <div className="mt-3">
                  <Aviso gravidade="bloqueio">
                    <b>Linhas que não serão importadas:</b>
                    <ul className="mt-1 max-h-40 list-inside list-disc overflow-y-auto">
                      {previaOrdens.problemas.slice(0, 30).map((p) => (
                        <li key={p.linha}>Linha {p.linha}: {p.motivo}</li>
                      ))}
                    </ul>
                    {previaOrdens.problemas.length > 30 && (
                      <p className="mt-1">…e mais {previaOrdens.problemas.length - 30}.</p>
                    )}
                  </Aviso>
                </div>
              )}

              {previaOrdens.duplicadasNoArquivo.length > 0 && (
                <div className="mt-3">
                  <Aviso>
                    <b>Repetidas dentro do próprio arquivo</b> (só a primeira entra):{' '}
                    {previaOrdens.duplicadasNoArquivo.join(', ')}
                  </Aviso>
                </div>
              )}

              <div className="mt-3">
                <Botao
                  variante="primario"
                  disabled={previaOrdens.ordens.length === 0}
                  onClick={() =>
                    comErro(async () => {
                      const novas: g.NovaOrdem[] = previaOrdens.ordens.map((o) => {
                        const lote = lotes.find((l) => l.id === o.loteId)!
                        const receita = receitas.find(
                          (r) => r.nome.toUpperCase() === o.tratamento.toUpperCase(),
                        )!
                        return {
                          numero: o.numero,
                          cultivar: lote.cultivar,
                          receita_id: receita.id,
                          embalagem: o.embalagem,
                          bags: o.bags,
                          lote_id: o.loteId,
                          cliente: o.cliente,
                          observacao: o.observacao,
                          armazem: o.armazem,
                          bloco: o.bloco,
                          quadra: o.quadra,
                          maquina_id: o.maquinaId,
                          data_prog: o.dataProg,
                        }
                      })
                      const r = await g.criarOrdensEmLote(novas)
                      setPreviaOrdens(null)
                      setMsg(
                        `${r.criadas} ordem(ns) criada(s).` +
                          (r.jaExistiam.length > 0
                            ? ` ${r.jaExistiam.length} não entraram: ${r.jaExistiam
                                .slice(0, 5)
                                .map((x) => x.numero)
                                .join(', ')}${r.jaExistiam.length > 5 ? '…' : ''}`
                            : ''),
                      )
                    })
                  }
                >
                  Importar {previaOrdens.ordens.length} ordem(ns)
                </Botao>
              </div>
            </div>
          )}
        </Cartao>
      )}

      {/* ---------------- nova ordem ---------------- */}
      {podeEditar && (
        <NovaOrdemForm
          lotes={lotes}
          receitas={receitas}
          embalagens={embalagens}
          maquinas={maquinas}
          ordens={ordens}
          balanco={balanco}
          onCriada={(texto) => {
            setMsg(texto)
            recarregar().catch(() => {})
          }}
        />
      )}

      {/* ---------------- painel de demanda ---------------- */}
      <Cartao titulo="Demanda × Estoque × Planejado" className="mb-5">
        {balanco.length === 0 ? (
          <Vazio>Nenhuma carga de demanda importada ainda.</Vazio>
        ) : (
          <Tabela
            cabecalho={['Cultivar', 'Tratamento', 'Emb.', '#Pedido', '#Aguardando',
              '#Estoque', '#Planejado', '#Saldo', '']}
          >
            {balanco
              .slice()
              .sort((a, b) => b.saldo - a.saldo)
              .map((b, i) => (
                <tr key={i} className="border-t border-stone-100 dark:border-stone-800/60">
                  <td className="px-2 py-1.5">{b.cultivar}</td>
                  <td className="px-2 py-1.5">{b.tratamento}</td>
                  <td className="px-2 py-1.5">{b.embalagem}</td>
                  <td className="num-tabular px-2 py-1.5 text-right">{inteiro(b.pedido_aprovado)}</td>
                  <td className="num-tabular px-2 py-1.5 text-right text-stone-400">
                    {inteiro(b.pedido_pendente)}
                  </td>
                  <td className="num-tabular px-2 py-1.5 text-right">{inteiro(b.estoque_pa)}</td>
                  <td className="num-tabular px-2 py-1.5 text-right">{inteiro(b.ordens_abertas)}</td>
                  <td
                    className={`num-tabular px-2 py-1.5 text-right font-semibold ${
                      b.saldo > 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-stone-400'
                    }`}
                  >
                    {inteiro(b.saldo)}
                  </td>
                  <td className="px-2 py-1.5">
                    {!b.receita_cadastrada && <Tag cor="alerta">receita não cadastrada</Tag>}
                  </td>
                </tr>
              ))}
          </Tabela>
        )}
      </Cartao>

      {/* ---------------- lista de ordens ---------------- */}
      <Cartao
        titulo={`Ordens (${filtradas.length} de ${ordens.length})`}
        acoes={
          <>
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="buscar ordem, cultivar, lote, cliente…"
              className="rounded-md border border-stone-300 px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-800"
            />
            <select
              value={filtroStatus}
              onChange={(e) => setFiltroStatus(e.target.value)}
              className="rounded-md border border-stone-300 px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-800"
            >
              <option value="">todos os status</option>
              {statusDisponiveis.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <select
              value={filtroMaquina}
              onChange={(e) => setFiltroMaquina(e.target.value)}
              className="rounded-md border border-stone-300 px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-800"
            >
              <option value="">todas as máquinas</option>
              {maquinas.map((m) => (
                <option key={m.id} value={m.id}>{m.nome}</option>
              ))}
            </select>
          </>
        }
      >
        {porDia.length === 0 ? (
          <Vazio>Nenhuma ordem encontrada com esses filtros.</Vazio>
        ) : (
          <Tabela
            cabecalho={['Seq', 'Ordem', 'Cultivar', 'Tratamento', 'Emb.', 'Lote', 'Endereço',
              '#Bags', '#Peso', 'Cliente', 'Status', '']}
          >
            {porDia.map(([dia, lista]) => (
              <FragmentoDia
                key={dia}
                dia={dia}
                lista={lista}
                podeEditar={!!podeEditar}
                onExcluir={(id) =>
                  comErro(async () => {
                    if (!confirm('Excluir esta ordem?')) return
                    await g.excluirOrdem(id)
                  })
                }
                onPrioridade={(id, p) =>
                  comErro(() => g.definirPrioridade(id, p, usuario!.id))
                }
              />
            ))}
          </Tabela>
        )}
      </Cartao>
    </Pagina>
  )
}

function FragmentoDia({
  dia, lista, podeEditar, onExcluir, onPrioridade,
}: {
  dia: string
  lista: OrdemVisao[]
  podeEditar: boolean
  onExcluir: (id: string) => void
  onPrioridade: (id: string, p: 'Normal' | 'Urgente') => void
}) {
  const totalT = lista.reduce((a, o) => a + o.peso_t, 0)
  return (
    <>
      <tr className="bg-stone-100/70 dark:bg-stone-800/40">
        <td colSpan={8} className="px-2 py-1.5 text-xs font-semibold uppercase">
          {dia === 'sem-dia' ? 'Sem dia programado' : `Dia ${diaCurto(dia)}`}
        </td>
        <td className="num-tabular px-2 py-1.5 text-right text-xs font-semibold">
          {n(totalT, 1)} t
        </td>
        <td colSpan={3} />
      </tr>
      {lista.map((o) => {
        const st = o.status_efetivo as StatusEfetivo
        return (
          <tr key={o.id} className="border-t border-stone-100 dark:border-stone-800/60">
            <td className="px-2 py-1.5 text-stone-400">{o.seq ?? '—'}</td>
            <td className="px-2 py-1.5 font-medium">
              {o.numero}
              {o.prioridade === 'Urgente' && <span className="ml-1"><Tag cor="perigo">urgente</Tag></span>}
            </td>
            <td className="px-2 py-1.5">{o.cultivar}</td>
            <td className="px-2 py-1.5">{o.receita_nome}</td>
            <td className="px-2 py-1.5">{o.embalagem}</td>
            <td className="px-2 py-1.5 font-medium">{o.lote_id}</td>
            <td className="px-2 py-1.5 text-xs text-stone-500">{enderecoLote(o)}</td>
            <td className="num-tabular px-2 py-1.5 text-right">{o.bags}</td>
            <td className="num-tabular px-2 py-1.5 text-right">{n(o.peso_t, 1)} t</td>
            <td className="max-w-32 truncate px-2 py-1.5 text-stone-500">{o.cliente ?? '—'}</td>
            <td className="px-2 py-1.5"><Tag cor={corDoStatus(st)}>{st}</Tag></td>
            <td className="px-2 py-1.5 text-right whitespace-nowrap">
              {podeEditar && pode(st, 'priorizar') && (
                <button
                  onClick={() => onPrioridade(o.id, o.prioridade === 'Urgente' ? 'Normal' : 'Urgente')}
                  className="mr-1 text-xs underline"
                >
                  {o.prioridade === 'Urgente' ? 'normal' : 'urgente'}
                </button>
              )}
              {podeEditar && pode(st, 'excluir') && (
                <button onClick={() => onExcluir(o.id)} className="text-xs text-red-600 underline">
                  excluir
                </button>
              )}
            </td>
          </tr>
        )
      })}
    </>
  )
}

function NovaOrdemForm({
  lotes, receitas, embalagens, maquinas, ordens, balanco, onCriada,
}: {
  lotes: LoteSementeLinha[]
  receitas: ReceitaCompleta[]
  embalagens: g.EmbalagemLinha[]
  maquinas: api.LinhaMaquina[]
  ordens: OrdemVisao[]
  balanco: BalancoLinha[]
  onCriada: (msg: string) => void
}) {
  const [aberto, setAberto] = useState(false)
  const [numero, setNumero] = useState('')
  const [loteId, setLoteId] = useState('')
  const [receitaId, setReceitaId] = useState('')
  const [embalagem, setEmbalagem] = useState(embalagens[0]?.codigo ?? '')
  const [bags, setBags] = useState(0)
  const [cliente, setCliente] = useState('')
  const [observacao, setObservacao] = useState('')
  const [armazem, setArmazem] = useState('')
  const [bloco, setBloco] = useState('')
  const [quadra, setQuadra] = useState('')
  const [maquinaId, setMaquinaId] = useState('')
  const [dataProg, setDataProg] = useState('')
  const [erro, setErro] = useState<string | null>(null)

  const lote = lotes.find((l) => l.id === loteId)
  const receita = receitas.find((r) => r.id === receitaId)

  const analise = useMemo(() => {
    if (!lote || !receita || !embalagem || bags <= 0) return null
    const chave = { cultivar: lote.cultivar, tratamento: receita.nome, embalagem }
    const linhaBalanco = balanco.find(
      (b) => b.cultivar === chave.cultivar && b.tratamento === chave.tratamento &&
        b.embalagem === chave.embalagem,
    )
    return analisaDemanda(
      chave,
      bags,
      linhaBalanco
        ? [
            { ...chave, bags: linhaBalanco.pedido_aprovado, aprovado: true },
            { ...chave, bags: linhaBalanco.pedido_pendente, aprovado: false },
          ]
        : [],
      linhaBalanco ? [{ ...chave, bags: linhaBalanco.estoque_pa }] : [],
      ordens
        .filter((o) => o.status_efetivo !== 'Apontada' && o.cultivar === chave.cultivar &&
          o.receita_nome === chave.tratamento && o.embalagem === chave.embalagem)
        .map((o) => ({ ...chave, bags: o.bags })),
      true,
    )
  }, [lote, receita, embalagem, bags, balanco, ordens])

  if (!aberto) {
    return (
      <div className="mb-5">
        <Botao variante="primario" onClick={() => setAberto(true)}>Nova ordem</Botao>
      </div>
    )
  }

  return (
    <Cartao
      titulo="Nova ordem"
      acoes={<Botao onClick={() => setAberto(false)}>Fechar</Botao>}
      className="mb-5"
    >
      {erro && <Erro>{erro}</Erro>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Campo rotulo="Nº da ordem">
          <input value={numero} onChange={(e) => setNumero(e.target.value)} className={INPUT} />
        </Campo>
        <Campo rotulo="Lote de semente">
          <select value={loteId} onChange={(e) => setLoteId(e.target.value)} className={INPUT}>
            <option value="">escolha…</option>
            {lotes.map((l) => (
              <option key={l.id} value={l.id}>
                {l.id} · {l.cultivar} · {n(l.peso_bag_kg, 0)} kg/bag
              </option>
            ))}
          </select>
        </Campo>
        <Campo rotulo="Tratamento">
          <select value={receitaId} onChange={(e) => setReceitaId(e.target.value)} className={INPUT}>
            <option value="">escolha…</option>
            {receitas.map((r) => (
              <option key={r.id} value={r.id}>{r.nome}</option>
            ))}
          </select>
        </Campo>
        <Campo rotulo="Embalagem">
          <select value={embalagem} onChange={(e) => setEmbalagem(e.target.value)} className={INPUT}>
            {embalagens.map((e) => (
              <option key={e.codigo} value={e.codigo}>{e.codigo}</option>
            ))}
          </select>
        </Campo>
        <Campo rotulo="Bags">
          <input
            type="number" min={1} value={bags || ''}
            onChange={(e) => setBags(Number(e.target.value))} className={INPUT}
          />
        </Campo>
        <Campo rotulo="Peso resultante">
          <p className="num-tabular py-1.5 text-sm font-medium">
            {lote && bags > 0 ? `${n((bags * lote.peso_bag_kg) / 1000, 2)} t` : '—'}
          </p>
        </Campo>
        <Campo rotulo="Cliente (opcional)">
          <input value={cliente} onChange={(e) => setCliente(e.target.value)} className={INPUT} />
        </Campo>
        <Campo rotulo="Observação de processo">
          <input
            value={observacao} onChange={(e) => setObservacao(e.target.value)}
            placeholder="ex.: SEM GRAFITE" className={INPUT}
          />
        </Campo>
        <Campo rotulo="Máquina e dia (opcional)">
          <div className="flex gap-2">
            <select value={maquinaId} onChange={(e) => setMaquinaId(e.target.value)} className={INPUT}>
              <option value="">pool</option>
              {maquinas.map((m) => (
                <option key={m.id} value={m.id}>{m.nome}</option>
              ))}
            </select>
            <input
              type="date" value={dataProg}
              onChange={(e) => setDataProg(e.target.value)} className={INPUT}
            />
          </div>
        </Campo>
        <Campo rotulo="Endereço do lote (opcional)">
          <div className="flex gap-2">
            <input
              value={armazem}
              onChange={(e) => setArmazem(e.target.value.toUpperCase())}
              placeholder="ARMAZEM C"
              title="Armazém — onde buscar o lote para esta ordem"
              className={INPUT}
            />
            <input
              value={bloco}
              onChange={(e) => setBloco(e.target.value.toUpperCase())}
              placeholder="BL01"
              title="Bloco"
              className={`${INPUT} w-24`}
            />
            <input
              value={quadra}
              onChange={(e) => setQuadra(e.target.value.toUpperCase())}
              placeholder="QD04"
              title="Quadra"
              className={`${INPUT} w-24`}
            />
          </div>
        </Campo>
      </div>

      {lote && (
        <p className="mt-2 text-xs text-stone-500">
          O mesmo lote pode estar em vários endereços — por isso o endereço fica na ordem, não no
          lote. Em branco, a logística preenche na separação.
        </p>
      )}

      {analise && analise.avisos.length > 0 && (
        <div className="mt-4 space-y-2">
          {analise.avisos.map((a, i) => (
            <Aviso key={i} gravidade={a.bloqueia ? 'bloqueio' : 'alerta'}>
              {a.mensagem}
            </Aviso>
          ))}
          {!analise.avisos.some((a) => a.bloqueia) && (
            <p className="text-xs text-stone-500">
              Avisos não bloqueiam: a decisão de produzir é do PCP.
            </p>
          )}
        </div>
      )}

      <div className="mt-4">
        <Botao
          variante="primario"
          disabled={!numero || !loteId || !receitaId || bags <= 0 ||
            (analise ? !podeCriarOrdem(analise) : false)}
          onClick={async () => {
            try {
              setErro(null)
              await g.criarOrdem({
                numero: numero.trim(),
                cultivar: lote!.cultivar,
                receita_id: receitaId,
                embalagem,
                bags,
                lote_id: loteId,
                cliente: cliente.trim() || null,
                observacao: observacao.trim() || null,
                armazem: armazem.trim() || null,
                bloco: bloco.trim() || null,
                quadra: quadra.trim() || null,
                maquina_id: maquinaId || null,
                data_prog: dataProg || null,
              })
              setNumero(''); setBags(0); setCliente(''); setObservacao('')
              // endereço costuma repetir entre ordens do mesmo lote: mantém preenchido
              onCriada(`Ordem criada.`)
            } catch (e) {
              setErro(e instanceof Error ? e.message : String(e))
            }
          }}
        >
          Criar ordem
        </Botao>
      </div>
    </Cartao>
  )
}

const INPUT =
  'w-full rounded-md border border-stone-300 px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-800'

function Campo({ rotulo, children }: { rotulo: string; children: React.ReactNode }) {
  return (
    <label className="block text-xs font-medium uppercase tracking-wide text-stone-500">
      {rotulo}
      <div className="mt-1 normal-case">{children}</div>
    </label>
  )
}
