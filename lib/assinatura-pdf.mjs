// O que da para afirmar sobre a assinatura de um termo em PDF.
//
// A mesma regra da PONTE SEFAZ (src/webapp/termos/assinatura-digital.ts, F6 da
// revisao de 08/10/2026): o dono decidiu CONFERIR E MOSTRAR, SEM TRAVAR. O
// termo recebido fica guardado de qualquer jeito; a tela so diz "conferida"
// quando a maquina provou. Os resultados, do mais forte ao mais fraco:
//
//   icp-brasil  assinatura integra e a cadeia chega a uma raiz da ICP-Brasil
//               (assinatura qualificada, MP 2.200-2/2001);
//   gov-br      integra, e a cadeia chega a raiz do Governo Federal
//               (assinatura avancada do gov.br, Lei 14.063/2020);
//   integra     o arquivo nao mudou depois de assinado, mas o emissor do
//               certificado nao e um que se confira ate a raiz: a tela mostra
//               quem assinou e quem emitiu;
//   nao-confere tem assinatura e ela nao fecha (mudou depois, ou acrescentaram
//               conteudo depois de assinar);
//   manual      PDF sem assinatura digital: a conferencia e de quem olha.
//
// Aqui sem dependencia: um leitor DER minimo para o CMS (RFC 5652), e o
// X509Certificate e o crypto.verify do proprio Node.

import { createHash, verify as verificarAssinatura, X509Certificate } from "node:crypto";
import { RAIZES_ICP_BRASIL, RAIZ_GOV_BR, CADEIA_CONHECIDA_GOV_BR } from "./raizes-assinatura.mjs";

export const ROTULO_DA_CONFERENCIA = {
  "icp-brasil": "ASSINATURA DIGITAL CONFERIDA (ICP-BRASIL)",
  "gov-br": "ASSINATURA DIGITAL CONFERIDA (GOV.BR)",
  integra: "ASSINATURA DIGITAL ÍNTEGRA",
  "nao-confere": "ASSINATURA DIGITAL NÃO CONFERE",
  manual: "CONFERÊNCIA MANUAL"
};

const ALGORITMO_DO_HASH = {
  "1.3.14.3.2.26": "sha1",
  "2.16.840.1.101.3.4.2.1": "sha256",
  "2.16.840.1.101.3.4.2.2": "sha384",
  "2.16.840.1.101.3.4.2.3": "sha512"
};
const OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
const OID_SIGNING_TIME = "1.2.840.113549.1.9.5";
const OID_RSA_PSS = "1.2.840.113549.1.1.10";
// Outro nome do SAN no certificado ICP-Brasil: pessoa fisica (nascimento + CPF) e CNPJ da pessoa juridica.
const OID_DADOS_DA_PESSOA_FISICA = "2.16.76.1.3.1";
const OID_CNPJ = "2.16.76.1.3.3";

function resultado(nivel, motivo, extra = {}) {
  return { nivel, rotulo: ROTULO_DA_CONFERENCIA[nivel], motivo, ...extra };
}

// ------------------------------------------------------------- DER minimo

/** Um no TLV em `pos`. Aceita tamanho indefinido (BER), que alguns assinadores usam. */
function no(buf, pos) {
  const tag = buf[pos];
  let tamanho = buf[pos + 1];
  if (tag === undefined || tamanho === undefined) throw new Error("DER truncado");
  if (tamanho === 0x80) {
    let p = pos + 2;
    while (!(buf[p] === 0 && buf[p + 1] === 0)) {
      if (p >= buf.length) throw new Error("DER sem fim");
      p = no(buf, p).fim;
    }
    return { tag, inicio: pos + 2, fimConteudo: p, fim: p + 2, pos, buf };
  }
  let cabeca = 2;
  if (tamanho & 0x80) {
    const n = tamanho & 0x7f;
    if (n > 4) throw new Error("DER grande demais");
    tamanho = 0;
    for (let i = 0; i < n; i += 1) tamanho = tamanho * 256 + buf[pos + 2 + i];
    cabeca = 2 + n;
  }
  const inicio = pos + cabeca;
  const fim = inicio + tamanho;
  if (fim > buf.length) throw new Error("DER truncado");
  return { tag, inicio, fimConteudo: fim, fim, pos, buf };
}

