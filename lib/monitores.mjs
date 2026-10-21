// Monitores de vigilancia fiscal.
//
// Cada monitor recebe o estado e devolve alertas calculados, nunca escritos a
// mao. O id de cada alerta e deterministico (hash do que o originou), de modo
// que rodar a vigilancia duas vezes nao duplica alerta: o mesmo fato produz o
// mesmo id, e o chamador faz upsert.

import crypto from "node:crypto";
import { EMISSOR_NACIONAL_SIMPLES } from "./simples.mjs";

const DIA_MS = 24 * 60 * 60 * 1000;
// Hora de Brasilia fixa em -03:00 (sem horario de verao desde 2019), como na PONTE.
const BRASILIA_MS = 3 * 60 * 60 * 1000;

export const LIMITES_PADRAO = {
  certificadoAvisoDias: 30,
  semEmissaoDias: 45,
  dasVencimentoDia: 20,
  quedaFaturamentoPercentual: 50,
  // Queda de faturamento: a media sai de ate 6 meses antes do mes fechado, e
  // so com receita em pelo menos 3 deles (cliente novo nao tem media).
  quedaJanelaMeses: 6,
  quedaMesesComReceita: 3,
  simplesAvisoPercentual: 80,
  limiteSimples: 4800000
};

function idDeterministico(code, ...partes) {
  const base = [code, ...partes.map((parte) => String(parte ?? ""))].join("|");
  return code.toLowerCase() + "-" + crypto.createHash("sha1").update(base).digest("hex").slice(0, 12);
}

function alerta({ code, source, severity, clientId, title, detail, evidence = {}, dueAt = null }, agora) {
  return {
    id: idDeterministico(code, clientId, evidence.chave ?? evidence.competencia ?? evidence.referencia ?? ""),
    code,
    source,
    severity,
    clientId,
    title,
    detail,
    evidence,
    status: "Pendente",
    detectedAt: agora.toISOString(),
    dueAt
  };
}

function diasEntre(de, ate) {
  return Math.floor((ate.getTime() - de.getTime()) / DIA_MS);
}

function dataValida(valor) {
  if (!valor) return null;
  const data = new Date(valor.length === 10 ? valor + "T12:00:00Z" : valor);
  return Number.isNaN(data.getTime()) ? null : data;
}

/**
 * Le a validade real de um certificado em PEM ou DER (.cer, .crt).
 * PFX/P12 nao e suportado: o Node nao expoe leitura de PKCS#12, e abrir o
 * arquivo exigiria a senha do cliente. Para esses, a data vem do cadastro.
 */
