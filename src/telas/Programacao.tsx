import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '@/dados/api'
import * as g from '@/dados/api-gestao'
import type { AgendamentoBanco, OrdemVisao } from '@/dados/api-gestao'
import { diaDeProducao } from '@/dominio/calculos'
import {
  autoProgramar,
  DIA_CHEIO,
  HORAS_TURNOS,
  checklistDoDia,
  horasDoDia,
  melhorSlot,
  otimizarSequencia,
  rebalancearDia,
  reprogramarCascata,
  resumoHorasFila,
  rotuloTurnos,
  toneladasPorTratamento,
  type HorasDia,
  type MaquinaCapacidade,
  type OrdemProgramavel,
  type TurnosDoDia,
} from '@/dominio/programacao'
import { useRealtime } from '@/dados/useRealtime'
import { alternarNaFaixa, faixaDe, listaAposArraste, moverNaFaixa, semDaFaixa } from '@/dominio/prioridadesDia'
import { alternarOrdenacao, type Ordenacao } from '@/dominio/ordenacao'
import { ehConcluida, exibicaoDoDia, grupoMovel, type CampoQuadro } from '@/dominio/quadroDoDia'
import { ordensSemAgenda } from '@/dominio/ordensSemAgenda'
import ModalOrdem from './ModalOrdem'
import { ListaMaquinaDia } from './ProgramacaoLista'
import { jaIniciada } from '@/dominio/status'
import type { StatusEfetivo } from '@/dominio/tipos'
import { useAuth } from '@/auth/AuthProvider'
import {
  Aviso, Botao, Cartao, Erro, Pagina, Tabela, Tag, Vazio,
  corDoStatus, diaCurto, diaSemana, n, somaDias,
} from '@/componentes/ui'

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

/** Ordem de exibição dos chips de status — a mesma sequência do ciclo de vida. */
const ORDEM_STATUS: StatusEfetivo[] = [
  'Nao programada', 'Programada', 'Aguardando lote', 'Pronto para produzir',
  'Em producao', 'Parada', 'Finalizada', 'Qualidade apontada', 'Apontada',
]

/** Onde a ordem arrastada vai cair: célula e posição na fila (null = no fim). */
type Alvo = { maq: string; dia: string; pos: number | null } | null

