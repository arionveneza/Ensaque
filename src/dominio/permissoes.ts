/**
 * Matriz de permissões por perfil.
 *
 * A tabela `perfil_permissoes` guarda só o que o gestor MEXEU. Célula ausente
 * segue o padrão daqui — assim a tabela pode nascer vazia sem trancar ninguém,
 * e marcar uma célula não apaga as demais do perfil. A regra de resolução é:
 * linha explícita manda; ausente, vale o padrão.
 *
 * O RLS no banco continua sendo a proteção real; isto controla a interface.
 */

import type { Perfil } from './tipos'

/** Ações que fazem sentido em cada recurso — evita matriz cheia de célula inútil. */
export const ACOES_POR_RECURSO: Record<string, string[]> = {
  ordens: ['ver', 'criar', 'editar', 'excluir', 'priorizar'],
  programacao: ['ver', 'editar'],
  lotes: ['ver', 'baixar_lote'],
  execucao: ['ver', 'apontar'],
  qualidade: ['ver', 'qualidade', 'agrotis'],
  indicadores: ['ver'],
  cadastros: ['ver', 'editar'],
}

export const ROTULO_ACAO: Record<string, string> = {
  ver: 'Ver',
  criar: 'Criar',
  editar: 'Editar',
  excluir: 'Excluir',
  priorizar: 'Priorizar',
  baixar_lote: 'Baixar lote',
  apontar: 'Apontar',
  qualidade: 'Apontar qualidade',
  agrotis: 'Lançar AGROTIS',
}

/**
 * O padrão de fábrica, espelhando a matriz da especificação (§5):
 * PCP programa e encerra, Logística baixa lote, Produção aponta,
 * Qualidade avalia, Gestor tudo.
 */
export const MATRIZ_PADRAO: Record<Perfil, Record<string, string[]>> = {
  PCP: {
    ordens: ['ver', 'criar', 'editar', 'excluir', 'priorizar'],
    programacao: ['ver', 'editar'],
    lotes: ['ver'],
    execucao: ['ver'],
    qualidade: ['ver', 'agrotis'],
    indicadores: ['ver'],
    cadastros: ['ver', 'editar'],
  },
  Logistica: {
    programacao: ['ver'],
    lotes: ['ver', 'baixar_lote'],
    indicadores: ['ver'],
  },
  Producao: {
    programacao: ['ver'],
    execucao: ['ver', 'apontar'],
    indicadores: ['ver'],
  },
  Qualidade: {
    execucao: ['ver'],
    qualidade: ['ver', 'qualidade'],
    indicadores: ['ver'],
  },
  Gestor: { ...ACOES_POR_RECURSO },
}

export const permitidoPadrao = (
  perfil: Perfil,
  recurso: string,
  acao: string,
): boolean => MATRIZ_PADRAO[perfil]?.[recurso]?.includes(acao) ?? false

/** Linha explícita da tabela; `permitido` pode contradizer o padrão — e manda. */
export interface PermissaoExplicita {
  recurso: string
  acao: string
  permitido: boolean
}

/**
 * Resolve a permissão efetiva: o que o gestor gravou vence; célula nunca
 * gravada cai no padrão do perfil.
 */
export function permissaoEfetiva(
  perfil: Perfil,
  recurso: string,
  acao: string,
  explicitas: PermissaoExplicita[],
): boolean {
  const linha = explicitas.find((p) => p.recurso === recurso && p.acao === acao)
  return linha ? linha.permitido : permitidoPadrao(perfil, recurso, acao)
}
