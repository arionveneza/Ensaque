# Pendências

Estado do projeto e o que falta, para retomar sem depender da memória de ninguém.
Atualizado em 05/08/2026 (noite — correções de RLS e baixa atômica).

## Onde o sistema está

| Item | Situação |
|---|---|
| App publicado | **https://tsi.veneza.app.br** (Cloudflare) — ver §3b. O github.io redireciona |
| Repositório | `arionveneza/Ensaque` (público) — `push` na `main` roda os testes e republica |
| Banco | Supabase `Sistema_de_ensaque`, projeto `ztwmrhfloelqxhhpdmoz`, schema **`tsi`** |
| Telas | As 8 implementadas: Ordens, Programação, Lotes, Execução, Qualidade, Indicadores, Cadastros, Administração |
| Testes | 308, rodam antes de cada deploy — teste vermelho não publica |
| Integração SAP | **Laboratório no app** (aba "SAP (teste)", só p/ Arion, homolog só-leitura via Edge Function `sap-teste`). Caminho validado em 09/08/2026: Basic Auth + endpoint de homolog + saldo por lote. Produção espera a autorização de `SQLQueries` — ver `docs/integracao-sap.md` |

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

> **Atualizado 09/08/2026:** a integração voltou ao radar — existe a Edge Function
> **`sap-teste`** (aba "SAP (teste)", laboratório de homologação só-leitura) que **usa
> `SAP_USER`/`SAP_PASSWORD`**. Então NÃO apagar esses dois secrets. O resto da limpeza da
> integração antiga (`sap`) continua valendo.

- **Tabela:** executar `supabase/remover-consultas-sap.sql` no SQL Editor (a `sap-teste` não
  usa a tabela `consultas_sap` — manda o caminho OData direto).
- **Edge Function antiga:** apagar a função `sap` em *Edge Functions* (a nova é `sap-teste`,
  outra função).
- **Secrets:** apagar `SAP_SL_URL` e `SAP_COMPANY_DB` (a `sap-teste` aponta para homolog por
  conta própria, via `SAP_HOM_URL`/`SAP_HOM_DB` com fallback embutido). **Manter
  `SAP_USER` e `SAP_PASSWORD`** — a `sap-teste` depende deles.
  ⚠️ Confirmar QUAL credencial está guardada: durante os testes de julho pode ter ficado a
  senha **pessoal** do Arion, não a do `ven040`. O certo é um usuário de integração
  dedicado, somente leitura (ver checklist em `docs/integracao-sap.md` §7), e trocar a senha
  do `ven040` que ficou exposta.

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

## 3b. Publicação — resolvido pela Cloudflare (06/08/2026)

O GitHub abriu incidente crítico de Actions/Pages às 15:22 de 06/08/2026
(stspg.io/rcz3fcm83sff): build sempre verde, publicação em timeout por horas. A saída foi
publicar na **Cloudflare Workers**, que clona o repositório e constrói na infraestrutura
dela, sem passar pelo GitHub Actions.

**Endereço em produção: https://tsi.veneza.app.br** (raiz, sem `/Ensaque/` — ver
`wrangler.jsonc`). Publica sozinha a cada push no `main`, ~2 min.

O domínio `veneza.app.br` passou a ter o DNS na Cloudflare em 07/08/2026 (nameservers
`huxley`/`ulla`, trocados no Registro.br). Foi preciso porque domínio próprio em Worker
exige a zona na Cloudflare — CNAME apontando para `workers.dev` a partir de DNS externo não
funciona. O DNSSEC do Registro.br saiu junto, e a **Central de aplicativos** que roda no
apex (`veneza.app.br`, GitHub Pages, seis módulos) continuou intocada: os 4 registros A e o
CNAME do `www` foram copiados iguais e ficaram em **DNS only** (nuvem cinza) — em laranja a
Cloudflare entraria no caminho e quebraria a renovação do certificado do GitHub.

O endereço `ensaque.arion-pereira.workers.dev` continua servindo o mesmo Worker, mas
redireciona (301) para o definitivo — ver `worker/index.ts`.

