/**
 * Programação e ocupação.
 *
 * O critério que atravessa tudo é reduzir setup: agrupar ordens da mesma
 * receita (e, melhor ainda, da mesma receita + cultivar) na mesma máquina
 * evita troca de produto, que é parada planejada mas ainda assim é tempo.
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
   * A produção já tocou a ordem: não se move, mas continua ocupando a
   * capacidade e a numeração do dia dela. Só a cascata precisa saber.
   */
  iniciada?: boolean
}

export interface MaquinaCapacidade {
  id: string
  capacidadeDiaT: number
}

/**
 * Capacidade em toneladas de uma máquina num dia. É função, e não número
 * fixo, porque nem todo dia roda os dois turnos — sábado costuma ter um só
 * e domingo nenhum (tabela `dias_producao`).
 */
export type CapacidadeDia = (maquinaId: string, dia: string) => number

const capacidadeFixa =
  (maquinas: MaquinaCapacidade[]): CapacidadeDia =>
  (id) =>
    maquinas.find((m) => m.id === id)?.capacidadeDiaT ?? 0

/** Horas de operação de um dia com `turnos` turnos (0, 1 ou 2). */
export function horasDoDia(turnos: number, horasPorTurno: readonly number[]): number {
  return horasPorTurno.slice(0, Math.max(0, turnos)).reduce((a, h) => a + h, 0)
}

