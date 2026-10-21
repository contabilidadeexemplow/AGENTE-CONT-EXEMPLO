// Motor de conferencia fiscal.
// Recalcula o que o XML declara e aponta divergencia com memoria de calculo.
// Cada achado traz: o que era esperado, o que veio, a conta e a base normativa.
//
// Tolerancia: o layout da NF-e usa 2 casas por item, entao diferenca de
// arredondamento de 1 centavo por item nao e divergencia.

import { validarChave, lerChave } from "./documentos.mjs";

const CENTAVO = 0.011;

// CST de PIS/COFINS sem incidencia, aliquota zero, isencao ou suspensao: nao
// pode haver valor (IN RFB 1.009/2010, tabelas I e II). Os CST 49 e 99
// ("outras operacoes") NAO estao aqui: neles o valor e permitido.
const CST_SEM_TRIBUTO = new Set(["04", "05", "06", "07", "08", "09"]);
// CST de PIS/COFINS tributados por aliquota percentual: vBC x p / 100.
const CST_POR_ALIQUOTA = new Set(["01", "02"]);
// CST 03: tributado por unidade de produto: qBCProd x vAliqProd (em reais).
const CST_POR_QUANTIDADE = new Set(["03"]);
// CST de ICMS que indicam substituicao tributaria.
const CST_ICMS_ST = new Set(["10", "30", "60", "70"]);
const CSOSN_ST = new Set(["201", "202", "203", "500"]);
// CSOSN em que o proprio optante do Simples cobra a ST.
const CSOSN_ST_DO_OPTANTE = new Set(["201", "202", "203"]);
// CSOSN validos para optante do Simples (Ajuste SINIEF 07/05, Anexo).
const CSOSN_VALIDOS = new Set(["101", "102", "103", "201", "202", "203", "300", "400", "500", "900"]);
// CFOP que declaram mercadoria com ST ja recolhida.
const CFOP_ST_RECOLHIDA = new Set(["5405", "6404", "5656", "6656", "5667"]);