**O GitHub não publica mais** (decisão de 06/08/2026, depois que o incidente fechou e o
Pages continuou servindo o build pré-incidente). `.github/workflows/testes.yml` só roda
testes, lint e build de verificação; o job `publicar` está no histórico do arquivo caso um
dia se queira voltar. A branch `gh-pages` guarda apenas uma página que redireciona
`arionveneza.github.io/Ensaque` para `tsi.veneza.app.br` — desligar o Pages faria o
endereço antigo dar 404, e quem tem o link salvo no tablet merece ser levado ao lugar certo.

### SQL pendente de execução
- [x] `supabase/turnos-por-dia.sql` — confirmado aplicado em produção (validação de
      08/08/2026: `dias_producao.turno1/turno2` e `ordens.data_prog_original` existem).
- [x] `supabase/fecha-rpc-sem-guarda.sql` — aplicado e confirmado em produção em 08/08/2026
      (as duas RPCs recusam anônimo com `42501`, `tem_acao()` devolve `false` nunca `null`).
- [x] `supabase/trancar-rpc-anon.sql` — aplicado e confirmado em 08/08/2026. Ver §5.
- [x] `supabase/liberacao-lote-por-ordem.sql` — aplicado e confirmado em produção em 10/08/2026:
      liberação de lote passa a ser por ORDEM, não por lote inteiro (ver `CLAUDE.md` §1,
      "Lotes de semente"). Recriou a cadeia toda de views (`v_ordens` e as 5 dependentes,
      as 6 com `security_invoker`) e as RPCs `baixar_lote`/`estornar_lote` com assinatura
      nova (1 arg em vez de 3/2, sem ambiguidade). De brinde, corrigiu a armadilha abaixo
      (`v_ordens` sem as colunas de reprogramação). Backfill liberou 3 ordens que já
      estavam efetivamente prontas. Na primeira tentativa o backfill falhou com "Editar a
      ordem exige a acao Editar" — rodar UPDATE em `ordens` pelo SQL Editor não tem usuário
      logado, e a checagem dedicada de `lote_liberado_*` em `tg_ordens_por_acao` exige
      `tem_acao('lotes','baixar_lote')`, sempre `false` sem sessão; corrigido desligando só
      esse gatilho em volta do UPDATE do backfill.
- [x] `supabase/estorno-liberacao-por-ordem.sql` — aplicado e confirmado em produção em
      10/08/2026: o estorno também passa a ser por ORDEM (a liberação já era desde o script
      anterior; só o estorno ainda desfazia todas as ordens liberadas do lote de uma vez).
      Substituiu `estornar_lote(text)` por `estornar_liberacao(uuid)` (uma ordem só) e
      acrescentou `devolver_lote_orfao(text)` para o caso raro de lote `Baixado` sem nenhuma
      ordem dependente. `baixar_lote(text)` não mudou — baixa continua em bloco, por lote.
- [x] `supabase/renumerar-ordem-tocada.sql` — aplicado e confirmado em produção em 11/08/2026:
      PCP pode corrigir o **número** de uma ordem já tocada pela produção (Em produção,
      Parada, Finalizada, Qualidade apontada) — não entra em cálculo nenhum, então corrigir
      não distorce nada. Trava de novo em `Apontada` (já foi para o AGROTIS): achado ao
      implementar que `fn_ordem_imutavel` nunca checou a coluna `numero` em NENHUM status
      tocado — o banco sempre permitiu essa edição, inclusive em `Apontada`; só a tela nunca
      expunha. A migração fechou esse caso específico no próprio trigger, não só escondendo o
      botão.
