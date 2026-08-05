# Pendências

Estado do projeto e o que falta, para retomar sem depender da memória de ninguém.
Atualizado em 05/08/2026 (noite — correções de RLS e baixa atômica).

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

- ~~Pedido `Aguardando Aprovação` fica invisível~~ — **DECIDIDO em 05/08/2026**: só pedido
  firme entra (`Status Pedido = Aprovado` ou `Integrado`). Cotação, cancelado, reprovado,
  aguardando aprovação e reaberto ficam fora — a prévia da importação mostra quantos bags de
  TSI real cada status descartou. O "aguardando" do painel é só o
  `Status Financeiro = Não Aprovado`: importado, visível, fora do saldo. Quantidade é a
  coluna `Saldo a Faturar` (BW), já líquida do faturado — sempre foi.
- ~~Qualidade reprovada~~ — **RESOLVIDO em 05/08/2026**: o Aprovado/Reprovado saiu. A qualidade
  virou checklist informativo em 2 etapas (em processo + final): recobrimento 1–5, umidade,
  desprendimento de pó, observação. Nunca bloqueia. A tabela `ordem_qualidade` ficou sem uso —
  remover na limpeza geral (o nível 1 do limpar-dados-teste já a esvazia).
- **Estoque de químicos:** o app registra consumo real mas não sabe o saldo de insumo, então
  não consegue avisar "o Fortenza não cobre a programação da semana".
- **Etiquetas:** ~15 abas da planilha antiga ficaram fora do escopo.
- **Capacidade variável:** 12 t/h é global. Varia por receita ou embalagem?
- **Horário previsto por ordem** e **painel modo TV**: sugeridos, não feitos.

## 4. Melhorias técnicas conhecidas

- **RLS × matriz da Administração — só a baixa de lote está unificada.** Desde 05/08/2026
  a policy `pode_baixar_lote()` lê `perfil_permissoes` (linha explícita manda, ausência
  segue o padrão), então conceder "Baixar lote" na Administração funciona para qualquer
  perfil. As demais ações (`apontar`, `qualidade`, `lancar`…) continuam com policies de
  perfil fixo no schema: conceder `apontar` ao PCP na tela, por exemplo, dá erro alto ao
  gravar eventos/tanques (não mais falha silenciosa). Se a operação quiser a matriz
  mandando em tudo, estender o padrão `pode_baixar_lote()` às outras ações.

- **Usuários da operação criados em 05/08/2026** (6 Produção, 1 Logística, 2 PCP) via script
  SQL direto no Auth + `tsi.usuarios` — o script **não está no repositório de propósito**
  (repo público; contém logins e senha inicial). Todos entraram com a **mesma senha inicial**,
  que deve ser trocada — mas **o app não tem tela de troca de senha** nem "esqueci a senha".
  Enquanto não tiver, a troca é pelo painel do Supabase (Authentication → usuário → Reset
  password) ou um novo script. É a próxima lacuna real de segurança.
- **react-router 7.18.1** tem o aviso `GHSA-qwww-vcr4-c8h2` (CSRF bypass), que só ocorre em
  **modo RSC**. Este app é SPA sem RSC, então o vetor não existe aqui, e não há versão
  corrigida publicada — a única sugestão do `npm audit` é regredir para 7.11.0. Mantido;
  revisar quando sair correção.
- **Testes**: só de domínio e dois de componente. Não há teste de fluxo ponta a ponta.
- **Cadastros** cobrem produtos químicos, receitas, máquinas, turnos, embalagens, motivos e
  lotes de semente.

---

## Armadilhas já pagas — não repetir

**UPDATE/DELETE barrado pelo RLS afeta 0 linhas SEM erro.** O app seguia adiante achando
que gravou: a Produção inteira apontava no vácuo (não havia policy de update em `ordens`),
o Cancelar início nunca apagava os eventos (sem policy de delete — sobrou `inicio` duplicado
inflando o tempo bruto da 131104) e a baixa de lote pelo PCP gravou o status sem o movimento
(lote SV0101036060345, reparado). Regra desde 05/08/2026: todo update/delete de apontamento
pede as linhas de volta (`.select()`) e trata 0 linhas como recusa (`exigeLinha` em
`api.ts`); escritas que precisam valer juntas vão em RPC transacional
(`baixar_lote`/`estornar_lote` em `supabase/baixa-atomica-e-rls-apontamento.sql`, aplicado
em 05/08/2026). Ao criar policy nova, testar com o perfil que NÃO pode: o sintoma de policy
faltando é sucesso silencioso, não erro.

**Lote de químico saiu do escopo em 05/08/2026.** As tabelas `lotes_quimico` e
`ordem_tanque_lotes` foram removidas, junto do cadastro, da escolha na ordem e da trava de
início. Não reimplementar sem pedido explícito. O cadastro de **produtos** químicos (com a
densidade da FISPQ) continua e é o que alimenta o peso de balança.

**RLS: view sem `security_invoker` fura o RLS.** Por padrão a view roda com os privilégios
de quem a criou. Como as views ficam expostas na API, `anon` conseguiria ler a produção
inteira. As 6 views do schema têm `security_invoker = true` — manter ao criar novas.

**Permissões: linha explícita manda, célula ausente segue o padrão.** A tabela
`perfil_permissoes` guarda só o que o gestor MEXEU; o padrão de fábrica vive em
`src/dominio/permissoes.ts` (`MATRIZ_PADRAO`). Nunca semear a tabela inteira: o primeiro
clique do gestor não pode virar tudo-ou-nada para o perfil. "Restaurar padrão" = apagar as
linhas do perfil. A tela Administração é hard-coded do Gestor — é ela que conserta a matriz,
não pode depender da matriz. Mudanças valem no próximo carregamento (a matriz é lida no login).

**Comparar texto da SimpleAgro sempre normalizado.** `Integrado`, `Aprovado` e `SEM TSI` são
comparados com caixa e acento removidos (`normaliza()` em `simpleagro.ts`). Igualdade exata
falha **calada**: uma renomeação para `INTEGRADO` descartaria o arquivo inteiro e o painel
mostraria zero demanda, indistinguível de "não há pedido". Pior no financeiro — `APROVADO`
faria tudo virar pendente e liberaria o PCP a planejar o que já está vendido. A prévia avisa
quando nenhuma linha é aproveitada, justamente para esse caso.

**A chave anônima do Supabase não protege nada.** Ela é pública por natureza e é um JWT
válido, então `verify_jwt` sozinho não barra ninguém. Quem protege é o RLS mais a checagem
de cadastro em `tsi.usuarios`.

**`Access-Control-Allow-Headers` de Edge Function precisa de `apikey` e `x-client-info`.**
O `supabase-js` envia os dois; sem eles o navegador bloqueia no preflight e o erro que
aparece é o genérico "Failed to send a request to the Edge Function", sem pista da causa.

**Deploy do GitHub Pages precisa do caminho base.** Um "project site" é servido em
`/Ensaque/`; sem `BASE_PATH` no build, todos os assets dão 404.
