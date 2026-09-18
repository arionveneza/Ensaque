/**
 * Ficha de químicos da ordem (11/09/2026): o conteúdo VARIÁVEL que vai
 * impresso sobre o formulário pré-impresso da Veneza — o papel (212 × 320
 * mm) já traz logos, cabeçalhos verdes, grade e precauções; o app só
 * preenche as células. Uma linha por produto POR CLASSE de princípio
 * ativo: produto que junta fungicida e inseticida sai nas duas seções,
 * cada uma com os princípios daquela classe. Dosagem sempre na base de
 * 100 kg de semente (decisão do Arion). Função pura — testável sem banco.
 */

import { baseDoseKg } from './calculos'
import type { ClasseAgronomica, UnidadeDose } from './tipos'

export interface PrincipioFicha {
  nome: string
  concentracao: number | null
  unidadeConc: 'g/L' | 'g/kg' | '%'
  classe: ClasseAgronomica
}

export interface ItemFicha {
  /** Nome comercial do produto — o que sai na coluna PRODUTO. */
  produto: string
  unidade: UnidadeDose
  dose: number
  principios: PrincipioFicha[]
}

export interface LinhaFicha {
  produto: string
  principio: string
  concentracao: string
  dosagem: string
}

export interface LinhaOutros {
  produto: string
  informacoes: string
  dosagem: string
}

export type SecaoFicha = 'inseticida' | 'fungicida' | 'nematicida' | 'inoculante'

export const SECOES_FICHA: SecaoFicha[] = ['inseticida', 'fungicida', 'nematicida', 'inoculante']

/**
 * Linhas de dados que o PAPEL tem em cada seção — quem estoura vai pra
 * OUTROS. Contadas pelo Arion na ficha real (12/09/2026): OUTROS tem 5
 * linhas, não as 7 que a foto sugeria.
 */
export const CAPACIDADE_FICHA: Record<SecaoFicha | 'outros', number> = {
  inseticida: 2,
  fungicida: 2,
  nematicida: 1,
  inoculante: 1,
  outros: 5,
}

/**
 * Ajuste fino POR IMPRESSORA (12/09/2026): deslocamentos em mm somados às
 * posições padrão da ficha — vertical por seção (positivo = mais pra
 * baixo) e um horizontal geral (positivo = mais pra direita). Fica salvo
 * no navegador de cada computador, então cada impressora tem o seu, e o
 * operador acerta sozinho, sem publicar nada.
 */
export interface AjusteFicha {
  x: number
  /** etiqueta do lote (17/09/2026): vertical e horizontal próprios, além do x geral */
  etiqueta: number
  etiquetaX: number
  receita: number
  biologicos: number
  inseticida: number
  fungicida: number
  nematicida: number
  inoculante: number
  outros: number
}

export const AJUSTE_FICHA_ZERO: AjusteFicha = {
  x: 0, etiqueta: 0, etiquetaX: 0, receita: 0, biologicos: 0, inseticida: 0, fungicida: 0, nematicida: 0, inoculante: 0, outros: 0,
}

/** Ordem e rótulo das linhas do painel de ajuste. */
export const LINHAS_AJUSTE_FICHA: { chave: keyof AjusteFicha; rotulo: string }[] = [
  { chave: 'etiqueta', rotulo: 'Etiqueta do lote (vertical)' },
  { chave: 'etiquetaX', rotulo: 'Etiqueta do lote (horizontal)' },
  { chave: 'receita', rotulo: 'Receita (nome do tratamento)' },
  { chave: 'biologicos', rotulo: 'Biológicos (SIM/NÃO)' },
  { chave: 'inseticida', rotulo: 'Inseticida' },
  { chave: 'fungicida', rotulo: 'Fungicida' },
  { chave: 'nematicida', rotulo: 'Nematicida' },
  { chave: 'inoculante', rotulo: 'Inoculante' },
  { chave: 'outros', rotulo: 'Outros produtos' },
  { chave: 'x', rotulo: 'Tudo na horizontal' },
]

/** Chaves que deslocam na HORIZONTAL (setas ◂▸ no painel); as demais são verticais. */
export const AJUSTES_HORIZONTAIS: ReadonlySet<keyof AjusteFicha> = new Set<keyof AjusteFicha>(['x', 'etiquetaX'])

/** Mais que isso é erro de digitação, não calibração. */
export const LIMITE_AJUSTE_MM = 30

