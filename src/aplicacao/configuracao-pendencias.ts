// Define tempos operacionais em milissegundos; dinheiro continua exclusivamente em Money.
export interface ConfiguracaoPendencias {
  atrasoInicialMs: number;
  atrasoMaximoMs: number;
  ttlMs: number;
  intervaloConsultaMs: number;
}

// Recusa configuração inválida na inicialização, evitando polling sem pausa ou prazos infinitos.
export function lerConfiguracaoPendencias(ambiente: Record<string, string | undefined> = process.env): ConfiguracaoPendencias {
  // Os limites permitem acelerar testes sem aceitar notação ambígua ou estouro do temporizador.
  function inteiro(nome: string, padrao: number, maximo: number): number {
    const texto = ambiente[nome] ?? String(padrao);
    if (!/^[1-9][0-9]*$/.test(texto) || !Number.isSafeInteger(Number(texto)) || Number(texto) > maximo) {
      throw new Error(nome + " deve ser um inteiro positivo até " + maximo);
    }
    return Number(texto);
  }
  const configuracao = {
    atrasoInicialMs: inteiro("REFERENCIAS_ATRASO_INICIAL_MS", 1000, 60000),
    atrasoMaximoMs: inteiro("REFERENCIAS_ATRASO_MAXIMO_MS", 60000, 3600000),
    ttlMs: inteiro("REFERENCIAS_TTL_MS", 900000, 86400000),
    intervaloConsultaMs: inteiro("REFERENCIAS_INTERVALO_MS", 200, 60000),
  };
  if (configuracao.atrasoInicialMs > configuracao.atrasoMaximoMs) throw new Error("O atraso inicial deve respeitar o teto");
  return configuracao;
}

// A primeira espera usa tentativa zero; cada avaliação ainda pendente dobra o atraso até o teto.
export function calcularAtrasoReferencia(tentativas: number, configuracao: ConfiguracaoPendencias): number {
  return Math.min(configuracao.atrasoMaximoMs, configuracao.atrasoInicialMs * 2 ** Math.min(tentativas, 30));
}
