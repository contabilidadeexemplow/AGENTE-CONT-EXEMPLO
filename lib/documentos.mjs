// Extracao de documentos fiscais reais a partir do XML.
// Normaliza NF-e, NFC-e e NFS-e (ABRASF e nacional) num formato unico,
// para que a conferencia e a apuracao nao precisem conhecer cada layout.

import { parseXml, deep, deepAll, text, num } from "./xml.mjs";

const PESOS = [2, 3, 4, 5, 6, 7, 8, 9];

/** Digito verificador da chave de acesso (modulo 11, NT 2003/003). */
export function digitoChave(chave43) {
  const digits = String(chave43).replace(/\D/g, "").slice(0, 43);
  if (digits.length !== 43) return null;
  let soma = 0;
  for (let index = 0; index < 43; index += 1) {
    soma += Number(digits[42 - index]) * PESOS[index % 8];
  }
  const dv = 11 - (soma % 11);
  return dv >= 10 ? 0 : dv;
}

/** Valida os 44 digitos e o DV da chave. */
export function validarChave(chave) {
  const digits = String(chave || "").replace(/\D/g, "");
  if (digits.length !== 44) return { valid: false, reason: "Chave deve ter 44 digitos" };
  const expected = digitoChave(digits.slice(0, 43));
  if (expected === null) return { valid: false, reason: "Chave incompleta" };
  if (expected !== Number(digits[43])) {
    return { valid: false, reason: "Digito verificador invalido (esperado " + expected + ")" };
  }
  return { valid: true };
}

/** Decompoe a chave nos campos que ela carrega. */
export function lerChave(chave) {
  const d = String(chave || "").replace(/\D/g, "");
  if (d.length !== 44) return null;
  return {
    uf: d.slice(0, 2),
    ano: d.slice(2, 4),
    mes: d.slice(4, 6),
    cnpj: d.slice(6, 20),
    modelo: d.slice(20, 22),
    serie: d.slice(22, 25),
    numero: d.slice(25, 34),
    tipoEmissao: d.slice(34, 35),
    codigo: d.slice(35, 43),
    dv: d.slice(43, 44)
  };
}

function somenteDigitos(value) {
  return String(value || "").replace(/\D/g, "");
}

function dataIso(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return iso[1] + "-" + iso[2] + "-" + iso[3];
  const br = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return br[3] + "-" + br[2] + "-" + br[1];
  const compet = raw.match(/^(\d{2})\/(\d{4})$/);
  if (compet) return compet[2] + "-" + compet[1] + "-01";
  return "";
}

// ---------------------------------------------------------------- NF-e / NFC-e

const GRUPOS_ICMS = [
  "ICMS00", "ICMS02", "ICMS10", "ICMS15", "ICMS20", "ICMS30", "ICMS40", "ICMS41",
  "ICMS50", "ICMS51", "ICMS53", "ICMS60", "ICMS61", "ICMS70", "ICMS90",
  "ICMSSN101", "ICMSSN102", "ICMSSN201", "ICMSSN202", "ICMSSN500", "ICMSSN900",
  "ICMSST", "ICMSPart"
];

function grupoIcms(imposto) {
  const icms = deep(imposto, "ICMS");
  if (!icms) return null;
  for (const nome of GRUPOS_ICMS) {
    const found = deep(icms, nome);
    if (found) return found;
  }
  return icms.children[0] ?? null;
}

function grupoTributo(imposto, tributo) {
  const raiz = deep(imposto, tributo);
  if (!raiz) return null;
  return raiz.children[0] ?? raiz;
}