export function lerValidadeCertificado(buffer) {
  try {
    const certificado = new crypto.X509Certificate(buffer);
    return {
      ok: true,
      subject: certificado.subject,
      issuer: certificado.issuer,
      validFrom: new Date(certificado.validFrom).toISOString().slice(0, 10),
      validTo: new Date(certificado.validTo).toISOString().slice(0, 10),
      serial: certificado.serialNumber
    };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
}

// ------------------------------------------------------- monitores individuais

/** Certificado vencido, vencendo ou ausente em cliente com modulo ativo. */
export function monitorarCertificados({ clients, certificates, limites, agora }) {
  const alertas = [];

  for (const cliente of clients) {
    const doCliente = certificates.filter((item) => item.clientId === cliente.id);

    if (!doCliente.length && (cliente.modules || []).length) {
      alertas.push(alerta({
        code: "CERT_AUSENTE",
        source: "CERT",
        severity: "critico",
        clientId: cliente.id,
        title: "Cliente com modulo ativo e sem certificado cadastrado",
        detail: "Modulos vinculados: " + (cliente.modules || []).join(", ") +
          ". Sem certificado nao ha captura nem transmissao.",
        evidence: { referencia: "sem-certificado", modulos: cliente.modules }
      }, agora));
      continue;
    }

    for (const certificado of doCliente) {
      const vencimento = dataValida(certificado.expiresAt);
      if (!vencimento) {
        alertas.push(alerta({
          code: "CERT_SEM_DATA",
          source: "CERT",
          severity: "atencao",
          clientId: cliente.id,
          title: "Certificado sem data de validade legivel",
          detail: "Campo expiresAt invalido ou ausente: " + (certificado.expiresAt || "vazio"),
          evidence: { referencia: certificado.id }
        }, agora));
        continue;
      }

      const dias = diasEntre(agora, vencimento);
      if (dias < 0) {
        alertas.push(alerta({
          code: "CERT_VENCIDO",
          source: "CERT",
          severity: "critico",
          clientId: cliente.id,
          title: "Certificado " + certificado.type + " vencido ha " + Math.abs(dias) + " dia(s)",
          detail: "Venceu em " + certificado.expiresAt + ". Operacoes que dependem dele estao paradas.",
          evidence: { referencia: certificado.id, vencimento: certificado.expiresAt, dias },
          dueAt: certificado.expiresAt
        }, agora));
      } else if (dias <= limites.certificadoAvisoDias) {
        alertas.push(alerta({
          code: "CERT_VENCENDO",
          source: "CERT",
          severity: dias <= 7 ? "critico" : "atencao",
          clientId: cliente.id,
          title: "Certificado " + certificado.type + " vence em " + dias + " dia(s)",
          detail: "Vencimento em " + certificado.expiresAt + ". Renove antes para nao interromper a captura.",
          evidence: { referencia: certificado.id, vencimento: certificado.expiresAt, dias },
          dueAt: certificado.expiresAt
        }, agora));
      }
    }
  }

  return alertas;
}

/** Cliente que parou de emitir: ultimo documento mais antigo que o limite. */
export function monitorarEmissao({ clients, documents, limites, agora }) {
  const alertas = [];

  for (const cliente of clients) {
    if (!(cliente.modules || []).length) continue;

    const doCliente = documents.filter((documento) =>
      documento.clientId === cliente.id && documento.operation !== "entrada");

    if (!doCliente.length) {
      alertas.push(alerta({
        code: "SEM_EMISSAO_NUNCA",
        source: "EMISSAO",
        severity: "atencao",
        clientId: cliente.id,
        title: "Nenhum documento de saida capturado para o cliente",
        detail: "Cliente com modulos " + (cliente.modules || []).join(", ") +
          " e sem nenhuma nota de saida na base.",
        evidence: { referencia: "sem-documento" }
      }, agora));
      continue;
    }

    const datas = doCliente
      .map((documento) => dataValida(documento.issuedAt))
      .filter(Boolean)
      .sort((a, b) => b - a);
    if (!datas.length) continue;

    const dias = diasEntre(datas[0], agora);
    if (dias > limites.semEmissaoDias) {
      alertas.push(alerta({
        code: "SEM_EMISSAO",
        source: "EMISSAO",
        severity: dias > limites.semEmissaoDias * 2 ? "critico" : "atencao",
        clientId: cliente.id,
        title: "Sem emissao ha " + dias + " dia(s)",
        detail: "Ultima nota de saida em " + datas[0].toISOString().slice(0, 10) +
          ". Limite configurado: " + limites.semEmissaoDias + " dias.",
        evidence: { referencia: datas[0].toISOString().slice(0, 10), dias }
      }, agora));
    }
  }

  return alertas;
}

/** Importacao ou rotina que falhou e nao foi reprocessada. */
export function monitorarCaptura({ imports, processes, agora }) {
  const alertas = [];

  for (const importacao of imports) {
    if (importacao.status !== "Erro") continue;
    alertas.push(alerta({
      code: "CAPTURA_FALHA",
      source: "FED",
      severity: "critico",
      clientId: importacao.clientId || null,
      title: "Importacao " + (importacao.module || "") + " falhou",
      detail: (importacao.errors || []).join("; ") || importacao.details || "Falha sem detalhe registrado",
      evidence: { referencia: importacao.id, modulo: importacao.module, tipo: importacao.type }
    }, agora));
  }

  for (const rotina of processes) {
    if (rotina.status !== "Erro") continue;
    alertas.push(alerta({
      code: "ROTINA_FALHA",
      source: "JOB",
      severity: "atencao",
      clientId: rotina.clientId || null,
      title: "Rotina " + (rotina.type || "") + " terminou em erro",
      detail: rotina.details || "Sem detalhe registrado",
      evidence: { referencia: rotina.id }
    }, agora));
  }

  return alertas;
}

/** DAS da competencia encerrada sem apuracao finalizada. */
export function monitorarDas({ clients, assessments, limites, agora }) {
  const alertas = [];
  const anterior = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - 1, 1));
  const competencia = String(anterior.getUTCMonth() + 1).padStart(2, "0") + "/" + anterior.getUTCFullYear();
  const vencimento = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), limites.dasVencimentoDia, 12));

  for (const cliente of clients) {
    if (cliente.taxRegime !== "Simples Nacional") continue;

    const apuracao = assessments.find((item) =>
      item.clientId === cliente.id && item.period === competencia);

    if (!apuracao) {
      alertas.push(alerta({
        code: "DAS_SEM_APURACAO",
        source: "SIMPLES",
        severity: agora > vencimento ? "critico" : "atencao",
        clientId: cliente.id,
        title: "Competencia " + competencia + " sem apuracao",
        detail: "Vencimento do DAS em " + vencimento.toISOString().slice(0, 10) +
          (agora > vencimento ? " (ja passou)" : ""),
        evidence: { competencia },
        dueAt: vencimento.toISOString().slice(0, 10)
      }, agora));
      continue;
    }

    if (apuracao.status === "Aberto" && agora > vencimento) {
      alertas.push(alerta({
        code: "DAS_VENCIDO",
        source: "SIMPLES",
        severity: "critico",
        clientId: cliente.id,
        title: "DAS de " + competencia + " em aberto apos o vencimento",
        detail: "Valor apurado: " + Number(apuracao.amount || 0).toFixed(2) +
          ". Vencimento em " + vencimento.toISOString().slice(0, 10) + ".",
        evidence: { competencia, valor: apuracao.amount },
        dueAt: vencimento.toISOString().slice(0, 10)
      }, agora));
    }
  }

  return alertas;
}

