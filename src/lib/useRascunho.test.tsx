import { beforeEach, describe, expect, it } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { limparRascunhoDe, useRascunho, temRascunho } from './useRascunho'

/**
 * O cenário do chão de fábrica: o PCP digita metade de uma ordem, sai para
 * conferir um lote e volta. A navegação do app DESMONTA a tela, então sem
 * rascunho o React descarta tudo.
 */

interface Form { numero: string; cliente: string }
const INICIAL: Form = { numero: '', cliente: '' }

function FormularioFake({ chave = 'teste' }: { chave?: string }) {
  const { valor, definir, limpar, recuperado } = useRascunho<Form>(chave, INICIAL)
  return (
    <div>
      {recuperado && <span>rascunho recuperado</span>}
      <input
        aria-label="numero"
        value={valor.numero}
        onChange={(e) => definir({ numero: e.target.value })}
      />
      <input
        aria-label="cliente"
        value={valor.cliente}
        onChange={(e) => definir({ cliente: e.target.value })}
      />
      <button onClick={limpar}>descartar</button>
    </div>
  )
}

describe('rascunho de formulario', () => {
  beforeEach(() => localStorage.clear())

  it('o que foi digitado volta depois de a tela ser desmontada', async () => {
    const u = userEvent.setup()
    const tela = render(<FormularioFake />)
    await u.type(screen.getByLabelText('numero'), '79500-1')
    await u.type(screen.getByLabelText('cliente'), 'FAZENDA X')

    // sair da tela: e exatamente isto que o App faz ao trocar de aba
    tela.unmount()

    render(<FormularioFake />)
    expect(screen.getByLabelText('numero')).toHaveValue('79500-1')
    expect(screen.getByLabelText('cliente')).toHaveValue('FAZENDA X')
    expect(screen.getByText('rascunho recuperado')).toBeInTheDocument()
  })

  it('formulario intocado nao deixa rascunho nem avisa', () => {
    const tela = render(<FormularioFake />)
    tela.unmount()
    render(<FormularioFake />)
    expect(screen.queryByText('rascunho recuperado')).not.toBeInTheDocument()
    expect(temRascunho('teste')).toBe(false)
  })

  it('apagar o que foi digitado nao deixa lixo no storage', async () => {
    const u = userEvent.setup()
    render(<FormularioFake />)
    await u.type(screen.getByLabelText('numero'), 'ABC')
    expect(temRascunho('teste')).toBe(true)
    await u.clear(screen.getByLabelText('numero'))
    // de volta ao inicial: a chave sai, senao o aviso apareceria sem motivo
    expect(temRascunho('teste')).toBe(false)
  })

  it('descartar limpa a tela e o storage', async () => {
    const u = userEvent.setup()
    render(<FormularioFake />)
    await u.type(screen.getByLabelText('numero'), '79500-1')
    await u.click(screen.getByText('descartar'))
    expect(screen.getByLabelText('numero')).toHaveValue('')
    expect(temRascunho('teste')).toBe(false)
  })

  /**
   * O caso da câmera: o componente do formulário já foi DESMONTADO quando a
   * gravação no servidor termina com sucesso (o pai trocou de tela ou
   * fechou o formulário), então o `limpar()` do hook não está mais ao
   * alcance — só a função solta serve para o pai apagar de fora.
   */
  it('limparRascunhoDe apaga sem precisar do componente montado', async () => {
    const u = userEvent.setup()
    const tela = render(<FormularioFake />)
    await u.type(screen.getByLabelText('numero'), '79500-1')
    tela.unmount()
    expect(temRascunho('teste')).toBe(true)

    limparRascunhoDe('teste')

    expect(temRascunho('teste')).toBe(false)
    render(<FormularioFake />)
    expect(screen.getByLabelText('numero')).toHaveValue('')
  })

  it('rascunhos de chaves diferentes nao se misturam', async () => {
    const u = userEvent.setup()
    const a = render(<FormularioFake chave="ordem.nova" />)
    await u.type(screen.getByLabelText('numero'), 'AAA')
    a.unmount()

    const b = render(<FormularioFake chave="ordem.123" />)
    expect(screen.getByLabelText('numero')).toHaveValue('')
    await u.type(screen.getByLabelText('numero'), 'BBB')
    b.unmount()

    render(<FormularioFake chave="ordem.nova" />)
    expect(screen.getByLabelText('numero')).toHaveValue('AAA')
  })

  it('storage indisponivel nao derruba o formulario', async () => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    try {
      const u = userEvent.setup()
      render(<FormularioFake />)
      await act(async () => {
        await u.type(screen.getByLabelText('numero'), 'X')
      })
      // sem persistir, mas digitando normalmente
      expect(screen.getByLabelText('numero')).toHaveValue('X')
    } finally {
      Storage.prototype.setItem = original
    }
  })
})
