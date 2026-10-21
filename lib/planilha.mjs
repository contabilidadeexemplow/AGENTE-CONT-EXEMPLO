// Gerador de planilha .xlsx (Office Open XML / SpreadsheetML) sem dependencias.
// Strings inline (t="inlineStr"), entao nao ha sharedStrings.xml. Cabecalho em
// negrito com fundo claro, primeira linha congelada, autofiltro no intervalo
// usado e largura de coluna por `largura` ou estimada pelo conteudo.
//
// criarXlsx({ abas: [{ nome, colunas: [{ titulo, largura?, tipo? }], linhas }] })
//   tipo "texto"  -> sempre texto (bom para CNPJ e chave de acesso)
//   tipo "numero" -> numero real, formato Geral
//   tipo "moeda"  -> numero real com formato #,##0.00
//   tipo "data"   -> serial do Excel com formato dd/mm/yyyy
//   sem tipo      -> pelo valor: number vira numero, boolean vira logico,
//                    Date vira data e o resto vira texto (string nunca e convertida)
// null, undefined e "" viram celula vazia. O resultado e deterministico: a mesma
// entrada gera os mesmos bytes (as datas internas do ZIP ficam fixas).

import { criarZip } from "./zip.mjs";

const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const CABECALHO_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const MAX_LINHAS = 1048576;
const MAX_COLUNAS = 16384;
const MAX_TEXTO = 32767;
const MAX_NOME_ABA = 31;

// Indices em cellXfs (ver estilosXml).
const ESTILO_CABECALHO = 1;
const ESTILO_MOEDA = 2;
const ESTILO_DATA = 3;

const TIPOS = new Set(["texto", "numero", "moeda", "data"]);

// Caracteres fora do XML 1.0: controles (menos tab, LF e CR), surrogates soltos, FFFE e FFFF.
const INVALIDOS_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF￾￿]/gu;
const PRECISA_TRATAR = /[&<>"'\r_\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF￾￿]/;

// Serial 0 do Excel e 1899-12-30 (ja considerando o falso 29/02/1900 do Lotus).
const BASE_SERIAL = Date.UTC(1899, 11, 30);
const DIA_MS = 86400000;

// ------------------------------------------------------------------ texto

/** Escapa para conteudo ou atributo XML; tira os caracteres invalidos no XML 1.0. */
function escXml(valor) {
  const texto = String(valor);
  if (!PRECISA_TRATAR.test(texto)) return texto;
  return texto
    .replace(INVALIDOS_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Texto de celula: limpa, normaliza quebras, respeita o limite do Excel e escapa. */
function textoCelula(valor) {
  let texto = String(valor);
  if (PRECISA_TRATAR.test(texto)) {
    texto = texto.replace(INVALIDOS_XML, "").replace(/\r\n?/g, "\n");
    // O Excel le _xHHHH_ como caractere escapado; o "_" literal vira _x005F_.
    texto = texto.replace(/_(x[0-9A-Fa-f]{4}_)/g, "_x005F_$1");
  }
  if (texto.length > MAX_TEXTO) texto = texto.slice(0, MAX_TEXTO).replace(/[\uD800-\uDBFF]$/, "");
  return escXml(texto);
}

// ------------------------------------------------------------------ valores

/** Numero a partir de number, bigint ou string ("1234.56" ou no padrao BR "1.234,56"). */
function paraNumero(valor) {
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : null;
  if (typeof valor === "bigint") return Number(valor);
  if (typeof valor !== "string") return null;
  let texto = valor.trim();
  if (!texto) return null;
  if (texto.includes(",")) {
    if (!/^-?\d{1,3}(\.\d{3})*(,\d+)?$|^-?\d+(,\d+)?$/.test(texto)) return null;
    texto = texto.replace(/\./g, "").replace(",", ".");
  } else if (!/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(texto)) {
    return null;
  }
  const numero = Number(texto);
  return Number.isFinite(numero) ? numero : null;
}

/** Serial do Excel para ano/mes/dia, ou null se a data nao existe ou esta fora do Excel. */
function serialDe(ano, mes, dia) {
  if (ano < 1900 || ano > 9999 || mes < 1 || mes > 12 || dia < 1) return null;
  const instante = Date.UTC(ano, mes - 1, dia);
  const conferida = new Date(instante);
  if (conferida.getUTCMonth() !== mes - 1 || conferida.getUTCDate() !== dia) return null;
  const serial = Math.round((instante - BASE_SERIAL) / DIA_MS);
  // Antes de 01/03/1900 o Excel nao conta o 29/02/1900 que ele inventa.
  return serial < 61 ? serial - 1 : serial;
}

/**
 * Data para serial do Excel. Aceita Date (data UTC), "AAAA-MM-DD", ISO com hora
 * (usa a data escrita, sem converter fuso) e "DD/MM/AAAA". Number e tido como serial.
 */
function paraSerial(valor) {
  if (typeof valor === "number") return Number.isFinite(valor) ? valor : null;
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) return null;
    return serialDe(valor.getUTCFullYear(), valor.getUTCMonth() + 1, valor.getUTCDate());
  }
  if (typeof valor !== "string") return null;
  const texto = valor.trim();
  let partes = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ]\d{2}:\d{2})/.exec(texto);
  if (partes) return serialDe(Number(partes[1]), Number(partes[2]), Number(partes[3]));
  partes = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(texto);
  if (partes) return serialDe(Number(partes[3]), Number(partes[2]), Number(partes[1]));
  return null;
}