/** Divergencia critica de conferencia sem justificativa registrada. */
export function monitorarDivergencias({ conferences, agora }) {
  const alertas = [];

  for (const conferencia of conferences) {
    const criticos = (conferencia.findings || [])
      .filter((item) => item.severity === "critico" && !item.justification);
    if (!criticos.length) continue;

    alertas.push(alerta({
      code: "DIVERGENCIA_ABERTA",
      source: "CONF",
      severity: "critico",
      clientId: conferencia.clientId || null,
      title: criticos.length + " divergencia(s) critica(s) sem tratamento",
      detail: "Documento " + (conferencia.kind || "") + " " + (conferencia.number || conferencia.documentKey) +
        ": " + criticos.slice(0, 3).map((item) => item.code).join(", ") +
        (criticos.length > 3 ? " e mais " + (criticos.length - 3) : ""),
      evidence: { chave: conferencia.documentKey, codigos: criticos.map((item) => item.code) }
    }, agora));
  }

  return alertas;
}

// ------------------------------------------------- queda de faturamento
//
// Defeito 7: a queda comparava o mes CORRENTE, ainda aberto, com a media dos
// anteriores. No dia 3 de todo mes a carteira inteira aparecia com "queda de
// 90%". A regra agora e a da PONTE SEFAZ (alertas-da-carteira.ts):
//   - so o MES FECHADO (o ultimo mes completo, no relogio de Brasilia) e
//     julgado, nunca o mes em curso;
//   - e so depois de uma captura que deu certo DEPOIS do fim dele, em todas as
//     fontes ligadas da empresa: antes disso, a "queda" pode ser nota do fim do
//     mes que ainda nao chegou. Sem captura automatica, nada se afirma;
//   - a media sai dos meses antes dele, cortados no inicio do vinculo (o mes de
//     antes nao e zero, e desconhecido), e exige receita em pelo menos tres;
//   - um alerta por causa: um por cliente e mes fechado, e nenhum quando o
//     cliente ja esta em "sem emissao" (o mesmo fato contado duas vezes).

const mesBr = (competencia) => competencia.slice(5, 7) + "/" + competencia.slice(0, 4);
const dataBr = (iso) => String(iso).slice(0, 10).split("-").reverse().join("/");

/** AAAA-MM do mes de Brasilia em que `agora` cai. */
export function mesDeBrasilia(agora) {
  return new Date(agora.getTime() - BRASILIA_MS).toISOString().slice(0, 7);
}

/** O ultimo mes fechado em Brasilia: no dia 1o de outubro, setembro. */
export function mesFechado(agora) {
  const [ano, mes] = mesDeBrasilia(agora).split("-").map(Number);
  return new Date(Date.UTC(ano, mes - 2, 1)).toISOString().slice(0, 7);
}

/** Os `n` meses antes de `competencia`, do mais antigo ao mais recente. */
export function mesesAntes(competencia, n) {
  const [ano, mes] = competencia.split("-").map(Number);
  const saida = [];
  for (let i = n; i >= 1; i -= 1) saida.push(new Date(Date.UTC(ano, mes - 1 - i, 1)).toISOString().slice(0, 7));
  return saida;
}

/** O primeiro instante (Brasilia) do mes seguinte a `competencia`. */
function fimDoMes(competencia) {
  const [ano, mes] = competencia.split("-").map(Number);
  return Date.UTC(ano, mes, 1) + BRASILIA_MS;
}

/**
 * A captura deu certo DEPOIS do fim do mes? So entao o mes pode ser julgado:
 * antes disso, o que falta pode ser nota que ainda nao chegou.
 */
export function mesJaCapturado(competencia, capturaBoa) {
  if (!capturaBoa) return false;
  const quando = Date.parse(capturaBoa);
  return !Number.isNaN(quando) && quando >= fimDoMes(competencia);
}

