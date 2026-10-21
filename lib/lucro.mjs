// Apuracao de IRPJ, CSLL, PIS e COFINS no Lucro Presumido e no Lucro Real,
// a partir da receita das notas. Funcoes puras: recebem os numeros e devolvem
// o resultado com a memoria de calculo, linha a linha.
//
// Lucro Presumido (Lei 9.249/95, arts. 15 e 20; trimestral):
//   - base do IRPJ e da CSLL = receita x percentual de presuncao da atividade;
//   - IRPJ 15% + adicional de 10% sobre a base que passar de R$ 60.000 no
//     trimestre (R$ 20.000 por mes); CSLL 9%;
//   - acrescimo de 10% nos percentuais de presuncao sobre a parcela da receita
//     que passar de R$ 1.250.000 no trimestre (R$ 5 milhoes no ano), com a
//     sobra do limite acumulando para os trimestres seguintes do mesmo ano e o
//     ajuste no ultimo trimestre (LC 224/2025; IN RFB 2.305/2025 e 2.306/2026).
//     Vale para o IRPJ desde 01/01/2026 e para a CSLL desde 01/04/2026;
//   - PIS 0,65% e COFINS 3% cumulativos, mes a mes.
// Lucro Real:
//   - estimativa mensal: a mesma presuncao sobre a receita do mes (sem o
//     acrescimo da LC 224, que e do Presumido), IRPJ 15% + adicional sobre
//     R$ 20.000 no mes, CSLL 9%;
//   - trimestral: sobre o lucro contabil informado, com adicoes, exclusoes e a
//     compensacao de prejuizo limitada a 30% do lucro ajustado; adicional sobre
//     R$ 60.000 no trimestre;
//   - PIS 1,65% e COFINS 7,6% nao cumulativos: debito sobre a receita, credito
//     sobre as compras informadas.
// O que as notas nao dizem (devolucoes, receitas financeiras, ganhos de capital,
// retencoes da NFS-e nacional) entra como ajuste informado. Em 2026 a CBS e o
// IBS sao destacados em carater de teste e nao entram aqui.

export const ATIVIDADES = {
  comercio: { rotulo: "Comércio e indústria", irpj: 0.08, csll: 0.12 },
  servicos: { rotulo: "Serviços em geral", irpj: 0.32, csll: 0.32 },
  carga: { rotulo: "Transporte de cargas", irpj: 0.08, csll: 0.12 },
  passageiros: { rotulo: "Transporte de passageiros", irpj: 0.16, csll: 0.12 },
  hospitalar: { rotulo: "Serviços hospitalares", irpj: 0.08, csll: 0.12 },
  combustivel: { rotulo: "Revenda de combustíveis", irpj: 0.016, csll: 0.12 },
  servicosAte120: { rotulo: "Serviços (receita anual até R$ 120 mil)", irpj: 0.16, csll: 0.32 }
};

/** Atividade padrao da receita de cada documento emitido (a pessoa pode trocar). */
export const ATIVIDADE_DO_DOCUMENTO = { "NF-e": "comercio", "NFC-e": "comercio", "NFS-e": "servicos", "CT-e": "carga" };

export const LIMITE_ACRESCIMO_TRIMESTRE = 1_250_000;
const LIMITE_ADICIONAL_MES = 20_000;

const centavos = (valor) => Math.round((Number(valor) || 0) * 100) / 100;
const pct = (valor) => (Math.round(valor * 10000) / 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 }) + "%";
const brl = (valor) => "R$ " + centavos(valor).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "2026-T2" -> { ano: 2026, trimestre: 2, meses: ["2026-04","2026-05","2026-06"] } */
export function trimestre(periodo) {
  const m = /^(\d{4})-T([1-4])$/.exec(String(periodo || ""));
  if (!m) throw new Error("Periodo do trimestre invalido: use AAAA-T1 a AAAA-T4");
  const ano = Number(m[1]);
  const t = Number(m[2]);
  return { ano, trimestre: t, meses: [1, 2, 3].map((i) => ano + "-" + String((t - 1) * 3 + i).padStart(2, "0")) };
}

/** Trimestre da competencia AAAA-MM. */
export function trimestreDaCompetencia(competencia) {
  const [ano, mes] = String(competencia).split("-").map(Number);
  return ano + "-T" + Math.ceil(mes / 3);
}

