// Apuracao do Simples Nacional com memoria de calculo.
//
// Base normativa: LC 123/2006, art. 18 e Anexos I a V, com a redacao dada pela
// LC 155/2016 (vigencia a partir de 01/01/2018).
//
// CONFERIDO em 08/10/2026 contra as fontes listadas em VIGENCIA.fontes. As 30
// linhas de reparticao dos cinco anexos foram comparadas numero por numero e
// nenhuma divergencia foi encontrada. O teste de coerencia (cada linha somando
// 100%) continua rodando em npm test.
//
// LIMITE DE VIGENCIA: estas tabelas valem ate a competencia 12/2026. A reforma
// tributaria substitui PIS e COFINS por CBS e IBS na reparticao a partir de
// 01/2027, e altera aliquota nominal (o Anexo II cai de 30,00% para 29,90% na
// 6a faixa), com nova mudanca em 2029. Apurar competencia de 2027 em diante com
// estas tabelas produz DAS errado, entao `apurar` emite aviso critico e o
// servidor recusa gravar sem confirmacao explicita.

// Resolucao CGSN 189/2026 (DOU de 28/04/2026), que alterou o art. 59 da
// Resolucao CGSN 140/2018: a partir de 01/09/2026 a optante pelo Simples emite
// NFS-e EXCLUSIVAMENTE pelo Emissor Nacional (web ou API). Nota de sistema
// proprio da prefeitura depois dessa data nao vale para o Simples.
// Conferido em 10/10/2026 (Fenacon; Prefeitura de Sao Paulo).
export const EMISSOR_NACIONAL_SIMPLES = {
  desde: "2026-09",
  norma: "Resolucao CGSN 189/2026"
};

export const VIGENCIA = {
  norma: "LC 123/2006, Anexos I a V, redacao da LC 155/2016",
  inicio: "2018-01-01",
  fim: "2026-12-31",
  conferidoEm: "2026-10-08",
  fontes: [
    "LC 155/2016 (texto publicado), Anexos I a V",
    "Receita Federal, Anexo V - Aliquotas e Partilha do Simples Nacional (normas.receita.fazenda.gov.br)",
    "Senado Federal, texto consolidado da LC 123/2006 com os anexos de vigencia 2027-2028"
  ],
  observacao: "Tabelas conferidas para competencias de 01/2018 a 12/2026. " +
    "A partir de 01/2027 a reforma tributaria altera a reparticao (CBS e IBS no " +
    "lugar de PIS e COFINS) e aliquotas nominais: e preciso transcrever e conferir " +
    "os anexos daquela vigencia antes de apurar essas competencias."
};

/** Competencia "MM/AAAA" coberta pelas tabelas transcritas? */
export function dentroDaVigencia(competencia) {
  const match = String(competencia || "").match(/^(\d{2})\/(\d{4})$/);
  if (!match) return { aplicavel: null, motivo: "Competencia nao informada ou invalida" };
  const ultimoDia = match[2] + "-" + match[1] + "-28";
  if (VIGENCIA.inicio && ultimoDia < VIGENCIA.inicio) {
    return {
      aplicavel: false,
      motivo: "Competencia " + competencia + " e anterior a " + VIGENCIA.inicio +
        ", quando os anexos tinham 20 faixas e outra formula (antes da LC 155/2016)."
    };
  }
  if (VIGENCIA.fim && ultimoDia > VIGENCIA.fim) {
    return {
      aplicavel: false,
      motivo: "Competencia " + competencia + " e posterior a " + VIGENCIA.fim +
        ". A reforma tributaria troca PIS e COFINS por CBS e IBS na reparticao a " +
        "partir de 01/2027, e muda aliquota nominal. Estas tabelas produziriam DAS errado."
    };
  }
  return { aplicavel: true, motivo: "Competencia coberta pelas tabelas conferidas" };
}

const FAIXAS = [
  { faixa: 1, ate: 180000 },
  { faixa: 2, ate: 360000 },
  { faixa: 3, ate: 720000 },
  { faixa: 4, ate: 1800000 },
  { faixa: 5, ate: 3600000 },
  { faixa: 6, ate: 4800000 }
];