function filhos(n) {
  const lista = [];
  for (let p = n.inicio; p < n.fimConteudo;) {
    const f = no(n.buf, p);
    lista.push(f);
    p = f.fim;
  }
  return lista;
}

const conteudo = (n) => n.buf.subarray(n.inicio, n.fimConteudo);
const bruto = (n) => n.buf.subarray(n.pos, n.fim);

function oidDe(n) {
  const b = conteudo(n);
  const partes = [Math.floor(b[0] / 40), b[0] % 40];
  let valor = 0;
  for (let i = 1; i < b.length; i += 1) {
    valor = valor * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) { partes.push(valor); valor = 0; }
  }
  return partes.join(".");
}

/** O texto de um no, descendo por [0] explicito e OCTET STRING. */
function textoDe(n) {
  if (n.tag & 0x20) return filhos(n).map(textoDe).join("");
  return conteudo(n).toString("latin1");
}

/** O valor que segue um OID dentro do certificado (outro nome do SAN), procurado em toda a arvore. */
function valorDoOid(der, oidProcurado) {
  let achado = null;
  const varrer = (n) => {
    if (achado !== null) return;
    if (!(n.tag & 0x20)) return;
    const lista = filhos(n);
    for (let i = 0; i < lista.length; i += 1) {
      const f = lista[i];
      if (f.tag === 0x06 && oidDe(f) === oidProcurado && lista[i + 1]) { achado = textoDe(lista[i + 1]); return; }
      try { varrer(f); } catch { /* ramo que nao e DER construido */ }
      if (achado !== null) return;
    }
  };
  try { varrer(no(der, 0)); } catch { /* certificado que nao se le: fica o CN */ }
  return achado;
}

function campoDoNome(nome, campo) {
  for (const linha of String(nome || "").split("\n")) {
    const i = linha.indexOf("=");
    if (i > 0 && linha.slice(0, i).trim() === campo) return linha.slice(i + 1).trim();
  }
  return "";
}

function cpfDo(cert, cn) {
  const digitos = String(valorDoOid(cert.raw, OID_DADOS_DA_PESSOA_FISICA) || "").replace(/\D/g, "");
  if (digitos.length >= 19 && !/^0+$/.test(digitos.slice(8, 19))) return digitos.slice(8, 19);
  const doCn = /:(\d{11})\s*$/.exec(cn)?.[1];
  if (doCn) return doCn;
  const serie = campoDoNome(cert.subject, "serialNumber").replace(/\D/g, "");
  return serie.length === 11 && !/^0+$/.test(serie) ? serie : undefined;
}

function cnpjDo(cert, cn) {
  const doSan = String(valorDoOid(cert.raw, OID_CNPJ) || "").replace(/\D/g, "");
  if (doSan.length === 14 && !/^0+$/.test(doSan)) return doSan;
  return /:(\d{14})\s*$/.exec(cn)?.[1];
}

// ------------------------------------------------------------ PDF e cadeia

/** A ultima assinatura do PDF: o /ByteRange e o CMS no buraco que ele deixa. */
function ultimaAssinaturaDoPdf(pdf) {
  const texto = pdf.toString("latin1");
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let ultima = null;
  for (let m = re.exec(texto); m; m = re.exec(texto)) ultima = m;
  if (!ultima) return null;
  const faixa = ultima.slice(1, 5).map(Number);
  const [, b, c] = faixa;
  if (!(b < c && c <= pdf.length)) return null;
  const buraco = texto.slice(b, c).trim();
  if (!buraco.startsWith("<") || !buraco.endsWith(">")) return null;
  const hex = buraco.slice(1, -1).replace(/\s+/g, "");
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2) return null;
  return { faixa, cms: Buffer.from(hex, "hex") };
}

