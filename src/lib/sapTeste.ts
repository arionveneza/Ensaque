/**
 * Helpers puros da aba "SAP (teste)" — separados da tela para ganharem teste
 * de unidade. A validação de caminho espelha a da Edge Function `sap-teste`:
 * recusar aqui dá feedback imediato, mas a barreira que vale é a de lá.
 */

/** Só quem está nesta lista vê a aba; a Edge Function usa a mesma. */
export const USUARIOS_SAP_TESTE = ['arion.pereira@sementesveneza.com.br']

/**
 * Feedback imediato na tela; a barreira que vale é a `resolveCaminho` da
 * Edge Function. Recusa `%` e `\` além de `..`: o parser de URL colapsa
 * `%2e%2e`/`\` em `..`, então checar só o literal deixaria escapar do
 * /b1s/v1 (o servidor recusa de novo, mas erra cedo é melhor).
 */
export function problemaNoCaminho(caminho: string): string | null {
  const c = caminho.trim()
  if (!c) return 'Informe o caminho OData.'
  if (c.includes('://')) return 'Só caminho relativo — sem http(s)://.'
  if (c.includes('..')) return 'Caminho não pode conter "..".'
  if (c.includes('%') || c.includes('\\')) return 'Sem "%" ou "\\" no caminho.'
  if (c.startsWith('/')) return 'Sem a barra inicial — ex.: Items?$top=1'
  if (!/^[A-Za-z$]/.test(c)) return 'O caminho começa com letra (ou $).'
  return null
}

export interface TabelaSap {
  colunas: string[]
  linhas: Record<string, unknown>[]
  /** true se houve mais colunas do que MAX_COLUNAS e o resto foi cortado. */
  colunasCortadas: boolean
}

/** Teto de colunas exibidas: `Orders` sem `$select` traz ~300 campos e
 *  renderizar todas trava a aba. O aviso na tela conta o corte. */
export const MAX_COLUNAS = 40

/**
 * Converte a resposta do Service Layer em linhas de tabela, quando ela tem
 * essa cara: coleção OData ({ value: [...] }) ou array puro. Resposta de
 * entidade única ou escalar devolve null — a tela mostra o JSON cru.
 *
 * As colunas são a UNIÃO das chaves de TODAS as linhas (consulta SQL omite
 * campo nulo em algumas linhas; olhar só as primeiras perderia colunas e a
 * coluna sumiria do CSV também). Metadados `odata.*` e propriedades de
 * navegação (arrays/objetos aninhados, ex.: DocumentLines) ficam de fora —
 * inchariam a tabela e a célula viraria um JSON gigante.
 */
export function tabelaDe(dados: unknown): TabelaSap | null {
  const corpo = dados as { value?: unknown } | null
  const lista = Array.isArray(dados)
    ? dados
    : Array.isArray(corpo?.value)
      ? corpo.value
      : null
  if (!lista) return null

  const linhas = lista.filter(
    (l): l is Record<string, unknown> => typeof l === 'object' && l !== null,
  )
  const todas: string[] = []
  for (const linha of linhas) {
    for (const [chave, valor] of Object.entries(linha)) {
      if (chave.startsWith('odata.')) continue
      // navegação aninhada (DocumentLines etc.) não vira coluna de tabela
      if (valor !== null && typeof valor === 'object') continue
      if (!todas.includes(chave)) todas.push(chave)
    }
  }
  const colunas = todas.slice(0, MAX_COLUNAS)
  return { colunas, linhas, colunasCortadas: todas.length > MAX_COLUNAS }
}

/** Tamanho máximo de uma célula renderizada — trava JSON/valor gigante. */
const MAX_CELULA = 200

/** Valor de célula legível: null vira travessão, objeto vira JSON, tudo
 *  truncado para não travar a renderização com um campo enorme. */
export function textoCelula(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v)
  return s.length > MAX_CELULA ? s.slice(0, MAX_CELULA) + '…' : s
}
