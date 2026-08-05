import type { LinhaMotivo, LinhaOrdem, LinhaProduto } from './api'
import type { MotivoParada, Ordem, ProdutoQuimico, Receita } from '@/dominio/tipos'

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
    eventos: l.ordem_eventos.map((e) => ({ tipo: e.tipo, ts: ms(e.ts) })),
    paradas: l.ordem_paradas.map((p) => ({
      motivoId: p.motivo_id,
      inicio: ms(p.inicio),
      fim: p.fim ? ms(p.fim) : null,
    })),
    tanques: l.ordem_tanques
      .slice()
      .sort((a, b) => a.tanque - b.tanque)
      .map((t) => ({
        tanque: t.tanque,
        itens: l.receitas.receita_itens
          .filter((i) => i.tanque === t.tanque)
          .map((i) => ({ produtoId: i.produto_id, dose: i.dose, tanque: i.tanque })),
        pesoInicial: t.peso_inicial,
        pesoFinal: t.peso_final,
      })),
  }
}

export function paraReceitaDominio(l: LinhaOrdem): Receita {
  return {
    id: l.receita_id,
    nome: l.receitas.nome,
    itens: l.receitas.receita_itens.map((i) => ({
      produtoId: i.produto_id,
      dose: i.dose,
      tanque: i.tanque,
    })),
  }
}

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

/** Tanques da receita, na ordem, para preparar a ordem antes de iniciar. */
export const tanquesDaReceita = (l: LinhaOrdem): number[] =>
  [...new Set(l.receitas.receita_itens.map((i) => i.tanque))].sort((a, b) => a - b)

export const pesoOrdemKg = (l: LinhaOrdem): number => l.bags * l.lotes_semente.peso_bag_kg
