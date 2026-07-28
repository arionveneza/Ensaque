import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * O cliente do Supabase é substituído: o teste verifica o comportamento da
 * tela, não a autenticação real.
 */
const signInWithPassword = vi.fn()
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { signInWithPassword: (...a: unknown[]) => signInWithPassword(...a) } },
}))

const { default: Login } = await import('./Login')

describe('tela de login', () => {
  beforeEach(() => signInWithPassword.mockReset())

  it('mostra os campos e o botao', () => {
    render(<Login />)
    expect(screen.getByLabelText(/e-mail/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/senha/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /entrar/i })).toBeInTheDocument()
  })

  it('envia as credenciais digitadas', async () => {
    signInWithPassword.mockResolvedValue({ error: null })
    const user = userEvent.setup()
    render(<Login />)

    await user.type(screen.getByLabelText(/e-mail/i), 'pessoa@sementesveneza.com.br')
    await user.type(screen.getByLabelText(/senha/i), 'segredo')
    await user.click(screen.getByRole('button', { name: /entrar/i }))

    await waitFor(() =>
      expect(signInWithPassword).toHaveBeenCalledWith({
        email: 'pessoa@sementesveneza.com.br',
        password: 'segredo',
      }),
    )
  })

  it('traduz credencial invalida em vez de mostrar o erro cru em ingles', async () => {
    signInWithPassword.mockResolvedValue({ error: { message: 'Invalid login credentials' } })
    const user = userEvent.setup()
    render(<Login />)

    await user.type(screen.getByLabelText(/e-mail/i), 'a@b.com')
    await user.type(screen.getByLabelText(/senha/i), 'errada')
    await user.click(screen.getByRole('button', { name: /entrar/i }))

    expect(await screen.findByText('E-mail ou senha incorretos.')).toBeInTheDocument()
  })

  it('mostra outros erros como vieram, para nao esconder a causa', async () => {
    signInWithPassword.mockResolvedValue({ error: { message: 'Email not confirmed' } })
    const user = userEvent.setup()
    render(<Login />)

    await user.type(screen.getByLabelText(/e-mail/i), 'a@b.com')
    await user.type(screen.getByLabelText(/senha/i), 'x')
    await user.click(screen.getByRole('button', { name: /entrar/i }))

    expect(await screen.findByText('Email not confirmed')).toBeInTheDocument()
  })
})
