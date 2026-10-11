# Contrato de atribuição

Diz de onde veio cada cadastro (campanha, indicação ou orgânico) e guarda o porquê. Não depende de referrer: a origem viaja no próprio link, o app repassa o link que abriu e o servidor decide no cadastro.

Biblioteca em TypeScript com a regra em funções puras ([src/attribution.ts](src/attribution.ts)) e uma API Fastify fina por cima ([src/server.ts](src/server.ts)).

## Rodar

Precisa de Node 22.18 ou mais novo (o Node executa o TypeScript direto).

```bash
npm install
npm test
npm run typecheck
ATTRIBUTION_LINK_SECRET=segredo-de-exemplo npm start
```

`ATTRIBUTION_WINDOW_DAYS` muda a janela (padrão 7) e `PORT` a porta (padrão 3000).

## O contrato

### 1. O que viaja no link

| Parâmetro | Significado |
| --- | --- |
| `v` | Versão do contrato. Hoje `1`. |
| `t` | `campaign` ou `referral`. |
| `id` | Slug da campanha, ou código de quem indicou. |
| `ch` | Canal de divulgação. Opcional. |
| `sig` | HMAC-SHA256 dos campos acima, em base64url. |

Link de campanha:

```
https://conty.app/l?v=1&t=campaign&id=creators-out26&ch=instagram&sig=YutJD5PdFjBMf_EwhJr3coNOr8a2OjN5YS3K2ggIHrE
```

Link de indicação:

```
https://conty.app/l?v=1&t=referral&id=ana-7f3k&sig=S2zTcWtQd-SZE5JI1GylRuI-raYoxIUBynTPRTs_KOw
```

Os dois foram gerados por `buildLink` com a chave `segredo-de-exemplo` e estão fixados em [test/link.test.ts](test/link.test.ts). A assinatura impede que alguém troque o código de indicação à mão. Só a query é lida, então o mesmo link funciona como deep link (`conty://l?...`), e parâmetros fora do contrato são ignorados.

O link é estático: todo mundo que recebe a campanha recebe o mesmo link. Por isso "o mesmo clique" é o par instalação + link (`linkId` é um hash dos campos).

### 2. O que o app grava no primeiro abertura

O app gera um `installId` na primeira execução, guarda localmente e faz duas chamadas:

| Chamada | Quando | Resposta |
| --- | --- | --- |
| `POST /installs/:installId/first-open` | Na primeira execução. | Primeiro abertura e fim da janela. |
| `POST /installs/:installId/touches` com `{ "url", "deviceAt"? }` | Toda vez que o app abre por um link. | `201` toque novo, `200` clique repetido, `422` link rejeitado. |

O primeiro abertura é o primeiro contato da instalação com o servidor, por qualquer rota, e nunca muda depois. Se o toque chegar antes do aviso, ele fixa o primeiro abertura.

Todo horário que decide algo é o do servidor, em UTC. `deviceAt` é guardado só para auditoria.

Link rejeitado (assinatura errada, malformado, versão ou tipo desconhecido) responde `422`, mas fica gravado com o motivo e aparece na auditoria. Nunca vence.

### 3. Como o cadastro consome

`POST /signups` com `{ "userId", "installId"? }` calcula a origem, grava a decisão e a devolve. A decisão é gravada uma vez: repetir a chamada devolve a mesma (`200` em vez de `201`), mesmo que novos toques tenham chegado.

`GET /signups/:userId/attribution` devolve a decisão gravada mais os toques que chegaram depois do cadastro, marcados como `after_signup`.

## A regra (`last_touch_v1`)

A janela é `[primeiro abertura, primeiro abertura + 7 dias]`, com os dois limites inclusivos. Ela conta do primeiro abertura do app, não do clique.

Um toque é elegível quando o link é válido, foi recebido dentro da janela e até o instante do cadastro, e o cadastro também aconteceu dentro da janela. Entre os elegíveis vence o mais recente. Em horário idêntico, vence o de maior `seq` (a ordem de recebimento no servidor).

Reclicar o mesmo link não cria toque novo nem renova o horário, só soma `clickCount`. Em A, B, A vence B.

Motivo de cada toque na resposta:

| `reason` | Significado |
| --- | --- |
| `won` | Último toque elegível. |
| `superseded_by_later_touch` | Havia um elegível mais recente. |
| `lost_tie_by_sequence` | Mesmo horário do vencedor, sequência menor. |
| `rejected_link` | Link inválido. |
| `after_signup` | Chegou depois do cadastro. |
| `outside_window` | Recebido fora da janela. |
| `window_expired_before_signup` | Toque na janela, cadastro depois do fim dela. |
| `install_already_attributed` | A instalação já deu origem a outro cadastro. |

Cadastro sem origem fica com `origin.kind = "organic"` e um motivo:

| `origin.reason` | Significado |
| --- | --- |
| `no_install` | Cadastro sem `installId`. |
| `no_touches` | A instalação não abriu nenhum link. |
| `no_eligible_touch` | Havia toques, nenhum elegível. |
| `window_expired` | Cadastro depois do fim da janela. |
| `install_already_attributed` | A instalação já deu origem a outro cadastro. |

## Exemplo de auditoria

Resposta real de `GET /signups/user-42/attribution`, depois de um link de campanha, um de indicação, um de indicação adulterado e, após o cadastro, mais um link inválido (campos repetidos cortados com `...`):

