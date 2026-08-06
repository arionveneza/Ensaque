import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Estado de formulário que sobrevive ao componente sumir da tela.
 *
 * A navegação do app monta e desmonta a tela inteira (`{atual === 'x' && <X/>}`),
 * então sair de Ordens para conferir um lote destruía tudo que estava digitado.
 * Aqui o valor vai para o localStorage a cada mudança e volta na montagem —
 * o que também salva o trabalho de um F5, de fechar a aba sem querer ou do
 * tablet dormindo no chão de fábrica.
 *
 * Chame `limpar()` depois de gravar, senão o próximo formulário abre com o
 * rascunho antigo.
 */

const PREFIXO = 'tsi.rascunho.'

const ler = <T,>(chave: string): T | null => {
  try {
    const bruto = localStorage.getItem(PREFIXO + chave)
    return bruto == null ? null : (JSON.parse(bruto) as T)
  } catch {
    // storage cheio, desabilitado ou JSON corrompido: segue sem rascunho
    return null
  }
}

export interface Rascunho<T> {
  valor: T
  definir: (patch: Partial<T>) => void
  /** Substitui o valor inteiro — para listas e reinícios. */
  substituir: (v: T) => void
  /** Apaga o rascunho e volta ao inicial. Use após gravar. */
  limpar: () => void
  /** Havia rascunho salvo quando a tela montou. */
  recuperado: boolean
}

export function useRascunho<T extends object>(chave: string, inicial: T): Rascunho<T> {
  const salvo = useRef<T | null>(null)
  if (salvo.current === null) salvo.current = ler<T>(chave)

  const [valor, setValor] = useState<T>(() => ({ ...inicial, ...(salvo.current ?? {}) }))
  const [recuperado, setRecuperado] = useState(salvo.current != null)

  // grava a cada mudança; valor igual ao inicial não deixa lixo no storage
  useEffect(() => {
    try {
      if (JSON.stringify(valor) === JSON.stringify(inicial)) {
        localStorage.removeItem(PREFIXO + chave)
      } else {
        localStorage.setItem(PREFIXO + chave, JSON.stringify(valor))
      }
    } catch {
      // sem storage o formulário continua funcionando, só não sobrevive à saída
    }
    // `inicial` é literal recriado a cada render: comparar pelo conteúdo
    // evitaria o efeito extra, mas o custo aqui é irrelevante
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chave, valor])

  const definir = useCallback((patch: Partial<T>) => {
    setValor((v) => ({ ...v, ...patch }))
  }, [])

  const substituir = useCallback((v: T) => setValor(v), [])

  const limpar = useCallback(() => {
    try {
      localStorage.removeItem(PREFIXO + chave)
    } catch { /* nada a fazer */ }
    setValor(inicial)
    setRecuperado(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chave])

  return { valor, definir, substituir, limpar, recuperado }
}

/** Existe rascunho salvo para esta chave? Para reabrir o formulário sozinho. */
export const temRascunho = (chave: string): boolean => {
  try {
    return localStorage.getItem(PREFIXO + chave) != null
  } catch {
    return false
  }
}
