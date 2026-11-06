import { calcularAtrasoReferencia, lerConfiguracaoPendencias, type ConfiguracaoPendencias } from "./configuracao-pendencias";
import { createHash, randomUUID } from "node:crypto";
import type { MikroORM } from "@mikro-orm/postgresql";
import { Wallet } from "../dominio/wallet";
import { WalletLedgerEntry, type LedgerDirection } from "../dominio/wallet-ledger-entry";
import { WagerTransaction, type DadosTransacao, type WagerTransactionState } from "../dominio/wager-transaction";
import { WalletBalanceChanged, WagerTransactionProcessed, WagerTransactionRejected, WagerTransactionPendingReference } from "../dominio/integration-event";
import { OutboxMessage } from "../dominio/outbox-message";
import { ErroLimiteMonetario, Money, formatarCentavos } from "../dominio/money";
import { lerWallet, type RegistroWallet } from "../infraestrutura/mapear-wallet";
import { lerMoney } from "../infraestrutura/mapear-money";
import { RepositorioFinanceiro } from "../infraestrutura/repositorio-financeiro";
import { ErroFinanceiro, prefixoInterno, provedorInterno, type lerAbertura, type lerTransacao } from "./contratos-financeiros";

// A ordem dos campos no JSON não deve transformar um reenvio em conflito.
export function calcularHash(dados: object): string {
  const json = JSON.stringify(dados, (_chave, valor) => {
    if (!valor || typeof valor !== "object" || Array.isArray(valor)) return valor;
    return Object.fromEntries(Object.keys(valor).sort().map((chave) => [chave, valor[chave]]));
  });
  return createHash("sha256").update(json).digest("hex");
}

// Devolve somente os campos públicos da wallet.
function apresentarWallet(wallet: Wallet) {
  const { id, playerId, balance, version } = wallet.obterEstado();
  return { id, playerId, balance, version };
}

// A consulta expõe o resultado financeiro e mantém chaves, hashes e agendamento no banco.
function apresentarTransacao(estado: WagerTransactionState | undefined) {
  if (!estado) throw new ErroFinanceiro(404, "Transação não encontrada");
  const { id: transactionId, providerId, externalTransactionId, walletId, playerId, roundId, gameId,
    kind, money, status, referenceExternalTransactionId, referenceTransactionId, failureCode, balance, createdAt, processedAt } = estado;
  return { transactionId, providerId, externalTransactionId, walletId, playerId, roundId, gameId,
    kind, money, status, referenceExternalTransactionId, referenceTransactionId, failureCode, balance, createdAt, processedAt };
}

// Executa as operações financeiras sob uma única transação por comando.
export class ServicoFinanceiro {
  // A métrica pertence à réplica e volta a zero quando o processo reinicia.
  private divergenciasReconciliacao = 0;
  // Compartilha a conexão, mas cria um contexto independente em cada chamada.
  constructor(private readonly orm: MikroORM, private readonly pendencias: ConfiguracaoPendencias = lerConfiguracaoPendencias()) {}

  // Libera o pool quando o Nest encerra a aplicação.
  async onApplicationShutdown(): Promise<void> { await this.orm.close(); }

  // Abre a wallet e registra OPENING somente se houver saldo inicial positivo.
  abrir({ playerId, initialBalance }: ReturnType<typeof lerAbertura>) {
    const agora = new Date();
    const walletId = randomUUID();
    const wallet = Wallet.open(walletId, playerId, initialBalance, agora);
    return this.orm.em.fork().transactional(async (banco) => {
      const repositorio = new RepositorioFinanceiro(banco);
      if (!await repositorio.inserirWallet(wallet)) throw new ErroFinanceiro(409, "Já existe uma wallet para este jogador e moeda");
      if (initialBalance.isPositive()) {
        const dados = {
          walletId, playerId, money: initialBalance, kind: "OPENING" as const, providerId: provedorInterno,
          externalTransactionId: walletId, roundId: provedorInterno, gameId: provedorInterno,
        };
        const transacao = WagerTransaction.create({
          ...dados, id: randomUUID(), idempotencyKey: prefixoInterno + walletId, payloadHash: calcularHash(dados), createdAt: agora,
        });
        if (!await repositorio.reservarTransacao(transacao.obterEstado())) throw new Error("Falha ao reservar OPENING");
        transacao.markProcessed(wallet.balance, agora);
        await this.gravarMovimento(repositorio, wallet, transacao, "CREDIT", Money.zero(initialBalance.currency));
        await this.gravarResultado(repositorio, transacao);
      }
      return apresentarWallet(wallet);
    });
  }

