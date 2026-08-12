import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

/**
 * O que trava é achar o formulário depois de um reload (Chrome/Edge suspendem
 * a aba em segundo plano e recarregam a página ao voltar). O rascunho do
 * conteúdo (`useRascunho`) já sobrevivia, mas a tela nem mostrava o
 * formulário aberto de novo — este teste simula esse reload (desmontar e
 * montar de novo) e confere que a aba e o formulário voltam abertos, com o
 * que já tinha sido digitado.
 */

vi.mock('@/auth/AuthProvider', () => ({
  useAuth: () => ({ permitido: () => true }),
}))

/**
 * Mocks inteiramente inline — sem `vi.importActual`. Puxar o módulo real
 * (mesmo só para espalhar `...real`) importa `@/lib/supabase`, que lança se
 * `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` não existirem — o caso do CI,
 * que não tem `.env.local` (nem deveria: é gitignored). Rodava só na minha
 * máquina, que tem as credenciais reais; quebrava sempre no GitHub Actions.
 * `Cadastros.tsx` só chama estas quatro funções ao montar — nada mais do
 * módulo real precisa existir para este teste.
 */
vi.mock('@/dados/api', () => ({
  carregarCadastros: () =>
    Promise.resolve({
      maquinas: [],
      motivos: [],
      produtos: [{ id: 'p1', codigo: 'FTZ', nome: 'Fortenza', unidade: 'ml/100kg', densidade: 1.2 }],
    }),
}))

vi.mock('@/dados/api-gestao', () => ({
  listarReceitas: () => Promise.resolve([]),
  listarEmbalagens: () => Promise.resolve([]),
  listarTurnos: () => Promise.resolve([]),
  listarLotes: () => Promise.resolve([]),
}))

vi.mock('@/dados/api-admin', () => ({
  listarPrincipios: () => Promise.resolve([]),
}))

const { default: Cadastros } = await import('./Cadastros')

describe('Cadastros sobrevive a recarregar a página', () => {
  beforeEach(() => localStorage.clear())

  it('reabre a aba e o formulário de receita com o rascunho digitado', async () => {
    const user = userEvent.setup()

    const primeiraMontagem = render(<Cadastros />)
    await user.click(await screen.findByRole('button', { name: 'Receitas' }))
    await user.click(await screen.findByRole('button', { name: 'Nova receita' }))
    const nome = await screen.findByLabelText(/nome da receita/i)
    await user.type(nome, 'FTZ60-TESTE')
    await waitFor(() => expect(nome).toHaveValue('FTZ60-TESTE'))

    // simula o reload: a página inteira some e volta (não é F5 real, mas é
    // o mesmo efeito para o React — todo o estado em memória se perde)
    primeiraMontagem.unmount()
    render(<Cadastros />)

    expect(await screen.findByText(/Rascunho recuperado/)).toBeInTheDocument()
    const nomeRestaurado = await screen.findByLabelText(/nome da receita/i)
    expect(nomeRestaurado).toHaveValue('FTZ60-TESTE')
  })
})