- [x] `supabase/confirmar-ordem-programada.sql` — aplicado e confirmado em produção em
      11/08/2026 (relatado pelo Arion): dar máquina/dia a uma ordem não deveria já expô-la
      para a Logística baixar o lote, sem revisão do PCP (nem impressa, nada). O status
      derivado ganhou um passo — `Programada` (já existia no tipo, nunca era alcançado) —
      entre "tem máquina" e "Aguardando lote": só depois que o PCP clica "confirmar" (botão
      novo em Ordens) a ordem segue adiante e aparece para a Logística. Tocou `Ordens.tsx`,
      `Lotes.tsx` (a fila "a baixar" exige ordem confirmada, não só não-iniciada) e
      `Programacao.tsx` (o quadro do dia ganhou um grupo `Programada`, senão a ordem sumia
      da célula sem aparecer em nenhum status). Revisão adversarial pegou dois problemas
      reais antes de aplicar: (1) o backfill esbarraria na mesma armadilha do
      `tg_ordens_por_acao` sem sessão (corrigido com disable/enable trigger, igual à
      migração de 10/08); (2) `baixar_lote` não checava `confirmada_em` — o clique em
      "Baixar" (que a tela só soma sobre ordens confirmadas) liberaria por baixo dos panos
      qualquer ordem `Programada` do mesmo lote também, que pularia direto para `Pronto
      para produzir` ao ser confirmada, sem passar por `Aguardando lote` nem a Logística
      agir de propósito — corrigido acrescentando `confirmada_em is not null` ao `WHERE` da
      função. Backfill confirmou automaticamente 12 ordens já programadas, preservando o
      estado observável de antes da migração.

## 5. RPC executável por anônimo — achado na validação de 08/08/2026, corrigir já

Testando o domínio novo (`tsi.veneza.app.br`) contra o Supabase direto, com a chave
**anon pura, sem login nenhum**: `abastecer_tanque` e `definir_tanque_produto` executaram
— chegaram na lógica de negócio (uma devolveu "Tanque nao encontrado", a outra um erro de
FK) em vez de recusar por falta de permissão.

Causa: `tem_acao()` devolve **NULL** para quem não tem perfil (nem linha em
`perfil_permissoes`, nem `meu_perfil() = 'Gestor'` — os dois lados do `coalesce` avaliam
NULL). Em PL/pgSQL `if not NULL then` nunca entra no bloco — não é `true`, é `NULL`. Toda
RPC escrita com `if not tem_acao(...) then raise exception` está vulnerável **por padrão**
a partir de agora, a menos que `tem_acao()` nunca devolva NULL.

Todas as RPCs de apontamento anteriores (`baixar_lote`, `confirmar_inicio`, `confirmar_fim`,
`registrar_parada`, `retomar_producao`, `voltar_para_producao`, `cancelar_inicio`,
`apontar_qualidade_final`) já tinham `revoke execute … from public, anon` explícito de
outras migrações — só estas duas, criadas depois, ficaram sem. O `revoke` sozinho já
resolvia as duas; `supabase/fecha-rpc-sem-guarda.sql` faz os dois: revoga as duas E
envolve `tem_acao()` em `coalesce(…, false)`, para a próxima função escrita no padrão
de sempre já nascer segura.

**Aplicado e confirmado em produção em 08/08/2026.** A auditoria completa (todas as funções
que `anon` conseguia executar) revelou mais duas RPCs reais no mesmo estado:
`excluir_lotes_sem_uso` (que APAGA lotes) e `contar_lotes_sem_uso`, ambas com a mesma guarda
furada de NULL (`meu_perfil() not in (...)`). Fechadas por `supabase/trancar-rpc-anon.sql`.

**O "fecha sozinho" NÃO funciona neste Supabase — não insistir.** Tentei
`alter default privileges in schema tsi revoke execute on functions from public` (e de
`anon`): a regra grava certo em `pg_default_acl`, mas função nova continua nascendo com
`EXECUTE` para o PUBLIC embutido — que não aparece na regra e não é suprimido por ela neste
ambiente (testado à exaustão, `has_function_privilege('anon', ...)` seguia `true`). O
mecanismo que FUNCIONA é revogar por função. `supabase/trancar-rpc-anon.sql` faz isso em
laço para toda função do schema exceto os 3 ajudantes de RLS (`meu_perfil`, `tem_acao`,
`pode_baixar_lote`, que precisam ser anon-executáveis senão a policy dá erro em vez de
devolver vazio) — e é **reexecutável como passo final de toda migração que criar função**.
`supabase/auditoria-rpc.sql` lista quem `anon` ainda executa: depois de qualquer migração,
rodar e conferir que só sobram os 3 ajudantes.

## 4. Melhorias técnicas conhecidas

