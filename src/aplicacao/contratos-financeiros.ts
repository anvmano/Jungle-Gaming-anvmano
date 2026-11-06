import { Money } from "../dominio/money";

// Distingue erros esperados de falhas de infraestrutura.
export class ErroFinanceiro extends Error {
  // Carrega o status e, quando aplicável, o código estável do contrato.
  constructor(public readonly statusHttp: number, mensagem: string, public readonly failureCode?: string) {
    super(mensagem);
  }
}

// Reserva um provedor e um prefixo de chave para lançamentos internos.
export const provedorInterno = "__jungle_internal__";
export const prefixoInterno = provedorInterno + ":";

// Valida o formato UUID e normaliza a grafia antes do hash e da consulta.
export function lerUuid(valor: unknown, campo: string): string {
  if (typeof valor !== "string" || valor.length !== 36 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(valor)) {
    throw new ErroFinanceiro(400, campo + " deve ser um UUID");
  }
  return valor.toLowerCase();
}

// Limita identificadores para proteger o contrato e os índices de unicidade.
export function lerIdentificador(valor: unknown, campo: string): string {
  if (typeof valor !== "string" || valor.length === 0 || valor.length > 128 || valor.trim() !== valor || /[\x00-\x1f\x7f]/.test(valor)) {
    throw new ErroFinanceiro(400, campo + " deve conter de 1 a 128 caracteres válidos");
  }
  return valor;
}

// Exige um objeto JSON com os campos previstos para a operação.
function lerObjeto(valor: unknown, campos: string[]): Record<string, unknown> {
  if (typeof valor !== "object" || !valor || Array.isArray(valor) || Object.keys(valor).some((campo) => !campos.includes(campo))) {
    throw new ErroFinanceiro(400, "O corpo contém uma estrutura ou campos inválidos");
  }
  return valor as Record<string, unknown>;
}

// Converte os valores recebidos antes que o processador abra uma transação.
function lerValor(valor: unknown): Money {
  const { amount, currency } = lerObjeto(valor, ["amount", "currency"]);
  if (typeof amount !== "string" || amount.length > 20 || typeof currency !== "string") {
    throw new ErroFinanceiro(400, "Informe amount e currency no formato monetário");
  }
  try {
    return Money.from({ amount, currency });
  } catch (erro) {
    throw new ErroFinanceiro(400, (erro as Error).message);
  }
}

// Lê o contrato HTTP para abertura de wallet.
export function lerAbertura(corpo: unknown) {
  const { playerId, initialBalance } = lerObjeto(corpo, ["playerId", "initialBalance"]);
  return { playerId: lerUuid(playerId, "playerId"), initialBalance: lerValor(initialBalance) };
}

// Valida as operações externas e preserva a chave enviada no cabeçalho.
export function lerTransacao(corpo: unknown, chave: unknown) {
  const campos = lerObjeto(corpo, ["providerId", "externalTransactionId", "playerId", "walletId", "roundId", "gameId", "kind", "money", "referenceExternalTransactionId"]);
  const { kind } = campos;
  if (kind !== "BET" && kind !== "WIN" && kind !== "LOSS" && kind !== "REFUND" && kind !== "ROLLBACK") {
    throw new ErroFinanceiro(400, "Este fluxo aceita BET, WIN, LOSS, REFUND e ROLLBACK");
  }
  const providerId = lerIdentificador(campos.providerId, "providerId");
  const idempotencyKey = lerIdentificador(chave, "Idempotency-Key");
  if (providerId === provedorInterno || idempotencyKey.startsWith(prefixoInterno)) {
    throw new ErroFinanceiro(400, "Identidade reservada para operações internas");
  }
  const money = lerValor(campos.money);
  // A perda registra um resultado sem movimentação e exige valor zero.
  if (kind === "LOSS" ? !money.isZero() : !money.isPositive()) {
    throw new ErroFinanceiro(400, kind === "LOSS" ? "LOSS exige valor zero" : kind + " exige um valor positivo");
  }
  // Resolve apenas o contrato; existência e compatibilidade serão decididas sob o lock da wallet.
  const externalTransactionId = lerIdentificador(campos.externalTransactionId, "externalTransactionId");
  const referenceExternalTransactionId = campos.referenceExternalTransactionId === undefined ? undefined
    : lerIdentificador(campos.referenceExternalTransactionId, "referenceExternalTransactionId");
  if ((kind === "REFUND" || kind === "ROLLBACK") && !referenceExternalTransactionId) {
    throw new ErroFinanceiro(400, "A reversão exige referenceExternalTransactionId");
  }
  if (referenceExternalTransactionId !== undefined &&
    (kind === "BET" || kind === "LOSS" || referenceExternalTransactionId === externalTransactionId)) {
    throw new ErroFinanceiro(400, "Referência incompatível com a operação ou autorreferência");
  }
  return {
    providerId, idempotencyKey, money, kind,
    externalTransactionId, referenceExternalTransactionId,
    playerId: lerUuid(campos.playerId, "playerId"),
    walletId: lerUuid(campos.walletId, "walletId"),
    roundId: lerIdentificador(campos.roundId, "roundId"),
    gameId: lerIdentificador(campos.gameId, "gameId"),
  } as const;
}

// Limita a página e valida a representação canônica da sequência no cursor.
export function lerPaginacao(cursor: unknown, limite: unknown) {
  if (limite !== undefined && (typeof limite !== "string" || limite.trim() !== limite || !/^[1-9][0-9]{0,2}$/.test(limite) || Number(limite) > 100)) {
    throw new ErroFinanceiro(400, "limit deve estar entre 1 e 100");
  }
  if (cursor === undefined) return { sequencia: "0", limite: Number(limite ?? 50) };
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_-]{1,26}$/.test(cursor)) {
    throw new ErroFinanceiro(400, "Cursor inválido");
  }
  const bytes = Buffer.from(cursor, "base64url");
  const sequencia = bytes.toString("utf8");
  if (bytes.toString("base64url") !== cursor || !/^[1-9][0-9]{0,18}$/.test(sequencia) || BigInt(sequencia) >= (1n << 63n)) {
    throw new ErroFinanceiro(400, "Cursor inválido");
  }
  return { sequencia, limite: Number(limite ?? 50) };
}
