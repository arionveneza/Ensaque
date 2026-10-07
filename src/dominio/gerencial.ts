/**
 * Relatório gerencial (07/10/2026, pedido do Arion): (1) carregamento do dia,
 * digitado pelo PCP — veículos carregados, bags carregados, veículos
 * descarregados e veículos que sobraram no pátio —, com o ACUMULADO DA SEMANA
 * (segunda a domingo) de bags e veículos carregados; (2) produção planejado ×
 * executado por dia.
 *
 * O ponto delicado é o (2): "se eu empurrar as ordens não feitas pra frente, o
 * total planejado do dia vai ser sempre igual ao executado". A Reprogramação em
 * cascata reescreve `data_prog`, então o dia que atrasou perde as ordens que
 * saíram dele e parece 100%. O planejado aqui devolve ao dia o que SAIU dele
 * depois que ele começou (`noPlanoDoDia`), pelo histórico que o gatilho grava
 * a cada mudança de dia (`ordem_reprogramacoes`). Congelar o plano às 07:30 foi
 * a 1ª ideia e não serve: a maioria das ordens nasce no próprio dia em que roda
 * (30/09: 17 de 22; 02/10: 18 de 18). Funções puras.
 */

import { diaDeProducao } from './calculos'

// ---------------------------------------------------------------------------
// Semana (segunda a domingo) e datas
// ---------------------------------------------------------------------------