function round(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function soma(list, pick) {
  return round(list.reduce((total, item) => total + (Number(pick(item)) || 0), 0));
}

function achado(base) {
  return {
    severity: "atencao",
    scope: "documento",
    item: null,
    expected: null,
    found: null,
    difference: null,
    basis: "",
    rule: "",
    ...base
  };
}

function divergeValor({ code, severity, scope, item, title, expected, found, basis, rule, tolerance = CENTAVO }) {
  const esperado = round(expected);
  const encontrado = round(found);
  if (Math.abs(esperado - encontrado) <= tolerance) return null;
  return achado({
    code, severity, scope, item, title,
    expected: esperado,
    found: encontrado,
    difference: round(encontrado - esperado),
    basis, rule
  });
}

// ------------------------------------------------------------------ NF-e

// Operacao fiscal da nota pelo tpNF do proprio XML (0 entrada, 1 saida). Nunca
// pela "operation" gravada: a captura grava ali a visao da empresa da carteira
// (recebida = entrada), e a nota de entrada emitida pela propria empresa
// (devolucao, importacao) e "emitida" mas e de entrada. Documento gravado antes
// de o tpNF ser extraido devolve null: a conferencia do CFOP x operacao nao acusa.
function operacaoDoXml(documento) {
  if (documento.tpNF === "0") return "entrada";
  if (documento.tpNF === "1") return "saida";
  return null;
}

// CSOSN e do Simples (CRT 1) e do MEI (CRT 4). O CRT 2 (Simples com excesso de
// sublimite) usa CST, como o regime normal.
function usaCsosn(crt) {
  return crt === "1" || crt === "4";
}

function conferirItemTributo(item, sigla, campo, dispositivo) {
  const grupo = item[campo];
  const achados = [];

  // Documento gravado antes de qBCProd e vAliqProd serem extraidos nao tem o que
  // recalcular no CST 03: a conferencia nao acusa.
  const temQuantidade = Number.isFinite(grupo.quantityBase) && Number.isFinite(grupo.unitRate);
  if (CST_POR_QUANTIDADE.has(grupo.cst) && temQuantidade) {
    const esperado = grupo.quantityBase * grupo.unitRate;
    const valor = divergeValor({
      code: sigla + "_VALOR",
      severity: "critico",
      scope: "item",
      item: item.n,
      title: sigla + " por unidade diverge do recalculo",
      expected: esperado,
      found: grupo.value,
      basis: "qBCProd " + grupo.quantityBase.toFixed(4) + " x vAliqProd " + grupo.unitRate.toFixed(4) +
        " = " + round(esperado).toFixed(2),
      rule: dispositivo
    });
    if (valor) achados.push(valor);
  }

  if (CST_POR_ALIQUOTA.has(grupo.cst)) {
    const esperado = (grupo.base * grupo.rate) / 100;
    const valor = divergeValor({
      code: sigla + "_VALOR",
      severity: "critico",
      scope: "item",
      item: item.n,
      title: sigla + " destacado diverge do recalculo",
      expected: esperado,
      found: grupo.value,
      basis: "vBC " + grupo.base.toFixed(2) + " x p" + sigla + " " + grupo.rate.toFixed(4) + "% = " + round(esperado).toFixed(2),
      rule: dispositivo
    });
    if (valor) achados.push(valor);

    if (grupo.rate === 0) {
      achados.push(achado({
        code: sigla + "_ALIQUOTA_ZERADA",
        severity: "atencao",
        scope: "item",
        item: item.n,
        title: "CST " + grupo.cst + " e tributado, mas a aliquota de " + sigla + " esta zerada",
        basis: "CST " + grupo.cst + " exige aliquota positiva",
        rule: dispositivo
      }));
    }
  }

  if (CST_SEM_TRIBUTO.has(grupo.cst) && grupo.value > CENTAVO) {
    achados.push(achado({
      code: sigla + "_CST_INCOERENTE",
      severity: "critico",
      scope: "item",
      item: item.n,
      title: "CST " + grupo.cst + " nao tributa " + sigla + ", mas ha valor destacado",
      expected: 0,
      found: round(grupo.value),
      difference: round(grupo.value),
      basis: "CST " + grupo.cst + " classifica a operacao como sem incidencia, aliquota zero, isencao ou suspensao",
      rule: dispositivo
    }));
  }

  return achados;
}

function conferirItem(item, documento, regras) {
  const achados = [];
  const crt = documento.emitter?.crt || "";
  const simples = usaCsosn(crt);
  const operacao = operacaoDoXml(documento);

  // --- quantidade x preco unitario x total do item
  const totalCalculado = item.quantity * item.unitPrice;
  const totalItem = divergeValor({
    code: "ITEM_TOTAL",
    severity: "critico",
    scope: "item",
    item: item.n,
    title: "Valor do item diverge de quantidade x unitario",
    expected: totalCalculado,
    found: item.total,
    basis: "qCom " + item.quantity + " x vUnCom " + item.unitPrice.toFixed(2) + " = " + round(totalCalculado).toFixed(2),
    rule: "Manual de Orientacao do Contribuinte, campo vProd"
  });
  if (totalItem) achados.push(totalItem);

  // --- PIS e COFINS
  achados.push(...conferirItemTributo(item, "PIS", "pis", "Lei 10.637/2002, art. 2 e IN RFB 1.009/2010"));
  achados.push(...conferirItemTributo(item, "COFINS", "cofins", "Lei 10.833/2003, art. 2 e IN RFB 1.009/2010"));

  // --- ICMS proprio
  if (item.icms.rate > 0 || item.icms.value > 0) {
    const esperado = (item.icms.base * item.icms.rate) / 100;
    const icms = divergeValor({
      code: "ICMS_VALOR",
      severity: "critico",
      scope: "item",
      item: item.n,
      title: "ICMS destacado diverge do recalculo",
      expected: esperado,
      found: item.icms.value,
      basis: "vBC " + item.icms.base.toFixed(2) + " x pICMS " + item.icms.rate.toFixed(2) + "% = " + round(esperado).toFixed(2),
      rule: "LC 87/1996, art. 13 e Ajuste SINIEF 07/05"
    });
    if (icms) achados.push(icms);
  }

  // --- ICMS-ST
  // Emitente do Simples (CRT 1 ou 4) ou item com CSOSN 201, 202 ou 203: o ICMS
  // proprio que a conta deduz nao vem destacado no XML (o optante recolhe no
  // DAS), e recalcular acusaria toda nota com ST. A ST desses itens nao e
  // recalculada. O CRT 2 usa CST e destaca o ICMS proprio: e recalculado.
  const stDoOptante = simples || CSOSN_ST_DO_OPTANTE.has(item.icms.csosn);
  if (item.icms.stBase > 0 && !stDoOptante) {
    const esperado = (item.icms.stBase * item.icms.stRate) / 100 - item.icms.value;
    const st = divergeValor({
      code: "ICMS_ST_VALOR",
      severity: "critico",
      scope: "item",
      item: item.n,
      title: "ICMS-ST destacado diverge do recalculo",
      expected: esperado,
      found: item.icms.stValue,
      basis: "vBCST " + item.icms.stBase.toFixed(2) + " x pICMSST " + item.icms.stRate.toFixed(2) +
        "% - vICMS " + item.icms.value.toFixed(2) + " = " + round(esperado).toFixed(2),
      rule: "LC 87/1996, art. 8 e Convenio ICMS 142/2018"
    });
    if (st) achados.push(st);
  }

  // --- NCM
  if (!/^\d{8}$/.test(item.ncm)) {
    achados.push(achado({
      code: "NCM_FORMATO",
      severity: "critico",
      scope: "item",
      item: item.n,
      title: "NCM invalido: " + (item.ncm || "ausente"),
      expected: "8 digitos",
      found: item.ncm ? item.ncm.length + " digitos" : "ausente",
      basis: "NCM precisa ter exatamente 8 digitos numericos",
      rule: "Tabela TIPI e layout NF-e 4.00, campo NCM"
    }));
  }

  // --- CFOP
  if (!/^\d{4}$/.test(item.cfop)) {
    achados.push(achado({
      code: "CFOP_FORMATO",
      severity: "critico",
      scope: "item",
      item: item.n,
      title: "CFOP invalido: " + (item.cfop || "ausente"),
      basis: "CFOP precisa ter 4 digitos",
      rule: "Convenio SINIEF s/n 1970, Anexo CFOP"
    }));
  } else {
    const grupo = item.cfop[0];
    const esperadoSaida = ["5", "6", "7"].includes(grupo);
    if (operacao === "saida" && !esperadoSaida) {
      achados.push(achado({
        code: "CFOP_OPERACAO",
        severity: "critico",
        scope: "item",
        item: item.n,
        title: "CFOP de entrada (" + item.cfop + ") em nota de saida",
        expected: "CFOP iniciando em 5, 6 ou 7",
        found: item.cfop,
        basis: "tpNF=1 (saida) exige CFOP do grupo 5000, 6000 ou 7000",
        rule: "Convenio SINIEF s/n 1970, Anexo CFOP"
      }));
    }
    if (operacao === "entrada" && esperadoSaida) {
      achados.push(achado({
        code: "CFOP_OPERACAO",
        severity: "critico",
        scope: "item",
        item: item.n,
        title: "CFOP de saida (" + item.cfop + ") em nota de entrada",
        expected: "CFOP iniciando em 1, 2 ou 3",
        found: item.cfop,
        basis: "tpNF=0 (entrada) exige CFOP do grupo 1000, 2000 ou 3000",
        rule: "Convenio SINIEF s/n 1970, Anexo CFOP"
      }));
    }
    if (CFOP_ST_RECOLHIDA.has(item.cfop)) {
      const temSt = CST_ICMS_ST.has(item.icms.cst) || CSOSN_ST.has(item.icms.csosn);
      if (!temSt) {
        achados.push(achado({
          code: "CFOP_CST_ST",
          severity: "atencao",
          scope: "item",
          item: item.n,
          title: "CFOP " + item.cfop + " indica ST recolhida, mas o CST/CSOSN nao",
          expected: "CST 60 ou CSOSN 500",
          found: item.icms.cst || item.icms.csosn || "ausente",
          basis: "CFOP de mercadoria com ST ja recolhida pressupoe CST 60 ou CSOSN 500",
          rule: "Convenio ICMS 142/2018 e Ajuste SINIEF 07/05"
        }));
      }
    }
  }

  // --- regime x codigo de tributacao do ICMS
  // CRT 1 (Simples) e 4 (MEI) usam CSOSN; CRT 2 (Simples com excesso de
  // sublimite) e 3 (regime normal) usam CST. Sem CRT no XML, nao acusa.
  if (simples && item.icms.cst && !item.icms.csosn) {
    achados.push(achado({
      code: "REGIME_CSOSN",
      severity: "critico",
      scope: "item",
      item: item.n,
      title: "Emitente do Simples usando CST " + item.icms.cst + " em vez de CSOSN",
      expected: "CSOSN",
      found: "CST " + item.icms.cst,
      basis: "CRT=" + crt + (crt === "4" ? " identifica MEI, que usa CSOSN" : " identifica optante do Simples Nacional"),
      rule: "Ajuste SINIEF 07/05, Anexo, codigo de situacao da operacao no Simples"
    }));
  }
  if (crt && !simples && item.icms.csosn && !item.icms.cst) {
    achados.push(achado({
      code: "REGIME_CST",
      severity: "critico",
      scope: "item",
      item: item.n,
      title: crt === "2"
        ? "Emitente do Simples com excesso de sublimite usando CSOSN " + item.icms.csosn + " em vez de CST"
        : "Emitente do regime normal usando CSOSN " + item.icms.csosn,
      expected: "CST",
      found: "CSOSN " + item.icms.csosn,
      basis: crt === "2"
        ? "CRT=2 (Simples com excesso de sublimite) apura o ICMS pelo regime normal e usa CST"
        : "CRT=" + crt + " identifica regime normal",
      rule: "Ajuste SINIEF 07/05, Anexo"
    }));
  }
  if (item.icms.csosn && !CSOSN_VALIDOS.has(item.icms.csosn)) {
    achados.push(achado({
      code: "CSOSN_INVALIDO",
      severity: "critico",
      scope: "item",
      item: item.n,
      title: "CSOSN " + item.icms.csosn + " nao existe na tabela",
      basis: "Valores aceitos: " + [...CSOSN_VALIDOS].join(", "),
      rule: "Ajuste SINIEF 07/05, Anexo"
    }));
  }

  // --- CEST obrigatorio quando ha ST
  const indicaSt = CST_ICMS_ST.has(item.icms.cst) || CSOSN_ST.has(item.icms.csosn);
  if (indicaSt && !item.cest) {
    achados.push(achado({
      code: "CEST_AUSENTE",
      severity: "atencao",
      scope: "item",
      item: item.n,
      title: "Operacao com ST sem CEST informado",
      basis: "CST/CSOSN " + (item.icms.cst || item.icms.csosn) + " indica substituicao tributaria",
      rule: "Convenio ICMS 142/2018, art. 1, par. 1"
    }));
  }

  // --- regras cadastradas pelo escritorio
  for (const regra of regras) {
    if (regra.status !== "Ativa") continue;
    const alvo = String(regra.key || "").replace(/\D/g, "");
    if (!alvo || alvo !== item.ncm) continue;
    if (regra.expectedRate === undefined || regra.expectedRate === null) continue;
    const campo = regra.type === "PIS/COFINS" ? "pis" : regra.type === "ICMS" ? "icms" : null;
    if (!campo) continue;
    // CST 03 e por unidade (qBCProd x vAliqProd): nao tem aliquota percentual para comparar com a regra.
    if (campo === "pis" && item.pis.cst === "03") continue;
    const encontrada = item[campo].rate;
    if (Math.abs(Number(regra.expectedRate) - encontrada) > 0.0001) {
      achados.push(achado({
        code: "REGRA_CADASTRADA",
        severity: "atencao",
        scope: "item",
        item: item.n,
        title: "Aliquota divergente da regra " + regra.key,
        expected: Number(regra.expectedRate),
        found: encontrada,
        difference: round(encontrada - Number(regra.expectedRate)),
        basis: "Regra interna do escritorio: " + regra.description,
        rule: "Parametrizacao " + regra.id
      }));
    }
  }

  return achados;
}

function conferirTotais(documento) {
  const achados = [];
  const itens = documento.items;
  const tolerancia = Math.max(CENTAVO, itens.length * CENTAVO);

  const checagens = [
    ["TOTAL_PRODUTOS", "Soma dos itens diverge do total de produtos", soma(itens, (i) => i.total), documento.totals.products, "Soma de vProd dos itens", "critico"],
    ["TOTAL_ICMS", "Soma do ICMS dos itens diverge do total", soma(itens, (i) => i.icms.value), documento.totals.icms, "Soma de vICMS dos itens", "atencao"],
    ["TOTAL_PIS", "Soma do PIS dos itens diverge do total", soma(itens, (i) => i.pis.value), documento.totals.pis, "Soma de vPIS dos itens", "atencao"],
    ["TOTAL_COFINS", "Soma do COFINS dos itens diverge do total", soma(itens, (i) => i.cofins.value), documento.totals.cofins, "Soma de vCOFINS dos itens", "atencao"],
    ["TOTAL_ST", "Soma do ICMS-ST dos itens diverge do total", soma(itens, (i) => i.icms.stValue), documento.totals.st, "Soma de vICMSST dos itens", "atencao"]
  ];

  for (const [code, title, esperado, declarado, conta, severity] of checagens) {
    const item = divergeValor({
      code, severity, title,
      expected: esperado,
      found: declarado,
      basis: conta + " = " + esperado.toFixed(2) + ", total declarado = " + round(declarado).toFixed(2),
      rule: "Layout NF-e 4.00, grupo W (total)",
      tolerance: tolerancia
    });
    if (item) achados.push(item);
  }

  // --- valor da nota: vProd - vDesc + vST + vFCPST + vFrete + vSeg + vOutro + vII + vIPI + vIPIDevol.
  // O ICMS desonerado pode ser deduzido do total (NT 2023.004): fechar com ele deduzido tambem vale.
  // Documento gravado antes de vFCPST, vII, vIPIDevol e vICMSDeson serem lidos conta zero neles.
  const t = documento.totals;
  const v = (campo) => Number(t[campo]) || 0;
  const esperadoNota = v("products") - v("discount") + v("st") + v("fcpSt") + v("freight") + v("insurance") + v("other") +
    v("ii") + v("ipi") + v("ipiDevol");
  const fechaComDesoneracao = v("icmsDeson") > 0 && Math.abs(round(esperadoNota - v("icmsDeson")) - round(v("invoice"))) <= tolerancia;
  const nota = fechaComDesoneracao ? null : divergeValor({
    code: "TOTAL_NOTA",
    severity: "critico",
    title: "Valor total da nota nao fecha com a composicao",
    expected: esperadoNota,
    found: v("invoice"),
    basis: "vProd " + v("products").toFixed(2) + " - vDesc " + v("discount").toFixed(2) + " + vST " + v("st").toFixed(2) +
      " + vFCPST " + v("fcpSt").toFixed(2) + " + vFrete " + v("freight").toFixed(2) + " + vSeg " + v("insurance").toFixed(2) +
      " + vOutro " + v("other").toFixed(2) + " + vII " + v("ii").toFixed(2) + " + vIPI " + v("ipi").toFixed(2) +
      " + vIPIDevol " + v("ipiDevol").toFixed(2) + " = " + round(esperadoNota).toFixed(2) +
      (v("icmsDeson") ? " (com vICMSDeson " + v("icmsDeson").toFixed(2) + " deduzido: " + round(esperadoNota - v("icmsDeson")).toFixed(2) + ")" : ""),
    rule: "Layout NF-e 4.00, campo vNF; NT 2023.004 (ICMS desonerado)",
    tolerance: tolerancia
  });
  if (nota) achados.push(nota);

  return achados;
}

// CT-e: chave e coerencia dos valores da prestacao. A tributacao do frete
// (ICMS por UF de inicio e fim, substituicao) nao e conferida aqui.
function conferirCte(documento) {
  const achados = conferirChave(documento);
  const t = documento.totals || {};
  if ((t.received || 0) > (t.invoice || 0) + CENTAVO) {
    achados.push(achado({
      code: "CTE_VALOR_RECEBER",
      severity: "atencao",
      title: "Valor a receber maior que o valor total da prestacao",
      expected: round(t.invoice || 0),
      found: round(t.received || 0),
      difference: round((t.received || 0) - (t.invoice || 0)),
      basis: "vRec " + round(t.received || 0).toFixed(2) + " > vTPrest " + round(t.invoice || 0).toFixed(2),
      rule: "Layout CT-e 4.00, grupo vPrest"
    }));
  }
  if ((t.icmsBase || 0) > (t.invoice || 0) + CENTAVO) {
    achados.push(achado({
      code: "CTE_BASE_ICMS",
      severity: "atencao",
      title: "Base de calculo do ICMS maior que o valor da prestacao",
      expected: round(t.invoice || 0),
      found: round(t.icmsBase || 0),
      difference: round((t.icmsBase || 0) - (t.invoice || 0)),
      basis: "vBC " + round(t.icmsBase || 0).toFixed(2) + " > vTPrest " + round(t.invoice || 0).toFixed(2),
      rule: "Layout CT-e 4.00, grupo imp"
    }));
  }
  return achados;
}

function conferirChave(documento) {
  const achados = [];
  const chave = documento.key;
  if (!chave) return achados;

  const validacao = validarChave(chave);
  if (!validacao.valid) {
    achados.push(achado({
      code: "CHAVE_DV",
      severity: "critico",
      title: "Chave de acesso invalida",
      found: chave,
      basis: validacao.reason,
      rule: "NT 2003/003, calculo do DV por modulo 11"
    }));
    return achados;
  }

  const partes = lerChave(chave);
  const conflitos = [];
  if (documento.emitter.cnpj && partes.cnpj !== documento.emitter.cnpj) {
    conflitos.push("CNPJ na chave " + partes.cnpj + " x emitente " + documento.emitter.cnpj);
  }
  if (documento.number && Number(partes.numero) !== Number(documento.number)) {
    conflitos.push("numero na chave " + Number(partes.numero) + " x nNF " + documento.number);
  }
  if (documento.series && Number(partes.serie) !== Number(documento.series)) {
    conflitos.push("serie na chave " + Number(partes.serie) + " x serie " + documento.series);
  }
  if (documento.model && partes.modelo !== documento.model) {
    conflitos.push("modelo na chave " + partes.modelo + " x mod " + documento.model);
  }
  if (documento.issuedAt) {
    const [ano, mes] = documento.issuedAt.split("-");
    if (partes.ano !== ano.slice(2) || partes.mes !== mes) {
      conflitos.push("competencia na chave " + partes.mes + "/" + partes.ano + " x emissao " + mes + "/" + ano.slice(2));
    }
  }

  if (conflitos.length) {
    achados.push(achado({
      code: "CHAVE_COERENCIA",
      severity: "critico",
      title: "Chave de acesso nao corresponde ao conteudo da nota",
      basis: conflitos.join("; "),
      rule: "NT 2003/003, composicao da chave de acesso"
    }));
  }

  return achados;
}

// ------------------------------------------------------------------ NFS-e

function conferirNfse(documento) {
  const achados = [];
  const s = documento.service;

  const baseEsperada = s.gross - s.deductions;
  const base = divergeValor({
    code: "ISS_BASE",
    severity: "critico",
    title: "Base de calculo do ISS diverge de servicos menos deducoes",
    expected: baseEsperada,
    found: s.base,
    basis: "ValorServicos " + s.gross.toFixed(2) + " - ValorDeducoes " + s.deductions.toFixed(2) +
      " = " + round(baseEsperada).toFixed(2),
    rule: "LC 116/2003, art. 7"
  });
  if (base) achados.push(base);

  if (s.rate > 0) {
    const esperado = (s.base * s.rate) / 100;
    const iss = divergeValor({
      code: "ISS_VALOR",
      severity: "critico",
      title: "ISS destacado diverge do recalculo",
      expected: esperado,
      found: s.iss,
      basis: "BaseCalculo " + s.base.toFixed(2) + " x Aliquota " + s.rate.toFixed(2) + "% = " + round(esperado).toFixed(2),
      rule: "LC 116/2003, art. 7 e art. 8"
    });
    if (iss) achados.push(iss);

    if (s.rate > 5.0001) {
      achados.push(achado({
        code: "ISS_ALIQUOTA_TETO",
        severity: "critico",
        title: "Aliquota de ISS acima do teto de 5%",
        expected: 5,
        found: s.rate,
        difference: round(s.rate - 5),
        basis: "Aliquota informada: " + s.rate.toFixed(2) + "%",
        rule: "LC 116/2003, art. 8, II"
      }));
    }
    if (s.rate < 1.9999) {
      achados.push(achado({
        code: "ISS_ALIQUOTA_PISO",
        severity: "atencao",
        title: "Aliquota de ISS abaixo do piso de 2%",
        expected: 2,
        found: s.rate,
        difference: round(s.rate - 2),
        basis: "Aliquota informada: " + s.rate.toFixed(2) + "%",
        rule: "CF art. 156, par. 3, III e LC 116/2003, art. 8-A"
      }));
    }
  } else if (s.iss > CENTAVO) {
    achados.push(achado({
      code: "ISS_SEM_ALIQUOTA",
      severity: "atencao",
      title: "ISS destacado sem aliquota informada",
      found: round(s.iss),
      basis: "ValorIss " + s.iss.toFixed(2) + " com Aliquota 0",
      rule: "LC 116/2003, art. 7"
    }));
  }

  if (s.issWithheld && s.withheldValue <= CENTAVO) {
    achados.push(achado({
      code: "ISS_RETENCAO_SEM_VALOR",
      severity: "critico",
      title: "Nota marcada como ISS retido, mas sem valor retido destacado",
      expected: round((s.base * s.rate) / 100),
      found: round(s.withheldValue),
      basis: "IssRetido = sim e ValorIssRetido = " + s.withheldValue.toFixed(2),
      rule: "LC 116/2003, art. 6 (responsabilidade do tomador)"
    }));
  }

  if (!s.code) {
    achados.push(achado({
      code: "ISS_SEM_ITEM_LISTA",
      severity: "atencao",
      title: "Servico sem codigo da lista da LC 116",
      basis: "ItemListaServico ausente",
      rule: "LC 116/2003, lista anexa"
    }));
  }

  return achados;
}

// ------------------------------------------------------------------ fachada

/**
 * Confere um documento normalizado.
 * `regras` sao as parametrizacoes do escritorio (opcional).
 * Retorna { documentKey, kind, findings, summary }.
 */
export function conferir(documento, regras = []) {
  const achados = [];

  if (documento.kind === "Evento") {
    return { documentKey: documento.key, kind: documento.kind, findings: [], summary: resumo([]) };
  }

  if (documento.protocol && documento.protocol.status && documento.protocol.status !== "100") {
    achados.push(achado({
      code: "DOC_NAO_AUTORIZADO",
      severity: "critico",
      title: "Documento sem autorizacao de uso",
      found: documento.protocol.status,
      basis: documento.protocol.reason || "cStat " + documento.protocol.status,
      rule: "Manual de Orientacao do Contribuinte, codigos de status"
    }));
  }

  if (documento.kind === "NFS-e") {
    achados.push(...conferirNfse(documento));
  } else if (documento.kind === "CT-e") {
    achados.push(...conferirCte(documento));
  } else {
    achados.push(...conferirChave(documento));
    for (const item of documento.items) achados.push(...conferirItem(item, documento, regras));
    achados.push(...conferirTotais(documento));
    if (!documento.items.length) {
      achados.push(achado({
        code: "SEM_ITENS",
        severity: "critico",
        title: "Documento sem itens",
        basis: "Nenhum grupo det encontrado",
        rule: "Layout NF-e 4.00, grupo I"
      }));
    }
  }

  return {
    documentKey: documento.key,
    kind: documento.kind,
    number: documento.number,
    issuedAt: documento.issuedAt,
    emitter: documento.emitter.cnpj,
    findings: achados,
    summary: resumo(achados)
  };
}

function resumo(achados) {
  return {
    total: achados.length,
    critico: achados.filter((item) => item.severity === "critico").length,
    atencao: achados.filter((item) => item.severity === "atencao").length,
    informativo: achados.filter((item) => item.severity === "informativo").length,
    status: achados.some((item) => item.severity === "critico")
      ? "Irregular"
      : achados.length ? "Atencao" : "Conforme"
  };
}

/** Confere um lote e devolve o agregado por documento e o consolidado. */
export function conferirLote(documentos, regras = []) {
  const resultados = documentos.map((documento) => conferir(documento, regras));
  const todos = resultados.flatMap((item) => item.findings);
  const porCodigo = new Map();
  for (const item of todos) {
    const atual = porCodigo.get(item.code) || { code: item.code, title: item.title, count: 0, severity: item.severity };
    atual.count += 1;
    porCodigo.set(item.code, atual);
  }
  return {
    documentos: resultados,
    consolidado: {
      ...resumo(todos),
      conformes: resultados.filter((item) => item.summary.status === "Conforme").length,
      irregulares: resultados.filter((item) => item.summary.status === "Irregular").length,
      porCodigo: [...porCodigo.values()].sort((a, b) => b.count - a.count)
    }
  };
}
