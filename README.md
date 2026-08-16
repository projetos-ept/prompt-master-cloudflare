# Prompt Master — PWA + Cloudflare Worker

Acervo pessoal de prompts com funcionamento offline, salvamento automático e sincronização entre dispositivos. A interface é publicada no GitHub Pages, enquanto a API funciona em um Cloudflare Worker com D1 e R2.

## Visão geral

```text
GitHub Pages
└── PWA em HTML, CSS e JavaScript
    ├── IndexedDB: dados locais e fila offline
    ├── Service Worker: arquivos do aplicativo em cache
    └── HTTPS: comunicação com a API

Cloudflare Worker
├── API_TOKEN: autenticação
├── D1 / binding DB: prompts e metadados
└── R2 / binding ATTACHMENTS: conteúdo dos anexos
```

O GitHub Pages não recebe os prompts. Ele hospeda somente os arquivos estáticos do aplicativo.

## Recursos incluídos

- PWA responsivo e instalável;
- funcionamento sem internet;
- IndexedDB como banco local;
- salvamento automático após 850 ms sem digitação;
- fila persistente e reenvio quando a conexão retorna;
- prevenção de operações duplicadas;
- controle de versão e resolução visual de conflitos;
- busca por título, conteúdo, categoria e tags;
- favoritos, fixação, arquivamento, duplicação e exclusão;
- anexos privados no Cloudflare R2;
- importação e exportação JSON;
- cópia inteligente para colar diretamente em outra IA;
- modo claro e escuro sem dependências externas;
- autenticação Bearer Token e restrição de origem por CORS;
- workflow de deploy do Worker pelo GitHub Actions.

## Estrutura

```text
prompt-master-cloudflare/
├── docs/                         PWA publicado no GitHub Pages
├── worker/index.ts               API do Cloudflare Worker
├── migrations/0001_initial.sql   estrutura inicial do D1
├── .github/workflows/            deploy automático do Worker
├── .dev.vars.example
├── wrangler.jsonc
├── package.json
└── tsconfig.json
```

## O que é necessário

- conta Cloudflare e conta GitHub;
- Node.js e Git instalados;
- repositório GitHub;
- banco Cloudflare D1;
- bucket Cloudflare R2;
- Worker publicado;
- uma chave secreta criada por você.

Não é necessário manter um VPS. Confira os limites atuais do plano Cloudflare escolhido antes de armazenar uma grande quantidade de arquivos.

# Configuração completa do Cloudflare

## 1. Instalar e autenticar

Extraia o ZIP, abra o terminal dentro de `prompt-master-cloudflare` e execute:

```bash
npm install
npx wrangler login
```

O navegador será aberto para autorizar o Wrangler.

## 2. Criar o banco D1

```bash
npx wrangler d1 create prompt-master-db
```

O comando retorna um `database_id`. Abra `wrangler.jsonc` e substitua:

```json
"database_id": "SUBSTITUA_PELO_ID_DO_D1"
```

pelo ID real. O binding deve continuar se chamando `DB`, pois o Worker usa `env.DB`.

### Pelo painel

1. Abra **Storage & Databases → D1 SQL database**.
2. Escolha **Create database**.
3. Use `prompt-master-db`.
4. Copie o ID para `wrangler.jsonc`.

## 3. Criar o bucket R2

```bash
npx wrangler r2 bucket create prompt-master-anexos
npx wrangler r2 bucket list
```

O binding já está configurado:

```json
"r2_buckets": [{
  "binding": "ATTACHMENTS",
  "bucket_name": "prompt-master-anexos"
}]
```

Não altere `ATTACHMENTS` sem alterar também o Worker.

### Pelo painel

1. Abra **R2 Object Storage**.
2. Escolha **Create bucket**.
3. Use `prompt-master-anexos`.
4. Mantenha o bucket privado.

O navegador acessa os arquivos pela API autenticada; o bucket não precisa ser público nem ter CORS próprio.

## 4. Aplicar a estrutura do D1

Depois de colocar o ID correto no `wrangler.jsonc`:

```bash
npm run db:remote
```

Isso aplica `migrations/0001_initial.sql` e cria as tabelas `prompts`, `operations`, `attachments` e seus índices. O D1 registra as migrações já aplicadas.

## 5. Criar a chave de acesso

Gere uma senha longa e aleatória e cadastre-a como segredo:

```bash
npx wrangler secret put API_TOKEN
```

O projeto declara `API_TOKEN` como obrigatório. O deploy indicará claramente se ele estiver ausente.

