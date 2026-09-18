import { describe, expect, it } from 'vitest'
import { ehCelulaErro, ehHtml, lerCsv } from './csv'

describe('lerCsv: o CSV que o Google devolve', () => {
  it('separa campos e linhas simples', () => {
    expect(lerCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ])
  })

  it('respeita virgula dentro de aspas', () => {
    // caso real: 'Ficha "Intacta 2 Xtend" - 30,7x20,9'
    expect(lerCsv('"Ficha - 30,7x20,9",B')).toEqual([['Ficha - 30,7x20,9', 'B']])
  })

  it('aspa escapada vira uma aspa so', () => {
    expect(lerCsv('"Ficha ""Intacta"" 2",B')).toEqual([['Ficha "Intacta" 2', 'B']])
  })

  it('aceita quebra de linha DENTRO de aspas', () => {
    // a coluna OBSERVAÇÃO tem texto livre, digitado com Alt+Enter
    expect(lerCsv('"linha 1\nlinha 2",B\nx,y')).toEqual([
      ['linha 1\nlinha 2', 'B'],
      ['x', 'y'],
    ])
  })

  it('aceita CRLF e LF', () => {
    expect(lerCsv('a,b\r\nc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('le a ultima linha mesmo sem quebra no fim', () => {
    expect(lerCsv('a,b\nc,d')[1]).toEqual(['c', 'd'])
  })

  it('tira o BOM do comeco', () => {
    expect(lerCsv('﻿DATA,LOTES')[0]).toEqual(['DATA', 'LOTES'])
  })

  it('linha so de virgulas vira celulas vazias', () => {
    expect(lerCsv(',,')).toEqual([['', '', '']])
  })

  it('texto vazio nao vira linha nenhuma', () => {
    expect(lerCsv('')).toEqual([])
  })
})

describe('ehHtml: planilha que deixou de ser publica', () => {
  it('reconhece a pagina do Google', () => {
    expect(ehHtml('<!DOCTYPE html><html><head>')).toBe(true)
    expect(ehHtml('\n  <html lang="pt">')).toBe(true)
    expect(ehHtml('qualquer coisa accounts.google.com/signin')).toBe(true)
  })

  it('nao confunde com CSV de verdade', () => {
    expect(ehHtml('DATA,LOTES,SALDO\n20/01/2026,SV001,27')).toBe(false)
    // '<' dentro de campo entre aspas continua sendo CSV
    expect(ehHtml('"SC 40kg>",B')).toBe(false)
  })
})

describe('ehCelulaErro: formula quebrada na planilha', () => {
  it('pega as formas do Google/Excel', () => {
    for (const e of ['#REF!', '#ERROR!', '#N/A', '#VALUE!', '#DIV/0!', '#NAME?', '#NUM!', '#NULL!']) {
      expect(ehCelulaErro(e)).toBe(true)
    }
    expect(ehCelulaErro('  #ref!  ')).toBe(true)
  })

  it('nao pega valor de verdade', () => {
    expect(ehCelulaErro('27')).toBe(false)
    expect(ehCelulaErro('')).toBe(false)
    expect(ehCelulaErro('SV0011036060002')).toBe(false)
  })
})