// nominal em %, deducao em R$; reparticao em % da aliquota efetiva.
export const ANEXOS = {
  I: {
    nome: "Anexo I - Comercio",
    tributos: ["IRPJ", "CSLL", "COFINS", "PIS", "CPP", "ICMS"],
    tabela: [
      { nominal: 4.00, deducao: 0 },
      { nominal: 7.30, deducao: 5940 },
      { nominal: 9.50, deducao: 13860 },
      { nominal: 10.70, deducao: 22500 },
      { nominal: 14.30, deducao: 87300 },
      { nominal: 19.00, deducao: 378000 }
    ],
    reparticao: [
      { IRPJ: 5.50, CSLL: 3.50, COFINS: 12.74, PIS: 2.76, CPP: 41.50, ICMS: 34.00 },
      { IRPJ: 5.50, CSLL: 3.50, COFINS: 12.74, PIS: 2.76, CPP: 41.50, ICMS: 34.00 },
      { IRPJ: 5.50, CSLL: 3.50, COFINS: 12.74, PIS: 2.76, CPP: 42.00, ICMS: 33.50 },
      { IRPJ: 5.50, CSLL: 3.50, COFINS: 12.74, PIS: 2.76, CPP: 42.00, ICMS: 33.50 },
      { IRPJ: 5.50, CSLL: 3.50, COFINS: 12.74, PIS: 2.76, CPP: 42.00, ICMS: 33.50 },
      { IRPJ: 13.50, CSLL: 10.00, COFINS: 28.27, PIS: 6.13, CPP: 42.10, ICMS: 0 }
    ]
  },
  II: {
    nome: "Anexo II - Industria",
    tributos: ["IRPJ", "CSLL", "COFINS", "PIS", "CPP", "IPI", "ICMS"],
    tabela: [
      { nominal: 4.50, deducao: 0 },
      { nominal: 7.80, deducao: 5940 },
      { nominal: 10.00, deducao: 13860 },
      { nominal: 11.20, deducao: 22500 },
      { nominal: 14.70, deducao: 85500 },
      { nominal: 30.00, deducao: 720000 }
    ],
    reparticao: [
      { IRPJ: 5.50, CSLL: 3.50, COFINS: 11.51, PIS: 2.49, CPP: 37.50, IPI: 7.50, ICMS: 32.00 },
      { IRPJ: 5.50, CSLL: 3.50, COFINS: 11.51, PIS: 2.49, CPP: 37.50, IPI: 7.50, ICMS: 32.00 },
      { IRPJ: 5.50, CSLL: 3.50, COFINS: 11.51, PIS: 2.49, CPP: 37.50, IPI: 7.50, ICMS: 32.00 },
      { IRPJ: 5.50, CSLL: 3.50, COFINS: 11.51, PIS: 2.49, CPP: 37.50, IPI: 7.50, ICMS: 32.00 },
      { IRPJ: 5.50, CSLL: 3.50, COFINS: 11.51, PIS: 2.49, CPP: 37.50, IPI: 7.50, ICMS: 32.00 },
      { IRPJ: 8.50, CSLL: 7.50, COFINS: 20.96, PIS: 4.54, CPP: 23.50, IPI: 35.00, ICMS: 0 }
    ]
  },
  III: {
    nome: "Anexo III - Servicos",
    tributos: ["IRPJ", "CSLL", "COFINS", "PIS", "CPP", "ISS"],
    tabela: [
      { nominal: 6.00, deducao: 0 },
      { nominal: 11.20, deducao: 9360 },
      { nominal: 13.50, deducao: 17640 },
      { nominal: 16.00, deducao: 35640 },
      { nominal: 21.00, deducao: 125640 },
      { nominal: 33.00, deducao: 648000 }
    ],
    reparticao: [
      { IRPJ: 4.00, CSLL: 3.50, COFINS: 12.82, PIS: 2.78, CPP: 43.40, ISS: 33.50 },
      { IRPJ: 4.00, CSLL: 3.50, COFINS: 14.05, PIS: 3.05, CPP: 43.40, ISS: 32.00 },
      { IRPJ: 4.00, CSLL: 3.50, COFINS: 13.64, PIS: 2.96, CPP: 43.40, ISS: 32.50 },
      { IRPJ: 4.00, CSLL: 3.50, COFINS: 13.64, PIS: 2.96, CPP: 43.40, ISS: 32.50 },
      { IRPJ: 4.00, CSLL: 3.50, COFINS: 12.82, PIS: 2.78, CPP: 43.40, ISS: 33.50 },
      { IRPJ: 35.00, CSLL: 15.00, COFINS: 16.03, PIS: 3.47, CPP: 30.50, ISS: 0 }
    ]
  },
  IV: {
    nome: "Anexo IV - Servicos (sem CPP no DAS)",
    tributos: ["IRPJ", "CSLL", "COFINS", "PIS", "ISS"],
    tabela: [
      { nominal: 4.50, deducao: 0 },
      { nominal: 9.00, deducao: 8100 },
      { nominal: 10.20, deducao: 12420 },
      { nominal: 14.00, deducao: 39780 },
      { nominal: 22.00, deducao: 183780 },
      { nominal: 33.00, deducao: 828000 }
    ],
    reparticao: [
      { IRPJ: 18.80, CSLL: 15.20, COFINS: 17.67, PIS: 3.83, ISS: 44.50 },
      { IRPJ: 19.80, CSLL: 15.20, COFINS: 20.55, PIS: 4.45, ISS: 40.00 },
      { IRPJ: 20.80, CSLL: 15.20, COFINS: 19.73, PIS: 4.27, ISS: 40.00 },
      { IRPJ: 17.80, CSLL: 19.20, COFINS: 18.90, PIS: 4.10, ISS: 40.00 },
      { IRPJ: 18.80, CSLL: 19.20, COFINS: 18.08, PIS: 3.92, ISS: 40.00 },
      { IRPJ: 53.50, CSLL: 21.50, COFINS: 20.55, PIS: 4.45, ISS: 0 }
    ]
  },
  V: {
    nome: "Anexo V - Servicos (Fator R abaixo de 28%)",
    tributos: ["IRPJ", "CSLL", "COFINS", "PIS", "CPP", "ISS"],
    tabela: [
      { nominal: 15.50, deducao: 0 },
      { nominal: 18.00, deducao: 4500 },
      { nominal: 19.50, deducao: 9900 },
      { nominal: 20.50, deducao: 17100 },
      { nominal: 23.00, deducao: 62100 },
      { nominal: 30.50, deducao: 540000 }
    ],
    reparticao: [
      { IRPJ: 25.00, CSLL: 15.00, COFINS: 14.10, PIS: 3.05, CPP: 28.85, ISS: 14.00 },
      { IRPJ: 23.00, CSLL: 15.00, COFINS: 14.10, PIS: 3.05, CPP: 27.85, ISS: 17.00 },
      { IRPJ: 24.00, CSLL: 15.00, COFINS: 14.92, PIS: 3.23, CPP: 23.85, ISS: 19.00 },
      { IRPJ: 21.00, CSLL: 15.00, COFINS: 15.74, PIS: 3.41, CPP: 23.85, ISS: 21.00 },
      { IRPJ: 23.00, CSLL: 12.50, COFINS: 14.10, PIS: 3.05, CPP: 23.85, ISS: 23.50 },
      { IRPJ: 35.00, CSLL: 15.50, COFINS: 16.44, PIS: 3.56, CPP: 29.50, ISS: 0 }
    ]
  }
};

const LIMITE_SIMPLES = 4800000;
const SUBLIMITE_ICMS_ISS = 3600000;
const TETO_ISS = 5;
const FATOR_R_CORTE = 28;

function round(value, casas = 2) {
  const fator = 10 ** casas;
  return Math.round((Number(value) + Number.EPSILON) * fator) / fator;
}

/** Identifica a faixa (1 a 6) a partir do RBT12. */
export function faixaPor(rbt12) {
  for (const item of FAIXAS) {
    if (rbt12 <= item.ate) return item.faixa;
  }
  return 6;
}

/**
 * Fator R = folha de salarios dos 12 meses anteriores / RBT12.
 * A folha inclui pro-labore, FGTS e encargos (LC 123/2006, art. 18, par. 24).
 */
export function fatorR(folha12, rbt12) {
  if (!rbt12) return { valor: 0, percentual: 0, anexo: "V", motivo: "RBT12 zerado" };
  const percentual = (folha12 / rbt12) * 100;
  return {
    valor: round(folha12 / rbt12, 6),
    percentual: round(percentual, 4),
    anexo: percentual >= FATOR_R_CORTE ? "III" : "V",
    motivo: "Folha 12m " + round(folha12).toFixed(2) + " / RBT12 " + round(rbt12).toFixed(2) +
      " = " + round(percentual, 2).toFixed(2) + "% " +
      (percentual >= FATOR_R_CORTE ? "(>= 28%, Anexo III)" : "(< 28%, Anexo V)")
  };
}

/**
 * RBT12 proporcionalizada no inicio de atividade:
 * media da receita dos meses em atividade x 12 (LC 123/2006, art. 18, par. 2).
 */
export function rbt12Proporcional(receitas) {
  const meses = receitas.filter((valor) => valor !== null && valor !== undefined).length;
  if (!meses) return { rbt12: 0, meses: 0, memoria: "Sem meses de receita informados" };
  const total = receitas.reduce((acumulado, valor) => acumulado + (Number(valor) || 0), 0);
  const media = total / meses;
  return {
    rbt12: round(media * 12),
    meses,
    memoria: "Receita acumulada " + round(total).toFixed(2) + " / " + meses +
      " mes(es) x 12 = " + round(media * 12).toFixed(2)
  };
}