/** Percentuais por atividade, com o que a pessoa trocou. */
function percentuaisDe(atividade, sobrescritos = {}) {
  const base = ATIVIDADES[atividade];
  if (!base) throw new Error("Atividade desconhecida: " + atividade);
  return { ...base, ...(sobrescritos[atividade] || {}) };
}

/**
 * Excedente do limite do acrescimo no trimestre, com a sobra dos trimestres
 * anteriores do ano e o ajuste do ultimo. receitasTrimestres: receita total de
 * cada trimestre do ano ate o atual (indice 0 = primeiro trimestre que conta).
 */
export function excedenteDoAcrescimo(receitasTrimestres) {
  let sobra = 0;
  let excedentesAntes = 0;
  const atual = receitasTrimestres.length - 1;
  for (let i = 0; i < atual; i += 1) {
    const limite = LIMITE_ACRESCIMO_TRIMESTRE + sobra;
    const receita = receitasTrimestres[i];
    excedentesAntes += Math.max(0, receita - limite);
    sobra = Math.max(0, limite - receita);
  }
  const limite = LIMITE_ACRESCIMO_TRIMESTRE + sobra;
  return { limite, excedente: Math.max(0, receitasTrimestres[atual] - limite), excedentesAntes };
}

/**
 * Lucro Presumido de um trimestre.
 * receitasPorAtividade: { comercio: valor, servicos: valor, ... } do trimestre.
 * receitasMensais: { "AAAA-MM": valor } dos tres meses (PIS e COFINS).
 * receitasTrimestresAnteriores: receita total de cada trimestre anterior do mesmo ano.
 */