- **`schema.sql` não contém a camada de RLS/RPC nova.** As policies via `tem_acao`, as RPCs
  transacionais e os triggers de 05/08/2026 vivem nos scripts `baixa-atomica-*`,
  `matriz-permissoes-*`, `quantidade-produzida` e `exclusao-exige-ordem-virgem` (a ordem de
  aplicação é essa). O schema.sql recebeu só as partes estruturais (colunas, triggers de
  validação). Um dia vale consolidar tudo nele; até lá, **banco novo = schema.sql + estes
  5 scripts, nesta ordem**: `matriz-permissoes-no-banco` → `baixa-atomica-e-rls-apontamento`
  → `quantidade-produzida` → `exclusao-exige-ordem-virgem` → `tanque-por-ordem`.
  Cuidado ao reaplicar `schema.sql` sobre banco existente: as funções são `create or
  replace`, então ele **rebaixa** as versões que os scripts depois melhoraram.
- **Status `Cancelada` (anular ordem que já produziu) não existe.** Excluir agora é só para
  ordem virgem; se a operação precisar tirar da programação uma ordem com história (refugo,
  erro grave), o caminho seria um status que preserva tempos/consumos/qualidade fora do
  balanço. Escopo novo — só fazer se a operação pedir.

- **A matriz da Administração manda no banco** (decisão de 05/08/2026, script
  `matriz-permissoes-no-banco.sql`): a função `tem_acao(recurso, ação)` resolve a permissão
  igual ao app — linha explícita em `perfil_permissoes` vence, ausência cai no padrão de
  fábrica — e TODAS as policies de escrita a usam. O padrão de fábrica vive em DOIS lugares
  que precisam andar juntos: `src/dominio/permissoes.ts` (MATRIZ_PADRAO) e o `values` dentro
  de `tem_acao`. Mudou um, mude o outro. Fora da matriz, de propósito: a tela Administração
  (hard-coded Gestor — é ela que conserta a matriz) e as regras de negócio (histórico
  imutável, pesos obrigatórios, AGROTIS exige conferência), que são trigger para todo perfil.
- **Apontamentos e baixa são RPCs transacionais** (`confirmar_inicio`, `registrar_parada`,
  `retomar_producao`, `confirmar_fim`, `voltar_para_producao`, `cancelar_inicio`,
  `baixar_lote`, `estornar_lote`): evento + status + descartes valem juntos ou nada muda.
  Eventos de ordem têm unique em (ordem_id, tipo) — 'inicio' duplicado inflando tempo
  bruto (caso 131104) não volta. Mudar status de lote fora da RPC é recusado por trigger
  para qualquer perfil.
- **Transição de status fora do fluxo (ex.: reabrir Finalizada) exige `ordens/editar`**
  (trigger `tg_ordens_por_acao`) — na prática PCP/Gestor. Risco aceito e agora controlável
  pela matriz; o trigger também confere a ação certa por grupo de coluna (apontar, priorizar,
  programar, lançar AGROTIS, editar).

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
- **OEE e Painel TV (08/08/2026).** Indicadores tem OEE = Disponibilidade × Performance ×
  Qualidade, calculado sobre UMA população (as ordens com checklist final), para os três
  fatores medirem as mesmas ordens — o rótulo diz "N de M medidas". Disponibilidade usa a
  OPERACIONAL (líquido ÷ (bruto − paradas planejadas)), padrão Nakajima: parada planejada
  não penaliza. Qualidade = taxa de aprovação do checklist final (umidade+pó OK, recobrimento
  ≥ `RECOBRIMENTO_MINIMO_OEE`, hoje 3) — é o proxy possível, já que nada é refugado. O **Painel
  TV** (botão no cabeçalho, `src/telas/Painel.tsx`) é tela cheia para a fábrica: máquinas,
  cronômetro, parada, resumo do dia + OEE; atualiza por realtime + refetch de 30s.
- **Falta um ErrorBoundary no topo** (App.tsx só tem Suspense). Um throw no render derruba a
  árvore inteira = tela branca sem recuperação — pior no Painel, que fica sozinho na TV. O
  crash concreto conhecido (motivo de parada desconhecido em `temposOrdem`) foi removido em
  08/08/2026, mas um ErrorBoundary com "recarregar" pega a classe toda. Recomendado.
