import type { LinhaMotivo, LinhaOrdem, LinhaProduto } from './api'
import type {
  AlocacaoProduto, MotivoParada, Ordem, ProdutoQuimico, Receita,
} from '@/dominio/tipos'

/**
 * Converte as linhas do banco nos tipos do domínio, para que os cálculos já
 * testados em src/dominio sirvam a tela sem duplicar regra.
 */

const ms = (iso: string) => new Date(iso).getTime()

export function paraOrdemDominio(l: LinhaOrdem): Ordem {
  return {
    id: l.id,
    numero: l.numero,
    cultivar: l.cultivar,
    receitaId: l.receita_id,
    embalagem: l.embalagem,
    bags: l.bags,
    loteId: l.lote_id,
    cliente: l.cliente ?? undefined,
    observacao: l.observacao ?? undefined,
    prioridade: l.prioridade,
    maquinaId: l.maquina_id,
    dataProg: l.data_prog,
    seq: l.seq,
    turnoId: (l.turno_id as 1 | 2 | null) ?? null,
    status: l.status,
    loteLiberadoEm: l.lote_liberado_em ? ms(l.lote_liberado_em) : null,
    confirmadaEm: l.confirmada_em ? ms(l.confirmada_em) : null,
    eventos: l.ordem_eventos.map((e) => ({ tipo: e.tipo, ts: ms(e.ts) })),
    paradas: l.ordem_paradas.map((p) => ({
      motivoId: p.motivo_id,
      inicio: ms(p.inicio),
      fim: p.fim ? ms(p.fim) : null,
    })),
    // o produto entra no tanque que o OPERADOR escolheu nesta ordem
    tanques: l.ordem_tanques
      .slice()
      .sort((a, b) => a.tanque - b.tanque)
      .map((t) => {
        const doTanque = new Set(
          l.ordem_produtos.filter((op) => op.tanque === t.tanque).map((op) => op.produto_id),
        )
        return {
          tanque: t.tanque,
          itens: l.receitas.receita_itens
            .filter((i) => doTanque.has(i.produto_id))
            .map((i) => ({ produtoId: i.produto_id, dose: i.dose })),
          pesoInicial: t.peso_inicial,
          pesoFinal: t.peso_final,
          abastecidoKg: (t.ordem_tanque_abastecimentos ?? []).reduce(
            (a, x) => a + Number(x.peso_kg),
            0,
          ),
        }
      }),
  }
}

export function paraReceitaDominio(l: LinhaOrdem): Receita {
  return {
    id: l.receita_id,
    nome: l.receitas.nome,
    itens: l.receitas.receita_itens.map((i) => ({
      produtoId: i.produto_id,
      dose: i.dose,
    })),
  }
}

export const alocacaoDaOrdem = (l: LinhaOrdem): AlocacaoProduto[] =>
  l.ordem_produtos.map((op) => ({ produtoId: op.produto_id, tanque: op.tanque }))

export const mapaProdutos = (linhas: LinhaProduto[]): Map<string, ProdutoQuimico> =>
  new Map(
    linhas.map((p) => [
      p.id,
      {
        id: p.id,
        codigo: p.codigo,
        nome: p.nome,
        unidade: p.unidade,
        densidade: p.densidade,
      },
    ]),
  )

export const mapaMotivos = (linhas: LinhaMotivo[]): Map<string, MotivoParada> =>
  new Map(
    linhas.map((m) => [m.id, { id: m.id, descricao: m.descricao, tipo: m.tipo }]),
  )

export const pesoOrdemKg = (l: LinhaOrdem): number => l.bags * l.lotes_semente.peso_bag_kg
