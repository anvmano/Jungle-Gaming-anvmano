# Arquitetura

O controller HTTP e o consumidor SQS chamam o mesmo `ServicoFinanceiro`. Uma transação no PostgreSQL reserva a identidade da operação, decide se ela pode ser aplicada e grava o resultado. Cada réplica roda um publicador que lê a outbox depois do commit.

## Dinheiro e persistência

Guardei dinheiro como centavos em `bigint`. Como o contrato exige duas casas decimais, consigo ler `"80.00"` como `8000` centavos sem arredondar. A coluna `BIGINT` limita o valor ao intervalo assinado de 64 bits. Um crédito que estoure esse limite retorna `BALANCE_LIMIT_EXCEEDED`. `Money` admite valores negativos em cálculos internos, valida entradas não negativas e rejeita operações entre moedas diferentes.

Uso o MikroORM para conexões, transações e migrações. Deixei a reserva de identidade e os locks em SQL no repositório para que a ordem das operações fique visível ali. Isso exige mapear os valores na fronteira com o banco. O driver recebe os centavos como texto, e o mapeador reconstitui `Money` ao ler a coluna `BIGINT`. As entidades usam factories e reidratação explícita, sem decoradores do ORM.

O schema garante uma wallet por jogador e moeda, uma transação por chave de idempotência e por identidade externa do provedor, uma entrada de inbox por consumidor e mensagem e um lançamento por transação e wallet. O ledger tem `CHECK` para conferir a aritmética e os saldos não negativos, além de um trigger que bloqueia alterações e exclusões. Outro trigger protege a identidade da transação e os estados terminais. A conta `jungle_app` tem permissões de escrita limitadas e o Compose usa uma conta separada para migrações. [Schema financeiro](./migracoes/001-criar-esquema-financeiro.ts)

O `CHECK` impede gravar saldo negativo. A transação do processador mantém o saldo e o ledger de acordo ao gravar os dois juntos. Um `UPDATE` direto feito com a credencial da aplicação pode alterar o saldo sem gerar um lançamento. A reconciliação compara os dois no mesmo snapshot e sinaliza a diferença sem mexer no saldo.

## Identidade e concorrência

O processador reserva a `Idempotency-Key` e a identidade externa com `INSERT ... ON CONFLICT DO NOTHING`. Se a operação já existir, ele pode ler o resultado confirmado sem abortar a transação SQL. O SHA-256 usa os campos de negócio normalizados, com as chaves do JSON ordenadas recursivamente. Reenviar uma operação concluída devolve o saldo gravado na decisão original, mesmo que a wallet já tenha mudado.

Usei `FOR NO KEY UPDATE` para bloquear a wallet da leitura do saldo até o commit. O lock é compatível com o `KEY SHARE` que a chave estrangeira adquire ao reservar a transação. Duas apostas na mesma wallet precisam esperar uma pela outra. Em wallets diferentes, podem avançar em paralelo. `LOSS` e rejeições gravam o resultado e o evento sem alterar saldo, versão ou ledger.

## Referências fora de ordem

O processador lê a referência e as reversões confirmadas depois de bloquear a wallet. `WagerTransaction.avaliarReferencia` decide se a operação pode prosseguir, precisa aguardar ou deve ser rejeitada. Uma incompatibilidade retorna `REFERENCE_MISMATCH`, mesmo se a referência estiver pendente. Uma referência compatível em `REJECTED` ou `FAILED` resulta em `REFERENCE_NOT_PROCESSED`.

Uma `BET` poderia devolver o mesmo valor duas vezes se aceitasse um `REFUND` e um `ROLLBACK` direto. Por isso o índice único parcial cobre os dois tipos em `PROCESSED`. O `ROLLBACK` do próprio `REFUND` continua permitido se houver saldo. Ele grava um novo débito e a `BET` continua com sua reversão direta já usada. Um trigger exige que a referência esteja processada e confere provedor, identidade externa, jogador, wallet, moeda, rodada, tipo e valor integral nas reversões. [Índice e trigger de reversões](./migracoes/003-agendar-referencias-e-proteger-reversoes.ts)

Quando a operação entra em `PENDING_REFERENCE`, o banco grava o estado e o evento `WagerTransactionPendingReference` sem tocar no saldo. Se veio pelo SQS, a mensagem é confirmada após o commit. O PostgreSQL fixa o prazo de 15 minutos na primeira reserva. A espera começa em 1 segundo e dobra até 60 segundos, limitada pelo prazo original. Esses valores podem ser configurados. Os reenvios preservam o prazo e o evento já gravado.

`WorkerReferencias` roda em cada réplica e usa `FOR NO KEY UPDATE OF w SKIP LOCKED` para selecionar uma wallet livre com tentativa agendada. Depois do lock, relê a operação num novo snapshot e aplica as mesmas regras de HTTP e SQS, usando o relógio do banco para verificar o vencimento. Bloquear a wallet primeiro mantém a ordem de locks das demais entradas. [Locks do PostgreSQL](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE)