/** Número de trocas de receita numa sequência — proxy direto de setups. */
export function trocasDeReceita(seq: { receitaId: string }[]): number {
  return seq.reduce(
    (total, o, i) => total + (i > 0 && seq[i - 1].receitaId !== o.receitaId ? 1 : 0),
    0,
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
  livreT: number
}

/**
 * Melhor encaixe para uma ordem: o dia mais cedo que couber; dentro do dia, a
 * máquina com maior afinidade de receita; empatando, a menos carregada.
 */
export function melhorSlot(
  ordem: OrdemProgramavel,
  ordens: OrdemProgramavel[],
  maquinas: MaquinaCapacidade[],
  dias: string[],
  capDia?: CapacidadeDia,
): Slot | null {
  const cap = capDia ?? capacidadeFixa(maquinas)
  for (const dia of dias) {
    const candidatas = maquinas
      .map((m) => {
        const carga = toneladasDa(ordens, m.id, dia)
        return { m, carga, livre: cap(m.id, dia) - carga }
      })
      .filter((c) => c.livre >= ordem.pesoT)
      .map((c) => {
        const naMaquina = ordens.filter((o) => o.maquinaId === c.m.id && o.dataProg === dia)
        const afinidade: 0 | 1 | 2 = naMaquina.some(
          (o) => o.receitaId === ordem.receitaId && o.cultivar === ordem.cultivar,
        )
          ? 0
          : naMaquina.some((o) => o.receitaId === ordem.receitaId)
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
        livreT: escolhida.livre,
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
  capDia?: CapacidadeDia,
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
    const slot = melhorSlot(ordem, estado, maquinas, dias, capDia)
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
 */
export function otimizarSequencia(fila: OrdemProgramavel[]): Atribuicao[] {
  const urgentes = fila.filter((o) => o.prioridade === 'Urgente')
  const normais = fila.filter((o) => o.prioridade !== 'Urgente')

  const agrupar = (lista: OrdemProgramavel[]) => {
    const grupos = new Map<string, OrdemProgramavel[]>()
    for (const o of lista) {
      const chave = `${o.receitaId}|${o.cultivar}`
      const g = grupos.get(chave)
      if (g) g.push(o)
      else grupos.set(chave, [o])
    }
    // grupos maiores primeiro: concentram mais tempo sem troca
    return [...grupos.values()].sort((a, b) => b.length - a.length).flat()
  }

  return [...agrupar(urgentes), ...agrupar(normais)].map((o, i) => ({
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
 * Não move ordem já iniciada — quem chama filtra antes.
 */
export function rebalancearDia(
  ordens: OrdemProgramavel[],
  maquinas: MaquinaCapacidade[],
  dia: string,
  capDia?: CapacidadeDia,
): Desbalanceamento | null {
  if (maquinas.length < 2) return null
  const cap = capDia ?? capacidadeFixa(maquinas)

  const cargas = maquinas
    .map((m) => ({ m, ton: toneladasDa(ordens, m.id, dia) }))
    .sort((a, b) => b.ton - a.ton)
  const cheia = cargas[0]
  const vazia = cargas[cargas.length - 1]
  if (cheia.m.id === vazia.m.id) return null

  const diferenca = cheia.ton - vazia.ton
  if (diferenca <= 0) return null

  const candidatas = ordens
    .filter((o) => o.maquinaId === cheia.m.id && o.dataProg === dia)
    .slice()
    .sort((a, b) => {
      const noDestino = (x: OrdemProgramavel) =>
        ordens.some(
          (o) => o.maquinaId === vazia.m.id && o.dataProg === dia && o.receitaId === x.receitaId,
        )
          ? 0
          : 1
      return noDestino(a) - noDestino(b) || b.pesoT - a.pesoT
    })

  const movidas: Atribuicao[] = []
  let transferido = 0
  let livreDestino = cap(vazia.m.id, dia) - vazia.ton
  const noDestino = ordens.filter(
    (o) => o.maquinaId === vazia.m.id && o.dataProg === dia,
  )
  // maior seq existente, não contagem — mesma razão do autoProgramar
  const base = Math.max(noDestino.length, ...noDestino.map((o) => o.seq ?? 0))

  for (const o of candidatas) {
    // parar antes de inverter o desbalanceamento
    if (transferido + o.pesoT > diferenca / 2) continue
    if (o.pesoT > livreDestino) continue
    transferido += o.pesoT
    livreDestino -= o.pesoT
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
 * marcado nele é empurrado junto.
 */
export function reprogramarCascata(
  ordens: OrdemProgramavel[],
  maquinas: MaquinaCapacidade[],
  dias: string[],
  apartirDe: string,
  capDia?: CapacidadeDia,
): ResultadoCascata {
  const cap = capDia ?? capacidadeFixa(maquinas)
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
      const capacidade = cap(m.id, dia)
      if (capacidade <= 0) {
        // dia sem produção: não recebe nada e devolve o que tinha para a fila
        espera = [...espera, ...doDia]
        continue
      }
      const fixasDoDia = fixas.filter((o) => o.dataProg === dia)
      let livre = capacidade - fixasDoDia.reduce((a, o) => a + o.pesoT, 0)
      let seq = fixasDoDia.reduce((mx, o) => Math.max(mx, o.seq ?? 0), 0)

      const fila = [...espera, ...doDia]
      espera = []
      let travou = false
      for (const o of fila) {
        if (travou) {
          espera.push(o)
          continue
        }
        if (o.pesoT <= livre) {
          movimentos.push({ ordem: o, deDia: o.dataProg, paraDia: dia, seq: ++seq })
          livre -= o.pesoT
          continue
        }
        // maior que o dia inteiro e ninguém à frente: vai assim mesmo, senão
        // travaria a fila para sempre e nada mais seria reprogramado
        if (seq === 0 && o.pesoT > capacidade) {
          movimentos.push({ ordem: o, deDia: o.dataProg, paraDia: dia, seq: ++seq })
          excedem.push(o)
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

/** Checklist do dia: o que impede ou ameaça a produção programada. */
export function checklistDoDia(
  ordens: OrdemProgramavel[],
  maquinas: MaquinaCapacidade[],
  dia: string,
  capDia?: CapacidadeDia,
): ItemChecklist[] {
  const cap = capDia ?? capacidadeFixa(maquinas)
  const itens: ItemChecklist[] = []
  const doDia = ordens.filter((o) => o.dataProg === dia && o.maquinaId)

  const semLote = doDia.filter((o) => !o.loteBaixado)
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
    const ton = toneladasDa(ordens, m.id, dia)
    const capacidade = cap(m.id, dia)
    if (capacidade <= 0) {
      if (ton > 0) {
        itens.push({
          gravidade: 'bloqueio',
          mensagem: `${m.id} tem ${ton.toFixed(1)} t programadas num dia marcado como sem produção.`,
        })
      }
      continue
    }
    const pct = (ton / capacidade) * 100
    if (pct > 100) {
      itens.push({
        gravidade: 'bloqueio',
        mensagem: `${m.id} está com ${pct.toFixed(0)}% da capacidade do dia — não cabe.`,
      })
    } else if (pct > 85) {
      itens.push({
        gravidade: 'alerta',
        mensagem: `${m.id} está com ${pct.toFixed(0)}% da capacidade do dia.`,
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
