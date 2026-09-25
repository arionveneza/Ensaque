/**
 * Ficha de químicos da ordem (11/09/2026): o conteúdo VARIÁVEL que vai
 * impresso sobre o formulário pré-impresso da Veneza — o papel (212 × 320
 * mm) já traz logos, cabeçalhos verdes, grade e precauções; o app só
 * preenche as células. Desde 25/09/2026 há DOIS modelos de papel
 * (`ModeloFicha`): o novo, DEITADO (320 × 212 mm, logos e etiqueta à
 * esquerda, tabela à direita, linhas mais baixas e outra capacidade por
 * seção), e o antigo, em pé — cada um com o seu layout e o seu ajuste. Uma linha por produto POR CLASSE de princípio
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

export type CapacidadeFicha = Record<SecaoFicha | 'outros', number>

/**
 * Linhas de dados que o papel ANTIGO (em pé) tem em cada seção — quem estoura
 * vai pra OUTROS. Contadas pelo Arion na ficha real (12/09/2026): OUTROS tem 5
 * linhas, não as 7 que a foto sugeria.
 */
export const CAPACIDADE_FICHA: CapacidadeFicha = {
  inseticida: 2,
  fungicida: 2,
  nematicida: 1,
  inoculante: 1,
  outros: 5,
}

/** Papel pré-impresso em uso: o novo deitado (25/09/2026) ou o antigo em pé. */
export type ModeloFicha = 'paisagem' | 'retrato'

export const MODELO_FICHA_PADRAO: ModeloFicha = 'paisagem'

export const ROTULO_MODELO_FICHA: Record<ModeloFicha, string> = {
  paisagem: 'Nova (deitada)',
  retrato: 'Antiga (em pé)',
}

/** Uma coluna da tabela do papel: borda esquerda e largura, em mm. */
export interface ColunaFicha {
  left: number
  largura: number
}

/** Uma célula avulsa (Receita, Biológicos): canto superior esquerdo e tamanho, em mm. */
export interface CelulaFicha {
  left: number
  top: number
  largura: number
  altura: number
}

/**
 * Tudo o que muda de um papel pro outro. Posições em mm a partir do canto
 * superior esquerdo da folha, na orientação em que ela é lida.
 */
export interface LayoutFicha {
  pagina: { largura: number; altura: number }
  capacidade: CapacidadeFicha
  /** altura das linhas de DADOS de cada seção */
  altura: Record<SecaoFicha | 'outros', number>
  /** top da 1ª linha de dados de cada seção (logo abaixo do cabeçalho de colunas) */
  top: Record<SecaoFicha | 'outros', number>
  /** as 4 colunas das seções: PRODUTO, PRINCÍPIO ATIVO, CONCENTRAÇÃO, DOSAGEM */
  colunas: ColunaFicha[]
  /** as 3 colunas de OUTROS: PRODUTO, INFORMAÇÕES, DOSAGEM */
  colunasOutros: ColunaFicha[]
  /** null = o papel não tem campo pro nome do tratamento */
  receita: CelulaFicha | null
  biologicos: CelulaFicha
  /** canto superior esquerdo da etiqueta do lote (a imagem sai no tamanho real do PDF) */
  etiqueta: { left: number; top: number }
  /** tamanho suposto da etiqueta, só pra desenhar a guia do teste sem PDF carregado */
  etiquetaPadrao: { largura: number; altura: number }
  /** onde vai o texto de instrução no modo teste */
  nota: { left: number; top: number; largura: number }
}

const colunasUniformes = (esquerda: number, largura: number, n: number, deslocUltima: number): ColunaFicha[] =>
  Array.from({ length: n }, (_, c) => ({ left: esquerda + c * largura + (c === n - 1 ? deslocUltima : 0), largura }))

/**
 * Os dois papéis.
 *
 * RETRATO (antigo, 212 × 320 mm): calibrado com o "Teste de alinhamento" numa
 * ficha real em 9 rodadas (12/09/2026) — células de 9 mm, 48 mm de largura
 * (65 em OUTROS), a coluna DOSAGEM 1 cm à direita da grade uniforme, cada
 * seção com o seu top, e RECEITA/BIOLÓGICOS medidas uma a uma.
 *
 * PAISAGEM (novo, 320 × 212 mm — 25/09/2026, pedido do Arion: "a orientação
 * da ficha de TSI mudou"): medido na FOTO do papel novo, com correção de
 * perspectiva pelos 4 cantos da folha (homografia) e as linhas da grade achadas
 * pelos pixels — erro de ±2 mm, acerta-se pelo Teste de alinhamento + Ajuste
 * fino, como o antigo nasceu. Logos e o quadro da etiqueta (~103 × 70 mm, em
 * 12,6–116 × 95–165) à esquerda; tabela de 120,6 a 307,8 mm; colunas de
 * 49 · 49 · 49 · 40 mm (OUTROS: 49 · 75 · 63); linhas de dados de ~6,9 mm
 * (OUTROS ~5,5); BIOLÓGICO na 1ª linha da tabela (rótulo na 1ª coluna, valor
 * no resto); SEM campo de receita; 2 linhas em cada seção e 3 em OUTROS.
 */