// ------------------------------------------------------------------ celulas

function letraColuna(indice) {
  let numero = indice + 1;
  let letras = "";
  while (numero > 0) {
    const resto = (numero - 1) % 26;
    letras = String.fromCharCode(65 + resto) + letras;
    numero = Math.floor((numero - 1) / 26);
  }
  return letras;
}

function vazio(valor) {
  return valor === null || valor === undefined || valor === "";
}

function celulaTexto(ref, valor, estilo = 0) {
  const texto = textoCelula(valor);
  if (!texto) return "";
  const espaco = /^\s|\s$/.test(texto) ? ' xml:space="preserve"' : "";
  const s = estilo ? ' s="' + estilo + '"' : "";
  return '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t' + espaco + ">" + texto + "</t></is></c>";
}

function celulaNumero(ref, numero, estilo = 0) {
  const s = estilo ? ' s="' + estilo + '"' : "";
  return '<c r="' + ref + '"' + s + "><v>" + String(numero) + "</v></c>";
}

/** XML de uma celula conforme o tipo da coluna. Valor que nao converte vira texto. */
function celula(ref, valor, tipo) {
  if (vazio(valor)) return "";
  if (tipo === "texto") return celulaTexto(ref, valor);
  if (tipo === "numero" || tipo === "moeda") {
    if (typeof valor === "number" && !Number.isFinite(valor)) return "";
    const numero = paraNumero(valor);
    if (numero === null) return celulaTexto(ref, valor);
    return celulaNumero(ref, numero, tipo === "moeda" ? ESTILO_MOEDA : 0);
  }
  if (tipo === "data") {
    const serial = paraSerial(valor);
    if (serial === null) return celulaTexto(ref, valor instanceof Date ? "" : valor);
    return celulaNumero(ref, serial, ESTILO_DATA);
  }
  // Sem tipo: decide pelo valor.
  if (typeof valor === "number") return Number.isFinite(valor) ? celulaNumero(ref, valor) : "";
  if (typeof valor === "bigint") return celulaNumero(ref, Number(valor));
  if (typeof valor === "boolean") return '<c r="' + ref + '" t="b"><v>' + (valor ? 1 : 0) + "</v></c>";
  if (valor instanceof Date) {
    const serial = paraSerial(valor);
    return serial === null ? "" : celulaNumero(ref, serial, ESTILO_DATA);
  }
  return celulaTexto(ref, valor);
}

// ------------------------------------------------------------------ abas

