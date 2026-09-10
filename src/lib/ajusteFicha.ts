/**
 * Ajuste fino da ficha de químicos POR COMPUTADOR (12/09/2026): fica no
 * localStorage porque o desvio é da impressora ligada àquela máquina —
 * não é dado do sistema, e cada posto pode ter o seu. Sem storage (modo
 * privado, tablet bloqueado) o app segue com o padrão.
 */

import { AJUSTE_FICHA_ZERO, normalizarAjusteFicha, type AjusteFicha } from '@/dominio/fichaQuimicos'

const CHAVE = 'tsi.ficha.ajuste'

export function carregarAjusteFicha(): AjusteFicha {
  try {
    const bruto = localStorage.getItem(CHAVE)
    return bruto ? normalizarAjusteFicha(JSON.parse(bruto)) : AJUSTE_FICHA_ZERO
  } catch {
    return AJUSTE_FICHA_ZERO
  }
}

export function salvarAjusteFicha(ajuste: AjusteFicha): void {
  try {
    localStorage.setItem(CHAVE, JSON.stringify(normalizarAjusteFicha(ajuste)))
  } catch {
    // sem storage: o ajuste vale só enquanto a tela estiver aberta
  }
}