  // Reserva a identidade, bloqueia a wallet e decide a operação no saldo confirmado.
  processar({ idempotencyKey, ...negocio }: ReturnType<typeof lerTransacao>,
    entrega?: { messageId: string; payloadHash: string }) {
    const dados: DadosTransacao = { ...negocio, idempotencyKey, id: randomUUID(), payloadHash: calcularHash(negocio), createdAt: new Date() };
    const transacao = WagerTransaction.create(dados);
    return this.orm.em.fork().transactional(async (banco) => {
      // Limita a espera pelo lock no PostgreSQL a cinco segundos.
      await banco.execute("set local lock_timeout = '5s'");
      // A identidade da entrega e o efeito financeiro são confirmados juntos.
      if (entrega) {
        await banco.execute(`
          insert into inbox_messages (consumer_name, message_id, payload_hash, received_at)
          values ('wager-transactions', ?, ?, now()) on conflict do nothing
        `, [entrega.messageId, entrega.payloadHash]);
        const anterior = await banco.execute<{ payload_hash: string }>(
          "select payload_hash from inbox_messages where consumer_name = 'wager-transactions' and message_id = ?",
          [entrega.messageId], "get",
        );
        if (anterior.payload_hash !== entrega.payloadHash) {
          throw new ErroFinanceiro(409, "messageId reutilizado com outro conteúdo", "INBOX_CONFLICT");
        }
      }
      const repositorio = new RepositorioFinanceiro(banco);
      if (!await repositorio.reservarTransacao(dados, this.pendencias.ttlMs)) {
        const resultado = await this.reproduzir(repositorio, dados);
        if (entrega) await banco.execute(
          "update inbox_messages set processed_at = coalesce(processed_at, now()) where consumer_name = 'wager-transactions' and message_id = ?",
          [entrega.messageId],
        );
        return resultado;
      }
      const wallet = this.exigirWallet(await repositorio.buscarWallet(dados.walletId, true));
      const resultado = await this.aplicarTransacao(repositorio, wallet, transacao, new Date());
      if (entrega) await banco.execute(
        "update inbox_messages set processed_at = now() where consumer_name = 'wager-transactions' and message_id = ?",
        [entrega.messageId],
      );
      return resultado;
    }).then((resultado) => {
      // Registra apenas identificadores e resultado depois de confirmar o commit.
      console.log(JSON.stringify({ evento: "transacao_concluida", transactionId: resultado.transactionId,
        walletId: dados.walletId, providerId: dados.providerId, messageId: entrega?.messageId,
        correlationId: resultado.transactionId, status: resultado.status, idempotentReplay: resultado.idempotentReplay }));
      return resultado;
    });
  }


  // Aplica as mesmas regras no recebimento e na retomada, sempre com a wallet bloqueada.
  private async aplicarTransacao(repositorio: RepositorioFinanceiro, wallet: Wallet, transacao: WagerTransaction,
    agora: Date, expirada = false, tentativas = 0) {
    const saldoAnterior = wallet.balance;
    const dados = transacao.obterEstado();
    const estavaPendente = dados.status === "PENDING_REFERENCE";

    // O vencimento tem precedência sobre as validações que poderiam aplicar a referência tardia.
    let codigo = expirada ? "REFERENCE_EXPIRED" : wallet.obterEstado().playerId !== dados.playerId ? "WALLET_PLAYER_MISMATCH"
      : saldoAnterior.currency !== dados.money.currency ? "CURRENCY_MISMATCH"
      : dados.kind === "BET" && saldoAnterior.isLessThan(dados.money) ? "INSUFFICIENT_FUNDS" : undefined;
    // Resolve a dependência depois do lock, antes de aplicar qualquer movimentação.
    let direction: LedgerDirection | undefined = dados.kind === "BET" ? "DEBIT" : dados.kind === "WIN" ? "CREDIT" : undefined;
    let referenceTransactionId: string | undefined;
    let aguardando = false;
    if (!codigo && dados.referenceExternalTransactionId) {
      const referencia = await repositorio.buscarReferencia(dados.providerId, dados.referenceExternalTransactionId);
      const reversoes = referencia ? await repositorio.buscarReversoes(referencia.id) : [];
      const decisao = transacao.avaliarReferencia(referencia, reversoes, saldoAnterior);
      if (decisao.situacao === "rejeitar") codigo = decisao.failureCode;
      if (decisao.situacao === "aguardar") aguardando = true;
      if (decisao.situacao === "liberada") {
        direction = decisao.direction;
        referenceTransactionId = decisao.referenceTransactionId;
      }
    }
    if (!codigo && !aguardando) {
      try {
        if (direction === "DEBIT") wallet.debit(dados.money, agora);
        if (direction === "CREDIT") wallet.credit(dados.money, agora);
      } catch (erro) {
        if (!(erro instanceof ErroLimiteMonetario)) throw erro;
        codigo = "BALANCE_LIMIT_EXCEEDED";
      }
    }
    if (codigo) {
      transacao.reject(codigo, saldoAnterior, agora);
    } else if (aguardando) {
      transacao.markPendingReference();
    } else {
      transacao.markProcessed(wallet.balance, agora, referenceTransactionId);
      // LOSS conclui a operação sem mudar saldo, versão ou ledger.
      if (!wallet.balance.equals(saldoAnterior)) {
        await repositorio.atualizarWallet(wallet);
        if (!direction) throw new Error("Movimentação sem direção definida");
        await this.gravarMovimento(repositorio, wallet, transacao, direction, saldoAnterior);
      }
    }
    await this.gravarResultado(repositorio, transacao, tentativas, estavaPendente);
    return { transactionId: dados.id, status: transacao.obterEstado().status, balance: transacao.obterEstado().balance,
      idempotentReplay: false, failureCode: codigo, referenceTransactionId };
  }