function itemNfe(det) {
  const prod = deep(det, "prod");
  const imposto = deep(det, "imposto");
  const icms = grupoIcms(imposto);
  const ipi = grupoTributo(imposto, "IPI");
  const pis = grupoTributo(imposto, "PIS");
  const cofins = grupoTributo(imposto, "COFINS");

  return {
    n: Number(det.attrs.nItem || 0),
    code: text(prod, "cProd"),
    description: text(prod, "xProd"),
    ncm: somenteDigitos(text(prod, "NCM")),
    cest: somenteDigitos(text(prod, "CEST")),
    cfop: somenteDigitos(text(prod, "CFOP")),
    unit: text(prod, "uCom"),
    quantity: num(prod, "qCom"),
    unitPrice: num(prod, "vUnCom"),
    discount: num(prod, "vDesc"),
    freight: num(prod, "vFrete"),
    total: num(prod, "vProd"),
    icms: {
      origin: text(icms, "orig"),
      cst: text(icms, "CST"),
      csosn: text(icms, "CSOSN"),
      modBc: text(icms, "modBC"),
      base: num(icms, "vBC"),
      rate: num(icms, "pICMS"),
      value: num(icms, "vICMS"),
      reduction: num(icms, "pRedBC"),
      credit: num(icms, "vCredICMSSN"),
      creditRate: num(icms, "pCredSN"),
      mva: num(icms, "pMVAST"),
      stBase: num(icms, "vBCST"),
      stRate: num(icms, "pICMSST"),
      stValue: num(icms, "vICMSST")
    },
    ipi: { cst: text(ipi, "CST"), base: num(ipi, "vBC"), rate: num(ipi, "pIPI"), value: num(ipi, "vIPI") },
    pis: tributoContribuicao(pis, "PIS"),
    cofins: tributoContribuicao(cofins, "COFINS")
  };
}

// PIS e COFINS: por aliquota (vBC x p) ou, no CST 03, por unidade
// (qBCProd x vAliqProd, em reais por unidade de produto).
function tributoContribuicao(grupo, sigla) {
  return {
    cst: text(grupo, "CST"),
    base: num(grupo, "vBC"),
    rate: num(grupo, "p" + sigla),
    quantityBase: num(grupo, "qBCProd"),
    unitRate: num(grupo, "vAliqProd"),
    value: num(grupo, "v" + sigla)
  };
}

function extrairNfe(doc) {
  // O CT-e lista as NF-e da carga em infDoc/infNFe: isso nao faz dele uma NF-e.
  if (deep(doc, "infCte")) return null;
  const inf = deep(doc, "infNFe");
  if (!inf) return null;
  const ide = deep(inf, "ide");
  const emit = deep(inf, "emit");
  const dest = deep(inf, "dest");
  const total = deep(inf, "ICMSTot");
  const modelo = text(ide, "mod");
  const protocolo = deep(doc, "infProt");

  return {
    kind: modelo === "65" ? "NFC-e" : "NF-e",
    model: modelo,
    key: somenteDigitos(inf.attrs.Id || text(doc, "chNFe")),
    number: text(ide, "nNF"),
    series: text(ide, "serie"),
    issuedAt: dataIso(text(ide, "dhEmi", "dEmi")),
    operation: text(ide, "tpNF") === "0" ? "entrada" : "saida",
    // tpNF do proprio XML (0 entrada, 1 saida). A captura grava em "operation"
    // a visao da empresa da carteira (recebida = entrada); a conferencia
    // tributaria le este campo, que segue intacto nos dados gravados.
    tpNF: text(ide, "tpNF"),
    natureza: text(ide, "natOp"),
    protocol: protocolo ? { status: text(protocolo, "cStat"), reason: text(protocolo, "xMotivo") } : null,
    emitter: {
      cnpj: somenteDigitos(text(emit, "CNPJ")),
      cpf: somenteDigitos(text(emit, "CPF")),
      name: text(emit, "xNome"),
      city: text(emit, "xMun"),
      uf: text(emit, "UF"),
      crt: text(emit, "CRT"),
      im: text(emit, "IM")
    },
    recipient: {
      doc: somenteDigitos(text(dest, "CNPJ", "CPF")),
      name: text(dest, "xNome"),
      uf: text(dest, "UF"),
      indIe: text(dest, "indIEDest")
    },
    items: deepAll(inf, "det").map(itemNfe),
    totals: {
      products: num(total, "vProd"),
      discount: num(total, "vDesc"),
      freight: num(total, "vFrete"),
      insurance: num(total, "vSeg"),
      other: num(total, "vOutro"),
      invoice: num(total, "vNF"),
      icmsBase: num(total, "vBC"),
      icms: num(total, "vICMS"),
      stBase: num(total, "vBCST"),
      st: num(total, "vST"),
      ipi: num(total, "vIPI"),
      pis: num(total, "vPIS"),
      cofins: num(total, "vCOFINS"),
      fcpSt: num(total, "vFCPST"),
      ii: num(total, "vII"),
      ipiDevol: num(total, "vIPIDevol"),
      icmsDeson: num(total, "vICMSDeson")
    }
  };
}

