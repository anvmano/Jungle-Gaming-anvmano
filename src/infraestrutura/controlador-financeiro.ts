import {
  Body, Controller, Get, Header, Headers, HttpCode, HttpException, Inject, Param, Post, Query, UseGuards,
} from "@nestjs/common";
import { ErroFinanceiro, lerAbertura, lerTransacao, lerPaginacao, lerUuid, lerIdentificador } from "../aplicacao/contratos-financeiros";
import { ServicoFinanceiro } from "../aplicacao/servico-financeiro";
import { GuardaProvedorLocal } from "./guarda-provedor-local";

// Traduz erros conhecidos sem expor SQL ou detalhes da conexão.
async function responder<T>(operacao: () => Promise<T>): Promise<T> {
  try {
    return await operacao();
  } catch (erro) {
    if (erro instanceof ErroFinanceiro) {
      throw new HttpException({ message: erro.message, failureCode: erro.failureCode }, erro.statusHttp);
    }
    const codigo = (erro as { code?: string })?.code;
    if (codigo && (codigo.startsWith("08") || ["55P03", "40P01", "40001", "57P01", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(codigo))) {
      throw new HttpException("Serviço financeiro temporariamente indisponível", 503);
    }
    // O erro do driver pode conter a consulta expandida com valores financeiros.
    console.error(JSON.stringify({ evento: "falha_financeira_inesperada", codigo }));
    throw new HttpException("Erro interno no processamento financeiro", 500);
  }
}

// Expõe os comandos e consultas HTTP do fluxo financeiro.
@Controller()
@UseGuards(GuardaProvedorLocal)
export class ControladorFinanceiro {
  // Declara o token explicitamente para a injeção do Nest.
  constructor(@Inject(ServicoFinanceiro) private readonly servico: ServicoFinanceiro) {}

  // Publica o contador de divergências desta réplica no formato de exposição Prometheus.
  @Get("metrics")
  @Header("Content-Type", "text/plain; version=0.0.4")
  obterMetricas() { return this.servico.obterMetricas(); }

  // A abertura concluída responde com o status padrão 201 do Nest.
  @Post("wallets")
  abrir(@Body() corpo: unknown) {
    return responder(() => this.servico.abrir(lerAbertura(corpo)));
  }

  // Retorna o saldo corrente e a versão da wallet.
  @Get("wallets/:walletId")
  consultarWallet(@Param("walletId") walletId: string) {
    return responder(() => this.servico.consultarWallet(lerUuid(walletId, "walletId")));
  }

  // Aplica a paginação sobre a sequência imutável do ledger.
  @Get("wallets/:walletId/ledger")
  consultarLedger(@Param("walletId") walletId: string, @Query("cursor") cursor: unknown, @Query("limit") limite: unknown) {
    return responder(() => {
      const pagina = lerPaginacao(cursor, limite);
      return this.servico.consultarLedger(lerUuid(walletId, "walletId"), pagina.sequencia, pagina.limite);
    });
  }

  // Reconstrói o saldo do ledger e responde com o resultado da comparação.
  @Post("wallets/:walletId/reconciliation")
  @HttpCode(200)
  reconciliar(@Param("walletId") walletId: string) {
    return responder(() => this.servico.reconciliar(lerUuid(walletId, "walletId")));
  }

  // Uma consulta encontrada responde 200 mesmo quando o resultado financeiro é rejeitado ou pendente.
  @Get("wagering/transactions/:transactionId")
  consultarTransacao(@Param("transactionId") transactionId: string) {
    return responder(() => this.servico.consultarTransacao(lerUuid(transactionId, "transactionId")));
  }

  // Valida e mantém a grafia original dos identificadores externos, incluindo maiúsculas.
  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  consultarTransacaoExterna(@Param("providerId") providerId: string, @Param("externalTransactionId") externalTransactionId: string) {
    return responder(() => this.servico.consultarTransacaoExterna(
      lerIdentificador(providerId, "providerId"), lerIdentificador(externalTransactionId, "externalTransactionId"),
    ));
  }

  // Responde depois do commit e usa 422 para uma rejeição de negócio persistida.
  @Post("wagering/transactions")
  @HttpCode(200)
  async processar(@Body() corpo: unknown, @Headers("idempotency-key") chave: unknown) {
    const resultado = await responder(() => this.servico.processar(lerTransacao(corpo, chave)));
    if (resultado.status === "REJECTED") throw new HttpException(resultado, 422);
    if (resultado.status === "PENDING_REFERENCE") throw new HttpException(resultado, 202);
    return resultado;
  }
}