const iso = (d: Date) =>
  [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-')

const data = (dia: string) => {
  const [a, m, d] = dia.split('-').map(Number)
  return new Date(a, m - 1, d)
}

export const somaDiasIso = (dia: string, n: number): string => {
  const d = data(dia)
  d.setDate(d.getDate() + n)
  return iso(d)
}

/** Os 7 dias da semana (segunda a domingo) que contém `dia`. */
export function semanaDe(dia: string): string[] {
  const d = data(dia)
  const desdeSegunda = (d.getDay() + 6) % 7 // segunda = 0 … domingo = 6
  const segunda = iso(new Date(d.getFullYear(), d.getMonth(), d.getDate() - desdeSegunda))
  return Array.from({ length: 7 }, (_, i) => somaDiasIso(segunda, i))
}

/** Começo do dia de produção `dia` (07:30, hora local) — o instante em que o plano congela. */
export const inicioDoDiaProducao = (dia: string): Date => {
  const d = data(dia)
  d.setHours(7, 30, 0, 0)
  return d
}

// ---------------------------------------------------------------------------
// (1) Carregamento digitado pelo PCP
// ---------------------------------------------------------------------------

export interface CarregamentoDia {
  dia: string
  veiculos_carregados: number | null
  bags_carregados: number | null
  veiculos_descarregados: number | null
  veiculos_patio: number | null
  observacao?: string | null
}

export interface CarregamentoComAcumulado extends CarregamentoDia {
  /** Soma da segunda até este dia (dia sem lançamento soma zero). */
  acumVeiculos: number
  acumBags: number
}

/** Uma linha por dia da semana (lançado ou não), com o acumulado de segunda até ali. */
export function carregamentoDaSemana(dias: string[], lancados: CarregamentoDia[]): CarregamentoComAcumulado[] {
  const porDia = new Map(lancados.map((l) => [l.dia, l]))
  let acumVeiculos = 0
  let acumBags = 0
  return dias.map((dia) => {
    const l = porDia.get(dia) ?? {
      dia, veiculos_carregados: null, bags_carregados: null, veiculos_descarregados: null, veiculos_patio: null,
    }
    acumVeiculos += l.veiculos_carregados ?? 0
    acumBags += l.bags_carregados ?? 0
    return { ...l, acumVeiculos, acumBags }
  })
}


// ---------------------------------------------------------------------------
// (2) Produção: planejado (sem a cascata apagar o que foi empurrado) × executado
// ---------------------------------------------------------------------------

export interface OrdemPlano {
  id: string
  /** `data_prog` de AGORA. */
  data_prog: string | null
  bags: number
  bags_produzidos: number | null
  /** Peso planejado (bags × peso do bag da ordem). */
  peso_t: number
  /** Fim real (apontamento de finalização); null = não terminou. */
  fim: string | null
}

export interface MudancaDeDia {
  ordem_id: string
  de_dia: string | null
  para_dia: string | null
  ts: string
}

/**
 * A ordem conta no planejado do `dia` quando não tinha terminado antes de ele
 * começar (07:30) e: (a) está programada pra ele agora; ou (b) SAIU dele para um
 * dia seguinte — ou voltou pro pool — depois que o dia começou. O (b) é o que a
 * cascata apagava: a ordem empurrada continua no plano do dia de onde saiu (e
 * entra também no plano do dia pra onde foi). Ordem adiantada (mudou para um
 * dia ANTERIOR) não conta no dia de onde saiu.
 */
export function noPlanoDoDia(o: OrdemPlano, mudancas: MudancaDeDia[], dia: string): boolean {
  const t = inicioDoDiaProducao(dia).getTime()
  if (o.fim && new Date(o.fim).getTime() <= t) return false
  if (o.data_prog === dia) return true
  return mudancas.some(
    (m) =>
      m.de_dia === dia &&
      new Date(m.ts).getTime() > t &&
      (m.para_dia == null || m.para_dia > dia),
  )
}

export interface ProducaoDia {
  dia: string
  planejadoT: number
  planejadoBags: number
  planejadoOrdens: number
  /** Parte do planejado que foi empurrada pra frente (ou devolvida ao pool). */
  empurradoT: number
  empurradoOrdens: number
  /** Tudo que terminou no dia (do plano ou adiantado de outro dia). */
  executadoT: number
  executadoBags: number
  executadoOrdens: number
  /** Das ordens do plano do dia, quanto terminou no próprio dia. */
  doPlanoT: number
  doPlanoOrdens: number
}

const produzido = (o: OrdemPlano) => {
  const bags = o.bags_produzidos ?? o.bags
  const t = o.bags > 0 ? (Number(o.peso_t) * bags) / o.bags : Number(o.peso_t)
  return { bags, t }
}

const terminouEm = (o: OrdemPlano, dia: string) => o.fim != null && diaDeProducao(new Date(o.fim)) === dia

export function planejadoExecutado(
  dias: string[],
  ordens: OrdemPlano[],
  mudancas: MudancaDeDia[],
): ProducaoDia[] {
  const porOrdem = new Map<string, MudancaDeDia[]>()
  for (const m of mudancas) porOrdem.set(m.ordem_id, [...(porOrdem.get(m.ordem_id) ?? []), m])

  return dias.map((dia) => {
    const l: ProducaoDia = {
      dia, planejadoT: 0, planejadoBags: 0, planejadoOrdens: 0, empurradoT: 0, empurradoOrdens: 0,
      executadoT: 0, executadoBags: 0, executadoOrdens: 0, doPlanoT: 0, doPlanoOrdens: 0,
    }
    for (const o of ordens) {
      const terminou = terminouEm(o, dia)
      if (noPlanoDoDia(o, porOrdem.get(o.id) ?? [], dia)) {
        l.planejadoT += Number(o.peso_t)
        l.planejadoBags += o.bags
        l.planejadoOrdens++
        if (o.data_prog !== dia) {
          l.empurradoT += Number(o.peso_t)
          l.empurradoOrdens++
        }
        if (terminou) {
          l.doPlanoT += produzido(o).t
          l.doPlanoOrdens++
        }
      }
      if (terminou) {
        const p = produzido(o)
        l.executadoT += p.t
        l.executadoBags += p.bags
        l.executadoOrdens++
      }
    }
    return l
  })
}

export interface ProducaoSemana {
  /** Ordens DISTINTAS que estiveram no plano de algum dia da semana. */
  planejadoT: number
  planejadoBags: number
  planejadoOrdens: number
  executadoT: number
  executadoBags: number
  executadoOrdens: number
  /** Das planejadas na semana, as que terminaram dentro da semana. */
  doPlanoT: number
  doPlanoOrdens: number
}

/**
 * A ordem está no plano da SEMANA quando esteve no plano de algum dia dela ou
 * está programada pra um dia dela e não tinha terminado quando a semana
 * começou. A 2ª parte é a adiantada dentro da semana: programada pra quinta e
 * feita na quarta não está no plano de dia nenhum (na quinta já tinha
 * terminado), mas é trabalho que a semana prometeu e entregou.
 */
export function noPlanoDaSemana(o: OrdemPlano, mudancas: MudancaDeDia[], dias: string[]): boolean {
  if (dias.some((d) => noPlanoDoDia(o, mudancas, d))) return true
  const t = inicioDoDiaProducao(dias[0]).getTime()
  return o.data_prog != null && dias.includes(o.data_prog) && !(o.fim && new Date(o.fim).getTime() <= t)
}

/**
 * Total da semana SEM somar o planejado dia a dia: a ordem empurrada de segunda
 * pra terça está no plano dos dois dias, e a soma dos dias a contaria duas
 * vezes. Aqui cada ordem conta uma vez.
 */
export function producaoDaSemana(dias: string[], ordens: OrdemPlano[], mudancas: MudancaDeDia[]): ProducaoSemana {
  const porOrdem = new Map<string, MudancaDeDia[]>()
  for (const m of mudancas) porOrdem.set(m.ordem_id, [...(porOrdem.get(m.ordem_id) ?? []), m])
  const s: ProducaoSemana = {
    planejadoT: 0, planejadoBags: 0, planejadoOrdens: 0,
    executadoT: 0, executadoBags: 0, executadoOrdens: 0, doPlanoT: 0, doPlanoOrdens: 0,
  }
  for (const o of ordens) {
    const terminouNaSemana = dias.some((d) => terminouEm(o, d))
    if (noPlanoDaSemana(o, porOrdem.get(o.id) ?? [], dias)) {
      s.planejadoT += Number(o.peso_t)
      s.planejadoBags += o.bags
      s.planejadoOrdens++
      if (terminouNaSemana) {
        s.doPlanoT += produzido(o).t
        s.doPlanoOrdens++
      }
    }
    if (terminouNaSemana) {
      const p = produzido(o)
      s.executadoT += p.t
      s.executadoBags += p.bags
      s.executadoOrdens++
    }
  }
  return s
}
