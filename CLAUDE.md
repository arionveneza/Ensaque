# TSI — Sistema de Controle de Tratamento Industrial de Sementes

> **Contexto para o Claude Code.** Este projeto substitui a planilha `TSI 2025` (75 abas) por uma
> aplicação web multiusuário. Todas as regras abaixo foram validadas com a operação da Sementes Veneza
> e existem implementadas em `docs/prototipo-referencia.html` — um protótipo funcional em HTML/JS puro
> com 82 testes passando. **Use o protótipo como especificação executável**: quando houver dúvida de
> comportamento, abra-o e verifique.

## Stack alvo

- **Front-end**: React + TypeScript + Vite, Tailwind CSS, shadcn/ui, Recharts (gráficos), Framer Motion (transições leves)
- **Back-end**: Supabase (PostgreSQL + Auth + RLS + Realtime)
- **Deploy**: Vercel (front) + Supabase Cloud
- **Uso**: tablets no chão de fábrica (operação) e desktop (PCP/gestão). Layout responsivo obrigatório.

## Domínio em uma frase

Três máquinas (TSI 1, TSI 2 e, desde 19/09/2026, TSI 3 (DM), para volumes menores) tratam
sementes de soja com receitas químicas. O PCP programa ordens por
dia e máquina; a logística baixa os lotes de semente; a produção aponta início/paradas/fim e os pesos de
balança dos tanques; a qualidade avalia; o PCP encerra lançando no AGROTIS.

---

## 1. Entidades e regras de negócio

### Máquinas e capacidade
- 3 máquinas: **TSI 1**, **TSI 2** e **TSI 3 (DM)** (19/09/2026, pedido do Arion: "iremos
  produzir volumes menores nesta máquina" — DM = Difusão de Mercado; decisão dele: mesmo
  requisito das outras, 5 tanques, mesmos turnos, 12 t/h de partida ajustável em Cadastros).
  Cada uma com **5 tanques**. A lista de máquinas é a tabela `maquinas` (id sem espaço,
  `TSI3`; nome livre), lida em toda tela — **nada no código assume duas** desde a varredura
  de 19/09 (64 agentes): migração `maquina-tsi3.sql` (insert idempotente); Cadastros ▸ Máquinas
  ganhou **"Nova máquina"** (id/nome/capacidade/tanques/setup — antes máquina nova só
  entrava por SQL): grava por **INSERT** (`criarMaquina`; a PK barra id repetido — o upsert
  de `salvarMaquina` sobrescreveria em silêncio), com `confirm()` mostrando o id já
  normalizado porque **o id é definitivo** (a linha não o edita), nome repetido é recusado
  (o importador aceita o nome) e a mesma guarda de setup em branco da edição. **Excluir**
  na linha só funciona para máquina **sem história** — as FKs de `ordens` e
  `maquina_paradas` barram (23503) — é o desfazer da criação errada; não existe
  "desativar". Os cartões da Execução, do Painel TV e do quadro do dia
  passam a 3 colunas com 3+ máquinas (em 2 colunas o 3º caía sozinho e o cronômetro da TV
  perdia metade da altura) — na Execução o cartão foi **compactado** (nome 2xl, cronômetro
  3xl, capacidade em duas linhas curtas, recuos menores) e as 3 colunas valem já do tablet
  (`md`), pedido dele: "diminua os cards para que fiquem um ao lado do outro"; no Painel TV
  só de `xl` (1280 px): o cronômetro herói text-7xl mono tem ~330 px e não cabe em coluna
  de 1024. A ajuda da planilha de ordens lista as máquinas do cadastro e o importador
  aceita o **nome** além do id (`nomesMaquinas`, pares — nome que casa com duas máquinas é
  erro da linha, "ambígua no cadastro", nunca a primeira da lista). A trava do
  **Rebalancear** passou a exigir que a **diferença entre as duas máquinas encolha**, com
  as horas reais das duas filas depois da movida (setup incluído, `horasOrigemSem`) — a
  original ("metade da diferença") só fechava com capacidades iguais (máquina lenta vazia
  recusava a ordem que equilibraria; lenta cheia era esvaziada num clique), e a primeira
  correção, estimando o alívio da origem só pela produção, invertia o quadro por até um
  setup por movida e recusava a única ordem de uma máquina lenta estourada (achados da
  revisão adversarial, 254 mil casos aleatórios). Passar do ponto é permitido quando
  aproxima as duas; máquina com t/h zero fica fora do par. O Rebalancear segue
  tratando UM par por clique (a mais cheia → a mais vazia); com 3 máquinas a do meio entra no
  clique seguinte. **Máquina nova não chega por realtime**: `maquinas` está fora da
  publicação — recarregar o Painel TV e os tablets da Execução que ficam abertos o dia
  inteiro. **Fora de escopo, de propósito** (a TSI 3 tem 5 tanques e os mesmos turnos):
  seletor de tanque do ModalOrdem fixo em `[1..5]` e CHECK `tanque between 0 and 5` no SQL
  (`maquinas.qtd_tanques` é só informativo, e o campo diz isso), horas/turnos por máquina
  (`dias_producao` é por dia), coluna `ativa` ignorada pelo front (leitura e escrita), seq
  das movidas do Rebalancear só acrescenta ao fim (`base + n`, sem renumerar a célula).
- Capacidade **12 t/h por máquina** (configurável).
- **Recurso único**: uma máquina roda **uma ordem por vez**. Ordem `Parada` também ocupa a máquina.

### Turnos (2) — NÃO são programados
- Turno 1: 07:30–17:30 (10h) · Turno 2: 17:30–03:00 (9h30).
- **O turno não entra na programação.** É *derivado* do horário real do apontamento de início:
  início até 17:30 → T1; depois → T2.
- **Dia de produção** = 07:30 até 03:00 do dia seguinte. O turno 2 cruza a meia-noite e pertence
  ao dia que começou.
- Capacidade/dia por máquina = 12 t/h × 19,5 h = **234 t** — nominal. **A Programação conta
  em HORAS e cobra setup entre ordens** (13/09/2026, ver §3 Ocupação): cada máquina tem no
  cadastro `setup_mesmo_min` (padrão 20 — a ordem seguinte tem o MESMO tratamento, mesmo
  com outro cultivar) e `setup_troca_min` (padrão 40 — o tratamento muda, envolve limpeza);
  sem setup antes da primeira ordem do dia (migração `setup-por-maquina.sql`).
- **Quais turnos cada dia roda é do calendário** (decisão de 06/08/2026): nem todo dia tem os
  dois, e importa saber **qual** — só 1º são 10 h (120 t), só 2º são 9h30 (114 t). A tabela
  `dias_producao` (`turno1`/`turno2` booleanos) guarda **só a exceção**: dia sem linha roda os
  dois (234 t). Nenhum dos dois = sem produção, e o dia não recebe programação. Sem isso um
  sábado de um turno só aparecia com metade da ocupação real e a programação automática
  enfiava ordem que não caberia. Editável na linha **Turnos** do plano semanal; o cadastro de
  máquinas mostra a capacidade de cada turno e a do dia.

### Embalagens
| Código app | Código comercial (SimpleAgro) | Sementes | Peso do bag |
|---|---|---|---|
| BG5M | BB5M | 5.000.000 | PMS × 5 |
| MEIOBAG | BMB | 2.500.000 | PMS × 2,5 |
| SC10 | — | — | **10 kg fixo** |
| SC20 | — | — | **20 kg fixo** |

- **Dois modos de embalagem** (decisão de 24/08/2026): por SEMENTES (peso do bag = PMS ×
  fator, varia por lote) ou por PESO FIXO (`embalagens.peso_fixo_kg`, mesmo peso em qualquer
  lote — o PMS só muda quantas sementes cabem no saco). CHECK `embalagem_modo_valido` exige
  exatamente um dos modos. Precedência do peso do bag da ordem, idêntica no front
  (`pesoBagDaOrdemKg`) e no banco (`v_ordens`/`baixar_lote`, migração
  `embalagem-peso-fixo.sql`): `peso_fixo_kg → pms × fator_peso → peso_bag_kg do lote`.
- **SC10/SC20 vivem FORA dos ERPs** (decisão do Arion, 24/08/2026): pedido e saldo dessas
  embalagens não existem no SAP nem na SimpleAgro — nenhum importador as conhece
  (`EMBALAGEM_DEPARA` segue só BB5M/BMB) e o painel Demanda × Estoque × Planejado as isenta
  (mesmo padrão do SEM TSI: "sem pedido" seria alarme falso permanente). A baixa do lote
  generaliza sozinha: 1 saco de 10 kg consome `10 ÷ peso_bag_do_lote` bags do lote.
- Cadastro: a aba Embalagens cria embalagem nova (por sementes ou por peso fixo) e valida os
  modos — antes era só edição, sem validação nenhuma.

### Lotes de semente
- Vêm da planilha de **Saldos** da SimpleAgro (upload) — ver §4.
- **Peso do bag = PMS × 5** (BB5M) ou **PMS × 2,5** (BMB). Ex.: PMS 171 → 855 kg/bag.
- Status: `Em estoque` → `Baixado` (logística) → volta a `Em estoque` só por estorno.
  Serve só à Expedição (saldo de semente branca SEM TSI) — não decide se uma ordem pode produzir.
- **A liberação para produção é por ORDEM, não por lote** (decisão de 10/08/2026): o clique em
  "Baixar" continua sendo **um só por lote** (é uma viagem física ao depósito, que libera várias
  ordens de uma vez), mas o sistema carimba **cada ordem aberta daquele lote individualmente**
  (`ordens.lote_liberado_em`/`lote_liberado_por`). Uma ordem nova, criada depois — mesmo do
  mesmo lote, mesmo já `Baixado` para outras — **nasce sempre aguardando**; não existe saldo
  agregado do lote para herdar, nem quando uma ordem liberada é cancelada. Sem isso, uma ordem
  cancelada "doava" sua liberação para a próxima ordem do mesmo lote sem ação nenhuma da
  logística.
- **O estorno é por ORDEM** (decisão de 10/08/2026): desfaz a liberação de **uma** ordem
  específica, sem tocar nas outras do mesmo lote — se um lote tem 3 ordens liberadas e só 1
  foi por engano, estorna-se só ela. `lotes_semente.status` só volta a `Em estoque` quando,
  depois do estorno, **nenhuma** outra ordem do lote continuar liberada. Caso raro — lote
  `Baixado` sem **nenhuma** ordem dependente (ex.: a única ordem que dependia dele foi
  excluída depois de liberada) — não tem ordem para o estorno agir; a tela "Baixados sem
  ordem — devolver" cobre só esse caso, devolvendo o lote direto.

### Produtos químicos e receitas
- Cada químico tem **unidade de dose** (`ml/kg` ou `g/kg`) e **densidade em g/ml** (só para ml/kg).
- **A receita é definida por dose. A balança confere por peso.**
  - `ml/kg` → peso de balança (kg) = dose × peso_semente_kg × densidade / 1000
  - `g/kg`  → peso de balança (kg) = dose × peso_semente_kg / 1000
  - volume (L) = dose × peso_semente_kg / 1000 (informativo, só ml/kg)
- Nome da receita = **código do comercial** (FTZ60, V&P, DER + LMT, FTZ ELITE…) — língua única
  entre comercial e produção, sem tabela de-para.