- **`formataHms` não tem teto de horas**: uma ordem deixada aberta por dias mostra o
  cronômetro gigante do Painel com string longa que pode vazar. É higiene de dado (ordem
  aberta há dias é o próprio alarme), mas se incomodar, encolher a fonte ou capar.
- **Testes**: só de domínio e dois de componente. Não há teste de fluxo ponta a ponta.
- **Cadastros** cobrem produtos químicos, receitas, máquinas, turnos, embalagens, motivos e
  lotes de semente.

---

## Armadilhas já pagas — não repetir

**Novo filtro de visibilidade na tela não basta — auditar toda função de banco que age em
lote sobre o mesmo recurso.** Ao criar o gate de confirmação do PCP (11/08/2026), a revisão
adversarial (não eu sozinho) pegou que `Lotes.tsx` passou a exigir ordem confirmada para
mostrar "a baixar", mas `baixar_lote()` continuava liberando por `status`/`lote_id` crus, sem
checar `confirmada_em` — o clique em "Baixar" arrastaria uma ordem `Programada` do mesmo lote
por baixo dos panos, mesmo ela nunca tendo aparecido na tela para a Logística decidir. A
regra: toda vez que um novo campo mudar QUEM UMA TELA MOSTRA, perguntar também "que RPC/função
age sobre esse mesmo recurso sem passar pela tela — ela também precisa do novo filtro?"

**Teste de tela que usa `vi.mock` com `vi.importActual` sobre um módulo que importa
`@/lib/supabase` passa na sua máquina e quebra sempre no CI — achado em 11/08/2026.**
`Cadastros.test.tsx` mockava `@/dados/api`/`api-gestao`/`api-admin` espalhando
`{...real, funcaoX: ...}`, e `vi.importActual` PRECISA carregar o módulo real para conseguir
espalhar — o que carrega `@/lib/supabase`, que lança `Error` se
`VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` não existirem. Na minha máquina existem
(`.env.local` local, com credenciais reais) — no GitHub Actions não existem (`.env.local` é
gitignored de propósito), então o teste passava sempre local e falhava sempre lá, quebrando 3
commits em sequência sem eu notar (só a checagem manual do run no GitHub pegou). Corrigido
trocando por mocks TOTALMENTE inline (sem `importActual`, sem espalhar nada do módulo real) —
testado removendo `.env.local` E `.env.test` na hora, simulando o CI exatamente, antes de
confiar que resolveu. Regra: teste de componente nunca deve precisar do módulo real de
`@/dados/*`/`@/lib/supabase`; se `vi.mock` precisa de algumas funções, listar cada uma à mão
no factory, nunca `{...await vi.importActual(...)}`.

**Backfill de migração por UPDATE direto em `ordens` pode ser recusado pela própria checagem
de permissão que ele acabou de criar — achado em 10/08/2026.** O SQL Editor do Supabase não
tem usuário logado: `auth.uid()` é `null`, então `meu_perfil()` é `null` e `tem_acao(...)`
devolve **sempre `false`** (é a blindagem anti-NULL de 08/08 fazendo o trabalho certo — só que
aqui contra quem não devia). Qualquer coluna de `ordens` que ganhe checagem DEDICADA em
`fn_ordens_por_acao` (padrão usado por `prioridade_*`, `agrotis_*`, e agora `lote_liberado_*`)
vira um UPDATE-de-DBA impossível de rodar puro pelo editor: a checagem dispara e recusa com
"Editar a ordem exige a acao Editar", mesmo a migração estando certa. Reordenar os passos do
script (criar a função antes do backfill) NÃO resolve — o problema não é qual versão da função
está ativa, é que `tem_acao()` é `false` para QUALQUER versão sem sessão. A saída é desligar só
o gatilho específico em volta do UPDATE: `alter table ordens disable trigger tg_ordens_por_acao;`
... `update ...` ... `alter table ordens enable trigger tg_ordens_por_acao;` — cirúrgico, os
outros gatilhos de `ordens` (ex.: `fn_ordem_imutavel`) continuam de pé. Ao escrever nova
migração que dê `alter table ... add column` seguido de backfill nessa MESMA coluna, e a coluna
for entrar em checagem dedicada (não só no `ignorar` genérico), já sair com esse disable/enable
em volta do UPDATE.