/** Nome valido e unico (sem diferenciar maiusculas): ate 31 caracteres, sem []:*?/\ */
function nomeDeAba(bruto, posicao, usados) {
  let base = String(bruto ?? "")
    .replace(INVALIDOS_XML, "")
    .replace(/[\[\]:*?/\\\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^'+|'+$/g, "")
    .trim();
  if (!base || base.toLowerCase() === "history") base = base ? base + " 1" : "Planilha " + (posicao + 1);
  const cortar = (texto, limite) => {
    const pontos = [...texto];
    while (pontos.join("").length > limite) pontos.pop();
    return pontos.join("").replace(/'+$/, "").trimEnd();
  };
  let nome = cortar(base, MAX_NOME_ABA);
  for (let n = 2; usados.has(nome.toLowerCase()); n += 1) {
    const sufixo = " (" + n + ")";
    nome = cortar(base, MAX_NOME_ABA - sufixo.length) + sufixo;
  }
  usados.add(nome.toLowerCase());
  return nome;
}

function normalizarColunas(colunas) {
  return (colunas ?? []).map((coluna, indice) => {
    const definida = typeof coluna === "string" ? { titulo: coluna } : (coluna ?? {});
    const tipo = definida.tipo ?? null;
    if (tipo !== null && !TIPOS.has(tipo)) {
      throw new Error(`criarXlsx: tipo "${tipo}" invalido na coluna ${indice + 1} (use texto, numero, moeda ou data)`);
    }
    return { titulo: definida.titulo ?? "", largura: definida.largura, tipo };
  });
}

/** Largura estimada em caracteres: titulo (com folga para o botao do filtro) e amostra das linhas. */
function larguraEstimada(coluna, indice, linhas) {
  if (coluna.tipo === "data") return Math.max(12, String(coluna.titulo).length + 4);
  let maior = String(coluna.titulo ?? "").length + 4;
  const amostra = Math.min(linhas.length, 500);
  for (let linha = 0; linha < amostra; linha += 1) {
    const valor = linhas[linha]?.[indice];
    if (vazio(valor)) continue;
    let tamanho = valor instanceof Date ? 10 : String(valor).split("\n")[0].length;
    if (coluna.tipo === "moeda" || coluna.tipo === "numero") tamanho += Math.floor(tamanho / 3) + 1;
    if (tamanho > maior) maior = tamanho;
  }
  return Math.min(60, Math.max(8, maior + 2));
}

function abaXml(aba, ehPrimeira) {
  const colunas = aba.colunas;
  const linhas = aba.linhas;
  let totalColunas = Math.max(colunas.length, 1);
  for (const linha of linhas) if (linha.length > totalColunas) totalColunas = linha.length;
  const totalLinhas = linhas.length + 1;
  if (totalLinhas > MAX_LINHAS) throw new Error(`criarXlsx: a aba "${aba.nome}" passa de ${MAX_LINHAS} linhas`);
  if (totalColunas > MAX_COLUNAS) throw new Error(`criarXlsx: a aba "${aba.nome}" passa de ${MAX_COLUNAS} colunas`);

  const letras = Array.from({ length: totalColunas }, (_, indice) => letraColuna(indice));
  const tipos = letras.map((_, indice) => colunas[indice]?.tipo ?? null);
  const ultima = letras[totalColunas - 1] + totalLinhas;
  const partes = [];

  partes.push(CABECALHO_XML, '<worksheet xmlns="', NS_MAIN, '" xmlns:r="', NS_REL, '">');
  partes.push('<dimension ref="A1', ultima === "A1" ? "" : ":" + ultima, '"/>');
  partes.push('<sheetViews><sheetView', ehPrimeira ? ' tabSelected="1"' : "", ' workbookViewId="0">',
    '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>',
    '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>');
  partes.push('<sheetFormatPr defaultRowHeight="15"/>');

  if (colunas.length) {
    partes.push("<cols>");
    colunas.forEach((coluna, indice) => {
      const pedida = Number(coluna.largura);
      const largura = Number.isFinite(pedida) && pedida > 0
        ? Math.min(255, pedida)
        : larguraEstimada(coluna, indice, linhas);
      partes.push('<col min="', indice + 1, '" max="', indice + 1, '" width="', largura, '" customWidth="1"/>');
    });
    partes.push("</cols>");
  }

  partes.push('<sheetData><row r="1">');
  colunas.forEach((coluna, indice) => partes.push(celulaTexto(letras[indice] + "1", coluna.titulo, ESTILO_CABECALHO)));
  partes.push("</row>");
  for (let linha = 0; linha < linhas.length; linha += 1) {
    const valores = linhas[linha];
    const numero = linha + 2;
    partes.push('<row r="', numero, '">');
    for (let indice = 0; indice < valores.length; indice += 1) {
      partes.push(celula(letras[indice] + numero, valores[indice], tipos[indice]));
    }
    partes.push("</row>");
  }
  partes.push("</sheetData>");

  if (colunas.length) partes.push('<autoFilter ref="A1:', letras[colunas.length - 1] + totalLinhas, '"/>');
  partes.push('<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>');
  partes.push("</worksheet>");
  return partes.join("");
}

// ------------------------------------------------------------------ pacote

function contentTypesXml(abas) {
  const sobre = (parte, tipo) => '<Override PartName="' + parte + '" ContentType="' + tipo + '"/>';
  return CABECALHO_XML +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    sobre("/xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml") +
    abas.map((_, indice) => sobre("/xl/worksheets/sheet" + (indice + 1) + ".xml",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml")).join("") +
    sobre("/xl/styles.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml") +
    sobre("/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml") +
    sobre("/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml") +
    "</Types>";
}

function relsXml() {
  return CABECALHO_XML +
    '<Relationships xmlns="' + NS_PKG_REL + '">' +
    '<Relationship Id="rId1" Type="' + NS_REL + '/officeDocument" Target="xl/workbook.xml"/>' +
    '<Relationship Id="rId2" Type="' + NS_PKG_REL + '/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="' + NS_REL + '/extended-properties" Target="docProps/app.xml"/>' +
    "</Relationships>";
}

function appXml() {
  return CABECALHO_XML +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    "<Application>NUCLEO X</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>" +
    "</Properties>";
}

/** Data W3CDTF sem milissegundos, ou null. Sem data informada o arquivo nao leva data. */
function dataW3c(valor) {
  if (vazio(valor)) return null;
  const data = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(data.getTime())) return null;
  return data.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function coreXml({ titulo, autor, criadoEm }) {
  const quando = dataW3c(criadoEm);
  return CABECALHO_XML +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    (titulo ? "<dc:title>" + escXml(titulo) + "</dc:title>" : "") +
    "<dc:creator>" + escXml(autor || "NUCLEO X") + "</dc:creator>" +
    (quando
      ? '<dcterms:created xsi:type="dcterms:W3CDTF">' + quando + "</dcterms:created>" +
        '<dcterms:modified xsi:type="dcterms:W3CDTF">' + quando + "</dcterms:modified>"
      : "") +
    "</cp:coreProperties>";
}

/** Referencia absoluta 'Aba'!$A$1:$D$10 para o nome definido do autofiltro. */
function referenciaAba(nome, intervalo) {
  const [inicio, fim] = intervalo.split(":");
  const absoluta = (ref) => ref.replace(/^([A-Z]+)(\d+)$/, "$$$1$$$2");
  return "'" + nome.replace(/'/g, "''") + "'!" + absoluta(inicio) + ":" + absoluta(fim);
}

function workbookXml(abas) {
  const filtros = abas
    .map((aba, indice) => aba.colunas.length
      ? '<definedName name="_xlnm._FilterDatabase" localSheetId="' + indice + '" hidden="1">' +
        escXml(referenciaAba(aba.nome, "A1:" + letraColuna(aba.colunas.length - 1) + (aba.linhas.length + 1))) +
        "</definedName>"
      : "")
    .join("");
  return CABECALHO_XML +
    '<workbook xmlns="' + NS_MAIN + '" xmlns:r="' + NS_REL + '">' +
    '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="12300" activeTab="0"/></bookViews>' +
    "<sheets>" +
    abas.map((aba, indice) =>
      '<sheet name="' + escXml(aba.nome) + '" sheetId="' + (indice + 1) + '" r:id="rId' + (indice + 1) + '"/>').join("") +
    "</sheets>" +
    (filtros ? "<definedNames>" + filtros + "</definedNames>" : "") +
    '<calcPr calcId="191029"/>' +
    "</workbook>";
}

function workbookRelsXml(abas) {
  return CABECALHO_XML +
    '<Relationships xmlns="' + NS_PKG_REL + '">' +
    abas.map((_, indice) =>
      '<Relationship Id="rId' + (indice + 1) + '" Type="' + NS_REL + '/worksheet" Target="worksheets/sheet' + (indice + 1) + '.xml"/>').join("") +
    '<Relationship Id="rId' + (abas.length + 1) + '" Type="' + NS_REL + '/styles" Target="styles.xml"/>' +
    "</Relationships>";
}

// cellXfs: 0 padrao, 1 cabecalho (negrito + fundo claro), 2 moeda, 3 data.
function estilosXml() {
  return CABECALHO_XML +
    '<styleSheet xmlns="' + NS_MAIN + '">' +
    '<numFmts count="2"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="dd/mm/yyyy"/></numFmts>' +
    '<fonts count="2">' +
    '<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>' +
    "</fonts>" +
    '<fills count="3">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFE7EEF7"/><bgColor indexed="64"/></patternFill></fill>' +
    "</fills>" +
    '<borders count="2">' +
    "<border><left/><right/><top/><bottom/><diagonal/></border>" +
    '<border><left/><right/><top/><bottom style="thin"><color rgb="FFB4C6DE"/></bottom><diagonal/></border>' +
    "</borders>" +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="4">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    "</cellXfs>" +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '<dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>' +
    "</styleSheet>";
}

/** Fixa data e hora DOS de todas as entradas em 01/01/1980 00:00 (bytes iguais para a mesma entrada). */
function fixarDatasZip(zip) {
  let fim = zip.length - 22;
  while (fim >= 0 && zip.readUInt32LE(fim) !== 0x06054b50) fim -= 1;
  if (fim < 0) return zip;
  const total = zip.readUInt16LE(fim + 10);
  let at = zip.readUInt32LE(fim + 16);
  const DATA_DOS = (1 << 5) | 1;
  for (let indice = 0; indice < total; indice += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) break;
    zip.writeUInt16LE(0, at + 12);
    zip.writeUInt16LE(DATA_DOS, at + 14);
    const local = zip.readUInt32LE(at + 42);
    if (zip.readUInt32LE(local) === 0x04034b50) {
      zip.writeUInt16LE(0, local + 10);
      zip.writeUInt16LE(DATA_DOS, local + 12);
    }
    at += 46 + zip.readUInt16LE(at + 28) + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return zip;
}

/**
 * Monta o .xlsx e devolve um Buffer.
 * @param {{ abas: { nome: string, colunas: ({ titulo: string, largura?: number,
 *   tipo?: "texto"|"numero"|"moeda"|"data" }|string)[], linhas: any[][] }[],
 *   titulo?: string, autor?: string, criadoEm?: Date|string }} opcoes
 */
export function criarXlsx({ abas, titulo, autor, criadoEm } = {}) {
  if (!Array.isArray(abas) || !abas.length) throw new Error("criarXlsx: informe ao menos uma aba");

  const usados = new Set();
  const prontas = abas.map((aba, posicao) => {
    const linhas = aba?.linhas ?? [];
    if (!Array.isArray(linhas)) throw new Error(`criarXlsx: linhas da aba ${posicao + 1} precisam ser uma lista`);
    return {
      nome: nomeDeAba(aba?.nome, posicao, usados),
      colunas: normalizarColunas(aba?.colunas),
      linhas: linhas.map((linha) => (Array.isArray(linha) ? linha : []))
    };
  });

  const entradas = [
    { nome: "[Content_Types].xml", conteudo: contentTypesXml(prontas) },
    { nome: "_rels/.rels", conteudo: relsXml() },
    { nome: "docProps/app.xml", conteudo: appXml() },
    { nome: "docProps/core.xml", conteudo: coreXml({ titulo, autor, criadoEm }) },
    { nome: "xl/workbook.xml", conteudo: workbookXml(prontas) },
    { nome: "xl/_rels/workbook.xml.rels", conteudo: workbookRelsXml(prontas) },
    { nome: "xl/styles.xml", conteudo: estilosXml() },
    ...prontas.map((aba, indice) => ({
      nome: "xl/worksheets/sheet" + (indice + 1) + ".xml",
      conteudo: abaXml(aba, indice === 0)
    }))
  ].map(({ nome, conteudo }) => ({ nome, conteudo: Buffer.from(conteudo, "utf8") }));

  return fixarDatasZip(criarZip(entradas));
}

