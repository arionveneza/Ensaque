# Pendências

Estado do projeto e o que falta, para retomar sem depender da memória de ninguém.
Atualizado em 05/08/2026.

## Onde o sistema está

| Item | Situação |
|---|---|
| App publicado | https://arionveneza.github.io/Ensaque/ |
| Repositório | `arionveneza/Ensaque` (público) — `push` na `main` roda os testes e republica |
| Banco | Supabase `Sistema_de_ensaque`, projeto `ztwmrhfloelqxhhpdmoz`, schema **`tsi`** |
| Telas | As 8 implementadas: Ordens, Programação, Lotes, Execução, Qualidade, Indicadores, Cadastros, Administração |
| Testes | 153, rodam antes de cada deploy — teste vermelho não publica |
| Integração SAP | **Retirada do app.** Ver `docs/integracao-sap.md` |

Rodar local: `npm install`, depois `npm run dev` · `npm test` · `npm run build`.

---

## 1. Densidades reais dos químicos — MAIS IMPORTANTE

As densidades no banco são **fictícias**, herdadas do protótipo. Elas definem o **peso de
balança** que a produção afere em cada tanque, então um valor errado desloca a dosagem
inteira — e não gera alerta nenhum, porque o número parece plausível.

Trocar pelas **FISPQ** dos fabricantes em **Cadastros → Produtos químicos**. Produto em
`ml/kg` exige densidade; a tela recusa salvar sem ela e destaca em vermelho quem está
faltando.

Enquanto não for feito, o sistema é demonstrável mas **não confiável para produzir**.

## 2. Limpeza do que sobrou do SAP no Supabase

O código saiu do app, mas ficaram coisas no projeto:

- **Tabela:** executar `supabase/remover-consultas-sap.sql` no SQL Editor.
- **Edge Function:** apagar a função `sap` em *Edge Functions*.
- **Secrets:** apagar `SAP_SL_URL`, `SAP_COMPANY_DB`, `SAP_USER` e **`SAP_PASSWORD`**.
  Sem integração, guardar senha do ERP ali é exposição sem motivo.
  ⚠️ Durante os testes o `SAP_USER`/`SAP_PASSWORD` foi trocado para o usuário **pessoal**
  do Arion — pode ser a senha dele que está guardada, não a do `ven040`.

## 3. Decisões de negócio em aberto (§7 do CLAUDE.md)

Nenhuma é problema de código; todas dependem de definição da operação.

- **Qualidade reprovada:** hoje é só um carimbo. Gera retrabalho? Bloqueia o lote? Cria nova ordem?
- **Estoque de químicos:** o app registra consumo real mas não sabe o saldo de insumo, então
  não consegue avisar "o Fortenza não cobre a programação da semana".
- **Etiquetas:** ~15 abas da planilha antiga ficaram fora do escopo.
- **Capacidade variável:** 12 t/h é global. Varia por receita ou embalagem?
- **Horário previsto por ordem** e **painel modo TV**: sugeridos, não feitos.

## 4. Melhorias técnicas conhecidas

- **react-router 7.18.1** tem o aviso `GHSA-qwww-vcr4-c8h2` (CSRF bypass), que só ocorre em
  **modo RSC**. Este app é SPA sem RSC, então o vetor não existe aqui, e não há versão
  corrigida publicada — a única sugestão do `npm audit` é regredir para 7.11.0. Mantido;
  revisar quando sair correção.
- **Testes**: só de domínio e dois de componente. Não há teste de fluxo ponta a ponta.
- **Cadastros** cobrem químicos, receitas, máquinas, turnos, embalagens, motivos e lotes.

---

## Armadilhas já pagas — não repetir

**Não apagar lote de químico usado em ordem.** `ordem_tanque_lotes` referencia
`lotes_quimico`, e apagar quebraria a rastreabilidade. O caminho é **desativar**.

**RLS: view sem `security_invoker` fura o RLS.** Por padrão a view roda com os privilégios
de quem a criou. Como as views ficam expostas na API, `anon` conseguiria ler a produção
inteira. As 6 views do schema têm `security_invoker = true` — manter ao criar novas.

**A chave anônima do Supabase não protege nada.** Ela é pública por natureza e é um JWT
válido, então `verify_jwt` sozinho não barra ninguém. Quem protege é o RLS mais a checagem
de cadastro em `tsi.usuarios`.

**`Access-Control-Allow-Headers` de Edge Function precisa de `apikey` e `x-client-info`.**
O `supabase-js` envia os dois; sem eles o navegador bloqueia no preflight e o erro que
aparece é o genérico "Failed to send a request to the Edge Function", sem pista da causa.

**Deploy do GitHub Pages precisa do caminho base.** Um "project site" é servido em
`/Ensaque/`; sem `BASE_PATH` no build, todos os assets dão 404.