**Ordenar a fila por urgência DEPOIS de gravar a sequência faz o arraste parecer quebrado.**
O quadro da Programação ordenava por `(urgente, seq)`. Arrastar uma ordem normal para o topo
gravava `seq = 1` certinho, e a tela continuava mostrando a urgente em cima — o usuário via
"não moveu". Hoje Programação e Execução ordenam **só por `seq`**; urgência é etiqueta, e
quem reordena por urgência é o "Otimizar sequência", quando pedido. Regra geral: se a tela
permite ordenar à mão, nenhuma outra regra pode reordenar por cima.

**`dragover` dispara a cada pixel.** Um `setState` por evento repinta o quadro inteiro
durante o arraste e dá a sensação de travamento. O `marcarAlvo` da Programação compara antes
de trocar o estado e devolve a mesma referência quando nada mudou, para o React desistir do
render.

**Arrastar-e-soltar de HTML não existe em tela de toque.** O quadro é usado em tablet, onde
os eventos `drag*` simplesmente não disparam — sem uma alternativa por botão (o "mover", com
selects de máquina, dia e posição), a tela fica inutilizável lá, e ninguém reporta isso como
bug porque parece "o tablet que não pega".

**Capacidade do dia não é constante.** Desde 06/08/2026 ela vem de `capDia(maquina, dia)`,
que consulta os turnos daquele dia (`dias_producao`). Ao criar cálculo novo que envolva
capacidade, receber a função — não multiplicar por 234 nem por `capacidadeDiaT`, que é só o
padrão de dia cheio usado como fallback.

**Horário de apontamento é SEMPRE do servidor.** O relógio do navegador do chão de fábrica
não é confiável: em 05/08/2026 a ordem 131104 ficou com uma parada cujo `fim` (gravado com
`new Date()` no cliente) era ~2 h ANTES do `inicio` (default `now()`, servidor) — duração
negativa, e o líquido (2h23) saiu maior que o bruto (26 min), estragando aderência e
disponibilidade. Hoje todo horário de apontamento nasce dentro das RPCs (`now()`), há
`check (fim is null or fim >= inicio)` em `ordem_paradas`, e tanto a view `v_ordem_tempos`
quanto `temposOrdem` em `calculos.ts` usam `greatest(0, …)`/`Math.max(0, …)`. Ainda vêm do
cliente, por serem informativos e não entrarem em cálculo de duração: `ordem_conferencias.ts`,
`prioridade_em` e `agrotis_em` — se algum dia entrarem em conta, mover para o servidor.

**Tirar foto no Android recarrega a página — todo formulário com upload de imagem precisa
de rascunho.** Abrir a câmera nativa some com a aba do navegador da memória; ao voltar, o
Chrome recarrega a URL do zero. Foi o que travava a Qualidade final num ciclo de
câmera → tela limpa → câmera: o estado do formulário (nota, fotos já tiradas, qual ordem
estava aberta) vivia em `useState` e morria a cada volta. A correção tem duas partes —
(1) persistir em `useRascunho` **qual formulário está aberto**, não só o conteúdo dele,
porque a própria pergunta "que tela eu estava vendo" também não sobrevive; (2) fotos como
**dataURL (texto)**, nunca `File`: o objeto `File` é referência a um blob que a navegação
descartada invalida, e o rascunho (localStorage) só guarda texto/JSON. Reduzir a imagem
(1600 px) ANTES de guardar no rascunho evita explodir a cota do localStorage com o Base64
de uma foto de 8 MB. Ao criar qualquer tela nova com `<input type="file" capture="...">`,
repetir o padrão.

**A parte (1) acima ("qual formulário está aberto") foi esquecida em Cadastros — achado em
10/08/2026, relatado pelo Arion: "o de receita fica vazio" depois de Alt+Tab no Chrome
(Memory Saver recarrega a aba em segundo plano, mesmo efeito da câmera do Android).**
`FormReceita`/`FormProduto` já guardavam o CONTEÚDO certo via `useRascunho`, mas `aba`
(qual aba do Cadastros) e `editando`/`novo` (qual receita/produto estava aberto) eram
`useState` comum — reload trocava a aba para "Produtos químicos" e escondia o formulário,
com o rascunho intacto mas invisível. Corrigido replicando o padrão da Qualidade em
`Cadastros.tsx`: `aba`, e o `editando`/`novo` de Receitas e Químicos agora também vivem em
`useRascunho`. Teste de regressão em `Cadastros.test.tsx` (desmonta e remonta o componente,
confere que a aba e o formulário voltam abertos com o texto digitado). Não estendido às
outras abas (Máquinas, Embalagens, Motivos) — são edições de 1 linha, 2-3 campos, baixo
custo de redigitar; o padrão vale a pena só onde perder o formulário dói de verdade.