/**
 * Quando a captura da empresa deu certo pela ultima vez, contando TODAS as
 * fontes ligadas (cursores.ultimo_sucesso de cada uma): vale a mais atrasada,
 * porque com a NF-e parada as NF-e do fim do mes faltam mesmo com a NFS-e em
 * dia. Fonte ligada que nunca deu certo = sem captura. Pela PONTE conta tambem
 * a ultima varredura dela na SEFAZ (ponte_estado): copiar da PONTE antes de ela
 * varrer traz so o que ela ja tinha. Sem o detalhe por fonte, vale o
 * ultimoSucesso da empresa.
 */
export function ultimaCapturaBoa(empresa, estadoPonte = null) {
  if (!empresa) return null;
  const fontes = empresa.fontes?.length ? empresa.fontes : ["ADN"];
  const porFonte = empresa.ultimoSucessoPorFonte || null;
  let maisAtrasada = null;
  for (const fonte of fontes) {
    let quando = porFonte ? porFonte[fonte] : empresa.ultimoSucesso;
    if (!quando || Number.isNaN(Date.parse(quando))) return null;
    const varredura = fonte === "PONTE" ? Date.parse(estadoPonte?.ultimaVarredura || "") : NaN;
    if (!Number.isNaN(varredura) && varredura < Date.parse(quando)) quando = estadoPonte.ultimaVarredura;
    if (!maisAtrasada || Date.parse(quando) < Date.parse(maisAtrasada)) maisAtrasada = quando;
  }
  return maisAtrasada;
}

/**
 * O inicio do vinculo (AAAA-MM): antes dele, o mes nao e zero, e desconhecido.
 * Vale primeiro o que foi dito de forma explicita: o "desde" do cliente na
 * carteira da PONTE (ponte_estado.desde) e o comeco do periodo da regra de
 * busca (empresas_captura.periodo_desde) — o mais recente dos dois. Sem nenhum,
 * o mes do primeiro documento do cliente no acervo, emitido ou recebido. A
 * data de cadastro do cliente nao entra: o historico importado depois do
 * cadastro e de antes dele, e cortar ali jogaria fora meses conhecidos.
 */
export function inicioDoVinculo({ empresa = null, estadoPonte = null, primeiroDocumento = null } = {}) {
  const explicitos = [estadoPonte?.desde, empresa?.periodoDesde]
    .filter(Boolean).map((valor) => String(valor).slice(0, 7)).filter((mes) => /^\d{4}-\d{2}$/.test(mes)).sort();
  if (explicitos.length) return explicitos.at(-1);
  return primeiroDocumento ? String(primeiroDocumento).slice(0, 7) : null;
}

/**
 * A queda de um mes contra a media dos meses antes dele. Funcao pura: devolve
 * a conta, ou null quando o mes nao pode ser julgado.
 * `receitaPorMes`: Map AAAA-MM -> receita de saida do cliente.
 */
export function quedaDoMes({ competencia, receitaPorMes, inicio, capturaBoa, limites, agora }) {
  // Defeito 7: mes aberto nunca e julgado, venha de onde vier o pedido.
  if (!competencia || competencia >= mesDeBrasilia(agora)) return null;
  if (!mesJaCapturado(competencia, capturaBoa)) return null;
  if (!inicio || competencia < inicio) return null;
  const janela = mesesAntes(competencia, limites.quedaJanelaMeses ?? LIMITES_PADRAO.quedaJanelaMeses)
    .filter((mes) => mes >= inicio);
  // Dentro do vinculo, mes sem nota e zero de verdade, e entra na media.
  const valores = janela.map((mes) => receitaPorMes.get(mes) || 0);
  const comReceita = valores.filter((valor) => valor > 0).length;
  if (comReceita < (limites.quedaMesesComReceita ?? LIMITES_PADRAO.quedaMesesComReceita)) return null;
  const media = valores.reduce((total, valor) => total + valor, 0) / valores.length;
  if (media <= 0) return null;
  const atual = receitaPorMes.get(competencia) || 0;
  const queda = ((media - atual) / media) * 100;
  if (queda < limites.quedaFaturamentoPercentual) return null;
  return { competencia, atual, media, queda, meses: janela, comReceita };
}

