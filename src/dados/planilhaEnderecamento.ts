/**
 * Busca da planilha "Produção 2026" no Google (18/09/2026) — a ÚNICA casca
 * de rede da tela "Endereçamento planilha".
 *
 * O Google manda cabeçalhos CORS no export de planilha pública, então o
 * navegador do app baixa direto: sem Edge Function, sem proxy, sem tabela.
 * São duas requisições, e as duas foram medidas na produção:
 *
 *  1. `export?format=csv&range=A1:CZ12` → ~3 KB, o topo fiel da planilha.
 *     É dele que sai a linha do cabeçalho e o mapa nome → letra da coluna.
 *  2. `gviz/tq?tq=select <letras> where …` → ~87 KB, só as colunas e as
 *     linhas que interessam (o CSV inteiro tem 971 KB, peso demais pro
 *     tablet do galpão).
 *
 * O gviz NÃO serve para o passo 1: ele come as linhas do topo e desalinha o
 * cabeçalho. O export com `range` não serve para o passo 2: não filtra.
 *
 * O id da planilha fica aqui, à vista, e não numa variável `VITE_`: ela já é
 * pública por link, então não é segredo — e pôr em variável de ambiente daria
 * falsa sensação de proteção (CLAUDE.md §4.1).
 */

import {
  CAMPOS_PA,
  acharCabecalho,
  converterLinhas,
  montarConsulta,
  type Cabecalho,
  type Consulta,
} from '@/dominio/importacao/planilhaEnderecamento'
import { ehHtml, lerCsv } from '@/dominio/importacao/csv'
import type { PosicaoPlanilha, ProblemaPlanilha } from '@/dominio/enderecamento'

export const PLANILHA_ID = '1SgxRNKkhKYmgetndHNxf5Yb6f8e-uaLHqJVHX959sbM'
export const GID_LOTE_PA = '1062683801'
export const NOME_ABA = 'Lote PA'
export const URL_PLANILHA = `https://docs.google.com/spreadsheets/d/${PLANILHA_ID}/edit?gid=${GID_LOTE_PA}`

/** 12 linhas de folga: hoje o cabeçalho está na 5ª, e alguém pode inserir título em cima. */
export const urlCabecalho = (gid: string): string =>
  `https://docs.google.com/spreadsheets/d/${PLANILHA_ID}/export?format=csv&gid=${gid}&range=A1:CZ12`

export const urlConsulta = (gid: string, c: Consulta): string => {
  const tq = c.where ? `select ${c.select} where ${c.where}` : `select ${c.select}`
  return `https://docs.google.com/spreadsheets/d/${PLANILHA_ID}/gviz/tq?tqx=out:csv&gid=${gid}&headers=0&tq=${encodeURIComponent(tq)}`
}

export type MotivoFalha =
  | 'PLANILHA_FECHADA'
  | 'COLUNA_SUMIDA'
  | 'GOOGLE_FORA'
  | 'SEM_REDE'
  | 'DEMOROU'
  | 'VAZIO'

export class FalhaPlanilha extends Error {
  motivo: MotivoFalha
  constructor(motivo: MotivoFalha, mensagem: string) {
    super(mensagem)
    this.name = 'FalhaPlanilha'
    this.motivo = motivo
  }
}

const AVISO_COMPARTILHAR =
  'Se foi o compartilhamento: abra a planilha → Compartilhar → "qualquer pessoa com o link" → Leitor.'

/**
 * Traduz resposta ou exceção em motivo + mensagem pronta pro operador. O
 * caso mais comum e mais confuso é a planilha deixar de ser pública: o
 * Google redireciona pro login, e o navegador às vezes nem devolve resposta
 * (o redirecionamento não tem CORS) — por isso a mensagem cobre as duas
 * hipóteses em vez de chutar uma.
 */
