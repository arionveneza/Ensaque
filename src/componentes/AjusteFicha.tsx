import {
  AJUSTE_FICHA_ZERO, LIMITE_AJUSTE_MM, LINHAS_AJUSTE_FICHA, type AjusteFicha,
} from '@/dominio/fichaQuimicos'

interface Props {
  valor: AjusteFicha
  onMudar: (v: AjusteFicha) => void
  onImprimirTeste: () => void
  onImprimirFicha: () => void
}

const mm = (v: number) => (v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v)} mm`)

/**
 * Painel de ajuste fino da ficha de químicos (12/09/2026): ▲▼ de 1 mm por
 * seção e um horizontal geral, salvo neste computador. Substitui o
 * pingue-pongue "sobe 3 mm / desce 2 mm" com deploy no meio — quem está na
 * frente da impressora acerta e imprime de novo na hora.
 */
export function PainelAjusteFicha({ valor, onMudar, onImprimirTeste, onImprimirFicha }: Props) {
  const mudar = (chave: keyof AjusteFicha, delta: number) => {
    const novo = Math.max(-LIMITE_AJUSTE_MM, Math.min(LIMITE_AJUSTE_MM, valor[chave] + delta))
    onMudar({ ...valor, [chave]: novo })
  }
  const padrao = Object.values(valor).every((v) => v === 0)

  return (
    <div className="mt-1 border-t border-stone-200 pt-2 dark:border-stone-700">
      <p className="px-2 text-xs text-stone-500 dark:text-stone-400">
        Ajuste fino <b>desta impressora</b> — positivo desce / vai pra direita. Fica salvo
        neste computador e vale pra toda impressão.
      </p>
      <table className="mt-1 w-full text-sm">
        <tbody>
          {LINHAS_AJUSTE_FICHA.map(({ chave, rotulo }) => (
            <tr key={chave}>
              <td className="px-2 py-0.5">{rotulo}</td>
              <td className="px-1 py-0.5 text-right">
                <div className="inline-flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => mudar(chave, -1)}
                    aria-label={`${rotulo}: 1 mm ${chave === 'x' ? 'pra esquerda' : 'pra cima'}`}
                    title={chave === 'x' ? '1 mm pra esquerda' : '1 mm pra cima'}
                    className="h-7 w-7 rounded border border-stone-300 text-base leading-none hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800"
                  >
                    {chave === 'x' ? '◂' : '▴'}
                  </button>
                  <span className={`num-tabular inline-block w-16 text-center ${valor[chave] === 0 ? 'text-stone-400' : 'font-semibold'}`}>
                    {mm(valor[chave])}
                  </span>
                  <button
                    type="button"
                    onClick={() => mudar(chave, +1)}
                    aria-label={`${rotulo}: 1 mm ${chave === 'x' ? 'pra direita' : 'pra baixo'}`}
                    title={chave === 'x' ? '1 mm pra direita' : '1 mm pra baixo'}
                    className="h-7 w-7 rounded border border-stone-300 text-base leading-none hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800"
                  >
                    {chave === 'x' ? '▸' : '▾'}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 px-2 pb-1">
        <button
          type="button"
          onClick={onImprimirTeste}
          className="rounded-md border border-stone-300 px-2.5 py-1 text-xs hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800"
        >
          Imprimir teste
        </button>
        <button
          type="button"
          onClick={onImprimirFicha}
          className="rounded-md bg-green-800 px-2.5 py-1 text-xs font-medium text-white hover:bg-green-900"
        >
          Imprimir ficha
        </button>
        <button
          type="button"
          disabled={padrao}
          onClick={() => onMudar({ ...AJUSTE_FICHA_ZERO })}
          className="ml-auto rounded-md px-2 py-1 text-xs text-stone-500 hover:bg-stone-100 disabled:opacity-40 dark:hover:bg-stone-800"
        >
          Voltar ao padrão
        </button>
      </div>
    </div>
  )
}