/** Aplica o teto de 5% no ISS, redistribuindo a sobra nos tributos federais. */
function aplicarTetoIss(reparticao, aliquotaEfetiva, tributos) {
  const issEfetivo = (aliquotaEfetiva * (reparticao.ISS || 0)) / 100;
  if (!reparticao.ISS || issEfetivo <= TETO_ISS) return { reparticao, ajuste: null };

  const excedente = issEfetivo - TETO_ISS;
  const issNovoPercentual = (TETO_ISS / aliquotaEfetiva) * 100;
  const sobraPercentual = reparticao.ISS - issNovoPercentual;
  const federais = tributos.filter((nome) => nome !== "ISS" && nome !== "ICMS");
  const somaFederais = federais.reduce((total, nome) => total + (reparticao[nome] || 0), 0);

  const ajustada = { ...reparticao, ISS: round(issNovoPercentual, 6) };
  for (const nome of federais) {
    const peso = somaFederais ? (reparticao[nome] || 0) / somaFederais : 0;
    ajustada[nome] = round((reparticao[nome] || 0) + sobraPercentual * peso, 6);
  }

  return {
    reparticao: ajustada,
    ajuste: "ISS efetivo de " + round(issEfetivo, 4).toFixed(4) + "% limitado a " + TETO_ISS +
      "%; excedente de " + round(excedente, 4).toFixed(4) +
      " p.p. redistribuido proporcionalmente aos tributos federais"
  };
}

/**
 * Apura o DAS de uma competencia.
 *
 * @param {object} entrada
 * @param {number} entrada.receitaMes        receita bruta da competencia
 * @param {number} entrada.rbt12             receita bruta dos 12 meses anteriores
 * @param {string} entrada.anexo             "I".."V"; com folha12 informada, III/V sai do Fator R
 * @param {number} [entrada.folha12]         folha dos 12 meses (ativa o Fator R)
 * @param {number} [entrada.mesesAtividade]  menos de 13 ativa a proporcionalizacao
 * @param {boolean}[entrada.semMovimento]
 * @param {string} [entrada.competencia]     "MM/AAAA"
 */
export function apurar(entrada) {
  const receitaMes = Number(entrada.receitaMes) || 0;
  const rbt12 = Number(entrada.rbt12) || 0;
  const memoria = [];
  const avisos = [];

  // A competencia precisa estar dentro da vigencia das tabelas transcritas.
  // Fora dela o numero sai errado, e sair errado calado e o pior resultado.
  const vigencia = dentroDaVigencia(entrada.competencia);
  if (vigencia.aplicavel === false) {
    avisos.push({ code: "FORA_DE_VIGENCIA", severity: "critico", message: vigencia.motivo });
  }

  if (entrada.semMovimento || receitaMes === 0) {
    return {
      competencia: entrada.competencia || "",
      status: "Sem Movimento",
      anexo: entrada.anexo || null,
      faixa: null,
      rbt12: round(rbt12),
      receitaMes: 0,
      aliquotaNominal: 0,
      aliquotaEfetiva: 0,
      das: 0,
      tributos: {},
      foraDoDas: {},
      memoria: ["Competencia sem receita: declaracao sem movimento, DAS igual a zero."],
      avisos,
      vigencia: VIGENCIA,
      vigenciaAplicavel: vigencia.aplicavel
    };
  }

  // --- anexo: Fator R quando a folha e informada
  let anexoChave = String(entrada.anexo || "III").toUpperCase();
  let fator = null;
  if (entrada.folha12 !== undefined && entrada.folha12 !== null && (anexoChave === "III" || anexoChave === "V")) {
    fator = fatorR(Number(entrada.folha12), rbt12);
    anexoChave = fator.anexo;
    memoria.push("Fator R: " + fator.motivo);
  }

  const anexo = ANEXOS[anexoChave];
  if (!anexo) throw new Error("Anexo desconhecido: " + anexoChave);

  // --- RBT12 e faixa
  let rbt12Usada = rbt12;
  if (entrada.mesesAtividade && entrada.mesesAtividade < 13 && entrada.receitasAnteriores) {
    const proporcional = rbt12Proporcional(entrada.receitasAnteriores);
    rbt12Usada = proporcional.rbt12;
    memoria.push("Inicio de atividade: " + proporcional.memoria);
  }

  if (rbt12Usada > LIMITE_SIMPLES) {
    avisos.push({
      code: "LIMITE_EXCEDIDO",
      severity: "critico",
      message: "RBT12 de " + round(rbt12Usada).toFixed(2) + " excede o limite de " +
        LIMITE_SIMPLES.toFixed(2) + " do Simples Nacional (LC 123/2006, art. 3, II)"
    });
  }

  const faixa = faixaPor(rbt12Usada);
  const linha = anexo.tabela[faixa - 1];
  memoria.push("RBT12 de " + round(rbt12Usada).toFixed(2) + " cai na faixa " + faixa +
    " do " + anexo.nome + ": nominal " + linha.nominal.toFixed(2) + "%, deducao " + linha.deducao.toFixed(2));

  // --- aliquota efetiva
  const aliquotaEfetiva = round(((rbt12Usada * (linha.nominal / 100)) - linha.deducao) / rbt12Usada * 100, 4);
  memoria.push("Aliquota efetiva = [(RBT12 " + round(rbt12Usada).toFixed(2) + " x " + linha.nominal.toFixed(2) +
    "%) - " + linha.deducao.toFixed(2) + "] / RBT12 " + round(rbt12Usada).toFixed(2) +
    " = " + aliquotaEfetiva.toFixed(4) + "%");

  if (aliquotaEfetiva <= 0) {
    avisos.push({
      code: "ALIQUOTA_NAO_POSITIVA",
      severity: "critico",
      message: "Aliquota efetiva calculada em " + aliquotaEfetiva.toFixed(4) + "%: confira RBT12 e faixa"
    });
  }

  // --- reparticao, com teto de ISS
  const { reparticao, ajuste } = aplicarTetoIss(anexo.reparticao[faixa - 1], aliquotaEfetiva, anexo.tributos);
  if (ajuste) memoria.push(ajuste);

  const tributos = {};
  const foraDoDas = {};
  const sublimiteEstourado = rbt12Usada > SUBLIMITE_ICMS_ISS;

  for (const nome of anexo.tributos) {
    const percentual = reparticao[nome] || 0;

    // Na faixa 6 a lei nao atribui percentual de ICMS/ISS: esses tributos saem
    // do DAS e o valor vem da legislacao estadual/municipal, nao desta tabela.
    if (percentual === 0 && (nome === "ICMS" || nome === "ISS")) {
      foraDoDas[nome] = {
        percentualReparticao: 0,
        aliquota: null,
        valor: null,
        observacao: "Faixa " + faixa + ": fora do DAS. O valor nao sai da tabela do Simples - " +
          "apure pela legislacao do " + (nome === "ICMS" ? "Estado" : "Municipio") + "."
      };
      continue;
    }

    const aliquotaTributo = round((aliquotaEfetiva * percentual) / 100, 6);
    const destino = (nome === "ICMS" || nome === "ISS") && sublimiteEstourado ? foraDoDas : tributos;
    destino[nome] = {
      percentualReparticao: percentual,
      aliquota: aliquotaTributo,
      valor: round((receitaMes * aliquotaTributo) / 100),
      memoria: "Receita " + receitaMes.toFixed(2) + " x (" + aliquotaEfetiva.toFixed(4) + "% x " +
        percentual.toFixed(2) + "%) = " + round((receitaMes * aliquotaTributo) / 100).toFixed(2)
    };
  }

  if (sublimiteEstourado || faixa === 6) {
    avisos.push({
      code: "SUBLIMITE_ICMS_ISS",
      severity: "atencao",
      message: "RBT12 de " + round(rbt12Usada).toFixed(2) + " esta na faixa " + faixa +
        ": ICMS e ISS sao recolhidos fora do DAS, pela legislacao do Estado e do Municipio " +
        "(LC 123/2006, art. 19 e 20). O sistema nao calcula esses valores."
    });
  }

  // O DAS e receita x aliquota efetiva, menos o que foi desviado para fora dele
  // pelo sublimite. A reparticao precisa somar exatamente esse total, entao o
  // residuo de arredondamento vai para o tributo de maior peso, como no PGDAS.
  const dasCheio = round((receitaMes * aliquotaEfetiva) / 100);
  const desviado = round(Object.values(foraDoDas)
    .reduce((total, item) => total + (Number(item.valor) || 0), 0));
  const das = round(dasCheio - desviado);
  const somaPartes = round(Object.values(tributos).reduce((total, item) => total + item.valor, 0));
  const residuo = round(das - somaPartes);
  if (residuo !== 0 && Object.keys(tributos).length) {
    const maior = Object.keys(tributos).reduce((atual, nome) =>
      tributos[nome].valor > tributos[atual].valor ? nome : atual);
    tributos[maior].valor = round(tributos[maior].valor + residuo);
    tributos[maior].memoria += " (ajuste de arredondamento " + residuo.toFixed(2) + ")";
    memoria.push("Residuo de arredondamento de " + residuo.toFixed(2) +
      " alocado em " + maior + " para a reparticao fechar com o DAS.");
  }

  memoria.push("DAS = receita " + receitaMes.toFixed(2) + " x aliquota efetiva " +
    aliquotaEfetiva.toFixed(4) + "% = " + dasCheio.toFixed(2) +
    (desviado ? " menos " + desviado.toFixed(2) + " recolhido fora = " + das.toFixed(2) : "") +
    (faixa === 6 ? " (ICMS/ISS fora do DAS, apurados pelo ente)" : ""));

  return {
    competencia: entrada.competencia || "",
    status: "Aberto",
    anexo: anexoChave,
    anexoNome: anexo.nome,
    fatorR: fator,
    faixa,
    rbt12: round(rbt12Usada),
    receitaMes: round(receitaMes),
    aliquotaNominal: linha.nominal,
    deducao: linha.deducao,
    aliquotaEfetiva,
    das,
    tributos,
    foraDoDas,
    memoria,
    avisos,
    vigencia: VIGENCIA,
    vigenciaAplicavel: vigencia.aplicavel
  };
}