// ---------------------------------------------------------------------- CT-e

// Tomador do servico no CT-e: toma3/toma (0 remetente, 1 expedidor,
// 2 recebedor, 3 destinatario) ou toma4 explicito.
function tomadorCte(inf) {
  const ide = deep(inf, "ide");
  const toma4 = deep(ide, "toma4");
  if (toma4) return { doc: somenteDigitos(text(toma4, "CNPJ", "CPF")), name: text(toma4, "xNome") };
  const codigo = text(deep(ide, "toma3") || deep(ide, "toma03"), "toma");
  const papel = { 0: "rem", 1: "exped", 2: "receb", 3: "dest" }[codigo] || "dest";
  const no = filho(inf, papel) || deep(inf, papel);
  return { doc: somenteDigitos(text(no, "CNPJ", "CPF")), name: text(no, "xNome"), papel };
}

function extrairCte(doc) {
  const inf = deep(doc, "infCte");
  if (!inf) return null;
  const ide = deep(inf, "ide");
  const emit = filho(inf, "emit") || deep(inf, "emit");
  const prest = deep(inf, "vPrest");
  const icms = deep(deep(inf, "imp"), "ICMS");
  const protocolo = deep(doc, "infProt");
  const tomador = tomadorCte(inf);
  const valor = num(prest, "vTPrest");
  return {
    kind: "CT-e",
    model: text(ide, "mod") || "57",
    key: somenteDigitos(inf.attrs.Id || text(doc, "chCTe")),
    number: text(ide, "nCT"),
    series: text(ide, "serie"),
    issuedAt: dataIso(text(ide, "dhEmi")),
    competencia: dataIso(text(ide, "dhEmi")).slice(0, 7),
    operation: "saida",
    natureza: text(ide, "natOp"),
    cfop: text(ide, "CFOP"),
    protocol: protocolo ? { status: text(protocolo, "cStat"), reason: text(protocolo, "xMotivo") } : null,
    emitter: {
      cnpj: somenteDigitos(text(emit, "CNPJ")),
      name: text(emit, "xNome"),
      uf: text(deep(emit, "enderEmit"), "UF")
    },
    recipient: tomador,
    remetente: { doc: somenteDigitos(text(filho(inf, "rem"), "CNPJ", "CPF")), name: text(filho(inf, "rem"), "xNome") },
    destinatario: { doc: somenteDigitos(text(filho(inf, "dest"), "CNPJ", "CPF")), name: text(filho(inf, "dest"), "xNome") },
    items: [],
    totals: {
      products: valor,
      invoice: valor,
      received: num(prest, "vRec"),
      icmsBase: num(icms, "vBC"),
      icms: num(icms, "vICMS")
    }
  };
}

/**
 * Resumo de NF-e (resNFe) que a distribuicao entrega antes da manifestacao.
 * Nao e documento fiscal: e o aviso de que a nota existe.
 */
export function lerResumoNfe(xml) {
  const doc = parseXml(xml);
  const res = deep(doc, "resNFe") || (doc.children[0]?.name === "resNFe" ? doc.children[0] : null);
  if (!res) return null;
  return {
    chave: somenteDigitos(text(res, "chNFe")),
    emitente: { cnpj: somenteDigitos(text(res, "CNPJ", "CPF")), nome: text(res, "xNome") },
    emissao: dataIso(text(res, "dhEmi")),
    tipo: text(res, "tpNF") === "0" ? "entrada" : "saida",
    valor: num(res, "vNF"),
    situacao: { 1: "autorizada", 2: "denegada", 3: "cancelada" }[text(res, "cSitNFe")] || "desconhecida",
    protocolo: text(res, "nProt")
  };
}

// --------------------------------------------------------------------- NFS-e

function normalizarAliquota(valor) {
  // ABRASF publica tanto 0.05 quanto 5 para a mesma aliquota de 5%.
  return valor > 0 && valor < 1 ? valor * 100 : valor;
}