export function apurarPresumido({ periodo, receitasPorAtividade, receitasMensais = {}, receitasTrimestresAnteriores = [],
  percentuais = {}, retencoes = {}, ajustes = {} }) {
  const { ano, trimestre: t, meses } = trimestre(periodo);
  const memoria = [];
  const atividades = Object.entries(receitasPorAtividade).filter(([, valor]) => Number(valor) > 0);
  const total = centavos(atividades.reduce((soma, [, valor]) => soma + Number(valor), 0) + (Number(ajustes.receita) || 0));
  memoria.push(["Receita bruta do trimestre", brl(total), "", ""]);

  // Acrescimo da LC 224: IRPJ desde o 1o trimestre de 2026, CSLL desde o 2o (abril).
  const anteriores = receitasTrimestresAnteriores.slice(0, t - 1);
  const excedentes = {
    irpj: ano >= 2026 ? excedenteDoAcrescimo([...anteriores, total]) : null,
    csll: ano >= 2027 ? excedenteDoAcrescimo([...anteriores, total])
      : ano === 2026 && t >= 2 ? excedenteDoAcrescimo([...anteriores.slice(1), total]) : null
  };

  const bases = { irpj: 0, csll: 0 };
  for (const [atividade, valorBruto] of atividades) {
    const valor = Number(valorBruto);
    const p = percentuaisDe(atividade, percentuais);
    for (const tributo of ["irpj", "csll"]) {
      const exc = excedentes[tributo];
      // O excedente e repartido entre as atividades na proporcao da receita de cada uma.
      const parteExcedente = exc && total > 0 ? valor * (exc.excedente / total) : 0;
      const base = (valor - parteExcedente) * p[tributo] + parteExcedente * p[tributo] * 1.1;
      bases[tributo] += base;
      memoria.push(["Base " + tributo.toUpperCase() + " · " + p.rotulo, brl(valor), pct(p[tributo]) +
        (parteExcedente ? " (+10% sobre " + brl(parteExcedente) + ")" : ""), brl(base)]);
    }
  }
  if (Number(ajustes.receita)) {
    memoria.push(["Ajuste de receita informado", brl(ajustes.receita), "sem presunção aqui", "-"]);
  }
  for (const tributo of ["irpj", "csll"]) {
    const exc = excedentes[tributo];
    if (exc) {
      memoria.push(["Limite do acréscimo (" + tributo.toUpperCase() + ")", brl(exc.limite),
        exc.excedente ? "excedente " + brl(exc.excedente) : "não passou", ""]);
    }
  }
  if (Number(ajustes.outrasReceitas)) {
    // Receitas financeiras, ganhos de capital: entram inteiras na base.
    bases.irpj += Number(ajustes.outrasReceitas);
    bases.csll += Number(ajustes.outrasReceitas);
    memoria.push(["Outras receitas (financeiras, ganhos)", brl(ajustes.outrasReceitas), "100%", brl(ajustes.outrasReceitas)]);
  }
  bases.irpj = centavos(bases.irpj);
  bases.csll = centavos(bases.csll);

  const irpjNormal = centavos(bases.irpj * 0.15);
  const adicional = centavos(Math.max(0, bases.irpj - LIMITE_ADICIONAL_MES * 3) * 0.10);
  const irpj = centavos(Math.max(0, irpjNormal + adicional - (Number(retencoes.irpj) || 0)));
  const csll = centavos(Math.max(0, bases.csll * 0.09 - (Number(retencoes.csll) || 0)));
  memoria.push(["IRPJ 15%", brl(bases.irpj), "15%", brl(irpjNormal)]);
  memoria.push(["Adicional do IRPJ", brl(Math.max(0, bases.irpj - 60_000)), "10% sobre o que passa de R$ 60.000", brl(adicional)]);
  if (Number(retencoes.irpj)) memoria.push(["IRPJ retido na fonte", "", "", "- " + brl(retencoes.irpj)]);
  memoria.push(["CSLL 9%", brl(bases.csll), "9%", brl(bases.csll * 0.09)]);
  if (Number(retencoes.csll)) memoria.push(["CSLL retida na fonte", "", "", "- " + brl(retencoes.csll)]);

  const mensal = meses.map((competencia) => {
    const receita = Number(receitasMensais[competencia]) || 0;
    return { competencia, receita: centavos(receita), pis: centavos(receita * 0.0065), cofins: centavos(receita * 0.03) };
  });
  const pis = centavos(Math.max(0, mensal.reduce((s, m) => s + m.pis, 0) - (Number(retencoes.pis) || 0)));
  const cofins = centavos(Math.max(0, mensal.reduce((s, m) => s + m.cofins, 0) - (Number(retencoes.cofins) || 0)));
  for (const m of mensal) memoria.push(["PIS 0,65% e COFINS 3% · " + m.competencia.slice(5) + "/" + m.competencia.slice(0, 4),
    brl(m.receita), "0,65% e 3%", brl(m.pis) + " e " + brl(m.cofins)]);

  if (t === 4 && excedentes.irpj && excedentes.irpj.excedentesAntes > 0) {
    const anual = [...anteriores, total].reduce((s, v) => s + v, 0);
    if (anual <= LIMITE_ACRESCIMO_TRIMESTRE * 4) {
      memoria.push(["Ajuste anual do acréscimo", brl(anual), "receita do ano abaixo de R$ 5 milhões",
        "recalcule os trimestres anteriores: o acréscimo pago neles é deduzido agora"]);
    }
  }

  return {
    regime: "presumido", periodo, ano, trimestre: t, receita: total, bases,
    tributos: { irpj, adicionalIrpj: adicional, csll, pis, cofins },
    total: centavos(irpj + csll + pis + cofins), mensal, memoria,
    vencimentos: {
      irpjCsll: "último dia útil de " + mesSeguinte(meses[2]) + " (cota única ou 1ª de 3)",
      pisCofins: "dia 25 do mês seguinte a cada competência"
    }
  };
}

function mesSeguinte(competencia) {
  const [ano, mes] = competencia.split("-").map(Number);
  const data = new Date(Date.UTC(ano, mes, 1));
  return String(data.getUTCMonth() + 1).padStart(2, "0") + "/" + data.getUTCFullYear();
}