// ---------------------------------------------------------------------------
// A RECEITA DO MES, NOTA A NOTA, E A SEGREGACAO POR ANEXO
// ---------------------------------------------------------------------------
//
// Regra portada da PONTE SEFAZ (src/webapp/simples.ts: cfopDeReceita,
// receitaDaCompetencia, apurarCompetencia, apurarSegmento), onde esta testada.
// Corrige dois defeitos da versao anterior desta apuracao:
//
// - defeito 5: a receita somava toda nota emitida, sem olhar o CFOP. Remessa,
//   transferencia, retorno, venda de ativo e ate a nota de ENTRADA emitida pela
//   propria empresa (tpNF=0) viravam receita. Agora so venda e prestacao entram,
//   e a devolucao de venda abate;
// - defeito 11: um anexo so (o da maioria) para a receita inteira. Agora cada
//   parcela vai no seu anexo (LC 123/2006, art. 18, par. 4), todas com o MESMO
//   RBT12, que e da empresa e nao da atividade, e o DAS e a soma das parcelas.

const digitosCfop = (cfop) => String(cfop ?? "").replace(/\D/g, "");
const cfopValido = (cfop) => /^[123567]\d{3}$/.test(digitosCfop(cfop));
const primeiroDoCfop = (cfop) => digitosCfop(cfop).charAt(0);
const finalDoCfop = (cfop) => Number(digitosCfop(cfop).slice(1, 4));
const DE_ENTRADA = ["1", "2", "3"];
const DE_SAIDA = ["5", "6", "7"];

// Venda de producao do proprio estabelecimento: Anexo II. O resto das vendas de
// mercadoria e revenda: Anexo I. Entram aqui a industrializacao por encomenda
// (x.124, x.125) e o combustivel de producao propria (x.651 a x.653).
const PRODUCAO_PROPRIA = new Set([101, 103, 105, 107, 109, 111, 113, 116, 118, 122, 124, 125, 401, 402, 651, 652, 653]);

// Devolucao de venda: x.201, x.203 e x.410 devolvem producao propria; x.202,
// x.204 e x.411, mercadoria revendida.
const DEVOLUCAO_DE_VENDA = { 201: "industria", 202: "comercio", 203: "industria", 204: "comercio", 410: "industria", 411: "comercio" };

const ANEXOS_DE_SERVICO = ["III", "IV", "V"];

export const SEGMENTOS = {
  comercio: "Comercio (revenda de mercadorias)",
  industria: "Industria (venda de producao propria)",
  servicos: "Servicos",
  transporte: "Transporte e comunicacao"
};

/**
 * O CFOP e de receita bruta? Venda de mercadoria ou de producao, com ou sem ST,
 * de combustivel, de energia, de comunicacao, de transporte, e o servico do ISS
 * na NF-e conjugada (x.933). Fica de fora o que nao e venda: remessa, retorno,
 * transferencia, bonificacao, devolucao de compra, venda de ativo imobilizado
 * (que nao e receita da atividade) e todo CFOP de entrada (1, 2 e 3).
 */
export function cfopDeReceita(cfop) {
  if (!cfopValido(cfop) || !DE_SAIDA.includes(primeiroDoCfop(cfop))) return false;
  const n = finalDoCfop(cfop);
  return (n >= 101 && n <= 125) || (n >= 401 && n <= 405) || (n >= 651 && n <= 656) || n === 667 ||
    (n >= 251 && n <= 258) || (n >= 301 && n <= 307) || (n >= 351 && n <= 360) || n === 933;
}