const limita = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.max(-LIMITE_AJUSTE_MM, Math.min(LIMITE_AJUSTE_MM, Math.round(n)))
}

/** Valida o que veio do armazenamento: campo faltando ou lixo vira 0, excesso é limitado. */
export function normalizarAjusteFicha(bruto: unknown): AjusteFicha {
  const o = (bruto && typeof bruto === 'object' ? bruto : {}) as Record<string, unknown>
  const saida = { ...AJUSTE_FICHA_ZERO }
  for (const chave of Object.keys(AJUSTE_FICHA_ZERO) as (keyof AjusteFicha)[]) {
    saida[chave] = limita(o[chave])
  }
  return saida
}

interface LayoutAjustavel {
  esquerda: number
  esquerdaOutros: number
  etiqueta: { left: number; top: number }
  receita: { left: number; top: number }
  biologicos: { left: number; top: number }
  top: Record<SecaoFicha | 'outros', number>
}

/** Soma o ajuste às posições padrão — pura, não muda o layout de entrada. */
export function aplicarAjusteFicha<L extends LayoutAjustavel>(layout: L, ajuste: AjusteFicha): L {
  return {
    ...layout,
    esquerda: layout.esquerda + ajuste.x,
    esquerdaOutros: layout.esquerdaOutros + ajuste.x,
    // a etiqueta acompanha o x geral (desvio da impressora) e ainda tem o seu próprio
    etiqueta: {
      left: layout.etiqueta.left + ajuste.x + ajuste.etiquetaX,
      top: layout.etiqueta.top + ajuste.etiqueta,
    },
    receita: { left: layout.receita.left + ajuste.x, top: layout.receita.top + ajuste.receita },
    biologicos: { left: layout.biologicos.left + ajuste.x, top: layout.biologicos.top + ajuste.biologicos },
    top: {
      inseticida: layout.top.inseticida + ajuste.inseticida,
      fungicida: layout.top.fungicida + ajuste.fungicida,
      nematicida: layout.top.nematicida + ajuste.nematicida,
      inoculante: layout.top.inoculante + ajuste.inoculante,
      outros: layout.top.outros + ajuste.outros,
    },
  }
}

export interface FichaQuimicos {
  receita: string
  /** SIM quando algum princípio da receita é de classe Biologico. */
  biologicos: 'SIM' | 'NÃO'
  secoes: Record<SecaoFicha, LinhaFicha[]>
  outros: LinhaOutros[]
  /** Não couberam nem em OUTROS — a tela avisa antes de imprimir. */
  naoCouberam: string[]
  /** Sem princípio ativo cadastrado — saem em OUTROS sem informação; avisar. */
  semPrincipio: string[]
}

const SECAO_DA_CLASSE: Partial<Record<ClasseAgronomica, SecaoFicha>> = {
  Inseticida: 'inseticida',
  Fungicida: 'fungicida',
  Nematicida: 'nematicida',
  Inoculante: 'inoculante',
}

const ROTULO_CLASSE: Record<ClasseAgronomica, string> = {
  Fungicida: 'Fungicida',
  Inseticida: 'Inseticida',
  Biologico: 'Biológico',
  Nematicida: 'Nematicida',
  Inoculante: 'Inoculante',
  Outros: '',
}

const fmt = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 2 })

/** Dose da receita na base de 100 kg de semente: "200 mL/100 kg", "150 g/100 kg". */
export function doseFicha(dose: number, unidade: UnidadeDose): string {
  const por100 = dose * (100 / baseDoseKg(unidade))
  const un = unidade.startsWith('ml') ? 'mL' : 'g'
  return `${fmt(por100)} ${un}/100 kg`
}

/** "25 + 10 g/L" quando a unidade é a mesma; senão cada concentração com a sua. */
export function concentracaoFicha(ps: PrincipioFicha[]): string {
  const com = ps.filter((p) => p.concentracao != null)
  if (com.length === 0) return ''
  const unidades = new Set(com.map((p) => p.unidadeConc))
  if (unidades.size === 1) {
    return `${com.map((p) => fmt(p.concentracao!)).join(' + ')} ${com[0].unidadeConc}`
  }
  return com.map((p) => `${fmt(p.concentracao!)} ${p.unidadeConc}`).join(' + ')
}