Se ainda precisar esperar, o worker atualiza o contador e agenda a próxima tentativa. Ao concluir ou expirar, grava o resultado e os eventos na mesma transação de qualquer alteração de saldo ou ledger. Se o prazo já venceu quando o worker retoma a operação, ele grava `REFERENCE_EXPIRED` mesmo que a referência tenha chegado. Se houver rollback, outra réplica pode pegar a pendência. Reverter a migração do agendamento preserva os registros financeiros e remove os horários. Em um banco com pendências, planeje como recuperá-las antes de reverter.

## Mensageria e recuperação

O consumidor reserva a inbox por consumidor e `messageId` antes da identidade financeira. O hash do envelope identifica a reutilização de um `messageId` com outro conteúdo. Inbox, resultado, saldo, ledger e outbox são confirmados juntos. O ack acontece após o commit, inclusive para rejeições de negócio.

Os comandos usam FIFO por wallet. A ordenação da fila ajuda, mas a consistência vem da transação no banco. Mensagens inválidas, operações não suportadas e conflitos permanentes vão para `wager-transactions-dlq.fifo` antes do ack. Uma falha entre essas duas ações pode causar reentrega. Falhas técnicas usam backoff de até 60 segundos, com redrive após cinco recebimentos. A visibilidade inicial é de 30 segundos. Se o banco estiver indisponível, a mensagem fica para retry.

Cada publicador seleciona uma linha pronta da outbox com `FOR UPDATE SKIP LOCKED`. Mantive o lock durante o envio para que as réplicas não escolham a mesma linha ao mesmo tempo. Isso ocupa uma conexão do pool enquanto o SQS responde, por isso o envio tem limite de cinco segundos. A confirmação do broker vem antes de `published_at`. Se o envio falhar, o evento permanece na outbox e ganha uma nova tentativa, com intervalo de 1 a 60 segundos.

A fila `wager-events` é standard. Se o publicador cair depois do envio e antes de gravar `published_at`, o SQS pode receber o mesmo `eventId` de novo. O consumidor de demonstração grava uma única linha por `eventId` em `eventos_recebidos` e compara o hash em reenvios. Um conteúdo diferente com o mesmo ID vai para `wager-events-dlq`.

As DLQs retêm mensagens por 14 dias e as filas de origem, por quatro. Para recuperar uma mensagem, leia o corpo e o atributo `motivo`, corrija a causa e reenvie à fila de origem. Remova a mensagem da DLQ depois que o envio for confirmado. Preserve as identidades de uma operação válida e investigue conflitos antes de reenviar. A outbox mantém os eventos publicados e permite recuperar o conteúdo de uma entrega expirada.

## Cenários de falha testados

Nos testes de mensageria, uso PostgreSQL e MiniStack para verificar rollback antes do commit, falha no envio, falha ao registrar a publicação, reenvio e reinício do HTTP com o resultado e a outbox no banco. No teste de concorrência, espero o PostgreSQL mostrar as duas apostas bloqueadas na mesma wallet. Uma operação em outra wallet termina antes de liberar esse lock. Os testes de prontidão derrubam o acesso ao SQS e ao PostgreSQL separadamente e conferem que a aplicação continua respondendo em `/health/live`.

## Consultas de transação

As consultas por UUID e por `(providerId, externalTransactionId)` usam a chave primária e o índice de unicidade, com parâmetros SQL. Cada leitura recupera o estado confirmado e expõe o saldo histórico da transação. A moeda de `balance` vem da wallet. A de `money` é a que o provedor enviou, inclusive em caso de incompatibilidade.

O `GET` retorna 200 para qualquer estado encontrado, 400 para identificador inválido e 404 para ausência. No `POST`, rejeições retornam 422 e pendências, 202. A consulta de uma pendência deixa o reprocessamento a cargo do worker.

## Limites operacionais

- **Autenticação.** Deixei a API aberta para a demonstração local. Uma integração com IdP usaria `GuardaProvedorLocal` como ponto de entrada para validar o token e verificar acesso ao `providerId` nas operações que o informam. Os endpoints de saúde permaneceriam abertos.
- **Encerramento.** Os hooks do NestJS param novas leituras e aguardam o trabalho em andamento. Ainda faltam um prazo global de `SIGTERM` e um caminho explícito para devolver a visibilidade de uma mensagem em processamento.
- **Recuperação.** Os testes cobrem rollback, falha após envio e retomada da outbox. Ainda faltam testes que encerrem o consumidor entre commit e ack, ou o publicador entre envio e gravação de `published_at`. O estado `FAILED` é consultável e testado com dados inseridos por SQL. Ainda falta uma política geral para persistir falhas operacionais permanentes nesse estado.
- **Métricas.** A API expõe o contador de divergências de reconciliação por réplica. Contadores de retry e DLQ, latência e atraso da outbox ainda não são coletados.
