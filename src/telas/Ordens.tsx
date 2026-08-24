import {
  Fragment, useCallback, useEffect, useMemo, useRef, useState,
  type ChangeEvent, type KeyboardEvent,
} from 'react'
import readXlsxFile from 'read-excel-file/browser'
import * as api from '@/dados/api'
import type { LinhaOrdem } from '@/dados/api'
import * as g from '@/dados/api-gestao'
import type {
  BalancoLinha, ConferenciaLinha, LoteSementeLinha, OrdemVisao, ReceitaCompleta,
} from '@/dados/api-gestao'
import ModalOrdem from './ModalOrdem'
import {
  EMBALAGEM_DEPARA,
  converterPedidos, converterSaldos, ehRelatorioPedidos, ehRelatorioSaldos,
  type Linha, type ResultadoPedidos, type ResultadoSaldos,
} from '@/dominio/importacao/simpleagro'
import {
  converterSaldoSap, ehRelatorioSaldoSap, type ResultadoSaldoSap,
} from '@/dominio/importacao/sap'
import {
  converterOrdens, ehPlanilhaDeOrdens, type ResultadoOrdens,
} from '@/dominio/importacao/ordens'
import { exportarXlsx, imprimirTabela } from '@/lib/exportar'
import { useRascunho } from '@/lib/useRascunho'
import { supabase } from '@/lib/supabase'
import {
  USUARIOS_SAP_TESTE, caminhoSaldoLotes, saldoLoteDe, type SaldoLoteSap,
} from '@/lib/sapTeste'
import { useRealtime } from '@/dados/useRealtime'
import {
  analisaDemanda, bagsFaltando, bagsSobrando, ehSemTsi, podeCriarOrdem, resumoBalanco,
  situacaoDemanda, type SituacaoDemanda,
} from '@/dominio/balanco'
import { pesoBagDaOrdemKg } from '@/dominio/calculos'
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
  const { usuario, permitido } = useAuth()
  const podeCriar = permitido('ordens', 'criar')
  const podeEditarOrdem = permitido('ordens', 'editar')
  const podeExcluir = permitido('ordens', 'excluir')
  const podePriorizar = permitido('ordens', 'priorizar')
  const [editando, setEditando] = useState<OrdemVisao | null>(null)
  const [renumerando, setRenumerando] = useState<OrdemVisao | null>(null)

  const [ordens, setOrdens] = useState<OrdemVisao[]>([])
  const [lotes, setLotes] = useState<LoteSementeLinha[]>([])
  const [receitas, setReceitas] = useState<ReceitaCompleta[]>([])
  const [embalagens, setEmbalagens] = useState<g.EmbalagemLinha[]>([])
  const [maquinas, setMaquinas] = useState<api.LinhaMaquina[]>([])
  const [motivos, setMotivos] = useState<api.LinhaMotivo[]>([])
  const [produtos, setProdutos] = useState<api.LinhaProduto[]>([])
  const [conferencias, setConferencias] = useState<ConferenciaLinha[]>([])
  const [balanco, setBalanco] = useState<BalancoLinha[]>([])
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  // "detalhes": abre qualquer ordem (não só as do dia atual, ao contrário da
  // Execução) mostrando tempos, tanques, bags produzidos e conferência —
  // pedido do Arion, 18/08/2026: "na tela de execução, quando abro a ordem,
  // não tem" (a Execução só lista ordem do dia escolhido).
  const [ordemAberta, setOrdemAberta] = useState<LinhaOrdem | null>(null)
  const [abrindoId, setAbrindoId] = useState<string | null>(null)

  async function abrirOrdem(id: string) {
    setAbrindoId(id)
    setErro(null)
    try {
      const o = await api.carregarOrdemPorId(id)
      if (!o) throw new Error('Ordem não encontrada.')
      setOrdemAberta(o)
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    } finally {
      setAbrindoId(null)
    }
  }

  const [busca, setBusca] = useState('')
  const [filtroStatus, setFiltroStatus] = useState('')
  const [filtroMaquina, setFiltroMaquina] = useState('')

  const [previaPedidos, setPreviaPedidos] = useState<ResultadoPedidos | null>(null)
  const [previaSaldos, setPreviaSaldos] = useState<ResultadoSaldos | null>(null)
  const [previaSaldoSap, setPreviaSaldoSap] = useState<ResultadoSaldoSap | null>(null)
  const [previaOrdens, setPreviaOrdens] = useState<ResultadoOrdens | null>(null)

  const recarregar = useCallback(async () => {
    const [o, b, cf] = await Promise.all([g.listarOrdens(), g.listarBalanco(), g.listarConferencias()])
    setOrdens(o)
    setBalanco(b)
    setConferencias(cf)
  }, [])

  useEffect(() => {
    let vivo = true
    setCarregando(true)
    Promise.all([
      g.listarOrdens(), g.listarLotes(), g.listarReceitas(),
      g.listarEmbalagens(), api.carregarCadastros(), g.listarBalanco(), g.listarConferencias(),
    ])
      .then(([o, l, r, e, c, b, cf]) => {
        if (!vivo) return
        setOrdens(o); setLotes(l); setReceitas(r)
        setEmbalagens(e); setMaquinas(c.maquinas); setMotivos(c.motivos); setProdutos(c.produtos)
        setBalanco(b); setConferencias(cf)
      })
      .catch((x) => vivo && setErro(x instanceof Error ? x.message : String(x)))
      .finally(() => vivo && setCarregando(false))
    return () => { vivo = false }
  }, [])

  useRealtime(
    ['ordens', 'lotes_semente', 'pedidos_venda', 'estoque_pa', 'ordem_conferencias'],
    recarregar,
  )

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

  /** Lê o .xlsx em memória — mesmo formato que o read-excel-file devolve nos dois importadores. */
  async function linhasDoArquivo(arquivo: File): Promise<Linha[]> {
    const bruto = (await readXlsxFile(arquivo)) as unknown
    const arr = bruto as { data?: Linha[] }[]
    return Array.isArray(arr) && arr.length > 0 && !Array.isArray(arr[0]) && Array.isArray(arr[0]?.data)
      ? (arr[0].data as Linha[])
      : (bruto as Linha[])
  }

  async function lerArquivo(ev: ChangeEvent<HTMLInputElement>) {
    const arquivo = ev.target.files?.[0]
    if (!arquivo) return
    setErro(null); setMsg(null)
    setPreviaPedidos(null); setPreviaSaldos(null); setPreviaSaldoSap(null); setPreviaOrdens(null)
    try {
      const rows = await linhasDoArquivo(arquivo)

      if (ehRelatorioPedidos(rows)) {
        setPreviaPedidos(converterPedidos(rows, receitas.map((r) => r.nome)))
      } else if (ehRelatorioSaldos(rows)) {
        setPreviaSaldos(converterSaldos(rows))
      } else if (ehRelatorioSaldoSap(rows)) {
        setPreviaSaldoSap(converterSaldoSap(rows))
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
            '"Saldos" da SimpleAgro, o export de saldos do SAP, ou uma planilha de ordens com as ' +
            'colunas Ordem, Lote, Tratamento, Embalagem e Bags.',
        )
      }
    } catch (e) {
      setErro(`Não consegui ler o arquivo: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      ev.target.value = ''
    }
  }

  /**
   * Botão dedicado (pedido do Arion, 19/08/2026): enquanto o TI não resolve
   * o relatório de Saldos da SimpleAgro, esse export do SAP substitui os
   * dois destinos (lotes de semente + estoque de produto acabado). Separado
   * do botão genérico de propósito — o auto-detect acima também reconhece
   * esse formato, mas aqui o erro é específico se vier arquivo errado.
   */
  async function lerArquivoSap(ev: ChangeEvent<HTMLInputElement>) {
    const arquivo = ev.target.files?.[0]
    if (!arquivo) return
    setErro(null); setMsg(null)
    setPreviaSaldoSap(null)
    try {
      const rows = await linhasDoArquivo(arquivo)
      if (!ehRelatorioSaldoSap(rows)) {
        setErro(
          'Esse arquivo não parece o export de saldos do SAP — esperado colunas como ' +
            '"Nº do Lote", "Tratamento (TSI)" e "Qtd em Estoque".',
        )
        return
      }
      setPreviaSaldoSap(converterSaldoSap(rows))
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

  // ordenação dentro de cada máquina (pedido do Arion, 13/08/2026): a fila
  // real (campo `seq`) só é editada na tela Programação — isto é só pra
  // ENXERGAR melhor a lista aqui, clicando na coluna, sem mexer em nada.
  type CampoOrdenacao = 'cultivar' | 'tratamento' | 'status' | 'peso'
  const [ordenacao, setOrdenacao] = useState<{ campo: CampoOrdenacao; dir: 'asc' | 'desc' } | null>(
    null,
  )
  const alternarOrdenacao = (campo: CampoOrdenacao) =>
    setOrdenacao((o) =>
      !o || o.campo !== campo
        ? { campo, dir: 'asc' }
        : o.dir === 'asc'
          ? { campo, dir: 'desc' }
          : null,
    )
  const setaOrdem = (campo: CampoOrdenacao): 'asc' | 'desc' | undefined =>
    ordenacao?.campo === campo ? ordenacao.dir : undefined

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
                  { titulo: 'Dia', largura: 12 },
                  // o dia original e a contagem respondem "para quando isto
                  // estava programado?" depois de uma cascata
                  { titulo: 'Dia original', largura: 12 },
                  { titulo: 'Reprogramada', largura: 12, tipo: 'numero', casas: 0 },
                  { titulo: 'Máquina', largura: 10 },
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
                  o.data_prog ?? '',
                  o.data_prog_original ?? '',
                  o.reprogramacoes ?? 0,
                  o.maquina_id ?? '', o.seq, o.numero, o.cultivar,
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
      {podeCriar && (
        <Cartao titulo="Carga diária" className="mb-5">
          <p className="mb-3 text-sm text-stone-500">
            Um único botão — o sistema reconhece o arquivo pelo formato, sem precisar escolher
            o tipo:
          </p>
          <ul className="mb-3 list-inside list-disc text-sm text-stone-500">
            <li>
              <b>Pedidos Analítico Resumido</b> — vira demanda (painel Demanda × Estoque ×
              Planejado abaixo).
            </li>
            <li>
              <b>Saldos</b> — alimenta dois destinos: linhas com embalagem e tratamento{' '}
              <code>SEM TSI</code> viram lotes de semente; com tratamento real viram estoque de
              produto acabado. Pré-lote e granel são ignorados.
            </li>
            <li>
              <b>Planilha de ordens</b> (opcional, não vem da SimpleAgro) — cria várias ordens de
              uma vez; layout e modelo abaixo.
            </li>
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-stone-300 px-3 py-1.5 text-sm font-medium dark:border-stone-700">
              Carregar planilha (.xlsx)
              <input type="file" accept=".xlsx,.xls" className="hidden" onChange={lerArquivo} />
            </label>
            <label
              title="Enquanto o TI não resolve o relatório de Saldos da SimpleAgro: mesmo destino (lotes de semente + estoque de produto acabado), lido do export do SAP"
              className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-stone-300 px-3 py-1.5 text-sm font-medium dark:border-stone-700"
            >
              Importar saldo do SAP
              <input type="file" accept=".xlsx,.xls" className="hidden" onChange={lerArquivoSap} />
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
                {previaPedidos.resumo.bagsCooperado > 0 && (
                  <li className="font-medium text-amber-600 dark:text-amber-400">
                    {inteiro(previaPedidos.resumo.bagsCooperado)} bg de VENDA COOPERADO — destacados
                    no painel de demanda
                  </li>
                )}
                <li className="text-stone-500">
                  Fora: {previaPedidos.resumo.foraStatus} sem status firme (Aprovado/Integrado) ·{' '}
                  {previaPedidos.resumo.semTsi} SEM TSI · {previaPedidos.resumo.saldoZero} sem saldo
                </li>
              </ul>

              {/* Só Integrado entra. Se a origem renomear o status, o arquivo
                  todo cai aqui — melhor ver o número que descobrir depois. */}
              {Object.keys(previaPedidos.resumo.porStatusFora).length > 0 && (
                <details className="mt-2 text-sm">
                  <summary className="cursor-pointer text-stone-500">
                    {inteiro(
                      Object.values(previaPedidos.resumo.porStatusFora)
                        .reduce((a, v) => a + v.bags, 0),
                    )}{' '}
                    bg de TSI real descartados por status do pedido — ver quais
                  </summary>
                  <ul className="mt-1 space-y-0.5 pl-4 text-stone-500">
                    {Object.entries(previaPedidos.resumo.porStatusFora)
                      .sort(([, a], [, b]) => b.bags - a.bags)
                      .map(([status, v]) => (
                        <li key={status}>
                          <b>{status}</b>: {v.linhas} linha(s), {inteiro(v.bags)} bg
                        </li>
                      ))}
                  </ul>
                  <p className="mt-1 pl-4 text-xs text-stone-400">
                    Só pedido firme (<b>Aprovado</b> ou <b>Integrado</b>) gera trabalho de TSI.
                    Esses pedidos não entram nem como aguardando — somem da programação e do
                    balanço. O aguardando do painel é outro: Status Financeiro = Não Aprovado.
                  </p>
                </details>
              )}

              {previaPedidos.resumo.aproveitadas === 0 &&
                previaPedidos.resumo.totalLinhas > 0 && (
                  <div className="mt-3">
                    <Aviso>
                      <b>Nenhuma linha aproveitada em {previaPedidos.resumo.totalLinhas}.</b>{' '}
                      Confira se o arquivo é o “Pedidos Analítico Resumido” da safra certa. Se a
                      SimpleAgro tiver renomeado a coluna Status Pedido ou os valores
                      Aprovado/Integrado, o importador precisa de ajuste — não importe por cima
                      da carga boa.
                    </Aviso>
                  </div>
                )}

              {/* Embalagem sem de-para descarta a linha inteira — isso é
                  demanda de TSI sumindo do balanço, tem que gritar. */}
              {Object.keys(previaPedidos.resumo.embalagemDesconhecida).length > 0 && (
                <div className="mt-3">
                  <Aviso>
                    <b>Embalagem não reconhecida — pedidos DESCARTADOS:</b>{' '}
                    {Object.entries(previaPedidos.resumo.embalagemDesconhecida)
                      .map(([cod, bags]) => `${cod} (${inteiro(bags)} bg)`)
                      .join(' · ')}
                    . O importador conhece BB5M → BG5M e BMB → MEIOBAG. Se apareceu um código
                    novo no relatório, ele precisa entrar no de-para — esses bags não estão no
                    balanço.
                  </Aviso>
                </div>
              )}

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
              {Object.keys(previaSaldos.resumo.cultivarCorrigidos).length > 0 && (
                <div className="mt-3">
                  <Aviso>
                    <b>Cultivar corrigido pelo nome do produto</b> (a coluna veio truncada
                    da SimpleAgro — sem isso o balanço não casa com os pedidos):{' '}
                    {Object.entries(previaSaldos.resumo.cultivarCorrigidos)
                      .map(([de, linhas]) => `${de} (${linhas} linha${linhas > 1 ? 's' : ''})`)
                      .join(' · ')}
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

          {previaSaldoSap && (
            <div className="mt-4 rounded-md border border-stone-200 p-4 dark:border-stone-700">
              <h4 className="text-sm font-semibold">Saldo do SAP (substituto temporário)</h4>
              <ul className="mt-2 space-y-1 text-sm text-stone-600 dark:text-stone-300">
                <li>
                  <b>{previaSaldoSap.lotes.length} lote(s) de semente</b> ·{' '}
                  {inteiro(previaSaldoSap.totalBagsLotes)} bags
                </li>
                <li>
                  {previaSaldoSap.estoquePa.length} combinação(ões) de estoque tratado ·{' '}
                  {inteiro(previaSaldoSap.totalBagsEstoque)} bags
                </li>
                <li className="text-stone-500">
                  Fora: {previaSaldoSap.resumo.granel} linha(s) de pré-lote/granel ·{' '}
                  {previaSaldoSap.resumo.saldoZeroOuNegativo} sem saldo ·{' '}
                  {previaSaldoSap.resumo.antesDoCorte} anterior(es) a 01/01/2026 ·{' '}
                  {previaSaldoSap.resumo.dataInvalida} sem data legível
                </li>
              </ul>
              {previaSaldoSap.resumo.dataInvalida > previaSaldoSap.resumo.totalLinhas / 2 && (
                <div className="mt-3">
                  <Aviso gravidade="bloqueio">
                    <b>Quase todas as linhas ficaram sem data legível</b> — não é lote antigo,
                    é a coluna "Data de Entrada" não sendo entendida (formato diferente do
                    esperado, ou nome de coluna diferente no export). Confira antes de importar:
                    se seguir assim, o estoque some inteiro.
                  </Aviso>
                </div>
              )}
              {previaSaldoSap.resumo.negativos.length > 0 && (
                <div className="mt-3">
                  <Aviso>
                    <b>Saldo negativo na origem</b> (ignorado, verificar no SAP):{' '}
                    {previaSaldoSap.resumo.negativos.map((x) => `${x.lote} (${x.bags})`).join(', ')}
                  </Aviso>
                </div>
              )}
              {previaSaldoSap.resumo.semPms > 0 && (
                <div className="mt-3">
                  <Aviso gravidade="bloqueio">
                    {previaSaldoSap.resumo.semPms} lote(s) sem PMS — o peso do bag fica zero.
                    Corrigir na origem antes de produzir.
                  </Aviso>
                </div>
              )}
              {Object.keys(previaSaldoSap.resumo.unidades).length > 1 && (
                <div className="mt-3">
                  <Aviso gravidade="bloqueio">
                    <b>Mais de uma unidade em "UM Estoque"</b> — pode estar somando kg junto com
                    bag:{' '}
                    {Object.entries(previaSaldoSap.resumo.unidades)
                      .map(([um, linhas]) => `${um} (${linhas} linha${linhas > 1 ? 's' : ''})`)
                      .join(' · ')}
                    . Confira a planilha antes de importar.
                  </Aviso>
                </div>
              )}
              <div className="mt-3 flex gap-2">
                <Botao
                  variante="primario"
                  onClick={() =>
                    comErro(async () => {
                      const qtd = await g.importarLotes(previaSaldoSap.lotes)
                      setMsg(`${qtd} lote(s) importados (via SAP).`)
                      setPreviaSaldoSap(null)
                    })
                  }
                >
                  Importar lotes
                </Botao>
                <Botao
                  disabled={previaSaldoSap.estoquePa.length === 0}
                  onClick={() =>
                    comErro(async () => {
                      const qtd = await g.importarEstoquePa(previaSaldoSap.estoquePa, usuario!.id)
                      setMsg(`${qtd} linha(s) de estoque importadas (via SAP).`)
                      setPreviaSaldoSap(null)
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
      {podeCriar && (
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

      {/* ---------------- edição (só antes de iniciar) ---------------- */}
      {editando && (
        <NovaOrdemForm
          key={editando.id}
          ordem={editando}
          aoFechar={() => setEditando(null)}
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
      <PainelDemanda
        balanco={balanco}
        foraDoBalanco={new Set(
          embalagens.filter((e) => (e.peso_fixo_kg ?? 0) > 0).map((e) => e.codigo),
        )}
      />

      {/* ---------------- bags por lote ---------------- */}
      <ResumoBagsPorLote ordens={ordens} />

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
            cabecalho={[
              { texto: 'Seq', className: 'hidden lg:table-cell' }, 'Ordem',
              { texto: 'Cultivar', onClick: () => alternarOrdenacao('cultivar'), ordem: setaOrdem('cultivar') },
              { texto: 'Tratamento', onClick: () => alternarOrdenacao('tratamento'), ordem: setaOrdem('tratamento') },
              { texto: 'Emb.', className: 'hidden lg:table-cell' },
              { texto: 'Lote', className: 'hidden lg:table-cell' },
              { texto: 'Endereço', className: 'hidden lg:table-cell' },
              '#Bags',
              { texto: '#Peso', onClick: () => alternarOrdenacao('peso'), ordem: setaOrdem('peso') },
              { texto: 'Cliente', className: 'hidden lg:table-cell' },
              { texto: 'Status', onClick: () => alternarOrdenacao('status'), ordem: setaOrdem('status') },
              '',
            ]}
          >
            {porDia.map(([dia, lista]) => (
              <FragmentoDia
                key={dia}
                dia={dia}
                lista={lista}
                maquinas={maquinas}
                ordenacao={ordenacao}
                podeEditar={podeEditarOrdem}
                podeExcluir={podeExcluir}
                podePriorizar={podePriorizar}
                onEditar={(o) => {
                  setEditando(o)
                  window.scrollTo({ top: 0, behavior: 'smooth' })
                }}
                onExcluir={(id) =>
                  comErro(async () => {
                    if (!confirm('Excluir esta ordem?')) return
                    await g.excluirOrdem(id)
                  })
                }
                onPrioridade={(id, p) =>
                  comErro(() => g.definirPrioridade(id, p, usuario!.id))
                }
                onRenumerar={(o) => setRenumerando(o)}
                onConfirmar={(id) => comErro(() => g.confirmarOrdem(id, usuario!.id))}
                onAbrir={abrirOrdem}
                abrindoId={abrindoId}
                onForaBalanco={(o) => comErro(() => g.definirForaBalanco(o.id, !o.fora_balanco))}
              />
            ))}
          </Tabela>
        )}
      </Cartao>

      {renumerando && (
        <ModalRenumerar
          ordem={renumerando}
          onFechar={() => setRenumerando(null)}
          onSalvar={(numero) =>
            comErro(async () => {
              await g.atualizarOrdem(renumerando.id, { numero })
              setRenumerando(null)
            })
          }
        />
      )}

      {ordemAberta && (
        <ModalOrdem
          ordem={ordemAberta}
          produtos={produtos}
          motivos={motivos}
          podeApontar={permitido('execucao', 'apontar')}
          agora={Date.now()}
          capacidadeTh={maquinas.find((m) => m.id === ordemAberta.maquina_id)?.capacidade_th}
          conferencia={conferencias.find((c) => c.ordem_id === ordemAberta.id) ?? null}
          onFechar={() => setOrdemAberta(null)}
          onMudou={async () => {
            await recarregar()
            const o = await api.carregarOrdemPorId(ordemAberta.id)
            if (o) setOrdemAberta(o)
          }}
        />
      )}
    </Pagina>
  )
}

/**
 * Única correção liberada numa ordem já em produção/parada: o número. Os
 * outros campos (cultivar, receita, bags, lote, máquina, dia) continuam
 * travados pelo gatilho de imutabilidade — este modal só manda `numero`,
 * de propósito, para nunca tentar mudar mais que isso.
 */
function ModalRenumerar({
  ordem, onFechar, onSalvar,
}: {
  ordem: OrdemVisao
  onFechar: () => void
  onSalvar: (numero: string) => void
}) {
  const [numero, setNumero] = useState(ordem.numero)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-sm rounded-lg bg-white p-5 shadow-xl dark:bg-stone-900">
        <h3 className="text-base font-semibold text-stone-900 dark:text-stone-100">
          Renumerar ordem
        </h3>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          A ordem já está {ordem.status_efetivo.toLowerCase()} — só o número muda; os demais
          campos continuam travados.
        </p>
        <label className="mt-4 block text-xs text-stone-500">
          Número da ordem
          <input
            autoFocus
            value={numero}
            onChange={(e) => setNumero(e.target.value)}
            className="mt-1 block w-full rounded-md border border-stone-300 px-2 py-2 text-sm dark:border-stone-700 dark:bg-stone-800"
          />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onFechar}
            className="rounded-md px-3 py-1.5 text-sm text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            Cancelar
          </button>
          <button
            disabled={!numero.trim() || numero.trim() === ordem.numero}
            onClick={() => onSalvar(numero.trim())}
            className="rounded-md bg-stone-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900"
          >
            Salvar
          </button>
        </div>
      </div>
    </div>
  )
}

type CampoOrdenacaoDemanda = 'pedido' | 'aguardando' | 'estoque' | 'planejado' | 'falta' | 'sobra'

/** Valor bruto ou derivado de cada coluna numérica, para o clique no cabeçalho ordenar. */
function valorCampoDemanda(b: BalancoLinha, campo: CampoOrdenacaoDemanda): number {
  switch (campo) {
    case 'pedido': return b.pedido_aprovado
    case 'aguardando': return b.pedido_pendente
    case 'estoque': return b.estoque_pa
    case 'planejado': return b.ordens_abertas
    case 'falta': return bagsFaltando(b)
    case 'sobra': return bagsSobrando(b)
  }
}

/**
 * Fechado, mostra só a contagem — nunca os chips: com muita coisa marcada
 * (ex.: 23 tratamentos) a caixa virava uma parede de várias linhas cobrindo
 * a tela (achado do Arion, 18/08/2026). Clicar abre o editor: campo de
 * busca + chips removíveis + lista. Aí funciona como campo de tags: digita
 * pra filtrar, ↑/↓ move o destaque (rolando a lista pra acompanhar), Espaço
 * alterna o destacado quando a busca está vazia (igual ao Excel, que nem
 * tem campo de texto ali — com busca em andamento o espaço volta a ser
 * texto, porque nome de tratamento/cultivar tem espaço no meio), Enter
 * também alterna, Backspace com a busca vazia apaga a última selecionada.
 */
function SeletorMultiplo({
  rotulo, opcoes, selecionados, onMudar,
}: {
  rotulo: string
  opcoes: string[]
  selecionados: string[]
  onMudar: (s: string[]) => void
}) {
  const [aberto, setAberto] = useState(false)
  const [busca, setBusca] = useState('')
  const [destacado, setDestacado] = useState(0)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  // ↑/↓ rola a lista (scrollIntoView) e o cursor do mouse, parado, passa a
  // sobrepor um item DIFERENTE — o navegador dispara mouseenter mesmo sem o
  // mouse se mexer, e o destaque "voltava pra cima do nada" no meio da
  // navegação por teclado (achado do Arion, 18/08/2026). Só deixa o hover
  // mudar o destaque depois de um mousemove de verdade.
  const mouseAtivo = useRef(true)

  const filtradas = useMemo(
    () => opcoes.filter((o) => o.toLowerCase().includes(busca.trim().toLowerCase())),
    [opcoes, busca],
  )

  useEffect(() => {
    if (!aberto) return
    const aoClicarFora = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setAberto(false)
    }
    document.addEventListener('mousedown', aoClicarFora)
    return () => document.removeEventListener('mousedown', aoClicarFora)
  }, [aberto])

  // a busca muda o tamanho da lista filtrada — o destaque não pode ficar
  // apontando para um índice que não existe mais
  useEffect(() => {
    setDestacado((d) => Math.min(d, Math.max(0, filtradas.length - 1)))
  }, [filtradas.length])

  // ↑/↓ move o destaque mas a lista tem overflow-y-auto: sem isto, passar do
  // que já está visível parecia travado — o destaque ia embora da tela e
  // nada mostrava que a seta continuava funcionando
  useEffect(() => {
    if (!aberto) return
    itemRefs.current[destacado]?.scrollIntoView({ block: 'nearest' })
  }, [destacado, aberto])

  function alternar(v: string) {
    onMudar(selecionados.includes(v) ? selecionados.filter((s) => s !== v) : [...selecionados, v])
  }

  function aoTeclar(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      mouseAtivo.current = false
      setDestacado((d) => Math.min(d + 1, filtradas.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      mouseAtivo.current = false
      setDestacado((d) => Math.max(d - 1, 0))
    } else if (e.key === ' ' && busca === '') {
      e.preventDefault()
      const alvo = filtradas[destacado]
      if (alvo) alternar(alvo)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const alvo = filtradas[destacado]
      if (alvo) alternar(alvo)
    } else if (e.key === 'Backspace' && busca === '' && selecionados.length > 0) {
      onMudar(selecionados.slice(0, -1))
    } else if (e.key === 'Escape') {
      setAberto(false)
    }
  }

  if (!aberto) {
    return (
      <button
        type="button"
        onClick={() => setAberto(true)}
        className={`rounded-md border px-3 py-1.5 text-xs ${
          selecionados.length > 0
            ? 'border-stone-800 bg-stone-800 text-white dark:border-stone-200 dark:bg-stone-200 dark:text-stone-900'
            : 'border-stone-300 text-stone-600 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800'
        }`}
      >
        {rotulo}{selecionados.length > 0 ? ` (${selecionados.length})` : ''} ▾
      </button>
    )
  }

  return (
    <div ref={ref} className="relative">
      <div className="flex min-w-40 max-w-xs flex-wrap items-center gap-1 rounded-md border border-stone-800 px-2 py-1 text-xs dark:border-stone-200">
        <span className="text-stone-500">{rotulo}</span>
        {selecionados.map((s) => (
          <span
            key={s}
            className="flex items-center gap-1 rounded bg-stone-800 px-1.5 py-0.5 text-white dark:bg-stone-200 dark:text-stone-900"
          >
            {s}
            <button
              type="button"
              onClick={() => alternar(s)}
              title="Remover"
              className="leading-none"
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          autoFocus
          value={busca}
          onChange={(e) => {
            setBusca(e.target.value)
            setDestacado(0)
          }}
          onKeyDown={aoTeclar}
          placeholder={selecionados.length === 0 ? 'buscar…' : ''}
          className="min-w-16 flex-1 bg-transparent outline-none"
        />
      </div>
      <div
        onMouseMove={() => { mouseAtivo.current = true }}
        className="absolute z-20 mt-1 max-h-72 w-64 overflow-y-auto rounded-md border border-stone-300 bg-white p-1 shadow-lg dark:border-stone-700 dark:bg-stone-900"
      >
        {selecionados.length > 0 && (
          <button
            type="button"
            onClick={() => onMudar([])}
            className="mb-1 block w-full px-2 py-1 text-left text-xs text-stone-500 underline"
          >
            limpar seleção
          </button>
        )}
        {filtradas.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-stone-400">nada encontrado</p>
        ) : (
          filtradas.map((o, i) => (
            <button
              key={o}
              ref={(el) => { itemRefs.current[i] = el }}
              type="button"
              onClick={() => alternar(o)}
              onMouseEnter={() => { if (mouseAtivo.current) setDestacado(i) }}
              className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm ${
                i === destacado ? 'bg-stone-100 dark:bg-stone-800' : ''
              }`}
            >
              <input
                type="checkbox"
                checked={selecionados.includes(o)}
                readOnly
                className="pointer-events-none"
              />
              {o}
            </button>
          ))
        )}
      </div>
    </div>
  )
}

