import { useState, type FormEvent } from 'react'
import { supabase } from '@/lib/supabase'

export default function Login() {
  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')
  const [erro, setErro] = useState<string | null>(null)
  const [aviso, setAviso] = useState<string | null>(null)
  const [enviando, setEnviando] = useState(false)

  async function entrar(e: FormEvent) {
    e.preventDefault()
    setErro(null)
    setAviso(null)
    setEnviando(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password: senha })
    if (error) {
      setErro(
        error.message === 'Invalid login credentials'
          ? 'E-mail ou senha incorretos.'
          : error.message,
      )
    }
    setEnviando(false)
  }

  /**
   * Esqueci minha senha (05/09/2026): manda o e-mail de recuperação do
   * Supabase; o link loga a pessoa no app, que abre a tela "Definir nova
   * senha" (DefinirSenha.tsx). O mesmo caminho serve pro gestor dar a
   * primeira senha a um usuário novo — "Send password recovery" no painel.
   */
  async function esqueciSenha() {
    setErro(null)
    setAviso(null)
    if (!email.trim()) {
      setErro('Digite seu e-mail acima e clique de novo em "esqueci minha senha".')
      return
    }
    setEnviando(true)
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim())
    if (error) setErro(error.message)
    else
      setAviso(
        `Enviamos um link para ${email.trim()} — abra o e-mail e clique nele para definir uma nova senha.`,
      )
    setEnviando(false)
  }

  return (
    <div className="flex min-h-svh items-center justify-center bg-stone-100 p-6 dark:bg-stone-950">
      <form
        onSubmit={entrar}
        className="w-full max-w-sm rounded-lg border border-stone-200 bg-white p-8 shadow-sm dark:border-stone-800 dark:bg-stone-900"
      >
        <h1 className="text-xl font-semibold tracking-tight text-stone-900 dark:text-stone-100">
          TSI
        </h1>
        <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">
          Tratamento Industrial de Sementes · Sementes Veneza
        </p>

        <label className="mt-6 block text-sm font-medium text-stone-700 dark:text-stone-300">
          E-mail
          <input
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2 text-base text-stone-900 outline-none focus:border-stone-500 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100"
          />
        </label>

        <label className="mt-4 block text-sm font-medium text-stone-700 dark:text-stone-300">
          Senha
          <input
            type="password"
            required
            autoComplete="current-password"
            value={senha}
            onChange={(e) => setSenha(e.target.value)}
            className="mt-1 w-full rounded-md border border-stone-300 px-3 py-2 text-base text-stone-900 outline-none focus:border-stone-500 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-100"
          />
        </label>

        {erro && (
          <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
            {erro}
          </p>
        )}
        {aviso && (
          <p className="mt-4 rounded-md bg-green-50 px-3 py-2 text-sm text-green-800 dark:bg-green-950/40 dark:text-green-300">
            {aviso}
          </p>
        )}

        <button
          type="submit"
          disabled={enviando}
          className="mt-6 w-full rounded-md bg-stone-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900"
        >
          {enviando ? 'Entrando…' : 'Entrar'}
        </button>

        <button
          type="button"
          onClick={esqueciSenha}
          disabled={enviando}
          className="mt-3 w-full text-center text-sm text-stone-500 underline-offset-2 hover:underline disabled:opacity-50 dark:text-stone-400"
        >
          Esqueci minha senha
        </button>
      </form>
    </div>
  )
}