/** A atividade (e dai o anexo) de um CFOP de receita; null quando nao e receita. */
export function atividadeDoCfop(cfop) {
  if (!cfopDeReceita(cfop)) return null;
  const n = finalDoCfop(cfop);
  if (n === 933) return "servicos";
  // Comunicacao e transporte: Anexo III com o ICMS no lugar do ISS (art. 18, par. 5-E).
  if ((n >= 301 && n <= 307) || (n >= 351 && n <= 360)) return "transporte";
  return PRODUCAO_PROPRIA.has(n) ? "industria" : "comercio";
}

/**
 * Devolucao de VENDA, do lado de quem vendeu, e de que atividade.
 * - papel "emitida": a propria empresa emitiu a nota de entrada da devolucao
 *   (cliente nao contribuinte). O CFOP e dela e diz a atividade.
 * - papel "recebida": o cliente devolveu com a nota DELE (devolucao de compra,
 *   do lado dele). O CFOP descreve a compra dele, e nao diz se a venda foi de
 *   revenda ou de producao: atividade null.
 */
export function devolucaoDeVenda(cfop, papel) {
  const n = finalDoCfop(cfop);
  if (!cfopValido(cfop) || !Object.hasOwn(DEVOLUCAO_DE_VENDA, n)) return null;
  const primeiro = primeiroDoCfop(cfop);
  if (papel === "emitida") return DE_ENTRADA.includes(primeiro) ? { atividade: DEVOLUCAO_DE_VENDA[n] } : null;
  if (papel === "recebida") return DE_SAIDA.includes(primeiro) ? { atividade: null } : null;
  return null;
}

/** "MM/AAAA" ou "AAAA-MM" para "AAAA-MM". */
function competenciaIso(competencia) {
  const texto = String(competencia || "");
  const br = texto.match(/^(\d{2})\/(\d{4})$/);
  if (br) return br[2] + "-" + br[1];
  return texto.slice(0, 7);
}

function competenciaBr(iso) {
  return iso.slice(5, 7) + "/" + iso.slice(0, 4);
}

// Em que mes a nota conta. A coluna competencia do acervo traz, na NFS-e, a
// competencia dela (dCompet no padrao nacional, Competencia no ABRASF); nas
// demais, o mes da emissao.
function competenciaDaNota(documento) {
  return String(documento.competencia || documento.issuedAt || "").slice(0, 7);
}

// A empresa emitiu a nota ou a recebeu? A captura grava o papel; o que entrou
// por arquivo nao tem, e sai do CNPJ do emitente e do destinatario.
function papelDaNota(documento, cnpj) {
  if (["emitida", "recebida", "outro"].includes(documento.papel)) return documento.papel;
  if (!cnpj) return "emitida";
  if (documento.emitter?.cnpj === cnpj) return "emitida";
  if (documento.recipient?.doc === cnpj) return "recebida";
  return "outro";
}

// O tpNF que o emitente declarou (1 saida, 0 entrada). Documento lido depois
// desta correcao traz o campo. No que entrou por arquivo, sem papel gravado, a
// operacao foi lida do proprio tpNF. Na captura a operacao e reescrita pelo
// papel (emitida vira "saida" mesmo sendo nota de entrada) e nao serve: sem o
// campo, quem decide e o CFOP de cada item (1, 2 e 3 sao de entrada).
function tpNfDaNota(documento) {
  const declarado = String(documento.tpNF ?? "");
  if (declarado === "0" || declarado === "1") return declarado;
  if (!documento.papel && documento.operation === "entrada") return "0";
  if (!documento.papel && documento.operation === "saida") return "1";
  return null;
}

// Item da NF-e: vProd menos o desconto incondicional (vDesc). IPI e ST nao sao receita.
function valorDoItem(item) {
  return (Number(item?.total) || 0) - (Number(item?.discount) || 0);
}

function valorDaNotaSemItens(documento) {
  const totais = documento.totals || {};
  if (Number(totais.products)) return Number(totais.products) - (Number(totais.discount) || 0);
  return Number(totais.invoice) || 0;
}

/**
 * A receita bruta de uma competencia, a partir das notas da empresa.
 *
 * NF-e e NFC-e emitidas: soma so os itens com CFOP de receita, separados por
 * atividade (revenda, producao propria, servico conjugado x.933, transporte e
 * comunicacao). A nota de ENTRADA emitida pela empresa so conta se for
 * devolucao de venda, e abate. NFS-e e CT-e emitidos entram pelo total, a NFS-e
 * pela competencia dela. O que a empresa recebeu so conta como devolucao de
 * venda (a nota do cliente que devolveu). Cancelada e evento nao contam, e a
 * mesma chave so conta uma vez.
 *
 * Nota sem CFOP lido (documento antigo, ou NF-e sem itens): sem o CFOP nao ha
 * como separar venda de remessa. A saida emitida entra pelo total, de forma
 * conservadora (o DAS nao sai menor do que deve), e vai em `semCfop` para o
 * aviso dizer quais foram assim.
 *
 * @param {object[]} documentos  documentos normalizados (lib/documentos.mjs), como o acervo devolve
 * @param {string}   competencia "MM/AAAA" ou "AAAA-MM"
 * @param {object}   [opcoes]
 * @param {string}   [opcoes.cnpj] CNPJ da empresa (14 digitos), para saber o papel de cada nota
 */