export function montarFichaQuimicos(receita: string, itens: ItemFicha[]): FichaQuimicos {
  const ficha: FichaQuimicos = {
    receita,
    biologicos: 'NÃO',
    secoes: { inseticida: [], fungicida: [], nematicida: [], inoculante: [] },
    outros: [],
    naoCouberam: [],
    semPrincipio: [],
  }
  const paraOutros = (linha: LinhaOutros) => {
    if (ficha.outros.length < CAPACIDADE_FICHA.outros) ficha.outros.push(linha)
    else if (!ficha.naoCouberam.includes(linha.produto)) ficha.naoCouberam.push(linha.produto)
  }

  for (const item of itens) {
    const dosagem = doseFicha(item.dose, item.unidade)
    if (item.principios.length === 0) {
      ficha.semPrincipio.push(item.produto)
      paraOutros({ produto: item.produto, informacoes: '', dosagem })
      continue
    }
    // agrupa por classe, na ordem em que as classes aparecem no cadastro
    const porClasse = new Map<ClasseAgronomica, PrincipioFicha[]>()
    for (const p of item.principios) porClasse.set(p.classe, [...(porClasse.get(p.classe) ?? []), p])

    for (const [classe, ps] of porClasse) {
      const principio = ps.map((p) => p.nome).join(' + ')
      const concentracao = concentracaoFicha(ps)
      // Inoculante é biológico por natureza (Bradyrhizobium) e continua
      // na seção INOCULANTE do papel — decisão do Arion (12/09/2026): só o
      // Rizoliq marca SIM; nematicida biológico (Lumialza, Votivo) fica
      // como Nematicida e NÃO marca.
      if (classe === 'Biologico' || classe === 'Inoculante') ficha.biologicos = 'SIM'

      const secao = SECAO_DA_CLASSE[classe]
      if (secao && ficha.secoes[secao].length < CAPACIDADE_FICHA[secao]) {
        ficha.secoes[secao].push({ produto: item.produto, principio, concentracao, dosagem })
        continue
      }
      // Outros e Biológico não têm seção própria no papel; o que estourou
      // a seção também vem pra cá, levando a classe na coluna INFORMAÇÕES
      const informacoes = [ROTULO_CLASSE[classe], [principio, concentracao].filter(Boolean).join(' ')]
        .filter(Boolean)
        .join(' · ')
      paraOutros({ produto: item.produto, informacoes, dosagem })
    }
  }
  return ficha
}

// ---------------------------------------------------------------------------
// Etiqueta do lote na ficha (17/09/2026, pedido do Arion: "imprimir a etiqueta
// do lote na ficha de tratamento; vou fazer o upload da etiqueta em PDF, e ela
// deve ficar no espaço acima e à esquerda destinado à etiqueta"). O PDF vem do
// SimpleAgro (JasperReports): página de 207 × 283 pt com /Rotate 90 — o pdf.js
// já aplica o giro e ela sai deitada, 99,8 × 73 mm, como a etiqueta física. O app
// rasteriza a 1ª página no navegador (pdf.js) e imprime a imagem no tamanho
// REAL do PDF, no canto reservado da ficha. Aqui só o que é puro.
// ---------------------------------------------------------------------------

export type RotacaoEtiqueta = 0 | 90 | 180 | 270

/** Imagem já rasterizada da etiqueta, pronta pra ir na ficha. */
export interface EtiquetaFicha {
  /** PNG em data URL. */
  dataUrl: string
  /** Tamanho REAL da página (já girada), em mm — a imagem sai nesse tamanho no papel. */
  larguraMm: number
  alturaMm: number
  /** Giro aplicado sobre a página (o operador pode girar mais no menu). */
  rotacao: RotacaoEtiqueta
  nome: string
}

/** Pontos PDF (1/72") → mm, com 1 casa. */
export const mmDePontos = (pt: number): number => Math.round((pt * 25.4) / 72 * 10) / 10

/**
 * Rede pra PDF que ainda saia "de pé" (mais alto que largo) depois do /Rotate
 * da página: girar 90° no sentido horário o deita no formato físico. A
 * etiqueta do SimpleAgro já vem deitada pelo /Rotate 90 e não gira aqui.
 */
export const rotacaoSugeridaEtiqueta = (larguraPt: number, alturaPt: number): RotacaoEtiqueta =>
  alturaPt > larguraPt ? 90 : 0

export const proximaRotacao = (r: RotacaoEtiqueta): RotacaoEtiqueta => (((r + 90) % 360) as RotacaoEtiqueta)