**Aba em segundo plano congela o cronômetro.** Sleeping tabs / modo de eficiência do Edge (e o
throttling do Chrome) suspendem `setInterval` e o websocket do realtime: o tempo decorrido
parava e a tela ficava desatualizada. A tela Execução resincroniza relógio e dados no
`visibilitychange`/`focus` — ao criar outra tela com cronômetro, repetir o padrão.

**Coluna nova em `ordens` precisa entrar em `fn_ordens_por_acao`.** O gatilho tem a lista
`ignorar` com as colunas cobertas por checagem específica; o que sobra cai na regra final e
exige `ordens/editar`. Em 06/08/2026 `bags_produzidos` nasceu sem entrar na lista e
**finalizar ordem virou ação de administrador** — a Produção parou de conseguir fechar
ordem, com a mensagem "Editar a ordem exige a acao Editar". Ao acrescentar coluna em
`ordens`, decidir a qual ação ela pertence e colocá-la nos dois lugares.

**Trava de edição usa `jaIniciada`, não `emAndamento`.** `emAndamento` é só
`Em producao`/`Parada` — usá-lo para travar destrava tudo de novo quando a ordem chega em
`Finalizada`. Foi o que deixou mudar tanque e peso inicial de ordem já produzida.

**Validação de início só vale na transição de início.** `fn_valida_inicio` dispara em
`before update on ordens`, e `Em producao` é alcançado por TRÊS caminhos: `confirmar_inicio`
(de `Nao programada`/`Programada`), `retomar_producao` (de `Parada`) e `voltar_para_producao`.
Testar `old.status <> 'Em producao'` pega os três — em 06/08/2026 isso travou o retomar de
ordem em andamento que não tinha `ordem_produtos`, e a única saída pela tela seria o Cancelar
início, que apaga tempo e testes de qualidade. Sempre escopar com
`old.status in ('Nao programada','Programada')`.

**Leitura de balança não some como efeito colateral.** `definir_tanque_produto` remove o
tanque que ficou sem produto, mas nunca um que já tenha `peso_inicial`/`peso_final` — o
operador digitou aquilo olhando a balança. Vale a regra geral: apagar dado apontado só por
ação explícita de quem apontou.

**O tanque é da ORDEM, não da receita** (06/08/2026). `receita_itens` tem só produto e dose; o
destino de cada produto fica em `ordem_produtos`, escolhido pelo operador ao preparar. Não
devolver a coluna `tanque` à receita — a distribuição muda a cada ordem.
`montaTanques(receita, alocacao)` monta os tanques a partir dessa escolha, e o tanque só passa
a existir quando algum produto é destinado a ele (RPC `definir_tanque_produto` cria e remove).
`cancelar_inicio` descarta a distribuição junto com os tanques. Aplicar
`supabase/tanque-por-ordem.sql` **depois** de `matriz-permissoes-no-banco.sql` (usa `tem_acao`).

**Trocar de tela DESMONTA o componente e apaga o formulário.** O App renderiza
`{atual === 'ordens' && <Ordens />}`: sair de Ordens para ver um lote destrói todo o estado
local, e o PCP perdia a ordem digitada pela metade (relatado em 06/08/2026). Formulário longo
usa `useRascunho` (`src/lib/useRascunho.ts`), que persiste no localStorage e restaura na
montagem — sobrevive também a F5, a fechar a aba e ao tablet dormindo. Ao criar formulário
novo, usar o hook e **chamar `limpar()` depois de gravar**, senão o próximo abre com o
rascunho velho. Já cobertos: nova ordem, edição de ordem e receita.