function extrairNfseAbrasf(doc) {
  const inf = deep(doc, "InfNfse") || deep(doc, "Nfse") || deep(doc, "InfDeclaracaoPrestacaoServico");
  if (!inf) return null;
  const servico = deep(inf, "Servico");
  const valores = deep(servico, "Valores") || deep(inf, "Valores");
  const prestador = deep(inf, "PrestadorServico") || deep(inf, "Prestador");
  const tomador = deep(inf, "TomadorServico") || deep(inf, "Tomador");
  const bruto = num(valores, "ValorServicos");
  const base = num(valores, "BaseCalculo") || bruto - num(valores, "ValorDeducoes");

  return {
    kind: "NFS-e",
    standard: "ABRASF",
    key: text(inf, "CodigoVerificacao") || text(inf, "Numero"),
    number: text(inf, "Numero"),
    series: text(inf, "Serie"),
    issuedAt: dataIso(text(inf, "DataEmissao", "Competencia")),
    competencia: dataIso(text(inf, "Competencia")).slice(0, 7) || undefined,
    operation: "saida",
    emitter: {
      cnpj: somenteDigitos(text(prestador, "Cnpj", "CpfCnpj")),
      name: text(prestador, "RazaoSocial", "NomeFantasia"),
      city: text(prestador, "CodigoMunicipio"),
      im: text(prestador, "InscricaoMunicipal")
    },
    recipient: {
      doc: somenteDigitos(text(tomador, "Cnpj", "Cpf", "CpfCnpj")),
      name: text(tomador, "RazaoSocial")
    },
    items: [],
    service: {
      code: text(servico, "ItemListaServico"),
      cityCode: text(servico, "CodigoTributacaoMunicipio"),
      cityIbge: text(servico, "CodigoMunicipio") || text(servico, "MunicipioIncidencia"),
      description: text(servico, "Discriminacao"),
      gross: bruto,
      deductions: num(valores, "ValorDeducoes"),
      base,
      rate: normalizarAliquota(num(valores, "Aliquota")),
      iss: num(valores, "ValorIss"),
      issWithheld: text(servico, "IssRetido") === "1" || num(valores, "ValorIssRetido") > 0,
      withheldValue: num(valores, "ValorIssRetido"),
      pis: num(valores, "ValorPis"),
      cofins: num(valores, "ValorCofins"),
      inss: num(valores, "ValorInss"),
      ir: num(valores, "ValorIr"),
      csll: num(valores, "ValorCsll"),
      net: num(valores, "ValorLiquidoNfse")
    },
    totals: {
      products: bruto,
      invoice: num(valores, "ValorLiquidoNfse") || bruto,
      iss: num(valores, "ValorIss"),
      pis: num(valores, "ValorPis"),
      cofins: num(valores, "ValorCofins")
    }
  };
}

function filho(no, nome) {
  return no?.children.find((item) => item.name === nome) || null;
}