```json
{
  "userId": "user-42",
  "installId": "inst-42",
  "rule": "last_touch_v1",
  "signupAt": "2026-10-11T23:51:19.518Z",
  "firstOpenAt": "2026-10-11T23:51:19.440Z",
  "window": {
    "durationMs": 604800000,
    "startsAt": "2026-10-11T23:51:19.440Z",
    "endsAt": "2026-10-18T23:51:19.440Z"
  },
  "origin": { "kind": "referral", "id": "ana-7f3k", "channel": null, "linkId": "3e723c4b5d97cf2b", "touchSeq": 2 },
  "touches": [
    {
      "seq": 1,
      "url": "https://conty.app/l?v=1&t=campaign&id=creators-out26&ch=instagram&sig=...",
      "linkId": "9d77bb0d360b720b",
      "type": "campaign",
      "id": "creators-out26",
      "channel": "instagram",
      "receivedAt": "2026-10-11T23:51:19.467Z",
      "deviceAt": null,
      "clickCount": 1,
      "outcome": "lost",
      "reason": "superseded_by_later_touch",
      "detail": "Havia um toque elegível mais recente (seq 2)."
    },
    {
      "seq": 2,
      "type": "referral",
      "id": "ana-7f3k",
      "receivedAt": "2026-10-11T23:51:19.484Z",
      "outcome": "won",
      "reason": "won",
      "detail": "Último toque elegível dentro da janela.",
      "...": "..."
    },
    {
      "seq": 3,
      "url": "https://conty.app/l?v=1&t=referral&id=bia-1x9z&sig=...",
      "type": null,
      "receivedAt": "2026-10-11T23:51:19.501Z",
      "outcome": "lost",
      "reason": "rejected_link",
      "detail": "Link rejeitado (invalid_signature); nunca concorre.",
      "...": "..."
    },
    {
      "seq": 4,
      "receivedAt": "2026-10-11T23:51:19.534Z",
      "outcome": "lost",
      "reason": "rejected_link",
      "detail": "Link rejeitado (invalid_signature); nunca concorre.",
      "...": "..."
    }
  ]
}
```

## Como biblioteca

```ts
import { buildLink } from './src/link.ts';
import { createAttribution } from './src/service.ts';
import { MemoryStore } from './src/store.ts';

const secret = 'segredo-de-exemplo';
const attribution = createAttribution({ store: new MemoryStore(), secret });

await attribution.firstOpen('inst-42');
await attribution.touch({ installId: 'inst-42', url: buildLink({ type: 'referral', id: 'ana-7f3k' }, secret) });
const { decision } = await attribution.signup({ userId: 'user-42', installId: 'inst-42' });
```

`decide` em [src/attribution.ts](src/attribution.ts) é a regra pura: recebe os toques, o primeiro abertura, o horário do cadastro e a janela, e devolve a decisão.

## Decisões e o que custam

- **Último toque**: fácil de explicar e de auditar. A campanha que só relembrou leva o crédito de quem apresentou o app.
- **Reclique não renova o horário**: retry de rede nunca muda o vencedor. Em troca, quem voltou ao link A depois de abrir B fica atribuído a B.
- **Relógio do servidor**: imune a relógio errado ou adulterado no aparelho. Um toque feito offline entra com o horário do envio.
- **Janela vale para toque e cadastro**: a origem expira de verdade. Quem instalou por campanha e só se cadastrou no oitavo dia vira orgânico, com o motivo `window_expired` e o toque listado.
- **Decisão imutável**: mudar a regra ou a janela não reescreve o passado; `rule` e `window` ficam gravados em cada decisão. Reprocessar exigiria uma versão nova da regra.

## Fora do escopo

- **Banco de dados**: o `MemoryStore` perde tudo ao reiniciar. A interface `Store` em [src/store.ts](src/store.ts) lista as três unicidades que viram `UNIQUE` num banco (`installId`; `installId` + `dedupeKey`; `userId` na decisão). A checagem de instalação já atribuída é leitura seguida de escrita, e num banco precisaria de `UNIQUE` em `installId` da decisão atribuída.
- **Rotação de chave**: há uma chave HMAC só. Rotacionar pede um identificador de chave no link.
- **Autenticação das rotas** e limite de requisições.
- **Reinstalação**: `installId` novo é uma instalação nova, com janela nova.
- **Encurtador ou redirect** que registre o clique antes de o app abrir.

## Verificação

- `npm test`: 67 testes em 5 arquivos.
- `npm run typecheck`: sem erros.
- Para conferir que os testes protegem as regras, cada uma de 20 regras foi quebrada sozinha (limite da janela, desempate, dedupe, assinatura, relógio, idempotência do cadastro e outras) e a suíte falhou nas 20. Isso foi feito por um script fora do repositório.
- O exemplo de auditoria acima veio do servidor real, chamado com `curl`.

## Uso de IA

O código, os testes e este README foram escritos com o Claude Code (Claude Opus 5.5).

As decisões de desenho foram minhas, respondidas uma a uma antes de qualquer código: último toque vence, desempate por sequência de recebimento, link legível com assinatura, clique repetido mantém o primeiro horário, relógio do servidor, janela de 7 dias valendo para toque e cadastro, decisão imutável, link inválido gravado como rejeitado, persistência em memória, Fastify e Vitest.

Ainda não revisei o código nem os testes linha a linha.
