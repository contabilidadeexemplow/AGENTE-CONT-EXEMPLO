// DANFE (NF-e, modelo 55) e DACTE (CT-e, modelo 57) gerados a partir do XML
// autorizado, com pdf-lib e a fonte Arimo ja vendorizadas para o DANFSe.
//
// A SEFAZ nao entrega PDF: o documento auxiliar e sempre uma representacao do
// XML, e o leiaute segue o Manual de Orientacao do Contribuinte (retrato,
// canhoto, codigo de barras CODE-128C da chave de acesso, quadros na ordem do
// manual). O que o XML nao traz fica com "-".
//
// Codigo de barras: CODE-128 subconjunto C, 22 pares de digitos, digito
// verificador modulo 103, zona de silencio de 10 modulos.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseXml, deep, deepAll, text, num } from "./xml.mjs";

const require = createRequire(import.meta.url);
const vendor = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor");
let bibliotecas = null;

function carregar() {
  if (!bibliotecas) {
    bibliotecas = {
      PDFLib: require(join(vendor, "pdf-lib.cjs")),
      fontkit: require(join(vendor, "fontkit.cjs")),
      arimo: readFileSync(join(vendor, "fonts", "Arimo_400Regular.ttf")),
      arimoBold: readFileSync(join(vendor, "fonts", "Arimo_700Bold.ttf"))
    };
  }
  return bibliotecas;
}

// ------------------------------------------------------------- CODE-128C

const PADROES = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112"
];
const INICIO_C = 105;
const PARADA = 106;

/**
 * Codifica digitos (quantidade par) em CODE-128C.
 * Devolve a sequencia de larguras em modulos, alternando barra e espaco,
 * comecando por barra.
 */
export function code128c(digitos) {
  const texto = String(digitos).replace(/\D/g, "");
  if (!texto.length || texto.length % 2) throw new Error("CODE-128C exige quantidade par de digitos");
  const valores = [];
  for (let i = 0; i < texto.length; i += 2) valores.push(Number(texto.slice(i, i + 2)));
  let soma = INICIO_C;
  valores.forEach((valor, indice) => { soma += valor * (indice + 1); });
  const simbolos = [INICIO_C, ...valores, soma % 103, PARADA];
  return simbolos.flatMap((simbolo) => PADROES.at(simbolo).split("").map(Number));
}

// ---------------------------------------------------------------- desenho

function formatarChave(chave) {
  return String(chave).replace(/(\d{4})(?=\d)/g, "$1 ");
}

function formatarDoc(doc) {
  const d = String(doc || "").replace(/\D/g, "");
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5");
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
  return d || "-";
}

