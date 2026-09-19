/**
 * Programação e ocupação.
 *
 * O critério que atravessa tudo é reduzir setup: agrupar ordens da mesma
 * receita (e, melhor ainda, da mesma receita + cultivar) na mesma máquina
 * evita troca de produto, que é parada planejada mas ainda assim é tempo.
 *
 * Desde 13/09/2026 a capacidade é contada em HORAS, e cada troca de ordem
 * custa setup (20 min mesmo tratamento, 40 min quando muda — cadastro da
 * máquina). Isso vale SÓ aqui, na programação: o tempo planejado da ordem e
 * o OEE seguem sem setup, porque o setup real já é apontado como parada.
 */

export interface OrdemProgramavel {
  id: string
  cultivar: string
  receitaId: string
  prioridade: 'Normal' | 'Urgente'
  pesoT: number
  /** Lote baixado libera a ordem para produzir. */
  loteBaixado: boolean
  maquinaId: string | null
  dataProg: string | null
  seq: number | null
  /**
   * Nº da ordem, só para desempatar a fila quando o seq falta ou repete —
   * a tela ordena por (seq, número) e o domínio precisa ordenar IGUAL, senão
   * a cadeia de setup dá um valor na célula e outro no checklist.
   */
  numero?: string
  /**
   * A produção já tocou a ordem: não se move, mas continua ocupando a
   * capacidade e a numeração do dia dela. Entra na carga da célula (setup
   * inclusive) e nunca é candidata a mover.
   */
  iniciada?: boolean
}

/**
 * Minutos de setup entre duas ordens seguidas na mesma máquina (13/09/2026,
 * regra do Arion): o MESMO tratamento paga `mesmoMin` (troca de ordem, mesmo
 * com cultivar igual); tratamento DIFERENTE paga `trocaMin`, porque envolve
 * limpeza. Não há setup antes da primeira ordem do dia. Vem do cadastro de
 * cada máquina.
 */
export interface Setup {
  mesmoMin: number
  trocaMin: number
}

export const SETUP_PADRAO: Setup = { mesmoMin: 20, trocaMin: 40 }

export interface MaquinaCapacidade {
  id: string
  /** Capacidade nominal, t/h. */
  capacidadeTh: number
  /** Horas de operação num dia cheio; o calendário (`HorasDia`) refina por dia. */
  horasDia: number
  setup: Setup
}

/**
 * Horas de operação de uma máquina num dia. É função, e não número fixo,
 * porque nem todo dia roda os dois turnos — sábado costuma ter um só e
 * domingo nenhum (tabela `dias_producao`).
 *
 * A capacidade passou a ser medida em HORAS, não em toneladas (13/09/2026):
 * é o único jeito de o setup entre ordens entrar na conta — 20 ou 40 minutos
 * não têm equivalente em toneladas que valha para toda máquina.
 */
export type HorasDia = (maquinaId: string, dia: string) => number

const horasFixas =
  (maquinas: MaquinaCapacidade[]): HorasDia =>
  (id) =>
    maquinas.find((m) => m.id === id)?.horasDia ?? 0

/**
 * Quais turnos um dia roda. Importa saber QUAL, não quantos: um dia só de
 * 2º turno tem 9h30, um só de 1º tem 10h — capacidades diferentes.
 */
export interface TurnosDoDia {
  t1: boolean
  t2: boolean
}

export const DIA_CHEIO: TurnosDoDia = { t1: true, t2: true }

/**
 * Horas de cada turno: 1º das 07:30 às 17:30, 2º das 17:30 às 03:00. Mora
 * aqui, e não na tela de Programação, porque os Indicadores também precisam
 * dela para comparar as horas do turno com as horas realmente produzidas.
 */
export const HORAS_TURNOS: readonly number[] = [10, 9.5]

/** Horas de operação de um dia, somando só os turnos que ele roda. */
export function horasDoDia(turnos: TurnosDoDia, horasPorTurno: readonly number[]): number {
  return (turnos.t1 ? (horasPorTurno[0] ?? 0) : 0) + (turnos.t2 ? (horasPorTurno[1] ?? 0) : 0)
}

export function rotuloTurnos(t: TurnosDoDia): string {
  if (t.t1 && t.t2) return '1º e 2º turno'
  if (t.t1) return 'só 1º turno'
  if (t.t2) return 'só 2º turno'
  return 'sem produção'
}

