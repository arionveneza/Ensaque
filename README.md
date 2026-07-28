# TSI — Controle de Tratamento Industrial de Sementes

Aplicação de execução de produção (MES enxuto) para o tratamento industrial de sementes da
**Sementes Veneza**. Substitui a planilha `TSI 2025`.

## Como começar (passo a passo)

### 1. Criar o repositório no GitHub
```bash
cd tsi-app
git init
git add .
git commit -m "Especificacao, schema do Supabase e prototipo de referencia"
gh repo create sementes-veneza/tsi-app --private --source=. --push
# (ou crie o repo pela interface do GitHub e faça git remote add origin ... && git push -u origin main)
```

### 2. Criar o projeto no Supabase
1. https://supabase.com → **New project** (região: São Paulo)
2. **SQL Editor** → cole e execute `supabase/schema.sql`
   (cria o schema **`tsi`** — o projeto não usa o `public`)
3. **Settings → API → Exposed schemas**: acrescentar **`tsi`** à lista.
   Sem este passo a API não enxerga as tabelas e o app recebe 404 em tudo.
4. **Settings → API**: copie `Project URL` e `anon public key` para o `.env.local`
5. **Authentication → Users**: crie os usuários e depois insira o perfil de cada um:
```sql
insert into tsi.usuarios (id, nome, perfil) values
  ('<uuid-do-auth-user>', 'Nome da Pessoa', 'PCP');   -- PCP|Logistica|Producao|Qualidade|Gestor
```

### 3. Abrir o Claude Code na pasta
```bash
cd tsi-app
claude
```
O Claude Code lê o `CLAUDE.md` automaticamente. Primeiro pedido sugerido:

> Leia o CLAUDE.md e o docs/prototipo-referencia.html. Crie o projeto React + TypeScript + Vite
> com Tailwind e shadcn/ui, configure o cliente do Supabase por variáveis de ambiente e implemente
> a primeira tela: **Execução** (cards por máquina + grade agrupada por dia/máquina + fluxo de
> apontamento em duas etapas). Siga as regras do CLAUDE.md à risca — em especial a matriz de
> permissões por status e o fluxo Iniciar → pesos → Confirmar início.

### 4. Variáveis de ambiente
Crie `.env.local` (nunca comite):
```
VITE_SUPABASE_URL=https://xxxxx.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

### 5. Rodar localmente
```bash
npm install
```
Depois `npm run dev` (aplicação), `npm test` (153 testes) e `npm run build` (produção).

### 6. Publicar

A pilha é **GitHub + Supabase, só isso**: o GitHub guarda o código e serve o app pelo
Pages, o Supabase guarda os dados. Nenhum terceiro.

O workflow `.github/workflows/deploy.yml` roda os testes, faz o build e publica a cada
`push` na `main` — **teste vermelho não vira deploy**. Dois passos no repositório:

1. **Settings → Pages → Source**: `GitHub Actions`
   *(o Pages é gratuito em repositório público)*
2. **Settings → Secrets and variables → Actions**, aba **Secrets**:
   - `VITE_SUPABASE_URL` → `https://ztwmrhfloelqxhhpdmoz.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` → a chave `anon public`

O endereço final fica em `https://arionveneza.github.io/Ensaque/`.

> A chave anônima vai no bundle do front-end — é pública por natureza, em qualquer
> hospedagem. Quem protege os dados é o RLS no banco. **Nunca** cadastre a `service_role`.

<details>
<summary>Alternativas de hospedagem</summary>

O app é estático puro e não usa nada específico de nenhum provedor, então migrar é trocar
um arquivo de configuração.

- **Cloudflare Pages** — gratuito com uso comercial explicitamente permitido, conecta em
  repositório privado sem plano pago. É a opção mais barata sem zona cinzenta.
- **Vercel** — o `vercel.json` já está no repositório. Atenção: o plano gratuito da Vercel
  é restrito a uso **não comercial e pessoal**; para uso da empresa seria o Pro, a US$ 20
  por desenvolvedor/mês.
- **GitHub Pages** (o configurado) — proíbe usar o serviço para rodar negócio online,
  e-commerce ou SaaS comercial. Uma ferramenta interna de chão de fábrica não é nada disso,
  mas é interpretação, não autorização explícita.
</details>

## Situação das telas

| Tela | Situação |
|---|---|
| Execução | ✔ completa, com o fluxo de apontamento em duas etapas |
| Programação & Ocupação | ✔ plano semanal, quadro do dia, auto-programar, encaixar, rebalancear, otimizar |
| Lotes a baixar | ✔ cards, lotes críticos, devolução e relatório |
| Ordens | ✔ digitação, importação (3 formatos), painel de demanda, .xlsx e impressão |
| Qualidade | ✔ visual, amostra e encerramento no AGROTIS |
| Indicadores | ✔ por máquina e turno, Pareto de paradas, planejado × realizado |
| Cadastros | ✔ edição de químicos, receitas, máquinas, turnos, embalagens e motivos |
| Administração | ✔ usuários e matriz de permissões (só Gestor) |

**Pendente:** integração com o SAP (bloqueada por infraestrutura — ver `docs/integracao-sap.md`)
e as decisões de §7 do `CLAUDE.md`.

## Estrutura

```
tsi-app/
├── CLAUDE.md                        # especificação completa (o Claude Code lê sozinho)
├── README.md
├── vercel.json                      # build, rewrites e cabeçalhos do deploy
├── docs/
│   ├── prototipo-referencia.html    # protótipo original — especificação executável
│   ├── integracao-sap.md            # Service Layer: endpoints, diagnóstico e checklist
│   └── dados-exemplo/               # planilhas reais (fora do git)
├── supabase/
│   ├── schema.sql                   # schema `tsi`: tabelas, views, triggers, RLS e seed
│   └── seed-exemplo.sql             # dados de demonstração (densidades fictícias)
└── src/
    ├── dominio/                     # regras e cálculos, cobertos por testes
    │   └── importacao/              # conversões da SimpleAgro e de ordens
    ├── dados/                       # acesso ao Supabase e realtime
    ├── telas/                       # as oito telas
    ├── componentes/                 # peças visuais compartilhadas
    ├── auth/                        # sessão e perfil
    └── lib/                         # cliente do Supabase, exportação e impressão
```

## Fontes de dados (hoje upload, amanhã API)

| Dado | Origem | Situação |
|---|---|---|
| Pedidos de venda | SimpleAgro → relatório *Pedidos Analítico Resumido* | upload .xlsx (conversão validada) |
| Estoque PA + lotes de semente | SimpleAgro → tela *Saldos* | upload .xlsx (conversão validada) |
| Ordens de produção | outro sistema | digitação ou importação |
| Futuro | SAP B1 Service Layer (HANA, hospedado Agrotis) | **pendente**: chamado para exposição externa + usuário somente leitura |

## Verificação

O protótipo tem 82 verificações automatizadas cobrindo capacidade, densidade/ensaque,
auto-programação, fluxo de execução em duas etapas, recurso único, matriz de status, estorno,
mistura em tanque, balanço de demanda e as conversões dos dois relatórios da SimpleAgro
(inclusive os números conferidos: **1.018 bags aprovados** e **753 lotes / 16.865 bags**).
Ao reimplementar em React, **porte esses casos para testes** (Vitest) — eles são o contrato do domínio.
