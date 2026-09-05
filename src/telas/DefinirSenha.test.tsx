import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const updateUser = vi.fn()
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { updateUser: (...a: unknown[]) => updateUser(...a) } },
}))

const { default: DefinirSenha } = await import('./DefinirSenha')

describe('definir nova senha (link de recuperacao)', () => {
  beforeEach(() => updateUser.mockReset())

  it('so libera o botao com as duas senhas iguais e >= 6 caracteres', async () => {
    const user = userEvent.setup()
    render(<DefinirSenha email="a@b.com" onConcluir={() => {}} />)
    const botao = screen.getByRole('button', { name: /salvar e entrar/i })
    expect(botao).toBeDisabled()

    await user.type(screen.getByLabelText(/^nova senha/i), 'segredo1')
    await user.type(screen.getByLabelText(/repita/i), 'segredo2')
    expect(screen.getByText(/não conferem/i)).toBeInTheDocument()
    expect(botao).toBeDisabled()
  })

  it('salva a senha e conclui', async () => {
    updateUser.mockResolvedValue({ error: null })
    const onConcluir = vi.fn()
    const user = userEvent.setup()
    render(<DefinirSenha email="a@b.com" onConcluir={onConcluir} />)

    await user.type(screen.getByLabelText(/^nova senha/i), 'segredo1')
    await user.type(screen.getByLabelText(/repita/i), 'segredo1')
    await user.click(screen.getByRole('button', { name: /salvar e entrar/i }))

    await waitFor(() => expect(updateUser).toHaveBeenCalledWith({ password: 'segredo1' }))
    expect(onConcluir).toHaveBeenCalled()
  })

  it('traduz o erro de senha igual a antiga', async () => {
    updateUser.mockResolvedValue({
      error: { message: 'New password should be different from the old password.' },
    })
    const onConcluir = vi.fn()
    const user = userEvent.setup()
    render(<DefinirSenha email="a@b.com" onConcluir={onConcluir} />)

    await user.type(screen.getByLabelText(/^nova senha/i), 'segredo1')
    await user.type(screen.getByLabelText(/repita/i), 'segredo1')
    await user.click(screen.getByRole('button', { name: /salvar e entrar/i }))

    expect(await screen.findByText(/diferente da antiga/i)).toBeInTheDocument()
    expect(onConcluir).not.toHaveBeenCalled()
  })
})
