// Assinatura XMLDSig no padrao da NF-e (Manual de Orientacao do Contribuinte):
// enveloped, C14N 1.0 inclusiva, RSA-SHA1, DigestValue em SHA-1 do elemento
// referenciado pelo atributo Id, certificado em X509Certificate.
//
// O XML assinado aqui e gerado por este sistema, ja compacto e sem prefixos,
// entao a forma canonica e conhecida: o elemento com o namespace padrao herdado
// declarado nele, atributos em ordem, tags de fechamento explicitas.
//
// Armadilha que derruba muita implementacao: na C14N inclusiva o namespace
// herdado do pai ENTRA no elemento canonico. O documento traz
// <infEvento Id="..."> dentro de <evento xmlns="...nfe">, mas o digest e
// calculado sobre <infEvento xmlns="...nfe" Id="...">.

import crypto from "node:crypto";

export const NS_NFE = "http://www.portalfiscal.inf.br/nfe";
export const NS_CTE = "http://www.portalfiscal.inf.br/cte";
const NS_DSIG = "http://www.w3.org/2000/09/xmldsig#";
const C14N = "http://www.w3.org/TR/2001/REC-xml-c14n-20010315";

export function escaparTexto(valor) {
  return String(valor ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\r/g, "&#xD;");
}

/** Insere o namespace herdado logo apos o nome do elemento (vem antes dos atributos na C14N). */
function comNamespace(elementoXml, nome, namespace) {
  const abertura = "<" + nome;
  if (!elementoXml.startsWith(abertura)) throw new Error("Elemento canonico deve comecar por " + abertura);
  if (elementoXml.startsWith(abertura + ' xmlns="')) return elementoXml;
  return abertura + ' xmlns="' + namespace + '"' + elementoXml.slice(abertura.length);
}

function signedInfo(id, digest) {
  return "<SignedInfo>" +
    '<CanonicalizationMethod Algorithm="' + C14N + '"></CanonicalizationMethod>' +
    '<SignatureMethod Algorithm="http://www.w3.org/2000/09/xmldsig#rsa-sha1"></SignatureMethod>' +
    '<Reference URI="#' + id + '"><Transforms>' +
    '<Transform Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"></Transform>' +
    '<Transform Algorithm="' + C14N + '"></Transform>' +
    "</Transforms>" +
    '<DigestMethod Algorithm="http://www.w3.org/2000/09/xmldsig#sha1"></DigestMethod>' +
    "<DigestValue>" + digest + "</DigestValue>" +
    "</Reference></SignedInfo>";
}

/**
 * Assina um elemento ja em forma compacta (sem o xmlns herdado).
 * @param {object} p
 * @param {string} p.elementoXml   ex. '<infEvento Id="ID2102...">...</infEvento>'
 * @param {string} p.nome          nome do elemento ("infEvento")
 * @param {string} p.id            valor do atributo Id
 * @param {string} p.namespace     namespace padrao herdado (NS_NFE)
 * @returns {string} o elemento <Signature> para ir logo apos o elemento assinado
 */
export function assinar({ elementoXml, nome, id, namespace = NS_NFE, chavePrivada, certificadoDer }) {
  const canonico = comNamespace(elementoXml, nome, namespace);
  const digest = crypto.createHash("sha1").update(canonico, "utf8").digest("base64");
  const info = signedInfo(id, digest);
  const infoCanonico = comNamespace(info, "SignedInfo", NS_DSIG);
  const valor = crypto.sign("RSA-SHA1", Buffer.from(infoCanonico, "utf8"), chavePrivada).toString("base64");
  return '<Signature xmlns="' + NS_DSIG + '">' + info +
    "<SignatureValue>" + valor + "</SignatureValue>" +
    "<KeyInfo><X509Data><X509Certificate>" + Buffer.from(certificadoDer).toString("base64") +
    "</X509Certificate></X509Data></KeyInfo></Signature>";
}

function trecho(xml, nome) {
  const inicio = xml.indexOf("<" + nome);
  const fimTag = "</" + nome + ">";
  const fim = xml.indexOf(fimTag, inicio);
  if (inicio < 0 || fim < 0) return null;
  return xml.slice(inicio, fim + fimTag.length);
}

/**
 * Confere uma assinatura gerada neste formato: digest do elemento e
 * assinatura do SignedInfo com a chave publica do certificado embutido.
 */
export function verificar(xml, { nome, namespace = NS_NFE }) {
  const elemento = trecho(xml, nome);
  const assinatura = trecho(xml, "Signature");
  if (!elemento || !assinatura) return { valido: false, motivo: "Elemento ou assinatura ausente" };

  const info = trecho(assinatura, "SignedInfo");
  const digestDeclarado = (info.match(/<DigestValue>([^<]+)<\/DigestValue>/) || [])[1];
  const valor = (assinatura.match(/<SignatureValue>([^<]+)<\/SignatureValue>/) || [])[1];
  const certificado = (assinatura.match(/<X509Certificate>([^<]+)<\/X509Certificate>/) || [])[1];
  const referencia = (info.match(/URI="#([^"]+)"/) || [])[1];
  const idElemento = (elemento.match(/\sId="([^"]+)"/) || [])[1];
  if (!digestDeclarado || !valor || !certificado) return { valido: false, motivo: "Assinatura incompleta" };
  if (referencia !== idElemento) return { valido: false, motivo: "Reference URI nao aponta para o Id do elemento" };

  const digest = crypto.createHash("sha1").update(comNamespace(elemento, nome, namespace), "utf8").digest("base64");
  if (digest !== digestDeclarado) return { valido: false, motivo: "DigestValue nao confere: o conteudo foi alterado" };

  const x509 = new crypto.X509Certificate(Buffer.from(certificado, "base64"));
  const ok = crypto.verify("RSA-SHA1", Buffer.from(comNamespace(info, "SignedInfo", NS_DSIG), "utf8"),
    x509.publicKey, Buffer.from(valor, "base64"));
  return ok
    ? { valido: true, motivo: "Assinatura valida", certificado: x509 }
    : { valido: false, motivo: "SignatureValue nao confere com o certificado" };
}