  // Retoma uma pendência por vez quando chega o horário agendado, na mesma transação da decisão financeira.
  async reprocessarPendencia(): Promise<boolean> {
    const resultado = await this.orm.em.fork().transactional(async (banco) => {
      await banco.execute("set local lock_timeout = '5s'");
      await banco.execute("set local statement_timeout = '10s'");
      const repositorio = new RepositorioFinanceiro(banco);
      const linha = await repositorio.selecionarWalletPendente();
      if (!linha) return;
      const pendencia = await repositorio.buscarPendencia(linha.id);
      if (!pendencia) return;
      const transacao = WagerTransaction.rehydrate(pendencia.estado);
      const resposta = await this.aplicarTransacao(repositorio, lerWallet(linha), transacao,
        pendencia.agora, pendencia.expirada, pendencia.tentativas + 1);
      return { transactionId: resposta.transactionId, walletId: linha.id, status: resposta.status,
        failureCode: resposta.failureCode, tentativas: pendencia.tentativas + 1 };
    });
    // O log fica depois do commit para registrar somente tentativas confirmadas pelo banco.
    if (resultado) console.log(JSON.stringify({ evento: "referencia_reprocessada", ...resultado, correlationId: resultado.transactionId }));
    return resultado !== undefined;
  }

  // A leitura por UUID deixa a retomada da pendência a cargo do worker.
  async consultarTransacao(transactionId: string) {
    return apresentarTransacao(await new RepositorioFinanceiro(this.orm.em.fork()).buscarTransacao(transactionId));
  }

  // O mesmo ID externo pode existir em provedores diferentes; a busca exige ambos os campos.
  async consultarTransacaoExterna(providerId: string, externalTransactionId: string) {
    return apresentarTransacao(await new RepositorioFinanceiro(this.orm.em.fork()).buscarReferencia(providerId, externalTransactionId));
  }

  // Consulta a wallet sem adquirir bloqueio de escrita.
  async consultarWallet(walletId: string) {
    const repositorio = new RepositorioFinanceiro(this.orm.em.fork());
    return apresentarWallet(this.exigirWallet(await repositorio.buscarWallet(walletId)));
  }

  // A checagem distingue uma wallet inexistente de uma página sem lançamentos.
  async consultarLedger(walletId: string, sequencia: string, limite: number) {
    const repositorio = new RepositorioFinanceiro(this.orm.em.fork());
    this.exigirWallet(await repositorio.buscarWallet(walletId));
    return repositorio.listarLedger(walletId, sequencia, limite);
  }

  // Exibe divergências sem ajustar automaticamente o saldo registrado.
  async reconciliar(walletId: string) {
    const linha = await new RepositorioFinanceiro(this.orm.em.fork()).reconciliar(walletId);
    if (!linha) throw new ErroFinanceiro(404, "Wallet não encontrada");
    const diferenca = BigInt(linha.balance) - BigInt(linha.calculado);
    if (diferenca !== 0n) {
      this.divergenciasReconciliacao++;
      console.warn(JSON.stringify({ evento: "divergencia_reconciliacao", walletId }));
    }
    return {
      walletId, storedBalance: lerMoney(linha.balance, linha.currency),
      calculatedBalance: { amount: formatarCentavos(BigInt(linha.calculado)), currency: linha.currency },
      difference: { amount: formatarCentavos(diferenca), currency: linha.currency },
      consistent: diferenca === 0n, checkedEntries: Number(linha.quantidade),
    };
  }