export function classificarFalha(entrada: unknown): FalhaPlanilha {
  if (entrada instanceof FalhaPlanilha) return entrada

  if (typeof Response !== 'undefined' && entrada instanceof Response) {
    if (entrada.status === 401 || entrada.status === 403 || entrada.status === 404) {
      return new FalhaPlanilha(
        'PLANILHA_FECHADA',
        `O Google recusou a planilha (erro ${entrada.status}) — o compartilhamento por link deve ter sido desligado. ${AVISO_COMPARTILHAR}`,
      )
    }
    return new FalhaPlanilha(
      'GOOGLE_FORA',
      `O Google respondeu ${entrada.status} ao buscar a aba ${NOME_ABA}. Tente de novo em alguns minutos.`,
    )
  }

  const e = entrada as { name?: string; message?: string }
  if (e?.name === 'AbortError') {
    return new FalhaPlanilha(
      'DEMOROU',
      'O Google demorou mais de 20 segundos para responder. Toque em Atualizar para tentar de novo.',
    )
  }
  const semRede = typeof navigator !== 'undefined' && navigator.onLine === false
  if (semRede) {
    return new FalhaPlanilha('SEM_REDE', 'Sem internet. Volto a buscar quando a rede voltar.')
  }
  return new FalhaPlanilha(
    'PLANILHA_FECHADA',
    `Não consegui ler a planilha. Ou o compartilhamento por link foi desligado, ou a internet caiu. ${AVISO_COMPARTILHAR}`,
  )
}

async function baixarCsv(url: string, sinal: AbortSignal): Promise<string> {
  let resposta: Response
  try {
    resposta = await fetch(url, { signal: sinal, cache: 'no-store', redirect: 'follow' })
  } catch (e) {
    throw classificarFalha(e)
  }
  if (!resposta.ok) throw classificarFalha(resposta)
  const texto = await resposta.text()
  if (ehHtml(texto)) {
    throw new FalhaPlanilha(
      'PLANILHA_FECHADA',
      `A planilha não respondeu como planilha: veio uma página do Google no lugar dos dados. ${AVISO_COMPARTILHAR}`,
    )
  }
  return texto
}

export interface ResultadoBusca {
  posicoes: PosicaoPlanilha[]
  problemas: ProblemaPlanilha[]
  zeradas: number
  buscadoEm: string
  /** Onde estava o cabeçalho e o que ele trazia — só pra diagnóstico na tela. */
  cabecalho: Cabecalho
}

/** Corta a busca que não responde; 20 s é muito mais que os ~2 s medidos. */
const LIMITE_MS = 20_000

/**
 * Baixa e converte a aba Lote PA. `incluirZerados` traz também o lote com
 * saldo 0 (fora por padrão: já saiu do estoque, não está mais no galpão).
 */
export async function buscarLotePa(
  sinalExterno: AbortSignal,
  opcoes: { incluirZerados?: boolean } = {},
): Promise<ResultadoBusca> {
  const controle = new AbortController()
  const cancelar = () => controle.abort()
  sinalExterno.addEventListener('abort', cancelar)
  const relogio = setTimeout(() => controle.abort(), LIMITE_MS)

  try {
    const topo = lerCsv(await baixarCsv(urlCabecalho(GID_LOTE_PA), controle.signal))
    const cabecalho = acharCabecalho(topo, CAMPOS_PA)
    if (cabecalho.linha < 0 || cabecalho.faltando.length > 0) {
      const faltam = cabecalho.faltando.join(', ') || 'nenhuma coluna reconhecida'
      const achou = cabecalho.nomesVistos.slice(0, 12).join(', ')
      throw new FalhaPlanilha(
        'COLUNA_SUMIDA',
        `Não achei na aba ${NOME_ABA} a(s) coluna(s): ${faltam}. ` +
          (achou ? `O cabeçalho que encontrei traz: ${achou}…` : 'Não encontrei cabeçalho nenhum.') +
          ' Alguém renomeou ou moveu a coluna na planilha.',
      )
    }

    // O filtro fica só no `lote is not null`: cortar o saldo no servidor
    // economizaria 2 KB em 89 (medido), e em troca o lote zerado teria de
    // ser buscado de novo toda vez que alguém quisesse conferi-lo. Traz
    // tudo, e a tela esconde o zerado por padrão.
    const consulta = montarConsulta(cabecalho, { semFiltroSaldo: true })
    const csv = await baixarCsv(urlConsulta(GID_LOTE_PA, consulta), controle.signal)

    const { posicoes, problemas, zeradas } = converterLinhas(csv, consulta, {
      incluirZerados: true,
      ...opcoes,
    })
    if (posicoes.length === 0) {
      throw new FalhaPlanilha(
        'VAZIO',
        `A aba ${NOME_ABA} respondeu sem nenhuma linha com saldo. Ou zerou de verdade, ou a planilha mudou de forma.`,
      )
    }
    return { posicoes, problemas, zeradas, buscadoEm: new Date().toISOString(), cabecalho }
  } catch (e) {
    throw classificarFalha(e)
  } finally {
    clearTimeout(relogio)
    sinalExterno.removeEventListener('abort', cancelar)
  }
}
