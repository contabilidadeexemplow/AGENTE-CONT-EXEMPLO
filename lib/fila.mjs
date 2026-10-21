// Fila de tarefas de captura.
//
// - concorrencia global limitada (padrao 3 empresas ao mesmo tempo);
// - trava por empresa e fonte: duas tarefas da mesma empresa nunca rodam
//   juntas, ou consumiriam o mesmo NSU duas vezes;
// - erro transitorio volta para a fila com espera crescente (1, 5, 15, 60 min);
//   erro definitivo (certificado vencido, recusado, empresa desativada) encerra;
// - fonte que exige intervalo (SEFAZ: uma hora apos chegar ao fim) adia a
//   tarefa para o instante liberado, sem contar tentativa;
// - na subida, tarefa que ficou "executando" de um processo que morreu volta
//   para a fila. Como o cursor so avanca apos gravar, retomar e seguro.

import { tarefas } from "./repo-captura.mjs";

export function iniciarFila({ executar, aoTerminar = () => {}, concorrencia = 3, intervaloMs = 2000, log = console }) {
  const recuperadas = tarefas.recuperarTravadas(0);
  if (recuperadas) log.log("fila: " + recuperadas + " tarefa(s) interrompida(s) voltaram para a fila");

  const rodando = new Map();
  let parado = false;
  let ouvintes = [];

  async function rodar(tarefa) {
    try {
      const resumo = await executar(tarefa);
      const final = tarefas.concluir(tarefa.id, resumo);
      aoTerminar(final, null);
    } catch (erro) {
      // A fonte pediu para esperar (janela de uma hora da SEFAZ): nao e falha.
      if (erro.adiarAte) {
        const final = tarefas.adiar(tarefa.id, erro.adiarAte, erro.message);
        aoTerminar(final, null);
        return;
      }
      const definitivo = Boolean(erro.definitivo || erro.autenticacao);
      const final = tarefas.falhar(tarefa.id, erro.message, { definitivo, resumo: erro.resumo || null });
      aoTerminar(final, erro);
    } finally {
      rodando.delete(tarefa.id);
      if (!rodando.size) {
        const avisar = ouvintes;
        ouvintes = [];
        for (const ouvinte of avisar) ouvinte();
      }
    }
  }

  function tick() {
    if (parado) return 0;
    const livres = concorrencia - rodando.size;
    if (livres <= 0) return 0;
    const reservadas = tarefas.reservar(livres);
    for (const tarefa of reservadas) rodando.set(tarefa.id, rodar(tarefa));
    return reservadas.length;
  }

  const relogio = setInterval(tick, intervaloMs);
  relogio.unref?.();

  return {
    tick,
    emExecucao: () => [...rodando.keys()],
    parar() {
      parado = true;
      clearInterval(relogio);
      return Promise.allSettled([...rodando.values()]);
    },
    /** Resolve quando nada estiver rodando. */
    ocioso() {
      if (!rodando.size) return Promise.resolve();
      return new Promise((resolve) => ouvintes.push(resolve));
    }
  };
}