/** Faturamento do mes fechado muito abaixo da media dos meses antes dele. */
export function monitorarFaturamento({ clients, documents, empresasCaptura = [], ponteEstados = [], limites, agora }) {
  const alertas = [];
  const competencia = mesFechado(agora);
  const empresaDe = new Map(empresasCaptura.map((item) => [item.clientId, item]));
  const ponteDe = new Map(ponteEstados.map((item) => [item.clientId, item]));

  // Uma passada pelos documentos: a receita de saida por mes de cada cliente e
  // o mes do primeiro documento dele (emitido ou recebido).
  const receitas = new Map();
  const primeiro = new Map();
  for (const documento of documents) {
    if (!documento.clientId) continue;
    const mes = String(documento.issuedAt || "").slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(mes)) continue;
    if (!primeiro.has(documento.clientId) || mes < primeiro.get(documento.clientId)) primeiro.set(documento.clientId, mes);
    if (documento.operation === "entrada") continue;
    const porMes = receitas.get(documento.clientId) || new Map();
    porMes.set(mes, (porMes.get(mes) || 0) + (Number(documento.amount) || 0));
    receitas.set(documento.clientId, porMes);
  }

  for (const cliente of clients) {
    const receitaPorMes = receitas.get(cliente.id);
    if (!receitaPorMes) continue;
    const empresa = empresaDe.get(cliente.id) || null;
    const estadoPonte = ponteDe.get(cliente.id) || null;
    const capturaBoa = ultimaCapturaBoa(empresa, estadoPonte);
    const inicio = inicioDoVinculo({ empresa, estadoPonte, primeiroDocumento: primeiro.get(cliente.id) });
    const conta = quedaDoMes({ competencia, receitaPorMes, inicio, capturaBoa, limites, agora });
    if (!conta) continue;

    alertas.push(alerta({
      code: "QUEDA_FATURAMENTO",
      source: "EMISSAO",
      severity: "atencao",
      clientId: cliente.id,
      title: "Faturamento de " + mesBr(competencia) + " (mes fechado) caiu " + conta.queda.toFixed(0) + "% frente a media",
      detail: "Saidas de " + mesBr(competencia) + ": " + conta.atual.toFixed(2) + ". Media dos " + conta.meses.length +
        " meses anteriores (" + mesBr(conta.meses[0]) + " a " + mesBr(conta.meses.at(-1)) + "): " + conta.media.toFixed(2) +
        ". Conferido depois da captura de " + dataBr(capturaBoa) + ", que rodou depois do fim do mes. Pergunte ao " +
        "cliente se o movimento caiu de fato ou se parte das notas saiu por outro sistema; nesse caso, importe os XML.",
      // O id sai da referencia "mes-fechado:AAAA-MM", e nao da competencia: o
      // alerta falso do mes aberto, se alguem o ignorou, nao cala este.
      evidence: {
        referencia: "mes-fechado:" + competencia, mesFechado: competencia,
        media: Number(conta.media.toFixed(2)), atual: Number(conta.atual.toFixed(2)),
        meses: conta.meses, inicioDoVinculo: inicio, capturaBoa
      }
    }, agora));
  }

  return alertas;
}

/** RBT12 se aproximando do limite de permanencia no Simples. */
export function monitorarLimiteSimples({ clients, assessments, limites, agora }) {
  const alertas = [];

  for (const cliente of clients) {
    if (cliente.taxRegime !== "Simples Nacional") continue;
    const ultima = assessments
      .filter((item) => item.clientId === cliente.id && item.rbt12)
      .sort((a, b) => String(b.period).localeCompare(String(a.period)))[0];
    if (!ultima) continue;

    const percentual = (Number(ultima.rbt12) / limites.limiteSimples) * 100;
    if (percentual < limites.simplesAvisoPercentual) continue;

    alertas.push(alerta({
      code: percentual >= 100 ? "SIMPLES_LIMITE_ESTOURADO" : "SIMPLES_LIMITE_PROXIMO",
      source: "SIMPLES",
      severity: percentual >= 100 ? "critico" : "atencao",
      clientId: cliente.id,
      title: percentual >= 100
        ? "RBT12 ultrapassou o limite do Simples"
        : "RBT12 em " + percentual.toFixed(0) + "% do limite do Simples",
      detail: "RBT12 de " + Number(ultima.rbt12).toFixed(2) + " frente ao limite de " +
        limites.limiteSimples.toFixed(2) + " (LC 123/2006, art. 3, II).",
      evidence: { competencia: ultima.period, rbt12: ultima.rbt12 }
    }, agora));
  }

  return alertas;
}

/**
 * Carteira de captura: certificado A1 vencendo, captura com erro, empresa sem
 * captura recente, pendencias abertas e falha de espelho na pasta.
 */
