import {
  ChangeMessageVisibilityCommand, DeleteMessageCommand, ReceiveMessageCommand, SendMessageCommand,
  type Message, type SQSClient,
} from "@aws-sdk/client-sqs";
import type { MikroORM } from "@mikro-orm/postgresql";
import { calcularHash, ServicoFinanceiro } from "../aplicacao/servico-financeiro";
import { ErroFinanceiro, lerTransacao, lerUuid } from "../aplicacao/contratos-financeiros";
import { OutboxMessage } from "../dominio/outbox-message";
import type { localizarFilas } from "./filas";

// O broker pode entregar texto inválido, arrays ou valores simples. Só objetos entram no processamento.
function lerObjeto(corpo: string | undefined): Record<string, unknown> {
  try {
    const valor = JSON.parse(corpo ?? "");
    if (valor && typeof valor === "object" && !Array.isArray(valor)) return valor;
  } catch {}
  throw new ErroFinanceiro(400, "Envelope JSON inválido");
}

// Preserva o identificador como chegou para manter a comparação em caso de reenvio.
function lerTexto(valor: unknown): string {
  if (typeof valor !== "string" || valor.length === 0 || valor.length > 128 || valor.trim() !== valor) {
    throw new ErroFinanceiro(400, "Identificador do envelope inválido");
  }
  return valor;
}

// Reúne o consumidor de comandos, o publicador e o consumidor demonstrativo.
export class Mensageria {
  private encerrando = false;
  private tarefas: Promise<void>[] = [];

  // Recebe as mesmas conexões e o mesmo processador usados pelo HTTP.
  constructor(private readonly orm: MikroORM, private readonly financeiro: ServicoFinanceiro,
    private readonly cliente: SQSClient, private readonly filas: Awaited<ReturnType<typeof localizarFilas>>) {}

  // Inicia ciclos independentes para que o polling não atrase a publicação.
  onApplicationBootstrap(): void {
    this.tarefas = [
      this.executarCiclo(() => this.consumirComando()),
      this.executarCiclo(() => this.publicarUm()),
      this.executarCiclo(() => this.consumirEvento()),
    ];
  }

  // Para novas leituras e conclui as chamadas atuais antes de fechar o cliente.
  async beforeApplicationShutdown(): Promise<void> {
    this.encerrando = true;
    await Promise.all(this.tarefas);
    this.cliente.destroy();
  }

  // Mantém cada ciclo ativo durante falhas temporárias sem registrar o payload.
  private async executarCiclo(operacao: () => Promise<boolean>): Promise<void> {
    while (!this.encerrando) {
      try {
        if (await operacao()) continue;
      } catch {
        console.error(JSON.stringify({ evento: "falha_temporaria_mensageria" }));
      }
      await Bun.sleep(200);
    }
  }

  // O consumidor aguarda o commit antes de confirmar a entrega, inclusive para uma pendência.
  async consumirComando(): Promise<boolean> {
    return this.consumir(this.filas.comandos, this.filas.dlqComandos, true, async (mensagem) => {
      const envelope = lerObjeto(mensagem.Body);
      const messageId = lerTexto(envelope.messageId);
      if (envelope.type !== "WagerTransactionRequested" || typeof envelope.occurredAt !== "string" ||
        !Number.isFinite(Date.parse(envelope.occurredAt))) throw new ErroFinanceiro(400, "Tipo ou data do envelope inválido");
      if (!envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) throw new ErroFinanceiro(400, "Dados do comando inválidos");
      const { idempotencyKey, ...dados } = envelope.data as Record<string, unknown>;
      const comando = lerTransacao(dados, idempotencyKey);
      if (mensagem.Attributes?.MessageGroupId !== comando.walletId) throw new ErroFinanceiro(400, "MessageGroupId deve ser walletId");
      await this.financeiro.processar(comando, { messageId, payloadHash: calcularHash(envelope) });
    });
  }

