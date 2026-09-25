/**
 * Ajuste fino da ficha de químicos POR COMPUTADOR (12/09/2026): fica no
 * localStorage porque o desvio é da impressora ligada àquela máquina —
 * não é dado do sistema, e cada posto pode ter o seu. Sem storage (modo
 * privado, tablet bloqueado) o app segue com o padrão.
 *
 * Desde 25/09/2026 há dois papéis (o novo deitado e o antigo em pé), e o
 * ajuste é POR PAPEL: o calibrado no antigo deslocaria o novo. O antigo
 * continua na chave de sempre — quem calibrou não perde nada.
 */

import {
  AJUSTE_FICHA_ZERO, MODELO_FICHA_PADRAO, normalizarAjusteFicha, type AjusteFicha, type ModeloFicha,
} from '@/dominio/fichaQuimicos'

const CHAVE: Record<ModeloFicha, string> = {
  retrato: 'tsi.ficha.ajuste',
  paisagem: 'tsi.ficha.ajuste.paisagem',
}
const CHAVE_MODELO = 'tsi.ficha.modelo'

export function carregarAjusteFicha(modelo: ModeloFicha = MODELO_FICHA_PADRAO): AjusteFicha {
  try {
    const bruto = localStorage.getItem(CHAVE[modelo])
    return bruto ? normalizarAjusteFicha(JSON.parse(bruto)) : AJUSTE_FICHA_ZERO
  } catch {
    return AJUSTE_FICHA_ZERO
  }
}

export function salvarAjusteFicha(ajuste: AjusteFicha, modelo: ModeloFicha = MODELO_FICHA_PADRAO): void {
  try {
    localStorage.setItem(CHAVE[modelo], JSON.stringify(normalizarAjusteFicha(ajuste)))
  } catch {
    // sem storage: o ajuste vale só enquanto a tela estiver aberta
  }
}

/** Papel escolhido neste computador; sem escolha, o novo (deitado). */
export function carregarModeloFicha(): ModeloFicha {
  try {
    const v = localStorage.getItem(CHAVE_MODELO)
    return v === 'retrato' || v === 'paisagem' ? v : MODELO_FICHA_PADRAO
  } catch {
    return MODELO_FICHA_PADRAO
  }
}

export function salvarModeloFicha(modelo: ModeloFicha): void {
  try {
    localStorage.setItem(CHAVE_MODELO, modelo)
  } catch {
    // sem storage: vale só enquanto a tela estiver aberta
  }
}
