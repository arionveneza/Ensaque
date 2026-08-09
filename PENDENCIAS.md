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
| Testes | 153, rodam antes de cada deploy — teste vermelho não publica |
| Integração SAP | **Fora do app; caminho 100% validado em 09/08/2026**: Basic Auth + endpoint próprio de homolog descoberto — pipeline completo rodou lá, saldo por lote incluso. Em produção falta só replicar a autorização de `SQLQueries` — ver `docs/integracao-sap.md` |

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
mais externo de `tem_acao`. E desde `privilegio-padrao-fecha-funcoes.sql` (mesmo dia) o
Postgre já não libera função nova para `public` por padrão — as duas defesas se somam,
nenhuma dispensa a outra: a de hoje fecha a porta por padrão; a de ontem garante que, se
algum dia alguém abrir a porta de propósito, a checagem por dentro não falha em silêncio.

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
