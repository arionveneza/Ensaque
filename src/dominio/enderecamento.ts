/**
 * Endereçamento pela planilha (18/09/2026) — domínio puro.
 *
 * A operação anota à mão, na planilha "Produção 2026" do Google, onde cada
 * lote está: armazém, bloco e quadra. Pedido do Arion: ver os **lotes mais
 * fáceis** de puxar. A regra é dele e o mapa esquemático do galpão confirma:
 * dentro do MESMO bloco, **quadra de número MAIOR fica na frente, junto do
 * portão** — na aba "MO AZ A" da própria planilha, os blocos 41D e 42D
 * cercam o PORTÃO 08 com as quadras 8 e 9, e os números caem à medida que
 * se afunda no bloco. É a mesma regra que a grade do Mapa já usa.
 *
 * A unidade aqui é a LINHA (lote + tratamento + endereço), não o lote: 123
 * lotes da planilha estão em mais de um lugar ao mesmo tempo, com
 * tratamentos diferentes. Somar tudo num lote só apagaria justamente a
 * informação de onde ir buscar.
 */

export const ehQuadraNumerica = (q: string): boolean => /^\d+$/.test(q.trim())

/** Quadra numérica ordena da maior pra menor (frente primeiro); texto (CORREDOR, SILO) vai pro fim. */
export const ordenaQuadras = (a: string, b: string): number => {
  const na = ehQuadraNumerica(a) ? Number(a) : null
  const nb = ehQuadraNumerica(b) ? Number(b) : null
  if (na != null && nb != null) return nb - na
  if (na != null) return -1
  if (nb != null) return 1
  return a.localeCompare(b)
}

export const rotuloQuadra = (q: string): string =>
  ehQuadraNumerica(q) ? `QD${q.trim().padStart(2, '0')}` : q.trim()

/** "1C" → "01C", mesma casa do 01C — a planilha usa os dois formatos. */
export const normalizaBloco = (s: string): string => {
  const b = s.replace(/\s+/g, ' ').trim().toUpperCase()
  const m = b.match(/^(\d)([A-Z])$/)
  return m ? `0${m[1]}${m[2]}` : b
}

/** Uma linha da planilha: um lote, com um tratamento, num endereço. */
export interface PosicaoPlanilha {
  lote: string
  tratamento: string
  cultivar: string
  classe: string
  destinacao: string
  status: string
  armazem: string
  /** Já normalizado ("1C" → "01C"). */
  bloco: string
  /** Texto: '4', 'CORREDOR', ''. Vazio = endereço incompleto. */
  quadra: string
  bags: number
  /** dd/mm/aaaa como veio; pode ser vazio — NUNCA serve de filtro. */
  data: string
  /** >1 quando a planilha tinha a mesma linha repetida e os bags foram somados. */
  linhasSomadas: number
}

export interface LinhaRanqueada extends PosicaoPlanilha {
  /** 1 = frente do bloco. null = quadra não numérica ou endereço incompleto. */
  posicaoNoBloco: number | null
  /** Quantas linhas o bloco tem ao todo (inclusive as sem quadra). */
  totalNoBloco: number
  /** Quantas dividem esta MESMA quadra, contando ela própria (1 = sozinha). */
  empatados: number
  /** Bags a tirar da frente para alcançar. 0 = puxa direto. null = não ranqueável. */
  bagsNaFrente: number | null
  /** Endereço completo (armazém, bloco e quadra preenchidos). */
  enderecoCompleto: boolean
}

const chaveDoLote = (p: PosicaoPlanilha) => `${p.lote}|${p.tratamento}`
export const chaveBloco = (p: { armazem: string; bloco: string }): string =>
  `${p.armazem}|${p.bloco}`

const enderecoCompletoDe = (p: PosicaoPlanilha) =>
  p.armazem.trim() !== '' && p.bloco.trim() !== '' && p.quadra.trim() !== ''