let ancoras = null;
let caminhoConhecido = null;
function raizes() {
  if (!ancoras) {
    ancoras = [
      ...RAIZES_ICP_BRASIL.map((pem) => ({ cert: new X509Certificate(pem), qual: "icp-brasil" })),
      { cert: new X509Certificate(RAIZ_GOV_BR), qual: "gov-br" }
    ];
    caminhoConhecido = CADEIA_CONHECIDA_GOV_BR.map((pem) => new X509Certificate(pem));
  }
  return ancoras;
}

/** `c` foi assinado pela chave de `acima`? Chave que o Node nao abre e "nao". */
function assinadoPor(c, acima) {
  try { return c.checkIssued(acima) && c.verify(acima.publicKey); } catch { return false; }
}

/**
 * Sobe a cadeia ate uma raiz conhecida, degrau por degrau conferido pela chave
 * de quem esta acima: uma AC que so copie o NOME de uma raiz nao passa.
 */
function ancoraDaCadeia(folha, bolsa) {
  const conhecidas = raizes();
  const caminho = [...bolsa, ...caminhoConhecido];
  let atual = folha;
  for (let passo = 0; passo < 8; passo += 1) {
    for (const r of conhecidas) {
      if (atual.fingerprint256 === r.cert.fingerprint256 || assinadoPor(atual, r.cert)) return r.qual;
    }
    const acima = caminho.find((c) => c.fingerprint256 !== atual.fingerprint256 && assinadoPor(atual, c));
    if (!acima) return null;
    atual = acima;
  }
  return null;
}

/**
 * Confere a assinatura de um termo em PDF. Nunca lanca: arquivo que nao se deixa
 * ler vira "manual" ou "nao-confere" com o motivo. Com o CNPJ do cliente, diz
 * tambem se o certificado de quem assinou e de outra empresa.
 */