/** PIS e COFINS nao cumulativos de um mes: debito sobre a receita, credito sobre as compras. */
function pisCofinsNaoCumulativo(receita, compras, creditoAnterior = { pis: 0, cofins: 0 }) {
  const debito = { pis: receita * 0.0165, cofins: receita * 0.076 };
  const credito = { pis: compras * 0.0165 + (creditoAnterior.pis || 0), cofins: compras * 0.076 + (creditoAnterior.cofins || 0) };
  return {
    debito: { pis: centavos(debito.pis), cofins: centavos(debito.cofins) },
    credito: { pis: centavos(credito.pis), cofins: centavos(credito.cofins) },
    aPagar: { pis: centavos(Math.max(0, debito.pis - credito.pis)), cofins: centavos(Math.max(0, debito.cofins - credito.cofins)) },
    creditoQueSobra: { pis: centavos(Math.max(0, credito.pis - debito.pis)), cofins: centavos(Math.max(0, credito.cofins - debito.cofins)) }
  };
}

/**
 * Lucro Real por estimativa mensal (sobre a receita bruta do mes).
 */
export function apurarRealEstimativa({ competencia, receitasPorAtividade, compras = 0, percentuais = {}, retencoes = {},
  creditoAnterior = { pis: 0, cofins: 0 }, ajustes = {} }) {
  if (!/^\d{4}-\d{2}$/.test(String(competencia))) throw new Error("Competencia invalida: use AAAA-MM");
  const memoria = [];
  const atividades = Object.entries(receitasPorAtividade).filter(([, valor]) => Number(valor) > 0);
  const receita = centavos(atividades.reduce((s, [, v]) => s + Number(v), 0) + (Number(ajustes.receita) || 0));
  memoria.push(["Receita bruta do mês", brl(receita), "", ""]);
  const bases = { irpj: 0, csll: 0 };
  for (const [atividade, valor] of atividades) {
    const p = percentuaisDe(atividade, percentuais);
    bases.irpj += Number(valor) * p.irpj;
    bases.csll += Number(valor) * p.csll;
    memoria.push(["Base estimada · " + p.rotulo, brl(valor), pct(p.irpj) + " IRPJ · " + pct(p.csll) + " CSLL",
      brl(Number(valor) * p.irpj) + " · " + brl(Number(valor) * p.csll)]);
  }
  bases.irpj = centavos(bases.irpj + (Number(ajustes.outrasReceitas) || 0));
  bases.csll = centavos(bases.csll + (Number(ajustes.outrasReceitas) || 0));
  const irpjNormal = centavos(bases.irpj * 0.15);
  const adicional = centavos(Math.max(0, bases.irpj - LIMITE_ADICIONAL_MES) * 0.10);
  const irpj = centavos(Math.max(0, irpjNormal + adicional - (Number(retencoes.irpj) || 0)));
  const csll = centavos(Math.max(0, bases.csll * 0.09 - (Number(retencoes.csll) || 0)));
  memoria.push(["IRPJ 15% (estimativa)", brl(bases.irpj), "15%", brl(irpjNormal)]);
  memoria.push(["Adicional do IRPJ", brl(Math.max(0, bases.irpj - LIMITE_ADICIONAL_MES)), "10% sobre o que passa de R$ 20.000", brl(adicional)]);
  memoria.push(["CSLL 9% (estimativa)", brl(bases.csll), "9%", brl(bases.csll * 0.09)]);
  const pc = pisCofinsNaoCumulativo(receita, Number(compras) || 0, creditoAnterior);
  memoria.push(["PIS 1,65% e COFINS 7,6% · débito", brl(receita), "1,65% e 7,6%", brl(pc.debito.pis) + " e " + brl(pc.debito.cofins)]);
  memoria.push(["Crédito sobre compras", brl(compras), "1,65% e 7,6%", brl(pc.credito.pis) + " e " + brl(pc.credito.cofins)]);
  const pis = centavos(Math.max(0, pc.aPagar.pis - (Number(retencoes.pis) || 0)));
  const cofins = centavos(Math.max(0, pc.aPagar.cofins - (Number(retencoes.cofins) || 0)));
  return {
    regime: "real-estimativa", periodo: competencia, receita, bases, compras: centavos(compras),
    tributos: { irpj, adicionalIrpj: adicional, csll, pis, cofins }, creditoQueSobra: pc.creditoQueSobra,
    total: centavos(irpj + csll + pis + cofins), memoria,
    vencimentos: { irpjCsll: "último dia útil do mês seguinte", pisCofins: "dia 25 do mês seguinte" }
  };
}

/**
 * Lucro Real trimestral, sobre o lucro contabil informado.
 */
