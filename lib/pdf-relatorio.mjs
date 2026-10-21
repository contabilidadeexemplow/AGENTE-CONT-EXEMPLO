// Relatorio em PDF: uma tabela em A4 deitado, com titulo, linha de contexto,
// cabecalho repetido a cada pagina, linhas alternadas e "pagina X de Y". Usa
// o pdf-lib e a fonte Arimo ja vendorizados para o DANFE e o DANFSe.
//
// As colunas ganham largura pelo tamanho do que trazem (amostra das primeiras
// linhas), com teto, e o texto que nao cabe e cortado com reticencias: o PDF e
// para ler e imprimir; a planilha (Excel) e quem leva o dado inteiro.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

const LARGURA = 841.89;
const ALTURA = 595.28;
const MARGEM = 28;
const TAMANHO = 7;
const LINHA = 12;

function textoDe(valor) {
  if (valor === null || valor === undefined) return "";
  if (typeof valor === "object") return JSON.stringify(valor);
  return String(valor).replace(/\s+/g, " ").trim();
}

/** Corta o texto para caber na largura, com reticencias. */
function caber(texto, largura, fonte, tamanho) {
  let t = texto;
  if (fonte.widthOfTextAtSize(t, tamanho) <= largura) return t;
  while (t.length > 1 && fonte.widthOfTextAtSize(t + "…", tamanho) > largura) t = t.slice(0, -1);
  return t + "…";
}

/**
 * linhas: a primeira e o cabecalho. Devolve um Buffer com o PDF.
 */
export async function gerarPdfTabela({ titulo, subtitulo = "", linhas, marca = "NÚCLEO FISCAL" }) {
  const { PDFLib, fontkit, arimo, arimoBold } = carregar();
  const { PDFDocument, rgb } = PDFLib;
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(titulo);
  pdf.setProducer(marca);
  const fonte = await pdf.embedFont(arimo, { subset: true });
  const negrito = await pdf.embedFont(arimoBold, { subset: true });

  const cabecalho = (linhas[0] || []).map(textoDe);
  const corpo = linhas.slice(1).map((linha) => cabecalho.map((_, i) => textoDe(linha[i])));
  const util = LARGURA - 2 * MARGEM;
  const pesos = cabecalho.map((titulo, i) => {
    let maior = titulo.length;
    for (const linha of corpo.slice(0, 300)) maior = Math.max(maior, Math.min(48, linha[i].length));
    return Math.max(5, maior);
  });
  const soma = pesos.reduce((a, b) => a + b, 0) || 1;
  const larguras = pesos.map((peso) => util * peso / soma);

  const cinza = rgb(0.42, 0.44, 0.52);
  const tinta = rgb(0.09, 0.09, 0.17);
  const faixa = rgb(0.95, 0.95, 0.97);
  const borda = rgb(0.86, 0.87, 0.91);
  const primaria = rgb(0.29, 0.25, 0.88);

  const paginas = [];
  let pagina;
  let y;
  const novaPagina = () => {
    pagina = pdf.addPage([LARGURA, ALTURA]);
    paginas.push(pagina);
    y = ALTURA - MARGEM;
    pagina.drawText(caber(marca.toUpperCase(), util, negrito, 8), { x: MARGEM, y: y - 8, size: 8, font: negrito, color: primaria });
    pagina.drawText(caber(titulo, util - 120, negrito, 13), { x: MARGEM, y: y - 24, size: 13, font: negrito, color: tinta });
    if (subtitulo) pagina.drawText(caber(subtitulo, util, fonte, 8), { x: MARGEM, y: y - 37, size: 8, font: fonte, color: cinza });
    y -= 52;
    // cabecalho da tabela
    pagina.drawRectangle({ x: MARGEM, y: y - LINHA + 3, width: util, height: LINHA + 2, color: faixa, borderColor: borda, borderWidth: 0.5 });
    let x = MARGEM;
    cabecalho.forEach((texto, i) => {
      pagina.drawText(caber(texto.toUpperCase(), larguras[i] - 4, negrito, 6.5), { x: x + 2, y: y - 5, size: 6.5, font: negrito, color: cinza });
      x += larguras[i];
    });
    y -= LINHA + 4;
  };

  novaPagina();
  if (!corpo.length) {
    pagina.drawText("Nenhum registro.", { x: MARGEM, y: y - 6, size: 9, font: fonte, color: cinza });
  }
  corpo.forEach((linha, n) => {
    if (y - LINHA < MARGEM + 14) novaPagina();
    if (n % 2) pagina.drawRectangle({ x: MARGEM, y: y - LINHA + 4, width: util, height: LINHA, color: faixa });
    let x = MARGEM;
    linha.forEach((texto, i) => {
      if (texto) pagina.drawText(caber(texto, larguras[i] - 4, fonte, TAMANHO), { x: x + 2, y: y - 4, size: TAMANHO, font: fonte, color: tinta });
      x += larguras[i];
    });
    y -= LINHA;
  });

  paginas.forEach((pag, i) => {
    const rodape = corpo.length + " registro(s) · página " + (i + 1) + " de " + paginas.length;
    pag.drawLine({ start: { x: MARGEM, y: MARGEM + 6 }, end: { x: LARGURA - MARGEM, y: MARGEM + 6 }, thickness: 0.5, color: borda });
    pag.drawText(rodape, { x: LARGURA - MARGEM - fonte.widthOfTextAtSize(rodape, 7), y: MARGEM - 4, size: 7, font: fonte, color: cinza });
  });
  return Buffer.from(await pdf.save());
}
