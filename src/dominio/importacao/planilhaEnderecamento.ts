/**
 * Leitura da planilha "Produção 2026" (aba Lote PA) — 18/09/2026.
 *
 * A planilha é mantida à mão pela operação e muda de forma: já tem coluna
 * repetida (`AZ` aparece 3 vezes, por causa das colunas auxiliares de
 * fórmula), bloco escrito de dois jeitos (`5D` e `05D`), célula com `#REF!`
 * e linha sem data. Por isso a coluna é achada **pelo nome**, nunca pela
 * letra — a mesma lição das planilhas da SimpleAgro (CLAUDE.md §4) — e a
 * linha do cabeçalho é DESCOBERTA, não fixa.
 */

import { lerCsv, ehCelulaErro } from './csv'
import { normaliza, num, txt } from './simpleagro'
import { normalizaBloco, type PosicaoPlanilha, type ProblemaPlanilha } from '../enderecamento'

export type CampoPlanilha =
  | 'data'
  | 'destinacao'
  | 'tratamento'
  | 'cultivar'
  | 'lote'
  | 'classe'
  | 'status'
  | 'armazem'
  | 'bloco'
  | 'quadra'
  | 'bags'

export interface DefinicaoCampo {
  campo: CampoPlanilha
  /** Nomes aceitos, já normalizados (sem acento, caixa alta). */
  nomes: string[]
  obrigatorio: boolean
}

/** Aba "Lote PA": produto acabado, o único com bloco e quadra de verdade. */
export const CAMPOS_PA: DefinicaoCampo[] = [
  { campo: 'lote', nomes: ['LOTES', 'LOTE'], obrigatorio: true },
  { campo: 'bags', nomes: ['SALDO'], obrigatorio: true },
  { campo: 'armazem', nomes: ['AZ', 'ARMAZEM'], obrigatorio: true },
  { campo: 'bloco', nomes: ['BLOCO'], obrigatorio: true },
  { campo: 'quadra', nomes: ['QUADRA'], obrigatorio: true },
  { campo: 'cultivar', nomes: ['CULTIVAR'], obrigatorio: false },
  { campo: 'tratamento', nomes: ['TRATAMENTO'], obrigatorio: false },
  { campo: 'classe', nomes: ['CLASSE'], obrigatorio: false },
  { campo: 'status', nomes: ['STATUS'], obrigatorio: false },
  { campo: 'destinacao', nomes: ['DESTINACAO DO LOTE', 'DESTINACAO'], obrigatorio: false },
  { campo: 'data', nomes: ['DATA'], obrigatorio: false },
]

export interface Cabecalho {
  /** Índice 0-based da linha do cabeçalho dentro do trecho lido. -1 = não achou. */
  linha: number
  /** campo → índice da coluna (PRIMEIRA ocorrência do nome). */
  colunas: Partial<Record<CampoPlanilha, number>>
  /** Obrigatórios que não apareceram — a mensagem de erro nomeia cada um. */
  faltando: CampoPlanilha[]
  /** O que o cabeçalho traz, pra mensagem de erro dizer o que ACHOU. */
  nomesVistos: string[]
}

