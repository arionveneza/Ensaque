import {
  useCallback, useEffect, useMemo, useState,
  type ChangeEvent, type Dispatch, type ReactNode, type SetStateAction,
} from 'react'
import readXlsxFile from 'read-excel-file/browser'
import * as g from '@/dados/api-gestao'
import type { AgendamentoBanco } from '@/dados/api-gestao'
import {
  agendadoPorTipo,
  bagsProduzidosSemApontar,
  cargasAgendadas,
  converterAgendados,
  ehRelatorioAgendados,
  faltaPorProduto,
  normalizaLinhasXlsx,
  ordenarFaltaPorProduto,
  recorteDaSelecao,
  resumoPorTipoVenda,
  saldosExpedicao,
  situacaoSaldo,
  transferenciaDe,
  SEM_TSI,
  type AlocacaoCaminhao,
  type CriterioFalta,
  type LadoTipoVenda,
  type OrdemPrevista,
} from '@/dominio/expedicao'
import { EMBALAGEM_DEPARA } from '@/dominio/importacao/simpleagro'
import { jaIniciada } from '@/dominio/status'
import type { StatusEfetivo } from '@/dominio/tipos'
import { useRealtime } from '@/dados/useRealtime'
import { useAuth } from '@/auth/AuthProvider'
import {
  Aviso, Botao, Cartao, Erro, Pagina, Tabela, Tag, Vazio,
  diaCurto, inteiro,
} from '@/componentes/ui'

const CAMPO =
  'rounded-md border border-stone-300 px-2 py-1.5 text-sm dark:border-stone-700 dark:bg-stone-800'

/** Ordem que ainda vai virar produto: tudo que não foi apontado no AGROTIS. */
const ABERTAS = ['Nao programada', 'Programada', 'Aguardando lote', 'Pronto para produzir',
  'Em producao', 'Parada', 'Finalizada', 'Qualidade apontada']

/**
 * Tipos de venda em destaque roxo na lista (Arion, 15/09/2026): COOPERADO e
 * MULTIPLICADOR — os dois são compromisso com produtor parceiro. Só o visual;
 * a divisão COOPERADO × OUTRAS dos saldos continua pela marca `cooperado`.
 */
const tipoVendaDestacado = (tipo: string | null | undefined) =>
  /COOPERADO|MULTIPLICADOR/i.test(tipo ?? '')

/** Embalagens que o app conhece — fora disso o estoque nunca casa. */
const EMBALAGENS_APP = new Set(Object.values(EMBALAGEM_DEPARA).map((e) => e.codigo))

/**
 * Expedição (12/09/2026): o relatório de PEDIDOS AGENDADOS da SimpleAgro
 * cruzado com o estoque do SAP (lotes de semente pra branca, estoque PA pro
 * tratado — o upload da aba Ordens) e com a produção aberta, caminhão a
 * caminhão. A fila consolidada por produto decide o que é coberto; a visão
 * por tipo de venda (VENDA COOPERADO × OUTRAS) só detalha — nunca conta
 * estoque duas vezes.
 */