export function monitorarCarteira({ empresasCaptura = [], certificadosDigitais = [], pendenciasAbertas = [],
  limites, agora }) {
  const alertas = [];
  const limiteDias = limites.semCapturaDias ?? 35;

  for (const certificado of certificadosDigitais) {
    if (!certificado.ativo || !(certificado.empresas || []).length) continue;
    const nomes = certificado.empresas.map((item) => item.name).join(", ");
    if (certificado.diasParaVencer < 0) {
      for (const empresa of certificado.empresas) {
        alertas.push(alerta({
          code: "CERT_A1_VENCIDO", source: "CAPTURA", severity: "critico", clientId: empresa.id,
          title: "Certificado A1 de " + certificado.titular + " vencido: captura parada",
          detail: "Venceu em " + certificado.validoAte + ". Usado por: " + nomes + ".",
          evidence: { referencia: certificado.id + ":" + empresa.id }, dueAt: certificado.validoAte
        }, agora));
      }
    } else if (certificado.diasParaVencer <= limites.certificadoAvisoDias) {
      for (const empresa of certificado.empresas) {
        alertas.push(alerta({
          code: "CERT_A1_VENCENDO", source: "CAPTURA",
          severity: certificado.diasParaVencer <= 7 ? "critico" : "atencao", clientId: empresa.id,
          title: "Certificado A1 de " + certificado.titular + " vence em " + certificado.diasParaVencer + " dia(s)",
          detail: "Vencimento em " + certificado.validoAte + ". Depois disso a captura de " + nomes + " para.",
          evidence: { referencia: certificado.id + ":" + empresa.id }, dueAt: certificado.validoAte
        }, agora));
      }
    }
  }

  for (const empresa of empresasCaptura) {
    if (!empresa.ativa) continue;
    if (empresa.ultimaTarefa === "erro" && empresa.ultimoErro) {
      alertas.push(alerta({
        code: "CAPTURA_ERRO", source: "CAPTURA", severity: "critico", clientId: empresa.clientId,
        title: "Ultima captura terminou em erro",
        detail: empresa.ultimoErro,
        evidence: { referencia: "erro:" + empresa.ultimoErro.slice(0, 80) }
      }, agora));
    }
    // Prestadora com o ADN respondendo e nenhuma NFS-e emitida. No Simples,
    // depois de 01/09/2026, e irregularidade: so vale o Emissor Nacional. Nos
    // demais regimes, o mais provavel e o sistema proprio da prefeitura.
    const corte = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - 3, 1));
    const corteMes = corte.getUTCFullYear() + "-" + String(corte.getUTCMonth() + 1).padStart(2, "0");
    const mesAgora = agora.getUTCFullYear() + "-" + String(agora.getUTCMonth() + 1).padStart(2, "0");
    const verificaNfse = (empresa.fontes || ["ADN"]).includes("ADN") && (empresa.ultimoSucessoAdn ?? empresa.ultimoSucesso) &&
      empresa.prestaServico;
    const simplesObrigado = empresa.simples && mesAgora >= EMISSOR_NACIONAL_SIMPLES.desde;
    if (verificaNfse && simplesObrigado && empresa.nfseNacionalRecentes === 0) {
      const inicio = corteMes > EMISSOR_NACIONAL_SIMPLES.desde ? corteMes : EMISSOR_NACIONAL_SIMPLES.desde;
      const desde = inicio.slice(5) + "/" + inicio.slice(0, 4);
      const daPrefeitura = empresa.nfsePrefeituraPosObrigacao || 0;
      alertas.push(alerta({
        code: "NFSE_SIMPLES_FORA_DO_EMISSOR", source: "CAPTURA", severity: "critico", clientId: empresa.clientId,
        title: "Simples sem NFS-e no Emissor Nacional desde " + desde,
        detail: empresa.name + " e do Simples e presta servico. Desde 01/09/2026 o Simples so pode emitir NFS-e " +
          "pelo Emissor Nacional (" + EMISSOR_NACIONAL_SIMPLES.norma + "), e o ADN nao tem nenhuma emitida por ela " +
          "desde " + desde + "." +
          (daPrefeitura ? " Ha " + daPrefeitura + " NFS-e de sistema da prefeitura nessas competencias: para o " +
            "Simples elas nao valem mais." : "") +
          " Confira com o cliente. Se ele nao faturou servico no periodo, resolva este alerta.",
        evidence: { referencia: "simples-sem-emissor:" + desde }
      }, agora));
    } else if (verificaNfse && !simplesObrigado && empresa.nfseEmitidasRecentes === 0) {
      const desde = corteMes.slice(5) + "/" + corteMes.slice(0, 4);
      alertas.push(alerta({
        code: "NFSE_FORA_DO_ADN", source: "CAPTURA", severity: "atencao", clientId: empresa.clientId,
        title: "Prestadora sem NFS-e emitida no Emissor Nacional desde " + desde,
        detail: empresa.name + " presta servico" + (empresa.anexo ? " (Anexo " + empresa.anexo + ")" : "") +
          " e o ADN respondeu, mas nao ha NFS-e emitida por ela desde " + desde + ". Se ela emite no sistema " +
          "proprio da prefeitura, importe os XML no painel da empresa ou solte-os na pasta " +
          "EMPRESAS/" + empresa.cnpjDigits + "/ENTRADA. Se nao faturou servico no periodo, resolva este alerta.",
        evidence: { referencia: "nfse-fora:" + desde }
      }, agora));
    }

    const ultimo = empresa.ultimoSucesso ? new Date(empresa.ultimoSucesso) : null;
    const dias = ultimo ? diasEntre(ultimo, agora) : null;
    if (dias === null || dias > limiteDias) {
      alertas.push(alerta({
        code: "CAPTURA_ATRASADA", source: "CAPTURA", severity: "atencao", clientId: empresa.clientId,
        title: dias === null ? "Empresa ainda nao teve captura concluida" : "Sem captura concluida ha " + dias + " dia(s)",
        detail: "Limite configurado: " + limiteDias + " dias. Confira agendamento e certificado.",
        evidence: { referencia: dias === null ? "nunca" : "atraso" }
      }, agora));
    }
  }

  const porEmpresa = new Map();
  for (const pendencia of pendenciasAbertas) {
    if (pendencia.situacao !== "aberta") continue;
    const lista = porEmpresa.get(pendencia.clientId) || [];
    lista.push(pendencia);
    porEmpresa.set(pendencia.clientId, lista);
  }
  for (const [clienteId, lista] of porEmpresa) {
    const tipos = [...new Set(lista.map((item) => item.tipo))];
    alertas.push(alerta({
      code: "PENDENCIAS_CAPTURA", source: "CAPTURA",
      severity: tipos.some((tipo) => ["resumo_sem_xml", "nota_referenciada_ausente", "xml_invalido"].includes(tipo))
        ? "critico" : "atencao",
      clientId: clienteId,
      title: lista.length + " pendencia(s) de captura em aberto",
      detail: "Tipos: " + tipos.join(", ") + ". Veja o painel de pendencias.",
      evidence: { referencia: "pendencias" }
    }, agora));
  }

  return alertas;
}

