# Continuar o projeto em outro computador

Roteiro para pôr o TSI para rodar numa máquina nova, sem recriar nada. O projeto inteiro vive
no GitHub (`https://github.com/arionveneza/Ensaque`) — o que **não** vai junto são só as
credenciais e as preferências de cada máquina. Leva uns 15 minutos.

## Caminho rápido (deixa o Claude Code fazer)

1. Instale o **Claude Code** e faça login com a mesma conta.
2. Instale o **Git** (https://git-scm.com) e o **Node.js 22 ou mais novo**
   (https://nodejs.org — aqui roda o 24).
3. Abra o Claude Code numa pasta vazia (ex.: `Downloads`) e peça:

   > clone https://github.com/arionveneza/Ensaque.git e prepare o ambiente para rodar

   Ele clona, roda o `npm install` e avisa o que falta.
4. Faça só o passo que ninguém pode fazer por você: o **`.env.local`** (abaixo).

## O `.env.local` — o único arquivo que não vem no clone

Ele fica de fora do Git de propósito (regra do §4.1 do `CLAUDE.md`: credencial não entra em
repositório). Crie o arquivo `.env.local` na raiz do projeto com duas linhas:

```
VITE_SUPABASE_URL=https://<id-do-projeto>.supabase.co
VITE_SUPABASE_ANON_KEY=<a chave anon public>
```

Os dois valores estão em **supabase.com → projeto Sistema_de_ensaque → Settings → API**
(`Project URL` e `anon public`). Sem esse arquivo o app nem abre: ele avisa na tela que as duas
variáveis são obrigatórias.

## Conferir que está tudo de pé

```bash
npm install
npm run dev
```

O app sobe em `http://localhost:5173`. Entre com o seu e-mail e senha de sempre — o login é do
Supabase, não da máquina, então funciona igual em qualquer computador.

Para conferir que nada quebrou no caminho:

```bash
npm test
```

Devem passar todos os testes (640 em 18/09/2026).

## Logins extras — só se for publicar ou mexer no banco por ali

Nenhum dos dois é necessário para desenvolver e ver o app rodando.

- **Publicar no ar** (`npx wrangler deploy`): antes, uma vez, `npx wrangler login` — abre o
  navegador e entra na conta Cloudflare.
- **Rodar migração no banco** (`npx supabase db query …`): antes, uma vez,
  `npx supabase login`.

O `git push` não precisa de configuração: na primeira vez o Windows abre a janela do GitHub
para você entrar, e guarda a partir dali.

## O que NÃO vai junto (e está certo assim)

| O quê | Por quê |
|---|---|
| **Ajuste fino da ficha de químicos** | É da impressora ligada àquele computador. Na máquina nova, imprima o "Teste de alinhamento" e acerte de novo pelo menu da ficha. |
| **Foto do Endereçamento planilha** | Cópia local da planilha do Google. Basta tocar em "Atualizar agora" na tela. |
| **`node_modules`** | Recriado pelo `npm install`. |
| **Permissões locais do Claude Code** | `.claude/settings.local.json` é por máquina; ele pergunta de novo o que precisar. |
| **Memória do Claude Code** | As preferências que ele guardou sobre o seu jeito de trabalhar são desta máquina. O que importa do projeto está no `CLAUDE.md`, que vem no clone. |

## Regra de ouro trabalhando em dois computadores

**Antes de começar, puxe o que o outro computador fez:**

```bash
git pull
```

E no fim do trabalho, confira que subiu:

```bash
git status
```

O Claude Code já faz `commit` e `push` a cada mudança, então o GitHub é sempre a versão boa. O
único jeito de dar dor de cabeça é começar a mexer numa máquina que está atrasada — o `git pull`
de dois segundos evita isso.