  // Publica uma linha bloqueada por vez, em transação separada da transação financeira.
  async publicarUm(): Promise<boolean> {
    return this.orm.em.fork().transactional(async (banco) => {
      const linha = await banco.execute<{
        id: string; aggregate_id: string; event_type: string; payload: Record<string, unknown>;
        occurred_at: Date; attempts: number; next_attempt_at: Date | null;
      }>(`
        select * from outbox_messages where published_at is null
          and (next_attempt_at is null or next_attempt_at <= now())
        order by occurred_at, id limit 1 for update skip locked
      `, [], "get");
      if (!linha) return false;
      const evento = OutboxMessage.rehydrate({
        id: linha.id, aggregateId: linha.aggregate_id, eventType: linha.event_type, payload: linha.payload,
        occurredAt: linha.occurred_at, attempts: linha.attempts, nextAttemptAt: linha.next_attempt_at ?? undefined,
      });
      try {
        await this.cliente.send(new SendMessageCommand({
          QueueUrl: this.filas.eventos, MessageBody: JSON.stringify(linha.payload),
        }), { abortSignal: AbortSignal.timeout(5000) });
      } catch {
        // O intervalo cresce até 60 segundos. O evento fica na outbox para a próxima tentativa.
        evento.scheduleRetry(new Date(Date.now() + Math.min(60, 2 ** Math.min(linha.attempts, 6)) * 1000));
        const estado = evento.obterEstado();
        await banco.execute("update outbox_messages set attempts = ?, next_attempt_at = ? where id = ?",
          [estado.attempts, estado.nextAttemptAt, linha.id]);
        return false;
      }
      // Se a gravação falhar após o envio, o próximo publisher reutiliza o mesmo eventId.
      evento.markPublished(new Date());
      await banco.execute("update outbox_messages set published_at = ?, next_attempt_at = null where id = ?",
        [evento.obterEstado().publishedAt, linha.id]);
      return true;
    });
  }

  // Uma linha por eventId permite conferir que entregas duplicadas produziram um único efeito.
  async consumirEvento(): Promise<boolean> {
    return this.consumir(this.filas.eventos, this.filas.dlqEventos, false, async (mensagem) => {
      const envelope = lerObjeto(mensagem.Body);
      const eventId = lerUuid(envelope.eventId, "eventId");
      lerUuid(envelope.aggregateId, "aggregateId");
      lerTexto(envelope.correlationId);
      if (!["WagerTransactionProcessed", "WagerTransactionRejected", "WalletBalanceChanged", "WagerTransactionPendingReference"].includes(String(envelope.eventType)) ||
        envelope.version !== 1 || typeof envelope.occurredAt !== "string" || !Number.isFinite(Date.parse(envelope.occurredAt)) ||
        !envelope.data || typeof envelope.data !== "object" || Array.isArray(envelope.data)) {
        throw new ErroFinanceiro(400, "Evento incompatível com o consumidor");
      }
      const hash = calcularHash(envelope);
      await this.orm.em.fork().transactional(async (banco) => {
        await banco.execute(`
          insert into eventos_recebidos (event_id, payload_hash, payload)
          values (?, ?, ?::jsonb) on conflict do nothing
        `, [eventId, hash, JSON.stringify(envelope)]);
        const anterior = await banco.execute<{ payload_hash: string }>(
          "select payload_hash from eventos_recebidos where event_id = ?", [eventId], "get",
        );
        if (anterior.payload_hash !== hash) throw new ErroFinanceiro(409, "eventId reutilizado com outro conteúdo");
      });
    });
  }

  // Mantém o ack depois do efeito persistido ou da confirmação de encaminhamento à DLQ.
  private async consumir(fila: string, dlq: string, fifo: boolean, executar: (mensagem: Message) => Promise<void>): Promise<boolean> {
    const resposta = await this.cliente.send(new ReceiveMessageCommand({
      QueueUrl: fila, MaxNumberOfMessages: 1, WaitTimeSeconds: 2,
      MessageSystemAttributeNames: ["MessageGroupId", "ApproximateReceiveCount"],
    }));
    const mensagem = resposta.Messages?.[0];
    if (!mensagem) return false;
    try {
      await executar(mensagem);
    } catch (erro) {
      if (erro instanceof ErroFinanceiro && [400, 404, 409].includes(erro.statusHttp)) {
        // Preserva o corpo original para diagnóstico e eventual redrive manual.
        await this.cliente.send(new SendMessageCommand({
          QueueUrl: dlq, MessageBody: mensagem.Body ?? "",
          ...(fifo ? { MessageGroupId: mensagem.Attributes?.MessageGroupId ?? "invalida",
            MessageDeduplicationId: mensagem.MessageId } : {}),
          MessageAttributes: { motivo: { DataType: "String", StringValue: erro.failureCode ?? erro.message } },
        }));
        console.warn(JSON.stringify({ evento: "mensagem_encaminhada_dlq", messageId: mensagem.MessageId }));
      } else {
        // Falhas transitórias voltam à fila. O broker aplica o redrive após cinco recebimentos.
        const tentativas = Number(mensagem.Attributes?.ApproximateReceiveCount ?? 1);
        await this.cliente.send(new ChangeMessageVisibilityCommand({
          QueueUrl: fila, ReceiptHandle: mensagem.ReceiptHandle, VisibilityTimeout: Math.min(60, 2 ** Math.min(tentativas, 6)),
        }));
        console.warn(JSON.stringify({ evento: "mensagem_agendada_retry", messageId: mensagem.MessageId }));
        return true;
      }
    }
    await this.cliente.send(new DeleteMessageCommand({ QueueUrl: fila, ReceiptHandle: mensagem.ReceiptHandle }));
    return true;
  }
}
