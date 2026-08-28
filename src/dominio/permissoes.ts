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
  lotes: ['ver', 'baixar_lote', 'conferir'],
  execucao: ['ver', 'apontar'],
  qualidade: ['ver', 'qualidade'],
  agrotis: ['ver', 'lancar'],
  etapas: ['ver'],
  indicadores: ['ver'],
  mrp: ['ver', 'importar'],
  mapa: ['ver', 'importar', 'enderecar', 'montar_carga'],
  cadastros: ['ver', 'editar'],
  expedicao: ['ver', 'importar'],
  veiculos: ['ver', 'chamar', 'checklist'],
}

export const ROTULO_ACAO: Record<string, string> = {
  ver: 'Ver',
  criar: 'Criar',
  editar: 'Editar',
  excluir: 'Excluir',
  priorizar: 'Priorizar',
  baixar_lote: 'Baixar lote',
  conferir: 'Conferir estoque',
  apontar: 'Apontar',
  qualidade: 'Apontar qualidade',
  lancar: 'Lançar no AGROTIS',
  importar: 'Importar planilha',
  chamar: 'Chamar motorista',
  checklist: 'Preencher checklist',
  enderecar: 'Endereçar lote',
  montar_carga: 'Montar carga',
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
    qualidade: ['ver'],
    agrotis: ['ver', 'lancar'],
    etapas: ['ver'],
    indicadores: ['ver'],
    // MRP (27/08/2026): necessidade de material — PCP, Gestor e Direção;
    // importar = subir o estoque de químicos do SAP (PCP/Gestor)
    mrp: ['ver', 'importar'],
    // Mapa (28/08/2026): PCP vê e sobe o saldo do SAP; endereçar é da
    // Logística, montar carga é da Balança
    mapa: ['ver', 'importar'],
    cadastros: ['ver', 'editar'],
    expedicao: ['ver', 'importar'],
    veiculos: ['ver', 'chamar', 'checklist'],
  },
  Logistica: {
    programacao: ['ver'],
    lotes: ['ver', 'baixar_lote', 'conferir'],
    etapas: ['ver'],
    indicadores: ['ver'],
    // Mapa (28/08/2026): endereçamento e movimentação de lote são da
    // Logística; ela também pode subir o saldo e montar carga se precisar
    mapa: ['ver', 'importar', 'enderecar', 'montar_carga'],
    // os carregamentos são agenda da logística tanto quanto do PCP
    expedicao: ['ver', 'importar'],
    veiculos: ['ver', 'chamar', 'checklist'],
  },
  Producao: {
    programacao: ['ver'],
    execucao: ['ver', 'apontar'],
    etapas: ['ver'],
    indicadores: ['ver'],
  },
  Qualidade: {
    execucao: ['ver'],
    qualidade: ['ver', 'qualidade'],
    etapas: ['ver'],
    indicadores: ['ver'],
  },
  /**
   * Direção enxerga a operação inteira e exporta relatório, mas não altera
   * nada: só a ação `ver` em cada recurso. Exportar não é ação própria —
   * quem vê a tela baixa o .xlsx dela.
   */
  Direcao: {
    ordens: ['ver'],
    programacao: ['ver'],
    lotes: ['ver'],
    execucao: ['ver'],
    qualidade: ['ver'],
    agrotis: ['ver'],
    etapas: ['ver'],
    indicadores: ['ver'],
    mrp: ['ver'],
    mapa: ['ver'],
    cadastros: ['ver'],
    expedicao: ['ver'],
    veiculos: ['ver'],
  },
  /**
   * Balança (15/08/2026): perfil do pátio/portaria — checklist de veículo,
   * chamada de motorista e, desde 28/08/2026, a montagem de carga na aba
   * Mapa (a operadora informa a ordem de carregamento e escolhe os lotes).
   */
  Balanca: {
    veiculos: ['ver', 'chamar', 'checklist'],
    mapa: ['ver', 'montar_carga'],
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
