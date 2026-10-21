// Limite de tentativas de senha.
//
// No endereco publico do Render, sem isto, qualquer um tenta senhas sem parar
// contra o e-mail do administrador. Dois contadores:
//
//   - por CONTA (e-mail): 5 erros em 15 minutos travam a conta por 15 minutos.
//     E a protecao principal, porque nao depende de saber de onde vem o pedido;
//   - por ORIGEM (IP): 20 erros em 15 minutos travam aquela origem. Pega quem
//     varre varias contas de uma vez.
//
// Fica em memoria: o Render roda uma instancia so (render.yaml), e reiniciar o
// servidor so zera a conta de quem esta tentando - que perde o tempo da
// reinicializacao. Acertar a senha zera o contador da conta.

export function criarLimitador({ maximo, janelaMs = 15 * 60_000, bloqueioMs = 15 * 60_000, agora = () => Date.now() }) {
  const registros = new Map(); // chave -> { erros: [instantes], bloqueadoAte }

  function limpar(chave, instante) {
    const registro = registros.get(chave);
    if (!registro) return null;
    registro.erros = registro.erros.filter((t) => instante - t < janelaMs);
    if (!registro.erros.length && (!registro.bloqueadoAte || registro.bloqueadoAte <= instante)) {
      registros.delete(chave);
      return null;
    }
    return registro;
  }

  return {
    /** Instante (ms) ate quando a chave esta travada, ou 0. */
    bloqueadoAte(chave) {
      const instante = agora();
      const registro = limpar(chave, instante);
      return registro?.bloqueadoAte && registro.bloqueadoAte > instante ? registro.bloqueadoAte : 0;
    },

    /** Conta um erro. Devolve o instante do bloqueio quando este erro travou a chave. */
    falhou(chave) {
      const instante = agora();
      const registro = limpar(chave, instante) || { erros: [], bloqueadoAte: 0 };
      registro.erros.push(instante);
      let travouAgora = 0;
      if (registro.erros.length >= maximo && !(registro.bloqueadoAte > instante)) {
        registro.bloqueadoAte = instante + bloqueioMs;
        registro.erros = [];
        travouAgora = registro.bloqueadoAte;
      }
      registros.set(chave, registro);
      return travouAgora;
    },

    acertou(chave) {
      registros.delete(chave);
    },

    /** Para o painel de diagnostico e os testes. */
    tamanho() {
      return registros.size;
    }
  };
}

/**
 * Origem do pedido. Atras do proxy do Render (NUCLEO_ATRAS_DE_PROXY=1) o IP do
 * cliente vem em x-forwarded-for; fora dele, esse cabecalho e do proprio
 * cliente e nao se confia nele. Usa o primeiro endereco: se o proxy acrescentar
 * mais de um salto, o ultimo seria o mesmo para todo mundo, e um atacante
 * travaria o login de todos.
 */
export function origemDoPedido(req, atrasDeProxy = process.env.NUCLEO_ATRAS_DE_PROXY === "1") {
  if (atrasDeProxy) {
    const encaminhado = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (encaminhado) return encaminhado;
  }
  return req.socket?.remoteAddress || "desconhecida";
}
