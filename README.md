# Contrato de atribuição

Este serviço grava a origem de cada cadastro (campanha, indicação ou orgânico) e o motivo. A origem viaja no link, então o serviço não usa referrer.

A regra está em [src/attribution.ts](src/attribution.ts). A API Fastify está em [src/server.ts](src/server.ts).

## Rodar

Use Node 22.18 ou mais novo.

```bash
npm install
npm test
npm run typecheck
ATTRIBUTION_LINK_SECRET=segredo-de-exemplo npm start
```

`ATTRIBUTION_WINDOW_DAYS` define a janela (padrão 7). `ATTRIBUTION_PRE_INSTALL_WINDOW_HOURS` define a janela do clique feito antes da instalação (padrão 24). `ATTRIBUTION_DB_PATH` define o arquivo SQLite (padrão `attribution.db`). `PORT` define a porta (padrão 3000).

## Contrato

### 1. Link

| Parâmetro | Significado |
| --- | --- |
| `v` | Versão do contrato. Hoje `1`. |
| `t` | `campaign` ou `referral`. |
| `id` | Slug da campanha, ou código de quem indicou. |
| `ch` | Canal. Opcional. |
| `sig` | HMAC-SHA256 dos outros campos. |

Campanha:

```
https://conty.app/l?v=1&t=campaign&id=creators-out26&ch=instagram&sig=YutJD5PdFjBMf_EwhJr3coNOr8a2OjN5YS3K2ggIHrE
```

Indicação:

```
https://conty.app/l?v=1&t=referral&id=ana-7f3k&sig=S2zTcWtQd-SZE5JI1GylRuI-raYoxIUBynTPRTs_KOw
```

A chave destes exemplos é `segredo-de-exemplo`. A assinatura impede a troca manual do código de indicação. O servidor lê só a query, então o deep link `conty://l?...` também funciona.

O link é igual para todas as pessoas. Por isso, "o mesmo clique" é o par instalação e link.

### 2. Primeira abertura

O app gera um `installId` de até 100 caracteres na primeira execução e o guarda no aparelho.

| Chamada | Quando | Resposta |
| --- | --- | --- |
| `POST /clicks` com `{ "url" }` | No clique, antes de instalar. | `clickId` e até quando ele vale. |
| `POST /installs/:installId/first-open` com `{ "clickId"? }` | Na primeira execução. | Primeira abertura e fim da janela. Com `clickId`, se o clique foi resgatado. |
| `POST /installs/:installId/touches` com `{ "url", "deviceAt"? }` | Sempre que um link abre o app. | `201` toque novo, `200` clique repetido, `422` link rejeitado. |

A primeira abertura é o primeiro contato da instalação com o servidor, em qualquer rota. Ela nunca muda.

O relógio do servidor, em UTC, define todos os horários. `deviceAt` serve só para auditoria.

O servidor grava o link rejeitado com o motivo. Um toque rejeitado nunca vence.

### 3. Cadastro

`POST /signups` com `{ "userId", "installId"? }` grava a decisão uma vez e a devolve. Uma chamada repetida devolve a mesma decisão, com `200`.

`GET /signups/:userId/attribution` devolve a decisão e os toques posteriores ao cadastro.

## Regra (`last_touch_v1`)

A janela é `[primeira abertura, primeira abertura + 7 dias]`, com limites inclusivos. O horário do clique não altera a janela.

Um toque é elegível quando o link é válido, o toque chegou dentro da janela e até o cadastro, e o cadastro aconteceu dentro da janela. O clique resgatado na primeira abertura tem janela própria: ele é elegível se aconteceu até 24 horas antes da primeira abertura, com limite inclusivo. A decisão grava essa janela em `preInstallWindow`.

O toque elegível mais recente vence. Em horário igual, vence o maior `seq` (ordem de recebimento no servidor).

Um clique repetido só aumenta `clickCount` e mantém o primeiro horário. Na sequência A, B, A, vence B.

| `reason` do toque | Significado |
| --- | --- |
| `won` | Último toque elegível. |
| `superseded_by_later_touch` | Outro toque elegível é mais recente. |
| `lost_tie_by_sequence` | Mesmo horário do vencedor, `seq` menor. |
| `rejected_link` | Link inválido. |
| `after_signup` | Chegou depois do cadastro. |
| `outside_window` | Chegou fora da janela. |
| `pre_install_click_too_old` | Clique de antes da instalação, mais velho que a janela dele. |
| `window_expired_before_signup` | Toque na janela, cadastro depois do fim dela. |
| `install_already_attributed` | A instalação já deu origem a outro cadastro. |

Um cadastro sem origem recebe `origin.kind = "organic"` e um destes motivos:

