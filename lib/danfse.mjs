// Gera o DANFSe (PDF da NFS-e nacional) no servidor, com o MESMO codigo da
// extensao: vendor/danfse.cjs, copiado sem alteracao.
//
// O gerador da extensao le o XML com o DOMParser do navegador. Aqui ele recebe
// um adaptador minimo de DOM montado sobre lib/xml.mjs, com exatamente os
// metodos que ele usa: documentElement, firstElementChild, nextElementSibling,
// localName, textContent, getAttribute, children, parentNode,
// getElementsByTagName('*') e querySelector('parsererror').

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseXml } from "./xml.mjs";

const require = createRequire(import.meta.url);
const vendor = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor");

// ------------------------------------------------------------ DOM minimo

class Elemento {
  constructor(no, pai) {
    this.localName = no.name;
    this.nodeName = no.name;
    this.tagName = no.name;
    this.parentNode = pai;
    this._attrs = no.attrs || {};
    this._texto = no.text || "";
    this.nextElementSibling = null;
    this.children = [];
    let anterior = null;
    for (const filho of no.children) {
      const elemento = new Elemento(filho, this);
      if (anterior) anterior.nextElementSibling = elemento;
      this.children.push(elemento);
      anterior = elemento;
    }
    this.firstElementChild = this.children[0] || null;
  }

  get textContent() {
    return this._texto + this.children.map((filho) => filho.textContent).join("");
  }

  getAttribute(nome) {
    return Object.prototype.hasOwnProperty.call(this._attrs, nome) ? this._attrs[nome] : null;
  }

  getElementsByTagName(nome) {
    const saida = [];
    const pilha = [...this.children];
    while (pilha.length) {
      const atual = pilha.shift();
      if (nome === "*" || atual.localName === nome) saida.push(atual);
      pilha.push(...atual.children);
    }
    return saida;
  }

  querySelector(seletor) {
    return this.getElementsByTagName(seletor)[0] || null;
  }
}

class Documento {
  constructor(raiz, erro) {
    this._erro = erro;
    this.localName = undefined;
    this.documentElement = raiz ? new Elemento(raiz, this) : null;
  }

  querySelector(seletor) {
    if (seletor === "parsererror") return this._erro ? { textContent: this._erro } : null;
    return this.documentElement?.localName === seletor
      ? this.documentElement
      : this.documentElement?.querySelector(seletor) ?? null;
  }

  getElementsByTagName(nome) {
    if (!this.documentElement) return [];
    const proprio = nome === "*" || this.documentElement.localName === nome ? [this.documentElement] : [];
    return [...proprio, ...this.documentElement.getElementsByTagName(nome)];
  }
}

class DOMParserNode {
  parseFromString(texto) {
    try {
      const arvore = parseXml(texto);
      return new Documento(arvore.children[0], null);
    } catch (erro) {
      return new Documento(null, erro.message);
    }
  }
}

// --------------------------------------------------------- carregamento

let modulo = null;

function carregar() {
  if (modulo) return modulo;

  // As tabelas e o parser da extensao procuram estes nomes no escopo global.
  if (!globalThis.DOMParser) globalThis.DOMParser = DOMParserNode;
  const ibge = require(join(vendor, "ibge-municipios.cjs"));
  const nbs = require(join(vendor, "nbs-tabela.cjs"));
  globalThis.IBGE_MUNICIPIOS = ibge.IBGE_MUNICIPIOS;
  globalThis.IBGE_UF = ibge.IBGE_UF;
  globalThis.NBS_DESC = nbs.NBS_DESC;

  modulo = {
    danfse: require(join(vendor, "danfse.cjs")),
    deps: {
      PDFLib: require(join(vendor, "pdf-lib.cjs")),
      qrcode: require(join(vendor, "qrcode.cjs")),
      fontkit: require(join(vendor, "fontkit.cjs")),
      arimo: readFileSync(join(vendor, "fonts", "Arimo_400Regular.ttf")),
      arimoBold: readFileSync(join(vendor, "fonts", "Arimo_700Bold.ttf")),
      logoBytes: readFileSync(join(vendor, "nfse-logo.png"))
    }
  };
  return modulo;
}

/**
 * O quadro de contribuicoes retidas pela NT 008 v1.02 (14/07/2026).
 *
 * Com `tpRetPisCofins` 1 (PIS/COFINS Retido), o PIS e a COFINS RETIDOS estao no
 * `vPis` e no `vCofins`, e o `vRetCSLL` e so a CSLL. A NT manda o quadro
 * "Contribuicoes Sociais - Retidas" somar os tres e o "Debito Apuracao Propria"
 * de PIS e de COFINS imprimir zero. O gerador da extensao imprimia o `vRetCSLL`
 * sozinho e o `vPis`/`vCofins` como debito do prestador: a nota com R$ 46,50
 * retidos saia com R$ 10,00 retidos e R$ 36,50 de debito que ele nao tem.
 *
 * Fica aqui, e nao no `vendor/danfse.cjs`, porque aquele e copia da extensao e
 * se atualiza copiando de novo (vendor/LEIAME.md).
 */
export function retidasPelaNt008(dados) {
  const f = dados?.federal;
  if (!f || String(f.tpRetPisCofins ?? "").trim() !== "1") return dados;
  const numeros = [f.csll, f.pis, f.cofins].map((v) => Number(String(v ?? "").trim() || NaN)).filter((n) => !Number.isNaN(n));
  if (numeros.length) f.csll = numeros.reduce((a, b) => a + b, 0).toFixed(2);
  f.pis = "0.00";
  f.cofins = "0.00";
  return dados;
}

/**
 * XML da NFS-e nacional -> PDF (Buffer). Lanca se o XML nao for uma NFS-e nacional.
 * `marcaDagua` ("CANCELADA", "SUBSTITUIDA") vem dos eventos da nota.
 */
export async function gerarDanfse(xml, { marcaDagua = "" } = {}) {
  const { danfse, deps } = carregar();
  const dados = retidasPelaNt008(danfse.parseDanfse(String(xml)));
  if (!dados) throw new Error("XML nao e uma NFS-e nacional legivel para o DANFSe");
  if (marcaDagua) dados.marcaDagua = marcaDagua;
  const bytes = await danfse.buildDanfsePdf(dados, deps);
  return Buffer.from(bytes);
}

/** Dados que o gerador extrai do XML; util para conferir o parser. */
export function lerDadosDanfse(xml) {
  const { danfse } = carregar();
  return retidasPelaNt008(danfse.parseDanfse(String(xml)));
}

/** Le um evento (cancelamento, substituicao) e devolve a marca d'agua aplicavel. */
export function lerEvento(xml) {
  const { danfse } = carregar();
  return danfse.parseEvento ? danfse.parseEvento(String(xml)) : null;
}