export function receitaDaCompetencia(documentos, competencia, { cnpj } = {}) {
  const alvo = competenciaIso(competencia);
  const r = {
    competencia: alvo,
    comercio: 0, industria: 0, servicos: 0, transporte: 0, semCfop: 0,
    devolucoes: { comercio: 0, industria: 0, semAtividade: 0 },
    foraDaReceita: { itens: 0, valor: 0, porCfop: {} },
    notas: { mercadoria: 0, servico: 0, transporte: 0, devolucao: 0, entradaPropria: 0 },
    chaves: [],
    chavesSemCfop: [],
    comSt: false,
    exportacao: false,
    memoria: [],
    avisos: []
  };
  const vistas = new Set();

  for (const documento of documentos || []) {
    if (!documento || documento.kind === "Evento" || documento.cancelled) continue;
    if (competenciaDaNota(documento) !== alvo) continue;
    const chave = documento.key || documento.id || "(sem chave)";
    if (vistas.has(chave)) continue;
    vistas.add(chave);
    const papel = papelDaNota(documento, cnpj);
    if (papel === "outro") continue;

    if (documento.kind === "NFS-e") {
      if (papel === "emitida") {
        r.servicos += Number(documento.service?.gross ?? documento.totals?.products) || 0;
        r.notas.servico += 1;
        r.chaves.push(chave);
      }
      continue;
    }
    if (documento.kind === "CT-e") {
      if (papel === "emitida") {
        r.transporte += Number(documento.totals?.invoice ?? documento.totals?.products) || 0;
        r.notas.transporte += 1;
        r.chaves.push(chave);
      }
      continue;
    }
    if (documento.kind !== "NF-e" && documento.kind !== "NFC-e") continue;

    const tpNF = tpNfDaNota(documento);
    const itens = Array.isArray(documento.items) ? documento.items.filter(Boolean) : [];
    if (!itens.some((item) => cfopValido(item.cfop))) {
      if (papel === "emitida" && tpNF !== "0") {
        r.semCfop += valorDaNotaSemItens(documento);
        r.notas.mercadoria += 1;
        r.chaves.push(chave);
        r.chavesSemCfop.push(chave);
      }
      continue;
    }

    const conta = { mercadoria: false, servico: false, transporte: false, devolucao: false, semCfop: false };
    let soEntrada = true;
    for (const item of itens) {
      const cfop = digitosCfop(item.cfop);
      const valor = valorDoItem(item);
      if (!cfopValido(cfop)) {
        // Item sem CFOP numa nota que tem outros com: conservador, como a nota sem CFOP.
        if (papel === "emitida" && tpNF !== "0") { r.semCfop += valor; conta.semCfop = true; }
        continue;
      }
      if (papel === "recebida") {
        // Compra, remessa recebida etc. nao sao receita; so a devolucao do cliente abate.
        if (devolucaoDeVenda(cfop, "recebida")) { r.devolucoes.semAtividade += valor; conta.devolucao = true; }
        continue;
      }
      const entrada = tpNF === "0" || (tpNF === null && DE_ENTRADA.includes(cfop[0]));
      if (!entrada) soEntrada = false;
      if (!entrada) {
        const atividade = atividadeDoCfop(cfop);
        if (atividade) {
          r[atividade] += valor;
          if (atividade === "servicos") conta.servico = true;
          else if (atividade === "transporte") conta.transporte = true;
          else conta.mercadoria = true;
          const n = finalDoCfop(cfop);
          if (n >= 401 && n <= 405) r.comSt = true;
          if (cfop[0] === "7") r.exportacao = true;
          continue;
        }
      } else {
        const devolucao = devolucaoDeVenda(cfop, "emitida");
        if (devolucao) { r.devolucoes[devolucao.atividade] += valor; conta.devolucao = true; continue; }
      }
      // Remessa, retorno, transferencia, bonificacao, ativo, compra: fora da receita.
      r.foraDaReceita.itens += 1;
      r.foraDaReceita.valor += valor;
      r.foraDaReceita.porCfop[cfop] = (r.foraDaReceita.porCfop[cfop] || 0) + valor;
    }

    if (conta.mercadoria || conta.semCfop) r.notas.mercadoria += 1;
    if (conta.servico) r.notas.servico += 1;
    if (conta.transporte) r.notas.transporte += 1;
    if (conta.devolucao) r.notas.devolucao += 1;
    if (Object.values(conta).some(Boolean)) r.chaves.push(chave);
    if (conta.semCfop) r.chavesSemCfop.push(chave);
    if (papel === "emitida" && soEntrada && !conta.devolucao) r.notas.entradaPropria += 1;
  }

  for (const campo of ["comercio", "industria", "servicos", "transporte", "semCfop"]) r[campo] = round(r[campo]);
  for (const campo of Object.keys(r.devolucoes)) r.devolucoes[campo] = round(r.devolucoes[campo]);
  r.foraDaReceita.valor = round(r.foraDaReceita.valor);
  for (const cfop of Object.keys(r.foraDaReceita.porCfop)) r.foraDaReceita.porCfop[cfop] = round(r.foraDaReceita.porCfop[cfop]);

  // --- memoria da receita
  r.memoria.push("Receita da competencia " + competenciaBr(alvo) + " pelas notas da empresa, sem as canceladas: " +
    "entram so venda e prestacao (CFOP de venda, NFS-e e CT-e emitidos); devolucao de venda abate; " +
    "nota de entrada nunca e receita.");
  if (r.comercio) r.memoria.push("Revenda de mercadorias (CFOP de venda de mercadoria adquirida): " + r.comercio.toFixed(2));
  if (r.industria) r.memoria.push("Venda de producao propria (CFOP x.101 e afins): " + r.industria.toFixed(2));
  if (r.servicos) r.memoria.push("Servicos (NFS-e emitidas, pela competencia da nota, e CFOP x.933): " + r.servicos.toFixed(2));
  if (r.transporte) r.memoria.push("Transporte e comunicacao (CT-e emitidos, CFOP x.301 a x.360): " + r.transporte.toFixed(2));
  if (r.semCfop) r.memoria.push("Notas de saida sem CFOP lido, pelo total: " + r.semCfop.toFixed(2));
  const devolvido = round(r.devolucoes.comercio + r.devolucoes.industria + r.devolucoes.semAtividade);
  if (devolvido) r.memoria.push("Devolucoes de venda no mes: " + devolvido.toFixed(2));
  if (r.foraDaReceita.itens) {
    r.memoria.push("Fora da receita (remessa, retorno, transferencia, bonificacao, ativo, entrada): " +
      Object.entries(r.foraDaReceita.porCfop).map(([cfop, valor]) => "CFOP " + cfop + " " + valor.toFixed(2)).join("; ") +
      " = " + r.foraDaReceita.valor.toFixed(2));
  }
  if (r.notas.entradaPropria) {
    r.memoria.push(r.notas.entradaPropria + " nota(s) de entrada emitida(s) pela propria empresa (tpNF=0) sem devolucao de venda: nao sao receita.");
  }

  // --- o que o PGDAS-D segrega e esta apuracao nao
  if (r.comSt) {
    r.avisos.push({
      code: "RECEITA_COM_ST",
      severity: "atencao",
      message: "Ha venda com CFOP de substituicao tributaria (x.401 a x.405). No PGDAS-D a revenda como substituido " +
        "sai segregada, sem o ICMS na reparticao (LC 123/2006, art. 18, par. 4-A); esta apuracao nao faz essa " +
        "segregacao, entao o ICMS dessa receita pode sair a maior."
    });
  }
  if (r.exportacao) {
    r.avisos.push({
      code: "RECEITA_EXPORTACAO",
      severity: "atencao",
      message: "Ha receita de exportacao (CFOP 7.xxx). No PGDAS-D ela sai segregada, sem COFINS, PIS, IPI e ICMS " +
        "(LC 123/2006, art. 18, par. 14); esta apuracao nao faz essa segregacao, entao o DAS sai a maior."
    });
  }
  return r;
}

/**
 * A receita de cada atividade depois de:
 * 1. a nota sem CFOP ir para a atividade do anexo do cadastro (II e industria;
 *    I, servico ou vazio, revenda), com aviso;
 * 2. a devolucao de venda abater a atividade dela. A devolucao pela nota do
 *    cliente, que nao diz a atividade, abate a revenda e depois a producao.
 * Nenhuma parcela fica negativa: o que sobra de devolucao vira aviso.
 */