// --------------------------------------------------------------- PONTE SEFAZ

// Severidade de cada achado da conferencia da PONTE. "falta-manifestar" ja
// vira pendencia na captura; certificado sai do cadastro (abaixo).
const ACHADOS_DA_PONTE = {
  "furo-de-numeracao": "atencao",
  "cancelada-depois": "atencao",
  "atraso-de-captura": "atencao",
  "nunca-varrido": "atencao",
  "cfop-fora-do-padrao": "informativo"
};

/**
 * Empresa capturada pela PONTE nao tem A1 no NUCLEO: o vencimento dele, e o
 * que a conferencia da PONTE achou, chegam a cada captura (ponte_estado) e
 * viram alerta aqui. Sem isto, essas empresas sumiam da vigilancia.
 */
export function monitorarPonte({ empresasCaptura = [], ponteEstados = [], limites, agora }) {
  const alertas = [];
  const porCliente = new Map(ponteEstados.map((item) => [item.clientId, item]));
  for (const empresa of empresasCaptura) {
    if (!empresa.ativa || !(empresa.fontes || []).includes("PONTE")) continue;
    const estado = porCliente.get(empresa.clientId);
    if (!estado) continue;
    const base = { source: "PONTE", clientId: empresa.clientId };
    if (!estado.naCarteira) {
      alertas.push(alerta({ ...base, code: "PONTE_FORA_DA_CARTEIRA", severity: "critico",
        title: "Empresa saiu da carteira do escritorio na PONTE",
        detail: "A captura pela PONTE parou. Inclua o cliente de novo na carteira la, ou desligue a PONTE nesta empresa.",
        evidence: { referencia: "carteira" } }, agora));
      continue;
    }
    if (!estado.temCertificado) {
      alertas.push(alerta({ ...base, code: "PONTE_SEM_CERTIFICADO", severity: "critico",
        title: "A PONTE nao tem o A1 desta empresa",
        detail: "Sem o certificado a PONTE nao varre a SEFAZ por ela. Envie o A1 na carteira do escritorio, na PONTE.",
        evidence: { referencia: "sem-certificado" } }, agora));
    } else if (estado.certificadoVencimento) {
      const dias = Math.floor((new Date(String(estado.certificadoVencimento).slice(0, 10) + "T23:59:59Z") - agora) / 86_400_000);
      if (dias < 0) {
        alertas.push(alerta({ ...base, code: "PONTE_CERT_VENCIDO", severity: "critico",
          title: "A1 desta empresa na PONTE venceu",
          detail: "Venceu em " + String(estado.certificadoVencimento).slice(0, 10) + ": a PONTE parou de varrer. " +
            "Envie o A1 novo na carteira do escritorio, na PONTE.",
          evidence: { referencia: String(estado.certificadoVencimento).slice(0, 10) },
          dueAt: String(estado.certificadoVencimento).slice(0, 10) }, agora));
      } else if (dias <= (limites.certificadoAvisoDias ?? 30)) {
        alertas.push(alerta({ ...base, code: "PONTE_CERT_VENCENDO", severity: dias <= 7 ? "critico" : "atencao",
          title: "A1 desta empresa na PONTE vence em " + dias + " dia(s)",
          detail: "Vencimento em " + String(estado.certificadoVencimento).slice(0, 10) + ". Depois disso a PONTE para de " +
            "varrer por ela. Peca o A1 novo ao cliente.",
          evidence: { referencia: String(estado.certificadoVencimento).slice(0, 10) },
          dueAt: String(estado.certificadoVencimento).slice(0, 10) }, agora));
      }
    }
    if (estado.radar === false) {
      alertas.push(alerta({ ...base, code: "PONTE_RADAR_DESLIGADO", severity: "atencao",
        title: "Radar desligado na PONTE",
        detail: "A PONTE nao varre esta empresa sozinha. Ligue o radar no vinculo da carteira, na PONTE.",
        evidence: { referencia: "radar" } }, agora));
    }
    for (const achado of estado.achados || []) {
      const severidade = ACHADOS_DA_PONTE[achado.tipo];
      if (!severidade) continue;
      const referencia = achado.tipo + ":" + (achado.faixa ? achado.faixa.serie + ":" + achado.faixa.de + "-" + achado.faixa.ate
        : (achado.chaves || []).slice(0, 3).join(",") || achado.o_que);
      alertas.push(alerta({ ...base, code: "PONTE_" + achado.tipo.toUpperCase().replace(/-/g, "_"), severity: severidade,
        title: achado.o_que, detail: achado.fazer + " (conferencia da PONTE)",
        evidence: { referencia, chaves: achado.chaves || [], faixa: achado.faixa || null } }, agora));
    }
  }
  return alertas;
}

