import { useState, type FormEvent } from 'react'
import { supabase } from '@/lib/supabase'

/**
 * Definir nova senha (05/09/2026): o link de recuperação do Supabase loga a
 * pessoa no app e dispara PASSWORD_RECOVERY — esta tela intercepta e pede a
 * senha nova antes de deixar entrar. Sem ela, o "Send password recovery" do
 * painel (e o "esqueci minha senha" do login) era um beco sem saída: o app
 * não tinha onde a senha nova ser digitada.
 */
export default function DefinirSenha({
  email, onConcluir,
}: {
  email: string | null
  onConcluir: () => void
}) {
  const [senha, setSenha] = useState('')
  const [confirma, setConfirma] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [salvando, setSalvando] = useState(false)

  const valido = senha.length >= 6 && senha === confirma

  async function salvar(e: FormEvent) {
    e.preventDefault()
    if (!valido || salvando) return
    setErro(null)
    setSalvando(true)
    const { error } = await supabase.auth.updateUser({ password: senha })
    if (error) {
      setErro(
        error.message.includes('different from the old password')
          ? 'A nova senha precisa ser diferente da antiga.'
          : error.message.includes('at least')
            ? 'A senha é curta demais para a política do sistema.'
            : error.message,
      )
      setSalvando(false)
      return
    }
    onConcluir()
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-stone-100 p-6 dark:bg-stone-950">
      <form
        onSubmit={salvar}
        className="w-full max-w-sm rounded-lg border border-stone-200 bg-white p-8 shadow-sm dark:border-stone-800 dark:bg-stone-900"
      >
        <h1 className="text-xl font-semibold tracking-tight text-stone-900 dark:text-stone-100">
          Definir nova senha
        </h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          {email ? `Para ${email}. ` : ''}Escolha a senha que você vai usar pra entrar no TSI.
        </p>

        <label className="mt-6 block text-sm font-medium text-stone-700 dark:text-stone-300">
          Nova senha
          <input
            type="password"
            required
            minLength={6}
            autoComplete="new-password"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2 text-base text-stone-900 outline-none focus:border-stone-500 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100"
          />
        </label>

        <label className="mt-4 block text-sm font-medium text-stone-700 dark:text-stone-300">
          Repita a nova senha
          <input
            type="password"
            required
            autoComplete="new-password"
            value={confirma}
            onChange={(e) => setConfirma(e.target.value)}
            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2 text-base text-stone-900 outline-none focus:border-stone-500 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100"
          />
        </label>

        <p className="mt-2 text-xs text-stone-500 dark:text-stone-400">
          Mínimo de 6 caracteres.
          {confirma !== '' && senha !== confirma && (
            <span className="text-red-600 dark:text-red-400"> As senhas não conferem.</span>
          )}
        </p>

        {erro && (
          <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {erro}
          </p>
        )}

        <button
          type="submit"
          disabled={!valido || salvando}
          className="mt-6 w-full rounded-md bg-stone-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900"
        >
          {salvando ? 'Salvando…' : 'Salvar e entrar'}
        </button>
      </form>
    </div>
  )
}
