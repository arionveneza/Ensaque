/**
 * Ciclo de vida da ordem e matriz de permissões por status.
 *
 * Regra de ouro: antes de iniciar, tudo é editável; depois que a produção toca
 * a ordem, ela é registro histórico e nada que afete medição pode mudar.
 */

import type { Ordem, StatusEfetivo, StatusLote } from './tipos'

export interface PermissoesStatus {
  editar: boolean
  excluir: boolean
  iniciar: boolean
  priorizar: boolean
  qualidade: boolean
  /** Estorno do lote de semente desta ordem. */
  estornarLote: boolean
}

export const MATRIZ_STATUS: Record<StatusEfetivo, PermissoesStatus> = {
  'Nao programada': {
    editar: true, excluir: true, iniciar: false,
    priorizar: true, qualidade: false, estornarLote: true,
  },
  Programada: {
    editar: true, excluir: true, iniciar: false,
    priorizar: true, qualidade: false, estornarLote: true,
  },
  'Aguardando lote': {
    editar: true, excluir: true, iniciar: false,
    priorizar: true, qualidade: false, estornarLote: true,
  },
  'Pronto para produzir': {
    editar: true, excluir: true, iniciar: true,
    priorizar: true, qualidade: false, estornarLote: true,
  },
  'Em producao': {
    editar: false, excluir: false, iniciar: false,
    priorizar: false, qualidade: false, estornarLote: false,
  },
  Parada: {
    editar: false, excluir: false, iniciar: false,
    priorizar: false, qualidade: false, estornarLote: false,
  },
  Finalizada: {
    editar: false, excluir: false, iniciar: false,
    priorizar: false, qualidade: true, estornarLote: false,
  },
  'Qualidade apontada': {
    editar: false, excluir: false, iniciar: false,
    priorizar: false, qualidade: true, estornarLote: false,
  },
  Apontada: {
    editar: false, excluir: false, iniciar: false,
    priorizar: false, qualidade: false, estornarLote: false,
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
 * derivados da baixa do lote — nunca persistidos.
 */
export function statusEfetivo(ordem: Ordem, statusLote: StatusLote): StatusEfetivo {
  if (jaIniciada(ordem.status)) return ordem.status
  if (!ordem.maquinaId) return 'Nao programada'
  return statusLote === 'Em estoque' ? 'Aguardando lote' : 'Pronto para produzir'
}

export function permissoes(status: StatusEfetivo): PermissoesStatus {
  return MATRIZ_STATUS[status]
}

export function pode(status: StatusEfetivo, acao: keyof PermissoesStatus): boolean {
  return MATRIZ_STATUS[status][acao]
}

/**
 * Estorno de lote é bloqueado se QUALQUER ordem daquele lote já foi iniciada.
 * A baixa é do lote, não da ordem — então a decisão olha todas as dependentes.
 */
export function podeEstornarLote(
  ordensDoLote: { status: StatusEfetivo }[],
): { permitido: boolean; motivo?: string } {
  const iniciadas = ordensDoLote.filter((o) => jaIniciada(o.status))
  if (iniciadas.length > 0) {
    return {
      permitido: false,
      motivo: `Lote já consumido por ${iniciadas.length} ordem(ns) iniciada(s).`,
    }
  }
  return { permitido: true }
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