// ------------------------------------------------------------------ orquestrador

/**
 * Roda todos os monitores e devolve os alertas calculados.
 * `anteriores` sao os alertas ja existentes: alertas resolvidos ou ignorados
 * nao voltam, e alertas pendentes preservam a data de deteccao original.
 */
export function vigiar(estado, { limites = LIMITES_PADRAO, agora = new Date(), anteriores = [] } = {}) {
  const contexto = {
    clients: estado.clients || [],
    certificates: estado.certificates || [],
    documents: estado.documents || [],
    imports: estado.imports || [],
    processes: estado.processes || [],
    assessments: estado.assessments || [],
    conferences: estado.conferences || [],
    empresasCaptura: estado.empresasCaptura || [],
    certificadosDigitais: estado.certificadosDigitais || [],
    pendenciasAbertas: estado.pendenciasAbertas || [],
    ponteEstados: estado.ponteEstados || [],
    limites: { ...LIMITES_PADRAO, ...limites },
    agora
  };

  const todos = [
    ...monitorarCertificados(contexto),
    ...monitorarEmissao(contexto),
    ...monitorarCaptura(contexto),
    ...monitorarDas(contexto),
    ...monitorarDivergencias(contexto),
    ...monitorarFaturamento(contexto),
    ...monitorarLimiteSimples(contexto),
    ...monitorarCarteira(contexto),
    ...monitorarPonte(contexto)
  ];
  // Um alerta por causa: o cliente que esta sem emissao ha mais que o limite
  // ja tem o alerta da causa; a queda do mes fechado seria o mesmo fato de novo.
  const semEmissao = new Set(todos.filter((item) => item.code === "SEM_EMISSAO").map((item) => item.clientId));
  const calculados = todos.filter((item) => !(item.code === "QUEDA_FATURAMENTO" && semEmissao.has(item.clientId)));

  const porId = new Map(anteriores.map((item) => [item.id, item]));
  const resultado = [];
  const novos = [];

  for (const calculado of calculados) {
    const existente = porId.get(calculado.id);
    if (existente && (existente.status === "Resolvido" || existente.status === "Ignorado")) {
      resultado.push(existente);
      continue;
    }
    if (existente) {
      resultado.push({ ...calculado, status: existente.status, detectedAt: existente.detectedAt });
      continue;
    }
    novos.push(calculado);
    resultado.push(calculado);
  }

  const idsCalculados = new Set(calculados.map((item) => item.id));
  const encerrados = anteriores.filter((item) =>
    !idsCalculados.has(item.id) && item.status === "Pendente");

  return {
    alertas: resultado.sort((a, b) => {
      const peso = { critico: 0, atencao: 1, informativo: 2 };
      return (peso[a.severity] ?? 3) - (peso[b.severity] ?? 3);
    }),
    novos,
    encerrados,
    resumo: {
      total: resultado.length,
      pendentes: resultado.filter((item) => item.status === "Pendente").length,
      criticos: resultado.filter((item) => item.severity === "critico" && item.status === "Pendente").length,
      atencao: resultado.filter((item) => item.severity === "atencao" && item.status === "Pendente").length,
      novos: novos.length,
      encerrados: encerrados.length,
      executadoEm: agora.toISOString()
    }
  };
}
