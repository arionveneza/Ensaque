/**
 * Etapas da ordem — a régua da visão geral.
 *
 *   Produção → Q. em processo (durante) → Q. final → Conferência → AGROTIS
 *
 * A qualidade em processo só existe ENQUANTO a ordem roda: se a ordem
 * finalizou sem nenhum registro, a janela passou — não é pendência, é
 * "não realizada". O AGROTIS é o último: exige a qualidade final E a
 * conferência de estoque da logística.
 */

export type SituacaoEtapa = 'feita' | 'pendente' | 'nao-aplicavel'

export interface EtapaOrdem {
  id: 'producao' | 'q_processo' | 'q_final' | 'conferencia' | 'agrotis'
  rotulo: string
  situacao: SituacaoEtapa
  /** Complemento curto: "3×" nos checks, "não realizada" na janela perdida. */
  detalhe?: string
}

/** O recorte da v_ordem_etapas que decide a régua. */
export interface OrdemComEtapas {
  status_efetivo: string
  checks_processo: number
  tem_qualidade_final: boolean
  conferida: boolean
}

const EM_EXECUCAO = ['Em producao', 'Parada']
const FINALIZADA_OU_ALEM = ['Finalizada', 'Qualidade apontada', 'Apontada']

export function etapasDaOrdem(o: OrdemComEtapas): EtapaOrdem[] {
  const executando = EM_EXECUCAO.includes(o.status_efetivo)
  const finalizada = FINALIZADA_OU_ALEM.includes(o.status_efetivo)
  // o status carrega a qualidade final implícita: 'Qualidade apontada' e
  // 'Apontada' só existem depois dela
  const qualFinal =
    o.tem_qualidade_final ||
    o.status_efetivo === 'Qualidade apontada' ||
    o.status_efetivo === 'Apontada'

  return [
    {
      id: 'producao',
      rotulo: 'Produção',
      situacao: finalizada ? 'feita' : 'pendente',
      detalhe: executando ? 'em execução' : undefined,
    },
    {
      id: 'q_processo',
      rotulo: 'Q. processo',
      situacao:
        o.checks_processo > 0 ? 'feita' : executando ? 'pendente' : 'nao-aplicavel',
      detalhe:
        o.checks_processo > 0
          ? `${o.checks_processo}×`
          : finalizada
            ? 'não realizada'
            : undefined,
    },
    {
      id: 'q_final',
      rotulo: 'Q. final',
      situacao: qualFinal ? 'feita' : finalizada ? 'pendente' : 'nao-aplicavel',
    },
    {
      id: 'conferencia',
      rotulo: 'Conferência',
      situacao: o.conferida ? 'feita' : finalizada ? 'pendente' : 'nao-aplicavel',
    },
    {
      id: 'agrotis',
      rotulo: 'AGROTIS',
      // pré-requisitos: qualidade final E conferência da logística
      situacao:
        o.status_efetivo === 'Apontada'
          ? 'feita'
          : qualFinal && o.conferida
            ? 'pendente'
            : 'nao-aplicavel',
      detalhe:
        o.status_efetivo === 'Apontada' || !finalizada
          ? undefined
          : qualFinal && o.conferida
            ? undefined
            : `aguarda ${[
                !qualFinal ? 'q. final' : null,
                !o.conferida ? 'conferência' : null,
              ]
                .filter(Boolean)
                .join(' e ')}`,
    },
  ]
}

/** Ordem 100% concluída: apontada no AGROTIS (o registro definitivo). */
export const ordemConcluida = (o: OrdemComEtapas): boolean =>
  o.status_efetivo === 'Apontada'

/** Quantas etapas aplicáveis ainda faltam — para ordenar a visão geral. */
export const etapasPendentes = (o: OrdemComEtapas): number =>
  etapasDaOrdem(o).filter((e) => e.situacao === 'pendente').length
