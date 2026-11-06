import { CreateQueueCommand, GetQueueAttributesCommand, GetQueueUrlCommand, SetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";

// Mantém comandos e eventos em canais separados e permite isolar filas nos testes.
export function nomesFilas(prefixo = "") {
  return {
    comandos: prefixo + "wager-transactions.fifo", dlqComandos: prefixo + "wager-transactions-dlq.fifo",
    eventos: prefixo + "wager-events", dlqEventos: prefixo + "wager-events-dlq",
  };
}

// Usa credenciais fictícias somente no ambiente local com endpoint explícito.
export function criarClienteSqs(): SQSClient {
  const endpoint = URL.parse(process.env.URL_SQS ?? "");
  if (!endpoint || !["http:", "https:"].includes(endpoint.protocol)) throw new Error("Informe URL_SQS");
  return new SQSClient({
    endpoint: endpoint.href, region: "us-east-1", useQueueUrlAsEndpoint: false,
    credentials: { accessKeyId: "local", secretAccessKey: "local" },
    requestHandler: { requestTimeout: 8000 },
  });
}

// Resolve as URLs existentes sem criar recursos durante a inicialização de cada réplica.
export async function localizarFilas(cliente: SQSClient, prefixo = "") {
  const nomes = nomesFilas(prefixo);
  const urls = {} as Record<keyof typeof nomes, string>;
  for (const chave of Object.keys(nomes) as (keyof typeof nomes)[]) {
    const resposta = await cliente.send(new GetQueueUrlCommand({ QueueName: nomes[chave] }));
    if (!resposta.QueueUrl) throw new Error("Fila indisponível: " + nomes[chave]);
    urls[chave] = resposta.QueueUrl;
  }
  return urls;
}

// Provisiona de forma repetível as filas e a política de redrive para falhas persistentes.
export async function prepararFilas(cliente: SQSClient, prefixo = "") {
  const nomes = nomesFilas(prefixo);
  for (const nome of Object.values(nomes)) {
    await cliente.send(new CreateQueueCommand({
      QueueName: nome, Attributes: nome.endsWith(".fifo") ? { FifoQueue: "true" } : {},
    }));
  }
  const urls = await localizarFilas(cliente, prefixo);
  for (const [origem, destino] of [[urls.comandos, urls.dlqComandos], [urls.eventos, urls.dlqEventos]]) {
    await cliente.send(new SetQueueAttributesCommand({ QueueUrl: destino, Attributes: { MessageRetentionPeriod: "1209600" } }));
    const atributos = await cliente.send(new GetQueueAttributesCommand({ QueueUrl: destino, AttributeNames: ["QueueArn"] }));
    await cliente.send(new SetQueueAttributesCommand({ QueueUrl: origem, Attributes: {
      VisibilityTimeout: "30", ReceiveMessageWaitTimeSeconds: "2", MessageRetentionPeriod: "345600",
      RedrivePolicy: JSON.stringify({ deadLetterTargetArn: atributos.Attributes?.QueueArn, maxReceiveCount: 5 }),
    } }));
  }
  return urls;
}
