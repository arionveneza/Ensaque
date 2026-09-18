/**
 * Parser de CSV (18/09/2026) — o primeiro do projeto.
 *
 * Todas as outras origens chegam em .xlsx pelo `read-excel-file`; a planilha
 * do Google da tela "Endereçamento planilha" chega em CSV, porque é o único
 * formato que o Google serve direto pro navegador. Segue o RFC 4180 no que
 * importa aqui: vírgula separa, aspas duplas cercam, `""` é uma aspa
 * literal, e DENTRO das aspas tudo vale — inclusive vírgula e quebra de
 * linha (a coluna OBSERVAÇÃO da planilha tem texto livre).
 */

/** Uma célula por coluna, uma linha por linha do arquivo. Nunca lança. */
export function lerCsv(texto: string): string[][] {
  // BOM: o Excel grava, e sem tirar ele o primeiro cabeçalho nunca casa
  const t = texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto
  const linhas: string[][] = []
  let campo = ''
  let linha: string[] = []
  let dentroDeAspas = false

  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (dentroDeAspas) {
      if (c === '"') {
        if (t[i + 1] === '"') {
          campo += '"'
          i++
        } else dentroDeAspas = false
      } else campo += c
      continue
    }
    if (c === '"') dentroDeAspas = true
    else if (c === ',') {
      linha.push(campo)
      campo = ''
    } else if (c === '\r') {
      // CRLF: o \n seguinte fecha a linha; \r solto (Mac antigo) também fecha
      if (t[i + 1] !== '\n') {
        linha.push(campo)
        linhas.push(linha)
        linha = []
        campo = ''
      }
    } else if (c === '\n') {
      linha.push(campo)
      linhas.push(linha)
      linha = []
      campo = ''
    } else campo += c
  }
  // última linha sem quebra no fim
  if (campo !== '' || linha.length > 0) {
    linha.push(campo)
    linhas.push(linha)
  }
  return linhas
}

/**
 * A resposta é uma página HTML, não CSV. Acontece quando a planilha deixa
 * de ser pública: o Google responde 200 com a tela de login, e sem esta
 * checagem o parser leria o HTML como se fossem dados.
 */
export function ehHtml(texto: string): boolean {
  const inicio = texto.slice(0, 500).trim().toLowerCase()
  return (
    inicio.startsWith('<!doctype html') ||
    inicio.startsWith('<html') ||
    inicio.includes('accounts.google.com') ||
    inicio.includes('<head>')
  )
}

/** Fórmula quebrada na planilha (#REF!, #ERROR!…) — vale como célula vazia, nunca como dado. */
export function ehCelulaErro(v: string): boolean {
  const s = v.trim().toUpperCase()
  return (
    s === '#REF!' ||
    s === '#ERROR!' ||
    s === '#N/A' ||
    s === '#VALUE!' ||
    s === '#DIV/0!' ||
    s === '#NAME?' ||
    s === '#NUM!' ||
    s === '#NULL!'
  )
}