- **Famílias de tratamento** (19/09/2026, pedido do Arion: "V&P e suas derivações, onde V&P é
  a base; Dermacor; Standak; FTZ60; FTZ Elite"): `src/dominio/tratamentos.ts` —
  `familiaDoTratamento(nome)` reconhece a família pelo COMEÇO do nome normalizado
  (`FAMILIAS_TSI`: V&P/VEP, DER/DERMACOR, STDK/STANDAK, FTZ ELITE, FTZ60 — cobre "FTZ 60 S" e
  "STANDAK TOP"); fora delas, o primeiro segmento antes do "+" é a família (FTZ80, SEM TSI).
  Família nova = uma linha em `FAMILIAS_TSI`. `compararTratamentos` = família → **menos itens
  na receita primeiro** (a base antes das derivações: "o FTZ60 + RCoMoNi + Lli tem mais itens
  que o FTZ60, então deveria vir depois") → nome. É a ordem da **Otimizar sequência**
  (`otimizarSequencia(fila, itensPorReceita)`: famílias com mais ordens primeiro, dentro da
  família por itens, dentro da receita por cultivar; sem `receitaNome` cada receita é a própria
  família e o resultado é o de antes) e da coluna Tratamento da lista do quadro do dia. A
  Programação carrega `listarReceitas()` uma vez para contar os itens.
- **A receita NÃO define o tanque** (decisão de 06/08/2026): ela é só **produto + dose**. A
  distribuição varia de ordem para ordem, então quem informa o destino de cada produto é o
  **operador**, ao preparar a ordem, antes dos pesos (tabela `ordem_produtos`).
- **Mistura em tanque**: só existem 5 tanques. Receita com mais de 5 produtos obriga o operador
  a juntar produtos num tanque. O planejado do tanque é a **soma** dos pesos dos produtos que
  ele colocou lá, e o Real vs Planejado compara contra essa soma.
- **Transferidor (destino 0)**: pó secante (grafite) nunca vai em tanque — o operador escolhe
  "Transferidor" em vez de T1–T5. Tem **pesagem (peso inicial/final) igual aos tanques**.
- **Reabastecimento durante a ordem** (decisão de 07/08/2026): o produto acaba no meio e o
  operador completa o tanque. O consumo real deixa de ser `inicial − final` e passa a ser
  **`inicial + Σ abastecimentos − final`** — 100 kg de início, mais 100 durante, 50 sobrando
  = 150 consumidos, não 50. Cada carga vira uma linha em `ordem_tanque_abastecimentos`, com
  hora e autor: o total é derivável, mas *quantas vezes precisou completar* não — e é isso
  que denuncia tanque pequeno demais para a receita. Só com a ordem `Em produção`/`Parada`.
- **Lote de químico está FORA do escopo** (decisão de 05/08/2026): não há cadastro de lote de
  químico, escolha na ordem nem trava no início. O cadastro de **produtos** químicos (com
  densidade) continua — é dele que sai o peso de balança.

### Peso de ensaque
`ensaque_por_bag = peso_do_bag_DA_ORDEM × 1,005 + (peso_químico_total_da_ordem ÷ bags_da_ordem)`

O ×1,005 é a **margem de meio por cento sobre o peso do bag** (decisão de 05/08/2026);
a margem não incide sobre a parcela de químico.

- **O peso do bag que entra em TODA conta é o da embalagem DA ORDEM** (decisão de
  13/08/2026): `pms × fator_peso(ordens.embalagem)`, com fallback no `peso_bag_kg` do lote
  quando o PMS é nulo. O `lotes_semente.peso_bag_kg` é congelado na importação com o fator
  da embalagem ORIGINAL do lote — usar ele numa ordem MEIOBAG de lote big bag dobrava peso
  de semente, químico, ensaque, tempo planejado e ocupação. Vale no front
  (`pesoBagDaOrdemKg`, calculos.ts), na `v_ordens` (`peso_bag_ordem_kg`, `peso_kg`,
  `peso_t` — migração `peso-por-embalagem-da-ordem.sql`) **e em `baixar_lote`**
  (`peso-por-embalagem-na-baixa-do-lote.sql`): 1 bag MEIOBAG consome **meio** bag do lote
  (2,5 milhões de sementes num lote de 5 milhões), não um bag inteiro — a primeira
  migração corrigiu a ordem e deixou a baixa de propósito ("a logística move os bags
  físicos do lote"), mas a conta da baixa nunca foi por bag físico do lote: é
  `soma(ordens.bags) × peso do lote`, e `ordens.bags` é contagem na embalagem DA ORDEM.
  `ordens.bags` cru (sem peso) continua valendo como contador informativo no relatório de
  baixas — só o `peso_t` gravado em `lote_movimentos` passou a ser por ordem.

- **Receita SEM PRODUTO é permitida** (decisão de 13/08/2026): é a receita de ensaque sem
  tratamento (ex.: `SEM TSI`) — a ordem roda sem tanque, sem pesagem e com químico zero; o
  "Confirmar início" dispensa a exigência de tanque montado nesse caso. O banco nunca
  impediu (as validações são todas `count de pendência > 0`); as travas eram só do front.

---

## 2. Ciclo de vida da ordem (matriz de permissões)

Status: `Não programada` → `Programada` → `Aguardando lote` → `Pronto para produzir` →
`Em produção` ⇄ `Parada` → `Finalizada` → `Qualidade apontada` → `Apontada`

`Programada`, `Aguardando lote` e `Pronto para produzir` são **derivados**. `Programada`
(decisão de 11/08/2026): dar máquina/dia a uma ordem não a expõe direto para a Logística
baixar o lote — programar é rápido, muitas vezes só reserva um horário, e a Logística não
devia agir sem o PCP ter revisado e confirmado de propósito (nem impressa, nada). Fica
`Programada` até o PCP clicar "confirmar" (botão próprio na tela de Ordens); só a partir daí
segue para `Aguardando lote`/`Pronto para produzir`, que é quando aparece para a Logística
(`ordens.confirmada_em`). `Aguardando lote`/`Pronto para produzir` continuam olhando a
liberação da **própria ordem** (`lote_liberado_em` nulo/preenchido), por ordem, não pelo
status do lote (§1, Lotes de semente) — e `baixar_lote` só libera ordem confirmada: uma
`Programada` do mesmo lote não é arrastada por baixo dos panos no clique de outra.

| Status | Editar | Excluir | Iniciar | Priorizar | Qualidade | Estorno do lote | Renumerar | Confirmar |
|---|---|---|---|---|---|---|---|---|
| Não programada | ✔ | ✔ | — | ✔ | — | ✔ | — | — |
| Programada | ✔ | ✔ | — | ✔ | — | ✔ | — | ✔ (só PCP) |
| Aguardando lote / Pronto para produzir | ✔ | ✔ | ✔ (só Pronto) | ✔ | — | ✔ | — | — |
| Em produção / Parada | ✖ | ✖ | ✖ | ✖ | ✖ | **✖** | ✔ (só PCP) | — |
| Finalizada / Qualidade apontada | ✖ | ✖ | ✖ | ✖ | ✔ | **✖** | ✔ (só PCP) | — |
| Apontada | ✖ | ✖ | ✖ | ✖ | ✖ | **✖** | **✖** | — |

**Regra de ouro:** antes de iniciar, tudo é editável; depois que a produção toca a ordem, ela é
registro histórico. Estorno de lote é bloqueado se **qualquer** ordem daquele lote já foi iniciada.

**Renumerar é a única exceção à regra de ouro** (decisão de 11/08/2026): o **nº da ordem** pode
ser corrigido em qualquer status já tocado pela produção — não entra em nenhum cálculo (tempo,
consumo, peso), então corrigi-lo não distorce nada, diferente dos outros campos. Ação exclusiva
de quem tem `ordens/editar` (PCP/Gestor) — a tela de Ordens mostra um botão "renumerar" separado
do "editar" para esses status; os demais campos continuam travados pelo trigger de imutabilidade.
**Trava de novo em `Apontada`**: nesse ponto o número já foi lançado no AGROTIS (ERP externo), e
corrigir aqui divergiria de lá sem ninguém saber — bloqueado tanto na tela quanto no próprio
trigger `fn_ordem_imutavel` (que nunca checava a coluna `numero`; era permissivo por omissão em
TODOS os status tocados, não só nos 4 que a tela libera de propósito).

**Excluir exige ordem virgem** (decisão de 05/08/2026): além do status, o banco recusa excluir
ordem com **qualquer história** — evento de produção, parada, teste de qualidade ou conferência
(trigger `tg_ordem_sem_historia`). Sem isso, o Cancelar início "lavava" o status e uma ordem
com testes de qualidade voltava a ser excluível em cascata, sem rastro. Tanques montados/pesos
digitados sem confirmação **não** bloqueiam (preparação é descartável); auditoria também não.

**Chave anti-duplicidade da ordem:** `nº ordem + cultivar + tratamento + embalagem`.

**Urgente e expedição prevista no formulário da ordem** (12/09/2026, pedido do Arion).
Urgente já existia (`prioridade`, ação `ordens/priorizar`), mas era um clique à parte
depois de criar; agora é caixa no formulário — só aparece com a ação, e no UPDATE as
colunas de prioridade só entram no payload quando mudam, porque o gatilho
`fn_ordens_por_acao` cobra Priorizar por elas (mandá-las iguais já contaria como toque).
`ordens.data_expedicao` (migração `ordem-data-expedicao.sql`) é a **data prevista do
caminhão**, opcional e informativa — NÃO é `data_prog` (quando a máquina roda). Fica fora
da lista `ignorar` do `fn_ordens_por_acao` (mudar exige `ordens/editar`, como cliente) e
fora do `fn_ordem_imutavel` porque não entra em cálculo nenhum — mas hoje só é editável
pelo formulário, enquanto a ordem não foi iniciada (`MATRIZ_STATUS.editar`); corrigir a
data do caminhão em ordem já rodada ficou como próximo passo (item no menu de ações, ao
lado do renumerar). Aparece na lista (coluna **Destaque**, numa vaga fixa DEPOIS da
etiqueta urgente — a vaga da etiqueta existe em toda linha, vazia quando normal, para o
"exp." nunca mudar de coluna: pedido do Arion de 19/09/2026, "mantenha o expedição sempre
no mesmo local, mesmo quando não tenha o card de urgente" — e na sub-linha do tablet), no
detalhe, na folha impressa, no .xlsx e na folha do quadro. A
`v_ordens` enumera colunas: coluna nova entra **no fim** do `select` (é a única forma que
`create or replace view` aceita). **Recriar view = repetir `alter view … set
(security_invoker = true)` e conferir no fim**: `create or replace view` zera as
reloptions, a view volta a rodar como `postgres` (bypassrls) e a chave anon lê a produção
inteira por ela — aconteceu com a primeira versão de `ordem-data-expedicao.sql` por cerca
de uma hora em 12/09/2026, pego pela revisão adversarial e contido no banco na hora.
**Datas de célula do Excel saem em UTC**: `dataIso` da importação de ordens usa
`toISOString().slice(0,10)`, nunca `getDate()` local (em UTC-3 gravava o dia anterior). A planilha de ordens ganhou as colunas opcionais
**Expedição** (mesmos formatos do Dia; ilegível é erro da linha) e **Urgente** (SIM/X/1/
URGENTE marcam; vazio/NÃO/NORMAL não) — a urgência pela planilha obedece à mesma ação
Priorizar da caixa do formulário: sem ela, a coluna é ignorada. **Programada depois do
caminhão** (`data_prog > data_expedicao`) ganha marca vermelha na lista de Ordens e a
etiqueta "após a expedição" no cartão da Programação — é o erro que a data existe para
evitar, e a Programação é onde o PCP escolhe o dia.

**Programar em lote pela demanda leva os mesmos campos do formulário** (12/09/2026):
o `ModalProgramarDemanda` (Programar → fila → lotes) ganhou um bloco "para todas as ordens
desta leva" — destinação (obrigatória, como no formulário), expedição prevista, máquina e
dia, e urgente (só com Priorizar) — aplicado a cada ordem criada; antes tudo nascia no pool
e o PCP abria ordem por ordem pra ajustar. **Destinação aparece embaixo do status** na
lista de Ordens e na tela Etapas, sempre pelo componente `Destinacao`
(`src/componentes/Destinacao.tsx`: pastilha neutra da largura da etiqueta de status,
traço apagado quando vazia). **Filtro de status nasce com tudo marcado menos Apontada**
(`ehFiltroStatusPadrao` evita listar isso no título da impressão). No cartão Bags por lote
a coluna SAP tem três vagas fixas (número · veredito `w-80` · ação); no painel de demanda,
quatro (situação · aguardando · na fila · Programar) — caixa de tamanho fixo em toda linha
é o padrão visual que o Arion pediu, e vale para os próximos cartões.

### Fluxo de execução em duas etapas (crítico — não simplificar)
1. **Iniciar** apenas *abre* a ordem para preparação. **Não** inicia o cronômetro.
2. Operador escolhe o **tanque de cada produto** (T1–T5 ou Transferidor) e informa o **peso
   inicial de cada tanque** — ambos obrigatórios. O tanque só existe depois que algum produto
   é destinado a ele.
3. **Confirmar início** → grava o evento, define o turno, ocupa a máquina.
4. Durante a produção o **peso final está travado**.
5. **Finalizar** apenas *libera* a pesagem final. **Não** finaliza.
6. **Confirmar finalização** exige a **quantidade produzida (bags)** — campo em branco,
   sem pré-preenchimento (vai para `ordens.bags_produzidos`). Peso final é **opcional**
   aqui (decisão de 05/08/2026): o operador anota na **folha impressa da ordem** e o
   **PCP digita na tela AGROTIS** — o lançamento exige todos os pesos (trigger).

Fechar a janela em qualquer etapa **não** muda o estado. `Cancelar início` descarta apontamentos
(com auditoria) e libera a máquina — usado quando o operador inicia a ordem errada. Se a ordem
já tem **testes de qualidade em processo**, o aviso diz quantos e eles são **apagados junto**
(decisão de 05/08/2026) — teste órfão em ordem "nunca produzida" seria corrupção de dado.
`Voltar para produção` desfaz um Finalizar clicado por engano: fecha a pesagem final e
descarta os pesos finais já digitados — a produção continuou, então serão pesados de novo
(decisão de 05/08/2026 — antes a única saída era o Cancelar início).

### Qualidade em 2 etapas + conferência (decisão de 05/08/2026)
O **checklist substituiu** o Aprovado/Reprovado + amostra. Campos, iguais nas duas etapas:
**qualidade geral do tratamento** (nota 1–5; a coluna no banco chama `recobrimento`, nome
histórico) · umidade do tratamento (OK/Fora do padrão) · desprendimento de pó (OK/Fora do
padrão) · observação. Em processo tem ainda a **origem da amostra (BOWL/BAG)**.
**Apenas informativos — nunca bloqueiam.**
- **Em processo**: com a ordem `Em produção`/`Parada`. Vários registros por ordem, com hora
  (histórico). Não muda status.
- **Final**: com a ordem `Finalizada`. Um registro por ordem → status `Qualidade apontada`.
  Aceita **até 3 fotos** (decisão de 07/08/2026), guardadas no bucket privado `qualidade` do
  Storage — a linha do teste só guarda o caminho. As imagens são reduzidas a 1600 px no
  navegador antes de subir: foto de tablet tem vários MB e travaria o envio na rede do galpão.
- **Ver os testes de uma ordem concluída**: a linha da tela Qualidade expande e mostra os
  testes em processo, o final e as fotos. Antes só o relatório `.xlsx` mostrava isso, e
  conferir uma reclamação exigia baixar a planilha inteira.
- **Conferência de estoque (Logística)**: para ordens finalizadas, a logística informa a
  **quantidade produzida que contou** — campo em branco, obrigatório, sem pré-preenchimento
  (contagem cega, decisão de 05/08/2026). A divergência compara com o **produzido** declarado
  pela produção (fallback: esperado). **É pré-requisito do AGROTIS** (trigger no banco).
- **Visão geral (tela Etapas)**: régua por ordem — Produção → Q. processo → Q. final →
  Conferência → AGROTIS.

### Encerramento (AGROTIS — tela própria)
Após a **qualidade final** e a **conferência de estoque**, o **PCP** lança a ordem no AGROTIS e
registra o **nº do lançamento** (obrigatório) → status `Apontada`, registro definitivo. Gancho
natural para integração futura.

---

## 3. Cálculos

### Tempos (por ordem)
```
bruto      = fim − início
paradas    = Σ (fim − início) de cada parada
líquido    = bruto − paradas
lead time  = fim − liberação/programação
disp. bruta        = líquido ÷ bruto                        (toda parada é perda)
disp. operacional  = líquido ÷ (bruto − paradas planejadas) (só perda real)
rendimento = toneladas ÷ líquido
planejado  = peso_t ÷ capacidade_th × 3600 (segundos)
```

**Motivos de parada têm tipo `Planejada` ou `Não planejada`.** Setup/troca de receita, limpeza,
refeição e manutenção preventiva são planejadas; quebra, falta de lote/químico/embalagem,
entupimento e queda de energia são não planejadas. Sem essa classificação o setup penalizaria a
disponibilidade como se fosse falha.

### Parada de MÁQUINA — o tempo que não pertence a ordem nenhuma
(12/09/2026, pedido do Arion: "não conseguimos mensurar o tempo que a máquina para por
aguardar semente".) Toda parada era de ordem — `ordem_paradas.ordem_id` é `not null` e
`registrar_parada` exige ordem `Em producao` —, então máquina ociosa não tinha onde
registrar nada e a hora perdida não existia. Tabela própria `maquina_paradas`
(migração `parada-de-maquina.sql`), **nunca** `ordem_paradas` afrouxada: afrouxar
contaminaria `v_ordem_tempos`, disponibilidade e OEE, todos ancorados na ordem por
`!inner`. **Parada de máquina não entra em `temposOrdem`, disponibilidade nem OEE** — é
outro eixo, máquina × dia, então não há dupla contagem.
- **Na Execução**, com a máquina livre e **nenhuma ordem `Pronto para produzir`**: botão
  **Aguardando semente** (um clique, motivo próprio semeado pela migração) e um
  **"outro motivo"** que abre o `ModalMotivoParada` — o mesmo seletor do detalhe da ordem,
  extraído para `src/componentes/ModalMotivoParada.tsx`. Com ordem pronta na fila o botão
  some: aí a semente está no galpão e o caminho é Iniciar. O cartão fica âmbar com o
  cronômetro, e o Painel TV mostra o mesmo.
- **Motivo separado do "Falta de lote de semente"** que já existia: aquele é parada NO MEIO
  da ordem (a semente acabou), este é ANTES dela (a semente não chegou).
- **Fecha sozinha** no `confirmar_inicio` da primeira ordem daquela máquina — exigir um
  "Encerrar" antes seria mais um toque para esquecer, e a parada esquecida correria por
  cima da produção. O botão Encerrar continua existindo.
- **Uma aberta por máquina**, por índice único parcial no banco, não por regra de tela.
- **Duração cortada no fim do dia de produção** (`duracaoParadaMaquinaS`): parada esquecida
  aberta no fim do expediente renderia a madrugada inteira e inflaria justamente o motivo
  que se quer medir. A tela avisa quando a parada é de um dia anterior.
- **Onde aparece**: coluna própria "Parado sem ordem" no relatório por dia (fora de
  planejada/não planejada, senão o total do dia deixa de bater com a soma das ordens);
  barra âmbar no Pareto, com a chave incluindo o contexto porque o mesmo motivo pode
  existir nos dois; e o cartão **Aproveitamento da máquina** (`aproveitamentoMaquina`),
  que é o indicador que faltava — a disponibilidade e o OEE medem a ORDEM, e um dia inteiro
  sem produzir saía com 100%. Aqui o denominador são as horas do turno
  (`horasDoDia` × `HORAS_TURNOS`, que saiu de `Programacao.tsx` para o domínio), e o resto
  do dia aparece como *parado sem ordem* (alguém nomeou) ou *ocioso* (ninguém nomeou).
- **Duas armadilhas do aproveitamento, achadas com dado real na conferência:** (1) a ordem
  não respeita a virada — a 141498 começou 03/09 às 20:34 e terminou 04/09 às 16:47, e a
  `v_ordem_tempos` joga as 20 h inteiras no `data_prog`, o que dava 28 h de produção num
  turno de 10 h; `sobreposicaoNoDiaS` reparte o intervalo pelas janelas de 07:30–03:00 que
  ele cruza, e o cartão soma a partir daí, não pelo dia programado (o vão das 03:00 às
  07:30 não pertence a dia nenhum e não é contado em lugar algum, de propósito). (2) O
  percentual **passa de 100% e isso é informação, não erro**: 03/09 sai com 153% e 175%
  porque o calendário marca só o 1º turno e a máquina rodou até a madrugada — ou é hora
  extra, ou a linha Turnos do plano semanal está desatualizada. Prender no teto de 100%
  apagava exatamente esse aviso. O ocioso continua com piso em zero, senão o dia não fecha.

**Realtime estava morto na Execução** (achado junto, 12/09/2026): a tela assina `ordens`,
`ordem_eventos`, `ordem_paradas` e `ordem_tanques`, e **nenhuma das quatro** estava na
publicação `supabase_realtime` (`lotes_semente` também não) — e, como o próprio
`realtime-completo.sql` documenta, uma tabela inválida derruba o canal INTEIRO, em
silêncio: Execução, Painel TV e Expedição só atualizavam ao voltar o foco da aba. A
migração `parada-de-maquina.sql` acrescenta as cinco mais a tabela nova. **Tabela nova que
alguma tela assine precisa entrar na publicação na mesma migração.**

### Ocupação (em horas, com setup — 13/09/2026)
```
horas_do_dia   = Σ das horas dos turnos que o dia roda (2 → 19,5 · 1 → 10 · 0 → 0)
horas_da_fila  = Σ (peso_t ÷ capacidade_th)  +  Σ setup(anterior, atual) ÷ 60
setup(anterior, atual) = 0 se não há anterior · setup_mesmo_min se receita igual · setup_troca_min se muda
ocupação = horas_da_fila ÷ horas_do_dia            (a fila NA ORDEM DA SEQUÊNCIA gravada)
```
Pedido do Arion: "hoje consideramos só a capacidade nominal; cada ordem diferente deve
considerar 20 min de setup, e 40 quando muda o tratamento, porque envolve limpeza". Com ~5
ordens/dia na TSI 1 isso é 6 a 13% de capacidade que a conta em toneladas prometia e não
existia. Toda a lógica de `src/dominio/programacao.ts` passou para horas: `resumoHorasFila`
(produção, setup, trocas, horas), `melhorSlot`/`autoProgramar` ("cabe" = a ordem entra NO
FIM da fila e paga o setup contra a última), `rebalancearDia` (custo de cada movida é o que
ela vale no destino), `reprogramarCascata` (a "anterior" acompanha a fila; a iniciada do dia
é a primeira anterior), `checklistDoDia` (percentual em horas; a mensagem diz "X h em Y h,
sendo N min de setup"). Alerta >85% (âmbar) e >100% (vermelho, com opção de rebalancear); dia
de 0 turnos com ordem programada é **bloqueio**; máquina com t/h zero é bloqueio próprio, não
"Infinity%". A célula da semana mostra "% · t · h", o título do dia "X t · Y h de Z h · P%
(N min de setup)" e o tooltip conta ordens/trocas/setup.
- **Onde o setup NÃO entra** (decisão do Arion): `tempoPlanejadoS`, `v_ordem_tempos.planejado_s`,
  OEE/performance e o cartão Aproveitamento — o setup real já é apontado como parada
  Planejada ("Setup / troca de receita", "Limpeza de maquina"); somá-lo ao planejado contaria
  duas vezes e inflaria a performance. Execução e Painel TV mostram só a linha informativa
  "+ setup previsto N min" (`setupPrevistoDaOrdem`: a ordem de maior seq abaixo, no mesmo dia
  e máquina), sem somar à barra nem ao "estourou".
- **Tela e domínio ordenam a fila IGUAL**: seq, e no empate o número da ordem
  (`OrdemProgramavel.numero`, `filaDa`). Ordem criada já com máquina e dia nasce com seq
  nulo; se cada lado desempatasse de um jeito, a célula mostraria um setup e o checklist
  outro. Pelo mesmo motivo "Programar automaticamente" renumera a célula inteira (fila atual
  + novas no fim), como o Encaixar já fazia — "maior seq + 1" punha a nova na frente das
  sem seq, e o setup gravado não era o precificado.
- **A ordem iniciada entra na carga** (`iniciada: true`, nunca candidata a mover): antes só
  as mexíveis iam para checklist/Encaixar/Rebalancear, e a Em produção sumia da conta —
  horas livres que a máquina não tinha. Iniciada não conta como "lote não baixado".
- **Cartão "Programado por tratamento"** (mesmo pedido): toneladas, bags e ordens por
  tratamento na semana à vista ou só no dia selecionado (`toneladasPorTratamento`); só ordens
  com máquina e dia, Apontada fora (já virou estoque) — por isso o total pode não bater com a
  soma das células quando há Apontada na semana.

### Reprogramação em cascata
Empurra para a frente o que não foi feito, a partir de um dia escolhido. Duas regras valem mais
que compactar bem (decisão de 06/08/2026):
- **Nada anda para trás** — uma ordem só entra na fila no dia dela ou depois; a cascata nunca
  puxa ordem da semana que vem para amanhã só porque sobrou espaço.
- **A fila não fura** — quando uma ordem não cabe no dia, as seguintes esperam junto; não se
  procura uma menor para preencher o buraco. Sequência é compromisso, não jogo de encaixe.

Ordem já iniciada não se move e continua ocupando capacidade e numeração do dia dela; dia sem
turno não recebe nada e devolve o que tinha para a fila. Ordem maior que um dia inteiro é
alocada mesmo assim, sinalizada — senão travaria a cascata para sempre. **Sempre com prévia
antes de gravar**: mexe em dezenas de ordens de uma vez.

### Histórico de reprogramação
Mudar o dia de uma ordem **não apaga de onde ela veio** (decisão de 06/08/2026 — antes
apagava). `ordens.data_prog_original` guarda o primeiro dia programado e nunca muda;
`reprogramacoes` conta quantas vezes o dia mudou; a tabela `ordem_reprogramacoes` registra
cada movimento (de/para dia, de/para máquina, quem e quando), inclusive as mudanças que são só
de máquina. Tudo por gatilho no banco — não dá para reprogramar por fora e escapar do
registro. Aparece no relatório de ordens (colunas *Dia original* e *Reprogramada*) e na marca
`↷n` ao lado do número da ordem.

### Balanço de demanda (por cultivar + tratamento + embalagem)
```
saldo = pedidos_APROVADOS − estoque_PA − ordens_abertas
```
- `ordens_abertas` = todas com status ≠ `Apontada` **e não marcadas `fora_balanco`** (ordem
  apontada sai do balanço e reaparece no estoque do próximo upload).
- **Ordem "fora do estoque"** (`ordens.fora_balanco`, decisão de 24/08/2026): produção que
  não vira estoque vendável — ex.: bags BG5M pra reensaque na **sacaria**. Sai do balanço e
  da conta de produção futura da Expedição; baixa do lote, execução, tempos e qualidade
  seguem normais. Marcável no formulário da ordem e alternável **em qualquer status exceto
  `Apontada`** (botão "sem estoque"/"volta ao estoque" na tela Ordens, ação de
  `ordens/editar`; tag roxa "sem estoque" na lista). Os gatilhos de imutabilidade e de
  coluna-por-ação ficaram intactos de propósito: a coluna fora das listas deles já dá
  exatamente esse comportamento (migração `ordem-fora-do-estoque.sql`).
- Avisos **fortes, nunca bloqueantes** (decisão do PCP): sem pedido de venda · estoque já cobre ·
  já planejado · excede o saldo · **estoque parado** (mesmo cultivar+tratamento em embalagem sem pedido).
- **Pedido aguardando aprovação é programável** (12/09/2026, pedido do Arion: "só consigo
  programar o que tem FALTA; o saldo com pedido aguardando não tem botão"). O pendente
  continua **fora do `saldo`** (não vira falta nem alarme), mas o alvo do botão Programar é
  `bagsProgramaveis = max(0, saldo + pendente)` — o firme que falta mais o pendente que
  estoque e ordens não cobrem (uma sobra do firme abate o pendente antes). A parcela
  pendente aparece como "+N aguardando" ao lado da situação, no popover ("faltam X do
  aprovado e mais N aguardando"), no placar "Aguardando aprovação" e no chip de filtro (por
  valor, não por situação: linha com falta firme E pendente também entra). Situação nova
  **`aguardando`** só quando não há pedido firme, estoque nem ordem — antes essa linha saía
  "coberto", em verde, o que era falso. Cooperado pendente entra no atalho do popover
  quando o alvo inclui pendente.
- Pedido de venda com código de tratamento **sem receita cadastrada** entra no balanço (a demanda
  existe), mas **não permite criar ordem** — a combinação é marcada "receita não cadastrada".

---

## 4. Integrações (hoje upload, amanhã API)

### Pedidos de venda — SimpleAgro, relatório "Pedidos Analítico Resumido"
`https://sementesveneza.painel.simpleagro.com.br:3333/sales/relatorios/pedidos-analitico-resumido`

Regras de conversão (validadas contra arquivo real de 1.196 linhas):
- **Coluna `Status Pedido`** (E no arquivo de referência; a letra varia por export, o importador
  acha pelo nome): só pedido firme — `Aprovado` ou `Integrado` (aprovado já sincronizado no ERP).
  Decisão do PCP em 05/08/2026; no arquivo de referência só existe `Integrado`.
- **Coluna H `Status Financeiro`**: `Aprovado` entra no balanço; `Não Aprovado` é importado como
  *aguardando aprovação* (visível, fora do cálculo).
- **Coluna BW `Saldo a Faturar`** = quantidade em bags (já líquida do faturado).
- **Coluna AT `Tratamento`** = código da receita. `SEM TSI` → **excluir** (não gera trabalho de TSI).
- **Coluna AU `Embalagem`**: BB5M→BG5M, BMB→MEIOBAG.
- **Coluna AL `Produto`** vem duplicado ("761 I2X - 761 I2X") → usar o trecho antes do " - ".
- Saldo ≤ 0 → excluir. Agregar por combinação somando BW.
- **Resultado esperado do arquivo de referência**: 1.018 bags aprovados, 4.674 aguardando,
  247 combinações, 22 códigos sem receita cadastrada.

### Estoque e lotes — SimpleAgro, tela "Saldos"
`https://sementesveneza.painel.simpleagro.com.br:3333/work/saldos` (escolher safra → Ir → Exportar)

Colunas: C cultivar · F lote · G lote tratamento · H PMS · K saldo (bags) · A nome do produto (embalagem no fim).
- **Cultivar truncado na origem**: em alguns produtos a coluna CULTIVAR perde o começo do nome
  (`O700 I2X` quando o nome do produto diz `SS NEO700 I2X BB5M`) — e os pedidos usam o nome
  completo, então o balanço nunca casaria. Regra validada na carga de 28/07 (126 linhas, 2
  cultivares, 0 falso positivo): quando o miolo do nome do produto TERMINA com a coluna, o
  miolo vence. A prévia mostra cada correção.
**Um arquivo, dois destinos:**
- linhas **com embalagem** + tratamento `SEM TSI` → **lotes de semente** (peso/bag = PMS × fator),
  agregando o mesmo lote em vários endereços;
- linhas **com embalagem** + tratamento real → **estoque PA** (para o balanço);
- **PRE-LOTE / granel (sem embalagem)** → ignorar (matéria-prima em kg).
- Saldo negativo → ignorar e **reportar** (o arquivo de referência tem 4 casos, −27 bags).
- **Resultado esperado**: 753 lotes · 16.865 bags · 0 estoque PA tratado.

**A coluna PMS do export do SAP não é confiável — "Peso Bruto" é a rede** (12/09/2026).
O `SAP.xlsx` (o "Saldo do SAP" da aba Ordens, e o mesmo arquivo do Mapa e do Inventário)
manda a coluna `PMS (g)` em **formatos misturados na mesma planilha**: texto ("205.0"),
número, **célula formatada como DATA** e vazia. O leitor de xlsx devolve a data como
`Date`, e `parseFloat` disso era `NaN` → PMS 0 → **peso do bag zero**, e com ele tempo
planejado, ocupação, químico e ensaque da ordem (achado do Arion: 6 lotes com saldo sem
peso na carga de 10/09, ordens P73 e P77 com 0 t). Duas defesas, ambas em cima do próprio
arquivo: (1) `numPms` desfaz a conversão de data — o serial do Excel **é** o PMS
(19/07/1900 = dia 201 = PMS 201,0, conferido contra o lote-base em texto no mesmo
arquivo); data de verdade daria serial de 5 dígitos e cai na trava dos 1.000 g. (2)
`converterSaldoSap` (e `converterMapaSap`) caem em **`Peso Bruto` ÷ fator da embalagem**
quando o PMS continua ilegível — inclui o número fora de escala (1208880 com Peso Bruto
604,44 = PMS 120,888), que a trava zera de propósito. **PMS legível sempre manda**; a
coluna Peso Bruto bate com PMS × fator em 100% das 1.137 linhas do export de 10/09 que
têm as duas. O resumo ganhou `pmsRecuperado` e a prévia da importação diz quantos lotes
vieram por essa rede (vale pedir o acerto da coluna no SAP) — o aviso vermelho de
`semPms` agora só sobra pra quem não tem **nem** PMS **nem** Peso Bruto. Correção dos 6
lotes já gravados: `supabase/lotes-pms-do-peso-bruto.sql` (aplicada).
**Sub-lote sem saldo não entra**: o SAP desdobra o lote em `-1`, `-2`, `-3`, e o
importador pula linha com Qtd em Estoque 0 — é por isso que só o sufixo com bags existe
em `lotes_semente` (o `-1` "sumido" não é bug).

### Planilha do Google "Produção 2026" — leitura direta do navegador (18/09/2026)
Primeira origem que o app lê **sem upload e sem servidor no meio**: o Google manda cabeçalhos
CORS no export de planilha pública, então a tela busca o CSV direto. Duas requisições, as duas
medidas em produção: (1) `export?format=csv&range=A1:CZ12` (~3 KB) só pro cabeçalho, que dá o
mapa **nome da coluna → letra**; (2) `gviz/tq?tq=select <letras> where <lote> is not null`
(~89 KB) pros dados. O CSV inteiro tem 971 KB — peso demais pro tablet do galpão —, e o gviz
sozinho não serve pro passo 1 porque come as linhas do topo e desalinha o cabeçalho. Filtrar o
saldo no servidor economizaria 2 KB em 89 e obrigaria a buscar de novo pra conferir lote
zerado: não vale, a tela esconde o zerado por conta própria. Se um dia a planilha deixar de ser
pública, o caminho é uma Edge Function de proxy — a rede está isolada em
`src/dados/planilhaEnderecamento.ts` justamente por isso.

### SAP Business One — Service Layer: **laboratório no app, integração de produção pendente** 🟡
A integração de produção (job que alimenta o app) **ainda não existe** — os dados seguem
vindo do upload das planilhas da SimpleAgro. O que existe desde 09/08/2026 é a aba
**"SAP (teste)"** (Edge Function `sap-teste`), um laboratório de LEITURA em homologação
visível só para o Arion (`src/telas/SapTeste.tsx`, gate por e-mail em `src/App.tsx` +
`src/lib/sapTeste.ts`). O diagnóstico de 09/08/2026 destravou o caminho técnico:

- **Basic Auth por requisição funciona** em produção (`SBOVENPRD`) — dispensa o fluxo
  Login+sessão, que está quebrado no ambiente hospedado (a sessão emitida não é reconhecida
  por nenhum nó). Se reimplementar, usar Basic Auth, não Login+sessão.
- **Mapeamento de campos confirmado com dado real**: PMS em `U_AGRT_PMS` (×5 = peso do bag,
  confirmado 176,40 × 5 = 882), tratamento em `U_LoteTSI` (texto livre — normalizar),
  item tratado tem sufixo `TSI` no `ItemName`, saldo total por item em
  `Items.QuantityOnStock` (55 insumos/defensivos listados).
- **Homologação tem endpoint próprio de Service Layer** (descoberto 09/08/2026):
  `https://sap-sementesvenezahom-sl.skyinone.net:50000/b1s/v1` — o SL de produção não a
  atende (HANAs separados). Lá o pipeline completo foi validado: criar e executar a
  consulta `TSI_SALDOS` devolveu **saldo por lote real** (PMS, tratamento, safra, bags por
  depósito). **Desenvolver sempre contra a homolog.**
- **Em produção só falta** replicar a autorização de `SQLQueries` (`code -6006`, assunto
  "Service Layer SQL Query" das Autorizações Gerais — mesma config que a homolog já tem)
  para liberar o saldo por lote de semente lá.

Ver `docs/integracao-sap.md` para o histórico completo. Reimplementar no app só com pedido
explícito do Arion — e sempre somente leitura em produção.

Ambiente **B1 sobre HANA**, hospedado pela Agrotis/AutoSky:

| Item | Valor |
|---|---|
| Endpoint | `https://sap-sementesveneza-sl.skyinone.net:50000/b1s/v1` |
| Base de **homologação** | `SBOVENHOM` |
| Base de **produção** | `SBOVENPRD` |
| Credenciais | usuário/senha fornecidos por e-mail — **nunca comitar** (ver §4.1) |
| Certificado | provavelmente autoassinado (navegador exige "Avançado → Continuar") |

**Regra de trabalho, se um dia voltar:** desenvolver e testar **sempre contra `SBOVENHOM`**.
`SBOVENPRD` só no job final e **somente leitura** — nenhum POST/PATCH/DELETE em produção.

---

### 4.1 Segredos — regra dura
Credenciais **nunca** entram no repositório, no CLAUDE.md, em prints ou em chat. Sempre:
- desenvolvimento local → `.env.local` (já no `.gitignore`)
- job de sincronização → **Supabase Secrets** / variáveis de ambiente do servidor
- rotação: se um segredo aparecer em qualquer lugar versionado, trocar imediatamente com a Agrotis.

```
# .env.local (exemplo — preencher com os valores reais)
SAP_SL_URL=https://sap-sementesveneza-sl.skyinone.net:50000/b1s/v1
SAP_COMPANY_DB=SBOVENHOM
SAP_USER=
SAP_PASSWORD=
```

## 5. Perfis e permissões

| Perfil | Telas | Ações exclusivas |
|---|---|---|
| **PCP** | Ordens, Programação, Lotes, Execução, Qualidade, Indicadores, Cadastros | criar/editar/excluir ordem, priorizar, programar, apontar AGROTIS |
| **Logística** | Programação, Lotes, Indicadores | baixar/estornar lote |
| **Produção** | Programação, Execução, Indicadores | iniciar/parar/retomar/finalizar, pesos de tanque |
| **Qualidade** | Execução, Qualidade, Indicadores | apontar qualidade visual e amostra |
| **Gestor** | todas | todas |
| **Balança** | Veículos, Mapa (ver), **Pesagem** | chamar motorista, checklist de veículo, **registrar pesagem** (etapas 1 e 2) |

Recurso `enderecamento` (18/09/2026): só `ver` — **PCP, Logística e Gestor**. A tela
só lê uma planilha de fora; não existe ação de escrita, e por isso também não existe migração
SQL (a `tem_acao` do banco só serve a policy de tabela, e aqui não há tabela).

Recurso `pesagem` (14/09/2026): `ver` (Balança, PCP, Logística, Direção, Gestor) ·
`registrar` (**só Balança**, e Gestor) · `administrar` (tipos de veículo, tolerâncias, correção
de bruto — **só Gestor**). Decisão do Arion: "só Balança registra; Gestor administra".

No protótipo os perfis são fixos no código. **No sistema real**: Supabase Auth com usuários
nominais (apontamento registra a pessoa, não o perfil) e uma **tela de administração** onde o gestor
define quais telas/ações cada perfil acessa. RLS no banco espelhando a matriz.

---

## 6. Telas (ver protótipo)

1. **Ordens** — inclusão por digitação e importação (Excel), filtros (busca livre, dia, status, máquina,
   cultivar, tratamento, lote), agrupamento dia→máquina com subtotais, coluna Seq, painel
   Demanda × Estoque × Planejado, upload diário, atalhos para a SimpleAgro, impressão e export .xlsx.
2. **Programação & Ocupação** — plano semanal navegável (máquina × dia, % ocupação, linha de
   **turnos do dia**), quadro do dia com 1 célula por máquina, arrastar-e-soltar (sobre outra
   ordem para posicionar na sequência; sobre uma célula da semana para trocar de dia/máquina;
   sobre o pool para desprogramar), botão **mover** com selects para tablet — arrastar não
   funciona em tela de toque —, ▲▼, **Programar automaticamente** (urgentes → lote baixado →
   agrupa cultivar+tratamento), **Encaixar**, **Rebalancear**, **Otimizar sequência**,
   **Reprogramar cascata**, **Checklist do dia**.
   A fila é exibida **só pela sequência gravada** — urgência é etiqueta, não reordena sozinha,
   senão arrastar uma ordem normal para o topo parecia não funcionar. Cartão **Programado por
   tratamento** (semana/dia) e ocupação **em horas com setup** (§3) desde 13/09/2026.
   **Faixa "Prioridades do dia"** (16/09/2026, pedido do Arion: "várias urgentes, e a produção
   não consegue priorizar entre elas"): acima da fila de cada máquina no quadro do dia, uma
   lista curta e ORDENADA (P1, P2, P3…) montada por arraste (ou botão "prioridade" no cartão
   da ordem, para tablet), com ▲▼ e ✕. Tabela própria `ordem_prioridades_dia` (migração
   `prioridades-do-dia.sql`; coluna em `ordens` esbarraria no `fn_ordens_por_acao`), escrita
   SÓ pela RPC `definir_prioridades_dia(maquina, dia, uuid[])`, que regrava a faixa inteira
   de uma vez (exige `programacao/editar`). **A prioridade é da célula**: gatilho apaga a linha
   quando a ordem muda de máquina/dia ou conclui. A ordem continua na fila com o seu `seq` (a
   faixa é destaque, não tira da fila); `v_ordens.prioridade_dia` expõe a posição. Soltar uma
   ordem DA faixa na fila da MESMA célula só a tira da faixa — não mexe no seq; soltar em outra
   máquina/dia move a ordem (e o gatilho derruba a prioridade). Solta no pool, desprograma.
   No cartão da fila, a marca `P1`/`P2` fica na **coluna da direita, numa vaga fixa colada ao
   status** (19/09/2026, pedido do Arion: "coloque ao lado direito do card, para não perder o
   padrão") — à esquerda do número ela empurrava o texto só nas linhas priorizadas.
   Armadilha do arraste: o Chrome não dispara `dragend` quando o nó de origem some do DOM
   (realtime remonta a faixa), então TODO `onDragStart` zera `arrastandoDaFaixa`.
   **Quadro do dia em LISTA por máquina** (19/09/2026, pedido do Arion: "a tela de
   programação está ruim de olhar, tem como colocar uma visão em lista, por máquina? onde eu
   possa classificar por cultivar, tratamento e tonelada? […] Quase como um Excel"). O quadro
   **abre sempre em lista** (`modoQuadro`, sem persistir — decisão dele): uma `Tabela` por
   máquina com as ordens do dia selecionado, o MESMO recorte dos cartões — Seq (a posição de
   exibição que o cartão mostra, `posicoesDeExibicao`, calculada da fila padrão e nunca do
   índice da tabela ordenada), nº (clicável → `ModalOrdem`; a Programação passou a guardar
   `motivos`/`produtos` do `carregarCadastros` que já buscava e descartava, e busca embalagens
   + a conferência **da ordem** — `conferenciaDaOrdem`, uma linha — só no clique), cultivar,
   tratamento, emb./lote (`hidden lg:table-cell`, sub-linha no tablet), bags, peso, expedição
   (vermelha quando `data_prog > data_expedicao`), urgente/normal em coluna própria, status
   com a vaga fixa `w-8` do P{n}, e os botões prioridade/mover dos cartões (`alternarNaFaixa`;
   o `PainelMover` abre numa linha extra). Os cartões ficam atrás do botão "cartões" — único
   lugar com arrastar, ▲▼ e a faixa Prioridades do dia. **Ordenar pelo cabeçalho é só visão**
   (`ordenarQuadroDoDia` em `src/dominio/quadroDoDia.ts` sobre `src/dominio/ordenacao.ts`:
   pt-BR numérico, empate pelo nº sempre asc; ciclo asc→desc→padrão; **as já produzidas
   (Finalizada/Qualidade apontada/Apontada) NÃO entram na ordenação** — ficam no fim, na ordem
   da fila, com fundo verde ("quando classificar, não mexer nas ordens que já foram
   produzidas"); Tratamento ordena por família e nº de itens (§1 Famílias); **por máquina** — a 1ª
   versão tinha um estado só e "quando eu classifico uma, a de baixo classifica também";
   Expedição com sem-data sempre no fim, Status na ordem do ciclo de vida): o `seq` gravado
   não muda. **A lista tem as mesmas ações do cartão** (2ª rodada, pedido dele: "as mesmas
   funcionalidades do card e uma alteração em um sempre refletir no outro" — refletem porque
   os dois leem a mesma fila): prioridade, mover, **urgente** (botão novo nos DOIS modos,
   `definirPrioridade`, ação `ordens/priorizar`) e **▲▼** (`trocarComVizinho` — o mesmo
   helper do cartão; na lista as setas ficam travadas com ordenação por coluna ativa ou
   filtro, pela mesma ambiguidade das setas com filtro nos cartões). **Otimizar sequência**
   zera a ordenação da máquina antes de gravar: numa tabela ordenada por cultivar o novo seq
   não aparecia — "o botão parece que não funciona". `exibicaoDoDia` (rodando → pronto →
   aguardando → programada → concluídas; status desconhecido cai em programada, nunca some)
   e `grupoMovel` saíram do JSX do cartão para o domínio e valem nos dois modos. Total (bags · t) no `<tfoot>` — `Tabela` ganhou `rodape`, porque `children` cai
   dentro do `<tbody>`. Linhas do painel de mover e do total somam colSpan 12 em `lg` e 10
   abaixo (`<td hidden lg:table-cell colSpan=2>`, como em Ordens) — um `colSpan` único cria
   coluna-fantasma no tablet. As tabelas por máquina usam **`larguraFixa`** com largura em
   toda coluna de conteúdo previsível (Cultivar e Tratamento ficam com o que sobra): são
   tabelas SEPARADAS empilhadas, e sem `table-fixed` Bags/Peso da TSI 1 não caíam embaixo dos
   da TSI 2 — o mesmo achado de 26/08/2026 da Logística, pego pela revisão adversarial.
   Teste jsdom `ProgramacaoLista.test.tsx` é a conferência estrutural (a tela exige login e o
   preview não a vê montada); o componente puro foi montado no dev server com dados falsos
   para conferir 1280/1024/768 px.
   **3ª rodada (19/09/2026)**: (a) **"Otimizar sem status"** — "hoje a otimização leva o status
   em consideração": não leva (o seq é otimizado igual), mas a lista por status separa uma
   FTZ60 aguardando lote de uma FTZ60 pronta mesmo com seq vizinho, e a sequência otimizada não
   aparece de ponta a ponta. O botão faz a mesma otimização e põe a lista da máquina **pela
   sequência** (`filaSemStatus` na tela, `filaSemStatus()` no domínio: ativas por seq,
   produzidas no fim); a lista tem o toggle "Ordem da fila: por status | pela sequência", e
   nesse modo as setas ▲▼ trocam com o vizinho real da fila (todas as não iniciadas), não só
   do mesmo status. (b) Coluna **Tempo** (`tempoPlanejadoS` = peso ÷ t/h, sem setup, "1h25")
   por ordem e no total. (c) O resumo da máquina ganhou **legenda por número** — Programado ·
   Setup previsto · Dia · Ocupação — e **"Falta produzir"** (`ocupacaoCelula(...).falta`:
   toneladas, horas com setup e nº de ordens **não finalizadas** — finalizada é a que a
   produção já informou a quantidade produzida), em destaque âmbar; o cartão usa o mesmo
   resumo.
3. **Lotes a baixar** — cards por lote com bags a baixar, lotes críticos (travam ordem urgente),
   mini-tabela de ordens dependentes, seção "baixados sem ordem — devolver", relatório de baixas
   (dia/semana/mês) com export.
4. **Execução** — cards por máquina (ordem atual, tempo planejado, decorrido, paradas, parada atual),
   **faixa de prioridades do dia** (16/09/2026: a lista da máquina mostra P1/P2/P3 no topo,
   em âmbar, antes das "demais ordens" por sequência; com a máquina livre o cartão aponta a
   P1 e diz se já pode iniciar — revisita a decisão de 06/08 de não apontar a próxima: sem
   faixa marcada segue sem apontar; o Painel TV mostra a P1 na máquina livre),
   grade completa agrupada por dia→máquina, botões de apontamento, coluna Lote sempre visível.
5. **Qualidade** — visual (Aprovado / Aprovado com observação / Reprovado) + retirada de amostra (S/N).
6. **Indicadores** — produção por máquina e turno, relatório por ordem (planejado vs realizado bruto e
   líquido), produção por período (dia/semana/mês/geral) com tempo parado, Pareto de paradas
   separando planejada de não planejada, export .xlsx. Dois relatórios **por dia** que respondem
   perguntas diferentes (11/08/2026): "Programado × finalizado" usa `data_prog` — o dia ATUAL da
   ordem — então reprogramar apaga o programado de onde ela saiu, como se nunca tivesse sido a
   intenção. "Planejado (antes de reprogramar) × executado" usa `data_prog_original` — carimbado
   na primeira vez que a ordem ganha um dia e nunca muda — para as duas pontas (planejado e
   executado): mostra quanto do que foi combinado para aquele dia saiu, não importa quando saiu de
   fato. Divergência entre os dois é reprogramação mascarando atraso.
6b. **Expedição** (07/08/2026; refeita em 12/09/2026) — upload do relatório **pedidos
   agendados** da SimpleAgro (`converterAgendados`, substituiu a "montagem de carga";
   substituição total na tabela `agendamentos`, migração `agendamentos.sql`; a tabela
   `carregamentos` ficou como histórico). Colunas pelo **nome normalizado** (a letra varia):
   `QTD AGENDADA` é a quantidade que vale (pode ser menor que `QTD PEDIDO` — agendamento
   parcial), `DATA AGENDADA` vem como Date **com hora** e o dia sai dos componentes UTC que o
   `read-excel-file` produz (`dia()` — `getDate()` local erraria), `TIPO VENDA` define
   `cooperado` pela mesma regra do import de pedidos (`normaliza(...).includes('COOPERADO')`),
   `TRATAMENTO` é código composto (`FTZ60 + VIC`) normalizado por `normalizaTratamento` (caixa,
   acento, espaço em volta do `+`) nos dois lados do cruzamento. **Toda linha com quantidade
   entra, inclusive "Aguardando Estoque"** — é a demanda que precisa de estoque (status visível
   e filtrável) — **exceto STATUS ENTREGA = FINALIZADO/Finalizada ou STATUS CARGA = Finalizado**
   (15/09/2026: 182 linhas, 3.759 bags, tinham a carga finalizada com a entrega ainda
   "Aprovado" e inflavam a falta), que fica fora na
   importação (caminhão já saiu; o upload seguinte de saldos já desconta — contar de novo
   dobraria a falta; `resumo.finalizados`, pedido do Arion 12/09/2026). A tabela consolidada
   mostra o `#Agendado` de cada produto repartido em **COOPERADO × OUTRAS VENDAS**
   (`agendadoPorTipo`). **Base de estoque = o upload do SAP da aba Ordens**: `SEM TSI` cruza com os
   **lotes de semente** por cultivar (o cultivar vira **uma linha só** somando as embalagens —
   o pool de lotes é um), tratamento real cruza com **estoque PA + TODAS as ordens abertas** —
   a data programada **não corta a conta**, porque produção se adianta (decisão do PCP,
   07/08/2026). O aviso vem da **fila em ordem de data**: caminhão a caminhão, a demanda
   acumulada é comparada com o garantido até aquele dia — estoque, ordens **já iniciadas**
   (inclusive a adiantada com data futura) e ordens programadas até a data; promessa vencida
   e ordem sem dia não garantem; caminhão sem data entra primeiro e só vê estoque + iniciadas.
   O pior buraco vira o âmbar **"adiantar ≥ X bg"**; vermelho "faltam X" é falta mesmo
   adiantando; **"Atende" é reservado a estoque físico** — coberta só por produção futura fica
   em **"aguardando produção"** (azul). **A mesma fila aloca cada caminhão**
   (`SaldoExpedicao.caminhoes`, `coberto`/`descoberto`; `Σ descoberto ≥ deficitPrazo`, igual
   quando o buraco não encolhe entre caminhões; SEM TSI: `Σ descoberto = max(0, −saldo)`) — e a
   visão **por tipo de venda** (VENDA COOPERADO × OUTRAS, `resumoPorTipoVenda`) **só detalha: a
   consolidada manda**, nenhum bag é contado duas vezes, cooperado no fim da fila absorve o
   descoberto como a data manda (decisão do Arion, 12/09/2026). Embalagem sem de-para não vira
   falta falsa: ganha etiqueta própria. O cartão de pedidos de venda saiu da Expedição (o
   painel Demanda × Estoque da aba Ordens já cobre). **Quando vai faltar** (16/09/2026, pedido
   do Arion: "escolho 16 a 18 e vejo a falta total, mas não quanto falta em cada data" — e, na
   1ª versão por dia, "ficou horrível, o dia e os itens separados; quero ver o ITEM e depois a
   data em que vai faltar"): cartão acima da consolidada, uma linha por PRODUTO com falta e,
   na linha, uma pastilha por DATA em que falta ("16/09 · faltam 13 de 43"), na cor da
   situação da linha consolidada (`faltaPorProduto`). É a MESMA fila agregada por produto ×
   dia do caminhão; nenhum bag contado duas vezes — a soma das datas é o descoberto do
   produto; dia que não aparece não tem falta. **Cada célula diz "faltam X de Y"**
   (19/09/2026): a grade mostrava só o descoberto e o Arion leu "6 e 23" como o pedido do
   dia — o pedido era 24 e 58 (NEO680 IPRO · FTZ60, 18 e 21/09), e "faltam 23" na consolidada
   pareceu vir de fora do período. `FaltaPorProduto.agendado` traz o agendado do produto no
   recorte (todas as datas) e `FaltaNaData.agendado` o do dia; a coluna Total sai "29 de 82".
   Os dois "falta" continuam com sentidos distintos e a legenda diz: 29 é a soma por dia (parte
   se resolve adiantando a produção de 19/09 para 18/09), 23 é o que falta mesmo adiantando.
   **Ordenar por** maior falta (padrão) · cultivar · tratamento (19/09/2026, pedido do Arion:
   "coloque uma forma de classificar por tratamento, cultivar"): chips no cabeçalho do cartão,
   `ordenarFaltaPorProduto` (puro, testado) com comparação numérica pt-BR e empate resolvido
   pelas outras chaves — a conta não muda, só a ordem das linhas; agrupado por tratamento, a
   célula do produto inverte as linhas (tratamento em cima, cultivar · emb. embaixo), porque a
   chave da ordenação é o que o olho percorre. Recurso `expedicao` (ver/importar): PCP
   e Logística importam, Direção vê.
   **Recorte por CARGA** (19/09/2026, pedido do Arion: "selecionar as cargas e ver a demanda
   daquelas cargas apenas, não o geral — que aí eu consigo dar prioridade nos materiais não
   produzidos"; decisões dele: seleciona pelo número da carga, e o estoque **continua
   reservado para as cargas anteriores**). A regra que estrutura tudo: **a seleção NÃO entra
   em `filtrados`**. Todo filtro da tela é aplicado ANTES da fila e quem sai devolve o
   estoque que consumia — se a carga entrasse ali, marcar a 822 mostraria o estoque inteiro
   livre para ela, ignorando as cargas de ontem. Então a fila roda com o período inteiro e a
   seleção só recorta o que se soma, pelo mesmo mecanismo do "por tipo de venda":
   `recorteDaSelecao(saldos, incluir, cargaDe)` e `faltaPorProduto(saldos, incluir?)` recebem
   um predicado sobre `c.caminhao`; `resumoDoGrupo` virou o motor comum dos dois recortes.
   Três coisas que a crítica do desenho achou e entraram junto: (1) **desempate estável na
   mesma data** — `alocarFila` ordenava só por data e, no empate, quem levava o estoque era
   a ordem em que o Postgres devolveu as linhas (invisível somado por produto, veredito quando
   se olha uma carga, e trocava de dono a cada reimportação); a tela passa
   `carga|identificador` como chave, o padrão vazio preserva o de sempre; (2)
   **`AlocacaoCaminhao.cobertoEstoque`** separa o coberto por estoque físico do coberto por
   ordem que ainda não rodou — "coberto" pela produção programada é justamente o que precisa ir
   para a máquina, e sumia da lista; a coluna **A produzir** = pedem − tem hoje; (3)
   `SaldoExpedicao.producao` guarda as ordens abertas da combinação (já eram calculadas e
   se perdiam) para a coluna "Já programado · para quando" e **Sem ordem** (a produzir −
   programado: o que abrir hoje). O cartão "Cargas selecionadas · o que a máquina precisa
   entregar" ordena por Sem ordem, depois pelo caminhão mais próximo; mostra para onde o
   estoque foi antes da seleção (`ItemRecorte.antes`: outras cargas × linhas sem carga, o que
   a fila serviu antes do PRIMEIRO caminhão da seleção — explicação, nunca conta); SEM TSI sai
   marcado "lote de semente" porque semente branca não passa pela máquina; a situação do
   PRODUTO inteiro fica numa coluna rotulada, nunca tinge a linha (mentiria nas duas pontas).
   Seletor em lista com busca (32 cargas viram parede em chip), montado sobre `filtrados`
   — carga marcada que os filtros tiraram aparece como aviso, não como recorte vazio. A
   **carga saiu da busca livre**: buscar "822" filtrava ANTES da fila e dava a resposta oposta
   do recorte, na mesma tela. Dado de 17/09: 647 linhas vivas, só 104 com carga (32 cargas),
   543 sem carga = 82% dos bags — continuam na fila e o cartão do recorte diz isso. Achado de
   passagem: `soTransferencia` não entrava em `temFiltro`/`limparFiltros` (o botão "Limpar
   filtros" não aparecia); corrigido junto com `cargaSel`.
   **A ordem que cobre a linha aparece com nº e status** (19/09/2026, pedido do Arion: "não dá
   pra colocar o status da ordem?"). Caso real: a Expedição dizia "aguardando produção — 2 bg a
   produzir" para O790 IPRO · FTZ ELITE, e ele não achava a ordem; era a **148734**, 19 bags,
   já com **Qualidade apontada** — os bags existiam, mas o saldo do SAP (subido às 09:10 do
   mesmo dia) ainda não os trazia, porque a ordem não tinha sido apontada no AGROTIS. "Atende"
   é reservado a estoque físico no SAP (regra de 07/08), então tudo que só tem ordem cai em
   "aguardando produção", mesmo produzido. Agora `ProducaoPrevista` leva `numero` e
   `status` (só exibição), `SaldoExpedicao.producao` é `OrdemPrevista[]` com os dois, e a
   tela lista as ordens embaixo da etiqueta na consolidada (`OrdensDaLinha`: nº · status ·
   bags · dia), nos avisos de texto (`ordensCurto`) e na coluna "Já programado" do recorte por
   carga. `bagsProduzidosSemApontar` soma as ordens em `STATUS_PRODUZIDO` (Finalizada,
   Qualidade apontada); quando cobrem o que falta, a etiqueta vira **"produzido · falta
   apontar"** em vez de "aguardando produção", e o aviso diz o caminho: apontar no AGROTIS e
   subir o saldo do SAP de novo.
   **Filial do pedido e transferência de saldo** (13/09/2026, pedido do Arion: "para pedido
   de outra filial é necessário solicitar a transferência de saldo em estoque"). O relatório
   de agendados tem coluna FILIAL, mas ela vem **vazia** (289/289 em 10/09); a filial só existe
   no Pedidos Analítico (col. B `Filial`, col. D `Número Pedido`), e o `NUMERO` dos agendados
   casa com o Número Pedido em 289/289. Então `converterPedidos` devolve, além do agregado,
   `pedidosFilial` (distinct por número, de TODAS as linhas — a filial é fato do pedido, vale
   mesmo para linha que o balanço descarta), gravado em **`pedidos_filial`** na MESMA carga
   (migração `pedidos-filial.sql`; tabela própria porque pôr o número na chave de
   `pedidos_venda` explodiria o balanço). A Expedição lê a carga de pedidos mais recente
   (`listarPedidosFilial`, mesma regra `ult_ped`) e cruza pelo número; a FILIAL do próprio
   relatório de agendados (`agendamentos.filial`) é fonte secundária, se um dia vier
   preenchida. **Filial casa = `FILIAL_CASA` = SEMENTES VENEZA LTDA, a matriz** (decisão do
   Arion); `normalizaFilial` colapsa os espaços em volta do hífen (o mesmo arquivo traz
   "LTDA - CHAPADAO DO SUL" e "LTDA-TUPACIGUARA"), `'0'`/vazia = "não informada";
   `transferenciaDe` só afirma `precisa` com filial conhecida e ≠ matriz. Na tela: coluna
   **Filial** (nome curto: o que vem depois do hífen, MATRIZ para a casa), etiqueta âmbar
   **"transferência · TUPACIGUARA"** na coluna das etiquetas e na sub-linha do tablet, chip
   **"Precisa transferência (N)"**, resumo por filial no cartão Por tipo de venda, e aviso
   (na tela e na importação de agendados) enquanto o Pedidos Analítico não foi importado —
   **a filial só aparece depois de reimportar o Pedidos Analítico na aba Ordens** (a carga
   anterior não tem `pedidos_filial`).
6c. **Mapa e Montagem de Carga** (28/08/2026) — TODO lote do SAP (semente branca E
   tratada) do depósito `VEN_GER`, em tabela própria (`lotes_mapa`) SEPARADA de
   `lotes_semente` de propósito: a base de produção assume semente branca. **A unidade é
   a COMBINAÇÃO lote + tratamento** (PK composta; `SEM TSI` = branca — migração
   `mapa-lote-tratamento.sql`, que substituiu a `mapa-montagem-carga.sql` do mesmo dia):
   o endereçamento físico do Arion provou que o MESMO lote existe branco e tratado ao
   mesmo tempo, em endereços diferentes (SV0891056060482 tinha 5 tratamentos, um por
   lugar). **O mapa é alimentado pela PRODUÇÃO** (decisão de 30/08/2026 — a integração
   SAP em tempo real ficou de fora): ordem que vira `Qualidade apontada` põe a combinação
   (lote base + tratamento da receita) no mapa com os **bags apontados pela produção**
   (gatilho `tg_lote_tratado_no_mapa`, SECURITY DEFINER; receita SEM TSI não cria);
   carga marcada **Carregada desconta** os bags do mapa (desfazer devolve; linha zerada
   fica no banco e some da tela). O upload do SAP.xlsx mudou de papel: **substituição
   total SÓ da semente branca**; pro tratado ele apenas CARIMBA destinação/classe (RPC
   `enriquecer_tratados`), casando pelo **número BASE + tratamento** — os sufixos
   -1/-2/-3 do SAP morrem na entrada (`loteBase`), destinações divergentes de sub-lotes
   viram "A / B" (migração `mapa-alimentado-pela-producao.sql`, que também fundiu os
   tratados sufixados pré-existentes preservando endereços). A **Logística endereça**
   (`lote_enderecos`: Armazém + Bloco + **Quadra em TEXTO** — nem sempre é número:
   CORREDOR, SILO — e **bags opcional**, o físico não controla quantidade por endereço;
   uma combinação pode ter VÁRIOS endereços); fila "Sem localização" mostra quem chegou
   sem endereço. **Mapa esquemático** sem planta: por armazém, cada bloco é uma coluna de
   quadras — número MAIOR = frente = acesso fácil, quadra de texto vai pro fim; filtros
   cultivar/tratamento/embalagem + **Destinação e Classe (A–D) com multiseleção** acendem
   os lotes (verde) e apagam o resto; chip azul = tratado, vermelho = com **Destinação**
   no SAP. **Montagem de carga (Balança) é POR PRODUTO, em duas OPERAÇÕES separadas,
   cada uma com o seu Salvar** (decisão de 29/08/2026, depois de duas tentativas de
   wizard): (1) **Montagem** — nº + placa/cliente/tara opcionais e CADA produto da carga
   (cultivar + tratamento + quantidade, os três obrigatórios; um caminhão leva vários),
   SEM lote nenhum na tela; Salvar grava a carga **"aguardando lotear"** (tag amarela,
   status derivado: produto sem lote) e limpa o formulário. (2) **Lotear** — botão na
   lista de cargas pendentes; abre cartão próprio com busca e lista de lotes por produto
   (acesso mais fácil primeiro; aviso forte em lote com Destinação); "Salvar lotes"
   grava — todos os produtos loteados viram **"loteada"** (verde), sobrou produto sem
   lote continua pendente. Gravação TRANSACIONAL via RPC `salvar_carga_montada` em
   `cargas_montadas` → `carga_montada_produtos` → `carga_montada_itens` (migração
   `carga-por-produto.sql`; itens sem FK pro lote — o registro sobrevive ao lote zerar).
   A carga salva tem **Lotear (se pendente) / Imprimir / Editar / Excluir** — Editar mexe
   só em cabeçalho/produtos e preserva os lotes. A **ordem impressa** agrupa por produto:
   "lotes a definir" quando pendente, e lotes com endereço
   ATUAL (onde buscar), DESTINAÇÃO em vermelho, pesos por lote e total, e o quadro de
   pesagem — peso da carga, TARA (valor ou campo em branco pra anotar) e peso bruto
   (tara + carga). Recurso `mapa` (30/08/2026): ver (todos) · importar
   (PCP/Logística/Gestor) · enderecar (Logística/Gestor) · montar_carga — montagem E
   loteamento — (**PCP/Gestor**; a Balança perdeu a ação e só vê). Fotos da carga: quem
   monta OU quem endereça. A consulta
   em tempo real ao SAP foi DESCARTADA por ora (30/08/2026): o tratado entra pela
   produção e o upload segue cobrindo branca + destinação/classe.

6d. **Inventário** (04/09/2026) — contagem física de sementes (branca e tratada) × estoque
   do SAP, **FORA do mapa** de propósito: nenhum saldo é ajustado, a tela só responde "bate
   ou não bate". Fluxo do Arion: o **PCP cria o inventário e INSERE o estoque do SAP** nele
   (upload da MESMA planilha do mapa; `converterEstoqueInventario` — toda linha COM
   quantidade, branca E tratada, só VEN_GER, agregada por lote BASE + tratamento +
   **embalagem**, porque bag de BB5M e de BMB não somam juntos) — a lista fica congelada em
   `inventario_saldos` (substituição total via RPC `substituir_saldos_inventario`). O
   **operador (Logística/Produção) conta contra a lista**: lança **endereço
   (Armazém/Bloco/Quadra, como no mapa) + quantidade** — um lançamento por endereço, a
   conferência SOMA; cada lançamento tem **editar e excluir**. **Contagem CEGA**: a
   quantidade do SAP não aparece na contagem, só na conferência (mesma regra da conferência
   de estoque). Achado fora da lista → lançamento manual completo (`fora_da_lista`;
   cultivar SÓ dos da planilha inserida, tratamento do cadastro de receitas + SEM TSI,
   embalagem do cadastro). Conferência por combinação: bate / sobra / falta / não contado /
   fora do SAP (tolerância 0,01 bg; bags 0 = "contei e está vazio", ≠ não contado), chips
   de filtro, acuracidade das contadas, export CSV. **Fechar congela** a comparação no
   servidor (`fechar_inventario` → `inventario_resultados`, com lock; inventário fechado é
   registro — gatilho trava itens e saldos; **reabrir** apaga o congelado e libera).
   Recurso `inventario`: ver (PCP/Logística/Produção/Direção) · **abrir** (criar, inserir
   SAP, fechar, reabrir, excluir — PCP/Gestor) · **contar** (Logística/Produção/PCP/
   Gestor). Migração `inventario.sql`.
   **Aplicar no mapa** (08/09/2026, migração `inventario-mapa-ajuste-reserva.sql`): botão
   em inventário FECHADO (ação `abrir`, uma vez só — aplicado NÃO reabre) que grava **SÓ
   ENDEREÇOS**: os lançamentos contados SUBSTITUEM `lote_enderecos` da combinação (com
   quantidade por endereço; contagem 0 não vira endereço); **o saldo continua o do SAP**
   (sobra/falta é ajuste no SAP via CSV da conferência, e depois Ajuste de estoque no
   mapa). Contada sem linha no mapa não cria nada (relatado). NÃO CONTADA nunca é mexida:
   ganha `lotes_mapa.nao_encontrado_inventario_em` e aparece no cartão **"Não encontrados
   no inventário"** do Mapa — sai ao ser endereçada (gatilho `tg_endereco_achado`), contada
   numa aplicação futura, ou zerada por ajuste. **Ajuste de estoque** (ação
   `mapa/ajustar` — PCP/Logística/Gestor): ± bags numa combinação com motivo obrigatório e
   endereço opcional, rastro em `mapa_ajustes` (RPC `ajustar_saldo_mapa`, DEFINER; saldo
   nunca fica negativo), cartão recolhível com o histórico. **Reserva contínua**: ordem
   de produção com lote selecionado segura a branca do mapa até o APONTAMENTO —
   `listarConsumoOrdens` (front) e a trava server de `salvar_carga_montada` usam a MESMA
   régua (status not in Finalizada/QA/Apontada/Excluida — mudou um, mude o outro); a trava
   da carga recusa cargas + ordens > saldo da branca. **Entrada do tratado no mapa
   ANTECIPOU** de `Qualidade apontada` pra **`Finalizada`** (apontamento da quantidade
   produzida): gatilho `tg_lote_tratado_no_mapa` recriado com desfazer SIMÉTRICO no
   "Voltar para produção" (sem clamp; usa valores VELHOS da ordem) e idempotência pela
   tabela `ordem_mapa_lancado` (backfill na migração) — tabela PRÓPRIA porque coluna em
   `ordens` esbarrava no fn_ordens_por_acao, que exige a ação Editar pra coluna fora das
   listas dele (achado de 09/09/2026). O lote tratado nasce "Sem
   localização" e a **Logística o endereça na própria conferência de quantidade
   produzida** (tela Logística: armazém A–E obrigatório + bloco/quadra; SOMA ao endereço
   existente — `somarEndereco`; ordem SEM TSI não pede endereço). Formulário de ordem
   ganhou aviso (nunca bloqueante) quando a branca do lote não tem saldo LIVRE no mapa.
   **Pendências do inventário no Mapa** (10/09/2026, especificação final — substituiu 3
   cartões que confundiam): UM cartão, sempre CONTADO × SAP (a foto congelada), uma linha
   por lote+tratamento+embalagem — falta/sobra (vermelho), fora do SAP (azul→preto na
   grade), não contado (âmbar, aguardando contagem E endereçamento) — e a Logística
   resolve TUDO por **RECONTAGEM inline** (RPC `recontar_inventario`, quantas vezes
   precisar; linha que bater sai sozinha; rastro da 1ª contagem em
   bags_primeira_contagem). Até conferir, **o saldo que vale no mapa é o do SAP**. A
   recontagem também existe na conferência da tela Inventário; o Ajuste de estoque fica
   no botão do topo (etapa pós-acerto no SAP).
   **O MAPA exibe SÓ o confirmado no físico** (regra final do Arion, 10/09/2026): a
   combinação marcada `nao_encontrado_inventario_em` fica FORA da grade, do "Sem
   localização", das datalists de filtro e do loteamento de carga (`visiveis` em
   `Mapa.tsx` — `todos` completo continua valendo pra Pendências, cuja coluna Contar
   precisa achar a linha, e pro Ajuste de estoque, ferramenta de correção que enxerga
   tudo) — não contado **entra no mapa conforme for contado** (o Contar do cartão de
   Pendências limpa a marca e endereça num ato só). O título do cartão de saldo do SAP
   soma "· N aguardando contagem" quando há marcados. Divergente de quantidade
   (falta/sobra) CONTINUA visível no mapa, com borda vermelha — só o não contado some.
   **Contar não pode apagar endereço de outra embalagem** (fix de 11/09/2026, migração
   `inventario-recontagem-embalagem.sql`): `lote_enderecos` é por lote+tratamento (sem
   embalagem), mas um mesmo lote+tratamento pode ter DUAS pendências (uma por
   embalagem — BB5M e MEIOBAG não somam). A recontagem endereça com `somarEndereco`
   (soma), nunca `salvarEnderecos` (substitui) — usar substitui apagava o endereço que
   a contagem da OUTRA embalagem tinha acabado de gravar. Pelo mesmo motivo, "achada"
   só limpa `nao_encontrado_inventario_em` quando NENHUMA outra embalagem da mesma
   combinação, no inventário aplicado, continuar sem contagem — vale tanto no
   `recontar_inventario` quanto no gatilho `fn_endereco_achado` (dispara em qualquer
   insert em `lote_enderecos`, então precisa da mesma guarda). O botão solto
   "Endereçar" nas linhas não-contado da Pendências foi removido — endereçar sem
   contar furava a regra "só entra no mapa o que foi contado" (o gatilho limpava a
   marca mesmo sem `recontar_inventario` ter rodado); quem quer trazer a combinação
   pro mapa usa o **Contar**, único caminho que registra a contagem E o endereço.
   A grade ficou só com vermelho (divergente) e preto (fora do SAP) — o "?" âmbar do não
   contado saiu da grade e da legenda, porque a combinação não aparece mais lá.
   **Recontagem de falta/sobra/fora do SAP oferece revisar o endereço** (11/09/2026):
   essas situações já tinham contagem e endereço antes, e uma combinação pode ter MAIS
   de um endereço físico — corrigir só o número, sem revisar onde está, deixava a
   informação velha. Depois de gravar a recontagem, abre (sem obrigar — dá pra fechar
   sem mudar nada) o MESMO modal de endereçamento usado em "Sem localização"/grade,
   pré-carregado com a lista atual da combinação, pra revisar/editar. Não-contado
   continua com o fluxo obrigatório de sempre (armazém junto da quantidade, um ato só,
   por já não ter endereço nenhum).
   Novo lote de produção segue igual: apontou quantidade → "Sem localização" →
   endereçado → mapa (botão Novo lote continua pra compra de terceiros); consumo e
   reserva de ordens/cargas seguem sobre a tabela `lotes_mapa` cheia, sem mudança.

6e. **Pesagem — checklist de carregamento com conferência de peso** (14/09/2026, especificação
   funcional do Arion; substitui a planilha `Checklist_Carregamento_Pesagem.xlsx` com as MESMAS
   regras, para três operadores da balança ao mesmo tempo). Tela própria, recurso `pesagem`,
   **totalmente separada da montagem de carga do Mapa** (decisão do Arion — `cargas_montadas`
   tem placa/tara/peso, mas não se cruza nem pré-preenche). Tabelas `tipos_veiculo` (nome +
   PBT máximo legal em kg, 7 tipos semeados: Rodotrem 74.000 · Bitrem 57.000 · LS Simples
   41.500 · LS Trucada 48.500 · LS 4 Eixos 58.500 · Truck 23.000 · Bitruck 29.000),
   `parametros_pesagem` (linha única: tolerância legal 5% — Lei 7.408/85 — e tolerância da
   ordem 0,5%) e **`pesagens`** (não `carregamentos`: esse nome já é a foto legada da
   SimpleAgro). Migração `pesagem.sql`. Tudo em kg inteiros.
   **Duas etapas por veículo** (domínio puro `src/dominio/pesagem.ts`, mesma fórmula na
   função SQL `calc_pesagem` usada pela view `v_pesagens` e conferida na migração com os 6
   casos de aceite da especificação — mudou uma, mude a outra):
   (1) **Pré-conferência**, antes de carregar: `tara + ordem ≤ PBT` → SIM, senão NÃO com
   "Excede PBT em X kg" — **sem tolerância** (a tolerância legal é margem de balança, não de
   planejamento). (2) **Pesagem final**: `líquido = bruto − tara`; legislação OK (≤ PBT) ·
   ATENÇÃO (≤ PBT × 1,05) · EXCESSO; × ordem OK (|dif| ≤ 0,5%) · ACIMA · ABAIXO; **Liberado?**
   = SIM se legislação ∈ {OK, ATENÇÃO} e ordem OK, NÃO caso contrário, PENDENTE sem bruto.
   ATENÇÃO libera (está dentro da tolerância legal) mas fica visível. Comparações com EPS no
   TS (74.000 × 1,05 e 175 ÷ 35.000 não são exatos em ponto flutuante); no SQL é `numeric`.
   **O que fica congelado na linha**: `pbt_max_kg_aplicado` no INSERT (trocar o tipo antes de
   pesar recongela; depois de pesado nunca muda) e as duas tolerâncias na **primeira**
   gravação do bruto — mudar PBT ou tolerância vale só para o futuro, o histórico não muda de
   status. **Pré-conferência NÃO não bloqueia a pesagem** (decisão do Arion: "permitir com
   justificativa"): o gatilho exige observação preenchida e carimba
   `excesso_autorizado_em/por`; a linha mostra "excesso autorizado". Etapa 1 continua
   editável ("ajustar") enquanto não pesada — é o caminho para reduzir a ordem. Bruto já
   gravado só muda com `administrar` (carimba `corrigido_em/por`; `pesado_em/por` guardam a
   1ª pesagem). **Excluir** (pedido do Arion, mesmo dia; migração `pesagem-excluir.sql`):
   quem registra exclui só carregamento ainda não pesado (erro da etapa 1); pesado, só o
   administrador — com confirmação e a versão lida. **Filtro de data nasce vazio = todas as
   datas** (pedido dele: "quando não tem data, mostrar todos").
   **Concorrência otimista** (novidade no app): `pesagens.versao` inteira, incrementada pelo
   gatilho; o cliente grava com `.eq('versao', v)` lida na abertura do modal e zero linhas
   vira "alterado por outro operador — a lista foi atualizada" (`atualizarComVersao` em
   `api-pesagem.ts`). Inteiro, não `atualizado_em`: o PostgREST devolve microssegundos e
   `Date` trunca em ms. A tela lê a TABELA (realtime não emite evento de view) e calcula pelo
   domínio; `v_pesagens` (security_invoker) fica para relatório/BI. Realtime nas três tabelas.
   Tela: resumo do período (contadores da §4.5 da especificação), filtros (data padrão hoje,
   placa, ordem, tipo, chips Liberado?), lista com etiquetas coloridas e PENDENTE em âmbar
   (caminhão no pátio) na frente, modal Etapa 1 com prévia ao vivo e rascunho, modal Etapa 2
   com prévia e justificativa, cartão Parâmetros (Gestor), export .xlsx com todas as colunas.
6f. **Endereçamento planilha** (18/09/2026, pedido do Arion: "a planilha é dinâmica, tem como
   colocar uma aba dentro do app com o nome 'ENDEREÇAMENTO PLANILHA' e ir atualizando conforme
   ela atualiza ou um botão pra atualizar?"). Espelho de **leitura** da aba `Lote PA` da
   planilha Google "Produção 2026", onde a operação anota à mão em que armazém/bloco/quadra
   cada lote está. **Não é o Mapa** e não grava nada — nem no TSI nem na planilha; a tela avisa
   isso em destaque, porque duas verdades no mesmo sistema é o risco humano caro aqui.
   **Atualiza só pelo botão** (decisão dele), com uma exceção: sem foto guardada, busca uma vez
   ao abrir, senão a tela nasceria vazia. A última foto fica em `localStorage`
   (`tsi.enderecamento.foto`, `src/lib/fotoEnderecamento.ts`, molde do `ajusteFicha`): abre
   instantânea, e **falha de busca nunca apaga a foto anterior** — o erro vai em cima, a lista
   antiga fica embaixo com a hora dela.
   **A regra do "mais fácil" é do Arion e o galpão confirma**: dentro do MESMO bloco, quadra de
   número MAIOR fica junto do portão (a aba "MO AZ A" da planilha desenha os blocos 41D e 42D
   cercando o PORTÃO 08 pelas quadras 8 e 9). É a mesma regra da grade do Mapa. **Posição** =
   1 + nº de linhas do bloco com quadra estritamente maior, então empate divide a posição e a
   seguinte pula (4,3,3,2,1 → 1º,2º,2º,4º,5º); **bags na frente** = soma dos bags em quadras
   maiores, fora os do próprio lote (ele não é obstáculo de si mesmo) e fora os empatados (esses
   estão do lado, não na frente). Quadra não numérica ou endereço incompleto fica **sem posição**
   e vai pro fim — nunca aparece como 1º.
   **A unidade é a LINHA (lote + tratamento + endereço), não o lote**: 123 lotes estão em mais de
   um lugar ao mesmo tempo. Linha idêntica repetida soma os bags e vira item do cartão
   "Problemas na planilha", junto com endereço incompleto e quadra ilegível — o cartão vira lista
   de tarefa pra operação corrigir lá na planilha.
   **Coluna pelo NOME, nunca pela letra** (mesma lição da SimpleAgro, §4), e a linha do cabeçalho
   é DESCOBERTA, não fixa — hoje é a 5ª. Nome repetido: vence a **primeira** ocorrência, e
   **exato ganha de normalizado**, porque `AZ` aparece 3× e `SALDO` colide com um `saldo`
   minúsculo das colunas auxiliares de fórmula; sem essa precedência, renomear a coluna de dado
   fazia a auxiliar assumir o lugar em silêncio. **O filtro é lote + saldo, NUNCA data**: exigir
   data escondeu 3 lotes com saldo do primeiro relatório entregue (`SV0321026260777`,
   `SV0271046760629`, `11149P1630`). Bloco passa por `normalizaBloco` (`5D` e `05D`
   são o mesmo bloco). Domínio puro em `src/dominio/enderecamento.ts` e
   `src/dominio/importacao/planilhaEnderecamento.ts`; parser de CSV próprio em
   `src/dominio/importacao/csv.ts` (o primeiro do projeto — todo o resto é .xlsx).
7. **Cadastros** — máquinas, turnos, embalagens, químicos (com densidade), receitas (dose · densidade ·
   volume · peso de balança), motivos de parada, lotes.

**Navegação sobrevive à recarga** (12/09/2026 — "as telas ficam atualizando e abrem em
outra página"): a vista ativa vai pro **hash da URL** (`#expedicao`, `#painel`, `#chamada`)
e pro `localStorage` `tsi.tela` (`src/lib/telaAtiva.ts`) — F5 e aba descartada pelo tablet
voltam pela URL; o atalho da tela inicial (URL limpa) volta pelo storage; sem nada, Execução.
Só a AÇÃO do usuário grava (clique no menu, abrir/fechar painel), nunca a montagem, porque o
supabase-js usa o mesmo hash no link de recuperação de senha e o limpa na inicialização; só
id de vista conhecido é aceito. **Renovar o token não remonta o app**: `AuthProvider` guarda
o id do usuário carregado e, no mesmo usuário (TOKEN_REFRESHED, foco), reatualiza perfil e
matriz em silêncio — antes cada renovação passava pelo "Carregando…" e desmontava a tela
inteira (filtros, modal, inventário em contagem). Leitura silenciosa que falha mantém o que
já tinha (matriz virando `[]` tirava tela do menu e o App trocava de tela sozinho). **Chunk
velho depois de deploy** (`vite:preloadError` em `main.tsx`) recarrega sozinho, na mesma
tela, no máximo 1× a cada 30 s.

---

## 7. Pendências de especificação (decidir com o cliente)

- **Qualidade reprovada**: hoje é só um carimbo. Retrabalho? Bloqueio do lote? Nova ordem?
- **Estoque de químicos**: RESOLVIDO na aba MRP (27/08/2026) — upload do export do SAP
  (Quimicos.xlsx, uma linha por lote; só o armazém `VEN_GER` entra), foto por carga em
  `estoque_quimicos` (migração `estoque-quimicos.sql`; quem lê usa SÓ a carga vigente,
  lição do bug do estoque PA multiplicado). O cruzamento com a necessidade é por NOME
  em 3 níveis (`cruzarEstoqueQuimico`) — o código do item no SAP NÃO bate com o do app
  (INS00004 lá é RIZOLIQ, aqui era KELMAX). Líquido compara em L, pó em kg; colunas
  "Em estoque"/"Falta comprar" (firme e com aguardando) na tabela de necessidade.
  Segue em aberto só o alerta pró-ativo contra a programação da semana.
- **Etiquetas**: a planilha antiga tinha ~15 abas de etiquetas; ficaram fora do escopo —
  EXCETO a **etiqueta DM** (25/08/2026): menu "Etiqueta DM ▾" no detalhe da ordem
  (`imprimirEtiquetaDm` em `exportar.ts`), tamanho físico 97 × 63 mm, com
  peneira/categoria vindas do saldo do SAP (`lotes_semente.peneira/categoria`, migração
  `lote-peneira-categoria.sql`), germinação 80% e pureza 99% fixos, logo em texto por
  enquanto. A DM reparte a produção em pacotes variados, então o menu tem um item por
  embalagem do cadastro e **só o peso muda** entre eles (peso fixo do cadastro, ou PMS do
  lote × fator — ex.: PMS 210 → BAG 1.050 kg, MEIO BAG 525 kg, SC10 10 kg); os demais
  campos são sempre os da ordem. Formato por sementes desabilita sem PMS no lote.
  **Ficha de químicos** (11/09/2026): formulário PRÉ-IMPRESSO da Veneza (papel 212 × 320
  mm, com logos, cabeçalhos verdes, grade e precauções já no papel) — o app imprime **só o
  texto** nas células (menu "Ficha de químicos ▾" no detalhe da ordem, `ModalOrdem.tsx`;
  `imprimirFichaQuimicos` em `exportar.ts`, `@page 212mm 320mm`, divs absolutas em mm;
  domínio puro em `src/dominio/fichaQuimicos.ts`). Células de 9 mm de altura × 48 mm
  (seções de 4 colunas) e 65 mm (OUTROS, 3 colunas); linhas no papel: Inseticida 2 ·
  Fungicida 2 · Nematicida 1 · Inoculante 1 · Outros 5 (`CAPACIDADE_FICHA`; a coluna
  DOSAGEM fica 1 cm à direita da grade uniforme, `deslocDosagem`). Dados vêm
  da receita + `produto_principios` (princípio ativo, concentração, classe — já existiam
  no cadastro de químicos): **uma linha por produto POR CLASSE** (produto fungicida +
  inseticida sai nas duas seções, princípios da mesma classe juntam com " + ");
  **dosagem sempre por 100 kg de semente**; Biologico/Outros e o que estoura a seção vão
  pra OUTROS PRODUTOS com a classe na coluna INFORMAÇÕES; **BIOLÓGICOS: = SIM quando há
  princípio de classe Biologico OU Inoculante** (decisão do Arion, 12/09/2026: só o
  Rizoliq marca SIM e continua na seção INOCULANTE; nematicida biológico como Lumialza
  fica Nematicida e não marca); produto sem princípio cadastrado sai em OUTROS sem
  informação e a tela avisa antes de imprimir. Carga inicial dos princípios em
  `supabase/seed-principios-ativos.sql` (planilha "Descrição" da Veneza + rótulos onde
  ela falhava; Grafite, Pó secante, Kelmax e Disco Black ficam sem princípio de
  propósito).
  Posições (`FICHA_QUIMICOS_LAYOUT`) começaram como estimativa pela foto — o item "Teste
  de alinhamento" imprime a grade suposta + régua de 10 mm numa ficha real e o desvio
  relatado vira ajuste SÓ nessa constante. Imprimir em 100%, sem margens.
  **Ajuste fino por impressora** (12/09/2026, depois de 9 rodadas de "sobe 3 / desce 5"
  com deploy no meio): o menu da ficha tem o painel "Ajuste fino desta impressora" — ▲▼
  de 1 mm por seção (Receita, Biológicos, Inseticida, Fungicida, Nematicida, Inoculante,
  Outros) e um horizontal geral, limite ±30 mm, salvo em `localStorage`
  (`tsi.ficha.ajuste`, `src/lib/ajusteFicha.ts`) — é da impressora ligada àquele
  computador, não do sistema; cada posto tem o seu e "Voltar ao padrão" zera.
  `aplicarAjusteFicha` (domínio, testada) soma o ajuste ao layout padrão na hora de
  imprimir; o teste de alinhamento imprime também quais ajustes estão ativos. Quem está
  na frente da impressora acerta sozinho, sem publicar nada. Se o desvio variar de folha
  pra folha com o mesmo ajuste, é papel/bandeja — a saída definitiva é o app imprimir a
  ficha inteira em papel branco (proposto, não decidido).
  **Etiqueta do lote na ficha** (17/09/2026, pedido do Arion: "imprimir a etiqueta do
  lote na ficha; vou fazer o upload da etiqueta em PDF, e ela deve ficar no espaço acima
  e à esquerda destinado à etiqueta"). O PDF é o do SimpleAgro (JasperReports): página
  de 207 × 283 pt com `/Rotate 90` = etiqueta deitada de **99,8 × 73 mm** (QR, cultivar,
  lote, categoria, safra, peneira, peso, germinação, produtor). No menu "Ficha de
  químicos ▾" há o bloco **Etiqueta do lote (PDF)**: escolhe o arquivo, o app rasteriza a
  1ª página **no navegador** com `pdfjs-dist` (chunk carregado só ali, 300 dpi —
  `src/lib/etiquetaPdf.ts`) e mostra a prévia; "girar" roda 90° (o pdf.js já aplica o
  `/Rotate` da página, então o padrão sai legível; `rotacaoSugeridaEtiqueta` só gira
  página que ainda sair de pé). A imagem entra na ficha como `<img>` absoluta no
  **tamanho real do PDF** (`FICHA_QUIMICOS_LAYOUT.etiqueta = {left 10, top 14}`, canto
  do espaço reservado no cabeçalho, que vai de 0 a 90 mm — estimativa, como as outras
  posições nasceram), e o teste de alinhamento desenha a guia da etiqueta mesmo sem PDF
  (100 × 73 mm supostos). O ajuste fino ganhou **Etiqueta do lote (vertical)** e
  **(horizontal)**, além do x geral que ela também acompanha (`AJUSTES_HORIZONTAIS` diz
  quais chaves são ◂▸). O arquivo fica **só na memória do detalhe da ordem** — nada sobe
  pro Storage, fechar o modal esquece; com etiqueta o `abrirParaImpressao` espera a
  imagem decodificar antes do `print()`.
- **Capacidade variável**: 12 t/h é global. Pode variar por receita/embalagem?
- **Horário previsto por ordem** (cascata a partir da sequência) — sugerido, não feito.
  O **painel modo TV** FOI feito (09/08/2026): botão "Painel TV" no cabeçalho, tela cheia,
  aberto a quem vê a Execução (`src/telas/Painel.tsx`). A aba **SAP (teste)** também existe —
  restrita por e-mail (fora da matriz de perfis), mesma lista da Edge Function `sap-teste`.

## 8. Dados de exemplo do protótipo (substituir na carga real)

Produtos, doses e **densidades** dos químicos são **fictícios plausíveis** — trocar pelas fichas
técnicas (FISPQ) reais. Densidade errada desloca todo o planejado de balança.
