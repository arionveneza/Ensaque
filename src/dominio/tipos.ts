/**
 * Tipos do domínio TSI.
 *
 * Espelham o schema em supabase/schema.sql. Os status derivados
 * ('Aguardando lote' e 'Pronto para produzir') existem aqui e na view v_ordens,
 * mas nunca são persistidos na coluna status.
 */

export type Perfil = 'PCP' | 'Logistica' | 'Producao' | 'Qualidade' | 'Gestor'

/**
 * As bulas de TSI costumam expressar a dose por 100 kg de semente; algumas
 * fichas trazem por kg. As quatro combinações existem para o cadastro copiar
 * o número EXATO da ficha — conversão de cabeça é onde nasce erro de 100×.
 */
export type UnidadeDose = 'ml/kg' | 'g/kg' | 'ml/100kg' | 'g/100kg'

export type StatusLote = 'Em estoque' | 'Baixado'

export type TipoParada = 'Planejada' | 'Nao planejada'

export type QualidadeVisual = 'Aprovado' | 'Aprovado com observacao' | 'Reprovado'

/** Status persistidos na coluna `ordens.status`. */
export type StatusPersistido =
  | 'Nao programada'
  | 'Programada'
  | 'Em producao'
  | 'Parada'
  | 'Finalizada'
  | 'Qualidade apontada'
  | 'Apontada'

/** Status derivados: dependem da baixa do lote, não são gravados. */
export type StatusDerivado = 'Aguardando lote' | 'Pronto para produzir'

export type StatusEfetivo = StatusPersistido | StatusDerivado

export interface Maquina {
  id: string
  nome: string
  capacidadeTh: number
  qtdTanques: number
}

export interface Turno {
  id: 1 | 2
  nome: string
  inicio: string
  fim: string
  horas: number
}

export interface Embalagem {
  codigo: string
  /** Código da SimpleAgro: BB5M / BMB. */
  codigoExt: string
  descricao: string
  sementes: number
  /** peso_bag = PMS × fatorPeso */
  fatorPeso: number
}

export interface ProdutoQuimico {
  id: string
  codigo: string
  nome: string
  unidade: UnidadeDose
  /** g/ml — obrigatório quando unidade é 'ml/kg'; null quando a dose já é peso. */
  densidade: number | null
}

/**
 * Item da receita: produto e dose. O TANQUE não está aqui de propósito —
 * a distribuição varia de ordem para ordem, então quem informa é o operador
 * ao preparar a ordem (decisão de 05/08/2026).
 */
export interface ItemReceita {
  produtoId: string
  dose: number
}

/**
 * Destino escolhido pelo operador nesta ordem: 1–5 = tanque, 0 =
 * transferidor (pó secante, que nunca vai em tanque). Mais de um produto
 * no mesmo destino = mistura.
 */
export interface AlocacaoProduto {
  produtoId: string
  tanque: number
}

export interface Receita {
  id: string
  /** Nome = código do comercial (FTZ60, V&P, DER + LMT...). */
  nome: string
  itens: ItemReceita[]
}

export interface MotivoParada {
  id: string
  descricao: string
  tipo: TipoParada
}

export interface LoteSemente {
  id: string
  cultivar: string
  /** Peso de mil sementes, em gramas. */
  pms: number | null
  pesoBagKg: number
  bagsDisp: number
  status: StatusLote
}

export interface Parada {
  motivoId: string
  inicio: number
  fim: number | null
}

export interface EventoOrdem {
  tipo: 'inicio' | 'fim'
  ts: number
}

export interface TanqueOrdem {
  tanque: number
  itens: ItemReceita[]
  pesoInicial: number | null
  pesoFinal: number | null
}

export interface Ordem {
  id: string
  numero: string
  cultivar: string
  receitaId: string
  embalagem: string
  bags: number
  loteId: string
  cliente?: string
  observacao?: string
  prioridade: 'Normal' | 'Urgente'
  maquinaId: string | null
  dataProg: string | null
  seq: number | null
  /** Derivado do horário real do início. Nunca programado. */
  turnoId: 1 | 2 | null
  status: StatusPersistido
  eventos: EventoOrdem[]
  paradas: Parada[]
  tanques: TanqueOrdem[]
}

export interface LinhaDemanda {
  cultivar: string
  /** Código do tratamento; pode não ter receita cadastrada. */
  tratamento: string
  embalagem: string
  bags: number
}

export interface PedidoVenda extends LinhaDemanda {
  /** Coluna H do relatório: só 'Aprovado' entra no balanço. */
  aprovado: boolean
}