export function receitaLiquida(receitas = {}, anexoDoCadastro = null) {
  const base = anexoDoCadastro ? String(anexoDoCadastro).toUpperCase() : null;
  const memoria = [];
  const avisos = [];
  const saldo = { comercio: round(Number(receitas.comercio) || 0), industria: round(Number(receitas.industria) || 0) };

  const semCfop = round(Number(receitas.semCfop) || 0);
  if (semCfop > 0) {
    const destino = base === "II" ? "industria" : "comercio";
    const anexoSemCfop = destino === "industria" ? "II" : "I";
    saldo[destino] = round(saldo[destino] + semCfop);
    const quantas = Array.isArray(receitas.chavesSemCfop) && receitas.chavesSemCfop.length
      ? receitas.chavesSemCfop.length + " nota(s)" : "Nota(s)";
    avisos.push({
      code: "RECEITA_SEM_CFOP",
      severity: "atencao",
      message: quantas + " de saida sem CFOP lido (documento antigo ou sem itens) entraram pelo valor total, " +
        semCfop.toFixed(2) + ", no Anexo " + anexoSemCfop +
        (base === "I" || base === "II" ? " do cadastro" : " (revenda: o cadastro nao traz anexo de mercadoria)") +
        ". Sem o CFOP nao ha como separar venda de remessa, transferencia ou retorno: reimporte o XML para a " +
        "apuracao separar pelo CFOP."
    });
    memoria.push("Notas sem CFOP: " + semCfop.toFixed(2) + " somados a parcela de " + destino +
      " (Anexo " + anexoSemCfop + "), pelo total da nota.");
  }

  const devolucoes = receitas.devolucoes || {};
  let excedente = 0;
  for (const atividade of ["comercio", "industria"]) {
    const valor = round(Number(devolucoes[atividade]) || 0);
    if (!valor) continue;
    const abatido = round(Math.min(valor, saldo[atividade]));
    saldo[atividade] = round(saldo[atividade] - abatido);
    excedente = round(excedente + valor - abatido);
    memoria.push("Devolucao de venda de " + (atividade === "comercio" ? "mercadoria revendida" : "producao propria") +
      ": " + valor.toFixed(2) + " abatido da parcela de " + atividade +
      (abatido < valor ? " (so " + abatido.toFixed(2) + " cabiam)" : "") + ".");
  }
  let semAtividade = round(Number(devolucoes.semAtividade) || 0);
  if (semAtividade) {
    const total = semAtividade;
    const partes = [];
    for (const atividade of ["comercio", "industria"]) {
      const abatido = round(Math.min(semAtividade, saldo[atividade]));
      if (abatido <= 0) continue;
      saldo[atividade] = round(saldo[atividade] - abatido);
      semAtividade = round(semAtividade - abatido);
      partes.push(abatido.toFixed(2) + " da parcela de " + atividade);
    }
    excedente = round(excedente + semAtividade);
    memoria.push("Devolucao de venda pela nota do cliente (o CFOP dele nao diz se a venda foi revenda ou producao): " +
      total.toFixed(2) + ", abatido " + (partes.length ? partes.join(" e ") : "de nada (sem receita de mercadoria no mes)") + ".");
  }
  if (excedente > 0) {
    avisos.push({
      code: "DEVOLUCAO_MAIOR_QUE_RECEITA",
      severity: "atencao",
      message: "Devolucoes de venda de " + excedente.toFixed(2) + " passaram da receita da atividade no mes e nao " +
        "foram abatidas: a parcela ficou em zero. Confira no PGDAS-D o tratamento desse saldo."
    });
  }

  return {
    comercio: saldo.comercio,
    industria: saldo.industria,
    servicos: round(Number(receitas.servicos) || 0),
    transporte: round(Number(receitas.transporte) || 0),
    devolucoesExcedentes: excedente,
    memoria,
    avisos
  };
}