export function conferirAssinaturaDoTermo(bytes, { cnpjCliente = null } = {}) {
  const achada = ultimaAssinaturaDoPdf(bytes);
  if (!achada) return resultado("manual", "PDF sem assinatura digital: a conferência é de quem olha o papel.");
  const [a, b, c, d] = achada.faixa;
  const sobra = bytes.subarray(c + d).toString("latin1");
  if (a !== 0 || sobra.trim() !== "") {
    return resultado("nao-confere", "O arquivo recebeu conteúdo depois de assinado: a assinatura não cobre tudo o que está nele.");
  }
  const assinado = Buffer.concat([bytes.subarray(a, a + b), bytes.subarray(c, c + d)]);

  try {
    // ContentInfo { OID signedData, [0] SignedData { versao, digestAlgs, encap, [0] certificados?, [1] crls?, signerInfos } }
    const contentInfo = no(achada.cms, 0);
    const signedData = filhos(filhos(filhos(contentInfo)[1])[0]);
    const certificadosNo = signedData.find((n) => n.tag === 0xa0);
    const signerInfos = filhos(signedData[signedData.length - 1]);
    const signer = filhos(signerInfos[0]);
    const bolsa = (certificadosNo ? filhos(certificadosNo) : [])
      .map((n) => { try { return new X509Certificate(bruto(n)); } catch { return null; } })
      .filter(Boolean);

    const algoritmoDoHash = ALGORITMO_DO_HASH[oidDe(filhos(signer[2])[0])];
    if (!algoritmoDoHash) return resultado("nao-confere", "A assinatura usa um algoritmo de hash que o NÚCLEO não confere.");
    let i = 3;
    const atributosNo = signer[i]?.tag === 0xa0 ? signer[i++] : null;
    const algoritmoDaAssinatura = oidDe(filhos(signer[i++])[0]);
    const assinatura = Buffer.from(conteudo(signer[i]));
    if (algoritmoDaAssinatura === OID_RSA_PSS) {
      return resultado("nao-confere", "A assinatura usa RSA-PSS, que o NÚCLEO ainda não confere.");
    }

    const resumo = createHash(algoritmoDoHash).update(assinado).digest();
    let conteudoAssinado = assinado;
    let assinadoEm;
    if (atributosNo) {
      let resumoDeclarado = null;
      for (const at of filhos(atributosNo)) {
        const [oidNo, valores] = filhos(at);
        const oid = oidDe(oidNo);
        const valor = filhos(valores)[0];
        if (oid === OID_MESSAGE_DIGEST) resumoDeclarado = Buffer.from(conteudo(valor));
        if (oid === OID_SIGNING_TIME) {
          const t = conteudo(valor).toString("latin1");
          const m = /^(\d{2,4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(t);
          if (m) {
            const ano = m[1].length === 2 ? (Number(m[1]) < 50 ? 2000 : 1900) + Number(m[1]) : Number(m[1]);
            assinadoEm = new Date(Date.UTC(ano, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))).toISOString();
          }
        }
      }
      if (!resumoDeclarado || !resumoDeclarado.equals(resumo)) {
        return resultado("nao-confere", "O conteúdo do PDF não é o que foi assinado: o arquivo mudou depois da assinatura.");
      }
      // A assinatura e sobre os atributos recodificados como SET (RFC 5652, 5.4).
      const atributos = bruto(atributosNo);
      conteudoAssinado = Buffer.concat([Buffer.from([0x31]), atributos.subarray(1)]);
    }

    const quem = bolsa.find((cert) => {
      try { return verificarAssinatura(algoritmoDoHash, conteudoAssinado, cert.publicKey, assinatura); } catch { return false; }
    });
    if (!quem) return resultado("nao-confere", "A assinatura não confere com nenhum certificado que veio junto dela.");

    const cnCompleto = campoDoNome(quem.subject, "CN");
    const assinante = cnCompleto.replace(/:\d{11,14}\s*$/, "").trim() || cnCompleto;
    const cpf = cpfDo(quem, cnCompleto);
    const cnpj = cnpjDo(quem, cnCompleto);
    const emissor = campoDoNome(quem.issuer, "CN") || campoDoNome(quem.issuer, "O");
    const alvo = String(cnpjCliente || "").replace(/\D/g, "");
    // e-CNPJ do proprio cliente (ou da matriz dele): mesma raiz. e-CPF nao diz de qual empresa: fica null.
    const doCliente = cnpj && alvo.length === 14 ? cnpj.slice(0, 8) === alvo.slice(0, 8) : null;
    const extra = { assinante, ...(cpf ? { cpf } : {}), ...(cnpj ? { cnpj } : {}), ...(emissor ? { emissor } : {}),
      ...(assinadoEm ? { assinadoEm } : {}), doCliente,
      ...(doCliente === false ? { aviso: "Assinado com o certificado de outra empresa (CNPJ " + cnpj + "), não o do cliente." } : {}) };
    const ancora = ancoraDaCadeia(quem, bolsa);
    if (ancora === "icp-brasil") return resultado("icp-brasil", "Assinatura digital íntegra, com certificado da ICP-Brasil conferido até a raiz.", extra);
    if (ancora === "gov-br") {
      return resultado("gov-br", "Assinatura eletrônica avançada do gov.br, íntegra e conferida até a raiz do Governo Federal.", extra);
    }
    return resultado("integra", "Assinatura digital íntegra: o arquivo não mudou depois de assinado. O emissor do certificado (" +
      (emissor || "sem nome") + ") não é um que o NÚCLEO confira até a raiz: confira quem assinou.", extra);
  } catch {
    return resultado("nao-confere", "O PDF diz que é assinado, mas a assinatura não se deixa ler.");
  }
}
