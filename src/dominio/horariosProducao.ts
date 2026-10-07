/**
 * Horários das ordens e das paradas (07/10/2026, pedido do Arion: "eu preciso
 * na aba de indicadores um relatório com horário de início e fim de cada ordem
 * e as paradas"). Até aqui eram dois cartões separados — "Paradas no período"
 * e "Planejado vs realizado por ordem" —, e ver o que travou a ordem 150067
 * exigia cruzar os dois de cabeça.
 *
 * Aqui é a LINHA DO TEMPO de cada máquina em cada dia de produção (07:30–03:00):
 * as ordens na ordem em que começaram, cada uma com as SUAS paradas embaixo, e
 * as paradas de máquina (sem ordem — aguardando semente e afins) intercaladas
 * no horário em que aconteceram. O dia é o do INÍCIO real (`diaDeProducao`),
 * não o programado: é um relatório de horário, e a ordem adiantada aparece no
 * dia em que rodou. Função pura — testável sem banco.
 */

import { diaDeProducao } from './calculos'
import type { TipoParada } from './tipos'

export interface OrdemHorario {
  ordem_id: string
  numero: string
  maquina_id: string
  turno_id: number | null
  /** Início real (apontamento); `fim` null enquanto roda. */
  ini: string
  fim: string | null
  bruto_s: number
  paradas_s: number
  liquido_s: number
  cultivar?: string | null
  tratamento?: string | null
  lote?: string | null
}

export interface ParadaHorario {
  inicio: string
  fim: string | null
  segundos: number
  motivo: string
  tipo: TipoParada
  observacao?: string | null
}

export interface ParadaDaOrdem extends ParadaHorario {
  ordem_id: string
}

export interface ParadaDeMaquina extends ParadaHorario {
  maquina_id: string
  /** Dia de produção já calculado na leitura (`listarParadasMaquina`). */
  dia: string
}

export type LinhaHorario =
  | ({ linha: 'ordem'; paradas: ParadaHorario[] } & OrdemHorario)
  | ({ linha: 'parada-maquina' } & ParadaDeMaquina)

export interface GrupoHorario {
  dia: string
  maquina_id: string
  linhas: LinhaHorario[]
  ordens: number
  /** Soma dos tempos brutos das ordens do grupo. */
  brutoS: number
  /** Paradas DENTRO das ordens. */
  paradasOrdemS: number
  /** Paradas de máquina, fora de ordem. */
  paradasMaquinaS: number
}

const inicioDa = (l: LinhaHorario) => (l.linha === 'ordem' ? l.ini : l.inicio)

export function horariosPorDiaEMaquina(
  ordens: OrdemHorario[],
  paradasOrdem: ParadaDaOrdem[],
  paradasMaquina: ParadaDeMaquina[],
): GrupoHorario[] {
  const paradasPorOrdem = new Map<string, ParadaHorario[]>()
  for (const { ordem_id, ...p } of paradasOrdem) {
    paradasPorOrdem.set(ordem_id, [...(paradasPorOrdem.get(ordem_id) ?? []), p])
  }

  const grupos = new Map<string, GrupoHorario>()
  const grupo = (dia: string, maquina_id: string) => {
    const k = `${dia}|${maquina_id}`
    let g = grupos.get(k)
    if (!g) {
      g = { dia, maquina_id, linhas: [], ordens: 0, brutoS: 0, paradasOrdemS: 0, paradasMaquinaS: 0 }
      grupos.set(k, g)
    }
    return g
  }

  for (const o of ordens) {
    const g = grupo(diaDeProducao(new Date(o.ini)), o.maquina_id)
    const paradas = [...(paradasPorOrdem.get(o.ordem_id) ?? [])].sort((a, b) =>
      a.inicio.localeCompare(b.inicio),
    )
    g.linhas.push({ linha: 'ordem', ...o, paradas })
    g.ordens++
    g.brutoS += Number(o.bruto_s) || 0
    g.paradasOrdemS += paradas.reduce((s, p) => s + p.segundos, 0)
  }
  for (const p of paradasMaquina) {
    const g = grupo(p.dia, p.maquina_id)
    g.linhas.push({ linha: 'parada-maquina', ...p })
    g.paradasMaquinaS += p.segundos
  }

  for (const g of grupos.values()) {
    // ISO com fuso do banco: comparar como data, não como texto
    g.linhas.sort((a, b) => new Date(inicioDa(a)).getTime() - new Date(inicioDa(b)).getTime())
  }
  return [...grupos.values()].sort(
    (a, b) =>
      a.dia.localeCompare(b.dia) ||
      a.maquina_id.localeCompare(b.maquina_id, 'pt-BR', { numeric: true }),
  )
}

/**
 * Hora curta de um momento dentro do dia de produção `dia`: "08:10"; quando o
 * relógio já virou para outro dia de calendário (turno 2 depois da meia-noite,
 * ou ordem que atravessou dias), "01:30 (08/10)" — senão 01:30 parece manhã.
 */
export function horaNoDia(iso: string, dia: string): string {
  const d = new Date(iso)
  const hora = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const calendario = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-')
  return calendario === dia ? hora : `${hora} (${calendario.slice(8, 10)}/${calendario.slice(5, 7)})`
}