### Pelo painel, para um Worker que já existe

1. Abra **Workers & Pages**.
2. Selecione `prompt-master-api`.
3. Abra **Settings → Variables and Secrets**.
4. Adicione `API_TOKEN` como **Secret**.
5. Informe a chave e confirme o deploy.

Na primeira instalação, prefira `npx wrangler secret put API_TOKEN`, pois o projeto exige esse segredo antes do deploy normal.

Nunca coloque essa chave em `wrangler.jsonc`, `app.js`, README ou commit.

## 6. Autorizar o GitHub Pages

Edite `ALLOWED_ORIGINS` em `wrangler.jsonc`:

```json
"ALLOWED_ORIGINS": "http://localhost:8080,https://SEU-USUARIO.github.io"
```

Exemplo:

```json
"ALLOWED_ORIGINS": "http://localhost:8080,https://hyskal.github.io"
```

Use somente a origem, sem o repositório e sem barra final.

```text
Correto:   https://hyskal.github.io
Incorreto: https://hyskal.github.io/prompt-master/
```

Separe múltiplos domínios por vírgula.

## 7. Publicar o Worker

```bash
npm run deploy
```

O Wrangler mostra uma URL semelhante a:

```text
https://prompt-master-api.seu-subdominio.workers.dev
```

Guarde-a para a primeira abertura do PWA.

## 8. Testar a API

Abra o endpoint público de saúde:

```text
https://prompt-master-api.seu-subdominio.workers.dev/api/health
```

Resposta esperada:

```json
{"ok":true,"service":"prompt-master-api"}
```

As demais rotas exigem `Authorization: Bearer SUA_CHAVE`.

# Publicação no GitHub Pages

1. Envie todo o projeto para o GitHub, mantendo `docs` na raiz.
2. Abra **Settings → Pages**.
3. Selecione **Deploy from a branch**.
4. Escolha a branch `main` e a pasta `/docs`.
5. Salve e aguarde.

O endereço será semelhante a:

```text
https://SEU-USUARIO.github.io/NOME-DO-REPOSITORIO/
```

Os caminhos do PWA são relativos e funcionam no subdiretório do repositório.

Na primeira abertura, informe:

- **URL da API:** URL do Worker, sem `/api/prompts`;
- **Chave:** o mesmo valor cadastrado em `API_TOKEN`.

# Salvamento automático e offline

1. O usuário altera o prompt.
2. Após 850 ms sem digitação, o PWA grava no IndexedDB.
3. A alteração entra na fila local.
4. Com internet, o Worker recebe a operação.
5. O D1 valida a versão e salva.
6. Só após a confirmação a operação sai da fila.
7. Se a conexão cair, tudo permanece no dispositivo.
8. Quando a internet volta, o envio recomeça automaticamente.

Cada operação possui um identificador. Se uma resposta se perder, o Worker reconhece o reenvio e evita duplicação.

## Conflitos entre dispositivos

Cada prompt possui uma versão. Se um computador editar a versão 4 enquanto o celular já salvou a versão 5, o PWA mostra ambas e permite usar a versão do servidor ou manter a versão local. Nada é sobrescrito silenciosamente.

# Botão Copiar

## Prompt sem anexos

O botão copia somente o texto principal, pronto para colar no ChatGPT, Claude, Gemini ou outra IA.

## Prompt com anexos

O botão monta um JSON autoexplicativo compatível com o Prompt Master anterior:

```json
{
  "_instrucao": "Você recebeu um prompt exportado do Prompt Master...",
  "versao": 1,
  "exportado_em": "2026-08-16T17:12:30.000Z",
  "total": 1,
  "prompts": [{
    "id": "identificador",
    "titulo": "Mapa de Trabalho TAC",
    "prompt": "Crie um mapa de trabalho...",
    "categoria": "Dev",
    "tags": [],
    "data": "2026-06-15T01:55:56.000Z",
    "fixado": false,
    "arquivos": [{
      "nome": "mapa.html",
      "conteudo": "<!doctype html>..."
    }]
  }]
}
```

HTML, CSS, JavaScript, Markdown, JSON, Python, SQL e outros textos entram diretamente em `arquivos[].conteudo`.

Binários usam Data URL:

```json
{
  "nome": "referencia.pdf",
  "conteudo": "data:application/pdf;base64,...",
  "codificacao": "data-url",
  "tipo_mime": "application/pdf"
}
```

Para copiar anexos que já estão no R2, o dispositivo precisa estar conectado. Se não estiver, o PWA avisa que precisa da internet para produzir uma cópia completa.

