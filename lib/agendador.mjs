// Agendador: decide quais tarefas de captura ja deveriam existir agora.
//
// Funcao pura sobre (agendamentos, empresas, agora): o servidor chama a cada
// minuto e grava as tarefas com uma chave unica, entao rodar de novo, ou
// reiniciar o servidor, nunca duplica nada.
//
// Regra mensal: no dia D, hora H, busca a competencia ANTERIOR. Executar em
// 1/10 busca 09; em 1/11 busca 10. Sem intervencao. As revarreduras (D+5,
// D+15) repetem a mesma competencia para pegar notas publicadas com atraso.
//
// Se o servidor estava desligado no horario, a tarefa e criada quando ele
// volta, dentro do mesmo mes. Nao se recria tarefa de meses passados: como a
// captura e incremental por NSU, a proxima execucao traz tudo de qualquer jeito.
//
// Horario no fuso do escritorio (padrao America/Sao_Paulo): o Render roda em UTC.

export const PRIORIDADE = { manual: 10, agendada: 5, revarredura: 3 };

/** Ano, mes, dia, hora, minuto e dia da semana no fuso informado. */
export function partesLocais(data, fuso = "America/Sao_Paulo") {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: fuso, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23"
  }).formatToParts(data);
  const valor = (tipo) => partes.find((item) => item.type === tipo)?.value;
  const semana = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    ano: Number(valor("year")),
    mes: Number(valor("month")),
    dia: Number(valor("day")),
    hora: Number(valor("hour")),
    minuto: Number(valor("minute")),
    diaSemana: semana[valor("weekday")]
  };
}

function diasNoMes(ano, mes) {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

function competenciaAnterior(ano, mes) {
  return mes === 1 ? (ano - 1) + "-12" : ano + "-" + String(mes - 1).padStart(2, "0");
}

function competenciaAtual(ano, mes) {
  return ano + "-" + String(mes).padStart(2, "0");
}

/** "Agora" ja passou do dia/hora informados, dentro do mes corrente? */
function passou(local, dia, hora, minuto) {
  if (local.dia !== dia) return local.dia > dia;
  return local.hora * 60 + local.minuto >= hora * 60 + minuto;
}

function dataIso(ano, mes, dia) {
  return ano + "-" + String(mes).padStart(2, "0") + "-" + String(dia).padStart(2, "0");
}

/** Recua `n` dias em calendario local (sem fuso: so aritmetica de data). */
function recuarDias(ano, mes, dia, n) {
  const data = new Date(Date.UTC(ano, mes - 1, dia - n));
  return { ano: data.getUTCFullYear(), mes: data.getUTCMonth() + 1, dia: data.getUTCDate() };
}

/**
 * @param {object} p
 * @param {Array} p.agendamentos  lista de repo-captura agendamentos.ativos()
 * @param {Array} p.empresas      empresas com captura ativa ({ clientId })
 * @param {Date}  p.agora
 * @returns Array<{ agendamentoId, clienteId, fonte, competencia, rodada, origem, prioridade, chaveUnica }>
 */
export function tarefasDevidas({ agendamentos, empresas, agora = new Date(), fuso = "America/Sao_Paulo" }) {
  const local = partesLocais(agora, fuso);
  const saida = [];

  for (const agendamento of agendamentos) {
    if (!agendamento.ativo) continue;
    const alvos = agendamento.clientId
      ? empresas.filter((empresa) => empresa.clientId === agendamento.clientId)
      : empresas;
    if (!alvos.length) continue;

    const ocorrencias = [];

    if (agendamento.frequencia === "mensal") {
      const ultimo = diasNoMes(local.ano, local.mes);
      const dia = Math.min(Math.max(1, Number(agendamento.diaMes) || 1), ultimo);
      const competencia = competenciaAnterior(local.ano, local.mes);
      if (passou(local, dia, agendamento.hora, agendamento.minuto)) {
        ocorrencias.push({ competencia, rodada: "principal", origem: "agendada" });
      }
      for (const deslocamento of agendamento.revarreduras || []) {
        const diaRev = dia + Number(deslocamento);
        if (!Number.isFinite(diaRev) || diaRev > ultimo || deslocamento <= 0) continue;
        if (passou(local, diaRev, agendamento.hora, agendamento.minuto)) {
          ocorrencias.push({ competencia, rodada: "rev" + deslocamento, origem: "revarredura" });
        }
      }
    } else if (agendamento.frequencia === "semanal") {
      const alvoSemana = Number(agendamento.diaSemana) || 0;
      let recuo = (local.diaSemana - alvoSemana + 7) % 7;
      if (recuo === 0 && local.hora * 60 + local.minuto < agendamento.hora * 60 + agendamento.minuto) recuo = 7;
      const data = recuarDias(local.ano, local.mes, local.dia, recuo);
      ocorrencias.push({
        competencia: competenciaAtual(data.ano, data.mes),
        rodada: "sem-" + dataIso(data.ano, data.mes, data.dia),
        origem: "agendada"
      });
    } else if (agendamento.frequencia === "diaria") {
      if (local.hora * 60 + local.minuto >= agendamento.hora * 60 + agendamento.minuto) {
        ocorrencias.push({
          competencia: competenciaAtual(local.ano, local.mes),
          rodada: "dia-" + dataIso(local.ano, local.mes, local.dia),
          origem: "agendada"
        });
      }
    }

    // Uma tarefa por fonte ligada na empresa (NFS-e, NF-e, CT-e): cada fonte
    // tem cursor e regras de consulta proprios. A chave da NFS-e continua sem
    // sufixo para nao repetir a rodada de quem ja tinha tarefas antes.
    for (const ocorrencia of ocorrencias) {
      for (const empresa of alvos) {
        const fontes = empresa.fontes?.length ? empresa.fontes : ["ADN"];
        for (const fonte of fontes) {
          const chave = ["ag", agendamento.id, empresa.clientId, ocorrencia.competencia, ocorrencia.rodada];
          if (fonte !== "ADN") chave.push(fonte);
          saida.push({
            agendamentoId: agendamento.id,
            clienteId: empresa.clientId,
            fonte,
            competencia: ocorrencia.competencia,
            rodada: ocorrencia.rodada,
            origem: ocorrencia.origem,
            prioridade: PRIORIDADE[ocorrencia.origem] ?? 0,
            chaveUnica: chave.join(":")
          });
        }
      }
    }
  }

  return saida;
}

/** Proxima execucao prevista de um agendamento, para mostrar na tela. */
export function descreverAgendamento(agendamento) {
  const regra = descreverRegra(agendamento);
  return agendamento.soCopiar ? regra + "; da PONTE, só copia o que ela já buscou" : regra;
}

function descreverRegra(agendamento) {
  const hora = String(agendamento.hora).padStart(2, "0") + ":" + String(agendamento.minuto).padStart(2, "0");
  if (agendamento.frequencia === "mensal") {
    const dias = agendamento.revarreduras || [];
    const rev = dias.length
      ? "; repete " + (dias.length > 1 ? dias.slice(0, -1).join(", ") + " e " + dias.at(-1) : dias[0]) + " dias depois"
      : "";
    return "Todo dia " + agendamento.diaMes + " às " + hora + ", busca a competência anterior" + rev;
  }
  if (agendamento.frequencia === "semanal") {
    const dias = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
    const dia = dias.at(Number(agendamento.diaSemana) || 0);
    return (["domingo", "sábado"].includes(dia) ? "Todo " : "Toda ") + dia + " às " + hora + ", busca o que há de novo";
  }
  return "Todo dia às " + hora + ", busca o que há de novo";
}
