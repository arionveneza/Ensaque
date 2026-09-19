# Trabalhar o projeto em dois computadores

Roteiro para editar o TSI em mais de uma máquina, alternando entre elas. O projeto inteiro vive
no GitHub (`https://github.com/arionveneza/Ensaque`) — o que **não** vai junto são só as
credenciais e as preferências de cada máquina. Pôr a segunda máquina de pé leva uns 15 minutos;
depois disso, a sincronia é automática (ver a última seção).

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

## Sincronia entre as duas máquinas — já é automática

O Claude Code faz `commit` e `push` a cada mudança, então o **GitHub é sempre a versão boa**. E o
que faltava — puxar o que a outra máquina fez antes de começar — agora é automático: o arquivo
`.claude/settings.json` (versionado, vale nos dois computadores) tem um gancho que roda
`git pull --ff-only` toda vez que o projeto é aberto.

Como ele se comporta:

- **Nada mudou na outra máquina** → silêncio, você nem percebe.
- **A outra máquina trabalhou** → as mudanças entram e o resumo aparece na abertura.
- **Sem internet, ou as duas máquinas divergiram** → ele avisa o motivo e **não mexe em nada**.
  O `--ff-only` é justamente isso: ou avança limpo, ou não faz nada.

Na primeira vez que você abrir o projeto em cada máquina, o Claude Code pede para aprovar o
gancho — é a mesma pergunta de permissão de sempre, e a resposta fica guardada ali.

**A única disciplina que sobra:** não trabalhe nos dois computadores ao mesmo tempo. Termine
numa, deixe o Claude publicar, e só então abra na outra. Se as duas divergirem, o gancho avisa
na abertura e é só pedir ao Claude para resolver.