// Leiaute nacional: NFSe/infNFSe (dados apurados pelo ADN, com emit e valores)
// contem DPS/infDPS (o que o emitente declarou: prest, toma, serv, valores).
// A chave e o atributo Id de infNFSe, "NFS" + 50 digitos.
function extrairNfseNacional(doc) {
  const inf = deep(doc, "infNFSe");
  if (!inf) return null;
  const dps = deep(inf, "infDPS") || inf;
  const emit = filho(inf, "emit");
  const prest = filho(dps, "prest");
  const toma = filho(dps, "toma");
  const serv = filho(dps, "serv");
  const valoresNfse = filho(inf, "valores");
  const valoresDps = filho(dps, "valores") || valoresNfse;
  const tribMun = deep(valoresDps, "tribMun");
  const bruto = num(valoresDps, "vServ");
  const iss = num(valoresNfse, "vISSQN") || num(tribMun, "vISSQN");
  const retencao = text(tribMun, "tpRetISSQN");
  const retido = retencao === "2" || retencao === "3";
  const aliquota = num(valoresNfse, "pAliqAplic") || num(tribMun, "pAliq");

  return {
    kind: "NFS-e",
    standard: "Nacional",
    key: somenteDigitos(inf.attrs.Id || ""),
    number: text(inf, "nNFSe") || text(dps, "nDPS"),
    series: text(dps, "serie"),
    issuedAt: dataIso(text(dps, "dhEmi") || text(inf, "dhProc")),
    competencia: dataIso(text(dps, "dCompet")).slice(0, 7),
    status: text(inf, "cStat"),
    operation: "saida",
    emitter: {
      cnpj: somenteDigitos(text(emit, "CNPJ") || text(prest, "CNPJ")),
      cpf: somenteDigitos(text(emit, "CPF") || text(prest, "CPF")),
      name: text(emit, "xNome") || text(prest, "xNome"),
      city: text(emit, "cMun") || text(dps, "cLocEmi"),
      im: text(emit, "IM")
    },
    recipient: {
      doc: somenteDigitos(text(toma, "CNPJ", "CPF")),
      name: text(toma, "xNome")
    },
    items: [],
    service: {
      code: text(serv, "cTribNac"),
      cityCode: text(serv, "cTribMun"),
      cityIbge: text(serv, "cLocPrestacao") || text(inf, "cLocIncid"),
      description: text(serv, "xDescServ"),
      gross: bruto,
      deductions: num(valoresDps, "vDR") || num(valoresDps, "vDedRed"),
      base: num(valoresNfse, "vBC") || bruto,
      rate: normalizarAliquota(aliquota),
      iss,
      issWithheld: retido,
      withheldValue: retido ? iss : 0,
      pis: num(valoresDps, "vPis"),
      cofins: num(valoresDps, "vCofins"),
      net: num(valoresNfse, "vLiq")
    },
    totals: {
      products: bruto,
      invoice: num(valoresNfse, "vLiq") || bruto,
      iss
    }
  };
}

// ---------------------------------------------------------------- orquestracao

/**
 * Converte uma string XML num documento normalizado.
 * Lanca Error quando o XML nao e um documento fiscal reconhecido.
 */
export function lerDocumento(xml, origem = "") {
  const doc = parseXml(xml);
  const extraido = extrairNfe(doc) || extrairCte(doc) || extrairNfseAbrasf(doc) || extrairNfseNacional(doc);
  if (extraido) return { ...extraido, source: origem };

  // Resumo de evento da distribuicao de NF-e: sem infEvento, campos na raiz.
  const resumoEvento = deep(doc, "resEvento") || (doc.children[0]?.name === "resEvento" ? doc.children[0] : null);
  if (resumoEvento) {
    return {
      kind: "Evento",
      key: somenteDigitos(text(resumoEvento, "chNFe")),
      event: text(resumoEvento, "tpEvento"),
      description: text(resumoEvento, "xEvento"),
      reason: "",
      author: somenteDigitos(text(resumoEvento, "CNPJ")),
      issuedAt: dataIso(text(resumoEvento, "dhEvento")),
      source: origem,
      items: [],
      totals: {}
    };
  }

  const evento = deep(doc, "infEvento");
  if (evento) {
    // NFS-e nacional: o tipo e o nome do elemento filho de infPedReg (e101101).
    const pedido = deep(evento, "infPedReg");
    const elementoTipo = pedido?.children.find((item) => /^e\d{4,}$/.test(item.name)) || null;
    return {
      kind: "Evento",
      key: somenteDigitos(text(evento, "chNFe") || text(evento, "chCTe") || text(evento, "chNFSe")),
      event: text(evento, "tpEvento") || (elementoTipo ? elementoTipo.name.slice(1) : ""),
      description: text(elementoTipo, "xDesc") || text(evento, "descEvento"),
      reason: text(evento, "xJust") || text(elementoTipo, "xMotivo"),
      author: somenteDigitos(text(evento, "CNPJAutor") || text(evento, "CNPJ")),
      issuedAt: dataIso(text(evento, "dhEvento") || text(evento, "dhProc")),
      source: origem,
      items: [],
      totals: {}
    };
  }

  throw new Error("XML nao reconhecido como NF-e, NFC-e, NFS-e ou evento");
}

/** Le um lote de arquivos XML, separando o que entrou do que falhou. */
export function lerLote(arquivos) {
  const documentos = [];
  const falhas = [];
  for (const arquivo of arquivos) {
    try {
      documentos.push(lerDocumento(arquivo.content, arquivo.name));
    } catch (error) {
      falhas.push({ name: arquivo.name, error: error.message });
    }
  }
  return { documentos, falhas };
}
