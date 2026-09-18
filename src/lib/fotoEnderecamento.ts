/**
 * Última foto da planilha guardada NESTE navegador (18/09/2026), no molde
 * do `ajusteFicha.ts`: a tela abre instantânea com o que já tinha e só vai
 * à rede quando o operador clicar em Atualizar. Não é dado do sistema —
 * é cópia de leitura de uma planilha de fora, então não tem tabela, não
 * tem RLS e não há o que sincronizar. Sem storage (modo privado, tablet
 * bloqueado) a tela funciona igual, só não abre instantânea na próxima vez.
 */

import { normalizarFoto, VERSAO_FOTO, type FotoEnderecamento } from '@/dominio/enderecamento'
import { PLANILHA_ID } from '@/dados/planilhaEnderecamento'

const CHAVE = 'tsi.enderecamento.foto'

export function carregarFoto(): FotoEnderecamento | null {
  try {
    const bruto = localStorage.getItem(CHAVE)
    return bruto ? normalizarFoto(JSON.parse(bruto), PLANILHA_ID) : null
  } catch {
    // JSON corrompido ou storage indisponível: começa do zero, sem quebrar a tela
    return null
  }
}

export function salvarFoto(f: Omit<FotoEnderecamento, 'versao' | 'planilhaId'>): void {
  try {
    localStorage.setItem(
      CHAVE,
      JSON.stringify({ ...f, versao: VERSAO_FOTO, planilhaId: PLANILHA_ID }),
    )
  } catch {
    // QuotaExceededError e afins: a foto vale só enquanto a tela estiver aberta
  }
}
