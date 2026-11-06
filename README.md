# Processador distribuído de apostas

Implementei este serviço para o desafio da Jungle Gaming. Ele processa `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` por HTTP e SQS. Uma mesma `BET` de 80,00 BRL enviada pelos dois canais com a mesma identidade e chave é debitada uma vez. Se o `REFUND` chegar antes da `BET`, ele fica pendente no banco até o worker retomar a operação. [Enunciado do desafio](https://github.com/junglegaming/backend-challenge)

O serviço roda com Bun, TypeScript e NestJS. Uso MikroORM para acessar o PostgreSQL e MiniStack para rodar o SQS localmente. [Decisões de arquitetura](./ARCHITECTURE.md)

## Rodar com Docker Compose

Rode os comandos abaixo na raiz do repositório. O Docker precisa estar no modo de contêineres Linux. O Bun já vem na imagem.

```powershell
docker compose up -d --build --wait --wait-timeout 120
docker compose ps
1..3 | ForEach-Object { docker compose exec -T --index $_ app bun run testar:integracao }
```

O `migrador` prepara a conta `jungle_app`, aplica as migrações e cria as filas antes de as réplicas subirem. As três réplicas compartilham o banco e as filas e atendem nas portas `3001`, `3002` e `3003`. Os exemplos abaixo usam `http://127.0.0.1:3001`.

## Rodar com Bun no host

Use Bun 1.4.4. Se já houver um `.env`, pule o `Copy-Item` e confira as chaves em `.env.example` antes de seguir.

```powershell
docker compose up -d --wait postgres ministack
bun install --frozen-lockfile
Copy-Item .env.example .env
bun run verificar:tipos
bun run preparar:banco-local
bun run migrar:aplicar
bun run preparar:filas
bun run iniciar
```

Com a aplicação na porta `3000`, rode `bun run testar:integracao` em outro terminal. O teste consulta a API, grava e lê um `bigint` numa tabela temporária e chama `ListQueues` no SQS. Defina `URL_APLICACAO` se usar outra porta.

O `package.json` reúne os scripts, fixa as versões do Bun e das dependências diretas e configura o pacote como privado, com módulos ES. O `bun.lock` fixa as versões usadas na instalação. No `.env.example`, as credenciais são locais. `MENSAGERIA_ATIVA` liga os consumidores SQS e o publicador, e as chaves `REFERENCIAS_*` controlam o worker e seus prazos. [Configuração de exemplo](./.env.example)

## Rotas HTTP

| Método e rota | Resultado |
|---|---|
| `POST /wallets` | Abre uma wallet. Saldo inicial positivo gera um lançamento `OPENING`. |
| `GET /wallets/:walletId` | Mostra saldo atual e versão. |
| `GET /wagering/transactions/:transactionId` | Consulta o estado e o saldo histórico pelo UUID interno. |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Consulta o mesmo registro pela identidade externa no provedor. |
| `POST /wagering/transactions` | Processa `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK` com o cabeçalho obrigatório `Idempotency-Key`. |
| `GET /wallets/:walletId/ledger?limit=50&cursor=...` | Retorna `entries` e `nextCursor`. Use o cursor retornado para buscar a próxima página. |
| `POST /wallets/:walletId/reconciliation` | Compara o saldo registrado com o total do ledger. |

Envie um valor positivo para `BET` e `WIN` e zero para `LOSS`. O `LOSS` só registra o resultado, deixando saldo, versão e ledger como estavam. Uma rejeição de negócio fica gravada e retorna HTTP 422.

Se precisar reenviar uma operação concluída, use o mesmo corpo e a mesma chave para receber o saldo da decisão original. A API retorna HTTP 409 se você usar a chave com outro conteúdo ou enviar a mesma identidade externa com outra chave.

`REFUND` e `ROLLBACK` exigem `referenceExternalTransactionId` do mesmo provedor e o valor integral da operação original. `WIN` pode apontar para uma `BET` de valor diferente. Uma `BET` admite uma única reversão direta entre `REFUND` e `ROLLBACK`. O `ROLLBACK` de `WIN` ou `REFUND` debita a wallet e pode retornar `REVERSAL_INSUFFICIENT_FUNDS`. Uma operação processada com referência traz o UUID resolvido em `referenceTransactionId`.

Se a referência ainda não estiver disponível, o `POST` retorna HTTP 202 com `PENDING_REFERENCE` e mantém o saldo. Para acompanhar a operação, consulte-a pelo UUID ou pelo ID externo. O prazo padrão de 15 minutos começa na primeira aceitação e vale mesmo se você reenviar o comando. Quando o worker retoma uma operação com o prazo vencido, registra `REFERENCE_EXPIRED`.

## Demonstração e testes

Com o Compose rodando e o Bun instalado no host, execute `bun --env-file=.env.example run demonstrar`. O saldo começa em 100,00 BRL, cai para 20,00 BRL após uma `BET` enviada pelo SQS e volta a 100,00 BRL com um `REFUND` por HTTP. O script espera os eventos de abertura e aposta, consulta a `BET` e confere seu saldo histórico após o `REFUND`. No fim, a reconciliação deve mostrar três lançamentos e diferença zero. A wallet fica no banco local.

Rode uma suíte por vez, pois elas usam portas fixas. As suítes financeiras criam bancos descartáveis com a credencial administrativa local. Quando um teste cria filas, usa um prefixo próprio e remove as filas ao terminar.

| Comando | O que verifica |
|---|---|
| `bun run verificar:tipos` | TypeScript estrito |
| `bun test` | Domínio, referências e agendamento |
| `bun --env-file=.env.example run testar:protecoes` | Migrações up/down/up, BIGINT, constraints, triggers e privilégios |
| `bun --env-file=.env.example run testar:concorrencia` | Três processos. Duas `BET` de 80,00 BRL disputam um saldo de 100,00 BRL e produzem um único débito, com saldo final de 20,00 BRL. Também verifica reenvios e wallets independentes. |
| `bun --env-file=.env.example run testar:reversoes` | Reversões concorrentes, incompatibilidades e proteções em SQL direto |
| `bun --env-file=.env.example run testar:pendencias` | Referência tardia, expiração e retomada após reinício |
| `bun --env-file=.env.example run testar:consultas` | Busca pelos dois IDs, estados e saldo histórico |
| `bun --env-file=.env.example run testar:mensageria` | HTTP/SQS, inbox atômica, DLQ, retry, reinício, dois publishers e deduplicação persistente |
| `docker compose exec -T --index 1 app bun run testar:integracao` | Health, PostgreSQL e SQS. Repita com índices 2 e 3. |

No Postman, importe as coleções, confira se `base` está em `http://127.0.0.1:3001` e rode os itens em ordem. Cada execução abre uma wallet. No Newman, as duas coleções passaram com 30 requisições e 79 asserções. [Fluxo financeiro](./postman/fluxo-financeiro.postman_collection.json) · [Reversões e consultas](./postman/reversoes-e-consultas.postman_collection.json)

## Exemplos dos contratos

Envie o corpo abaixo para `POST http://localhost:3001/wallets`, com `Content-Type: application/json`.

```json
{
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "initialBalance": { "amount": "100.00", "currency": "BRL" }
}
```

Copie o `id` retornado na abertura para `walletId` no exemplo abaixo. Para enviar a aposta por HTTP, use só os campos de `data` no corpo de `POST /wagering/transactions`. Tire `idempotencyKey` do JSON e envie seu valor no cabeçalho `Idempotency-Key`.

Para SQS, envie o envelope inteiro à fila `wager-transactions.fifo`. Use `MessageGroupId` igual ao `walletId` e informe `MessageDeduplicationId` ao enviar a mensagem. [Exemplo com o SDK](./scripts/demonstrar.ts)

```json
{
  "messageId": "mensagem-001",
  "type": "WagerTransactionRequested",
  "occurredAt": "2026-11-05T18:00:00.000Z",
  "data": {
    "providerId": "provedor-a",
    "externalTransactionId": "aposta-001",
    "idempotencyKey": "provedor-a:aposta-001",
    "walletId": "SUBSTITUA-PELO-ID-RETORNADO",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "roundId": "rodada-001",
    "gameId": "jogo",
    "kind": "BET",
    "money": { "amount": "80.00", "currency": "BRL" }
  }
}
```

## Saúde e observabilidade

`GET /health/live` verifica se o processo responde. `GET /health/ready` consulta PostgreSQL e SQS e retorna 503 se uma dependência falhar. `GET /metrics` mostra o contador de divergências de reconciliação da réplica. Os logs JSON omitem o payload financeiro.

A API de demonstração roda localmente sem autenticação. O desenho para integrar um IdP e os limites de recuperação estão descritos na [arquitetura](./ARCHITECTURE.md#limites-operacionais).
