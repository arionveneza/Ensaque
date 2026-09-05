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
  inventario: ['ver', 'abrir', 'contar'],
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
  abrir: 'Abrir/fechar inventário',
  contar: 'Lançar contagem',
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
    // Mapa (30/08/2026): montar carga e lotear são do PCP (e Gestor);
    // endereçar/movimentar segue da Logística
    mapa: ['ver', 'importar', 'montar_carga'],
    // Inventário (04/09/2026): o PCP abre, insere o estoque do SAP e fecha;
    // contar é da Logística e da Produção (e do PCP também)
    inventario: ['ver', 'abrir', 'contar'],
    cadastros: ['ver', 'editar'],
    expedicao: ['ver', 'importar'],
    veiculos: ['ver', 'chamar', 'checklist'],
  },
  Logistica: {
    programacao: ['ver'],
    lotes: ['ver', 'baixar_lote', 'conferir'],
    etapas: ['ver'],
    indicadores: ['ver'],
    // Mapa (30/08/2026): endereçamento, movimentação, filtros, upload e
    // FOTOS da carga são da Logística; montar carga/lotear virou do PCP
    mapa: ['ver', 'importar', 'enderecar'],
    // Inventário (04/09/2026): a Logística conta (lança endereço + quantidade)
    inventario: ['ver', 'contar'],
    // os carregamentos são agenda da logística tanto quanto do PCP
    expedicao: ['ver', 'importar'],
    veiculos: ['ver', 'chamar', 'checklist'],
  },
  Producao: {
    programacao: ['ver'],
    execucao: ['ver', 'apontar'],
    etapas: ['ver'],
    indicadores: ['ver'],
    // Inventário (04/09/2026): o operador de produção também conta
    inventario: ['ver', 'contar'],
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
    inventario: ['ver'],
    cadastros: ['ver'],
    expedicao: ['ver'],
    veiculos: ['ver'],
  },
  /**
   * Balança (15/08/2026): perfil do pátio/portaria — checklist de veículo e
   * chamada de motorista. A montagem de carga passou pro PCP em 30/08/2026;
   * a Balança segue VENDO o mapa e as cargas.
   */
  Balanca: {
    veiculos: ['ver', 'chamar', 'checklist'],
    mapa: ['ver'],
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