/** Número de trocas de receita numa sequência — proxy direto de setups. */
export function trocasDeReceita(seq: { receitaId: string }[]): number {
  return seq.reduce(
    (total, o, i) => total + (i > 0 && seq[i - 1].receitaId !== o.receitaId ? 1 : 0),
    0,
  )
}

/** Setup que a ordem `atual` paga por entrar depois de `anterior`. */
export function setupEntre(
  anterior: { receitaId: string } | null | undefined,
  atual: { receitaId: string },
  setup: Setup,
): number {
  if (!anterior) return 0
  return anterior.receitaId === atual.receitaId ? setup.mesmoMin : setup.trocaMin
}

/**
 * Setup que a ordem `atual` deve pagar, olhando a ordem imediatamente
 * anterior na fila do MESMO dia e máquina (maior seq abaixo da dela). Serve à
 * Execução/Painel como linha informativa — NÃO entra no tempo planejado nem
 * no OEE, porque o setup real é apontado como parada Planejada.
 */
export function setupPrevistoDaOrdem<
  T extends { id: string; receitaId: string; dataProg: string | null; seq: number | null },
>(atual: T, daMaquina: T[], setup: Setup): number {
  const anterior = daMaquina
    .filter(
      (o) =>
        o.id !== atual.id &&
        o.dataProg === atual.dataProg &&
        o.seq != null &&
        atual.seq != null &&
        o.seq < atual.seq,
    )
    .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))[0]
  return setupEntre(anterior ?? null, atual, setup)
}

export interface HorasFila {
  /** Σ peso ÷ capacidade nominal. */
  producaoH: number
  /** Σ setup entre ordens consecutivas. */
  setupMin: number
  /** Trocas de tratamento na fila. */
  trocas: number
  /** producaoH + setupMin/60 — o que a fila realmente ocupa. */
  horas: number
}

/**
 * Quanto uma fila ocupa, NA ORDEM EM QUE VAI RODAR (quem chama ordena por
 * seq; aqui a lista é tomada como está). Máquina sem capacidade nominal
 * não produz: qualquer fila nela vira infinita, e nada cabe.
 */
export function resumoHorasFila(
  fila: { pesoT: number; receitaId: string }[],
  capacidadeTh: number,
  setup: Setup,
): HorasFila {
  const setupMin = fila.reduce((a, o, i) => a + setupEntre(fila[i - 1], o, setup), 0)
  const trocas = trocasDeReceita(fila)
  if (capacidadeTh <= 0) {
    const inf = fila.length > 0 ? Infinity : 0
    return { producaoH: inf, setupMin, trocas, horas: inf }
  }
  const producaoH = fila.reduce((a, o) => a + o.pesoT, 0) / capacidadeTh
  return { producaoH, setupMin, trocas, horas: producaoH + setupMin / 60 }
}

export function horasDaFila(
  fila: { pesoT: number; receitaId: string }[],
  capacidadeTh: number,
  setup: Setup,
): number {
  return resumoHorasFila(fila, capacidadeTh, setup).horas
}

/**
 * Fila de uma célula (máquina × dia) na ordem da sequência gravada. O
 * desempate (seq nulo ou repetido) é pelo número da ordem, o MESMO da tela
 * (`celula()` em Programacao.tsx) — ordem criada já com máquina e dia nasce
 * sem seq, e os dois lados precisam contar o mesmo setup.
 */
export function filaDa(
  ordens: OrdemProgramavel[],
  maquinaId: string,
  dia: string,
): OrdemProgramavel[] {
  return ordens
    .filter((o) => o.maquinaId === maquinaId && o.dataProg === dia)
    .sort(
      (a, b) =>
        (a.seq ?? 9999) - (b.seq ?? 9999) ||
        (a.numero ?? a.id).localeCompare(b.numero ?? b.id),
    )
}

export function toneladasDa(
  ordens: OrdemProgramavel[],
  maquinaId: string,
  dia: string,
): number {
  return ordens
    .filter((o) => o.maquinaId === maquinaId && o.dataProg === dia)
    .reduce((a, o) => a + o.pesoT, 0)
}

