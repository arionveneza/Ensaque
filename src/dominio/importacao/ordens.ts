/**
 * Importação de ordens por planilha.
 *
 * Diferente dos relatórios da SimpleAgro, aqui o formato é nosso: a planilha
 * vem do outro sistema de ordens, ou é digitada. Por isso o cabeçalho é
 * tolerante a acento, caixa e algumas variações de nome.
 */

import type { Linha } from './simpleagro'

export interface OrdemImportada {
  numero: string
  loteId: string
  tratamento: string
  embalagem: string
  bags: number
  cliente: string | null
  observacao: string | null
  /** Endereço de onde buscar o lote para esta ordem. */
  armazem: string | null
  bloco: string | null
  quadra: string | null
  maquinaId: string | null
  dataProg: string | null
}

export interface ProblemaImportacao {
  linha: number
  motivo: string
}

export interface ResultadoOrdens {
  ordens: OrdemImportada[]
  problemas: ProblemaImportacao[]
  /** Chaves repetidas dentro da própria planilha. */
  duplicadasNoArquivo: string[]
}

export interface ContextoImportacao {
  lotesConhecidos: Set<string>
  receitasConhecidas: Set<string>
  embalagensConhecidas: Set<string>
  maquinasConhecidas: Set<string>
}

const semAcento = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '')

const normaliza = (s: unknown) =>
  semAcento(String(s ?? '').trim().toLowerCase()).replace(/[^a-z0-9]/g, '')

/** Aceita variações comuns de nome de coluna. */
const SINONIMOS: Record<keyof OrdemImportada, string[]> = {
  numero: ['numero', 'ordem', 'numeroordem', 'nordem', 'pedido', 'op'],
  loteId: ['lote', 'loteid', 'lotesemente', 'numerolote'],
  tratamento: ['tratamento', 'receita', 'codigotratamento'],
  embalagem: ['embalagem', 'emb'],
  bags: ['bags', 'quantidade', 'qtd', 'qtdbags'],
  cliente: ['cliente'],
  observacao: ['observacao', 'obs', 'observacoes'],
  // o relatório de Saldos chama de ARMAZEM e ENDERECO (ex.: BL01-QD04);
  // aqui bloco e quadra são separados, mas os nomes da origem também valem
  armazem: ['armazem', 'deposito', 'armazenagem'],
  bloco: ['bloco', 'bl'],
  quadra: ['quadra', 'qd'],
  maquinaId: ['maquina', 'maquinaid', 'tsi'],
  dataProg: ['dia', 'data', 'dataprog', 'dataprogramacao'],
}

function acharColunas(cabecalho: Linha): Partial<Record<keyof OrdemImportada, number>> {
  const normalizado = cabecalho.map(normaliza)
  const mapa: Partial<Record<keyof OrdemImportada, number>> = {}
  for (const campo of Object.keys(SINONIMOS) as (keyof OrdemImportada)[]) {
    const idx = normalizado.findIndex((c) => SINONIMOS[campo].includes(c))
    if (idx >= 0) mapa[campo] = idx
  }
  return mapa
}

export function ehPlanilhaDeOrdens(rows: Linha[]): boolean {
  const cols = acharColunas(rows[0] ?? [])
  // exige ao menos o mínimo para montar uma ordem
  return (
    cols.numero != null && cols.loteId != null && cols.bags != null && cols.tratamento != null
  )
}

const texto = (v: unknown) => String(v ?? '').trim()

/** Aceita 2026-07-28, 28/07/2026 e a Date que o leitor de xlsx devolve. */
function dataIso(v: unknown): string | null {
  if (v == null || v === '') return null
  if (v instanceof Date) {
    return [
      v.getFullYear(),
      String(v.getMonth() + 1).padStart(2, '0'),
      String(v.getDate()).padStart(2, '0'),
    ].join('-')
  }
  const s = texto(v)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (br) return `${br[3]}-${br[2]}-${br[1]}`
  return null
}

export function converterOrdens(rows: Linha[], ctx: ContextoImportacao): ResultadoOrdens {
  const cols = acharColunas(rows[0] ?? [])
  const ordens: OrdemImportada[] = []
  const problemas: ProblemaImportacao[] = []
  const vistas = new Set<string>()
  const duplicadasNoArquivo: string[] = []

  rows.slice(1).forEach((r, i) => {
    const numeroLinha = i + 2 // 1-based, contando o cabeçalho
    const erros: string[] = []

    const numero = texto(r[cols.numero!])
    const loteId = texto(r[cols.loteId!])
    const tratamento = texto(r[cols.tratamento!])
    const embalagem = texto(cols.embalagem != null ? r[cols.embalagem] : '').toUpperCase()
    const bagsBruto = texto(r[cols.bags!]).replace(',', '.')
    const bags = Number(bagsBruto)

    // linha totalmente vazia é fim de planilha, não erro
    if (!numero && !loteId && !tratamento && !bagsBruto) return

    if (!numero) erros.push('sem número de ordem')
    if (!loteId) erros.push('sem lote')
    else if (!ctx.lotesConhecidos.has(loteId)) erros.push(`lote ${loteId} não cadastrado`)

    if (!tratamento) erros.push('sem tratamento')
    else if (!ctx.receitasConhecidas.has(tratamento.toUpperCase())) {
      erros.push(`tratamento ${tratamento} sem receita cadastrada`)
    }

    if (!embalagem) erros.push('sem embalagem')
    else if (!ctx.embalagensConhecidas.has(embalagem)) {
      erros.push(`embalagem ${embalagem} desconhecida`)
    }

    if (!Number.isFinite(bags) || bags <= 0) erros.push('bags precisa ser maior que zero')

    const maquinaTexto = texto(cols.maquinaId != null ? r[cols.maquinaId] : '')
    let maquinaId: string | null = null
    if (maquinaTexto) {
      const achada = [...ctx.maquinasConhecidas].find(
        (m) => normaliza(m) === normaliza(maquinaTexto),
      )
      if (achada) maquinaId = achada
      else erros.push(`máquina ${maquinaTexto} desconhecida`)
    }

    const diaTexto = cols.dataProg != null ? r[cols.dataProg] : null
    const dataProg = dataIso(diaTexto)
    if (diaTexto && !dataProg) erros.push(`data "${texto(diaTexto)}" não reconhecida`)

    if (erros.length > 0) {
      problemas.push({ linha: numeroLinha, motivo: erros.join(' · ') })
      return
    }

    // mesma chave anti-duplicidade da ordem
    const chave = [numero, loteId, tratamento.toUpperCase(), embalagem].join('|')
    if (vistas.has(chave)) {
      duplicadasNoArquivo.push(`linha ${numeroLinha}: ${numero}`)
      return
    }
    vistas.add(chave)

    // endereço é livre e opcional: a logística pode preencher depois
    const opcional = (idx: number | undefined) =>
      texto(idx != null ? r[idx] : '').toUpperCase() || null

    ordens.push({
      numero,
      loteId,
      tratamento,
      embalagem,
      bags,
      cliente: texto(cols.cliente != null ? r[cols.cliente] : '') || null,
      observacao: texto(cols.observacao != null ? r[cols.observacao] : '') || null,
      armazem: opcional(cols.armazem),
      bloco: opcional(cols.bloco),
      quadra: opcional(cols.quadra),
      maquinaId,
      dataProg,
    })
  })

  return { ordens, problemas, duplicadasNoArquivo }
}
