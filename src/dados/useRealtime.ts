import { useEffect, useRef } from 'react'
import { supabase } from '@/lib/supabase'

/**
 * Recarrega a tela quando alguém mexe nas tabelas observadas.
 *
 * O caso real: o PCP olha a Programação enquanto a produção aponta início na
 * Execução. Sem isso, o quadro do PCP mente até ele apertar F5.
 *
 * O recarregamento é agrupado num intervalo curto porque uma única ação gera
 * vários eventos — confirmar início mexe em ordens, ordem_eventos e
 * ordem_tanques quase ao mesmo tempo.
 */
export function useRealtime(
  tabelas: string[],
  aoMudar: () => void,
  opcoes: { ativo?: boolean; agruparMs?: number } = {},
): void {
  const { ativo = true, agruparMs = 400 } = opcoes
  const callback = useRef(aoMudar)
  callback.current = aoMudar

  // string estável: evita reassinar o canal a cada render
  const chave = tabelas.slice().sort().join(',')

  useEffect(() => {
    if (!ativo || !chave) return

    let timer: ReturnType<typeof setTimeout> | null = null
    const agendar = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => callback.current(), agruparMs)
    }

    const canal = supabase.channel(`tsi:${chave}`)
    for (const tabela of chave.split(',')) {
      canal.on('postgres_changes', { event: '*', schema: 'tsi', table: tabela }, agendar)
    }
    canal.subscribe()

    return () => {
      if (timer) clearTimeout(timer)
      supabase.removeChannel(canal)
    }
  }, [chave, ativo, agruparMs])
}