/**
 * Posição e material na frente, bloco a bloco.
 *
 * - **posição** = 1 + nº de linhas do mesmo bloco com quadra ESTRITAMENTE
 *   maior. Empatados dividem a posição e a seguinte pula (`4,3,3,2,1` vira
 *   `1,2,2,4,5`), como em qualquer ranking de competição.
 * - **bags na frente** = soma dos bags do mesmo bloco em quadras
 *   estritamente maiores, fora as do PRÓPRIO lote (o lote não é obstáculo
 *   de si mesmo) — mesma semântica do `bagsNaFrenteDe` do Mapa. Quem
 *   divide a quadra está do lado, não na frente, e por isso não conta.
 */
export function ranquear(posicoes: PosicaoPlanilha[]): LinhaRanqueada[] {
  const porBloco = new Map<string, PosicaoPlanilha[]>()
  for (const p of posicoes) {
    const k = chaveBloco(p)
    const lista = porBloco.get(k)
    if (lista) lista.push(p)
    else porBloco.set(k, [p])
  }

  const saida: LinhaRanqueada[] = []
  for (const [, linhas] of porBloco) {
    const numericas = linhas.filter((p) => ehQuadraNumerica(p.quadra) && enderecoCompletoDe(p))
    for (const p of linhas) {
      const completo = enderecoCompletoDe(p)
      if (!completo || !ehQuadraNumerica(p.quadra)) {
        saida.push({
          ...p,
          posicaoNoBloco: null,
          totalNoBloco: linhas.length,
          empatados: 1,
          bagsNaFrente: null,
          enderecoCompleto: completo,
        })
        continue
      }
      const q = Number(p.quadra)
      const naFrente = numericas.filter((o) => Number(o.quadra) > q)
      saida.push({
        ...p,
        posicaoNoBloco: 1 + naFrente.length,
        totalNoBloco: linhas.length,
        empatados: numericas.filter((o) => Number(o.quadra) === q).length,
        bagsNaFrente: naFrente
          .filter((o) => chaveDoLote(o) !== chaveDoLote(p))
          .reduce((s, o) => s + o.bags, 0),
        enderecoCompleto: true,
      })
    }
  }
  return saida
}

/** Da mais fácil para a mais difícil; sem quadra por último. */
export function ordenaPorFacilidade(a: LinhaRanqueada, b: LinhaRanqueada): number {
  if ((a.posicaoNoBloco == null) !== (b.posicaoNoBloco == null)) {
    return a.posicaoNoBloco == null ? 1 : -1
  }
  if (a.posicaoNoBloco != null && b.posicaoNoBloco != null) {
    if (a.bagsNaFrente !== b.bagsNaFrente) return (a.bagsNaFrente ?? 0) - (b.bagsNaFrente ?? 0)
    if (a.posicaoNoBloco !== b.posicaoNoBloco) return a.posicaoNoBloco - b.posicaoNoBloco
  }
  return (
    a.armazem.localeCompare(b.armazem, 'pt-BR') ||
    a.bloco.localeCompare(b.bloco, 'pt-BR', { numeric: true }) ||
    a.lote.localeCompare(b.lote, 'pt-BR')
  )
}

export interface QuadraDoBloco {
  quadra: string
  linhas: LinhaRanqueada[]
  bags: number
}

export interface ResumoBloco {
  armazem: string
  bloco: string
  linhas: number
  bags: number
  /** Já em ordem frente → fundo. */
  quadras: QuadraDoBloco[]
}

/** Agrupa para a vista "Por bloco": armazém → bloco → quadra, frente primeiro. */
export function resumoPorBloco(linhas: LinhaRanqueada[]): ResumoBloco[] {
  const blocos = new Map<string, ResumoBloco>()
  for (const l of linhas) {
    const k = chaveBloco(l)
    let b = blocos.get(k)
    if (!b) {
      b = { armazem: l.armazem, bloco: l.bloco, linhas: 0, bags: 0, quadras: [] }
      blocos.set(k, b)
    }
    b.linhas++
    b.bags += l.bags
    const q = b.quadras.find((x) => x.quadra === l.quadra)
    if (q) {
      q.linhas.push(l)
      q.bags += l.bags
    } else b.quadras.push({ quadra: l.quadra, linhas: [l], bags: l.bags })
  }
  const lista = [...blocos.values()]
  for (const b of lista) b.quadras.sort((x, y) => ordenaQuadras(x.quadra, y.quadra))
  return lista.sort(
    (a, b) =>
      a.armazem.localeCompare(b.armazem, 'pt-BR') ||
      a.bloco.localeCompare(b.bloco, 'pt-BR', { numeric: true }),
  )
}