export function apurarRealTrimestral({ periodo, lucroContabil, adicoes = 0, exclusoes = 0, prejuizoACompensar = 0,
  baseNegativaCsll = 0, receitasMensais = {}, comprasMensais = {}, retencoes = {} }) {
  const { meses } = trimestre(periodo);
  if (lucroContabil === undefined || lucroContabil === null || lucroContabil === "") {
    throw new Error("Informe o lucro contabil do trimestre (antes do IRPJ e da CSLL)");
  }
  const memoria = [];
  const ajustado = centavos(Number(lucroContabil) + Number(adicoes || 0) - Number(exclusoes || 0));
  memoria.push(["Lucro contábil antes do IRPJ e da CSLL", brl(lucroContabil), "", ""]);
  memoria.push(["(+) Adições", brl(adicoes), "", ""], ["(-) Exclusões", brl(exclusoes), "", ""]);
  memoria.push(["Lucro ajustado", brl(ajustado), "", ""]);
  const limite30 = Math.max(0, ajustado) * 0.30;
  const compensadoIrpj = centavos(Math.min(Number(prejuizoACompensar) || 0, limite30));
  const compensadoCsll = centavos(Math.min(Number(baseNegativaCsll) || 0, limite30));
  const baseIrpj = centavos(Math.max(0, ajustado - compensadoIrpj));
  const baseCsll = centavos(Math.max(0, ajustado - compensadoCsll));
  if (compensadoIrpj) memoria.push(["Prejuízo fiscal compensado (até 30%)", brl(prejuizoACompensar), "limite " + brl(limite30), "- " + brl(compensadoIrpj)]);
  if (compensadoCsll) memoria.push(["Base negativa da CSLL compensada (até 30%)", brl(baseNegativaCsll), "limite " + brl(limite30), "- " + brl(compensadoCsll)]);
  const irpjNormal = centavos(baseIrpj * 0.15);
  const adicional = centavos(Math.max(0, baseIrpj - LIMITE_ADICIONAL_MES * 3) * 0.10);
  const irpj = centavos(Math.max(0, irpjNormal + adicional - (Number(retencoes.irpj) || 0)));
  const csll = centavos(Math.max(0, baseCsll * 0.09 - (Number(retencoes.csll) || 0)));
  memoria.push(["Lucro real (base do IRPJ)", brl(baseIrpj), "15%", brl(irpjNormal)]);
  memoria.push(["Adicional do IRPJ", brl(Math.max(0, baseIrpj - 60_000)), "10% sobre o que passa de R$ 60.000", brl(adicional)]);
  memoria.push(["Base da CSLL", brl(baseCsll), "9%", brl(baseCsll * 0.09)]);
  let credito = { pis: 0, cofins: 0 };
  const mensal = meses.map((competencia) => {
    const receita = Number(receitasMensais[competencia]) || 0;
    const compras = Number(comprasMensais[competencia]) || 0;
    const pc = pisCofinsNaoCumulativo(receita, compras, credito);
    credito = pc.creditoQueSobra;
    memoria.push(["PIS e COFINS não cumulativos · " + competencia.slice(5) + "/" + competencia.slice(0, 4),
      brl(receita) + " receita · " + brl(compras) + " compras", "1,65% e 7,6%", brl(pc.aPagar.pis) + " e " + brl(pc.aPagar.cofins)]);
    return { competencia, receita: centavos(receita), compras: centavos(compras), pis: pc.aPagar.pis, cofins: pc.aPagar.cofins };
  });
  const pis = centavos(Math.max(0, mensal.reduce((s, m) => s + m.pis, 0) - (Number(retencoes.pis) || 0)));
  const cofins = centavos(Math.max(0, mensal.reduce((s, m) => s + m.cofins, 0) - (Number(retencoes.cofins) || 0)));
  return {
    regime: "real-trimestral", periodo, lucroAjustado: ajustado, bases: { irpj: baseIrpj, csll: baseCsll },
    tributos: { irpj, adicionalIrpj: adicional, csll, pis, cofins }, creditoQueSobra: credito, mensal,
    total: centavos(irpj + csll + pis + cofins), memoria,
    vencimentos: { irpjCsll: "último dia útil do mês seguinte ao trimestre", pisCofins: "dia 25 do mês seguinte" }
  };
}