/** 0 → 'A', 25 → 'Z', 26 → 'AA', 51 → 'AZ', 52 → 'BA'. */
export function letraDaColuna(i: number): string {
  let s = ''
  let n = i
  do {
    s = String.fromCharCode(65 + (n % 26)) + s
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return s
}

/**
 * Acha a linha do cabeçalho pontuando cada linha pelo nº de campos que
 * reconhece — a da PA é a 5ª hoje, mas basta alguém inserir um título em
 * cima pra mudar. Nome repetido: vence a PRIMEIRA ocorrência, senão `AZ`
 * casaria com uma coluna auxiliar de fórmula e o endereço inteiro sairia
 * errado, calado.
 */
export function acharCabecalho(linhas: string[][], campos: DefinicaoCampo[]): Cabecalho {
  let melhor: Cabecalho = { linha: -1, colunas: {}, faltando: [], nomesVistos: [] }
  let melhorPontos = 0

  for (let i = 0; i < linhas.length; i++) {
    const cruas = linhas[i].map((c) => txt(c))
    const celulas = cruas.map((c) => normaliza(c))
    const colunas: Partial<Record<CampoPlanilha, number>> = {}
    for (const def of campos) {
      for (const nome of def.nomes) {
        // exato primeiro, depois normalizado: as colunas de dado são MAIÚSCULAS
        // (`SALDO`, coluna AA) e as auxiliares de fórmula são minúsculas
        // (`saldo`, coluna AL). Sem essa precedência, renomear a de dado fazia
        // a auxiliar assumir o lugar em silêncio — e o saldo inteiro saía errado.
        const idx = cruas.indexOf(nome) >= 0 ? cruas.indexOf(nome) : celulas.indexOf(nome)
        if (idx >= 0) {
          colunas[def.campo] = idx
          break
        }
      }
    }
    const pontos = Object.keys(colunas).length
    if (pontos > melhorPontos) {
      melhorPontos = pontos
      melhor = {
        linha: i,
        colunas,
        faltando: campos.filter((d) => d.obrigatorio && colunas[d.campo] == null).map((d) => d.campo),
        nomesVistos: linhas[i].map((c) => txt(c)).filter((c) => c !== ''),
      }
    }
  }
  return melhor
}

export interface Consulta {
  /** "A,C,D,F,H,I,M,N,O,P,AA" — na ordem de `ordem`. */
  select: string
  where: string
  /** Qual campo está em cada coluna do resultado. */
  ordem: CampoPlanilha[]
}

/**
 * Monta a consulta do gviz a partir das letras descobertas. `semFiltroSaldo`
 * é a segunda tentativa: se a coluna de saldo tiver texto em alguma linha, o
 * Google recusa o `> 0` e aí filtramos no cliente.
 */
export function montarConsulta(cab: Cabecalho, opcoes: { semFiltroSaldo?: boolean } = {}): Consulta {
  const ordem = (Object.keys(cab.colunas) as CampoPlanilha[]).sort(
    (a, b) => (cab.colunas[a] ?? 0) - (cab.colunas[b] ?? 0),
  )
  const select = ordem.map((c) => letraDaColuna(cab.colunas[c] as number)).join(',')
  const lote = cab.colunas.lote != null ? letraDaColuna(cab.colunas.lote) : null
  const bags = cab.colunas.bags != null ? letraDaColuna(cab.colunas.bags) : null
  const partes: string[] = []
  if (lote) partes.push(`${lote} is not null`)
  if (bags && !opcoes.semFiltroSaldo) partes.push(`${bags} > 0`)
  return { select, where: partes.join(' and '), ordem }
}

export interface Conversao {
  posicoes: PosicaoPlanilha[]
  problemas: ProblemaPlanilha[]
  /** Linhas com lote mas sem saldo — ficam fora por padrão (já saíram do estoque). */
  zeradas: number
}

const chaveLinha = (p: PosicaoPlanilha) =>
  `${p.lote}|${p.tratamento}|${p.armazem}|${p.bloco}|${p.quadra}`

/**
 * Converte o CSV de dados (na ordem de `consulta.ordem`) em posições.
 *
 * Filtra por **lote preenchido e saldo**, NUNCA por data: a coluna DATA vem
 * vazia em algumas linhas, e exigir data escondeu 3 lotes com saldo do
 * primeiro relatório que o Arion recebeu (18/09/2026).
 */
export function converterLinhas(
  csv: string,
  consulta: Consulta,
  opcoes: { incluirZerados?: boolean } = {},
): Conversao {
  const linhas = lerCsv(csv)
  const problemas: ProblemaPlanilha[] = []
  const porChave = new Map<string, PosicaoPlanilha>()
  let zeradas = 0

  const valor = (linha: string[], campo: CampoPlanilha): string => {
    const i = consulta.ordem.indexOf(campo)
    if (i < 0) return ''
    const bruto = txt(linha[i])
    return ehCelulaErro(bruto) ? '' : bruto
  }

  for (const linha of linhas) {
    const lote = valor(linha, 'lote')
    if (!lote) continue

    const iBags = consulta.ordem.indexOf('bags')
    const bagsBruto = iBags >= 0 ? txt(linha[iBags]) : ''
    if (ehCelulaErro(bagsBruto)) {
      problemas.push({ lote, motivo: `saldo ilegível na planilha (${bagsBruto})` })
      continue
    }
    const bags = num(bagsBruto)
    if (bags <= 0) {
      zeradas++
      if (!opcoes.incluirZerados) continue
    }

    const posicao: PosicaoPlanilha = {
      lote,
      bags,
      tratamento: valor(linha, 'tratamento'),
      cultivar: valor(linha, 'cultivar').replace(/\s+/g, ' '),
      classe: valor(linha, 'classe'),
      destinacao: valor(linha, 'destinacao'),
      status: valor(linha, 'status'),
      armazem: valor(linha, 'armazem').toUpperCase(),
      bloco: normalizaBloco(valor(linha, 'bloco')),
      quadra: valor(linha, 'quadra').toUpperCase(),
      data: valor(linha, 'data'),
      linhasSomadas: 1,
    }

    // a mesma linha repetida na planilha: soma os bags, não duplica a posição
    const k = chaveLinha(posicao)
    const jaTem = porChave.get(k)
    if (jaTem) {
      jaTem.bags += posicao.bags
      jaTem.linhasSomadas++
      problemas.push({ lote, motivo: `linha repetida na planilha (${jaTem.linhasSomadas}×) — bags somados` })
    } else porChave.set(k, posicao)
  }

  const posicoes = [...porChave.values()]
  for (const p of posicoes) {
    const falta = [
      p.armazem === '' && 'armazém',
      p.bloco === '' && 'bloco',
      p.quadra === '' && 'quadra',
    ].filter(Boolean)
    if (falta.length > 0) problemas.push({ lote: p.lote, motivo: `sem ${falta.join(' e ')} na planilha` })
    else if (!/^\d+$/.test(p.quadra)) {
      problemas.push({ lote: p.lote, motivo: `quadra "${p.quadra}" não é número — fica fora do ranking` })
    }
  }

  return { posicoes, problemas, zeradas }
}