# Importação e exportação

A exportação cria o mesmo pacote portátil da cópia, incluindo `_instrucao` e `arquivos[].conteudo`.

O importador aceita:

- formato atual `titulo`, `prompt` e `arquivos`;
- listas antigas de prompts;
- formato provisório `title`, `content` e `attachments`;
- anexos textuais em `conteudo`;
- anexos em Base64/Data URL.

Assim, JSONs do Prompt Master anterior podem ser migrados.

# Modo escuro

- Na primeira abertura, o PWA respeita `prefers-color-scheme` do sistema.
- O botão `◐` alterna o tema.
- A escolha é salva em `localStorage` como `pm_theme`.
- O tema funciona offline e não depende de CDN.

Para personalizar:

```css
:root { --primary: #6d4aff; }
:root[data-theme="dark"] { --primary: #9278ff; }
```

As variáveis ficam em `docs/styles.css`.

# Desenvolvimento local

Copie `.dev.vars.example` para `.dev.vars` e informe uma chave de teste:

```text
API_TOKEN=uma-chave-de-teste
```

Não envie `.dev.vars` ao GitHub; ele já está no `.gitignore`.

Prepare o banco e inicie a API:

```bash
npm run db:local
npm run dev
```

Em outro terminal:

```bash
npx serve docs -l 8080
```

Abra `http://localhost:8080` e use `http://localhost:8787` como API.

# Deploy automático pelo GitHub Actions

O workflow publica o Worker quando o backend muda. Cadastre em **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN`;
- `CLOUDFLARE_ACCOUNT_ID`.

| Segredo | Função | Local |
|---|---|---|
| `API_TOKEN` | entrar no Prompt Master | Cloudflare Worker |
| `CLOUDFLARE_API_TOKEN` | autorizar o deploy | GitHub Actions |
| `CLOUDFLARE_ACCOUNT_ID` | identificar a conta | GitHub Actions |

O token de deploy deve possuir somente as permissões necessárias. A migração D1 não é executada automaticamente pelo workflow; aplique-a conscientemente com `npm run db:remote`.

# Segurança

- R2 privado e downloads pelo Worker autenticado;
- segredo principal armazenado no Cloudflare;
- CORS restrito ao domínio configurado;
- validação dos dados no Worker;
- prevenção de operações repetidas;
- controle de versão inclusive nas exclusões.

O modelo atual usa uma chave única e é adequado para um acervo pessoal. Antes de oferecer contas independentes, implemente autenticação individual e `owner_id` nas tabelas.

# Solução de problemas

## `401 Não autorizado`

- confira se a chave é igual a `API_TOKEN`;
- execute `npx wrangler secret put API_TOKEN` novamente;
- desconecte e conecte o PWA.

## Erro de CORS

- confira `ALLOWED_ORIGINS`;
- use somente `https://usuario.github.io`;
- publique novamente após alterar `wrangler.jsonc`.

## D1 não encontrado

- substitua o ID de exemplo;
- confira `prompt-master-db`;
- confirme a conta usada pelo Wrangler.

## Tabelas não encontradas

```bash
npm run db:remote
```

## Anexo não é enviado

- confira o bucket `prompt-master-anexos`;
- confira o binding `ATTACHMENTS`;
- respeite 5 MB por arquivo;
- sincronize novamente com internet estável.

## Aplicativo mostra versão antiga

Recarregue com internet ativa. Se necessário, feche todas as janelas do PWA instalado e abra novamente para o service worker atualizar o cache.

# Checklist

- [ ] `npm install` executado.
- [ ] Login do Wrangler realizado.
- [ ] D1 criado e ID colocado no `wrangler.jsonc`.
- [ ] R2 criado com o nome correto.
- [ ] Migração remota aplicada.
- [ ] `API_TOKEN` cadastrado como secret.
- [ ] `ALLOWED_ORIGINS` atualizado.
- [ ] Worker publicado e `/api/health` testado.
- [ ] GitHub Pages ativado em `/docs`.
- [ ] URL do Worker informada no PWA.
- [ ] Testes de edição offline, cópia com anexo e exportação realizados.

# Referências oficiais

- D1: https://developers.cloudflare.com/d1/
- Migrações D1: https://developers.cloudflare.com/d1/reference/migrations/
- R2 com Workers: https://developers.cloudflare.com/r2/get-started/workers-api/
- Secrets: https://developers.cloudflare.com/workers/configuration/secrets/
- Wrangler: https://developers.cloudflare.com/workers/wrangler/configuration/