| `origin.reason` | Significado |
| --- | --- |
| `no_install` | Cadastro sem `installId`. |
| `no_touches` | A instalação não abriu nenhum link. |
| `no_eligible_touch` | Nenhum toque é elegível. |
| `window_expired` | Cadastro depois do fim da janela. |
| `install_already_attributed` | A instalação já deu origem a outro cadastro. |

## Exemplo de auditoria

Resposta real de `GET /signups/user-42/attribution`. A instalação abriu um link de campanha, um de indicação e um adulterado. Depois do cadastro, abriu outro link inválido. Cada toque também tem `url`, `linkId`, `channel`, `deviceAt`, `clickCount` e `preInstall`, e a decisão tem `preInstallWindow`, omitidos aqui.

```json
{
  "userId": "user-42",
  "installId": "inst-42",
  "rule": "last_touch_v1",
  "signupAt": "2026-10-11T23:51:19.518Z",
  "firstOpenAt": "2026-10-11T23:51:19.440Z",
  "window": { "durationMs": 604800000, "startsAt": "2026-10-11T23:51:19.440Z", "endsAt": "2026-10-18T23:51:19.440Z" },
  "origin": { "kind": "referral", "id": "ana-7f3k", "channel": null, "linkId": "3e723c4b5d97cf2b", "touchSeq": 2 },
  "touches": [
    { "seq": 1, "type": "campaign", "id": "creators-out26", "receivedAt": "2026-10-11T23:51:19.467Z", "outcome": "lost", "reason": "superseded_by_later_touch", "detail": "Havia um toque elegível mais recente (seq 2)." },
    { "seq": 2, "type": "referral", "id": "ana-7f3k", "receivedAt": "2026-10-11T23:51:19.484Z", "outcome": "won", "reason": "won", "detail": "Último toque elegível dentro da janela." },
    { "seq": 3, "type": null, "id": null, "receivedAt": "2026-10-11T23:51:19.501Z", "outcome": "lost", "reason": "rejected_link", "detail": "Link rejeitado (invalid_signature); nunca concorre." },
    { "seq": 4, "type": null, "id": null, "receivedAt": "2026-10-11T23:51:19.534Z", "outcome": "lost", "reason": "rejected_link", "detail": "Link rejeitado (invalid_signature); nunca concorre." }
  ]
}
```

## Uso como biblioteca

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

## Decisões e custos

| Decisão | Custo |
| --- | --- |
| Último toque vence. | A campanha que só relembrou recebe o crédito de quem apresentou o app. |
| Clique repetido mantém o horário. | Quem voltou ao link A depois de abrir B fica com B. |
| O relógio do servidor decide. | Um toque feito offline recebe o horário do envio. |
| A janela vale para toque e cadastro. | Um cadastro no oitavo dia fica orgânico. |
| A decisão é imutável e grava `rule` e `window`. | Reprocessar exige uma versão nova da regra. |

## Fora do escopo

- Rotação da chave HMAC.
- Autenticação das rotas e limite de requisições.
- Reinstalação. Um `installId` novo tem janela nova.
- O redirect que chama `POST /clicks` e a entrega do `clickId` ao app pela loja. O serviço guarda o clique e o resgata na primeira abertura; sem `clickId`, o cadastro de quem clicou e depois instalou fica orgânico (`no_touches`). O webview sem referrer não afeta o caso em que o app já está instalado.

## Verificação

- `npm test` passa com 174 testes em 9 arquivos.
- `npm run typecheck` não mostra erros.
- Teste de mutação: o Stryker gerou 346 mutantes e os testes falham em 339. Os outros 7 não mudam o comportamento. O teste rodou em uma cópia fora do repositório. Ele rodou antes dos últimos ajustes de legibilidade e dos dois testes de ordenação.
- O exemplo de auditoria veio do servidor real, chamado com `curl`.

## Uso de IA

O Claude Code (Claude Opus 5.5) escreveu o código, os testes e este README.

Eu tomei as decisões de desenho antes do código: último toque vence, desempate por sequência, link assinado, clique repetido mantém o horário, relógio do servidor, janela de 7 dias, decisão imutável, link inválido gravado, Fastify e Vitest.

Revisei à mão os trechos de maior risco: `decide` em `src/attribution.ts`, `parseLink` em `src/link.ts`, `signup` e `audit` em `src/service.ts`, `recordTouch` em `src/store.ts` e os schemas de `src/server.ts`. Questionei dez trechos. Cinco viraram mudanças de legibilidade. Os outros cinco ficaram como estavam, com justificativa: horários em epoch, ordem das desqualificações, função interna, passada única sobre os toques e posição da conferência de assinatura.

Também pedi o teste de mutação, que mostrou os casos de teste que faltavam.

Ainda não revisei os testes linha por linha.
