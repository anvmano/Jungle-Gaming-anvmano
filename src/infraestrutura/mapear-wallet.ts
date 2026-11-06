import { Wallet } from "../dominio/wallet";
import { gravarMoney, lerMoney } from "./mapear-money";

// Representa a linha da wallet como o driver PostgreSQL a devolve.
export interface RegistroWallet {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: number;
  created_at: Date;
  updated_at: Date;
}

// Converte valores do domínio para os tipos usados nos parâmetros SQL.
export function gravarWallet(wallet: Wallet): RegistroWallet {
  const { id, playerId, balance, version, createdAt, updatedAt } = wallet.obterEstado();
  return { id, player_id: playerId, currency: balance.currency, balance: gravarMoney(balance),
    version, created_at: createdAt, updated_at: updatedAt };
}

// Reidrata o saldo e a versão sem executar a regra de abertura novamente.
export function lerWallet(registro: RegistroWallet): Wallet {
  return Wallet.rehydrate({
    id: registro.id, playerId: registro.player_id, balance: lerMoney(registro.balance, registro.currency),
    version: registro.version, createdAt: registro.created_at, updatedAt: registro.updated_at,
  });
}
