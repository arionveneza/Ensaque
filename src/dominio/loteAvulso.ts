/**
 * Lote AVULSO (12/10/2026, pedido do Arion: "preciso, na tela de ordem de
 * produção, poder criar ordens com lotes que não estão no SAP; colocar todas
 * as informações de forma avulsa, mas de maneira que não gere confusão com o
 * sistema atual").
 *
 * É um lote de semente branca fora do SAP, digitado no formulário da ordem e
 * gravado em lotes_semente com origem_manual (a mesma marca do cadastro
 * manual). Para não confundir: número que já existe é recusado (escolhe-se
 * da lista); o cultivar é comparado com os nomes que o sistema já conhece
 * (grafia diferente quebra o balanço — "751 CE" ≠ "NEO751 CE"); o PMS é
 * sempre gravado, derivado do peso do bag quando não vem (sem ele, ordem
 * MEIOBAG do lote usaria o peso do bag inteiro). Puro.
 */

import { normalizaCultivar } from './importacao/simpleagro'

/** Embalagem em que o lote está fisicamente — define o peso do bag (PMS × fator). */
export const EMBALAGENS_LOTE_AVULSO = [
  { codigo: 'BB5M', rotulo: 'Bag 5 milhões (BB5M)', fator: 5 },
  { codigo: 'BMB', rotulo: 'Meio bag (BMB)', fator: 2.5 },
  { codigo: 'SC200MS', rotulo: 'Saco 200 mil (SC200MS)', fator: 0.2 },
] as const

export interface LoteAvulsoDigitado {
  id: string
  cultivar: string
  /** Código de EMBALAGENS_LOTE_AVULSO. */
  embalagem: string
  pms: string
  /** Em branco = PMS × fator. */
  pesoBag: string
  bags: string
}

export interface LoteAvulsoGravavel {
  id: string
  cultivar: string
  tratamento: 'SEM TSI'
  pms: number
  peso_bag_kg: number
  bags_disp: number
}

const numero = (s: string) => {
  const t = s.trim().replace(',', '.')
  return t === '' ? null : Number(t)
}

/** Nº do lote como fica gravado: sem espaço nas pontas, caixa alta. */
export const normalizaIdLote = (s: string) => s.trim().toUpperCase()

/** Mesma regra do importador do SAP: inteiro em bag/meio-bag, 2 casas no saco pequeno. */
const pesoDoBag = (pms: number, fator: number) =>
  fator >= 1 ? Math.round(pms * fator) : Math.round(pms * fator * 100) / 100

/**
 * Valida o que foi digitado contra os lotes e cultivares que o sistema já
 * conhece. `erros` bloqueiam a gravação; `avisos` só alertam.
 */
export function validarLoteAvulso(
  d: LoteAvulsoDigitado,
  existentes: { id: string; origem_manual?: boolean }[],
  cultivaresConhecidos: string[],
): { lote: LoteAvulsoGravavel | null; erros: string[]; avisos: string[] } {
  const erros: string[] = []
  const avisos: string[] = []

  const id = normalizaIdLote(d.id)
  if (!id) erros.push('informe o nº do lote')
  else if (!/^[A-Z0-9][A-Z0-9./-]*$/.test(id))
    erros.push('nº do lote só com letras, números, ponto, barra ou hífen (sem espaço)')
  else {
    const ja = existentes.find((l) => normalizaIdLote(l.id) === id)
    if (ja)
      erros.push(
        ja.origem_manual
          ? `o lote ${id} já foi criado como avulso — escolha ele na lista`
          : `o lote ${id} já existe no saldo do SAP — escolha ele na lista`,
      )
  }

  const cultivar = normalizaCultivar(d.cultivar)
  if (!cultivar) erros.push('informe o cultivar')
  else if (
    cultivaresConhecidos.length > 0 &&
    !cultivaresConhecidos.some((c) => normalizaCultivar(c) === cultivar)
  )
    avisos.push(
      `o cultivar "${cultivar}" não aparece em nenhum lote nem pedido — confira a grafia ` +
        '(o balanço só casa com o nome igual ao do pedido)',
    )

  const emb = EMBALAGENS_LOTE_AVULSO.find((e) => e.codigo === d.embalagem)
  if (!emb) erros.push('escolha a embalagem do lote')

  const pmsDigitado = numero(d.pms)
  const pesoDigitado = numero(d.pesoBag)
  if (pmsDigitado != null && !(pmsDigitado > 0 && pmsDigitado < 1000))
    erros.push('PMS inválido (gramas por mil sementes, entre 1 e 999)')
  if (pesoDigitado != null && !(pesoDigitado > 0))
    erros.push('peso do bag inválido')
  if (pmsDigitado == null && pesoDigitado == null) erros.push('informe o PMS ou o peso do bag')

  const bags = numero(d.bags)
  if (bags == null) erros.push('informe quantos bags o lote tem')
  else if (!(bags > 0)) erros.push('a quantidade de bags do lote tem de ser maior que zero')

  let pms: number | null = null
  let peso: number | null = null
  if (emb && erros.length === 0) {
    if (pesoDigitado != null) {
      peso = pesoDigitado
      // PMS digitado manda; sem ele, sai do peso (a mesma rede do Peso Bruto)
      pms = pmsDigitado ?? Math.round((pesoDigitado / emb.fator) * 1000) / 1000
      if (pmsDigitado != null) {
        const esperado = pmsDigitado * emb.fator
        if (Math.abs(esperado - pesoDigitado) / esperado > 0.05)
          avisos.push(
            `peso do bag ${pesoDigitado} kg não bate com PMS ${pmsDigitado} × ${emb.fator} ` +
              `(${pesoDoBag(pmsDigitado, emb.fator)} kg) — confira`,
          )
      }
    } else {
      pms = pmsDigitado!
      peso = pesoDoBag(pmsDigitado!, emb.fator)
    }
  }

  return {
    lote:
      erros.length === 0 && pms != null && peso != null
        ? { id, cultivar, tratamento: 'SEM TSI', pms, peso_bag_kg: peso, bags_disp: bags! }
        : null,
    erros,
    avisos,
  }
}