export interface Slot {
  maquinaId: string
  dia: string
  /** 0 = já tem mesma receita e cultivar · 1 = mesma receita · 2 = nenhuma afinidade */
  afinidade: 0 | 1 | 2
  /** Horas que sobram no dia DEPOIS de encaixar a ordem no fim da fila. */
  livreH: number
}

/**
 * Melhor encaixe para uma ordem: o dia mais cedo que couber; dentro do dia, a
 * máquina com maior afinidade de receita; empatando, a menos carregada.
 * "Caber" é em horas, com a ordem entrando no FIM da fila — inclui o setup
 * que ela paga por vir depois da última ordem já programada.
 */
export function melhorSlot(
  ordem: OrdemProgramavel,
  ordens: OrdemProgramavel[],
  maquinas: MaquinaCapacidade[],
  dias: string[],
  horasDia?: HorasDia,
): Slot | null {
  const horas = horasDia ?? horasFixas(maquinas)
  for (const dia of dias) {
    const candidatas = maquinas
      .map((m) => {
        const fila = filaDa(ordens, m.id, dia).filter((o) => o.id !== ordem.id)
        const carga = horasDaFila(fila, m.capacidadeTh, m.setup)
        const comEla = horasDaFila([...fila, ordem], m.capacidadeTh, m.setup)
        return { m, fila, carga, livre: horas(m.id, dia) - comEla }
      })
      .filter((c) => c.livre >= 0)
      .map((c) => {
        const afinidade: 0 | 1 | 2 = c.fila.some(
          (o) => o.receitaId === ordem.receitaId && o.cultivar === ordem.cultivar,
        )
          ? 0
          : c.fila.some((o) => o.receitaId === ordem.receitaId)
            ? 1
            : 2
        return { ...c, afinidade }
      })
      .sort((a, b) => a.afinidade - b.afinidade || a.carga - b.carga)

    if (candidatas.length > 0) {
      const escolhida = candidatas[0]
      return {
        maquinaId: escolhida.m.id,
        dia,
        afinidade: escolhida.afinidade,
        livreH: escolhida.livre,
      }
    }
  }
  return null
}

export interface Atribuicao {
  ordemId: string
  maquinaId: string
  dia: string
  seq: number
}

export interface ResultadoAutoProgramacao {
  atribuicoes: Atribuicao[]
  /** Ordens que não couberam em nenhum dia do horizonte. */
  naoCouberam: OrdemProgramavel[]
}

/**
 * Programa automaticamente as ordens ainda sem máquina.
 *
 * Prioridade de atendimento: urgentes primeiro, depois as de lote já baixado
 * (que podem começar hoje), depois as maiores — encaixar a grande primeiro
 * evita que ela fique sem espaço enquanto pequenas preenchem o dia.
 */
export function autoProgramar(
  ordens: OrdemProgramavel[],
  maquinas: MaquinaCapacidade[],
  dias: string[],
  horasDia?: HorasDia,
): ResultadoAutoProgramacao {
  const fila = ordens
    .filter((o) => !o.maquinaId)
    .slice()
    .sort(
      (a, b) =>
        (a.prioridade === 'Urgente' ? 0 : 1) - (b.prioridade === 'Urgente' ? 0 : 1) ||
        (a.loteBaixado ? 0 : 1) - (b.loteBaixado ? 0 : 1) ||
        b.pesoT - a.pesoT,
    )

  // cópia mutável: cada atribuição muda a carga vista pela próxima ordem
  const estado = ordens.map((o) => ({ ...o }))
  const atribuicoes: Atribuicao[] = []
  const naoCouberam: OrdemProgramavel[] = []

  for (const ordem of fila) {
    const slot = melhorSlot(ordem, estado, maquinas, dias, horasDia)
    if (!slot) {
      naoCouberam.push(ordem)
      continue
    }
    const noSlot = estado.filter(
      (o) => o.maquinaId === slot.maquinaId && o.dataProg === slot.dia,
    )
    // maior seq existente, não contagem: numa célula com buraco (2, 4) a
    // contagem daria 2 e a nova ordem entraria como 3ª duplicando depois
    const seqNova = Math.max(noSlot.length, ...noSlot.map((o) => o.seq ?? 0)) + 1
    const alvo = estado.find((o) => o.id === ordem.id)!
    alvo.maquinaId = slot.maquinaId
    alvo.dataProg = slot.dia
    alvo.seq = seqNova
    atribuicoes.push({
      ordemId: ordem.id,
      maquinaId: slot.maquinaId,
      dia: slot.dia,
      seq: seqNova,
    })
  }

  return { atribuicoes, naoCouberam }
}