export interface TotaisEnderecamento {
  linhas: number
  lotes: number
  bags: number
  blocos: number
  /** Linhas na frente do seu bloco (posição 1). */
  faceis: number
  semEndereco: number
  semQuadra: number
}

export function totaisEnderecamento(linhas: LinhaRanqueada[]): TotaisEnderecamento {
  return {
    linhas: linhas.length,
    lotes: new Set(linhas.map((l) => l.lote)).size,
    bags: linhas.reduce((s, l) => s + l.bags, 0),
    blocos: new Set(linhas.filter((l) => l.enderecoCompleto).map(chaveBloco)).size,
    faceis: linhas.filter((l) => l.posicaoNoBloco === 1).length,
    semEndereco: linhas.filter((l) => !l.enderecoCompleto).length,
    semQuadra: linhas.filter((l) => l.enderecoCompleto && !ehQuadraNumerica(l.quadra)).length,
  }
}

// ---------------------------------------------------------------------------
// Foto guardada no navegador
// ---------------------------------------------------------------------------

/** Problema achado na planilha — vira lista de tarefa pra operação corrigir lá. */
export interface ProblemaPlanilha {
  lote: string
  motivo: string
}

export const VERSAO_FOTO = 1

export interface FotoEnderecamento {
  versao: number
  /** Invalida a foto sozinha se um dia a planilha mudar de endereço. */
  planilhaId: string
  buscadoEm: string
  posicoes: PosicaoPlanilha[]
  problemas: ProblemaPlanilha[]
}

const textoDe = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * Valida o que veio do armazenamento do navegador. Foto de outra versão ou
 * de outra planilha é descartada inteira; linha malformada é descartada
 * SOZINHA, sem levar junto as boas. Nunca lança.
 */
export function normalizarFoto(bruto: unknown, planilhaId: string): FotoEnderecamento | null {
  if (!bruto || typeof bruto !== 'object') return null
  const f = bruto as Record<string, unknown>
  if (f.versao !== VERSAO_FOTO) return null
  if (textoDe(f.planilhaId) !== planilhaId) return null
  if (!Array.isArray(f.posicoes)) return null

  const posicoes: PosicaoPlanilha[] = []
  for (const bru of f.posicoes) {
    if (!bru || typeof bru !== 'object') continue
    const p = bru as Record<string, unknown>
    const lote = textoDe(p.lote)
    const bags = typeof p.bags === 'number' && Number.isFinite(p.bags) ? p.bags : null
    if (!lote || bags == null) continue
    posicoes.push({
      lote,
      bags,
      tratamento: textoDe(p.tratamento),
      cultivar: textoDe(p.cultivar),
      classe: textoDe(p.classe),
      destinacao: textoDe(p.destinacao),
      status: textoDe(p.status),
      armazem: textoDe(p.armazem),
      bloco: textoDe(p.bloco),
      quadra: textoDe(p.quadra),
      data: textoDe(p.data),
      linhasSomadas: typeof p.linhasSomadas === 'number' ? p.linhasSomadas : 1,
    })
  }
  if (posicoes.length === 0) return null

  const problemas = Array.isArray(f.problemas)
    ? f.problemas
        .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
        .map((p) => ({ lote: textoDe(p.lote), motivo: textoDe(p.motivo) }))
        .filter((p) => p.motivo !== '')
    : []

  return {
    versao: VERSAO_FOTO,
    planilhaId,
    buscadoEm: textoDe(f.buscadoEm),
    posicoes,
    problemas,
  }
}