export const LAYOUTS_FICHA: Record<ModeloFicha, LayoutFicha> = {
  paisagem: {
    pagina: { largura: 320, altura: 212 },
    capacidade: { inseticida: 2, fungicida: 2, nematicida: 2, inoculante: 2, outros: 3 },
    altura: { inseticida: 6.9, fungicida: 6.9, nematicida: 6.9, inoculante: 6.9, outros: 5.5 },
    top: { inseticida: 38.8, fungicida: 66.2, nematicida: 93, inoculante: 120.1, outros: 146.6 },
    colunas: [
      { left: 120.6, largura: 49.1 },
      { left: 169.7, largura: 49.3 },
      { left: 219, largura: 49.1 },
      { left: 268.1, largura: 39.7 },
    ],
    colunasOutros: [
      { left: 120.7, largura: 49.2 },
      { left: 169.9, largura: 75.1 },
      { left: 245, largura: 62.8 },
    ],
    receita: null,
    biologicos: { left: 169.7, top: 17.6, largura: 138.1, altura: 8.2 },
    etiqueta: { left: 14.5, top: 93.5 },
    etiquetaPadrao: { largura: 100, altura: 73 },
    nota: { left: 122, top: 3, largura: 186 },
  },
  retrato: {
    pagina: { largura: 212, altura: 320 },
    capacidade: CAPACIDADE_FICHA,
    altura: { inseticida: 9, fungicida: 9, nematicida: 9, inoculante: 9, outros: 9 },
    top: { inseticida: 116, fungicida: 151, nematicida: 184, inoculante: 211, outros: 240 },
    colunas: colunasUniformes(10, 48, 4, 10),
    colunasOutros: colunasUniformes(8.5, 65, 3, 10),
    receita: { left: 58, top: 90, largura: 48, altura: 9 },
    biologicos: { left: 164, top: 90, largura: 48, altura: 9 },
    etiqueta: { left: 10, top: 14 },
    etiquetaPadrao: { largura: 100, altura: 73 },
    nota: { left: 10, top: 300, largura: 192 },
  },
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

/** As linhas do painel que fazem sentido no papel (o novo não tem campo de receita). */
export const linhasAjusteDoModelo = (modelo: ModeloFicha) =>
  LINHAS_AJUSTE_FICHA.filter(({ chave }) => chave !== 'receita' || LAYOUTS_FICHA[modelo].receita !== null)

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

/** Soma o ajuste às posições padrão — pura, não muda o layout de entrada. */
export function aplicarAjusteFicha(layout: LayoutFicha, ajuste: AjusteFicha): LayoutFicha {
  const x = (c: ColunaFicha): ColunaFicha => ({ ...c, left: c.left + ajuste.x })
  return {
    ...layout,
    colunas: layout.colunas.map(x),
    colunasOutros: layout.colunasOutros.map(x),
    // a etiqueta acompanha o x geral (desvio da impressora) e ainda tem o seu próprio
    etiqueta: {
      left: layout.etiqueta.left + ajuste.x + ajuste.etiquetaX,
      top: layout.etiqueta.top + ajuste.etiqueta,
    },
    receita: layout.receita
      ? { ...layout.receita, left: layout.receita.left + ajuste.x, top: layout.receita.top + ajuste.receita }
      : null,
    biologicos: {
      ...layout.biologicos,
      left: layout.biologicos.left + ajuste.x,
      top: layout.biologicos.top + ajuste.biologicos,
    },
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

/** `capacidade`: linhas por seção do papel em uso (padrão: o antigo, em pé). */
export function montarFichaQuimicos(
  receita: string,
  itens: ItemFicha[],
  capacidade: CapacidadeFicha = CAPACIDADE_FICHA,
): FichaQuimicos {
  const ficha: FichaQuimicos = {
    receita,
    biologicos: 'NÃO',
    secoes: { inseticida: [], fungicida: [], nematicida: [], inoculante: [] },
    outros: [],
    naoCouberam: [],
    semPrincipio: [],
  }
  const paraOutros = (linha: LinhaOutros) => {
    if (ficha.outros.length < capacidade.outros) ficha.outros.push(linha)
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
      if (secao && ficha.secoes[secao].length < capacidade[secao]) {
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