function moeda(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function quantidade(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

function dataBr(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/);
  if (!m) return { data: "-", hora: "-" };
  return { data: m[3] + "/" + m[2] + "/" + m[1], hora: m[4] ? m[4] + ":" + m[5] + ":" + m[6] : "-" };
}

/** Pagina com helpers de caixa rotulada, texto ajustado e codigo de barras. */
async function novaFolha() {
  const { PDFLib, fontkit, arimo, arimoBold } = carregar();
  const pdf = await PDFLib.PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const fonte = await pdf.embedFont(arimo, { subset: false });
  const negrito = await pdf.embedFont(arimoBold, { subset: false });
  const preto = PDFLib.rgb(0, 0, 0);
  const cinza = PDFLib.rgb(0.35, 0.35, 0.35);
  const A4 = [595.28, 841.89];
  const M = 18;
  const largura = A4[0] - 2 * M;

  const ctx = { pdf, fonte, negrito, preto, cinza, PDFLib, M, largura, A4, paginas: [] };

  ctx.pagina = () => {
    const pagina = pdf.addPage(A4);
    ctx.paginas.push(pagina);
    ctx.atual = pagina;
    return pagina;
  };

  // y medido do topo da folha, como num leiaute impresso.
  const Y = (y) => A4[1] - y;

  ctx.ajustar = (texto, tamanho, maximo, f = fonte) => {
    let saida = String(texto ?? "");
    if (f.widthOfTextAtSize(saida, tamanho) <= maximo) return saida;
    while (saida.length > 1 && f.widthOfTextAtSize(saida + "...", tamanho) > maximo) saida = saida.slice(0, -1);
    return saida + "...";
  };

  ctx.linhas = (texto, tamanho, maximo, f = fonte) => {
    const palavras = String(texto ?? "").split(/\s+/).filter(Boolean);
    const saida = [];
    let linha = "";
    for (const palavra of palavras) {
      const teste = linha ? linha + " " + palavra : palavra;
      if (f.widthOfTextAtSize(teste, tamanho) <= maximo) linha = teste;
      else { if (linha) saida.push(linha); linha = ctx.ajustar(palavra, tamanho, maximo, f); }
    }
    if (linha) saida.push(linha);
    return saida;
  };

  ctx.texto = (texto, x, y, { tamanho = 7, f = fonte, cor = preto, maximo = null, alinhar = "esquerda" } = {}) => {
    const t = maximo ? ctx.ajustar(texto, tamanho, maximo, f) : String(texto ?? "");
    const w = f.widthOfTextAtSize(t, tamanho);
    const xx = alinhar === "direita" ? x - w : alinhar === "centro" ? x - w / 2 : x;
    ctx.atual.drawText(t, { x: xx, y: Y(y), size: tamanho, font: f, color: cor });
  };

  ctx.retangulo = (x, y, w, h, { espessura = 0.6, tracejado = false } = {}) => {
    ctx.atual.drawRectangle({ x, y: Y(y + h), width: w, height: h, borderColor: preto, borderWidth: espessura,
      borderDashArray: tracejado ? [3, 2] : undefined });
  };

  ctx.linha = (x1, y1, x2, y2, { espessura = 0.6, tracejado = false } = {}) => {
    ctx.atual.drawLine({ start: { x: x1, y: Y(y1) }, end: { x: x2, y: Y(y2) }, thickness: espessura, color: preto,
      dashArray: tracejado ? [3, 2] : undefined });
  };

  /** Caixa com rotulo pequeno no alto e valor embaixo, como no DANFE. */
  ctx.caixa = (x, y, w, h, rotulo, valor, { alinhar = "esquerda", tamanho = 7.5, negritoValor = false } = {}) => {
    ctx.retangulo(x, y, w, h);
    ctx.texto(String(rotulo).toUpperCase(), x + 2, y + 6.5, { tamanho: 5.2, cor: cinza, maximo: w - 4 });
    const xv = alinhar === "direita" ? x + w - 2 : alinhar === "centro" ? x + w / 2 : x + 2;
    ctx.texto(valor ?? "-", xv, y + h - 3, { tamanho, f: negritoValor ? negrito : fonte, maximo: w - 4, alinhar });
  };

  ctx.titulo = (x, y, texto) => {
    ctx.texto(texto, x, y + 7, { tamanho: 6.5, f: negrito });
  };

  ctx.codigoBarras = (digitos, x, y, w, h) => {
    const modulos = code128c(digitos);
    const total = modulos.reduce((a, b) => a + b, 0) + 20;
    const largura = w / total;
    let cursor = x + 10 * largura;
    modulos.forEach((m, indice) => {
      if (indice % 2 === 0) ctx.atual.drawRectangle({ x: cursor, y: Y(y + h), width: m * largura, height: h, color: preto });
      cursor += m * largura;
    });
  };

  ctx.marcaDagua = (texto) => {
    if (!texto) return;
    for (const pagina of ctx.paginas) {
      const tamanho = 70;
      const w = negrito.widthOfTextAtSize(texto, tamanho);
      pagina.drawText(texto, {
        x: A4[0] / 2 - (w * Math.cos(Math.PI / 5)) / 2, y: A4[1] / 2 - (w * Math.sin(Math.PI / 5)) / 2,
        size: tamanho, font: negrito, color: PDFLib.rgb(0.85, 0.2, 0.2), opacity: 0.28,
        rotate: PDFLib.degrees(36)
      });
    }
  };

  /** "FOLHA n/total"; a primeira folha tem canhoto, entao a posicao muda. */
  ctx.numerarFolhas = (x, yPrimeira, yDemais, campo = "FOLHA") => {
    const total = ctx.paginas.length;
    ctx.paginas.forEach((pagina, indice) => {
      const texto = campo + " " + (indice + 1) + "/" + total;
      const w = negrito.widthOfTextAtSize(texto, 7.5);
      pagina.drawText(texto, { x: x - w / 2, y: Y(indice === 0 ? yPrimeira : yDemais), size: 7.5, font: negrito, color: preto });
    });
  };

  ctx.salvar = async () => Buffer.from(await pdf.save());
  return ctx;
}

// -------------------------------------------------------------------- DANFE

function lerNfe(xml) {
  const doc = parseXml(xml);
  const inf = deep(doc, "infNFe");
  if (!inf) throw new Error("XML nao e uma NF-e");
  const ide = deep(inf, "ide");
  const emit = deep(inf, "emit");
  const enderEmit = deep(emit, "enderEmit");
  const dest = deep(inf, "dest");
  const enderDest = deep(dest, "enderDest");
  const tot = deep(inf, "ICMSTot");
  const transp = deep(inf, "transp");
  const transporta = deep(transp, "transporta");
  const vol = deep(transp, "vol");
  const prot = deep(doc, "infProt");
  const adic = deep(inf, "infAdic");
  const endereco = (e) => [text(e, "xLgr"), text(e, "nro"), text(e, "xCpl")].filter(Boolean).join(", ");

  return {
    chave: String(inf.attrs.Id || "").replace(/\D/g, ""),
    modelo: text(ide, "mod"),
    numero: text(ide, "nNF"),
    serie: text(ide, "serie"),
    tpNF: text(ide, "tpNF"),
    tpAmb: text(ide, "tpAmb"),
    natureza: text(ide, "natOp"),
    emissao: text(ide, "dhEmi", "dEmi"),
    saida: text(ide, "dhSaiEnt", "dSaiEnt"),
    emitente: {
      nome: text(emit, "xNome"), fantasia: text(emit, "xFant"), cnpj: text(emit, "CNPJ", "CPF"),
      ie: text(emit, "IE"), iest: text(emit, "IEST"), endereco: endereco(enderEmit), bairro: text(enderEmit, "xBairro"),
      municipio: text(enderEmit, "xMun"), uf: text(enderEmit, "UF"), cep: text(enderEmit, "CEP"), fone: text(enderEmit, "fone")
    },
    destinatario: {
      nome: text(dest, "xNome"), doc: text(dest, "CNPJ", "CPF", "idEstrangeiro"), ie: text(dest, "IE"),
      endereco: endereco(enderDest), bairro: text(enderDest, "xBairro"), municipio: text(enderDest, "xMun"),
      uf: text(enderDest, "UF"), cep: text(enderDest, "CEP"), fone: text(enderDest, "fone")
    },
    totais: {
      vBC: num(tot, "vBC"), vICMS: num(tot, "vICMS"), vBCST: num(tot, "vBCST"), vST: num(tot, "vST"),
      vProd: num(tot, "vProd"), vFrete: num(tot, "vFrete"), vSeg: num(tot, "vSeg"), vDesc: num(tot, "vDesc"),
      vOutro: num(tot, "vOutro"), vIPI: num(tot, "vIPI"), vNF: num(tot, "vNF"), vTotTrib: num(tot, "vTotTrib")
    },
    transporte: {
      modFrete: text(transp, "modFrete"), nome: text(transporta, "xNome"), doc: text(transporta, "CNPJ", "CPF"),
      ie: text(transporta, "IE"), endereco: text(transporta, "xEnder"), municipio: text(transporta, "xMun"),
      uf: text(transporta, "UF"), placa: text(deep(transp, "veicTransp"), "placa"),
      qVol: text(vol, "qVol"), especie: text(vol, "esp"), marca: text(vol, "marca"), nVol: text(vol, "nVol"),
      pesoB: text(vol, "pesoB"), pesoL: text(vol, "pesoL")
    },
    itens: deepAll(inf, "det").map((det) => {
      const prod = deep(det, "prod");
      const imposto = deep(det, "imposto");
      const icms = deep(imposto, "ICMS")?.children[0] || null;
      const ipi = deep(deep(imposto, "IPI"), "IPITrib");
      return {
        codigo: text(prod, "cProd"), descricao: text(prod, "xProd"), ncm: text(prod, "NCM"),
        cst: (text(icms, "orig") || "") + (text(icms, "CST") || text(icms, "CSOSN")), cfop: text(prod, "CFOP"),
        unidade: text(prod, "uCom"), quantidade: num(prod, "qCom"), unitario: num(prod, "vUnCom"),
        total: num(prod, "vProd"), bcIcms: num(icms, "vBC"), vIcms: num(icms, "vICMS"), vIpi: num(ipi, "vIPI"),
        aliqIcms: num(icms, "pICMS"), aliqIpi: num(ipi, "pIPI")
      };
    }),
    protocolo: prot ? { numero: text(prot, "nProt"), quando: text(prot, "dhRecbto"), cStat: text(prot, "cStat") } : null,
    informacoes: [text(adic, "infAdFisco"), text(adic, "infCpl")].filter(Boolean).join(" ")
  };
}

const MOD_FRETE = { 0: "0-Emitente", 1: "1-Destinatario", 2: "2-Terceiros", 3: "3-Proprio rem.", 4: "4-Proprio dest.", 9: "9-Sem frete" };

export async function gerarDanfe(xml, { marcaDagua = "" } = {}) {
  const n = lerNfe(xml);
  const c = await novaFolha();
  const { M, largura } = c;
  const direita = M + largura;
  const emissao = dataBr(n.emissao);
  const saida = dataBr(n.saida);
  const numeroFmt = String(n.numero).padStart(9, "0").replace(/(\d{3})(\d{3})(\d{3})/, "$1.$2.$3");

  const cabecalho = (primeira) => {
    let y = M;
    if (primeira) {
      // Canhoto
      const wNum = 110;
      c.retangulo(M, y, largura - wNum, 18);
      c.texto("RECEBEMOS DE " + n.emitente.nome + " OS PRODUTOS E/OU SERVICOS CONSTANTES DA NOTA FISCAL ELETRONICA INDICADA AO LADO",
        M + 2, y + 7, { tamanho: 5.6, maximo: largura - wNum - 4 });
      c.caixa(M, y + 18, 120, 20, "Data de recebimento", "");
      c.caixa(M + 120, y + 18, largura - wNum - 120, 20, "Identificacao e assinatura do recebedor", "");
      c.retangulo(direita - wNum, y, wNum, 38);
      c.texto("NF-e", direita - wNum / 2, y + 12, { tamanho: 10, f: c.negrito, alinhar: "centro" });
      c.texto("No " + numeroFmt, direita - wNum / 2, y + 24, { tamanho: 8, f: c.negrito, alinhar: "centro" });
      c.texto("SERIE " + String(n.serie).padStart(3, "0"), direita - wNum / 2, y + 34, { tamanho: 8, f: c.negrito, alinhar: "centro" });
      y += 44;
      c.linha(M, y - 3, direita, y - 3, { tracejado: true });
    }

    // Emitente | DANFE | chave
    const wEmit = 222;
    const wDanfe = 108;
    const wChave = largura - wEmit - wDanfe;
    const h = 108;
    c.retangulo(M, y, wEmit, h);
    c.texto("IDENTIFICACAO DO EMITENTE", M + 3, y + 8, { tamanho: 5.2, cor: c.cinza });
    let yy = y + 24;
    for (const linha of c.linhas(n.emitente.nome, 10, wEmit - 8, c.negrito).slice(0, 2)) {
      c.texto(linha, M + wEmit / 2, yy, { tamanho: 10, f: c.negrito, alinhar: "centro" });
      yy += 12;
    }
    yy += 4;
    for (const linha of [n.emitente.endereco, [n.emitente.bairro, n.emitente.cep ? "CEP " + n.emitente.cep : ""].filter(Boolean).join(" - "),
      [n.emitente.municipio, n.emitente.uf].filter(Boolean).join(" - "), n.emitente.fone ? "Fone: " + n.emitente.fone : ""]) {
      if (!linha) continue;
      c.texto(linha, M + wEmit / 2, yy, { tamanho: 7, alinhar: "centro", maximo: wEmit - 8 });
      yy += 9;
    }

    const xd = M + wEmit;
    c.retangulo(xd, y, wDanfe, h);
    c.texto("DANFE", xd + wDanfe / 2, y + 16, { tamanho: 14, f: c.negrito, alinhar: "centro" });
    c.texto("Documento Auxiliar da", xd + wDanfe / 2, y + 27, { tamanho: 6.5, alinhar: "centro" });
    c.texto("Nota Fiscal Eletronica", xd + wDanfe / 2, y + 35, { tamanho: 6.5, alinhar: "centro" });
    c.texto("0 - ENTRADA", xd + 8, y + 50, { tamanho: 6.5 });
    c.texto("1 - SAIDA", xd + 8, y + 59, { tamanho: 6.5 });
    c.retangulo(xd + wDanfe - 28, y + 44, 18, 18);
    c.texto(n.tpNF || "-", xd + wDanfe - 19, y + 57, { tamanho: 11, f: c.negrito, alinhar: "centro" });
    c.texto("No " + numeroFmt, xd + wDanfe / 2, y + 76, { tamanho: 8.5, f: c.negrito, alinhar: "centro" });
    c.texto("SERIE " + String(n.serie).padStart(3, "0"), xd + wDanfe / 2, y + 87, { tamanho: 8, f: c.negrito, alinhar: "centro" });

    const xc = xd + wDanfe;
    c.retangulo(xc, y, wChave, 42);
    c.codigoBarras(n.chave, xc + 4, y + 5, wChave - 8, 32);
    c.caixa(xc, y + 42, wChave, 22, "Chave de acesso", formatarChave(n.chave), { alinhar: "centro", tamanho: 8, negritoValor: true });
    c.retangulo(xc, y + 64, wChave, h - 64);
    c.texto("Consulta de autenticidade no portal nacional da NF-e", xc + wChave / 2, y + 80, { tamanho: 7, alinhar: "centro" });
    c.texto("www.nfe.fazenda.gov.br/portal ou no site da Sefaz autorizadora", xc + wChave / 2, y + 90, { tamanho: 7, alinhar: "centro" });

    y += h;
    const protocolo = n.protocolo
      ? n.protocolo.numero + " - " + dataBr(n.protocolo.quando).data + " " + dataBr(n.protocolo.quando).hora
      : "-";
    c.caixa(M, y, wEmit + wDanfe, 20, "Natureza da operacao", n.natureza);
    c.caixa(xc, y, wChave, 20, "Protocolo de autorizacao de uso", protocolo, { alinhar: "centro" });
    y += 20;
    const terco = largura / 3;
    c.caixa(M, y, terco, 20, "Inscricao estadual", n.emitente.ie);
    c.caixa(M + terco, y, terco, 20, "Inscricao estadual do subst. tribut.", n.emitente.iest);
    c.caixa(M + 2 * terco, y, terco, 20, "CNPJ", formatarDoc(n.emitente.cnpj));
    return y + 20;
  };

  c.pagina();
  let y = cabecalho(true);

  // Destinatario / remetente
  c.titulo(M, y + 2, "DESTINATARIO / REMETENTE");
  y += 11;
  c.caixa(M, y, largura - 190, 20, "Nome / razao social", n.destinatario.nome);
  c.caixa(direita - 190, y, 110, 20, "CNPJ / CPF", formatarDoc(n.destinatario.doc));
  c.caixa(direita - 80, y, 80, 20, "Data da emissao", emissao.data, { alinhar: "centro" });
  y += 20;
  c.caixa(M, y, largura - 270, 20, "Endereco", n.destinatario.endereco);
  c.caixa(direita - 270, y, 130, 20, "Bairro / distrito", n.destinatario.bairro);
  c.caixa(direita - 140, y, 60, 20, "CEP", n.destinatario.cep, { alinhar: "centro" });
  c.caixa(direita - 80, y, 80, 20, "Data da saida/entrada", saida.data, { alinhar: "centro" });
  y += 20;
  c.caixa(M, y, largura - 290, 20, "Municipio", n.destinatario.municipio);
  c.caixa(direita - 290, y, 90, 20, "Fone / fax", n.destinatario.fone);
  c.caixa(direita - 200, y, 30, 20, "UF", n.destinatario.uf, { alinhar: "centro" });
  c.caixa(direita - 170, y, 90, 20, "Inscricao estadual", n.destinatario.ie);
  c.caixa(direita - 80, y, 80, 20, "Hora da saida", saida.hora, { alinhar: "centro" });
  y += 24;

  // Calculo do imposto
  c.titulo(M, y, "CALCULO DO IMPOSTO");
  y += 9;
  const sexto = largura / 6;
  const t = n.totais;
  [["Base de calc. do ICMS", t.vBC], ["Valor do ICMS", t.vICMS], ["Base de calc. ICMS S.T.", t.vBCST],
    ["Valor do ICMS subst.", t.vST], ["V. aprox. tributos", t.vTotTrib], ["V. total produtos", t.vProd]]
    .forEach(([rotulo, valor], i) => c.caixa(M + i * sexto, y, sexto, 20, rotulo, moeda(valor), { alinhar: "direita" }));
  y += 20;
  [["Valor do frete", t.vFrete], ["Valor do seguro", t.vSeg], ["Desconto", t.vDesc], ["Outras despesas", t.vOutro],
    ["Valor total IPI", t.vIPI], ["V. total da nota", t.vNF]]
    .forEach(([rotulo, valor], i) => c.caixa(M + i * sexto, y, sexto, 20, rotulo, moeda(valor),
      { alinhar: "direita", negritoValor: i === 5 }));
  y += 24;

  // Transportador
  const tr = n.transporte;
  c.titulo(M, y, "TRANSPORTADOR / VOLUMES TRANSPORTADOS");
  y += 9;
  c.caixa(M, y, largura - 300, 20, "Nome / razao social", tr.nome);
  c.caixa(direita - 300, y, 90, 20, "Frete por conta", MOD_FRETE[tr.modFrete] || tr.modFrete);
  c.caixa(direita - 210, y, 70, 20, "Placa do veiculo", tr.placa, { alinhar: "centro" });
  c.caixa(direita - 140, y, 30, 20, "UF", tr.uf, { alinhar: "centro" });
  c.caixa(direita - 110, y, 110, 20, "CNPJ / CPF", formatarDoc(tr.doc));
  y += 20;
  [["Quantidade", tr.qVol], ["Especie", tr.especie], ["Marca", tr.marca], ["Numeracao", tr.nVol],
    ["Peso bruto", tr.pesoB], ["Peso liquido", tr.pesoL]]
    .forEach(([rotulo, valor], i) => c.caixa(M + i * sexto, y, sexto, 20, rotulo, valor || "-"));
  y += 24;

  // Produtos
  const colunas = [
    ["Codigo", 42, "esquerda"], ["Descricao do produto / servico", 0, "esquerda"], ["NCM/SH", 38, "centro"],
    ["CST", 22, "centro"], ["CFOP", 24, "centro"], ["UN", 20, "centro"], ["Quant.", 38, "direita"],
    ["Valor unit.", 42, "direita"], ["Valor total", 44, "direita"], ["BC ICMS", 40, "direita"],
    ["Valor ICMS", 38, "direita"], ["Valor IPI", 32, "direita"], ["Aliq. ICMS", 24, "direita"], ["Aliq. IPI", 22, "direita"]
  ];
  const fixas = colunas.reduce((acc, col) => acc + col[1], 0);
  colunas[1][1] = largura - fixas;
  const RODAPE = 80;
  const ALTURA_LINHA = 9;

  const cabecalhoTabela = (yy) => {
    c.titulo(M, yy, "DADOS DOS PRODUTOS / SERVICOS");
    yy += 9;
    let x = M;
    for (const [rotulo, w] of colunas) {
      c.retangulo(x, yy, w, 14);
      c.texto(rotulo.toUpperCase(), x + w / 2, yy + 9, { tamanho: 4.8, alinhar: "centro", maximo: w - 2 });
      x += w;
    }
    return yy + 14;
  };

  y = cabecalhoTabela(y);
  const limite = () => c.A4[1] - M - (c.paginas.length === 1 ? RODAPE : 0);
  for (const item of n.itens) {
    const descricao = c.linhas(item.descricao, 6, colunas[1][1] - 4).slice(0, 3);
    const altura = Math.max(1, descricao.length) * ALTURA_LINHA + 2;
    if (y + altura > limite()) {
      c.pagina();
      y = cabecalho(false);
      y = cabecalhoTabela(y + 4);
    }
    const valores = [item.codigo, null, item.ncm, item.cst, item.cfop, item.unidade, quantidade(item.quantidade),
      moeda(item.unitario), moeda(item.total), moeda(item.bcIcms), moeda(item.vIcms), moeda(item.vIpi),
      item.aliqIcms ? moeda(item.aliqIcms) : "", item.aliqIpi ? moeda(item.aliqIpi) : ""];
    let x = M;
    colunas.forEach(([, w, alinhar], i) => {
      c.linha(x, y, x, y + altura, { espessura: 0.3 });
      if (i === 1) {
        descricao.forEach((linha, j) => c.texto(linha, x + 2, y + 7 + j * ALTURA_LINHA, { tamanho: 6 }));
      } else {
        const xv = alinhar === "direita" ? x + w - 2 : alinhar === "centro" ? x + w / 2 : x + 2;
        c.texto(valores[i], xv, y + 7, { tamanho: 6, alinhar, maximo: w - 3 });
      }
      x += w;
    });
    c.linha(direita, y, direita, y + altura, { espessura: 0.3 });
    c.linha(M, y + altura, direita, y + altura, { espessura: 0.3 });
    y += altura;
  }

  // Dados adicionais no rodape da primeira folha
  const primeira = c.paginas[0];
  c.atual = primeira;
  const yAdic = c.A4[1] - M - RODAPE + 6;
  c.titulo(M, yAdic - 2, "DADOS ADICIONAIS");
  c.retangulo(M, yAdic + 7, largura * 0.66, RODAPE - 13);
  c.texto("INFORMACOES COMPLEMENTARES", M + 2, yAdic + 13.5, { tamanho: 5.2, cor: c.cinza });
  c.linhas(n.informacoes || "-", 6.2, largura * 0.66 - 6).slice(0, 7)
    .forEach((linha, i) => c.texto(linha, M + 3, yAdic + 22 + i * 7.5, { tamanho: 6.2 }));
  c.retangulo(M + largura * 0.66, yAdic + 7, largura * 0.34, RODAPE - 13);
  c.texto("RESERVADO AO FISCO", M + largura * 0.66 + 2, yAdic + 13.5, { tamanho: 5.2, cor: c.cinza });

  // Quadro do DANFE: x central da caixa (emitente 222 + metade de 108), y na ultima linha dela.
  c.numerarFolhas(M + 222 + 54, M + 44 + 99, M + 99);
  c.marcaDagua(marcaDagua || (n.tpAmb === "2" ? "SEM VALOR FISCAL" : ""));
  return c.salvar();
}

// -------------------------------------------------------------------- DACTE

function lerCte(xml) {
  const doc = parseXml(xml);
  const inf = deep(doc, "infCte");
  if (!inf) throw new Error("XML nao e um CT-e");
  const ide = deep(inf, "ide");
  const parte = (nome) => {
    const no = inf.children.find((filho) => filho.name === nome) || null;
    const ender = no ? (deep(no, "ender" + nome[0].toUpperCase() + nome.slice(1)) || deep(no, "enderReme") || deep(no, "enderDest")) : null;
    return no ? {
      nome: text(no, "xNome"), doc: text(no, "CNPJ", "CPF"), ie: text(no, "IE"),
      endereco: [text(ender, "xLgr"), text(ender, "nro")].filter(Boolean).join(", "),
      municipio: text(ender, "xMun"), uf: text(ender, "UF"), cep: text(ender, "CEP")
    } : null;
  };
  const emit = deep(inf, "emit");
  const enderEmit = deep(emit, "enderEmit");
  const vPrest = deep(inf, "vPrest");
  const icms = deep(deep(inf, "imp"), "ICMS")?.children[0] || null;
  const carga = deep(inf, "infCarga");
  const prot = deep(doc, "infProt");
  const tomaCodigo = text(deep(ide, "toma3") || deep(ide, "toma03"), "toma");
  const tomaNome = { 0: "Remetente", 1: "Expedidor", 2: "Recebedor", 3: "Destinatario" }[tomaCodigo] || (deep(ide, "toma4") ? "Outros" : "-");
  return {
    chave: String(inf.attrs.Id || "").replace(/\D/g, ""),
    numero: text(ide, "nCT"), serie: text(ide, "serie"), tpAmb: text(ide, "tpAmb"),
    emissao: text(ide, "dhEmi"), cfop: text(ide, "CFOP"), natureza: text(ide, "natOp"),
    tipoCte: { 0: "Normal", 1: "Complementar", 2: "Anulacao", 3: "Substituto" }[text(ide, "tpCTe")] || "-",
    tipoServico: { 0: "Normal", 1: "Subcontratacao", 2: "Redespacho", 3: "Redespacho intermediario", 4: "Multimodal" }[text(ide, "tpServ")] || "-",
    modal: { "01": "Rodoviario", "02": "Aereo", "03": "Aquaviario", "04": "Ferroviario", "05": "Dutoviario", "06": "Multimodal" }[text(ide, "modal")] || "-",
    inicio: [text(ide, "xMunIni"), text(ide, "UFIni")].filter(Boolean).join(" - "),
    fim: [text(ide, "xMunFim"), text(ide, "UFFim")].filter(Boolean).join(" - "),
    tomador: tomaNome,
    emitente: {
      nome: text(emit, "xNome"), cnpj: text(emit, "CNPJ"), ie: text(emit, "IE"),
      endereco: [text(enderEmit, "xLgr"), text(enderEmit, "nro")].filter(Boolean).join(", "),
      municipio: [text(enderEmit, "xMun"), text(enderEmit, "UF")].filter(Boolean).join(" - "), cep: text(enderEmit, "CEP"),
      fone: text(enderEmit, "fone")
    },
    remetente: parte("rem"), destinatario: parte("dest"), expedidor: parte("exped"), recebedor: parte("receb"),
    componentes: deepAll(vPrest, "Comp").map((comp) => ({ nome: text(comp, "xNome"), valor: num(comp, "vComp") })),
    valorTotal: num(vPrest, "vTPrest"), valorReceber: num(vPrest, "vRec"),
    imposto: { cst: text(icms, "CST"), base: num(icms, "vBC"), aliquota: num(icms, "pICMS"), valor: num(icms, "vICMS") },
    carga: { produto: text(carga, "proPred"), valor: num(carga, "vCarga") },
    observacoes: text(deep(inf, "compl"), "xObs"),
    protocolo: prot ? { numero: text(prot, "nProt"), quando: text(prot, "dhRecbto") } : null
  };
}

export async function gerarDacte(xml, { marcaDagua = "" } = {}) {
  const n = lerCte(xml);
  const c = await novaFolha();
  const { M, largura } = c;
  const direita = M + largura;
  const emissao = dataBr(n.emissao);
  c.pagina();

  let y = M;
  const wEmit = 230;
  const wTitulo = 120;
  const wChave = largura - wEmit - wTitulo;
  c.retangulo(M, y, wEmit, 92);
  let yy = y + 20;
  for (const linha of c.linhas(n.emitente.nome, 10, wEmit - 8, c.negrito).slice(0, 2)) {
    c.texto(linha, M + wEmit / 2, yy, { tamanho: 10, f: c.negrito, alinhar: "centro" });
    yy += 12;
  }
  for (const linha of [n.emitente.endereco, n.emitente.municipio, "CNPJ " + formatarDoc(n.emitente.cnpj) + "  IE " + (n.emitente.ie || "-")]) {
    if (!linha) continue;
    c.texto(linha, M + wEmit / 2, yy + 4, { tamanho: 7, alinhar: "centro", maximo: wEmit - 8 });
    yy += 9;
  }
  const xt = M + wEmit;
  c.retangulo(xt, y, wTitulo, 92);
  c.texto("DACTE", xt + wTitulo / 2, y + 18, { tamanho: 14, f: c.negrito, alinhar: "centro" });
  c.texto("Documento Auxiliar do", xt + wTitulo / 2, y + 30, { tamanho: 6.5, alinhar: "centro" });
  c.texto("Conhecimento de Transporte Eletronico", xt + wTitulo / 2, y + 38, { tamanho: 6, alinhar: "centro" });
  c.texto("MODELO 57   SERIE " + n.serie, xt + wTitulo / 2, y + 54, { tamanho: 7, f: c.negrito, alinhar: "centro" });
  c.texto("No " + n.numero, xt + wTitulo / 2, y + 66, { tamanho: 9, f: c.negrito, alinhar: "centro" });
  c.texto("Emissao " + emissao.data + " " + emissao.hora, xt + wTitulo / 2, y + 80, { tamanho: 6.5, alinhar: "centro" });
  const xc = xt + wTitulo;
  c.retangulo(xc, y, wChave, 40);
  c.codigoBarras(n.chave, xc + 4, y + 4, wChave - 8, 32);
  c.caixa(xc, y + 40, wChave, 22, "Chave de acesso", formatarChave(n.chave), { alinhar: "centro", tamanho: 7, negritoValor: true });
  const protocolo = n.protocolo ? n.protocolo.numero + " - " + dataBr(n.protocolo.quando).data + " " + dataBr(n.protocolo.quando).hora : "-";
  c.caixa(xc, y + 62, wChave, 30, "Protocolo de autorizacao de uso", protocolo, { alinhar: "centro" });
  y += 92;

  const quarto = largura / 4;
  c.caixa(M, y, quarto, 20, "Modal", n.modal);
  c.caixa(M + quarto, y, quarto, 20, "Tipo do CT-e", n.tipoCte);
  c.caixa(M + 2 * quarto, y, quarto, 20, "Tipo do servico", n.tipoServico);
  c.caixa(M + 3 * quarto, y, quarto, 20, "Tomador do servico", n.tomador);
  y += 20;
  c.caixa(M, y, largura, 20, "CFOP - natureza da prestacao", [n.cfop, n.natureza].filter(Boolean).join(" - "));
  y += 20;
  c.caixa(M, y, largura / 2, 20, "Inicio da prestacao", n.inicio);
  c.caixa(M + largura / 2, y, largura / 2, 20, "Termino da prestacao", n.fim);
  y += 24;

  const pessoa = (x, yy2, w, rotulo, p) => {
    c.retangulo(x, yy2, w, 58);
    c.texto(rotulo, x + 2, yy2 + 7, { tamanho: 5.6, f: c.negrito });
    const linhas = p ? [p.nome, p.endereco, [p.municipio, p.uf].filter(Boolean).join(" - ") + (p.cep ? "  CEP " + p.cep : ""),
      "CNPJ/CPF " + formatarDoc(p.doc) + "   IE " + (p.ie || "-")] : ["-"];
    linhas.forEach((linha, i) => c.texto(linha || "-", x + 3, yy2 + 18 + i * 10, { tamanho: i === 0 ? 7.5 : 6.8, f: i === 0 ? c.negrito : c.fonte, maximo: w - 6 }));
  };
  pessoa(M, y, largura / 2, "REMETENTE", n.remetente);
  pessoa(M + largura / 2, y, largura / 2, "DESTINATARIO", n.destinatario);
  y += 58;
  if (n.expedidor || n.recebedor) {
    pessoa(M, y, largura / 2, "EXPEDIDOR", n.expedidor);
    pessoa(M + largura / 2, y, largura / 2, "RECEBEDOR", n.recebedor);
    y += 58;
  }
  y += 4;
  c.caixa(M, y, largura * 0.7, 20, "Produto predominante", n.carga.produto);
  c.caixa(M + largura * 0.7, y, largura * 0.3, 20, "Valor total da carga", moeda(n.carga.valor), { alinhar: "direita" });
  y += 24;

  c.titulo(M, y, "COMPONENTES DO VALOR DA PRESTACAO DO SERVICO");
  y += 9;
  const comps = n.componentes.length ? n.componentes : [{ nome: "-", valor: 0 }];
  const porLinha = 4;
  const wComp = (largura - 160) / porLinha;
  const linhasComp = Math.ceil(comps.length / porLinha);
  comps.forEach((comp, i) => {
    c.caixa(M + (i % porLinha) * wComp, y + Math.floor(i / porLinha) * 20, wComp, 20, comp.nome, moeda(comp.valor), { alinhar: "direita" });
  });
  c.caixa(direita - 160, y, 160, 20, "Valor total do servico", moeda(n.valorTotal), { alinhar: "direita", negritoValor: true });
  c.caixa(direita - 160, y + 20, 160, 20, "Valor a receber", moeda(n.valorReceber), { alinhar: "direita" });
  y += Math.max(2, linhasComp) * 20 + 4;

  c.titulo(M, y, "INFORMACOES RELATIVAS AO IMPOSTO");
  y += 9;
  const q = largura / 4;
  c.caixa(M, y, q, 20, "Situacao tributaria (CST)", n.imposto.cst);
  c.caixa(M + q, y, q, 20, "Base de calculo", moeda(n.imposto.base), { alinhar: "direita" });
  c.caixa(M + 2 * q, y, q, 20, "Aliquota do ICMS", n.imposto.aliquota ? moeda(n.imposto.aliquota) : "-", { alinhar: "direita" });
  c.caixa(M + 3 * q, y, q, 20, "Valor do ICMS", moeda(n.imposto.valor), { alinhar: "direita" });
  y += 24;

  c.titulo(M, y, "OBSERVACOES");
  y += 9;
  c.retangulo(M, y, largura * 0.66, 70);
  c.linhas(n.observacoes || "-", 6.5, largura * 0.66 - 6).slice(0, 8).forEach((linha, i) => c.texto(linha, M + 3, y + 10 + i * 8, { tamanho: 6.5 }));
  c.retangulo(M + largura * 0.66, y, largura * 0.34, 70);
  c.texto("RESERVADO AO FISCO", M + largura * 0.66 + 2, y + 7, { tamanho: 5.2, cor: c.cinza });

  c.marcaDagua(marcaDagua || (n.tpAmb === "2" ? "SEM VALOR FISCAL" : ""));
  return c.salvar();
}