/**
 * Reordena a fila de uma célula agrupando por receita para reduzir setup,
 * mantendo as urgentes na frente. Devolve a nova sequência (1..n).
 *
 * O setup só olha a RECEITA (`setupEntre`), então o agrupamento é por
 * receita — dentro dela, por cultivar. Antes a chave era receita+cultivar e
 * duas ordens da mesma receita com cultivares diferentes caíam em grupos
 * separados, que podiam ficar longe (achado do Arion no dia 15/09/2026: o
 * botão não tirava nada dos 320 min da TSI 1). A fronteira urgente → normal
 * também é aproveitada: se alguma receita aparece dos dois lados, ela fecha
 * as urgentes e abre as normais, e essa troca some.
 */
export function otimizarSequencia(fila: OrdemProgramavel[]): Atribuicao[] {
  const urgentes = fila.filter((o) => o.prioridade === 'Urgente')
  const normais = fila.filter((o) => o.prioridade !== 'Urgente')

  /** Blocos por receita (maiores primeiro); dentro do bloco, por cultivar (maiores primeiro). */
  const blocos = (lista: OrdemProgramavel[]): OrdemProgramavel[][] => {
    const porReceita = new Map<string, Map<string, OrdemProgramavel[]>>()
    for (const o of lista) {
      const r = porReceita.get(o.receitaId) ?? new Map<string, OrdemProgramavel[]>()
      const c = r.get(o.cultivar) ?? []
      c.push(o)
      r.set(o.cultivar, c)
      porReceita.set(o.receitaId, r)
    }
    return [...porReceita.values()]
      .map((r) => [...r.values()].sort((a, b) => b.length - a.length).flat())
      .sort((a, b) => b.length - a.length)
  }

  const bu = blocos(urgentes)
  const bn = blocos(normais)
  // receita comum aos dois lados: última das urgentes e primeira das normais
  const iu = bu.findIndex((b) => bn.some((n) => n[0].receitaId === b[0].receitaId))
  if (iu >= 0) {
    const [b] = bu.splice(iu, 1)
    bu.push(b)
    const jn = bn.findIndex((n) => n[0].receitaId === b[0].receitaId)
    const [n] = bn.splice(jn, 1)
    bn.unshift(n)
  }

  return [...bu.flat(), ...bn.flat()].map((o, i) => ({
    ordemId: o.id,
    maquinaId: o.maquinaId!,
    dia: o.dataProg!,
    seq: i + 1,
  }))
}

export interface Desbalanceamento {
  dia: string
  origem: string
  destino: string
  ordensMovidas: Atribuicao[]
}

/**
 * Rebalanceia um dia: move ordens da máquina sobrecarregada para a que tem
 * folga, preferindo mover as que têm afinidade de receita com o destino.
 * Tudo em horas: cada ordem movida custa o peso dela mais o setup que paga
 * por entrar no fim da fila do destino. Não move ordem já iniciada — quem
 * chama filtra antes.
 */