export default function Expedicao() {
  const { usuario, permitido } = useAuth()
  const podeImportar = permitido('expedicao', 'importar')

  const [agendamentos, setAgendamentos] = useState<AgendamentoBanco[]>([])
  const [lotes, setLotes] = useState<g.LoteSementeLinha[]>([])
  const [estoquePa, setEstoquePa] = useState<g.EstoquePaLinha[]>([])
  const [ordens, setOrdens] = useState<g.OrdemVisao[]>([])
  /** Número do pedido → filial, da última carga do Pedidos Analítico (aba Ordens). */
  const [filiais, setFiliais] = useState<Map<string, string | null>>(new Map())
  const [carregando, setCarregando] = useState(true)
  const [erro, setErro] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  // ---- filtros ----
  const [de, setDe] = useState('')
  const [ate, setAte] = useState('')
  const [tipoSel, setTipoSel] = useState<Set<string>>(new Set())
  const [statusSel, setStatusSel] = useState<Set<string>>(new Set())
  const [fCultivar, setFCultivar] = useState('')
  const [fTratamento, setFTratamento] = useState('')
  const [fEmbalagem, setFEmbalagem] = useState('')
  const [busca, setBusca] = useState('')
  const [soTransferencia, setSoTransferencia] = useState(false)
  /**
   * Recorte por CARGA (19/09/2026, pedido do Arion: "selecionar as cargas e
   * ver a demanda daquelas cargas apenas"). NÃO entra em `filtrados`: se
   * entrasse, as outras cargas sairiam da fila e devolveriam o estoque que
   * já consumiram — a carga escolhida ficaria verde por engano. A fila
   * continua com todo o período; a seleção só recorta o que se soma.
   */
  const [cargaSel, setCargaSel] = useState<Set<string>>(new Set())
  /** Ordem da grade "Quando vai faltar" (19/09/2026): maior falta, cultivar ou tratamento. */
  const [ordemFalta, setOrdemFalta] = useState<CriterioFalta>('falta')
  const [painelCargas, setPainelCargas] = useState(false)
  const [buscaCarga, setBuscaCarga] = useState('')
  const [soSelecao, setSoSelecao] = useState(false)

  const recarregar = useCallback(async () => {
    const [a, l, e, o, f] = await Promise.all([
      g.listarAgendamentos(), g.listarLotes(), g.listarEstoquePa(), g.listarOrdens(),
      g.listarPedidosFilial(),
    ])
    setAgendamentos(a)
    setLotes(l)
    setEstoquePa(e)
    setOrdens(o)
    setFiliais(f)
  }, [])

  /**
   * Filial efetiva do agendamento: a do próprio relatório se um dia vier
   * preenchida; senão a do Pedidos Analítico pelo número do pedido (289 de
   * 289 casam no arquivo de 10/09/2026). Pedido que não está na carga de
   * pedidos = não informada.
   */
  const transferencia = useCallback(
    (a: AgendamentoBanco) =>
      transferenciaDe(a.filial ?? (a.pedido ? filiais.get(a.pedido) : null) ?? null),
    [filiais],
  )

  useEffect(() => {
    setCarregando(true)
    recarregar()
      .catch((e) => setErro(e instanceof Error ? e.message : String(e)))
      .finally(() => setCarregando(false))
  }, [recarregar])

  useRealtime(['agendamentos', 'ordens', 'lotes_semente'], recarregar)

  // chips começam todos ligados; um upload novo pode trazer valores novos, então
  // o padrão é refeito depois de importar
  const tiposExistentes = useMemo(
    () => [...new Set(agendamentos.map((a) => a.tipo_venda || '(sem tipo)'))].sort(),
    [agendamentos],
  )
  const statusExistentes = useMemo(
    () => [...new Set(agendamentos.map((a) => a.status_entrega))].sort(),
    [agendamentos],
  )
  const [chipsIniciados, setChipsIniciados] = useState(false)
  useEffect(() => {
    if (chipsIniciados || agendamentos.length === 0) return
    setTipoSel(new Set(tiposExistentes))
    setStatusSel(new Set(statusExistentes))
    setChipsIniciados(true)
  }, [agendamentos.length, tiposExistentes, statusExistentes, chipsIniciados])

  const filtrados = useMemo(
    () =>
      agendamentos.filter((a) => {
        if (de && (a.data == null || a.data < de)) return false
        if (ate && (a.data == null || a.data > ate)) return false
        if (tipoSel.size > 0 && !tipoSel.has(a.tipo_venda || '(sem tipo)')) return false
        if (statusSel.size > 0 && !statusSel.has(a.status_entrega)) return false
        if (fCultivar && a.cultivar !== fCultivar) return false
        if (fTratamento && a.tratamento !== fTratamento) return false
        if (fEmbalagem && a.embalagem !== fEmbalagem) return false
        if (soTransferencia && !transferencia(a).precisa) return false
        if (busca.trim()) {
          const q = busca.trim().toLowerCase()
          // a CARGA saiu daqui de propósito (19/09/2026): buscar por carga
          // filtrava ANTES da fila e devolvia o estoque das outras — dois
          // jeitos de "filtrar por carga" com respostas opostas na mesma
          // tela. Para carga existe o recorte, que não mexe na conta.
          const alvo = `${a.cliente ?? ''} ${a.pedido ?? ''} ${a.identificador} ${a.cidade ?? ''} ${a.estado ?? ''} ${transferencia(a).filial ?? ''}`.toLowerCase()
          if (!alvo.includes(q)) return false
        }
        return true
      }),
    [agendamentos, de, ate, tipoSel, statusSel, fCultivar, fTratamento, fEmbalagem, busca, soTransferencia, transferencia],
  )

  /** Quantos agendamentos (e bags) são de filial ≠ matriz, por filial. */
  const transferencias = useMemo(() => {
    const porFilial = new Map<string, { n: number; bags: number }>()
    let n = 0
    let bags = 0
    for (const a of agendamentos) {
      const t = transferencia(a)
      if (!t.precisa) continue
      n++
      bags += a.bags
      const acc = porFilial.get(t.curto!) ?? { n: 0, bags: 0 }
      acc.n++
      acc.bags += a.bags
      porFilial.set(t.curto!, acc)
    }
    return { n, bags, porFilial: [...porFilial.entries()].sort((x, y) => y[1].n - x[1].n) }
  }, [agendamentos, transferencia])

  /** O cruzamento usa SÓ o que passou pelos filtros: o período é a pergunta. */
  const saldos = useMemo(
    () =>
      saldosExpedicao(
        filtrados,
        lotes
          .filter((l) => l.status === 'Em estoque')
          .map((l) => ({ cultivar: l.cultivar, bags: l.bags_disp ?? 0 })),
        estoquePa,
        ordens
          // fora_balanco (sacaria): a produção não vira estoque vendável —
          // não pode contar como material garantido/futuro pros caminhões
          .filter((o) => ABERTAS.includes(o.status_efetivo) && !o.fora_balanco)
          .map((o) => ({
            cultivar: o.cultivar,
            tratamento: (o.receita_nome ?? '').toUpperCase(),
            embalagem: o.embalagem,
            bags: o.bags_produzidos ?? o.bags,
            dataProg: o.data_prog,
            // ordem que a produção já tocou é material garantido — inclusive a
            // ADIANTADA, cuja data programada continua no futuro
            iniciada: jaIniciada(o.status_efetivo as StatusEfetivo),
            numero: o.numero,
            status: o.status_efetivo,
          })),
        new Date().toISOString().slice(0, 10),
        // desempate estável entre caminhões do MESMO dia: sem ele quem leva o
        // estoque é a ordem em que o banco devolveu as linhas, e o veredito de
        // uma carga mudava a cada reimportação (19/09/2026)
        (a) => `${a.carga ?? ''}|${a.identificador}`,
      ),
    [filtrados, lotes, estoquePa, ordens],
  )

  /** As cargas montadas que estão na fila do período — o que dá para recortar. */
  const cargas = useMemo(
    () =>
      cargasAgendadas(
        filtrados.map((a) => ({
          carga: a.carga, data: a.data, bags: a.bags,
          cliente: a.cliente, statusCarga: a.status_carga,
        })),
      ),
    [filtrados],
  )
  /** Linhas sem carga: seguem disputando o estoque na fila, mas não dá para marcá-las. */
  const semCarga = useMemo(() => {
    const linhas = filtrados.filter((a) => (a.carga ?? '').trim() === '')
    return { linhas: linhas.length, bags: linhas.reduce((t, a) => t + a.bags, 0) }
  }, [filtrados])

  const temSelecao = cargaSel.size > 0
  const naSelecao = useCallback((a: AgendamentoBanco) => cargaSel.has((a.carga ?? '').trim()), [cargaSel])
  /** Marcada mas fora do período/filtros atuais — senão o recorte fica vazio sem explicação. */
  const selecaoForaDoPeriodo = useMemo(
    () => [...cargaSel].filter((c) => !cargas.some((x) => x.carga === c)),
    [cargaSel, cargas],
  )

  const porTipo = useMemo(() => resumoPorTipoVenda(saldos, (a) => a.cooperado), [saldos])
  /** Cobertura de cada agendamento, pela fila consolidada do produto dele. */
  const alocacao = useMemo(
    () =>
      new Map<string, AlocacaoCaminhao<AgendamentoBanco>>(
        saldos.flatMap((s) => s.caminhoes.map((c) => [c.caminhao.id, c] as const)),
      ),
    [saldos],
  )

  /** Falta por produto × data (16/09/2026): a mesma fila, item nas linhas e as datas do período nas colunas. */
  const faltaProdutos = useMemo(
    () => faltaPorProduto(saldos, temSelecao ? naSelecao : undefined),
    [saldos, temSelecao, naSelecao],
  )
  const faltaOrdenada = useMemo(() => ordenarFaltaPorProduto(faltaProdutos, ordemFalta), [faltaProdutos, ordemFalta])
  /** Todas as datas com caminhão no recorte em vista (colunas da grade), sem data primeiro. */
  const datasDoPeriodo = useMemo(
    () =>
      [
        ...new Set(
          saldos.flatMap((s) =>
            s.caminhoes
              .filter((c) => !temSelecao || naSelecao(c.caminhao))
              .map((c) => c.data ?? ''),
          ),
        ),
      ].sort(),
    [saldos, temSelecao, naSelecao],
  )
  /** A lista que vai para a produção: o que estas cargas pedem e ainda não existe. */
  const recorte = useMemo(
    () => (temSelecao ? recorteDaSelecao(saldos, naSelecao, (a) => a.carga) : null),
    [saldos, temSelecao, naSelecao],
  )
  /** O denominador honesto: tudo que está disputando o estoque no período. */
  const bagsNaFila = useMemo(() => filtrados.reduce((t, a) => t + a.bags, 0), [filtrados])
  const cargasVisiveis = useMemo(() => {
    const q = buscaCarga.trim().toLowerCase()
    if (!q) return cargas
    return cargas.filter((c) =>
      (c.carga + " " + c.clientes.join(" ") + " " + c.status.join(" ")).toLowerCase().includes(q),
    )
  }, [cargas, buscaCarga])
  /** Com o recorte ligado, a lista do fim pode mostrar só o que foi marcado. */
  const listaVisivel = useMemo(
    () => (temSelecao && soSelecao ? filtrados.filter(naSelecao) : filtrados),
    [filtrados, temSelecao, soSelecao, naSelecao],
  )

  const faltas = saldos.filter((s) => situacaoSaldo(s) === 'falta')
  const precisamAdiantar = saldos.filter((s) => situacaoSaldo(s) === 'adiantar')
  const aguardando = saldos.filter((s) => situacaoSaldo(s) === 'aguardando-producao')

  const opcoes = useMemo(
    () => ({
      cultivares: [...new Set(agendamentos.map((a) => a.cultivar))].sort(),
      tratamentos: [...new Set(agendamentos.map((a) => a.tratamento))].sort(),
      embalagens: [...new Set(agendamentos.map((a) => a.embalagem))].sort(),
    }),
    [agendamentos],
  )

  const temFiltro =
    !!(de || ate || fCultivar || fTratamento || fEmbalagem || busca.trim()) ||
    tipoSel.size !== tiposExistentes.length ||
    statusSel.size !== statusExistentes.length ||
    // faltavam os dois (achado de 19/09/2026): com só um deles ligado o botão
    // "Limpar filtros" não aparecia, e o recorte ficava ativo e invisível
    soTransferencia ||
    temSelecao

  function limparFiltros() {
    setDe('')
    setAte('')
    setFCultivar('')
    setFTratamento('')
    setFEmbalagem('')
    setBusca('')
    setTipoSel(new Set(tiposExistentes))
    setStatusSel(new Set(statusExistentes))
    setSoTransferencia(false)
    setCargaSel(new Set())
    setSoSelecao(false)
  }

  const alternar = (setter: Dispatch<SetStateAction<Set<string>>>, valor: string) =>
    setter((sel) => {
      const novo = new Set(sel)
      if (novo.has(valor)) novo.delete(valor)
      else novo.add(valor)
      return novo
    })

  // ---- upload ----
  async function importar(ev: ChangeEvent<HTMLInputElement>) {
    const arquivo = ev.target.files?.[0]
    ev.target.value = ''
    if (!arquivo) return
    setErro(null)
    setMsg(null)
    try {
      // aba nomeada faz o leitor devolver [{sheet, data}] em vez das linhas
      const rows = normalizaLinhasXlsx(await readXlsxFile(arquivo), ehRelatorioAgendados)
      if (!ehRelatorioAgendados(rows)) {
        throw new Error(
          'Este arquivo não parece o relatório de pedidos agendados (faltam as colunas IDENTIFICADOR / TIPO VENDA / QTD AGENDADA / DATA AGENDADA).',
        )
      }
      const { linhas, resumo } = converterAgendados(rows)
      await g.substituirAgendamentos(
        linhas.map((l) => ({
          identificador: l.identificador, pedido: l.pedido || null, filial: l.filial, tipo_venda: l.tipoVenda,
          cooperado: l.cooperado, cliente: l.cliente || null, cidade: l.cidade, estado: l.estado,
          cultivar: l.cultivar, categoria: l.categoria, tratamento: l.tratamento,
          embalagem: l.embalagem, qtd_pedido: l.qtdPedido, bags: l.bags,
          status_entrega: l.statusEntrega, carga: l.carga, status_carga: l.statusCarga,
          data: l.data, observacao: l.observacao,
        })),
        usuario!.id,
      )
      const status = Object.entries(resumo.porStatusEntrega).map(([s, n]) => `${s} ${n}`).join(', ')
      const avisos: string[] = []
      if (resumo.semData > 0) avisos.push(`${resumo.semData} sem data`)
      if (resumo.semQuantidade > 0) avisos.push(`${resumo.semQuantidade} sem quantidade (ignorados)`)
      if (resumo.finalizados > 0) avisos.push(`${resumo.finalizados} finalizado(s) ignorado(s) — caminhão já saiu`)
      if (resumo.identificadorRepetido > 0) avisos.push(`${resumo.identificadorRepetido} identificador(es) repetido(s)`)
      if (filiais.size === 0) avisos.push('filial dos pedidos não cruzada — importe o Pedidos Analítico na aba Ordens')
      const embDesc = Object.keys(resumo.embalagemDesconhecida)
      if (embDesc.length > 0) avisos.push(`embalagem sem de-para: ${embDesc.join(', ')}`)
      setMsg(
        `${resumo.aproveitadas} agendamento(s) importados (substituição total): ` +
          `${inteiro(resumo.bagsCooperado)} bg cooperado · ${inteiro(resumo.bagsOutras)} bg outras` +
          (status ? ` · status: ${status}` : '') +
          (avisos.length ? `. Atenção: ${avisos.join(' · ')}.` : '.'),
      )
      setChipsIniciados(false) // tipos/status podem ter mudado; refaz o padrão
      await recarregar()
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }

  if (carregando) return <p className="p-8 text-sm text-stone-500">Carregando expedição…</p>

  return (
    <Pagina
      titulo="Expedição"
      descricao="Pedidos agendados cruzados com o saldo do SAP e a produção programada: o que atende, o que falta e em que data — no total e por tipo de venda."
      acoes={
        podeImportar ? (
          <label className="cursor-pointer rounded-md bg-stone-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-stone-300">
            Importar pedidos agendados (.xlsx)
            <input type="file" accept=".xlsx" className="hidden" onChange={importar} />
          </label>
        ) : undefined
      }
    >
      {erro && <Erro>{erro}</Erro>}
      {msg && <div className="mb-4"><Aviso gravidade="ok">{msg}</Aviso></div>}

      {agendamentos.length === 0 ? (
        <Cartao titulo="Agendamentos" className="mb-5">
          <Vazio>
            Nenhum pedido agendado importado.
            {podeImportar
              ? ' Exporte o relatório de pedidos agendados na SimpleAgro e importe aqui.'
              : ' Peça ao PCP ou à logística para importar o relatório de pedidos agendados.'}
          </Vazio>
        </Cartao>
      ) : (
        <>
          {/* ---------------- filtros ---------------- */}
          <Cartao titulo="Filtros" className="mb-5">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs text-stone-500">
                De
                <input type="date" value={de} onChange={(e) => setDe(e.target.value)} className={`${CAMPO} mt-1 block`} />
              </label>
              <label className="text-xs text-stone-500">
                Até
                <input type="date" value={ate} onChange={(e) => setAte(e.target.value)} className={`${CAMPO} mt-1 block`} />
              </label>
              <label className="text-xs text-stone-500">
                Cultivar
                <select value={fCultivar} onChange={(e) => setFCultivar(e.target.value)} className={`${CAMPO} mt-1 block`}>
                  <option value="">todos</option>
                  {opcoes.cultivares.map((c) => <option key={c}>{c}</option>)}
                </select>
              </label>
              <label className="text-xs text-stone-500">
                Tratamento
                <select value={fTratamento} onChange={(e) => setFTratamento(e.target.value)} className={`${CAMPO} mt-1 block`}>
                  <option value="">todos</option>
                  {opcoes.tratamentos.map((t) => <option key={t}>{t}</option>)}
                </select>
              </label>
              <label className="text-xs text-stone-500">
                Embalagem
                <select value={fEmbalagem} onChange={(e) => setFEmbalagem(e.target.value)} className={`${CAMPO} mt-1 block`}>
                  <option value="">todas</option>
                  {opcoes.embalagens.map((e2) => <option key={e2}>{e2}</option>)}
                </select>
              </label>
              <label className="min-w-44 flex-1 text-xs text-stone-500">
                Cliente, pedido, cidade…
                <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="buscar" className={`${CAMPO} mt-1 block w-full`} />
              </label>
              {temFiltro && <Botao onClick={limparFiltros}>Limpar filtros</Botao>}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-stone-500">Tipo de venda:</span>
              {tiposExistentes.map((t) => (
                <Chip key={t} ativo={tipoSel.has(t)} onClick={() => alternar(setTipoSel, t)}>{t}</Chip>
              ))}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-stone-500">Status entrega:</span>
              {statusExistentes.map((s) => (
                <Chip key={s} ativo={statusSel.has(s)} onClick={() => alternar(setStatusSel, s)}>{s}</Chip>
              ))}
              <span className="ml-1 text-xs text-stone-400">
                ("Aguardando Estoque" entra: é exatamente a demanda que precisa de estoque)
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-stone-500">Filial do pedido:</span>
              <Chip ativo={soTransferencia} onClick={() => setSoTransferencia((v) => !v)}>
                Precisa transferência ({transferencias.n})
              </Chip>
              {filiais.size === 0 ? (
                <span className="ml-1 text-xs text-amber-700 dark:text-amber-400">
                  sem cruzamento: importe o Pedidos Analítico na aba Ordens para saber a filial de cada pedido
                </span>
              ) : (
                <span className="ml-1 text-xs text-stone-400">
                  (pedido de filial que não a matriz exige solicitar transferência de saldo antes de carregar)
                </span>
              )}
            </div>
          </Cartao>

          {/* ---------------- recorte por carga (19/09/2026) ---------------- */}
          <Cartao
            titulo="Recorte por carga"
            className="mb-5"
            acoes={
              <div className="flex flex-wrap items-center gap-2">
                {temSelecao && (
                  <Botao onClick={() => { setCargaSel(new Set()); setSoSelecao(false) }}>Limpar recorte</Botao>
                )}
                <Botao
                  variante={painelCargas ? 'normal' : 'primario'}
                  onClick={() => setPainelCargas((v) => !v)}
                  disabled={cargas.length === 0}
                >
                  {painelCargas ? 'Fechar lista' : temSelecao ? 'Trocar cargas' : 'Escolher cargas'}
                </Botao>
              </div>
            }
          >
            <p className="text-sm text-stone-500 dark:text-stone-400">
              A fila <b>não muda</b>: as cargas que vêm antes continuam pegando o estoque primeiro.
              Aqui você vê só a fatia destas cargas — é o que precisa sair da máquina para elas.
            </p>
            {temSelecao ? (
              <p className="mt-2 text-sm">
                <b>{cargaSel.size} carga(s) marcada(s)</b> · {inteiro(recorte?.agendado ?? 0)} bg
                {" de "}{inteiro(bagsNaFila)} bg na fila do período
              </p>
            ) : (
              <p className="mt-2 text-sm text-stone-500 dark:text-stone-400">
                {cargas.length === 0
                  ? 'Nenhuma carga montada no período filtrado — só demanda sem caminhão.'
                  : 'Nenhuma carga marcada: a tela está mostrando o período inteiro.'}
              </p>
            )}
            {selecaoForaDoPeriodo.length > 0 && (
              <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
                {selecaoForaDoPeriodo.length} carga(s) marcada(s) estão fora dos filtros atuais
                {' ('}{selecaoForaDoPeriodo.join(', ')}{')'} — limpe o período para vê-las.
              </p>
            )}
            {painelCargas && (
              <div className="mt-3 rounded-lg border border-stone-200 p-2 dark:border-stone-700">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={buscaCarga}
                    onChange={(e) => setBuscaCarga(e.target.value)}
                    placeholder="buscar carga, cliente, status…"
                    className={`${CAMPO} w-60`}
                  />
                  <Botao onClick={() => setCargaSel(new Set(cargasVisiveis.map((c) => c.carga)))}>
                    Marcar as visíveis
                  </Botao>
                  <Botao onClick={() => setCargaSel(new Set())}>Nenhuma</Botao>
                  <span className="text-xs text-stone-400">
                    {cargasVisiveis.length} de {cargas.length} cargas
                  </span>
                </div>
                <div className="mt-2 max-h-80 overflow-y-auto">
                  {cargasVisiveis.map((c) => (
                    <label
                      key={c.carga}
                      className="flex cursor-pointer items-center gap-2 border-t border-stone-100 px-1 py-2 text-sm hover:bg-stone-50 dark:border-stone-800/60 dark:hover:bg-stone-800/40"
                    >
                      <input
                        type="checkbox"
                        checked={cargaSel.has(c.carga)}
                        onChange={() => alternar(setCargaSel, c.carga)}
                        className="h-4 w-4 shrink-0"
                      />
                      <span className="num-tabular w-12 shrink-0 font-medium">{c.carga}</span>
                      <span className="w-24 shrink-0 text-xs text-stone-500">
                        {c.datas.map((d) => diaCurto(d)).join(' e ') || 'sem data'}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs">
                        {c.clientes[0] ?? '—'}
                        {c.clientes.length > 1 && ` +${c.clientes.length - 1}`}
                      </span>
                      <span className="num-tabular w-16 shrink-0 text-right text-xs">{inteiro(c.bags)} bg</span>
                      <span className="hidden w-36 shrink-0 text-right text-xs text-stone-500 sm:block">
                        {c.status.join(' / ') || '—'}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}
            {semCarga.linhas > 0 && (
              <p className="mt-2 text-xs text-stone-400">
                {semCarga.linhas} linha(s) ({inteiro(semCarga.bags)} bg) ainda não têm carga montada —
                não dá para marcá-las, mas elas continuam disputando o estoque na fila.
              </p>
            )}
          </Cartao>

          {/* -------- o que a máquina precisa entregar para as cargas marcadas -------- */}
          {recorte && (
            <Cartao titulo="Cargas selecionadas · o que a máquina precisa entregar" className="mb-5">
              {recorte.produtos.length === 0 ? (
                <Vazio>As cargas marcadas não estão nos filtros atuais.</Vazio>
              ) : (
                <>
                  <Tabela cabecalho={[
                    'Cultivar', 'Tratamento',
                    { texto: 'Emb.', className: 'hidden lg:table-cell' },
                    'Precisa até', '#Pedem', '#Tem hoje', '#A produzir', '#Sem ordem',
                    { texto: '#Não sai no dia', className: 'hidden lg:table-cell' },
                    { texto: 'Já programado', className: 'hidden lg:table-cell' },
                    { texto: 'Produto inteiro', className: 'hidden lg:table-cell' },
                  ]}>
                    {recorte.produtos.map((p) => (
                      <tr
                        key={`${p.cultivar}|${p.tratamento}|${p.embalagem}`}
                        className="border-t border-stone-100 dark:border-stone-800/60"
                      >
                        <td className="px-2 py-1.5 font-medium">{p.cultivar}</td>
                        <td className="px-2 py-1.5">
                          {p.semTsi ? 'SEM TSI' : p.tratamento}
                          {p.semTsi && (
                            <Tag cor="info" className="ml-1">lote de semente</Tag>
                          )}
                        </td>
                        <td className="hidden px-2 py-1.5 text-xs lg:table-cell">{p.embalagem}</td>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          {p.precisaAte ? diaCurto(p.precisaAte) : 'sem data'}
                        </td>
                        <td className="num-tabular px-2 py-1.5 text-right">{inteiro(p.agendado)}</td>
                        <td
                          className="num-tabular px-2 py-1.5 text-right"
                          title={
                            p.antes.outrasCargas + p.antes.semCarga > 0
                              ? `Antes destas cargas a fila entregou ${inteiro(p.antes.outrasCargas)} bg a outras cargas e ${inteiro(p.antes.semCarga)} bg a linhas sem carga.`
                              : undefined
                          }
                        >
                          {inteiro(p.temHoje)}
                        </td>
                        <td className="num-tabular px-2 py-1.5 text-right font-semibold">
                          {p.aProduzir > 0 ? (
                            <span className="text-amber-700 dark:text-amber-400">{inteiro(p.aProduzir)}</span>
                          ) : (
                            <span className="text-green-700 dark:text-green-400">0</span>
                          )}
                        </td>
                        <td className="num-tabular px-2 py-1.5 text-right font-semibold">
                          {p.semOrdem > 0 ? (
                            <span className="text-red-700 dark:text-red-400">{inteiro(p.semOrdem)}</span>
                            ) : (<span className="text-stone-400">—</span>)}
                        </td>
                        <td className="hidden num-tabular px-2 py-1.5 text-right lg:table-cell">
                          {p.descoberto > 0 ? inteiro(p.descoberto) : '—'}
                        </td>
                        <td className="hidden px-2 py-1.5 text-xs lg:table-cell">
                          {p.ordens.length === 0 ? '—' : <OrdensDaLinha ordens={p.ordens} />}
                        </td>
                        <td className="hidden px-2 py-1.5 lg:table-cell">
                          <Tag
                            cor={
                              p.situacao === 'falta' ? 'perigo'
                                : p.situacao === 'adiantar' ? 'alerta'
                                : p.situacao === 'aguardando-producao' ? 'info' : 'ok'
                            }
                          >
                            {p.situacao === 'falta' ? 'falta'
                              : p.situacao === 'adiantar' ? 'adiantar'
                              : p.situacao === 'aguardando-producao' ? 'aguardando produção' : 'atende'}
                          </Tag>
                        </td>
                      </tr>
                    ))}
                  </Tabela>
                  <p className="mt-3 text-sm">
                    <b>{inteiro(recorte.aProduzir)} bags</b> a produzir para estas cargas
                    {recorte.produtos.some((p) => p.semOrdem > 0) && (
                      <>
                        {", sendo "}
                        <b className="text-red-700 dark:text-red-400">
                          {inteiro(recorte.produtos.reduce((t, p) => t + p.semOrdem, 0))} bg sem nenhuma ordem aberta
                        </b>
                      </>
                    )}
                    .
                  </p>
                  {recorte.produtos.some((p) => p.antes.outrasCargas + p.antes.semCarga > 0) && (
                    <p className="mt-1 text-xs text-stone-500">
                      Em alguns produtos o estoque foi para quem vem antes na fila:{" "}
                      {inteiro(recorte.produtos.reduce((t, p) => t + p.antes.outrasCargas, 0))} bg para outras
                      cargas e {inteiro(recorte.produtos.reduce((t, p) => t + p.antes.semCarga, 0))} bg para
                      linhas sem carga. Passe o mouse em "Tem hoje" para ver produto a produto.
                    </p>
                  )}
                  <p className="mt-1 text-xs text-stone-500">
                    <b>A produzir</b> = o que estas cargas pedem menos o que já está no galpão para elas.
                    {" "}<b>Sem ordem</b> = nem ordem aberta existe — é o que abrir hoje.
                    {" "}<b>Não sai no dia</b> = nem com o programado a fila fecha no prazo.
                    {" "}Já programado e Produto inteiro olham o produto todo, não só estas cargas.
                  </p>
                </>
              )}
            </Cartao>
          )}

          {/* ---------------- o veredito ---------------- */}
          {temSelecao && (faltas.length > 0 || precisamAdiantar.length > 0 || aguardando.length > 0) && (
            <p className="mb-2 text-xs uppercase tracking-wide text-stone-500">
              Abaixo, o total do período — todas as cargas
            </p>
          )}
          {faltas.length > 0 && (
            <div className="mb-5">
              <Aviso gravidade="bloqueio">
                <b>
                  {faltas.length} produto(s) não atendem o agendado
                  {ate && ` até ${diaCurto(ate)}`}:
                </b>{' '}
                faltam {inteiro(faltas.reduce((a, s) => a + -s.saldo, 0))} bags no total —
                nem adiantando a produção já aberta.
              </Aviso>
            </div>
          )}
          {precisamAdiantar.length > 0 && (
            <div className="mb-5">
              <Aviso gravidade="alerta">
                <b>{precisamAdiantar.length} produto(s) só atendem adiantando a produção:</b>{' '}
                {precisamAdiantar
                  .map((s) => `${s.cultivar} · ${s.tratamento} (adiantar ≥ ${inteiro(s.deficitPrazo)} bg${ordensCurto(s.producao)})`)
                  .join(' — ')}.
                Vale marcar essas ordens como urgentes na Programação.
              </Aviso>
            </div>
          )}
          {aguardando.length > 0 && (
            <div className="mb-5">
              <Aviso gravidade="alerta">
                <b>{aguardando.length} produto(s) sem estoque pronto no SAP</b> — dependem de
                ordem aberta:{' '}
                {aguardando
                  .map((s) => {
                    const precisa = s.agendado - s.estoque
                    const jaFeito = bagsProduzidosSemApontar(s) >= precisa
                    return `${s.cultivar} · ${s.tratamento} (${inteiro(precisa)} bg ${jaFeito ? "já produzidos, falta apontar" : "a produzir"}${ordensCurto(s.producao)})`
                  })
                  .join(' — ')}.
                Ordem que ainda não rodou precisa rodar; ordem que já rodou precisa ser apontada no
                AGROTIS e o saldo do SAP subir de novo para a linha virar "atende".
              </Aviso>
            </div>
          )}
          {faltas.length === 0 && precisamAdiantar.length === 0 && aguardando.length === 0 &&
            filtrados.length > 0 && (
            <div className="mb-5">
              <Aviso gravidade="ok">
                O estoque físico {ate ? `atende os agendamentos até ${diaCurto(ate)}` : 'atende tudo que está agendado'}.
              </Aviso>
            </div>
          )}

          {/* ---------------- falta por produto e data (16/09/2026) ---------------- */}
          <Cartao
            titulo={`Quando vai faltar · ${
              de && ate ? `${diaCurto(de)} a ${diaCurto(ate)}` : de ? `a partir de ${diaCurto(de)}` : ate ? `até ${diaCurto(ate)}` : 'todas as datas'
            }${temSelecao ? ' · só as cargas marcadas' : ''}`}
            className="mb-5"
            acoes={
              faltaProdutos.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-stone-500">
                  <span className="mr-0.5">Ordenar por</span>
                  {(
                    [
                      ['falta', 'maior falta'],
                      ['cultivar', 'cultivar'],
                      ['tratamento', 'tratamento'],
                    ] as [CriterioFalta, string][]
                  ).map(([c, rotulo]) => (
                    <Chip key={c} ativo={ordemFalta === c} onClick={() => setOrdemFalta(c)}>
                      {rotulo}
                    </Chip>
                  ))}
                </div>
              ) : undefined
            }
          >
            {saldos.length === 0 ? (
              <Vazio>Nenhum agendamento passa pelos filtros.</Vazio>
            ) : faltaProdutos.length === 0 ? (
              <p className="py-3 text-center text-sm text-green-700 dark:text-green-400">
                Nenhuma falta nas datas do período.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-stone-200 text-left text-xs uppercase tracking-wide text-stone-500 dark:border-stone-800 dark:text-stone-400">
                      <th className="px-2 py-2">Produto</th>
                      {datasDoPeriodo.map((d) => (
                        <th key={d || 'sem-data'} className="num-tabular px-2 py-2 text-right whitespace-nowrap">
                          {d ? diaCurto(d) : 'sem data'}
                        </th>
                      ))}
                      <th className="num-tabular px-2 py-2 text-right whitespace-nowrap">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {faltaOrdenada.map((p) => {
                      const porData = new Map(p.datas.map((d) => [d.data ?? '', d]))
                      const corTexto =
                        p.situacao === 'falta'
                          ? 'text-red-700 dark:text-red-400'
                          : p.situacao === 'adiantar'
                            ? 'text-amber-700 dark:text-amber-400'
                            : 'text-sky-700 dark:text-sky-400'
                      return (
                        <tr key={`${p.cultivar}|${p.tratamento}|${p.embalagem}`} className="border-t border-stone-100 dark:border-stone-800/60">
                          <td className="px-2 py-2">
                            {/* a chave da ordenação vai em cima: agrupado por
                                tratamento, é o tratamento que o olho percorre */}
                            {ordemFalta === 'tratamento' ? (
                              <>
                                <p className="font-medium">{p.semTsi ? 'SEM TSI' : p.tratamento}</p>
                                <p className="text-xs text-stone-500">
                                  {p.cultivar}{p.semTsi ? '' : ` · ${p.embalagem}`}
                                </p>
                              </>
                            ) : (
                              <>
                                <p className="font-medium">{p.cultivar}</p>
                                <p className="text-xs text-stone-500">
                                  {p.semTsi ? 'SEM TSI' : `${p.tratamento} · ${p.embalagem}`}
                                </p>
                              </>
                            )}
                          </td>
                          {datasDoPeriodo.map((d) => {
                            const f = porData.get(d)
                            return (
                              <td
                                key={d || 'sem-data'}
                                className={`num-tabular px-2 py-2 text-right align-middle ${f ? `font-semibold ${corTexto}` : 'text-stone-300 dark:text-stone-700'}`}
                                title={f ? `${f.caminhoes} caminhão(ões) · ${inteiro(f.agendado)} agendados · faltam ${inteiro(f.descoberto)}` : 'sem falta neste dia'}
                              >
                                {f ? (
                                  <>
                                    {inteiro(f.descoberto)}
                                    <span className="font-normal text-stone-400"> de {inteiro(f.agendado)}</span>
                                  </>
                                ) : '·'}
                              </td>
                            )
                          })}
                          <td className="num-tabular px-2 py-2 text-right align-middle">
                            <Tag cor={p.situacao === 'falta' ? 'perigo' : p.situacao === 'adiantar' ? 'alerta' : 'info'} className="min-w-16 justify-center font-semibold">
                              {inteiro(p.descoberto)}
                              <span className="ml-1 font-normal opacity-70">de {inteiro(p.agendado)}</span>
                            </Tag>
                          </td>
                        </tr>
                      )
                    })}
                    <tr className="border-t border-stone-300 text-xs dark:border-stone-700">
                      <td className="px-2 py-2 font-medium uppercase tracking-wide text-stone-500">Total do dia</td>
                      {datasDoPeriodo.map((d) => {
                        const t = faltaProdutos.reduce(
                          (acc, p) => acc + (p.datas.find((x) => (x.data ?? '') === d)?.descoberto ?? 0),
                          0,
                        )
                        return (
                          <td key={d || 'sem-data'} className={`num-tabular px-2 py-2 text-right font-semibold ${t > 0 ? 'text-red-700 dark:text-red-400' : 'text-stone-300 dark:text-stone-700'}`}>
                            {t > 0 ? inteiro(t) : '·'}
                          </td>
                        )
                      })}
                      <td className="num-tabular px-2 py-2 text-right font-semibold text-red-700 dark:text-red-400">
                        {inteiro(faltaProdutos.reduce((t, p) => t + p.descoberto, 0))}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}
            <p className="mt-3 text-xs text-stone-500">
              Bags que faltam para o caminhão de cada dia (vermelho = falta mesmo adiantando; âmbar = resolve
              adiantando produção; azul = coberto só por produção futura). Cada célula é "faltam X de Y",
              onde Y é o que está agendado naquele dia — a falta, não o pedido. Ponto = sem falta naquele dia. Só
              produtos com alguma falta no período.
            </p>
          </Cartao>

          {/* ---------------- saldo por produto (consolidado) ---------------- */}
          <Cartao
            titulo={`Estoque × agendado (${saldos.length} produtos)`}
            className="mb-5"
          >
            {saldos.length === 0 ? (
              <Vazio>Nenhum agendamento passa pelos filtros.</Vazio>
            ) : (
              <>
                <Tabela cabecalho={[
                  'Cultivar', 'Tratamento',
                  { texto: 'Emb.', className: 'hidden lg:table-cell' },
                  '#Agendado',
                  { texto: 'COOPERADO', className: 'hidden lg:table-cell' },
                  { texto: 'OUTRAS VENDAS', className: 'hidden lg:table-cell' },
                  '#Estoque',
                  { texto: '#Prod. prevista', className: 'hidden lg:table-cell' },
                  '#Saldo',
                  { texto: '#Descoberto', className: 'hidden lg:table-cell' },
                  '',
                ]}>
                  {saldos.map((s) => {
                    const situacao = situacaoSaldo(s)
                    const descoberto = s.caminhoes.reduce((t, c) => t + c.descoberto, 0)
                    const porTipoLinha = agendadoPorTipo(s, (a) => a.cooperado)
                    // embalagem que o app não conhece nunca casa com o estoque:
                    // a "falta" seria artefato do de-para, não falta real
                    const embDesconhecida = !s.semTsi && !EMBALAGENS_APP.has(s.embalagem)
                    const fundo = embDesconhecida
                      ? 'bg-amber-50/60 dark:bg-amber-950/20'
                      : situacao === 'falta'
                        ? 'bg-red-50/60 dark:bg-red-950/20'
                        : situacao === 'adiantar'
                          ? 'bg-amber-50/60 dark:bg-amber-950/20'
                          : situacao === 'aguardando-producao'
                            ? 'bg-sky-50/60 dark:bg-sky-950/20'
                            : ''
                    return (
                      <tr
                        key={`${s.cultivar}|${s.tratamento}|${s.embalagem}`}
                        className={`border-t border-stone-100 dark:border-stone-800/60 ${fundo}`}
                      >
                        <td className="px-2 py-1.5 font-medium">
                          {s.cultivar}
                          <p className="text-xs font-normal text-stone-500 lg:hidden">
                            {s.embalagem}
                          </p>
                        </td>
                        <td className="px-2 py-1.5">
                          {s.semTsi ? <Tag cor="neutro">SEM TSI</Tag> : s.tratamento}
                        </td>
                        <td className="hidden px-2 py-1.5 lg:table-cell">{s.embalagem}</td>
                        <td className="num-tabular px-2 py-1.5 text-right">{inteiro(s.agendado)}</td>
                        <td className="hidden num-tabular px-2 py-1.5 text-right lg:table-cell" title="Bags agendados em VENDA COOPERADO neste produto">
                          {porTipoLinha.cooperado > 0 ? inteiro(porTipoLinha.cooperado) : <span className="text-stone-400">—</span>}
                        </td>
                        <td className="hidden num-tabular px-2 py-1.5 text-right lg:table-cell" title="Bags agendados nos demais tipos de venda neste produto">
                          {porTipoLinha.outras > 0 ? inteiro(porTipoLinha.outras) : <span className="text-stone-400">—</span>}
                        </td>
                        <td className="num-tabular px-2 py-1.5 text-right" title={s.semTsi ? 'Lotes de semente em estoque deste cultivar, todas as embalagens' : 'Estoque de produto acabado tratado'}>
                          {inteiro(s.estoque)}
                        </td>
                        <td className="hidden num-tabular px-2 py-1.5 text-right text-stone-500 lg:table-cell" title={s.semTsi ? 'Semente branca não passa pela produção' : 'Todas as ordens abertas da combinação — produção se adianta, então a data não corta a conta'}>
                          {s.semTsi ? '—' : inteiro(s.producaoPrevista)}
                        </td>
                        <td className={`num-tabular px-2 py-1.5 text-right font-semibold ${
                          s.saldo < 0 ? 'text-red-700 dark:text-red-400' : 'text-green-700 dark:text-green-400'
                        }`}>
                          {s.saldo > 0 ? '+' : ''}{inteiro(s.saldo)}
                        </td>
                        <td className="hidden num-tabular px-2 py-1.5 text-right lg:table-cell" title="Bags que ficam fora dos caminhões se nada for adiantado — soma da fila em ordem de data">
                          {descoberto > 0 ? <span className="text-red-700 dark:text-red-400">{inteiro(descoberto)}</span> : '—'}
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          {embDesconhecida ? (
                            <Tag cor="alerta">embalagem sem de-para</Tag>
                          ) : situacao === 'falta' ? (
                            <Tag cor="perigo">faltam {inteiro(-s.saldo)}</Tag>
                          ) : situacao === 'adiantar' ? (
                            <Tag cor="alerta">adiantar ≥ {inteiro(s.deficitPrazo)} bg</Tag>
                          ) : situacao === 'aguardando-producao' ? (
                            bagsProduzidosSemApontar(s) >= s.agendado - s.estoque ? (
                              <span title="As ordens já rodaram: os bags existem, mas o saldo do SAP ainda não os traz. Aponte no AGROTIS e suba o saldo de novo.">
                                <Tag cor="info">produzido · falta apontar</Tag>
                              </span>
                            ) : (
                              <span title={`${inteiro(s.agendado - s.estoque)} bags dependem de ordem que ainda não rodou (programada no prazo)`}>
                                <Tag cor="info">aguardando produção</Tag>
                              </span>
                            )
                          ) : (
                            <Tag cor="ok">atende</Tag>
                          )}
                          {!s.semTsi && <OrdensDaLinha ordens={s.producao} />}
                        </td>
                      </tr>
                    )
                  })}
                </Tabela>
                <p className="mt-3 text-xs text-stone-500">
                  O estoque é o do <b>upload do SAP na aba Ordens</b>: <b>SEM TSI</b> compara com
                  os lotes de semente — o cultivar vira uma linha só, somando as embalagens,
                  porque o pool de lotes é um; tratamento real compara com o estoque de produto
                  acabado mais <b>todas as ordens abertas</b> (produção se adianta, a data não
                  corta a conta). <b>Adiantar ≥ X</b> vem da fila em ordem de data: caminhão a
                  caminhão, conta como garantido o estoque, as ordens já iniciadas e as
                  programadas até a data de cada um; X é o pior buraco. <b>Descoberto</b> é o que
                  fica fora dos caminhões se nada for adiantado. <b>Atende</b> é reservado a
                  estoque físico — coberta só por produção futura, a linha fica em{' '}
                  <b>aguardando produção</b>.
                </p>
              </>
            )}
          </Cartao>

          {/* ---------------- por tipo de venda ---------------- */}
          <Cartao titulo="Por tipo de venda" className="mb-5">
            <div className="grid gap-4 md:grid-cols-2">
              <PainelLado titulo="VENDA COOPERADO" lado={porTipo.cooperado} cor="roxo" />
              <PainelLado titulo="OUTRAS VENDAS" lado={porTipo.outras} cor="neutro" />
            </div>
            <p className="mt-3 text-xs text-stone-500">
              A fila é <b>uma só</b>: o estoque de cada produto é dado aos caminhões em ordem de
              data, sem olhar o tipo de venda — cada lado só soma o que coube e o que ficou
              descoberto nos seus caminhões. Nenhum bag é contado duas vezes.
            </p>
            {transferencias.n > 0 && (
              <p className="mt-2 text-xs text-amber-800 dark:text-amber-300">
                <b>{transferencias.n} agendamento(s) · {inteiro(transferencias.bags)} bg</b> são de pedido de outra
                filial e precisam de transferência de saldo:{' '}
                {transferencias.porFilial.map(([f, v]) => `${f} ${v.n} (${inteiro(v.bags)} bg)`).join(' · ')}.
              </p>
            )}
          </Cartao>

          {/* ---------------- agendamentos ---------------- */}
          <Cartao
            titulo={`Agendamentos (${listaVisivel.length} de ${agendamentos.length})`}
            className="mb-5"
            acoes={
              temSelecao ? (
                <Chip ativo={soSelecao} onClick={() => setSoSelecao((v) => !v)}>
                  só as cargas marcadas ({filtrados.filter(naSelecao).length})
                </Chip>
              ) : undefined
            }
          >
            {listaVisivel.length === 0 ? (
              <Vazio>Nenhum agendamento passa pelos filtros.</Vazio>
            ) : (
              <Tabela cabecalho={[
                'Data',
                { texto: 'Pedido', className: 'hidden lg:table-cell' },
                { texto: 'Filial', className: 'hidden lg:table-cell' },
                { texto: 'Tipo venda', className: 'hidden lg:table-cell' },
                'Status', 'Cliente', 'Cultivar',
                { texto: 'Tratamento', className: 'hidden lg:table-cell' },
                { texto: 'Emb.', className: 'hidden lg:table-cell' },
                '#Agendado',
                { texto: 'Carga', className: 'hidden lg:table-cell' },
                '',
              ]}>
                {[...listaVisivel]
                  .sort((a, b) => (a.data ?? '').localeCompare(b.data ?? '') || (a.cliente ?? '').localeCompare(b.cliente ?? ''))
                  .map((a) => {
                    const al = alocacao.get(a.id)
                    const tr = transferencia(a)
                    // com recorte ligado e a lista inteira à vista, a linha marcada
                    // ganha destaque: dá para ver, nas vizinhas, quem vem antes dela
                    const marcada = temSelecao && naSelecao(a)
                    return (
                      <tr
                        key={a.id}
                        className={`border-t border-stone-100 dark:border-stone-800/60 ${
                          marcada ? 'border-l-2 border-l-green-600 bg-green-50/60 dark:bg-green-950/20' : ''
                        }`}
                      >
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          {a.data ? diaCurto(a.data) : (
                            <span className="text-amber-600 dark:text-amber-400">sem data</span>
                          )}
                        </td>
                        <td className="hidden num-tabular px-2 py-1.5 lg:table-cell">{a.pedido ?? '—'}</td>
                        <td className="hidden px-2 py-1.5 text-xs lg:table-cell" title={tr.filial ?? undefined}>
                          {tr.curto ? (
                            <span className={tr.precisa ? 'font-medium text-amber-800 dark:text-amber-300' : 'text-stone-500'}>
                              {tr.curto}
                            </span>
                          ) : (
                            <span className="text-stone-400">{filiais.size === 0 ? '—' : 'não informada'}</span>
                          )}
                        </td>
                        <td className="hidden px-2 py-1.5 lg:table-cell">
                          {tipoVendaDestacado(a.tipo_venda) ? <Tag cor="roxo">{a.tipo_venda}</Tag> : <span className="text-stone-600 dark:text-stone-300">{a.tipo_venda || '—'}</span>}
                        </td>
                        <td className="px-2 py-1.5"><Tag cor={corStatusEntrega(a.status_entrega)}>{a.status_entrega}</Tag></td>
                        {/* break-words em vez de truncate: em toque não há hover pro title */}
                        <td className="max-w-56 break-words px-2 py-1.5">
                          {a.cliente ?? '—'}
                          {(a.cidade || a.estado) && (
                            <p className="text-xs text-stone-500">{[a.cidade, a.estado].filter(Boolean).join('/')}</p>
                          )}
                          <p className="text-xs text-stone-500 lg:hidden">
                            {[
                              a.pedido && `pedido ${a.pedido}`,
                              tr.precisa ? `transferência ${tr.curto}` : null,
                              tipoVendaDestacado(a.tipo_venda) ? a.tipo_venda.replace(/^VENDAs+/i, '') : null,
                              a.carga && `carga ${a.carga}`,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </p>
                        </td>
                        <td className="px-2 py-1.5 font-medium">
                          {a.cultivar}
                          <p className="text-xs font-normal text-stone-500 lg:hidden">
                            {a.tratamento === SEM_TSI ? 'SEM TSI' : a.tratamento} · {a.embalagem}
                          </p>
                        </td>
                        <td className="hidden px-2 py-1.5 lg:table-cell">
                          {a.tratamento === SEM_TSI ? <Tag cor="neutro">SEM TSI</Tag> : a.tratamento}
                        </td>
                        <td className="hidden px-2 py-1.5 lg:table-cell">{a.embalagem}</td>
                        <td
                          className="num-tabular px-2 py-1.5 text-right"
                          title={a.qtd_pedido !== a.bags ? `Pedido de ${inteiro(a.qtd_pedido)} bags — agendados ${inteiro(a.bags)}` : undefined}
                        >
                          {inteiro(a.bags)}
                          {a.qtd_pedido > a.bags && <span className="text-xs text-stone-400"> / {inteiro(a.qtd_pedido)}</span>}
                        </td>
                        <td className="hidden px-2 py-1.5 text-xs text-stone-500 lg:table-cell">
                          {a.carga ? `${a.carga}${a.status_carga ? ` · ${a.status_carga}` : ''}` : '—'}
                        </td>
                        <td className="px-2 py-1.5 whitespace-nowrap">
                          <div className="flex flex-col items-start gap-1">
                            {al == null ? null : al.descoberto <= 0 ? (
                              <Tag cor="ok">coberto</Tag>
                            ) : al.coberto <= 0 ? (
                              <Tag cor="perigo">descoberto {inteiro(al.descoberto)}</Tag>
                            ) : (
                              <Tag cor="alerta">parcial {inteiro(al.coberto)} de {inteiro(al.bags)}</Tag>
                            )}
                            {tr.precisa && (
                              <span title={`Pedido da filial ${tr.filial} — solicitar transferência de saldo`}>
                                <Tag cor="alerta" className="text-[10px]">transferência · {tr.curto}</Tag>
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
              </Tabela>
            )}
          </Cartao>
        </>
      )}
    </Pagina>
  )
}

/** "— ordem 148734 · Qualidade apontada" para os avisos de texto corrido. */
const ordensCurto = (ordens: OrdemPrevista[]): string =>
  ordens.length === 0
    ? ''
    : ' — ' + (ordens.length === 1 ? 'ordem ' : 'ordens ') +
      ordens.map((o) => `${o.numero ?? 'sem nº'} · ${o.status ?? '?'}`).join(', ')

/**
 * As ordens que cobrem uma linha, com nº e status (19/09/2026, pedido do
 * Arion: "não dá pra colocar o status da ordem?"). Antes a tela dizia
 * "aguardando produção" para uma ordem já com qualidade apontada — os bags
 * existiam, só não estavam no saldo do SAP — e ninguém achava a ordem.
 */
function OrdensDaLinha({ ordens }: { ordens: OrdemPrevista[] }) {
  if (ordens.length === 0) return null
  const lista = [...ordens].sort((a, b) => (a.dataProg ?? '9999').localeCompare(b.dataProg ?? '9999'))
  return (
    <ul className="mt-1 space-y-0.5 text-xs text-stone-500 dark:text-stone-400">
      {lista.map((o, i) => (
        <li key={`${o.numero ?? 'sem'}|${i}`} className="whitespace-nowrap">
          <span className="num-tabular font-medium text-stone-700 dark:text-stone-200">
            {o.numero ?? 'sem nº'}
          </span>
          {' · '}{o.status ?? '—'}{' · '}{inteiro(o.bags)} bg
          {o.dataProg ? ` · ${diaCurto(o.dataProg)}` : ' · sem dia'}
        </li>
      ))}
    </ul>
  )
}

function Chip({ ativo, onClick, children }: { ativo: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-2.5 py-1.5 text-xs sm:py-0.5 ${
        ativo
          ? 'border-stone-900 bg-stone-900 text-white dark:border-stone-100 dark:bg-stone-100 dark:text-stone-900'
          : 'border-stone-300 text-stone-500 dark:border-stone-700'
      }`}
    >
      {children}
    </button>
  )
}

function PainelLado({ titulo, lado, cor }: { titulo: string; lado: LadoTipoVenda; cor: Parameters<typeof Tag>[0]['cor'] }) {
  return (
    <div className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
      <div className="flex items-baseline justify-between gap-2">
        <Tag cor={cor}>{titulo}</Tag>
        <span className="text-xs text-stone-500">{lado.caminhoes} agendamento(s)</span>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div>
          <dt className="text-xs text-stone-500">Agendado</dt>
          <dd className="num-tabular text-lg font-semibold">{inteiro(lado.agendado)}</dd>
        </div>
        <div>
          <dt className="text-xs text-stone-500">Coberto</dt>
          <dd className="num-tabular text-lg font-semibold text-green-700 dark:text-green-400">{inteiro(lado.coberto)}</dd>
        </div>
        <div>
          <dt className="text-xs text-stone-500">Descoberto</dt>
          <dd className={`num-tabular text-lg font-semibold ${lado.descoberto > 0 ? 'text-red-700 dark:text-red-400' : 'text-stone-400'}`}>
            {inteiro(lado.descoberto)}
          </dd>
        </div>
      </dl>
      {/* TODOS os produtos do grupo (19/09/2026, pedido do Arion: "mostra a
          quantidade do cooperado ou multiplicador, mas não quais são os
          produtos"): em falta primeiro, depois os maiores agendados */}
      {lado.produtos.length > 0 ? (
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="border-b border-stone-200 text-left text-[10px] uppercase tracking-wide text-stone-500 dark:border-stone-800">
              <th className="py-1 pr-2 font-medium">Produto</th>
              <th className="num-tabular py-1 px-1 text-right font-medium">Agend.</th>
              <th className="num-tabular py-1 px-1 text-right font-medium">Coberto</th>
              <th className="num-tabular py-1 pl-1 text-right font-medium">Falta</th>
            </tr>
          </thead>
          <tbody>
            {lado.produtos.map((p) => (
              <tr key={`${p.cultivar}|${p.tratamento}|${p.embalagem}`} className="border-t border-stone-100 dark:border-stone-800/60">
                <td className="py-1 pr-2 align-middle">
                  <b>{p.cultivar}</b> · {p.tratamento === SEM_TSI ? 'SEM TSI' : p.tratamento}
                  <span className="text-xs text-stone-500"> · {p.embalagem}</span>
                  <span className="text-xs text-stone-400"> · {p.caminhoes} cam.</span>
                </td>
                <td className="num-tabular py-1 px-1 text-right align-middle">{inteiro(p.agendado)}</td>
                <td className="num-tabular py-1 px-1 text-right align-middle text-green-700 dark:text-green-400">{inteiro(p.coberto)}</td>
                <td className="num-tabular py-1 pl-1 text-right align-middle">
                  {p.descoberto > 0 ? (
                    <Tag cor="perigo">faltam {inteiro(p.descoberto)}</Tag>
                  ) : (
                    <span className="text-stone-300 dark:text-stone-700">·</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mt-3 text-xs text-stone-500">Nenhum agendamento deste tipo nos filtros.</p>
      )}
      {lado.produtos.length > 0 && lado.descoberto === 0 && (
        <p className="mt-2 text-xs text-green-700 dark:text-green-400">Tudo coberto na data.</p>
      )}
    </div>
  )
}

function corStatusEntrega(s: string): Parameters<typeof Tag>[0]['cor'] {
  if (/aprovado/i.test(s)) return 'ok'
  if (/aguardando/i.test(s)) return 'alerta'
  if (/cancel/i.test(s)) return 'perigo'
  return 'neutro'
}