  // Expõe a evidência mínima de reconciliação para coleta por réplica.
  obterMetricas(): string {
    return "# TYPE jungle_reconciliation_divergences_total counter\njungle_reconciliation_divergences_total " +
      this.divergenciasReconciliacao + "\n";
  }

  // Separa replay idêntico de colisão de chave ou de identidade externa.
  private async reproduzir(repositorio: RepositorioFinanceiro, dados: DadosTransacao) {
    const resultado = await repositorio.buscarResultado(dados);
    if (!resultado) throw new ErroFinanceiro(404, "Wallet não encontrada");
    if (resultado.idempotency_key !== dados.idempotencyKey) {
      throw new ErroFinanceiro(409, "A transação externa já foi registrada", "EXTERNAL_ID_CONFLICT");
    }
    if (resultado.payload_hash !== dados.payloadHash) {
      throw new ErroFinanceiro(409, "A chave de idempotência já foi usada com outro conteúdo", "IDEMPOTENCY_CONFLICT");
    }
    return { transactionId: resultado.id, status: resultado.status,
      balance: resultado.balance === null ? undefined : lerMoney(resultado.balance, resultado.currency),
      idempotentReplay: true, failureCode: resultado.failure_code ?? undefined,
      referenceTransactionId: resultado.reference_transaction_id ?? undefined };
  }

  // Usa a mesma resposta de ausência nas rotas e no processamento de BET.
  private exigirWallet(linha: RegistroWallet | undefined): Wallet {
    if (!linha) throw new ErroFinanceiro(404, "Wallet não encontrada");
    return lerWallet(linha);
  }

  // Constrói o contexto comum dos eventos da operação.
  private dadosEvento(dados: DadosTransacao, occurredAt: Date) {
    return { eventId: randomUUID(), aggregateId: dados.walletId, correlationId: dados.id, occurredAt };
  }

  // Persiste o ledger e o evento de saldo somente quando há uma movimentação.
  private async gravarMovimento(repositorio: RepositorioFinanceiro, wallet: Wallet, transacao: WagerTransaction,
    direction: LedgerDirection, balanceBefore: Wallet["balance"]): Promise<void> {
    const { id: transactionId, walletId, money, processedAt } = transacao.obterEstado();
    if (!processedAt) throw new Error("A movimentação exige uma transação concluída");
    await repositorio.inserirLancamento(WalletLedgerEntry.create({
      id: randomUUID(), transactionId, walletId, direction, money, balanceBefore, balanceAfter: wallet.balance, createdAt: processedAt,
    }));
    await repositorio.inserirEvento(OutboxMessage.enqueue(new WalletBalanceChanged({
      ...this.dadosEvento(transacao.obterEstado(), processedAt),
      data: { transactionId, walletId, direction, money: money.toJSON(), balanceBefore: balanceBefore.toJSON(),
        balanceAfter: wallet.balance.toJSON(), walletVersion: wallet.version },
    })));
  }

  // Persiste o resultado e seu evento antes de a unidade de trabalho confirmar.
  private async gravarResultado(repositorio: RepositorioFinanceiro, transacao: WagerTransaction,
    tentativas = 0, estavaPendente = false): Promise<void> {
    const estado = transacao.obterEstado();
    const pendente = estado.status === "PENDING_REFERENCE";
    await repositorio.salvarResultado(transacao, tentativas, calcularAtrasoReferencia(tentativas, this.pendencias));
    // Uma nova espera muda só o agendamento; o evento inicial permanece único.
    if (pendente && estavaPendente) return;
    if (!pendente && !estado.processedAt) throw new Error("O resultado exige um instante de conclusão");
    const envelope = this.dadosEvento(estado, estado.processedAt ?? estado.createdAt);
    const data = { transactionId: estado.id, walletId: estado.walletId };
    const evento = pendente ? new WagerTransactionPendingReference({ ...envelope,
      data: { ...data, referenceExternalTransactionId: estado.referenceExternalTransactionId! } }) : estado.failureCode
      ? new WagerTransactionRejected({ ...envelope, data: { ...data, failureCode: estado.failureCode } })
      : new WagerTransactionProcessed({ ...envelope, data });
    await repositorio.inserirEvento(OutboxMessage.enqueue(evento));
  }
}