export function rebalancearDia(
  ordens: OrdemProgramavel[],
  maquinas: MaquinaCapacidade[],
  dia: string,
  horasDia?: HorasDia,
): Desbalanceamento | null {
  // máquina com t/h zero (só por SQL — o cadastro exige > 0) fica fora do
  // par: como "vazia" ela travava o Rebalancear do dia inteiro, e como
  // "cheia" a carga dela é Infinity
  const validas = maquinas.filter((m) => m.capacidadeTh > 0)
  if (validas.length < 2) return null
  const horas = horasDia ?? horasFixas(maquinas)

  const cargas = validas
    .map((m) => ({ m, h: horasDaFila(filaDa(ordens, m.id, dia), m.capacidadeTh, m.setup) }))
    .sort((a, b) => b.h - a.h)
  const cheia = cargas[0]
  const vazia = cargas[cargas.length - 1]
  if (cheia.m.id === vazia.m.id) return null
  if (cheia.h - vazia.h <= 0) return null

  const noDestino = filaDa(ordens, vazia.m.id, dia)
  // iniciada ocupa a máquina mas não sai dela: fica na fila da origem (conta
  // nas horas e no setup) e nunca é candidata
  const filaOrigem = filaDa(ordens, cheia.m.id, dia)
  const candidatas = filaOrigem
    .filter((o) => !o.iniciada)
    .sort((a, b) => {
    const afim = (x: OrdemProgramavel) =>
      noDestino.some((o) => o.receitaId === x.receitaId) ? 0 : 1
    return afim(a) - afim(b) || b.pesoT - a.pesoT
  })

  const movidas: Atribuicao[] = []
  const movidos = new Set<string>()
  let transferido = 0
  let livreDestino = horas(vazia.m.id, dia) - vazia.h
  let ultima: OrdemProgramavel | null = noDestino[noDestino.length - 1] ?? null
  // maior seq existente, não contagem — mesma razão do autoProgramar
  const base = Math.max(noDestino.length, ...noDestino.map((o) => o.seq ?? 0))
  const horasOrigemSem = (ids: Set<string>) =>
    horasDaFila(filaOrigem.filter((x) => !ids.has(x.id)), cheia.m.capacidadeTh, cheia.m.setup)

  for (const o of candidatas) {
    const custo = o.pesoT / vazia.m.capacidadeTh + setupEntre(ultima, o, vazia.m.setup) / 60
    /**
     * A movida só passa se a DIFERENÇA entre as duas máquinas ENCOLHER, com
     * as horas reais das duas filas depois dela (setup incluído). Duas
     * versões anteriores erravam (19/09/2026, revisão da TSI 3): a original
     * ("transferido + custo > diferenca / 2") comparava horas do destino com
     * metade de uma diferença medida na origem — só fecha com capacidades
     * iguais; a seguinte estimava o alívio da origem só pela produção
     * (pesoT ÷ t/h), ignorando o setup que ela deixa de pagar — ficava MAIS
     * permissiva que o prometido (invertia o quadro por até um setup por
     * movida, mesmo com capacidades iguais) e, exigindo "origem >= destino",
     * recusava a única ordem de uma máquina lenta estourada (alívio = carga
     * inteira → sobra zero → nada passa). Recalcular a fila que sobra é a
     * mesma conta do topo da função: uma chamada por candidata, fila de um
     * dia. Passar do ponto é permitido quando aproxima as duas — o clique
     * seguinte não desfaz, porque voltar não encolheria a diferença.
     */
    const origemAntes = horasOrigemSem(movidos)
    const origemDepois = horasOrigemSem(new Set([...movidos, o.id]))
    const destinoAntes = vazia.h + transferido
    const destinoDepois = destinoAntes + custo
    if (Math.abs(destinoDepois - origemDepois) >= Math.abs(origemAntes - destinoAntes)) continue
    if (custo > livreDestino) continue
    transferido += custo
    livreDestino -= custo
    ultima = o
    movidos.add(o.id)
    movidas.push({
      ordemId: o.id,
      maquinaId: vazia.m.id,
      dia,
      seq: base + movidas.length + 1,
    })
  }

  if (movidas.length === 0) return null
  return { dia, origem: cheia.m.id, destino: vazia.m.id, ordensMovidas: movidas }
}

export interface MovimentoCascata {
  ordem: OrdemProgramavel
  deDia: string | null
  paraDia: string
  seq: number
}

export interface ResultadoCascata {
  movimentos: MovimentoCascata[]
  /** Não coube em nenhum dia do horizonte — fica onde está. */
  naoCouberam: OrdemProgramavel[]
  /** Sozinha já estoura o dia inteiro: foi alocada mesmo assim. */
  excedem: OrdemProgramavel[]
}