function semRepetir(avisos) {
  const vistos = new Set();
  return avisos.filter((aviso) => {
    const chave = aviso.code + "|" + aviso.message;
    if (vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });
}

function somarTributos(segmentos) {
  const total = {};
  const partes = {};
  for (const segmento of segmentos) {
    for (const [nome, item] of Object.entries(segmento.tributos)) {
      total[nome] = total[nome] || { percentualReparticao: null, aliquota: null, valor: 0 };
      total[nome].valor = round(total[nome].valor + item.valor);
      (partes[nome] = partes[nome] || []).push(item.valor.toFixed(2) + " (Anexo " + segmento.anexo + ")");
    }
  }
  for (const nome of Object.keys(total)) {
    total[nome].memoria = "Soma das parcelas: " + partes[nome].join(" + ") + " = " + total[nome].valor.toFixed(2);
  }
  return total;
}

function juntarForaDoDas(segmentos) {
  const fora = {};
  for (const segmento of segmentos) {
    for (const [nome, item] of Object.entries(segmento.foraDoDas)) {
      const texto = "Anexo " + segmento.anexo + ": " + (item.observacao || item.memoria || "");
      const valor = item.valor ?? null;
      if (!fora[nome]) {
        fora[nome] = { percentualReparticao: null, aliquota: null, valor, observacao: texto };
        continue;
      }
      fora[nome].valor = fora[nome].valor === null || valor === null ? null : round(fora[nome].valor + valor);
      fora[nome].observacao += " | " + texto;
    }
  }
  return fora;
}

/**
 * A apuracao segregada: cada parcela da receita no seu anexo, todas com o
 * mesmo RBT12, e o DAS como soma das parcelas.
 *
 * - revenda de mercadorias: Anexo I (LC 123/2006, art. 18, par. 4, I);
 * - venda de producao propria: Anexo II (par. 4, II);
 * - servicos: o anexo de servico do cadastro (III, IV ou V), com o Fator R
 *   decidindo entre III e V quando a folha e informada. Cadastro sem anexo de
 *   servico: Anexo III, o residual (par. 5-F), com aviso critico;
 * - transporte e comunicacao: Anexo III (par. 5-E), com aviso.
 *
 * Com uma parcela so, o resultado e o mesmo de `apurar`, mais `segmentos`. Com
 * mais de uma, nominal, deducao e efetiva ficam em cada parcela (no topo vao
 * null), e `tributos` e `foraDoDas` do topo somam as parcelas.
 *
 * @param {object} entrada
 * @param {object} entrada.receitas  { comercio, industria, servicos, transporte, semCfop, devolucoes }
 *                                   (o formato de `receitaDaCompetencia`; so as atividades com valor importam)
 * @param {number} entrada.rbt12
 * @param {string} [entrada.anexo]   o anexo do cadastro (ou o informado na apuracao)
 * @param {number} [entrada.folha12] folha dos 12 meses: ativa o Fator R na parcela de servicos
 * @param {string} [entrada.competencia] "MM/AAAA"
 */
export function apurarSegregado({ receitas = {}, rbt12, anexo, folha12, competencia, memoriaDaReceita = [], avisosDaReceita = [] }) {
  const base = anexo ? String(anexo).toUpperCase() : null;
  const liquida = receitaLiquida(receitas, base);
  const memoria = [...memoriaDaReceita, ...liquida.memoria];
  const avisos = [...avisosDaReceita, ...liquida.avisos];

  const parcelas = [];
  if (liquida.comercio > 0) parcelas.push({ segmento: "comercio", anexo: "I", receita: liquida.comercio });
  if (liquida.industria > 0) parcelas.push({ segmento: "industria", anexo: "II", receita: liquida.industria });
  if (liquida.servicos > 0) {
    let anexoServico = base;
    if (!ANEXOS_DE_SERVICO.includes(base)) {
      anexoServico = "III";
      avisos.push({
        code: "SERVICO_SEM_ANEXO_NO_CADASTRO",
        severity: "critico",
        message: (base
          ? "O anexo do cadastro (" + base + ") e de mercadoria, nao de servico"
          : "O cadastro nao informa o anexo") +
          ": a receita de servicos de " + liquida.servicos.toFixed(2) + " foi apurada no Anexo III, o residual " +
          "da LC 123/2006 (art. 18, par. 5-F). Se a atividade e do Anexo IV ou V, o DAS desta parcela esta errado. " +
          "Informe no cadastro o anexo do servico (III, IV ou V); a parcela de mercadorias ja sai do CFOP."
      });
    }
    parcelas.push({ segmento: "servicos", anexo: anexoServico, receita: liquida.servicos });
  }
  if (liquida.transporte > 0) {
    parcelas.push({ segmento: "transporte", anexo: "III", receita: liquida.transporte });
    avisos.push({
      code: "TRANSPORTE",
      severity: "atencao",
      message: "Transporte de cargas ou comunicacao: Anexo III com a parcela do ISS trocada pela do ICMS " +
        "(LC 123/2006, art. 18, par. 5-E). O total e o do Anexo III; a reparticao por tributo mostra ISS onde o " +
        "PGDAS-D mostra ICMS."
    });
  }

  const vigencia = dentroDaVigencia(competencia);

  if (!parcelas.length) {
    const vazio = apurar({ receitaMes: 0, rbt12, anexo: base, competencia });
    return { ...vazio, segmentos: [], memoria: [...memoria, ...vazio.memoria], avisos: semRepetir([...vazio.avisos, ...avisos]) };
  }

  const apuradas = parcelas.map((parcela) => apurar({
    receitaMes: parcela.receita,
    rbt12,
    anexo: parcela.anexo,
    // O Fator R e da atividade de servico: nao mexe no anexo da mercadoria nem no do transporte.
    folha12: parcela.segmento === "servicos" ? folha12 : undefined,
    competencia
  }));
  const segmentos = apuradas.map((r, indice) => ({
    segmento: parcelas[indice].segmento,
    rotulo: SEGMENTOS[parcelas[indice].segmento],
    receita: r.receitaMes,
    anexo: r.anexo,
    anexoNome: r.anexoNome,
    faixa: r.faixa,
    rbt12: r.rbt12,
    aliquotaNominal: r.aliquotaNominal,
    deducao: r.deducao,
    aliquotaEfetiva: r.aliquotaEfetiva,
    das: r.das,
    tributos: r.tributos,
    foraDoDas: r.foraDoDas,
    fatorR: r.fatorR,
    memoria: r.memoria
  }));
  const todosAvisos = semRepetir([...apuradas.flatMap((r) => r.avisos), ...avisos]);

  if (segmentos.length === 1) {
    const [r] = apuradas;
    return {
      ...r,
      segmentos,
      memoria: [...memoria, "Receita do mes toda de uma atividade: " + segmentos[0].rotulo.toLowerCase() +
        ", no " + r.anexoNome + ".", ...r.memoria],
      avisos: todosAvisos
    };
  }

  const das = round(segmentos.reduce((total, item) => total + item.das, 0));
  const receitaMes = round(segmentos.reduce((total, item) => total + item.receita, 0));
  const { faixa, rbt12: rbt12Usada } = segmentos[0];
  memoria.push("Segregacao por atividade (LC 123/2006, art. 18, par. 4): cada parcela da receita no seu anexo, " +
    "todas com o mesmo RBT12 de " + rbt12Usada.toFixed(2) + " (faixa " + faixa + "), que e da empresa e nao da atividade.");
  for (const segmento of segmentos) {
    memoria.push(segmento.rotulo + ": receita " + segmento.receita.toFixed(2) + " no " + segmento.anexoNome + ".");
    for (const linha of segmento.memoria) memoria.push("[Anexo " + segmento.anexo + ", " + segmento.segmento + "] " + linha);
  }
  memoria.push("DAS = soma das parcelas: " +
    segmentos.map((item) => item.das.toFixed(2) + " (Anexo " + item.anexo + ")").join(" + ") + " = " + das.toFixed(2));

  return {
    competencia: competencia || "",
    status: "Aberto",
    anexo: [...new Set(segmentos.map((item) => item.anexo))].join(" + "),
    anexoNome: segmentos.map((item) => item.anexoNome).join(" + "),
    fatorR: segmentos.find((item) => item.fatorR)?.fatorR || null,
    faixa,
    rbt12: rbt12Usada,
    receitaMes,
    aliquotaNominal: null,
    deducao: null,
    aliquotaEfetiva: null,
    das,
    tributos: somarTributos(segmentos),
    foraDoDas: juntarForaDoDas(segmentos),
    segmentos,
    memoria,
    avisos: todosAvisos,
    vigencia: VIGENCIA,
    vigenciaAplicavel: vigencia.aplicavel
  };
}

/**
 * Monta a apuracao a partir dos documentos fiscais ja lidos: a receita do mes
 * pelo CFOP (`receitaDaCompetencia`) e cada parcela no seu anexo
 * (`apurarSegregado`). `origem` diz de onde veio cada numero.
 */
export function apurarDeDocumentos({ documentos, competencia, rbt12, anexo, folha12, cnpj }) {
  const receita = receitaDaCompetencia(documentos, competencia, { cnpj });
  const resultado = apurarSegregado({
    receitas: receita, rbt12, anexo, folha12, competencia,
    memoriaDaReceita: receita.memoria, avisosDaReceita: receita.avisos
  });

  return {
    ...resultado,
    origem: {
      documentos: receita.chaves.length,
      notasServico: receita.notas.servico,
      notasMercadoria: receita.notas.mercadoria,
      notasTransporte: receita.notas.transporte,
      notasDevolucao: receita.notas.devolucao,
      notasEntradaPropria: receita.notas.entradaPropria,
      receitaServicos: receita.servicos,
      receitaMercadorias: round(receita.comercio + receita.industria + receita.semCfop),
      receitaComercio: receita.comercio,
      receitaIndustria: receita.industria,
      receitaTransporte: receita.transporte,
      receitaSemCfop: receita.semCfop,
      devolucoes: round(receita.devolucoes.comercio + receita.devolucoes.industria + receita.devolucoes.semAtividade),
      foraDaReceita: {
        itens: receita.foraDaReceita.itens,
        valor: receita.foraDaReceita.valor,
        porCfop: Object.entries(receita.foraDaReceita.porCfop).map(([cfop, valor]) => ({ cfop, valor }))
      },
      semCfop: receita.chavesSemCfop,
      chaves: receita.chaves
    }
  };
}
