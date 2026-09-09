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
