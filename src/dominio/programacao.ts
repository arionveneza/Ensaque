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
}

export interface MaquinaCapacidade {
  id: string
  capacidadeDiaT: number
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
): Slot | null {
  for (const dia of dias) {
    const candidatas = maquinas
      .map((m) => {
        const carga = toneladasDa(ordens, m.id, dia)
        return { m, carga, livre: m.capacidadeDiaT - carga }
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
    const slot = melhorSlot(ordem, estado, maquinas, dias)
    if (!slot) {
      naoCouberam.push(ordem)
      continue
    }
    const jaNoSlot = estado.filter(
      (o) => o.maquinaId === slot.maquinaId && o.dataProg === slot.dia,
    ).length
    const alvo = estado.find((o) => o.id === ordem.id)!
    alvo.maquinaId = slot.maquinaId
    alvo.dataProg = slot.dia
    alvo.seq = jaNoSlot + 1
    atribuicoes.push({
      ordemId: ordem.id,
      maquinaId: slot.maquinaId,
      dia: slot.dia,
      seq: jaNoSlot + 1,
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
): Desbalanceamento | null {
  if (maquinas.length < 2) return null

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
  let livreDestino = vazia.m.capacidadeDiaT - vazia.ton
  const jaNoDestino = ordens.filter(
    (o) => o.maquinaId === vazia.m.id && o.dataProg === dia,
  ).length

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
      seq: jaNoDestino + movidas.length + 1,
    })
  }

  if (movidas.length === 0) return null
  return { dia, origem: cheia.m.id, destino: vazia.m.id, ordensMovidas: movidas }
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
): ItemChecklist[] {
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
    const pct = m.capacidadeDiaT > 0 ? (ton / m.capacidadeDiaT) * 100 : 0
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