export default function Programacao() {
  const { usuario, permitido } = useAuth()
  const podeProgramar = permitido('programacao', 'editar')
  /** Botão "urgente" no cartão e na lista (19/09/2026) — a mesma ação Priorizar da tela de Ordens. */
  const podeMarcarUrgente = permitido('ordens', 'priorizar')

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
  /**
   * Faixa "Prioridades do dia" (16/09/2026): alvo próprio do arraste (a faixa
   * de cada máquina) e de onde a ordem saiu — soltar uma ordem DA FAIXA na
   * fila tira ela da faixa, em vez de mover o seq.
   */
  const [alvoFaixa, setAlvoFaixa] = useState<{ maq: string; dia: string; pos: number | null } | null>(null)
  const [arrastandoDaFaixa, setArrastandoDaFaixa] = useState(false)
  const [movendo, setMovendo] = useState<string | null>(null)
  const [previa, setPrevia] = useState<ReturnType<typeof reprogramarCascata> | null>(null)
  /** De onde a prévia da cascata partiu (o botão da semana usa diaSel; o das atrasadas, ontem). */
  const [previaDesde, setPreviaDesde] = useState('')
  /**
   * Atrasadas: programadas em dia que já passou e nunca iniciadas. Busca
   * PRÓPRIA, fora da janela da semana — atrasada não some por navegação
   * (13 ordens de 27/08 "sumiram" quando a semana virou; 03/09/2026).
   */
  const [atrasadas, setAtrasadas] = useState<OrdemVisao[]>([])
  /**
   * Filtro por status do quadro do dia. Vazio = mostra tudo — o dia
   * misturava ordens em estágios bem diferentes (pronta para produzir,
   * parada, já com qualidade apontada) na mesma lista, e achar o que
   * precisa de ação agora exigia ler linha por linha.
   */
  const [filtroStatus, setFiltroStatus] = useState<Set<StatusEfetivo>>(new Set())

  /** Cartão "Programado por tratamento": a semana à vista ou só o dia selecionado. */
  const [recorteTratamento, setRecorteTratamento] = useState<'semana' | 'dia'>('semana')

  /**
   * Quadro do dia em LISTA por máquina (19/09/2026, pedido do Arion: "a tela
   * de programação está ruim de olhar… quase como um Excel"). Abre SEMPRE na
   * lista — decisão dele, por isso não persiste; os cartões ficam atrás do
   * botão, para arrastar, ▲▼ e a faixa de prioridades.
   */
  const [modoQuadro, setModoQuadro] = useState<'lista' | 'cartoes'>('lista')
  /**
   * Ordenação da lista, POR MÁQUINA (a 1ª versão tinha um estado só e "quando
   * eu classifico uma, a de baixo classifica também" — Arion, 19/09/2026).
   * Só visão: o seq não muda.
   */
  const [ordenacaoPorMaquina, setOrdenacaoPorMaquina] = useState<Record<string, Ordenacao<CampoQuadro>>>({})
  const ordenarMaquina = (maq: string, campo: CampoQuadro) =>
    setOrdenacaoPorMaquina((a) => ({ ...a, [maq]: alternarOrdenacao(a[maq] ?? null, campo) }))
  const semOrdenacao = (maq: string) => setOrdenacaoPorMaquina((a) => ({ ...a, [maq]: null }))
  /**
   * Lista pela sequência gravada, sem separar por status ("Otimizar sem
   * status", 19/09/2026): por status, a sequência otimizada não aparece de
   * ponta a ponta — uma FTZ60 aguardando lote e uma FTZ60 pronta ficam em
   * grupos diferentes mesmo com seq vizinho, e "a otimização parece levar
   * o status em consideração".
   */
  const [filaSemStatus, setFilaSemStatus] = useState<Record<string, boolean>>({})
  /**
   * Detalhe da ordem (ModalOrdem) aberto a partir da lista. Motivos e
   * produtos já vinham do carregarCadastros e eram descartados; embalagens
   * e a conferência DA ORDEM entram só no clique (a carga inicial roda a
   * cada semana navegada — não é lugar de buscar o que raramente se usa).
   */
  const [motivos, setMotivos] = useState<api.LinhaMotivo[]>([])
  const [produtos, setProdutos] = useState<api.LinhaProduto[]>([])
  const [embalagens, setEmbalagens] = useState<g.EmbalagemLinha[] | null>(null)
  const [ordemAberta, setOrdemAberta] = useState<{ ordem: api.LinhaOrdem; conferencia: g.ConferenciaLinha | null } | null>(null)
  const [abrindoId, setAbrindoId] = useState<string | null>(null)
  /**
   * Nº de itens de cada receita (19/09/2026): a otimização de sequência e a
   * coluna Tratamento da lista põem a base antes das derivações. Carregado
   * uma vez, junto dos cadastros — receita não muda no meio do dia.
   */
  const [itensPorReceita, setItensPorReceita] = useState<Map<string, number>>(new Map())
  /**
   * Ordens sem caminhão até X (19/09/2026): os agendamentos da Expedição,
   * carregados uma vez e por realtime próprio — fora do `recarregar` da semana,
   * que já faz quatro consultas a cada navegação. `null` = ainda não carregou;
   * `false` = a consulta falhou (a lista NÃO diz "todas sem caminhão" — diz que
   * não sabe).
   */
  const [agendamentos, setAgendamentos] = useState<AgendamentoBanco[]>([])
  const [agendamentosOk, setAgendamentosOk] = useState<boolean | null>(null)
  /** Até que dia procurar caminhão; vazio = o fim da semana à vista. */
  const [ateAgenda, setAteAgenda] = useState('')
  /**
   * Ordens programadas entre HOJE − 14 e o começo da janela — o mesmo horizonte
   * para trás que a semana atual enxerga, seja qual for a semana à vista (a
   * janela começa 14 dias antes dela). Sem isto o cartão "Ordens sem caminhão"
   * dizia "todas têm caminhão" calado sobre as ordens desta semana, e a ordem
   * iniciada com dia passado (que não é "atrasada": status cru ≠ Programada)
   * entrava ou não na conta conforme a semana navegada (achados da revisão de
   * 19/09/2026).
   */
  const [ordensAntesDaJanela, setOrdensAntesDaJanela] = useState<OrdemVisao[]>([])
  /** Cadastro de embalagens lido? null = ainda não; false = falhou (SC10/SC20 podem vazar para a lista). */
  const [embalagensOk, setEmbalagensOk] = useState<boolean | null>(null)

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
      const hoje = diaDeProducao(new Date())
      const [lista, poolLista, cal, atrasadasLista, antesDaJanela] = await Promise.all([
        g.listarOrdens(janela.de, janela.ate),
        g.listarPool(),
        g.listarDiasProducao(janela.de, janela.ate),
        g.listarOrdensAtrasadas(hoje),
        janela.de > somaDias(hoje, -14) ? g.listarOrdens(somaDias(hoje, -14), somaDias(janela.de, -1)) : Promise.resolve([]),
      ])
      setOrdens(lista)
      setPool(poolLista)
      setCalendario(cal)
      setAtrasadas(atrasadasLista)
      setOrdensAntesDaJanela(antesDaJanela)
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    }
  }, [janela])

  useEffect(() => {
    let vivo = true
    setCarregando(true)
    const hoje = diaDeProducao(new Date())
    Promise.all([
      api.carregarCadastros(),
      g.listarOrdens(janela.de, janela.ate),
      g.listarPool(),
      g.listarDiasProducao(janela.de, janela.ate),
      g.listarOrdensAtrasadas(hoje),
      janela.de > somaDias(hoje, -14) ? g.listarOrdens(somaDias(hoje, -14), somaDias(janela.de, -1)) : Promise.resolve([]),
    ])
      .then(([c, lista, poolLista, cal, atrasadasLista, antesDaJanela]) => {
        if (!vivo) return
        setMaquinas(c.maquinas)
        setMotivos(c.motivos)
        setProdutos(c.produtos)
        setOrdens(lista)
        setPool(poolLista)
        setCalendario(cal)
        setAtrasadas(atrasadasLista)
        setOrdensAntesDaJanela(antesDaJanela)
      })
      .catch((e) => vivo && setErro(e instanceof Error ? e.message : String(e)))
      .finally(() => vivo && setCarregando(false))
    return () => {
      vivo = false
    }
  }, [janela])

  // receitas UMA vez só (o efeito acima roda a cada semana navegada): a
  // contagem de itens não muda com a semana. Sem ela a ordenação por
  // tratamento cai no nome — não vale derrubar a tela por isso.
  useEffect(() => {
    let vivo = true
    g.listarReceitas()
      .then((rs) => {
        if (vivo) setItensPorReceita(new Map(rs.map((r) => [r.id, r.receita_itens.length])))
      })
      .catch(() => {})
    // embalagens: o cartão "Ordens sem caminhão" precisa saber quais são de peso
    // fixo (SC10/SC20, fora dos ERPs) — antes só carregavam ao abrir uma ordem
    g.listarEmbalagens()
      .then((es) => {
        if (!vivo) return
        setEmbalagens(es)
        setEmbalagensOk(true)
      })
      .catch(() => vivo && setEmbalagensOk(false))
    return () => {
      vivo = false
    }
  }, [])

  useRealtime(['ordens', 'lotes_semente', 'dias_producao', 'ordem_prioridades_dia'], recarregar)

  const recarregarAgendamentos = useCallback(() => {
    g.listarAgendamentos()
      .then((a) => {
        setAgendamentos(a)
        setAgendamentosOk(true)
      })
      .catch(() => setAgendamentosOk(false))
  }, [])
  useEffect(() => {
    recarregarAgendamentos()
  }, [recarregarAgendamentos])
  useRealtime(['agendamentos'], recarregarAgendamentos)

  /** Turnos que o dia roda. Sem exceção cadastrada, roda os dois. */
  const turnosDoDia = useCallback(
    (dia: string): TurnosDoDia => {
      const c = calendario.find((x) => x.data === dia)
      return c ? { t1: c.turno1, t2: c.turno2 } : { t1: true, t2: true }
    },
    [calendario],
  )

  /**
   * Capacidade de cada máquina para o domínio: t/h e os minutos de setup do
   * cadastro. A conta da ocupação é em HORAS desde 13/09/2026 — é assim que
   * o setup entre ordens (20 min mesmo tratamento, 40 na troca) entra.
   */
  const capacidades = useMemo<MaquinaCapacidade[]>(
    () =>
      maquinas.map((m) => ({
        id: m.id,
        capacidadeTh: m.capacidade_th,
        horasDia: horasDoDia(DIA_CHEIO, HORAS_TURNOS),
        setup: { mesmoMin: m.setup_mesmo_min, trocaMin: m.setup_troca_min },
      })),
    [maquinas],
  )

  /** Horas reais do dia: caem pela metade num dia de um turno só. */
  const capDia = useCallback<HorasDia>(
    (_maquinaId, dia) => horasDoDia(turnosDoDia(dia), HORAS_TURNOS),
    [turnosDoDia],
  )

  const paraDominio = useCallback(
    (o: OrdemVisao): OrdemProgramavel => ({
      id: o.id,
      numero: o.numero,
      cultivar: o.cultivar,
      receitaId: o.receita_id,
      receitaNome: o.receita_nome,
      prioridade: o.prioridade,
      pesoT: o.peso_t,
      // explícito, não "!== 'Aguardando lote'": Programada (11/08/2026,
      // aguardando confirmação do PCP) também não tem lote baixado ainda
      loteBaixado: o.status_efetivo === 'Pronto para produzir',
      maquinaId: o.maquina_id,
      dataProg: o.data_prog,
      seq: o.seq,
      iniciada: jaIniciada(o.status_efetivo as StatusEfetivo),
    }),
    [],
  )

  /**
   * TODAS as ordens no formato do domínio, inclusive as já iniciadas
   * (`iniciada: true`). Antes só as mexíveis entravam, e a ordem Em produção
   * sumia da conta: o checklist e o Encaixar viam horas livres que a máquina
   * não tinha, e o setup da próxima ignorava o que estava rodando. O domínio
   * nunca move uma iniciada; ela só pesa.
   */
  const programaveis = useMemo<OrdemProgramavel[]>(
    () => [...ordens, ...pool].map(paraDominio),
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

  /**
   * Ocupação da célula em HORAS: produção (peso ÷ t/h) + setup entre as
   * ordens na sequência gravada. `ton` continua para a leitura do PCP, mas
   * o percentual é horas ÷ horas do dia.
   */
  const ocupacaoCelula = useCallback(
    (maq: string, dia: string) => {
      const cap = capDia(maq, dia)
      const m = capacidades.find((x) => x.id === maq)
      const fila = celula(maq, dia)
      const ton = fila.reduce((a, o) => a + o.peso_t, 0)
      const horasDe = (lista: OrdemVisao[]) =>
        m
          ? resumoHorasFila(
              lista.map((o) => ({ pesoT: o.peso_t, receitaId: o.receita_id })),
              m.capacidadeTh,
              m.setup,
            )
          : { producaoH: 0, setupMin: 0, trocas: 0, horas: 0 }
      const r = horasDe(fila)
      // o que AINDA FALTA: ordens que a produção ainda não deu por produzidas
      // — finalizada é a que já teve a quantidade produzida informada
      // (pedido do Arion, 19/09/2026: quanto em tonelada e tempo ainda falta
      // para produzir ordens não finalizadas)
      const restante = fila.filter((o) => !ehConcluida(o.status_efetivo))
      const rf = horasDe(restante)
      return {
        ton,
        cap,
        capacidadeTh: m?.capacidadeTh ?? 0,
        horas: r.horas,
        setupMin: r.setupMin,
        trocas: r.trocas,
        ordens: fila.length,
        pct: cap > 0 && Number.isFinite(r.horas) ? (r.horas / cap) * 100 : 0,
        falta: {
          ton: restante.reduce((a, o) => a + o.peso_t, 0),
          horas: rf.horas,
          setupMin: rf.setupMin,
          ordens: restante.length,
        },
      }
    },
    [capDia, capacidades, celula],
  )

  /**
   * Toneladas programadas por tratamento no recorte escolhido. Só ordens com
   * máquina e dia; Apontada fica fora porque já virou estoque, Excluida a
   * consulta já não traz.
   */
  const porTratamento = useMemo(() => {
    const noRecorte = (o: OrdemVisao) =>
      !!o.maquina_id &&
      !!o.data_prog &&
      o.status_efetivo !== 'Apontada' &&
      (recorteTratamento === 'dia' ? o.data_prog === diaSel : dias.includes(o.data_prog))
    const linhas = toneladasPorTratamento(
      ordens
        .filter(noRecorte)
        .map((o) => ({ tratamento: o.receita_nome, pesoT: o.peso_t, bags: o.bags })),
    )
    return { linhas, total: linhas.reduce((a, l) => a + l.pesoT, 0) }
  }, [ordens, recorteTratamento, diaSel, dias])

  /**
   * Ordens sem caminhão até X (19/09/2026): a janela carregada mais as
   * atrasadas (o domínio deduplica), contra os agendamentos da Expedição.
   */
  const ateAgendaEfetivo = ateAgenda || dias[6]
  /** Embalagens de peso fixo (SC10/SC20): fora dos ERPs, nunca têm agendamento — saem da conta. */
  const embalagensForaDosErps = useMemo(
    () => new Set((embalagens ?? []).filter((e) => (e.peso_fixo_kg ?? 0) > 0).map((e) => e.codigo)),
    [embalagens],
  )
  const semAgenda = useMemo(
    () =>
      ordensSemAgenda(
        [...ordens, ...ordensAntesDaJanela, ...atrasadas],
        agendamentos.map((a) => ({
          cultivar: a.cultivar, tratamento: a.tratamento, embalagem: a.embalagem, data: a.data, bags: a.bags,
        })),
        ateAgendaEfetivo,
        { foraDosErps: (e) => embalagensForaDosErps.has(e) },
      ),
    [ordens, ordensAntesDaJanela, atrasadas, agendamentos, ateAgendaEfetivo, embalagensForaDosErps],
  )
  /**
   * Marca sutil no quadro do dia (20/09/2026, pedido do Arion: "hoje tenho
   * que ficar comparando manualmente" entre o cartão de cima e a fila da
   * máquina). Só marca com resposta CONFIÁVEL — agendamentos carregados e
   * embalagens carregadas (sem elas, SC10/SC20 entrariam em `semAgenda` por
   * engano e a marca mentiria) — vazio enquanto qualquer um dos dois falta.
   */
  const semCaminhaoIds = useMemo(
    () =>
      agendamentosOk && agendamentos.length > 0 && embalagensOk
        ? new Set(semAgenda.semAgenda.map((x) => x.ordem.id))
        : new Set<string>(),
    [agendamentosOk, agendamentos.length, embalagensOk, semAgenda],
  )

  const dicaOcupacao = (o: ReturnType<typeof ocupacaoCelula>) =>
    `${o.ordens} ordem(ns) · ${o.trocas} troca(s) de tratamento · ${o.setupMin} min de setup · ` +
    `${n(o.horas, 1)} h de ${n(o.cap, 1)} h`

  /**
   * Resumo da máquina no dia — no cartão e na lista. Cada número com a sua
   * legenda (19/09/2026, Arion: "no cabeçalho não dá pra saber o que é o
   * que") e o que AINDA FALTA produzir: as ordens não finalizadas —
   * finalizada é a que a produção já informou a quantidade produzida.
   */
  const resumoOcupacao = (o: ReturnType<typeof ocupacaoCelula>) => {
    const item = (rotulo: string, valor: string, titulo?: string, destaque = false) => (
      <span
        key={rotulo}
        title={titulo}
        className={`inline-flex items-baseline gap-1.5 rounded-md border px-2 py-0.5 ${
          destaque
            ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200'
            : 'border-stone-200 dark:border-stone-700'
        }`}
      >
        <span className="text-[10px] font-medium uppercase tracking-wide text-stone-500 dark:text-stone-400">{rotulo}</span>
        <span className="num-tabular font-medium">{valor}</span>
      </span>
    )
    if (o.cap <= 0) {
      return (
        <p className="mb-3 text-xs font-medium text-amber-700 dark:text-amber-400">
          Dia sem produção{o.ton > 0 && ` — ${n(o.ton, 1)} t ainda programadas aqui`}
        </p>
      )
    }
    const plural = (q: number) => (q === 1 ? 'ordem' : 'ordens')
    return (
      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs text-stone-700 dark:text-stone-300">
        {item('Programado', `${n(o.ton, 1)} t · ${n(o.horas, 1)} h`, `${o.ordens} ${plural(o.ordens)} no dia — horas de produção mais setup`)}
        {item('Setup previsto', `${o.setupMin} min`, `${o.trocas} troca(s) de tratamento`)}
        {item('Dia', `${n(o.cap, 1)} h · ${rotuloTurnos(turnosDoDia(diaSel))}`, 'Horas disponíveis nos turnos que o dia roda')}
        {item('Ocupação', `${n(o.pct, 0)}%`, dicaOcupacao(o))}
        {item(
          'Falta produzir',
          `${n(o.falta.ton, 1)} t · ${n(o.falta.horas, 1)} h · ${o.falta.ordens} ${plural(o.falta.ordens)}`,
          'Ordens ainda NÃO finalizadas — finalizada é a que a produção já informou a quantidade produzida. Horas de produção mais setup.',
          true,
        )}
      </div>
    )
  }

  /**
   * "Otimizar sequência" — no cartão e na lista (não é arraste; o PCP usa no
   * tablet). Na lista, zera a ordenação por coluna daquela máquina: a
   * otimização regrava o seq, e numa tabela ordenada por cultivar nada se
   * mexia — "o botão parece que não funciona" (Arion, 19/09/2026).
   */
  const otimizar = (lista: OrdemVisao[], maq: string, semStatus: boolean) =>
    comErro(async () => {
      const fila = lista
        .filter((x) => !jaIniciada(x.status_efetivo as StatusEfetivo))
        .map((x) => programaveis.find((p) => p.id === x.id)!)
        .filter(Boolean)
      semOrdenacao(maq)
      setFilaSemStatus((a) => ({ ...a, [maq]: semStatus }))
      await g.aplicarAtribuicoes(otimizarSequencia(fila, itensPorReceita))
    })
  const botaoOtimizar = (lista: OrdemVisao[], maq: string) =>
    podeProgramar && lista.length > 1 ? (
      <>
        <Botao
          titulo="Agrupa por família de tratamento (base antes das derivações) para reduzir trocas, mantendo urgentes na frente; a lista continua separada por status"
          onClick={() => otimizar(lista, maq, false)}
        >
          Otimizar sequência
        </Botao>
        {modoQuadro === 'lista' && (
          <Botao
            titulo="A mesma otimização, e a lista passa a mostrar a fila pela sequência gravada, sem separar por status — a sequência otimizada de ponta a ponta"
            onClick={() => otimizar(lista, maq, true)}
          >
            Otimizar sem status
          </Botao>
        )}
      </>
    ) : undefined

  /** Botão "prioridade" (16/09/2026) — o mesmo clique no cartão e na lista. */
  const alternarPrioridadeDia = (maq: string, dia: string, lista: OrdemVisao[], ord: OrdemVisao) => {
    const ids = faixaDe(lista.filter((x) => !ehConcluida(x.status_efetivo))).map((x) => x.id)
    return comErro(() => g.definirPrioridadesDia(maq, dia, alternarNaFaixa(ids, ord.id)))
  }

  /** O PainelMover, com os mesmos fechos, nos dois modos. */
  const painelMoverDe = (ord: OrdemVisao, maq: string) => (
    <PainelMover
      maquinas={maquinas}
      dias={dias}
      atual={{ maq, dia: diaSel }}
      onFechar={() => setMovendo(null)}
      onMover={(m2, d2, inicio) => {
        setMovendo(null)
        comErro(() => mover(ord.id, m2, d2, inicio ? 0 : null))
      }}
      onPool={() => {
        setMovendo(null)
        comErro(() => desprogramar(ord.id))
      }}
    />
  )

  /**
   * Grupo em que a ordem pode subir/descer: o do seu status (cartões e lista
   * por status) ou a fila inteira das não iniciadas (lista pela sequência —
   * ali o vizinho da fila está visível, então a troca pode ser com ele).
   */
  const grupoDe = (lista: OrdemVisao[], ord: OrdemVisao, porStatus = true) =>
    porStatus
      ? grupoMovel(exibicaoDoDia(lista).grupos, ord)
      : lista.filter((x) => !jaIniciada(x.status_efetivo as StatusEfetivo))
  const posicaoNoGrupo = (lista: OrdemVisao[], ord: OrdemVisao, porStatus = true) => {
    const grupo = grupoDe(lista, ord, porStatus)
    return { pos: grupo.indexOf(ord), tamanho: grupo.length }
  }

  /**
   * ▲▼ — troca com o vizinho do MESMO grupo (mesmo status) e regrava a fila
   * inteira; o mesmo clique no cartão e na lista. Trocar com o vizinho
   * literal da fila real pareceria não fazer nada (ele pode estar rodando ou
   * concluído, desenhado noutra parte da tela).
   */
  const trocarComVizinho = (
    maq: string, dia: string, lista: OrdemVisao[], ord: OrdemVisao, delta: -1 | 1, porStatus = true,
  ) => {
    const grupo = grupoDe(lista, ord, porStatus)
    const vizinho = grupo[grupo.indexOf(ord) + delta]
    if (!vizinho) return
    const copia = [...lista]
    const iA = copia.indexOf(ord)
    const iB = copia.indexOf(vizinho)
    ;[copia[iA], copia[iB]] = [copia[iB], copia[iA]]
    return comErro(() => g.aplicarAtribuicoes(renumerar(maq, dia, copia)))
  }

  /** Urgente ↔ normal (ação ordens/priorizar) — o mesmo clique no cartão e na lista. */
  const alternarUrgente = (ord: OrdemVisao) =>
    comErro(() => g.definirPrioridade(ord.id, ord.prioridade === 'Urgente' ? 'Normal' : 'Urgente', usuario!.id))

  /** Trocar de modo zera o que era do outro: painel de mover aberto e estados de arraste. */
  const trocarModoQuadro = (md: 'lista' | 'cartoes') => {
    setModoQuadro(md)
    setMovendo(null)
    setArrastando(null)
    setAlvo(null)
    setAlvoFaixa(null)
    setArrastandoDaFaixa(false)
  }

  async function abrirOrdem(id: string) {
    setAbrindoId(id)
    setErro(null)
    try {
      const [o, cf, emb] = await Promise.all([
        api.carregarOrdemPorId(id),
        g.conferenciaDaOrdem(id),
        embalagens ?? g.listarEmbalagens(),
      ])
      if (!o) throw new Error('Ordem não encontrada.')
      setEmbalagens(emb)
      setOrdemAberta({ ordem: o, conferencia: cf })
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e))
    } finally {
      setAbrindoId(null)
    }
  }

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
    const daFaixa = arrastandoDaFaixa
    setArrastando(null)
    setArrastandoDaFaixa(false)
    setAlvo(null)
    setAlvoFaixa(null)
    if (!id) return
    const movida = [...ordens, ...pool].find((o) => o.id === id)
    if (daFaixa && movida && movida.maquina_id === maq && movida.data_prog === dia) {
      // veio da faixa e caiu na fila da MESMA célula: sai da faixa (o seq fica como está)
      const ids = faixaDe(celula(maq, dia)).map((x) => x.id)
      comErro(() => g.definirPrioridadesDia(maq, dia, semDaFaixa(ids, id)))
      return
    }
    // outra célula: move de verdade — o gatilho derruba a prioridade sozinho
    comErro(() => mover(id, maq, dia, pos))
  }

  /** Solta na faixa de prioridades (vindo da fila ou da própria faixa). */
  function soltarNaFaixa(maq: string, dia: string, pos: number | null) {
    const id = arrastando
    setArrastando(null)
    setArrastandoDaFaixa(false)
    setAlvo(null)
    setAlvoFaixa(null)
    if (!id) return
    const movida = [...ordens, ...pool].find((o) => o.id === id)
    if (!movida || movida.maquina_id !== maq || movida.data_prog !== dia) {
      setErro('Só ordens já programadas nesta máquina e neste dia entram na faixa de prioridades.')
      return
    }
    const ids = faixaDe(celula(maq, dia)).map((x) => x.id)
    comErro(() => g.definirPrioridadesDia(maq, dia, listaAposArraste(ids, id, pos)))
  }

  const checklist = useMemo(
    () => checklistDoDia(programaveis, capacidades, diaSel, capDia),
    [programaveis, capacidades, diaSel, capDia],
  )

  const numeroDe = useCallback(
    (id: string) =>
      [...ordens, ...pool, ...atrasadas].find((o) => o.id === id)?.numero ?? id.slice(0, 8),
    [ordens, pool, atrasadas],
  )

  /** Quantas ordens do dia (nas duas máquinas) têm cada status — monta os chips. */
  const statusDoDia = useMemo(() => {
    const contagem = new Map<StatusEfetivo, number>()
    for (const m of maquinas) {
      for (const o of celula(m.id, diaSel)) {
        const st = o.status_efetivo as StatusEfetivo
        contagem.set(st, (contagem.get(st) ?? 0) + 1)
      }
    }
    return ORDEM_STATUS.filter((s) => contagem.has(s)).map((s) => ({ status: s, qtd: contagem.get(s)! }))
  }, [maquinas, diaSel, celula])

  const totalDoDia = statusDoDia.reduce((a, x) => a + x.qtd, 0)

  const visivel = useCallback(
    (o: OrdemVisao) =>
      filtroStatus.size === 0 || filtroStatus.has(o.status_efetivo as StatusEfetivo),
    [filtroStatus],
  )

  function alternarFiltro(st: StatusEfetivo) {
    setFiltroStatus((atual) => {
      const novo = new Set(atual)
      if (novo.has(st)) novo.delete(st)
      else novo.add(st)
      return novo
    })
  }

  if (carregando) return <p className="p-8 text-sm text-stone-500">Carregando programação…</p>

  const diasCascata = Array.from({ length: DIAS_CASCATA + 1 }, (_, i) => somaDias(diaSel, i))

  return (
    <Pagina
      titulo="Programação & Ocupação"
      descricao="Ocupação em horas: peso ÷ capacidade (t/h) mais o setup entre ordens — 20 min no mesmo tratamento, 40 min na troca (cadastro da máquina). Um dia de 2 turnos tem 19,5 h; só 1º turno, 10 h."
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
                  // renumera cada célula tocada (fila atual + novas no fim), como o
                  // Encaixar: o domínio precificou a nova NO FIM da fila, e numa célula
                  // com seq nulo "maior seq + 1" a poria na frente — e o setup contado
                  // não seria o gravado
                  const porCelula = new Map<string, typeof r.atribuicoes>()
                  for (const a of r.atribuicoes) {
                    const chave = `${a.maquinaId}|${a.dia}`
                    porCelula.set(chave, [...(porCelula.get(chave) ?? []), a])
                  }
                  const gravar = [...porCelula.entries()].flatMap(([, novas]) => {
                    const { maquinaId, dia } = novas[0]
                    const entrando = novas
                      .slice()
                      .sort((a, b) => a.seq - b.seq)
                      .map((a) => pool.find((p) => p.id === a.ordemId))
                      .filter((p): p is OrdemVisao => !!p)
                    return renumerar(maquinaId, dia, [...celula(maquinaId, dia), ...entrando])
                  })
                  await g.aplicarAtribuicoes(gravar)
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
                setPreviaDesde(diaSel)
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

      {/* -------- atrasadas: programadas em dia que já passou, sem iniciar.
          Faixa FIXA, independente da semana à vista — atrasada não pode
          sumir por navegação (03/09/2026) -------- */}
      {atrasadas.length > 0 && (
        <Cartao
          titulo={
            <span>
              Atrasadas{' '}
              <span className="font-bold text-red-600 dark:text-red-400">
                ({atrasadas.length})
              </span>
            </span>
          }
          acoes={
            podeProgramar ? (
              <Botao
                variante="primario"
                titulo="Puxa as atrasadas pra frente a partir de hoje, junto com a fila dos próximos dias — com prévia antes de gravar"
                onClick={() => {
                  setErro(null)
                  const hoje = diaDeProducao(new Date())
                  const ontem = somaDias(hoje, -1)
                  const diasDesdeHoje = Array.from(
                    { length: DIAS_CASCATA + 1 },
                    (_, i) => somaDias(hoje, i),
                  )
                  // janela da semana + atrasadas (que podem estar fora dela)
                  const unicas = new Map(
                    [...ordens, ...atrasadas].map((o) => [o.id, o]),
                  )
                  const r = reprogramarCascata(
                    [...unicas.values()].map(paraDominio),
                    capacidades,
                    diasDesdeHoje,
                    ontem,
                    capDia,
                  )
                  if (r.movimentos.length === 0) {
                    setErro(
                      r.naoCouberam.length > 0
                        ? `Nada a reprogramar: ${r.naoCouberam.length} ordem(ns) não cabe(m) nos próximos ${DIAS_CASCATA} dias.`
                        : 'Nada a reprogramar.',
                    )
                    return
                  }
                  setPreviaDesde(ontem)
                  setPrevia(r)
                }}
              >
                Reprogramar atrasadas →
              </Botao>
            ) : undefined
          }
          className="mb-5 border-red-300 dark:border-red-800"
        >
          <p className="mb-2 text-sm text-stone-500 dark:text-stone-400">
            Programadas em dias que já passaram e nunca iniciadas — não aparecem na semana
            atual do plano, mas continuam ocupando lote e numeração. Reprograme ou
            desprograme.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {atrasadas.map((o) => (
              <span
                key={o.id}
                className="inline-flex items-center gap-1.5 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
              >
                <b>{o.numero}</b> {o.cultivar} · {diaCurto(o.data_prog!)} · {o.maquina_id}
                {o.prioridade === 'Urgente' && <b>· URGENTE</b>}
              </span>
            ))}
          </div>
        </Cartao>
      )}

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
          {modoQuadro === 'cartoes'
            ? 'Arraste uma ordem do quadro abaixo sobre qualquer célula para mudá-la de dia ou de máquina.'
            : 'Clique num dia para ver a fila dele na lista abaixo; para arrastar, abra os cartões.'}
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-stone-500">
                {/* sticky: a coluna Máquina não deve rolar junto com os 7 dias
                    — sem referência, uma célula de ocupação isolada não diz nada */}
                <th className="sticky left-0 z-10 bg-white px-2 py-2 dark:bg-stone-900">Máquina</th>
                {dias.map((d) => (
                  <th key={d} className="px-2 py-2 text-center">
                    <button
                      onClick={() => setDiaSel(d)}
                      className={`rounded px-2 py-2 sm:py-0.5 ${d === diaSel ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900' : ''}`}
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
                  <td className="sticky left-0 z-10 bg-white px-2 py-2 font-medium dark:bg-stone-900">
                    {m.nome}
                  </td>
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
                              ? 'bg-green-50 text-green-800 dark:bg-green-950/40 dark:text-green-300'
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
                            destacado ? 'ring-2 ring-green-500' : ''
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
                              <span className="block opacity-70">
                                {n(o.ton, 0)} t · {n(o.horas, 1)} h
                              </span>
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
                        /*
                          Bug real de celular (achado testando no aparelho,
                          08/08/2026): sem min-width o select encolhia com a
                          coluna do dia (~66px) e o texto da opção selecionada
                          ("1º e 2º turno", "sem produção") era cortado no meio
                          da palavra — nem toda opção tem o mesmo tamanho, e
                          <select> nativo não aplica ellipsis sozinho. A
                          tabela já rola horizontalmente; dar espaço aqui só
                          faz o scroll começar um pouco mais perto.
                        */
                        <select
                          value={codigoTurnos(t)}
                          onChange={(e) => {
                            const op = OPCOES_TURNO.find((x) => x.valor === e.target.value)!
                            comErro(() =>
                              g.definirTurnosDoDia(d, op.turnos.t1, op.turnos.t2, usuario!.id),
                            )
                          }}
                          title="Quais turnos rodam neste dia — 1º tem 10 h, 2º tem 9h30, e isso muda a capacidade"
                          className={`min-w-24 w-full rounded border px-1 py-1 text-xs dark:bg-stone-800 ${
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

      {/* -------- programado por tratamento (Arion, 13/09/2026) -------- */}
      <Cartao
        titulo="Programado por tratamento"
        className="mb-5"
        acoes={
          <div className="flex items-center gap-1 text-xs">
            {(['semana', 'dia'] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRecorteTratamento(r)}
                className={`rounded-md border px-2 py-1 ${
                  recorteTratamento === r
                    ? 'border-green-600 bg-green-50 font-medium text-green-800 dark:bg-green-950 dark:text-green-300'
                    : 'border-stone-300 text-stone-600 dark:border-stone-700 dark:text-stone-300'
                }`}
              >
                {r === 'semana' ? 'semana' : `dia ${diaCurto(diaSel)}`}
              </button>
            ))}
          </div>
        }
      >
        {porTratamento.linhas.length === 0 ? (
          <Vazio>Nada programado {recorteTratamento === 'semana' ? 'nesta semana' : 'neste dia'}.</Vazio>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-stone-500">
                  <th className="px-2 py-1.5">Tratamento</th>
                  <th className="px-2 py-1.5 text-right">Ordens</th>
                  <th className="px-2 py-1.5 text-right">Bags</th>
                  <th className="px-2 py-1.5 text-right">Toneladas</th>
                  <th className="hidden w-1/3 px-2 py-1.5 sm:table-cell" />
                </tr>
              </thead>
              <tbody>
                {porTratamento.linhas.map((l) => (
                  <tr key={l.tratamento} className="border-t border-stone-100 dark:border-stone-800/60">
                    <td className="px-2 py-1.5 font-medium">{l.tratamento}</td>
                    <td className="num-tabular px-2 py-1.5 text-right">{l.ordens}</td>
                    <td className="num-tabular px-2 py-1.5 text-right">{n(l.bags, 0)}</td>
                    <td className="num-tabular px-2 py-1.5 text-right font-semibold">{n(l.pesoT, 1)} t</td>
                    <td className="hidden px-2 py-1.5 sm:table-cell">
                      <div className="h-2 w-full rounded bg-stone-100 dark:bg-stone-800">
                        <div
                          className="h-2 rounded bg-green-600 dark:bg-green-500"
                          style={{ width: `${porTratamento.total > 0 ? (l.pesoT / porTratamento.total) * 100 : 0}%` }}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-stone-300 text-xs dark:border-stone-700">
                  <td className="px-2 py-1.5 font-medium uppercase tracking-wide text-stone-500">Total</td>
                  <td className="num-tabular px-2 py-1.5 text-right">
                    {porTratamento.linhas.reduce((a, l) => a + l.ordens, 0)}
                  </td>
                  <td className="num-tabular px-2 py-1.5 text-right">
                    {n(porTratamento.linhas.reduce((a, l) => a + l.bags, 0), 0)}
                  </td>
                  <td className="num-tabular px-2 py-1.5 text-right font-semibold">{n(porTratamento.total, 1)} t</td>
                  <td className="hidden sm:table-cell" />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Cartao>

      {/* -------- ordens sem caminhão até X (Arion, 19/09/2026) -------- */}
      <Cartao
        titulo={`Ordens sem caminhão até ${diaCurto(ateAgendaEfetivo)}${agendamentosOk && agendamentos.length > 0 ? ` (${semAgenda.semAgenda.length})` : ''}`}
        className="mb-5"
        acoes={
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="flex items-center gap-1 text-stone-500">
              Até
              <input
                type="date"
                value={ateAgendaEfetivo}
                onChange={(e) => setAteAgenda(e.target.value)}
                className="rounded-md border border-stone-300 px-2 py-1 text-sm dark:border-stone-700 dark:bg-stone-800"
              />
            </label>
            {ateAgenda && <Botao onClick={() => setAteAgenda('')}>fim da semana</Botao>}
          </div>
        }
      >
        {agendamentosOk === null || embalagensOk === null ? (
          <p className="text-sm text-stone-500">Carregando agendamentos e embalagens…</p>
        ) : agendamentosOk === false ? (
          <Aviso gravidade="alerta">
            Não foi possível ler os agendamentos da Expedição — sem eles não dá para dizer quem tem caminhão.
          </Aviso>
        ) : agendamentos.length === 0 ? (
          <Vazio>Nenhum agendamento importado. Importe o relatório de pedidos agendados na Expedição.</Vazio>
        ) : semAgenda.avaliadas === 0 ? (
          <Vazio>Nenhuma ordem programada (com máquina e dia) até {diaCurto(ateAgendaEfetivo)}.</Vazio>
        ) : semAgenda.semAgenda.length === 0 ? (
          <Aviso gravidade="ok">
            Todas as {semAgenda.avaliadas} ordens programadas até {diaCurto(ateAgendaEfetivo)} têm caminhão agendado.
          </Aviso>
        ) : (
          <>
            <Tabela cabecalho={[
              'Ordem', 'Máquina', 'Dia', 'Cultivar', 'Tratamento',
              { texto: 'Emb.', className: 'hidden lg:table-cell' },
              '#Bags', 'Status', 'Próxima agenda',
            ]}>
              {semAgenda.semAgenda.map(({ ordem: o, proximaAgenda, bagsNaProximaAgenda, agendadoDepois }) => (
                <tr key={o.id} className="border-t border-stone-100 dark:border-stone-800/60">
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => abrirOrdem(o.id)}
                      disabled={abrindoId === o.id}
                      className="num-tabular font-medium underline-offset-2 hover:underline disabled:opacity-50"
                      title="Abrir a ordem"
                    >
                      {o.numero}
                    </button>
                    {o.prioridade === 'Urgente' && <Tag cor="perigo" className="ml-1">urgente</Tag>}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    {maquinas.find((m) => m.id === o.maquina_id)?.nome ?? o.maquina_id}
                  </td>
                  <td
                    className={`num-tabular px-2 py-1.5 whitespace-nowrap ${
                      o.data_prog && o.data_prog < diaDeProducao(new Date()) ? 'font-medium text-red-700 dark:text-red-400' : ''
                    }`}
                    title={o.data_prog && o.data_prog < diaDeProducao(new Date()) ? 'Atrasada: o dia já passou' : undefined}
                  >
                    {diaCurto(o.data_prog)}
                  </td>
                  <td className="px-2 py-1.5 font-medium">{o.cultivar}</td>
                  <td className="px-2 py-1.5">{o.receita_nome}</td>
                  <td className="hidden px-2 py-1.5 text-xs lg:table-cell">{o.embalagem}</td>
                  <td className="num-tabular px-2 py-1.5 text-right">{n(o.bags, 0)}</td>
                  <td className="px-2 py-1.5"><Tag cor={corDoStatus(o.status_efetivo)}>{o.status_efetivo}</Tag></td>
                  <td className="px-2 py-1.5 text-xs whitespace-nowrap">
                    {proximaAgenda ? (
                      <span title={`${n(agendadoDepois, 0)} bg agendados no total depois de ${diaCurto(ateAgendaEfetivo)}`}>
                        {diaCurto(proximaAgenda)} · {n(bagsNaProximaAgenda, 0)} bg
                        {agendadoDepois > bagsNaProximaAgenda && (
                          <span className="text-stone-400"> (+{n(agendadoDepois - bagsNaProximaAgenda, 0)} depois)</span>
                        )}
                      </span>
                    ) : <Tag cor="alerta">nenhuma</Tag>}
                  </td>
                </tr>
              ))}
            </Tabela>
            <p className="mt-3 text-xs text-stone-500">
              {semAgenda.semAgenda.length} de {semAgenda.avaliadas} ordens programadas até {diaCurto(ateAgendaEfetivo)} não
              têm caminhão agendado do mesmo produto (cultivar + tratamento + embalagem; semente branca só pelo cultivar)
              até essa data. Agendamento sem data conta como caminhão. Entram as ordens com máquina e dia até a data,
              ainda não finalizadas e no balanço; o pool (sem máquina) fica de fora.
              {' '}<b>Próxima agenda</b> = o primeiro caminhão do produto depois da data, com os bags dessa data
              (e quantos mais vêm depois).
              {ateAgendaEfetivo > janela.ate && (
                <b className="text-amber-700 dark:text-amber-400">
                  {' '}A data passa da janela carregada: ordens programadas depois de {diaCurto(janela.ate)} não
                  estão na conta.
                </b>
              )}
            </p>
          </>
        )}
        {embalagensOk === false && (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
            Não deu para ler o cadastro de embalagens: ordem em SC10/SC20 (fora dos ERPs) pode aparecer aqui por
            engano. Recarregue a página.
          </p>
        )}
        {agendamentosOk && semAgenda.foraDosErps.length > 0 && (
          <p className="mt-2 text-xs text-stone-500">
            {semAgenda.foraDosErps.length} ordem(ns) em embalagem de peso fixo ficam fora da conta
            {' ('}{semAgenda.foraDosErps.map((o) => `${o.numero} · ${o.embalagem}`).join(', ')}{')'}:
            pedido de SC10/SC20 não existe na SimpleAgro, então nunca teria agendamento.
          </p>
        )}
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

      {/* -------- filtro por status do dia -------- */}
      {statusDoDia.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-stone-500 dark:text-stone-400">Mostrar:</span>
          <button
            onClick={() => setFiltroStatus(new Set())}
            className={`rounded px-2 py-1 text-xs font-medium whitespace-nowrap ${
              filtroStatus.size === 0
                ? 'bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900'
                : 'bg-stone-100 text-stone-600 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-300 dark:hover:bg-stone-700'
            }`}
          >
            Todos ({totalDoDia})
          </button>
          {statusDoDia.map(({ status, qtd }) => {
            const ativo = filtroStatus.has(status)
            const cores = {
              neutro: 'bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300',
              ok: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
              alerta: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
              perigo: 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300',
              info: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300',
              roxo: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-300',
            }
            return (
              <button
                key={status}
                onClick={() => alternarFiltro(status)}
                className={`rounded px-2 py-1 text-xs font-medium whitespace-nowrap ${cores[corDoStatus(status)]} ${
                  ativo ? 'ring-2 ring-offset-1 ring-stone-900 dark:ring-stone-100' : 'opacity-60 hover:opacity-100'
                }`}
              >
                {status} ({qtd})
              </button>
            )
          })}
          {filtroStatus.size > 0 && (
            <button
              onClick={() => setFiltroStatus(new Set())}
              className="text-xs text-stone-500 underline hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
            >
              limpar
            </button>
          )}
        </div>
      )}

      {/* -------- quadro do dia: lista (padrão) ou cartões (19/09/2026) -------- */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-stone-500 dark:text-stone-400">
          Quadro de {diaSemana(diaSel)} {diaCurto(diaSel)}
          {modoQuadro === 'lista' && podeProgramar && ' — para arrastar ou reordenar com as setas, abra os cartões'}
        </span>
        <div className="flex items-center gap-1 text-xs">
          {(['lista', 'cartoes'] as const).map((md) => (
            <button
              key={md}
              type="button"
              onClick={() => trocarModoQuadro(md)}
              className={`rounded-md border px-2 py-1 ${
                modoQuadro === md
                  ? 'border-green-600 bg-green-50 font-medium text-green-800 dark:bg-green-950 dark:text-green-300'
                  : 'border-stone-300 text-stone-600 dark:border-stone-700 dark:text-stone-300'
              }`}
            >
              {md === 'lista' ? 'lista' : 'cartões'}
            </button>
          ))}
        </div>
      </div>
      {modoQuadro === 'lista' && (
        <div className="mb-5 space-y-4">
          {maquinas.map((m) => {
            const lista = celula(m.id, diaSel)
            const o = ocupacaoCelula(m.id, diaSel)
            const porStatus = !filaSemStatus[m.id]
            return (
              <ListaMaquinaDia
                key={m.id}
                titulo={`${m.nome} · ${diaSemana(diaSel)} ${diaCurto(diaSel)}`}
                acoes={botaoOtimizar(lista, m.id)}
                resumo={resumoOcupacao(o)}
                fila={lista}
                capacidadeTh={o.capacidadeTh}
                porStatus={porStatus}
                onAlternarPorStatus={() => setFilaSemStatus((a) => ({ ...a, [m.id]: !a[m.id] }))}
                visivel={visivel}
                filtroAtivo={filtroStatus.size > 0}
                onLimparFiltro={() => setFiltroStatus(new Set())}
                ordenacao={ordenacaoPorMaquina[m.id] ?? null}
                onOrdenar={(c) => ordenarMaquina(m.id, c)}
                itensPorReceita={itensPorReceita}
                podeProgramar={podeProgramar}
                podeMarcarUrgente={podeMarcarUrgente}
                semCaminhaoIds={semCaminhaoIds}
                semCaminhaoAte={ateAgendaEfetivo}
                onAbrir={abrirOrdem}
                abrindoId={abrindoId}
                onPrioridade={(ord) => alternarPrioridadeDia(m.id, diaSel, lista, ord)}
                onAlternarUrgente={alternarUrgente}
                posicaoNoGrupo={(ord) => posicaoNoGrupo(lista, ord, porStatus)}
                onSubir={(ord) => trocarComVizinho(m.id, diaSel, lista, ord, -1, porStatus)}
                onDescer={(ord) => trocarComVizinho(m.id, diaSel, lista, ord, 1, porStatus)}
                movendoId={movendo}
                onAlternarMover={(ord) => setMovendo(movendo === ord.id ? null : ord.id)}
                painelMover={(ord) => painelMoverDe(ord, m.id)}
              />
            )
          })}
        </div>
      )}
      {modoQuadro === 'cartoes' && (
      <div className={`mb-5 grid gap-4 sm:grid-cols-2 ${maquinas.length >= 3 ? 'xl:grid-cols-3' : ''}`}>
        {maquinas.map((m) => {
          const lista = celula(m.id, diaSel)
          const listaVisivel = lista.filter(visivel)
          const o = ocupacaoCelula(m.id, diaSel)
          const naCelula = alvo?.maq === m.id && alvo?.dia === diaSel

          /**
           * Ordem de EXIBIÇÃO, separada da ordem REAL (`lista`, por seq —
           * a única que `mover`/`renumerar`/a cascata conhecem). O dia
           * misturava ordens em estágios bem diferentes na mesma lista, e
           * achar o que precisa de ação agora exigia ler linha por linha:
           * agora quem está rodando aparece primeiro, o que pode ser
           * produzido logo depois, o que espera o lote em seguida, e o que
           * já passou pela qualidade vai para o fim, fora do caminho.
           *
           * `Pronto para produzir` e `Aguardando lote` são grupos SEPARADOS
           * (não misturados por seq): a diferença entre eles é se a ordem
           * pode rodar HOJE ou está bloqueada esperando a logística — muito
           * mais forte que uma prioridade arbitrária, e é por isso que não
           * reintroduz a ambiguidade das setas (cada uma só troca com o
           * vizinho do PRÓPRIO grupo, nunca com um item de outro status).
           * A regra vive em `exibicaoDoDia` (domínio) desde 19/09/2026 —
           * a lista usa a mesma.
           */
          const { exibicao, inicioConcluidas, grupos } = exibicaoDoDia(lista)
          const concluidas = grupos.concluidas
          const grupoMovelDe = (x: OrdemVisao) => grupoMovel(grupos, x)
          return (
            <Cartao
              key={m.id}
              titulo={`${m.nome} · ${diaSemana(diaSel)} ${diaCurto(diaSel)}`}
              acoes={botaoOtimizar(lista, m.id)}
            >
              {resumoOcupacao(o)}

              {/* -------- prioridades do dia (16/09/2026) -------- */}
              {(() => {
                const faixa = faixaDe(lista.filter((x) => !ehConcluida(x.status_efetivo)))
                const ids = faixa.map((x) => x.id)
                const naFaixa = alvoFaixa?.maq === m.id && alvoFaixa?.dia === diaSel
                const gravar = (novos: string[]) =>
                  comErro(() => g.definirPrioridadesDia(m.id, diaSel, novos))
                if (faixa.length === 0 && !podeProgramar) return null
                return (
                  <div
                    onDragOver={(e) => {
                      if (!podeProgramar || !arrastando) return
                      e.preventDefault()
                      e.stopPropagation()
                      setAlvo(null)
                      setAlvoFaixa((a) =>
                        a && a.maq === m.id && a.dia === diaSel && a.pos === null ? a : { maq: m.id, dia: diaSel, pos: null },
                      )
                    }}
                    onDragLeave={(e) => {
                      // dragleave borbulha dos filhos: só apaga quando sai do contêiner de verdade
                      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
                      if (naFaixa) setAlvoFaixa(null)
                    }}
                    onDrop={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      soltarNaFaixa(m.id, diaSel, naFaixa ? alvoFaixa!.pos : null)
                    }}
                    className={`mb-3 rounded-md border-2 border-dashed p-2 ${
                      naFaixa
                        ? 'border-amber-500 bg-amber-50 dark:bg-amber-950/30'
                        : 'border-amber-300 bg-amber-50/40 dark:border-amber-800 dark:bg-amber-950/10'
                    }`}
                  >
                    <p className="mb-1.5 flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-300">
                      Prioridades do dia
                      <span className="font-normal normal-case tracking-normal text-amber-700/80 dark:text-amber-400/80">
                        — o que a produção faz primeiro; aparece no topo da Execução
                      </span>
                    </p>
                    {faixa.length === 0 ? (
                      <p className="py-2 text-center text-xs text-amber-700/70 dark:text-amber-400/70">
                        Arraste ordens da fila para cá (ou use o botão "prioridade" na ordem)
                      </p>
                    ) : (
                      <div className="space-y-1">
                        {faixa.map((ord, i) => (
                          <div key={ord.id}>
                            {naFaixa && alvoFaixa?.pos === i && <LinhaDeInsercao />}
                            <div
                              draggable={podeProgramar}
                              onDragStart={() => {
                                setArrastando(ord.id)
                                setArrastandoDaFaixa(true)
                              }}
                              onDragEnd={() => {
                                setArrastando(null)
                                setArrastandoDaFaixa(false)
                                setAlvo(null)
                                setAlvoFaixa(null)
                              }}
                              onDragOver={(e) => {
                                if (!podeProgramar || !arrastando) return
                                e.preventDefault()
                                e.stopPropagation()
                                const r = e.currentTarget.getBoundingClientRect()
                                const antes = e.clientY < r.top + r.height / 2
                                const pos = i + (antes ? 0 : 1)
                                setAlvoFaixa((a) =>
                                  a && a.maq === m.id && a.dia === diaSel && a.pos === pos ? a : { maq: m.id, dia: diaSel, pos },
                                )
                              }}
                              className={`flex flex-wrap items-center gap-2 rounded-md border border-amber-200 bg-white px-2.5 py-1.5 text-sm dark:border-amber-900 dark:bg-stone-800 ${
                                podeProgramar ? 'cursor-grab' : ''
                              } ${arrastando === ord.id ? 'opacity-40' : ''}`}
                            >
                              <span className="inline-block w-8 rounded bg-amber-500 px-1.5 py-0.5 text-center text-xs font-bold text-white">
                                P{i + 1}
                              </span>
                              <div className="min-w-40 flex-1">
                                <p className="truncate font-medium">
                                  {ord.numero}
                                  {semCaminhaoIds.has(ord.id) && (
                                    <span
                                      className="ml-1 cursor-help text-amber-600 dark:text-amber-400"
                                      title={`Sem caminhão agendado até ${diaCurto(ateAgendaEfetivo)} (do cartão "Ordens sem caminhão")`}
                                    >
                                      ●
                                    </span>
                                  )}
                                  {' · '}{ord.cultivar}
                                </p>
                                <p className="truncate text-xs text-stone-500">
                                  {ord.receita_nome} · lote {ord.lote_id} · {n(ord.peso_t, 1)} t
                                </p>
                              </div>
                              <div className="ml-auto flex shrink-0 items-center gap-2">
                                {ord.prioridade === 'Urgente' && <Tag cor="perigo">urgente</Tag>}
                                <Tag cor={corDoStatus(ord.status_efetivo)} className="min-w-36 text-center">
                                  {ord.status_efetivo}
                                </Tag>
                                {podeProgramar && (
                                  <>
                                    <div className="flex flex-col">
                                      <button
                                        disabled={i === 0}
                                        onClick={() => gravar(moverNaFaixa(ids, ord.id, -1))}
                                        className="p-2 text-sm leading-none disabled:opacity-20 lg:p-0 lg:text-xs"
                                      >
                                        ▲
                                      </button>
                                      <button
                                        disabled={i === faixa.length - 1}
                                        onClick={() => gravar(moverNaFaixa(ids, ord.id, 1))}
                                        className="p-2 text-sm leading-none disabled:opacity-20 lg:p-0 lg:text-xs"
                                      >
                                        ▼
                                      </button>
                                    </div>
                                    <button
                                      onClick={() => gravar(semDaFaixa(ids, ord.id))}
                                      title="Tirar da faixa de prioridades (a ordem continua na fila)"
                                      className="rounded border border-stone-300 px-2 py-2 text-xs text-stone-500 hover:bg-stone-100 lg:px-1.5 lg:py-0.5 lg:text-[10px] dark:border-stone-600 dark:hover:bg-stone-700"
                                    >
                                      ✕
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                            {naFaixa && alvoFaixa?.pos === i + 1 && <LinhaDeInsercao />}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })()}

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
                    ? 'border-green-500 bg-green-50/40 dark:bg-green-950/20'
                    : 'border-stone-300 dark:border-stone-700'
                }`}
              >
                {lista.length === 0 ? (
                  <p className="py-4 text-center text-xs text-stone-400">
                    {podeProgramar ? 'Arraste ordens para cá' : 'Sem ordens'}
                  </p>
                ) : listaVisivel.length === 0 ? (
                  <p className="py-4 text-center text-xs text-stone-400">
                    Nenhuma ordem com o status filtrado aqui.{' '}
                    <button
                      onClick={() => setFiltroStatus(new Set())}
                      className="underline hover:text-stone-600 dark:hover:text-stone-300"
                    >
                      ver todas
                    </button>
                  </p>
                ) : (
                  exibicao.map((ord, displayIdx) => {
                    if (!visivel(ord)) return null
                    // posição na lista REAL — a que mover()/renumerar() conhecem;
                    // drag e "mover" sempre inserem relativos a um item específico
                    // (não a um vizinho), então continuam corretos com a exibição
                    // reagrupada. Só as setas precisam do grupo (abaixo).
                    const idx = lista.indexOf(ord)
                    const movivel =
                      podeProgramar && !jaIniciada(ord.status_efetivo as StatusEfetivo)
                    const grupo = grupoMovelDe(ord)
                    const posNoGrupo = grupo.indexOf(ord)
                    return (
                      <div key={ord.id}>
                        {displayIdx === inicioConcluidas && concluidas.length > 0 && inicioConcluidas > 0 && (
                          <p className="pt-1 pb-0.5 text-[10px] uppercase tracking-wide text-stone-400">
                            Concluídas
                          </p>
                        )}
                        {naCelula && alvo?.pos === idx && <LinhaDeInsercao />}
                        <div
                          draggable={movivel}
                          onDragStart={() => {
                            setArrastando(ord.id)
                            setArrastandoDaFaixa(false)
                          }}
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
                          className={`flex flex-wrap items-center gap-2 rounded-md border border-stone-200 bg-white px-2.5 py-2 text-sm dark:border-stone-700 dark:bg-stone-800 ${
                            movivel ? 'cursor-grab' : ''
                          } ${arrastando === ord.id ? 'opacity-40' : ''} ${
                            displayIdx >= inicioConcluidas ? 'opacity-70' : ''
                          }`}
                        >
                          <span className="w-5 text-xs text-stone-400">{displayIdx + 1}</span>
                          {/* min-w-40: no celular, sem largura mínima o texto
                              identificador espremia até ficar ilegível quando
                              tags+mover+setas competiam pela mesma linha */}
                          <div className="min-w-40 flex-1">
                            <p className="truncate font-medium">
                              {ord.numero}
                              {semCaminhaoIds.has(ord.id) && (
                                <span
                                  className="ml-1 cursor-help text-amber-600 dark:text-amber-400"
                                  title={`Sem caminhão agendado até ${diaCurto(ateAgendaEfetivo)} (do cartão "Ordens sem caminhão")`}
                                >
                                  ●
                                </span>
                              )}
                              {' · '}{ord.cultivar}
                            </p>
                            <p className="truncate text-xs text-stone-500">
                              {ord.receita_nome} · lote {ord.lote_id} · {n(ord.peso_t, 1)} t
                            </p>
                          </div>
                          {/* tags num bloco à parte, empurrado com ml-auto: sem
                              isso, a tag de status "flutuava" pra posições
                              diferentes conforme a linha tinha ou não
                              mover+setas depois dela (padronização pedida
                              pelo Arion, 13/08/2026) */}
                          <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
                            {/* expedição prevista (12/09/2026) EM CIMA da etiqueta
                                urgente, numa coluna fixa: lado a lado, a etiqueta
                                pulava de lugar conforme a linha tinha ou não a
                                data (pedido do Arion). É aqui que o PCP escolhe o
                                dia, então o caminhão precisa estar à vista — e
                                programar DEPOIS dele é o erro que o vermelho
                                denuncia. */}
                            {(ord.prioridade === 'Urgente' || ord.data_expedicao) && (
                              <div className="flex min-w-20 flex-col items-center gap-0.5">
                                {ord.data_expedicao && (
                                  <span
                                    className={`text-xs whitespace-nowrap ${
                                      ord.data_prog && ord.data_prog > ord.data_expedicao
                                        ? 'font-semibold text-red-600 dark:text-red-400'
                                        : 'text-stone-500'
                                    }`}
                                    title={
                                      ord.data_prog && ord.data_prog > ord.data_expedicao
                                        ? 'A máquina está programada para DEPOIS da data do caminhão'
                                        : 'Expedição prevista'
                                    }
                                  >
                                    exp. {diaCurto(ord.data_expedicao)}
                                  </span>
                                )}
                                {ord.prioridade === 'Urgente' && <Tag cor="perigo">urgente</Tag>}
                              </div>
                            )}
                            {/* P1/P2… da faixa de prioridades do dia (16/09/2026) fica
                                AQUI, numa vaga fixa colada ao status, em toda linha
                                (vazia quando a ordem não está na faixa). Nasceu à
                                esquerda do número e empurrava o texto só nas linhas
                                priorizadas — pedido do Arion, 19/09/2026: "coloque ao
                                lado direito do card, para não perder o padrão". */}
                            <span className="inline-block w-8 shrink-0 text-center">
                              {ord.prioridade_dia != null && (
                                <span
                                  className="inline-block rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-white"
                                  title="Está na faixa de prioridades do dia"
                                >
                                  P{ord.prioridade_dia}
                                </span>
                              )}
                            </span>
                            <Tag cor={corDoStatus(ord.status_efetivo)} className="min-w-36 text-center">
                              {ord.status_efetivo}
                            </Tag>
                          </div>
                          {/* bloco de ações sempre OCUPA o mesmo espaço, mesmo
                              quando não é movível (fica só invisível) — é o
                              que mantém a tag acima ancorada no mesmo lugar
                              em toda linha, movível ou não. */}
                          <div
                            className={`flex shrink-0 items-center gap-2 ${movivel ? '' : 'invisible'}`}
                            aria-hidden={!movivel}
                          >
                            <button
                              tabIndex={movivel ? 0 : -1}
                              onClick={() => alternarPrioridadeDia(m.id, diaSel, lista, ord)}
                              title={
                                ord.prioridade_dia != null
                                  ? 'Tirar da faixa de prioridades do dia'
                                  : 'Pôr no fim da faixa de prioridades do dia (funciona no tablet)'
                              }
                              className={`rounded border px-3 py-2 text-xs uppercase tracking-wide hover:bg-amber-100 lg:px-1.5 lg:py-0.5 lg:text-[10px] ${
                                ord.prioridade_dia != null
                                  ? 'border-amber-500 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                                  : 'border-stone-300 text-stone-500 dark:border-stone-600 dark:hover:bg-stone-700'
                              }`}
                            >
                              {ord.prioridade_dia != null ? 'priorizada' : 'prioridade'}
                            </button>
                            <button
                              tabIndex={movivel ? 0 : -1}
                              onClick={() => setMovendo(movendo === ord.id ? null : ord.id)}
                              title="Mover para outro dia ou máquina (funciona no tablet, onde arrastar não funciona)"
                              className="rounded border border-stone-300 px-3 py-2 text-xs uppercase tracking-wide text-stone-500 hover:bg-stone-100 lg:px-1.5 lg:py-0.5 lg:text-[10px] dark:border-stone-600 dark:hover:bg-stone-700"
                            >
                              mover
                            </button>
                            {podeMarcarUrgente && (
                              <button
                                tabIndex={movivel ? 0 : -1}
                                onClick={() => alternarUrgente(ord)}
                                title={ord.prioridade === 'Urgente' ? 'Voltar a normal' : 'Marcar como urgente'}
                                className={`rounded border px-3 py-2 text-xs uppercase tracking-wide lg:px-1.5 lg:py-0.5 lg:text-[10px] ${
                                  ord.prioridade === 'Urgente'
                                    ? 'border-red-400 bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-950/40 dark:text-red-300'
                                    : 'border-stone-300 text-stone-500 hover:bg-red-50 dark:border-stone-600 dark:hover:bg-stone-700'
                                }`}
                              >
                                urgente
                              </button>
                            )}
                            {/* as setas trocam com o vizinho do MESMO GRUPO
                                (mesmo status), não com o vizinho literal da
                                lista real — que agora pode ser uma ordem já
                                concluída ou em produção, renderizada em
                                outra parte da tela. Trocar com um vizinho
                                invisível pareceria não fazer nada, que foi
                                exatamente o defeito corrigido hoje de manhã
                                para a urgência; aqui a troca sempre aparece
                                dentro do próprio bloco visível. Com filtro
                                de status ativo, ficam desabilitadas — o
                                vizinho do grupo pode estar oculto. */}
                            <div className="flex flex-col">
                              <button
                                tabIndex={movivel ? 0 : -1}
                                disabled={posNoGrupo <= 0 || filtroStatus.size > 0}
                                title={filtroStatus.size > 0 ? 'Limpe o filtro para reordenar com as setas' : undefined}
                                onClick={() => trocarComVizinho(m.id, diaSel, lista, ord, -1)}
                                className="p-2 text-sm leading-none disabled:opacity-20 lg:p-0 lg:text-xs"
                              >
                                ▲
                              </button>
                              <button
                                tabIndex={movivel ? 0 : -1}
                                disabled={posNoGrupo < 0 || posNoGrupo === grupo.length - 1 || filtroStatus.size > 0}
                                title={filtroStatus.size > 0 ? 'Limpe o filtro para reordenar com as setas' : undefined}
                                onClick={() => trocarComVizinho(m.id, diaSel, lista, ord, 1)}
                                className="p-2 text-sm leading-none disabled:opacity-20 lg:p-0 lg:text-xs"
                              >
                                ▼
                              </button>
                            </div>
                          </div>
                        </div>
                        {movendo === ord.id && painelMoverDe(ord, m.id)}
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
      )}

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
          setArrastandoDaFaixa(false)
          setAlvoFaixa(null)
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
                  onDragStart={() => {
                    setArrastando(o.id)
                    setArrastandoDaFaixa(false)
                  }}
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

      {ordemAberta && (
        <ModalOrdem
          ordem={ordemAberta.ordem}
          produtos={produtos}
          motivos={motivos}
          podeApontar={permitido('execucao', 'apontar')}
          agora={Date.now()}
          capacidadeTh={maquinas.find((m) => m.id === ordemAberta.ordem.maquina_id)?.capacidade_th}
          conferencia={ordemAberta.conferencia}
          embalagens={embalagens ?? []}
          onFechar={() => setOrdemAberta(null)}
          onMudou={async () => {
            await recarregar()
            const [o, cf] = await Promise.all([
              api.carregarOrdemPorId(ordemAberta.ordem.id),
              g.conferenciaDaOrdem(ordemAberta.ordem.id),
            ])
            if (o) setOrdemAberta({ ordem: o, conferencia: cf })
          }}
        />
      )}

      {previa && (
        <PreviaCascata
          resultado={previa}
          numeroDe={numeroDe}
          apartirDe={previaDesde || diaSel}
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
  // pointer-events-none: a própria linha não pode roubar o dragover do item
  // (senão o alvo pulava pro fim quando o ponteiro passava sobre ela)
  return <div className="pointer-events-none my-1 h-0.5 rounded-full bg-green-500" />
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
                      <li key={mv.ordem.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
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