/**
 * Empurra para frente o que ficou para trás.
 *
 * O caso real: programaram 10 ordens para hoje, a produção fez 5, e as outras
 * 5 precisam virar as PRIMEIRAS de amanhã — o que por sua vez pode não deixar
 * as de amanhã caberem, e essas viram as primeiras de depois de amanhã, e
 * assim por diante. Fazer isso na mão é reprogramar dezenas de ordens uma a
 * uma.
 *
 * Duas regras que o algoritmo respeita e valem mais que compactar bem:
 *
 * 1. **Nada anda para trás.** Uma ordem só entra na fila no dia dela ou
 *    depois. Sem isso a cascata "puxaria" ordem da semana que vem para
 *    amanhã só porque sobrou espaço, bagunçando o combinado com o comercial.
 * 2. **A fila não fura.** Quando uma ordem não cabe no dia, todas as
 *    seguintes também esperam — não se procura uma menor para preencher o
 *    buraco. A sequência é compromisso, não um jogo de encaixe.
 *
 * Ordens já iniciadas não se movem: continuam ocupando capacidade e
 * numeração do dia delas. Dia com 0 turnos não recebe nada, e o que estava
 * marcado nele é empurrado junto. Cada ordem custa o peso dela mais o setup
 * que paga por vir depois da anterior — por isso a fila é percorrida em
 * ordem e a "anterior" acompanha.
 */
export function reprogramarCascata(
  ordens: OrdemProgramavel[],
  maquinas: MaquinaCapacidade[],
  dias: string[],
  apartirDe: string,
  horasDia?: HorasDia,
): ResultadoCascata {
  const horas = horasDia ?? horasFixas(maquinas)
  const destinos = dias.filter((d) => d > apartirDe).sort()
  const movimentos: MovimentoCascata[] = []
  const naoCouberam: OrdemProgramavel[] = []
  const excedem: OrdemProgramavel[] = []
  if (destinos.length === 0) return { movimentos, naoCouberam, excedem }
  const ultimo = destinos[destinos.length - 1]

  const naFila = (a: OrdemProgramavel, b: OrdemProgramavel) =>
    (a.prioridade === 'Urgente' ? 0 : 1) - (b.prioridade === 'Urgente' ? 0 : 1) ||
    (a.seq ?? 999) - (b.seq ?? 999)

  for (const m of maquinas) {
    const daMaquina = ordens.filter((o) => o.maquinaId === m.id && o.dataProg)
    const fixas = daMaquina.filter((o) => o.iniciada)
    // além do horizonte não se mexe: já estão no lugar que o PCP combinou
    const moveis = daMaquina.filter((o) => !o.iniciada && o.dataProg! <= ultimo)

    // o que já estava atrasado entra na frente de tudo, do mais velho ao mais novo
    let espera = moveis
      .filter((o) => o.dataProg! <= apartirDe)
      .sort((a, b) => a.dataProg!.localeCompare(b.dataProg!) || naFila(a, b))

    for (const dia of destinos) {
      const doDia = moveis.filter((o) => o.dataProg === dia).sort(naFila)
      const capacidade = horas(m.id, dia)
      if (capacidade <= 0 || m.capacidadeTh <= 0) {
        // dia sem produção: não recebe nada e devolve o que tinha para a fila
        espera = [...espera, ...doDia]
        continue
      }
      const fixasDoDia = fixas
        .filter((o) => o.dataProg === dia)
        .sort((a, b) => (a.seq ?? 9999) - (b.seq ?? 9999))
      let livre = capacidade - horasDaFila(fixasDoDia, m.capacidadeTh, m.setup)
      let seq = fixasDoDia.reduce((mx, o) => Math.max(mx, o.seq ?? 0), 0)
      // a última da fila decide o setup da próxima — começa pela última fixa
      let anterior: OrdemProgramavel | null = fixasDoDia[fixasDoDia.length - 1] ?? null

      const fila = [...espera, ...doDia]
      espera = []
      let travou = false
      for (const o of fila) {
        if (travou) {
          espera.push(o)
          continue
        }
        const custo = o.pesoT / m.capacidadeTh + setupEntre(anterior, o, m.setup) / 60
        if (custo <= livre) {
          movimentos.push({ ordem: o, deDia: o.dataProg, paraDia: dia, seq: ++seq })
          livre -= custo
          anterior = o
          continue
        }
        // maior que o dia inteiro e ninguém à frente: vai assim mesmo, senão
        // travaria a fila para sempre e nada mais seria reprogramado
        if (seq === 0 && custo > capacidade) {
          movimentos.push({ ordem: o, deDia: o.dataProg, paraDia: dia, seq: ++seq })
          excedem.push(o)
          anterior = o
          continue
        }
        travou = true
        espera.push(o)
      }
    }
    naoCouberam.push(...espera)
  }

  return {
    // quem terminou no mesmo dia e na mesma posição não precisa ir ao banco
    movimentos: movimentos.filter(
      (mv) => mv.paraDia !== mv.ordem.dataProg || mv.seq !== mv.ordem.seq,
    ),
    naoCouberam,
    excedem,
  }
}

