/**
 * Ciclo de vida da ordem e matriz de permissões por status.
 *
 * Regra de ouro: antes de iniciar, tudo é editável; depois que a produção toca
 * a ordem, ela é registro histórico e nada que afete medição pode mudar.
 */

import type { Ordem, StatusEfetivo } from './tipos'

export interface PermissoesStatus {
  editar: boolean
  excluir: boolean
  iniciar: boolean
  priorizar: boolean
  qualidade: boolean
  /** Estorno do lote de semente desta ordem. */
  estornarLote: boolean
  /**
   * Corrigir só o NÚMERO da ordem mesmo já tocada pela produção — decisão
   * de 11/08/2026. Único campo liberado aqui: não entra em nenhum cálculo
   * (tempo, consumo, peso), então corrigi-lo não distorce nada, diferente
   * de cultivar/receita/bags/lote/máquina/dia, que o gatilho de
   * imutabilidade continua travando. Vale até `Qualidade apontada`; trava
   * de novo em `Apontada` porque o número já foi lançado no AGROTIS
   * (ERP externo) — corrigir aqui divergiria de lá sem ninguém saber.
   */
  renumerar: boolean
}

export const MATRIZ_STATUS: Record<StatusEfetivo, PermissoesStatus> = {
  'Nao programada': {
    editar: true, excluir: true, iniciar: false,
    priorizar: true, qualidade: false, estornarLote: true, renumerar: false,
  },
  Programada: {
    editar: true, excluir: true, iniciar: false,
    priorizar: true, qualidade: false, estornarLote: true, renumerar: false,
  },
  'Aguardando lote': {
    editar: true, excluir: true, iniciar: false,
    priorizar: true, qualidade: false, estornarLote: true, renumerar: false,
  },
  'Pronto para produzir': {
    editar: true, excluir: true, iniciar: true,
    priorizar: true, qualidade: false, estornarLote: true, renumerar: false,
  },
  'Em producao': {
    editar: false, excluir: false, iniciar: false,
    priorizar: false, qualidade: false, estornarLote: false, renumerar: true,
  },
  Parada: {
    editar: false, excluir: false, iniciar: false,
    priorizar: false, qualidade: false, estornarLote: false, renumerar: true,
  },
  Finalizada: {
    editar: false, excluir: false, iniciar: false,
    priorizar: false, qualidade: true, estornarLote: false, renumerar: true,
  },
  'Qualidade apontada': {
    editar: false, excluir: false, iniciar: false,
    priorizar: false, qualidade: true, estornarLote: false, renumerar: true,
  },
  Apontada: {
    editar: false, excluir: false, iniciar: false,
    priorizar: false, qualidade: false, estornarLote: false, renumerar: false,
  },
}

/** Status em que a produção já tocou a ordem. */
export const STATUS_INICIADOS = [
  'Em producao',
  'Parada',
  'Finalizada',
  'Qualidade apontada',
  'Apontada',
] as const satisfies readonly StatusEfetivo[]

export function jaIniciada(status: StatusEfetivo): boolean {
  return (STATUS_INICIADOS as readonly string[]).includes(status)
}

/**
 * Status efetivo da ordem. 'Aguardando lote' e 'Pronto para produzir' são
 * derivados — nunca persistidos — mas a partir de 10/08/2026 olham a
 * liberação DESTA ordem (`ordem.loteLiberadoEm`), não mais o status do
 * lote inteiro: baixar libera bags para as ordens abertas NAQUELE momento,
 * e uma ordem criada depois não deve nascer pronta só porque o lote já
 * tinha sido baixado para outra — nem herdar sobra de uma ordem cancelada.
 */
export function statusEfetivo(ordem: Ordem): StatusEfetivo {
  if (jaIniciada(ordem.status)) return ordem.status
  if (!ordem.maquinaId) return 'Nao programada'
  return ordem.loteLiberadoEm == null ? 'Aguardando lote' : 'Pronto para produzir'
}

export function permissoes(status: StatusEfetivo): PermissoesStatus {
  return MATRIZ_STATUS[status]
}

export function pode(status: StatusEfetivo, acao: keyof PermissoesStatus): boolean {
  return MATRIZ_STATUS[status][acao]
}

/** Mensagem de bloqueio para o usuário, explicando o porquê. */
export function motivoBloqueio(status: StatusEfetivo): string | null {
  if (status === 'Em producao' || status === 'Parada') {
    return 'A ordem está em andamento — os tempos e consumos já estão sendo medidos.'
  }
  if (jaIniciada(status)) {
    return 'A ordem já foi finalizada — alterar agora distorceria tempos, consumos e relatórios.'
  }
  return null
}

/**
 * Chave anti-duplicidade da ordem: nº ordem + cultivar + tratamento + embalagem.
 */
export function chaveOrdem(o: {
  numero: string
  cultivar: string
  receitaId: string
  embalagem: string
}): string {
  return [o.numero, o.cultivar, o.receitaId, o.embalagem].join('|')
}
