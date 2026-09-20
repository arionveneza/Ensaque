/**
 * Ordens programadas que não atendem caminhão nenhum até um dia X
 * (19/09/2026, pedido do Arion: "na aba Programação, uma maneira de ver
 * quais ordens estão programadas mas não irão atender nenhuma agenda dentro
 * de um dia que eu vou escolher em um calendário").
 *
 * A pergunta é o COMPLEMENTO da fila da Expedição: lá se pergunta "que
 * caminhão fica sem produto"; aqui, "que ordem não tem caminhão". A regra,
 * decidida por ele: a ordem tem caminhão quando existe agendamento do MESMO
 * produto (`chaveProduto`: cultivar + tratamento + embalagem; SEM TSI só pelo
 * cultivar) com data até X — ou SEM data, que é demanda de prazo
 * desconhecido, nunca "para nunca" (a mesma leitura da fila). Não se
 * confere quantidade: uma ordem de 40 bags com um caminhão de 2 "tem
 * caminhão" — o que falta ou sobra é assunto da Expedição.
 *
 * Embalagem FORA dos ERPs (SC10/SC20, peso fixo — CLAUDE.md §1): pedido
 * dessas embalagens não existe na SimpleAgro, então nenhum agendamento jamais
 * casaria e a ordem seria "sem caminhão" para sempre — o mesmo alarme falso
 * que o painel Demanda × Estoque × Planejado isenta. Quem chama passa
 * `foraDosErps` e essas ordens saem da avaliação, contadas à parte.
 *
 * Puro: recebe as ordens e os agendamentos já carregados pela tela.
 */
import { chaveProduto } from './expedicao'
import { porNome } from './ordenacao'
import { ehConcluida } from './quadroDoDia'

/** O que a avaliação precisa de uma ordem (subconjunto de OrdemVisao). */
export interface OrdemAvaliavel {
  id: string
  numero: string
  cultivar: string
  receita_nome: string
  embalagem: string
  bags: number
  maquina_id: string | null
  data_prog: string | null
  status_efetivo: string
  /**
   * Status CRU (ordens.status). A v_ordens nunca emite 'Excluida' como
   * status_efetivo — a excluída sai da view como Programada/Aguardando/Pronto
   * — então a guarda só funciona olhando o cru; as consultas de hoje já
   * filtram (`listarOrdens` faz `.neq('status', 'Excluida')`), isto é cinto e
   * suspensório para um chamador que não filtre (achado da revisão).
   */
  status?: string
  fora_balanco: boolean
}

/** O que a avaliação precisa de um agendamento (subconjunto de AgendamentoBanco). */
export interface AgendaDoProduto {
  cultivar: string
  tratamento: string
  embalagem: string
  data: string | null
  bags: number
}

export interface OrdemSemAgenda<T extends OrdemAvaliavel> {
  ordem: T
  /** Menor data de caminhão do produto DEPOIS de X; null = nenhuma em data alguma. */
  proximaAgenda: string | null
  /** Bags agendados do produto NESSA data (o primeiro caminhão depois de X). */
  bagsNaProximaAgenda: number
  /** Σ bags agendados do produto em TODAS as datas depois de X. */
  agendadoDepois: number
}

export interface OpcoesSemAgenda {
  /** Embalagem que não existe nos ERPs (peso fixo): a ordem sai da avaliação. Padrão: nenhuma. */
  foraDosErps?: (embalagem: string) => boolean
}

const arred2 = (x: number) => Math.round(x * 100) / 100 + 0

/**
 * Entra na avaliação a ordem que está PROGRAMADA (máquina e dia) para até
 * X e ainda vai virar produto: não concluída (Finalizada, Qualidade
 * apontada e Apontada ficam de fora — já produziram), não excluída e no
 * balanço (`fora_balanco` é sacaria, nunca atende caminhão). Em produção,
 * parada, aguardando lote e pronta entram: ainda estão na fila. O pool (sem
 * máquina) fica de fora — a pergunta é sobre o que já ocupa a máquina.
 * Ordem com dia DEPOIS de X fica de fora: sem o corte, toda ordem futura
 * viraria ruído na lista.
 */
export function entraNaAvaliacao(o: OrdemAvaliavel, ate: string): boolean {
  return (
    o.maquina_id != null &&
    o.data_prog != null &&
    o.data_prog <= ate &&
    !ehConcluida(o.status_efetivo) &&
    o.status !== 'Excluida' &&
    o.status_efetivo !== 'Excluida' &&
    !o.fora_balanco
  )
}

/**
 * As ordens avaliadas que não têm caminhão até X, ordenadas por dia,
 * máquina e nº. Ordem repetida (a tela passa a janela da semana e as
 * atrasadas, que podem se sobrepor) conta uma vez só. `foraDosErps` lista
 * as que entrariam mas estão em embalagem fora dos ERPs.
 */
export function ordensSemAgenda<T extends OrdemAvaliavel>(
  ordens: T[],
  agendamentos: AgendaDoProduto[],
  ate: string,
  opcoes: OpcoesSemAgenda = {},
): { semAgenda: OrdemSemAgenda<T>[]; avaliadas: number; foraDosErps: T[] } {
  const temCaminhaoAte = new Set<string>()
  const depois = new Map<string, { data: string; bagsNaData: number; bags: number }>()
  for (const a of agendamentos) {
    const k = chaveProduto(a)
    if (a.data == null || a.data <= ate) {
      temCaminhaoAte.add(k)
      continue
    }
    const d = depois.get(k) ?? { data: a.data, bagsNaData: 0, bags: 0 }
    d.bags += a.bags
    if (a.data < d.data) {
      d.data = a.data
      d.bagsNaData = a.bags
    } else if (a.data === d.data) {
      d.bagsNaData += a.bags
    }
    depois.set(k, d)
  }

  const vistas = new Set<string>()
  const semAgenda: OrdemSemAgenda<T>[] = []
  const foraDosErps: T[] = []
  let avaliadas = 0
  for (const o of ordens) {
    if (vistas.has(o.id)) continue
    vistas.add(o.id)
    if (!entraNaAvaliacao(o, ate)) continue
    if (opcoes.foraDosErps?.(o.embalagem)) {
      foraDosErps.push(o)
      continue
    }
    avaliadas++
    const k = chaveProduto({ cultivar: o.cultivar, tratamento: o.receita_nome, embalagem: o.embalagem })
    if (temCaminhaoAte.has(k)) continue
    const d = depois.get(k)
    semAgenda.push({
      ordem: o,
      proximaAgenda: d?.data ?? null,
      bagsNaProximaAgenda: arred2(d?.bagsNaData ?? 0),
      agendadoDepois: arred2(d?.bags ?? 0),
    })
  }
  const porOrdem = (a: T, b: T) =>
    (a.data_prog ?? '').localeCompare(b.data_prog ?? '') ||
    (a.maquina_id ?? '').localeCompare(b.maquina_id ?? '') ||
    porNome(a.numero, b.numero)
  semAgenda.sort((a, b) => porOrdem(a.ordem, b.ordem))
  foraDosErps.sort(porOrdem)
  return { semAgenda, avaliadas, foraDosErps }
}