export interface ItemChecklist {
  gravidade: 'bloqueio' | 'alerta'
  mensagem: string
}

const fmtH = (h: number) => h.toFixed(1).replace('.', ',')

/** Checklist do dia: o que impede ou ameaça a produção programada. */
export function checklistDoDia(
  ordens: OrdemProgramavel[],
  maquinas: MaquinaCapacidade[],
  dia: string,
  horasDia?: HorasDia,
): ItemChecklist[] {
  const horas = horasDia ?? horasFixas(maquinas)
  const itens: ItemChecklist[] = []
  const doDia = ordens.filter((o) => o.dataProg === dia && o.maquinaId)

  // iniciada já passou pela baixa — o status dela não é "Pronto para produzir"
  const semLote = doDia.filter((o) => !o.loteBaixado && !o.iniciada)
  if (semLote.length > 0) {
    const urgentes = semLote.filter((o) => o.prioridade === 'Urgente').length
    itens.push({
      gravidade: urgentes > 0 ? 'bloqueio' : 'alerta',
      mensagem:
        `${semLote.length} ordem(ns) do dia com lote ainda não baixado` +
        (urgentes > 0 ? `, sendo ${urgentes} urgente(s)` : ''),
    })
  }

  for (const m of maquinas) {
    const fila = filaDa(ordens, m.id, dia)
    const ton = fila.reduce((a, o) => a + o.pesoT, 0)
    const capacidade = horas(m.id, dia)
    if (capacidade <= 0) {
      if (ton > 0) {
        itens.push({
          gravidade: 'bloqueio',
          mensagem: `${m.id} tem ${ton.toFixed(1)} t programadas num dia marcado como sem produção.`,
        })
      }
      continue
    }
    const r = resumoHorasFila(fila, m.capacidadeTh, m.setup)
    if (!Number.isFinite(r.horas)) {
      itens.push({
        gravidade: 'bloqueio',
        mensagem: `${m.id} está sem capacidade nominal (t/h) no cadastro — nada cabe nela.`,
      })
      continue
    }
    const pct = (r.horas / capacidade) * 100
    const detalhe =
      `${fmtH(r.horas)} h em ${fmtH(capacidade)} h` +
      (r.setupMin > 0 ? `, sendo ${r.setupMin} min de setup` : '')
    if (pct > 100) {
      itens.push({
        gravidade: 'bloqueio',
        mensagem: `${m.id} está com ${pct.toFixed(0)}% da capacidade do dia (${detalhe}) — não cabe.`,
      })
    } else if (pct > 85) {
      itens.push({
        gravidade: 'alerta',
        mensagem: `${m.id} está com ${pct.toFixed(0)}% da capacidade do dia (${detalhe}).`,
      })
    }
  }

  const pool = ordens.filter((o) => !o.maquinaId).length
  if (pool > 0) {
    itens.push({
      gravidade: 'alerta',
      mensagem: `${pool} ordem(ns) ainda sem máquina no pool.`,
    })
  }

  return itens
}

export interface TotalPorTratamento {
  tratamento: string
  ordens: number
  bags: number
  pesoT: number
}

/**
 * Toneladas programadas por tratamento (cartão da Programação, 13/09/2026).
 * Recebe o que a tela já filtrou (semana ou dia; só ordens com máquina e
 * dia) e devolve do maior peso para o menor.
 */
export function toneladasPorTratamento(
  ordens: { tratamento: string; pesoT: number; bags: number }[],
): TotalPorTratamento[] {
  const mapa = new Map<string, TotalPorTratamento>()
  for (const o of ordens) {
    const t = o.tratamento.trim() || '(sem tratamento)'
    const acc = mapa.get(t) ?? { tratamento: t, ordens: 0, bags: 0, pesoT: 0 }
    acc.ordens += 1
    acc.bags += o.bags
    acc.pesoT += o.pesoT
    mapa.set(t, acc)
  }
  return [...mapa.values()].sort(
    (a, b) => b.pesoT - a.pesoT || a.tratamento.localeCompare(b.tratamento),
  )
}