**`tem_acao()` nunca pode devolver NULL — só true ou false.** NULL some em silêncio em
qualquer `if not tem_acao(...) then raise exception`: `not NULL` é `NULL`, não `true`, e o
bloco não dispara. Foi assim que `abastecer_tanque` e `definir_tanque_produto` (08/08/2026)
ficaram chamáveis por um usuário **anônimo, sem login** — a checagem parecia estar lá, mas
não disparava para quem não tem perfil nenhum. Consertado com `coalesce(…, false)` no nível
mais externo de `tem_acao`. **Atenção: função nova AINDA nasce executável por `public`** —
o `ALTER DEFAULT PRIVILEGES` foi testado à exaustão em 08/08/2026 e NÃO funciona neste
Supabase (o script `privilegio-padrao-fecha-funcoes.sql` foi criado e apagado no mesmo dia
por isso). Toda migração que cria RPC precisa do par `revoke … from public, anon` +
`grant … to authenticated` na própria migração, e `auditoria-rpc.sql` é o cinto de
segurança que confere depois.

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

**`flex-1` some com o texto quando o vizinho não encolhe (08/08/2026).** `flex-1` é
`flex-basis: 0` — o cálculo de "cabe numa linha?" do `flex-wrap` ignora o conteúdo desse item
e olha só o vizinho que não é flexível. Em `Lotes.tsx` isso espremia o bloco de texto da
`LinhaLote` a ~16 px de largura (uma letra por linha) em vez do bloco de números quebrar para
a linha de baixo — só apareceu testando no celular de verdade, o code review anterior não
pegou. Corrigido empilhando por padrão (`flex-col`) e só virando `sm:flex-row` a partir do
tablet, onde sempre coube. Regra: `flex-1` ao lado de um irmão de largura fixa É candidato a
colapsar no mobile — testar ou preferir empilhar por padrão.

**View `select o.*` NÃO ganha coluna nova sozinha — achado em 10/08/2026.** Uma view criada com
`o.*` congela a lista de colunas no momento do `create`/`replace`; `alter table ... add column`
depois não aparece nela até um `create or replace view` (ou, se a coluna precisa entrar no meio
de colunas explícitas depois do `*`, um `drop view ... cascade` + recriação completa — Postgres
não deixa reposicionar coluna por `replace`). Foi assim que `v_ordens` ficou **sem**
`data_prog_original`/`reprogramacoes`/`reprogramada_em` (adicionadas em 08/08/2026): o
comentário no script de origem dizia "a view já expõe sem recriar nada" — verificado como falso
contra o banco real (REST API, login de teste) antes de confiar. As colunas "Dia original" e
"Reprogramada" do relatório de Ordens ficaram silenciosamente vazias por 2 dias. Corrigido de
brinde em `supabase/liberacao-lote-por-ordem.sql`, que já precisava recriar a view em cascata
por outro motivo. Regra: **toda vez que a view mudar, comparar o `pg_get_viewdef` contra o
banco**, nunca contra o que o último script de origem diz que criou.

**Tabela com coluna oculta redistribui a largura livre sem avisar (08/08/2026).**
`table-layout: auto` (padrão do HTML) manda a largura que uma `hidden lg:table-cell` liberou
para QUALQUER coluna vizinha, não necessariamente a que precisa — em `Ordens.tsx` a coluna de
ações (editar+urgente+excluir, ~160 px) ficou com só 96 px e os três empilharam verticalmente,
inflando a linha para 113 px; em `Programacao.tsx` o `<select>` de turno encolheu para 66 px e
cortou o texto da opção no meio da palavra (`<select>` nativo não faz ellipsis). Os dois só
apareceram no aparelho real, não no code review. Correção: `min-w-*` explícito (com
`lg:min-w-0` para não afetar o desktop) na célula que precisa de espaço garantido — a tabela já
rola horizontalmente por desenho, então só sobra um pouco mais de scroll, não quebra layout.
Aplicado também em `Indicadores.tsx` (tabela de paradas): `Motivo` ganhou `min-w-28` e as
colunas `Máq.`/`Turno` (menos essenciais que Motivo/Tipo/Duração) viraram `hidden lg:table-cell`
com o resumo "máquina · turno" numa linha pequena sob o número da ordem — mesmo padrão de
Ordens/Etapas.