/**
 * Demanda × Estoque × Planejado.
 *
 * O `saldo` sozinho engana: positivo é trabalho a fazer, negativo é bag que vai
 * sobrar sem comprador. São leituras opostas, então a tabela rotula a situação
 * de cada linha e o topo resume os dois totais separados.
 */
function PainelDemanda({
  balanco: balancoTodo,
  foraDoBalanco,
}: {
  balanco: BalancoLinha[]
  /** Embalagens de peso fixo (saco 10/20 kg): pedido/saldo fora dos ERPs — mesma isenção do SEM TSI. */
  foraDoBalanco: Set<string>
}) {
  // SEM TSI (semente branca) nunca tem pedido_venda/estoque_pa por desenho —
  // essa demanda é rastreada por lotes_semente, fora deste painel de
  // tratamento. Sem este filtro toda ordem SEM TSI programada aparecia aqui
  // como "sem pedido", um alarme falso — o mesmo problema que já foi
  // corrigido nos avisos de criar ordem (`ehSemTsi` em `analisaDemanda`),
  // só que `situacaoDemanda` (usada só aqui) nunca tinha ganho a mesma
  // correção. Embalagem de peso fixo é o mesmo raciocínio, pela embalagem.
  const balanco = useMemo(
    () => balancoTodo.filter((b) => !ehSemTsi(b.tratamento) && !foraDoBalanco.has(b.embalagem)),
    [balancoTodo, foraDoBalanco],
  )

  // Filtro/ordenação sobrevivem a recarregar (`useRascunho`, mesmo padrão da
  // aba de Cadastros): sem isto, qualquer atualização em tempo real de
  // `ordens` (que é constante) desmontava e remontava a tela ao navegar para
  // fora e voltar, e a seleção sumia — achado do Arion, 18/08/2026. Sets não
  // sobrevivem a JSON.stringify (viram `{}`), por isso os dois filtros
  // guardam array, não Set.
  const rasc = useRascunho<{
    filtro: 'tudo' | SituacaoDemanda | 'sem-receita'
    cultivares: string[]
    tratamentos: string[]
    ordenacao: { campo: CampoOrdenacaoDemanda; dir: 'asc' | 'desc' } | null
  }>('ordens-demanda-filtro', { filtro: 'tudo', cultivares: [], tratamentos: [], ordenacao: null })
  const { filtro, cultivares: cultivarSel, tratamentos: tratamentoSel, ordenacao } = rasc.valor
  const setFiltro = (v: typeof filtro) => rasc.definir({ filtro: v })
  const setCultivarSel = (v: string[]) => rasc.definir({ cultivares: v })
  const setTratamentoSel = (v: string[]) => rasc.definir({ tratamentos: v })

  // a tabela é comprida; nasce oculto, e a preferência (inclusive a de
  // mostrar) sobrevive ao recarregamento
  const [oculto, setOculto] = useState(
    () => localStorage.getItem('tsi.demanda.oculta') !== '0',
  )
  const alternar = () => {
    const v = !oculto
    setOculto(v)
    localStorage.setItem('tsi.demanda.oculta', v ? '1' : '0')
  }

  const alternarOrdenacao = (campo: CampoOrdenacaoDemanda) =>
    rasc.definir({
      ordenacao:
        !ordenacao || ordenacao.campo !== campo
          ? { campo, dir: 'asc' }
          : ordenacao.dir === 'asc'
            ? { campo, dir: 'desc' }
            : null,
    })
  const setaOrdem = (campo: CampoOrdenacaoDemanda): 'asc' | 'desc' | undefined =>
    ordenacao?.campo === campo ? ordenacao.dir : undefined

  const cultivares = useMemo(
    () => [...new Set(balanco.map((b) => b.cultivar))].sort(),
    [balanco],
  )
  const tratamentos = useMemo(
    () => [...new Set(balanco.map((b) => b.tratamento))].sort(),
    [balanco],
  )

  const resumo = useMemo(() => resumoBalanco(balanco), [balanco])

  const linhas = useMemo(() => {
    let lista =
      filtro === 'tudo'
        ? balanco
        : filtro === 'sem-receita'
          ? balanco.filter((b) => !b.receita_cadastrada)
          : balanco.filter((b) => situacaoDemanda(b) === filtro)
    if (cultivarSel.length > 0) lista = lista.filter((b) => cultivarSel.includes(b.cultivar))
    if (tratamentoSel.length > 0) lista = lista.filter((b) => tratamentoSel.includes(b.tratamento))
    return lista
      .slice()
      .sort((a, b) => {
        if (ordenacao) {
          const diff = valorCampoDemanda(a, ordenacao.campo) - valorCampoDemanda(b, ordenacao.campo)
          return ordenacao.dir === 'asc' ? diff : -diff
        }
        // sem coluna escolhida: maior descoberto primeiro; ao filtrar sobra,
        // o maior excesso vem no topo
        return filtro === 'tudo' ? b.saldo - a.saldo : a.saldo - b.saldo
      })
  }, [balanco, filtro, cultivarSel, tratamentoSel, ordenacao])

  const filtroAtivo =
    filtro !== 'tudo' || cultivarSel.length > 0 || tratamentoSel.length > 0 || ordenacao !== null
  const limparFiltros = () =>
    rasc.substituir({ filtro: 'tudo', cultivares: [], tratamentos: [], ordenacao: null })

  const semReceita = balanco.filter((b) => !b.receita_cadastrada).length
  const chips: { id: typeof filtro; texto: string; ativo: boolean }[] = [
    { id: 'tudo', texto: `Tudo (${balanco.length})`, ativo: true },
    { id: 'descoberto', texto: `Falta produzir (${resumo.combosFaltando})`, ativo: resumo.combosFaltando > 0 },
    { id: 'sobra', texto: `Vai sobrar (${resumo.combosSobrando})`, ativo: resumo.combosSobrando > 0 },
    { id: 'sem-pedido', texto: `Sem pedido (${resumo.combosSemPedido})`, ativo: resumo.combosSemPedido > 0 },
    { id: 'sem-receita', texto: `Sem receita (${semReceita})`, ativo: semReceita > 0 },
  ]

  // recolhido: só o título e a linha-resumo — a informação crítica continua à
  // vista. Fica DEPOIS de todos os hooks: retorno antecipado antes de um hook
  // quebra a regra do React (foi o que derrubou o lint no CI).
  if (oculto) {
    return (
      <Cartao
        titulo="Demanda × Estoque × Planejado"
        acoes={<Botao onClick={alternar}>Mostrar</Botao>}
        className="mb-5"
      >
        {balanco.length === 0 ? (
          <p className="text-sm text-stone-500">Nenhuma carga de demanda importada ainda.</p>
        ) : (
          <p className="text-sm text-stone-600 dark:text-stone-300">
            Falta produzir <b>{inteiro(resumo.faltando)} bg</b>
            {resumo.sobrando > 0 && (
              <> · vai sobrar{' '}
                <b className="text-amber-600 dark:text-amber-400">
                  {inteiro(resumo.sobrando)} bg
                </b>
              </>
            )}
            {resumo.semPedido > 0 && (
              <> · sem pedido{' '}
                <b className="text-red-600 dark:text-red-400">
                  {inteiro(resumo.semPedido)} bg
                </b>
              </>
            )}
          </p>
        )}
      </Cartao>
    )
  }

  return (
    <Cartao
      titulo="Demanda × Estoque × Planejado"
      acoes={<Botao onClick={alternar}>Ocultar</Botao>}
      className="mb-5"
    >
      {balanco.length === 0 ? (
        <Vazio>
          Nenhuma carga de demanda importada ainda. Suba o relatório
          “Pedidos Analítico Resumido” e a exportação de “Saldos” da SimpleAgro no botão
          Importar planilha acima.
        </Vazio>
      ) : (
        <>
          {/* totais: falta produzir vs vai sobrar */}
          <div className="mb-3 grid gap-2 sm:grid-cols-3">
            <Placar
              rotulo="Falta produzir"
              valor={resumo.faltando}
              detalhe={`${resumo.combosFaltando} combinação(ões) sem cobertura`}
              cor="neutro"
            />
            <Placar
              rotulo="Vai sobrar"
              valor={resumo.sobrando}
              detalhe={
                resumo.sobrando > 0
                  ? `${resumo.combosSobrando} combinação(ões) acima do pedido`
                  : 'nada acima do pedido aprovado'
              }
              cor={resumo.sobrando > 0 ? 'alerta' : 'ok'}
            />
            <Placar
              rotulo="Sem pedido nenhum"
              valor={resumo.semPedido}
              detalhe={
                resumo.semPedido > 0
                  ? `${resumo.combosSemPedido} combinação(ões) em estoque ou programadas`
                  : 'tudo tem pedido aprovado'
              }
              cor={resumo.semPedido > 0 ? 'perigo' : 'ok'}
            />
          </div>

          <div className="mb-3 flex flex-wrap gap-1.5">
            {chips
              .filter((c) => c.ativo)
              .map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setFiltro(c.id)}
                  className={`rounded border px-2 py-1 text-xs ${
                    filtro === c.id
                      ? 'border-stone-800 bg-stone-800 text-white dark:border-stone-200 dark:bg-stone-200 dark:text-stone-900'
                      : 'border-stone-300 text-stone-600 hover:bg-stone-100 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800'
                  }`}
                >
                  {c.texto}
                </button>
              ))}
          </div>

          <div className="mb-3 flex flex-wrap gap-2">
            {cultivares.length > 1 && (
              <SeletorMultiplo
                rotulo="Cultivar"
                opcoes={cultivares}
                selecionados={cultivarSel}
                onMudar={setCultivarSel}
              />
            )}
            {tratamentos.length > 1 && (
              <SeletorMultiplo
                rotulo="Tratamento"
                opcoes={tratamentos}
                selecionados={tratamentoSel}
                onMudar={setTratamentoSel}
              />
            )}
            {filtroAtivo && (
              <button
                type="button"
                onClick={limparFiltros}
                className="rounded-md border border-stone-300 px-3 py-1.5 text-xs text-stone-600 underline hover:bg-stone-100 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
              >
                Limpar filtros
              </button>
            )}
          </div>

          {linhas.length === 0 ? (
            <Vazio>Nenhuma combinação nesse filtro.</Vazio>
          ) : (
            <Tabela
              cabecalho={[
                'Cultivar', 'Tratamento', 'Emb.',
                { texto: '#Pedido', onClick: () => alternarOrdenacao('pedido'), ordem: setaOrdem('pedido') },
                { texto: '#Aguardando', onClick: () => alternarOrdenacao('aguardando'), ordem: setaOrdem('aguardando') },
                { texto: '#Estoque', onClick: () => alternarOrdenacao('estoque'), ordem: setaOrdem('estoque') },
                { texto: '#Planejado', onClick: () => alternarOrdenacao('planejado'), ordem: setaOrdem('planejado') },
                { texto: '#Falta', onClick: () => alternarOrdenacao('falta'), ordem: setaOrdem('falta') },
                { texto: '#Sobra', onClick: () => alternarOrdenacao('sobra'), ordem: setaOrdem('sobra') },
                'Situação',
              ]}
            >
              {linhas.map((b, i) => {
                const s = situacaoDemanda(b)
                const falta = bagsFaltando(b)
                const sobra = bagsSobrando(b)
                return (
                  <tr key={i} className="border-t border-stone-100 dark:border-stone-800/60">
                    <td className="px-2 py-1.5">{b.cultivar}</td>
                    <td className="px-2 py-1.5">{b.tratamento}</td>
                    <td className="whitespace-nowrap px-2 py-1.5"><Emb codigo={b.embalagem} /></td>
                    <td className="num-tabular px-2 py-1.5 text-right">
                      {inteiro(b.pedido_aprovado)}
                      {(b.pedido_cooperado ?? 0) > 0 && (
                        <div
                          className="whitespace-nowrap text-xs font-medium text-amber-600 dark:text-amber-400"
                          title="Parcela do pedido aprovado que é VENDA COOPERADO (coluna Tipo Venda da SimpleAgro)"
                        >
                          {inteiro(b.pedido_cooperado ?? 0)} coop.
                        </div>
                      )}
                    </td>
                    <td className="num-tabular px-2 py-1.5 text-right text-stone-400">
                      {inteiro(b.pedido_pendente)}
                      {(b.pedido_cooperado_pendente ?? 0) > 0 && (
                        <div
                          className="whitespace-nowrap text-xs font-medium text-amber-600 dark:text-amber-400"
                          title="Parcela do pedido aguardando liberação financeira que é VENDA COOPERADO"
                        >
                          {inteiro(b.pedido_cooperado_pendente ?? 0)} coop.
                        </div>
                      )}
                    </td>
                    <td className="num-tabular px-2 py-1.5 text-right">{inteiro(b.estoque_pa)}</td>
                    <td className="num-tabular px-2 py-1.5 text-right">{inteiro(b.ordens_abertas)}</td>
                    <td className="num-tabular px-2 py-1.5 text-right font-semibold">
                      {falta > 0 ? inteiro(falta) : <span className="text-stone-300">—</span>}
                    </td>
                    <td
                      className={`num-tabular px-2 py-1.5 text-right font-semibold ${
                        sobra > 0 ? 'text-amber-600 dark:text-amber-400' : ''
                      }`}
                    >
                      {sobra > 0 ? inteiro(sobra) : <span className="text-stone-300">—</span>}
                    </td>
                    <td className="whitespace-nowrap px-2 py-1.5">
                      <Tag cor={COR_SITUACAO[s]}>{ROTULO_SITUACAO[s]}</Tag>
                      {!b.receita_cadastrada && (
                        <span className="ml-1">
                          <Tag cor="alerta">sem receita</Tag>
                        </span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </Tabela>
          )}

          <p className="mt-2 text-xs text-stone-500">
            Pedido aprovado − estoque de produto acabado − ordens abertas. Ordem lançada no
            AGROTIS sai da conta e volta como estoque no próximo upload. Pedido aguardando
            aprovação financeira aparece, mas não cobre nada.
          </p>
        </>
      )}
    </Cartao>
  )
}

/** Ordem de exibição dos status — segue o ciclo de vida da ordem, não o alfabeto. */
const ORDEM_STATUS = [
  'Nao programada', 'Programada', 'Aguardando lote', 'Pronto para produzir',
  'Em producao', 'Parada', 'Finalizada', 'Qualidade apontada', 'Apontada',
]

/**
 * Quantos bags de cada lote estão em cada etapa (programado, em produção,
 * finalizado, apontado…) — a logística e o PCP perguntavam isso toda hora
 * sem ter onde olhar além de filtrar a lista ordem por ordem.
 */
interface EstadoConferenciaSap {
  carregando: boolean
  erro?: string
  saldo?: SaldoLoteSap
  /** a TSI_SALDOS tinha mais páginas além das 10 lidas — um "não achado"
   *  pode estar na parte não lida */
  saldoTemMais?: boolean
}

function ResumoBagsPorLote({ ordens }: { ordens: OrdemVisao[] }) {
  const [busca, setBusca] = useState('')
  // nasce oculto, e a preferência (inclusive a de mostrar) sobrevive ao recarregamento
  const [oculto, setOculto] = useState(
    () => localStorage.getItem('tsi.resumoLotes.oculta') !== '0',
  )
  const alternar = () => {
    const v = !oculto
    setOculto(v)
    localStorage.setItem('tsi.resumoLotes.oculta', v ? '1' : '0')
  }

  // teste pontual (12/08/2026): confere o saldo do lote direto no SAP de
  // produção, ao lado do total programado. Restrito à mesma lista da aba
  // "SAP (teste)" — é leitura de produção do SAP, mesma cautela de lá.
  const { session } = useAuth()
  const podeConferirSap = USUARIOS_SAP_TESTE.includes(
    (session?.user.email ?? '').toLowerCase(),
  )
  const [conferencias, setConferencias] = useState<Record<string, EstadoConferenciaSap>>({})

  // A TSI_SALDOS devolve TODOS os lotes com saldo, não um só — busca uma vez
  // por sessão da tela e reaproveita entre cliques em "Conferir" de lotes
  // diferentes. `-2028` aqui é erro de verdade (consulta não criada ainda /
  // problema real), nunca vira "0 linhas" silencioso.
  const saldosSapRef = useRef<{ dados: unknown; temMais: boolean } | null>(null)
  const carregarSaldosSap = useCallback(async (): Promise<{ dados: unknown; temMais: boolean }> => {
    if (saldosSapRef.current) return saldosSapRef.current
    const { data, error } = await supabase.functions.invoke('sap-teste', {
      body: { caminho: caminhoSaldoLotes(), paginas: 10, ambiente: 'producao' },
    })
    if (error) throw new Error(error.message)
    const r = data as { ok: boolean; erro?: string; sap?: unknown; dados?: unknown; temMais?: boolean }
    if (!r.ok) {
      const detalhe = r.sap ? ` — resposta do SAP: ${JSON.stringify(r.sap)}` : ''
      throw new Error((r.erro ?? 'SAP recusou a consulta.') + detalhe)
    }
    const resultado = { dados: r.dados, temMais: r.temMais ?? false }
    saldosSapRef.current = resultado
    return resultado
  }, [])

  const conferirNoSap = useCallback(async (loteId: string) => {
    setConferencias((s) => ({ ...s, [loteId]: { carregando: true } }))
    try {
      const { dados, temMais } = await carregarSaldosSap()
      setConferencias((s) => ({
        ...s,
        [loteId]: { carregando: false, saldo: saldoLoteDe(dados, loteId), saldoTemMais: temMais },
      }))
    } catch (e) {
      setConferencias((s) => ({
        ...s,
        [loteId]: { carregando: false, erro: e instanceof Error ? e.message : String(e) },
      }))
    }
  }, [carregarSaldosSap])

  const porLote = useMemo(() => {
    const mapa = new Map<
      string,
      {
        loteId: string
        cultivar: string
        total: number
        porStatus: Map<string, number>
        pesoKg: number
        pesoBagLoteKg: number
      }
    >()
    for (const o of ordens) {
      let e = mapa.get(o.lote_id)
      if (!e) {
        e = {
          loteId: o.lote_id, cultivar: o.cultivar, total: 0, porStatus: new Map(),
          pesoKg: 0, pesoBagLoteKg: o.peso_bag_kg,
        }
        mapa.set(o.lote_id, e)
      }
      e.total += o.bags
      e.pesoKg += o.peso_kg
      e.porStatus.set(o.status_efetivo, (e.porStatus.get(o.status_efetivo) ?? 0) + o.bags)
    }
    return [...mapa.values()].sort((a, b) => b.total - a.total)
  }, [ordens])

  const [conferindoTodos, setConferindoTodos] = useState(false)
  const conferirTodos = useCallback(async () => {
    if (conferindoTodos) return
    setConferindoTodos(true)
    // refetch de propósito: quem confere tudo quer o número de agora,
    // não o guardado de um clique anterior nesta mesma sessão da tela
    saldosSapRef.current = null
    const ids = porLote.map((l) => l.loteId)
    setConferencias(Object.fromEntries(ids.map((id) => [id, { carregando: true }])))
    try {
      const { dados, temMais } = await carregarSaldosSap()
      setConferencias(
        Object.fromEntries(
          ids.map((id) => [
            id,
            { carregando: false, saldo: saldoLoteDe(dados, id), saldoTemMais: temMais },
          ]),
        ),
      )
    } catch (e) {
      const erro = e instanceof Error ? e.message : String(e)
      setConferencias(Object.fromEntries(ids.map((id) => [id, { carregando: false, erro }])))
    }
    setConferindoTodos(false)
  }, [conferindoTodos, porLote, carregarSaldosSap])

  const filtrados = useMemo(() => {
    const termo = busca.trim().toLowerCase()
    if (!termo) return porLote
    return porLote.filter((l) => `${l.loteId} ${l.cultivar}`.toLowerCase().includes(termo))
  }, [porLote, busca])

  if (oculto) {
    return (
      <Cartao
        titulo="Bags por lote"
        acoes={<Botao onClick={alternar}>Mostrar</Botao>}
        className="mb-5"
      >
        <p className="text-sm text-stone-600 dark:text-stone-300">
          {porLote.length} lote(s) com ordem lançada.
        </p>
      </Cartao>
    )
  }

  return (
    <Cartao
      titulo="Bags por lote"
      acoes={
        <>
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="filtrar por lote ou cultivar…"
            className="rounded-md border border-stone-300 px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-800"
          />
          {podeConferirSap && (
            <Botao variante="primario" disabled={conferindoTodos} onClick={conferirTodos}>
              {conferindoTodos ? 'Conferindo…' : 'Conferir todos no SAP'}
            </Botao>
          )}
          <Botao onClick={alternar}>Ocultar</Botao>
        </>
      }
      className="mb-5"
    >
      {porLote.length === 0 ? (
        <Vazio>Nenhuma ordem lançada ainda.</Vazio>
      ) : filtrados.length === 0 ? (
        <Vazio>Nenhum lote nesse filtro.</Vazio>
      ) : (
        <>
        <Tabela
          cabecalho={
            podeConferirSap
              ? ['Lote', 'Cultivar', '#Total', 'Bags por status', 'SAP (produção)']
              : ['Lote', 'Cultivar', '#Total', 'Bags por status']
          }
        >
          {filtrados.map((l) => {
            const conf = conferencias[l.loteId]
            return (
              <tr key={l.loteId} className="border-t border-stone-100 dark:border-stone-800/60">
                <td className="px-2 py-1.5 font-medium">{l.loteId}</td>
                <td className="px-2 py-1.5">{l.cultivar}</td>
                <td className="num-tabular px-2 py-1.5 text-right font-semibold">
                  {inteiro(l.total)}
                </td>
                <td className="px-2 py-1.5">
                  <div className="flex flex-wrap gap-1">
                    {ORDEM_STATUS.filter((s) => l.porStatus.has(s)).map((s) => (
                      <Tag key={s} cor={corDoStatus(s)}>
                        {s}: {inteiro(l.porStatus.get(s)!)}
                      </Tag>
                    ))}
                  </div>
                </td>
                {podeConferirSap && (
                  <td className="px-2 py-1.5">
                    {!conf && (
                      <Botao onClick={() => conferirNoSap(l.loteId)}>Conferir</Botao>
                    )}
                    {conf?.carregando && (
                      <span className="text-xs text-stone-500 dark:text-stone-400">
                        consultando…
                      </span>
                    )}
                    {conf?.erro && (
                      <div className="flex flex-wrap items-center gap-1">
                        <Tag cor="perigo">{conf.erro}</Tag>
                        <Botao onClick={() => conferirNoSap(l.loteId)}>tentar de novo</Botao>
                      </div>
                    )}
                    {conf?.saldo && (() => {
                      // O SAP conta em bags DO LOTE (a embalagem original dele, ex.:
                      // big bag de 5 milhões) — "#Total" conta em bags DE CADA ORDEM,
                      // na embalagem que ELA escolheu. 2 ordens MEIOBAG (2,5 milhões)
                      // são 1 bag do lote, não 2 — comparar direto com #Total super-
                      // contava toda ordem MEIOBAG em 2× (relato do Arion, 13/08/2026).
                      // Peso já é por-ordem-embalagem (v_ordens); dividir pelo peso do
                      // BAG DO LOTE converte pra "quantos bags do lote" isso representa.
                      const totalBagsLote =
                        l.pesoBagLoteKg > 0 ? l.pesoKg / l.pesoBagLoteKg : l.total
                      const divergeDoTotal = Math.round(totalBagsLote) !== l.total
                      return (
                        <>
                          {conf.saldo.encontrados === 0 && (
                            <div className="flex flex-wrap items-center gap-1">
                              <Tag cor="alerta">sem saldo no SAP</Tag>
                              {totalBagsLote > 0 && (
                                <Tag cor="perigo">
                                  saldo {n(totalBagsLote, 1)} bg do lote ABAIXO do planejado
                                </Tag>
                              )}
                              <Botao onClick={() => conferirNoSap(l.loteId)}>tentar de novo</Botao>
                              <p className="w-full text-[11px] text-stone-400 dark:text-stone-500">
                                {conf.saldo.totalLinhasSaldo === 0
                                  ? 'a TSI_SALDOS devolveu 0 linhas no total (não é só este lote)'
                                  : `a TSI_SALDOS trouxe ${inteiro(conf.saldo.totalLinhasSaldo)} linha(s); nenhuma com o lote "${l.loteId}"${conf.saldo.amostraBatchNum.length ? ` — ex.: ${conf.saldo.amostraBatchNum.join(', ')}` : ''}${conf.saldoTemMais ? ' · havia mais páginas não lidas' : ''}`}
                              </p>
                            </div>
                          )}
                          {conf.saldo.encontrados > 0 && (
                            <div className="text-xs">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <p className="num-tabular font-semibold text-stone-900 dark:text-stone-100">
                                  SAP: {n(conf.saldo.quantidadeTotal, 0)}
                                  {conf.saldo.pms != null && ` · PMS ${n(conf.saldo.pms, 0)}`}
                                </p>
                                {(() => {
                                  // Ordem já produzida consumiu o lote, então divergência
                                  // aqui é ponto de atenção pra conferir, não veredito
                                  // automático.
                                  const dif = Math.round(conf.saldo.quantidadeTotal - totalBagsLote)
                                  if (dif === 0) return <Tag cor="ok">bate com o planejado</Tag>
                                  if (dif < 0)
                                    return (
                                      <Tag cor="perigo">
                                        saldo {inteiro(-dif)} bg ABAIXO do planejado
                                      </Tag>
                                    )
                                  return (
                                    <Tag cor="alerta">saldo {inteiro(dif)} bg acima do planejado</Tag>
                                  )
                                })()}
                              </div>
                              <p className="text-stone-500 dark:text-stone-400">
                                {conf.saldo.tratamentoSap ?? '—'} · {conf.saldo.itemCodes.join(', ') || '—'}
                              </p>
                            </div>
                          )}
                          {divergeDoTotal && (
                            <p className="w-full text-[11px] text-stone-400 dark:text-stone-500">
                              planejado em bags do lote: {n(totalBagsLote, 1)} (≠ #Total{' '}
                              {inteiro(l.total)} — tem ordem em embalagem diferente da do lote)
                            </p>
                          )}
                        </>
                      )
                    })()}
                  </td>
                )}
              </tr>
            )
          })}
        </Tabela>
        {podeConferirSap && (
          <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">
            "SAP" é a quantidade em estoque da consulta TSI_SALDOS (produção), somada entre
            os depósitos do lote — ainda sem conversão de unidade. É uma conferência manual,
            não substitui o total programado.
          </p>
        )}
        </>
      )}
    </Cartao>
  )
}

/**
 * Código comercial de cada embalagem (BG5M → BB5M, MEIOBAG → BMB), derivado
 * do de-para da importação. O painel mostra os dois porque o PCP e o
 * comercial falam BMB enquanto o app fala MEIOBAG — quem procura um código
 * tem que achar pelo outro.
 */
const CODIGO_COMERCIAL: Record<string, string> = Object.fromEntries(
  Object.entries(EMBALAGEM_DEPARA).map(([comercial, v]) => [v.codigo, comercial]),
)

function Emb({ codigo }: { codigo: string }) {
  const comercial = CODIGO_COMERCIAL[codigo]
  return (
    <>
      {codigo}
      {comercial && <span className="text-stone-400"> · {comercial}</span>}
    </>
  )
}

const ROTULO_SITUACAO: Record<SituacaoDemanda, string> = {
  descoberto: 'falta produzir',
  coberto: 'coberto',
  sobra: 'vai sobrar',
  'sem-pedido': 'sem pedido',
}

const COR_SITUACAO: Record<SituacaoDemanda, 'neutro' | 'ok' | 'alerta' | 'perigo' | 'info'> = {
  descoberto: 'info',
  coberto: 'ok',
  sobra: 'alerta',
  'sem-pedido': 'perigo',
}

function Placar({
  rotulo, valor, detalhe, cor,
}: {
  rotulo: string
  valor: number
  detalhe: string
  cor: 'neutro' | 'ok' | 'alerta' | 'perigo'
}) {
  const borda = {
    neutro: 'border-stone-200 dark:border-stone-800',
    ok: 'border-emerald-200 dark:border-emerald-900',
    alerta: 'border-amber-300 dark:border-amber-800',
    perigo: 'border-red-300 dark:border-red-800',
  }[cor]
  const numero = {
    neutro: 'text-stone-800 dark:text-stone-100',
    ok: 'text-emerald-700 dark:text-emerald-400',
    alerta: 'text-amber-700 dark:text-amber-400',
    perigo: 'text-red-700 dark:text-red-400',
  }[cor]
  return (
    <div className={`rounded border px-3 py-2 ${borda}`}>
      <p className="text-xs text-stone-500">{rotulo}</p>
      <p className={`num-tabular text-xl font-semibold ${numero}`}>
        {inteiro(valor)} <span className="text-xs font-normal text-stone-500">bg</span>
      </p>
      <p className="text-xs text-stone-500">{detalhe}</p>
    </div>
  )
}

/** Botões de ação da linha da ordem — mesmas cores do Botao, tamanho compacto para caber na tabela. */
const BOTAO_ACAO =
  'shrink-0 rounded-md border border-stone-300 px-2 py-1 text-xs font-medium transition-colors hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800'
const BOTAO_ACAO_PERIGO =
  'shrink-0 rounded-md border border-red-300 px-2 py-1 text-xs font-medium text-red-700 transition-colors hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950/40'

/** Compara duas ordens pelo campo escolhido — usado só dentro de cada
 *  máquina; a sequência real (`seq`) continua intacta, isto é só exibição. */
function comparadorOrdenacao(
  ordenacao: { campo: 'cultivar' | 'tratamento' | 'status' | 'peso'; dir: 'asc' | 'desc' } | null,
): ((a: OrdemVisao, b: OrdemVisao) => number) | null {
  if (!ordenacao) return null
  const sinal = ordenacao.dir === 'asc' ? 1 : -1
  switch (ordenacao.campo) {
    case 'cultivar':
      return (a, b) => sinal * a.cultivar.localeCompare(b.cultivar)
    case 'tratamento':
      return (a, b) => sinal * a.receita_nome.localeCompare(b.receita_nome)
    case 'status':
      return (a, b) => sinal * a.status_efetivo.localeCompare(b.status_efetivo)
    case 'peso':
      return (a, b) => sinal * (a.peso_t - b.peso_t)
  }
}

function FragmentoDia({
  dia, lista, maquinas, ordenacao, podeEditar, podeExcluir, podePriorizar,
  onEditar, onExcluir, onPrioridade, onRenumerar, onConfirmar, onAbrir, abrindoId,
  onForaBalanco,
}: {
  dia: string
  lista: OrdemVisao[]
  maquinas: api.LinhaMaquina[]
  ordenacao: { campo: 'cultivar' | 'tratamento' | 'status' | 'peso'; dir: 'asc' | 'desc' } | null
  podeEditar: boolean
  podeExcluir: boolean
  podePriorizar: boolean
  onEditar: (o: OrdemVisao) => void
  onExcluir: (id: string) => void
  onPrioridade: (id: string, p: 'Normal' | 'Urgente') => void
  onRenumerar: (o: OrdemVisao) => void
  onConfirmar: (id: string) => void
  /** Abre o detalhe completo (tempos, tanques, produzido, conferência) — qualquer status. */
  onAbrir: (id: string) => void
  abrindoId: string | null
  /** Alterna a marcação "não entra no estoque" (sacaria) — qualquer status exceto Apontada. */
  onForaBalanco: (o: OrdemVisao) => void
}) {
  const totalT = lista.reduce((a, o) => a + o.peso_t, 0)

  // sub-agrupamento por máquina (pedido do Arion, 13/08/2026) — a lista já
  // chega ordenada por maquina_id/seq (listarOrdens), então o Map preserva
  // essa mesma ordem por padrão; "Sem máquina" (pool, ainda não programada)
  // vai por último, depois das máquinas do cadastro.
  const porMaquina = new Map<string, OrdemVisao[]>()
  for (const o of lista) {
    const chave = o.maquina_id ?? '__sem__'
    const g = porMaquina.get(chave)
    if (g) g.push(o)
    else porMaquina.set(chave, [o])
  }
  const nomeMaquina = (id: string) =>
    id === '__sem__' ? 'Sem máquina' : (maquinas.find((m) => m.id === id)?.nome ?? id)
  const grupos = [...porMaquina.entries()].sort(([a], [b]) => {
    if (a === '__sem__') return 1
    if (b === '__sem__') return -1
    return nomeMaquina(a).localeCompare(nomeMaquina(b))
  })
  const comparador = comparadorOrdenacao(ordenacao)

  return (
    <>
      {/* o corpo esconde 5 colunas em <lg (Seq, Emb., Lote, Endereço,
          Cliente); a faixa do dia precisa esconder as mesmas trilhas, senão
          força a tabela a 12 colunas e o total flutua desalinhado à direita
          das ações, criando rolagem para colunas fantasmas — mesmo padrão da
          célula-fantasma da Execução */}
      <tr className="bg-stone-100/70 dark:bg-stone-800/40">
        <td colSpan={4} className="px-2 py-1.5 text-xs font-semibold uppercase">
          {dia === 'sem-dia' ? 'Sem dia programado' : `Dia ${diaCurto(dia)}`}
        </td>
        <td className="hidden lg:table-cell" colSpan={4} />
        <td className="num-tabular px-2 py-1.5 text-right text-xs font-semibold whitespace-nowrap">
          {n(totalT, 1)} t
        </td>
        <td className="hidden lg:table-cell" />
        <td colSpan={2} />
      </tr>
      {grupos.map(([maquinaId, ordensMaquina]) => {
        const linhas = comparador ? [...ordensMaquina].sort(comparador) : ordensMaquina
        const totalMaquina = ordensMaquina.reduce((a, o) => a + o.peso_t, 0)
        return (
          <Fragment key={maquinaId}>
            {/* mesma estrutura de colSpan da faixa do dia, um nível mais leve */}
            <tr className="bg-stone-50/60 dark:bg-stone-800/20">
              <td colSpan={4} className="px-2 py-1 pl-4 text-xs font-medium text-stone-600 dark:text-stone-300">
                {nomeMaquina(maquinaId)} · {ordensMaquina.length} ordem(ns)
              </td>
              <td className="hidden lg:table-cell" colSpan={4} />
              <td className="num-tabular px-2 py-1 text-right text-xs font-medium whitespace-nowrap">
                {n(totalMaquina, 1)} t
              </td>
              <td className="hidden lg:table-cell" />
              <td colSpan={2} />
            </tr>
            {linhas.map((o) => {
              const st = o.status_efetivo as StatusEfetivo
              return (
                <tr key={o.id} className="border-t border-stone-100 dark:border-stone-800/60">
                  <td className="hidden px-2 py-1.5 text-stone-400 lg:table-cell">{o.seq ?? '—'}</td>
                  {/*
                    min-w: achado testando no celular (08/08/2026) — table-layout
                    auto distribuiu a largura livre (5 colunas escondidas) para
                    Status/ações em vez desta, que agora carrega a linha
                    secundária; sem piso a legenda quebrava em várias linhas e
                    inflava a altura da linha inteira.
                  */}
                  <td className="min-w-36 px-2 py-1.5 font-medium lg:min-w-0">
                    {o.numero}
                    {o.prioridade === 'Urgente' && <span className="ml-1"><Tag cor="perigo">urgente</Tag></span>}
                    {!!o.reprogramacoes && o.reprogramacoes > 0 && (
                      <span
                        className="ml-1 cursor-help text-xs font-normal text-amber-700 dark:text-amber-400"
                        title={`Reprogramada ${o.reprogramacoes}× — estava para ${diaCurto(o.data_prog_original ?? null)}`}
                      >
                        ↷{o.reprogramacoes}
                      </span>
                    )}
                    {/* lote/embalagem somem em lg: — mostra aqui embaixo. Endereço
                        saiu da linha: é o texto mais longo e essa é a Ordem do
                        PCP, não a separação (a Logística já tem endereço em
                        destaque na tela dela). */}
                    <p className="text-xs font-normal text-stone-500 lg:hidden">
                      {o.embalagem} · lote {o.lote_id}
                    </p>
                  </td>
                  <td className="px-2 py-1.5">{o.cultivar}</td>
                  <td className="px-2 py-1.5">{o.receita_nome}</td>
                  <td className="hidden px-2 py-1.5 lg:table-cell">{o.embalagem}</td>
                  <td className="hidden px-2 py-1.5 font-medium lg:table-cell">{o.lote_id}</td>
                  <td className="hidden px-2 py-1.5 text-xs text-stone-500 lg:table-cell">{enderecoLote(o)}</td>
                  <td className="num-tabular px-2 py-1.5 text-right">{o.bags}</td>
                  <td className="num-tabular px-2 py-1.5 text-right whitespace-nowrap">{n(o.peso_t, 1)} t</td>
                  <td className="hidden max-w-32 truncate px-2 py-1.5 text-stone-500 lg:table-cell">
                    {o.cliente ?? '—'}
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5">
                    <Tag cor={corDoStatus(st)}>{st}</Tag>
                    {o.fora_balanco && (
                      <span className="ml-1" title="Produção que não vira estoque (ex.: sacaria) — fora do balanço de demanda">
                        <Tag cor="roxo">sem estoque</Tag>
                      </span>
                    )}
                  </td>
                  {/*
                    editar+urgente+excluir como botão com borda pedem mais espaço
                    que o texto sublinhado de antes — por isso min-w-56, não
                    min-w-44. Continua valendo em qualquer largura: em lg:
                    aparecem MAIS colunas (Seq, Emb., Lote, Endereço, Cliente)
                    disputando espaço, não menos — zerar o mínimo ali seria o
                    oposto do que essa coluna precisa.
                  */}
                  <td className="min-w-56 px-2 py-1.5 text-right whitespace-nowrap">
                    <div className="inline-flex flex-wrap justify-end gap-1.5">
                      <button
                        onClick={() => onAbrir(o.id)}
                        disabled={abrindoId === o.id}
                        className={BOTAO_ACAO}
                        title="Tempos, tanques, bags produzidos e conferência da logística"
                      >
                        {abrindoId === o.id ? 'abrindo…' : 'detalhes'}
                      </button>
                      {podeEditar && pode(st, 'editar') && (
                        <button
                          onClick={() => onEditar(o)}
                          className={BOTAO_ACAO}
                          title="Editável enquanto a produção não toca a ordem"
                        >
                          editar
                        </button>
                      )}
                      {/* programar não expõe a ordem para a Logística baixar o lote —
                          só depois que o PCP confirma (11/08/2026) */}
                      {podeEditar && pode(st, 'confirmar') && (
                        <button
                          onClick={() => onConfirmar(o.id)}
                          className={BOTAO_ACAO}
                          title="Libera a ordem para a Logística ver e baixar o lote"
                        >
                          confirmar
                        </button>
                      )}
                      {/* única correção liberada numa ordem já tocada pela produção:
                          o número não entra em nenhum cálculo, então corrigi-lo não
                          distorce tempo/consumo — diferente dos outros campos, que
                          o gatilho de imutabilidade continua travando */}
                      {podeEditar && pode(st, 'renumerar') && (
                        <button
                          onClick={() => onRenumerar(o)}
                          className={BOTAO_ACAO}
                          title="Corrige o número da ordem mesmo em produção — os demais campos continuam travados"
                        >
                          renumerar
                        </button>
                      )}
                      {/* qualquer status exceto Apontada: apontada já saiu do
                          balanço sozinha, alternar não muda mais nada */}
                      {podeEditar && st !== 'Apontada' && (
                        <button
                          onClick={() => onForaBalanco(o)}
                          className={BOTAO_ACAO}
                          title={o.fora_balanco
                            ? 'Voltar a contar esta produção no estoque/balanço de demanda'
                            : 'Marcar como produção que NÃO vira estoque (ex.: sacaria) — sai do balanço de demanda; baixa do lote e execução seguem normais'}
                        >
                          {o.fora_balanco ? 'volta ao estoque' : 'sem estoque'}
                        </button>
                      )}
                      {podePriorizar && pode(st, 'priorizar') && (
                        <button
                          onClick={() => onPrioridade(o.id, o.prioridade === 'Urgente' ? 'Normal' : 'Urgente')}
                          className={BOTAO_ACAO}
                        >
                          {o.prioridade === 'Urgente' ? 'normal' : 'urgente'}
                        </button>
                      )}
                      {podeExcluir && pode(st, 'excluir') && (
                        <button onClick={() => onExcluir(o.id)} className={BOTAO_ACAO_PERIGO}>
                          excluir
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </Fragment>
        )
      })}
    </>
  )
}

/**
 * Criação e edição na mesma tela. `ordem` preenchida = modo edição, restrito
 * pela matriz de status a ordens que a produção ainda não tocou — o pai só
 * renderiza nesse caso, e o trigger de imutabilidade garante no banco.
 */
function NovaOrdemForm({
  lotes, receitas, embalagens, maquinas, ordens, balanco, ordem, aoFechar, onCriada,
}: {
  lotes: LoteSementeLinha[]
  receitas: ReceitaCompleta[]
  embalagens: g.EmbalagemLinha[]
  maquinas: api.LinhaMaquina[]
  ordens: OrdemVisao[]
  balanco: BalancoLinha[]
  ordem?: OrdemVisao | null
  aoFechar?: () => void
  onCriada: (msg: string) => void
}) {
  const editando = ordem ?? null

  // O que foi digitado sobrevive a sair da tela: a navegação desmonta o
  // componente e o React descartaria tudo. Chave por ordem na edição, para
  // dois rascunhos não se misturarem.
  const inicial = useMemo(
    () => ({
      numero: editando?.numero ?? '',
      loteId: editando?.lote_id ?? '',
      receitaId: editando?.receita_id ?? '',
      embalagem: editando?.embalagem ?? embalagens[0]?.codigo ?? '',
      bags: editando?.bags ?? 0,
      cliente: editando?.cliente ?? '',
      observacao: editando?.observacao ?? '',
      armazem: editando?.armazem ?? '',
      bloco: editando?.bloco ?? '',
      quadra: editando?.quadra ?? '',
      maquinaId: editando?.maquina_id ?? '',
      dataProg: editando?.data_prog ?? '',
      foraBalanco: editando?.fora_balanco ?? false,
    }),
    [editando, embalagens],
  )
  const chaveRascunho = editando ? `ordem.${editando.id}` : 'ordem.nova'
  const { valor: f, definir, limpar, recuperado } = useRascunho(chaveRascunho, inicial)
  const {
    numero, loteId, receitaId, embalagem, bags, cliente, observacao,
    armazem, bloco, quadra, maquinaId, dataProg, foraBalanco,
  } = f

  // rascunho com nº digitado reabre o formulário sozinho — senão o trabalho
  // ficaria escondido atrás do botão "Nova ordem". O contexto que sobra depois
  // de gravar (lote, endereço) não conta: não é trabalho pendente.
  const [aberto, setAberto] = useState(editando != null || f.numero.trim() !== '')
  const [buscaLote, setBuscaLote] = useState('')
  const [buscaTrat, setBuscaTrat] = useState('')
  const [erro, setErro] = useState<string | null>(null)

  const lote = lotes.find((l) => l.id === loteId)
  const receita = receitas.find((r) => r.id === receitaId)

  // com centenas de lotes o select puro não dá: filtro por texto acima de
  // cada um. O item já escolhido nunca some da lista.
  const lotesFiltrados = useMemo(() => {
    const termo = buscaLote.trim().toLowerCase()
    if (!termo) return lotes
    return lotes.filter(
      (l) =>
        l.id === loteId ||
        `${l.id} ${l.cultivar} ${l.tratamento ?? ''}`.toLowerCase().includes(termo),
    )
  }, [lotes, buscaLote, loteId])

  const receitasFiltradas = useMemo(() => {
    const termo = buscaTrat.trim().toLowerCase()
    if (!termo) return receitas
    return receitas.filter(
      (r) => r.id === receitaId || r.nome.toLowerCase().includes(termo),
    )
  }, [receitas, buscaTrat, receitaId])

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
        // ordem fora do estoque (sacaria) não conta como "já planejado"
        // cobrindo pedido real — a produção dela não vira saldo
        .filter((o) => o.status_efetivo !== 'Apontada' && !o.fora_balanco &&
          o.cultivar === chave.cultivar &&
          o.receita_nome === chave.tratamento && o.embalagem === chave.embalagem)
        .map((o) => ({ ...chave, bags: o.bags })),
      true,
      // embalagem de peso fixo (saco 10/20 kg): pedido/saldo não existem nos
      // ERPs; ordem marcada fora do estoque (sacaria) idem — a família de
      // avisos "sem pedido" seria alarme falso sempre
      (embalagens.find((e) => e.codigo === embalagem)?.peso_fixo_kg ?? 0) > 0 || foraBalanco,
    )
  }, [lote, receita, embalagem, bags, balanco, ordens, embalagens, foraBalanco])

  if (!aberto && !editando) {
    return (
      <div className="mb-5">
        <Botao variante="primario" onClick={() => setAberto(true)}>Nova ordem</Botao>
      </div>
    )
  }

  return (
    <Cartao
      titulo={editando ? `Editar ordem ${editando.numero}` : 'Nova ordem'}
      acoes={
        <Botao onClick={() => (editando ? aoFechar?.() : setAberto(false))}>Fechar</Botao>
      }
      className="mb-5"
    >
      {erro && <Erro>{erro}</Erro>}

      {recuperado && (
        <div className="mb-3">
          <Aviso>
            <b>Rascunho recuperado.</b> O que você tinha digitado antes de sair da tela foi
            restaurado.{' '}
            <button onClick={limpar} className="underline">
              descartar e começar do zero
            </button>
          </Aviso>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <Campo rotulo="Nº da ordem">
          <input value={numero} onChange={(e) => definir({ numero: e.target.value })} className={INPUT} />
        </Campo>
        <Campo rotulo="Lote de semente">
          <input
            value={buscaLote}
            onChange={(e) => setBuscaLote(e.target.value)}
            placeholder="filtrar por lote ou cultivar…"
            className={`${INPUT} mb-1`}
          />
          <select value={loteId} onChange={(e) => definir({ loteId: e.target.value })} className={INPUT}>
            <option value="">
              {lotesFiltrados.length === 0
                ? 'nenhum lote nesse filtro'
                : `escolha… (${lotesFiltrados.length})`}
            </option>
            {lotesFiltrados.map((l) => (
              <option key={l.id} value={l.id}>
                {l.id} · {l.cultivar} · {n(l.peso_bag_kg, 0)} kg/bag
              </option>
            ))}
          </select>
        </Campo>
        <Campo rotulo="Tratamento">
          <input
            value={buscaTrat}
            onChange={(e) => setBuscaTrat(e.target.value)}
            placeholder="filtrar por receita…"
            className={`${INPUT} mb-1`}
          />
          <select value={receitaId} onChange={(e) => definir({ receitaId: e.target.value })} className={INPUT}>
            <option value="">
              {receitasFiltradas.length === 0
                ? 'nenhuma receita nesse filtro'
                : `escolha… (${receitasFiltradas.length})`}
            </option>
            {receitasFiltradas.map((r) => (
              <option key={r.id} value={r.id}>{r.nome}</option>
            ))}
          </select>
        </Campo>
        <Campo rotulo="Embalagem">
          <select value={embalagem} onChange={(e) => definir({ embalagem: e.target.value })} className={INPUT}>
            {embalagens.map((e) => (
              <option key={e.codigo} value={e.codigo}>{e.codigo}</option>
            ))}
          </select>
        </Campo>
        {/* "Qtd emb", não "Bags": com SC10/SC20 a unidade pode ser saco
            (pedido do Arion, 24/08/2026) — o campo continua ordens.bags */}
        <Campo rotulo="Qtd emb (bags ou sacos)">
          <input
            type="number" min={1} value={bags || ''}
            onChange={(e) => definir({ bags: Number(e.target.value) })} className={INPUT}
          />
        </Campo>
        <Campo rotulo="Peso resultante">
          {(() => {
            if (!lote || !(bags > 0)) {
              return <p className="num-tabular py-1.5 text-sm font-medium">—</p>
            }
            const emb = embalagens.find((e) => e.codigo === embalagem)
            const bagKg = pesoBagDaOrdemKg(lote.pms, emb ?? null, lote.peso_bag_kg)
            const pesoKg = bags * bagKg
            // quantos bags FÍSICOS do lote a ordem consome — é assim que a
            // baixa desconta (proporcional ao peso). Só aparece quando a
            // embalagem da ordem difere da do lote (SC10/SC20, MEIOBAG em
            // lote big bag); ordem na embalagem do lote é 1 pra 1.
            const bagsDoLote = lote.peso_bag_kg > 0 ? pesoKg / lote.peso_bag_kg : null
            const difere = bagsDoLote != null && Math.abs(bagsDoLote - bags) > 0.01
            return (
              <div className="py-1.5">
                <p className="num-tabular text-sm font-medium">{n(pesoKg / 1000, 2)} t</p>
                {difere && (
                  <p
                    className="num-tabular text-xs text-stone-500"
                    title="Peso total da ordem ÷ peso do bag do lote — é o que a baixa do lote desconta"
                  >
                    ≈ {n(bagsDoLote, 1)} bags do lote
                  </p>
                )}
              </div>
            )
          })()}
        </Campo>
        <Campo rotulo="Cliente (opcional)">
          <input value={cliente} onChange={(e) => definir({ cliente: e.target.value })} className={INPUT} />
        </Campo>
        <Campo rotulo="Observação de processo">
          <input
            value={observacao} onChange={(e) => definir({ observacao: e.target.value })}
            placeholder="ex.: SEM GRAFITE" className={INPUT}
          />
        </Campo>
        <Campo rotulo="Estoque">
          <label
            className="flex items-center gap-2 py-1.5 text-sm normal-case"
            title="Produção que não vira estoque vendável (ex.: bags pra reensaque na sacaria): consome o lote normalmente, mas fica fora do balanço de demanda e não gera alarme de pedido"
          >
            <input
              type="checkbox"
              checked={foraBalanco}
              onChange={(e) => definir({ foraBalanco: e.target.checked })}
            />
            Não entra no estoque (ex.: sacaria)
          </label>
        </Campo>
        <Campo rotulo="Máquina e dia (opcional)">
          <div className="flex gap-2">
            {/* min-w: sem isto o select murchava para ~64px no tablet, com a
                célula do grid pai em ~221px, apertando o texto da opção */}
            <select
              value={maquinaId} onChange={(e) => definir({ maquinaId: e.target.value })}
              className={`${INPUT} min-w-[5.5rem]`}
            >
              <option value="">pool</option>
              {maquinas.map((m) => (
                <option key={m.id} value={m.id}>{m.nome}</option>
              ))}
            </select>
            <input
              type="date" value={dataProg}
              onChange={(e) => definir({ dataProg: e.target.value })} className={INPUT}
            />
          </div>
        </Campo>
        <Campo rotulo="Endereço do lote (opcional)">
          {/* sem sub-rótulo em cima de cada input: eles empurravam os campos
              pra baixo da linha dos vizinhos (achado do Arion, 25/08/2026) —
              placeholder + tooltip dizem o que é cada um */}
          {/* larguras nos WRAPPERS, não nos inputs: INPUT já tem w-full, e
              w-16 no mesmo elemento perde a briga de classes — o Armazém
              murchava a nada e Bloco/Quadra estouravam a grade */}
          <div className="flex gap-2">
            <div className="min-w-0 flex-1">
              <input
                value={armazem}
                onChange={(e) => definir({ armazem: e.target.value.toUpperCase() })}
                placeholder="ARMAZÉM"
                title="Armazém — onde buscar o lote para esta ordem"
                className={INPUT}
              />
            </div>
            <div className="w-16 shrink-0">
              <input
                value={bloco}
                onChange={(e) => definir({ bloco: e.target.value.toUpperCase() })}
                placeholder="BL01"
                title="Bloco"
                className={INPUT}
              />
            </div>
            <div className="w-16 shrink-0">
              <input
                value={quadra}
                onChange={(e) => definir({ quadra: e.target.value.toUpperCase() })}
                placeholder="QD04"
                title="Quadra"
                className={INPUT}
              />
            </div>
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
              const dados = {
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
                fora_balanco: foraBalanco,
              }
              if (editando) {
                await g.atualizarOrdem(editando.id, dados)
                limpar() // gravou: o rascunho desta ordem não serve mais
                onCriada(`Ordem ${dados.numero} atualizada.`)
                aoFechar?.()
              } else {
                await g.criarOrdem(dados)
                // limpa só o que é da ordem; endereço, lote e receita costumam
                // repetir na próxima e ficam preenchidos
                definir({ numero: '', bags: 0, cliente: '', observacao: '' })
                onCriada(`Ordem criada.`)
              }
            } catch (e) {
              setErro(e instanceof Error ? e.message : String(e))
            }
          }}
        >
          {editando ? 'Salvar alterações' : 'Criar ordem'}
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
