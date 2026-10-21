// Certificados digitais A1 (arquivo .pfx / .p12).
//
// O .pfx e aberto por lib/pkcs12.mjs, em JavaScript, e daqui para frente o
// https/tls do Node so recebe PEM (key, cert, ca). Antes o .pfx ia cru para o
// tls.createSecureContext, e o A1 exportado pelo Windows (certificados em
// RC2-40) so abria com o processo rodando --openssl-legacy-provider: sem a
// opcao, o OpenSSL 3 recusava com "Unsupported PKCS12 PFX data" e o cadastro e
// a captura paravam. A opcao continua no `npm start`, mas nada aqui depende
// mais dela.

import tls from "node:tls";
import crypto from "node:crypto";
import { pfxParaPem, ErroPkcs12 } from "./pkcs12.mjs";

export const ERRO_SENHA = "CERTIFICADO_SENHA_INVALIDA";
export const ERRO_LEGADO = "CERTIFICADO_FORMATO_LEGADO";
export const ERRO_ARQUIVO = "CERTIFICADO_ARQUIVO_INVALIDO";

function falha(code, mensagem, comoResolver) {
  const erro = new Error(mensagem);
  erro.code = code;
  erro.comoResolver = comoResolver;
  return erro;
}

/**
 * Abre o A1 e devolve o PEM dele (ver pfxParaPem), com o erro ja traduzido
 * para o cadastro: ERRO_SENHA, ERRO_LEGADO ou ERRO_ARQUIVO.
 */
export function abrirA1(pfx, senha) {
  try {
    return pfxParaPem(pfx, String(senha ?? ""));
  } catch (erro) {
    if (erro instanceof ErroPkcs12 && erro.motivo === "senha") {
      throw falha(ERRO_SENHA, "Senha do certificado incorreta", "Confira a senha com o cliente.");
    }
    if (erro instanceof ErroPkcs12 && erro.motivo === "algoritmo") {
      throw falha(ERRO_LEGADO, erro.message,
        "Reexporte o certificado em formato moderno (AES-256) e envie de novo.");
    }
    throw falha(ERRO_ARQUIVO, "Arquivo nao e um certificado PKCS#12 valido: " + String(erro.message || ""),
      "Envie o arquivo .pfx ou .p12 do certificado A1.");
  }
}

/** As raizes que o Node usaria sem `ca` (Mozilla, mais NODE_EXTRA_CA_CERTS e as do sistema, se ligadas). */
function raizesPadrao() {
  return typeof tls.getCACertificates === "function" ? tls.getCACertificates("default") : tls.rootCertificates;
}

/**
 * As opcoes de TLS do A1 para o https.Agent: { key, cert, ca }.
 *
 * Reproduz o que o Node fazia com o .pfx, em PEM:
 *   - cert leva o titular seguido da cadeia do arquivo: e a cadeia que o
 *     servidor recebe para validar o cliente, como o OpenSSL mandava;
 *   - a cadeia do arquivo SOMA-SE as raizes que conferem o servidor (as do
 *     Node, ou o `caExtra` de quem chama), nao as substitui. Com o .pfx o Node
 *     fazia essa soma sozinho; passar so `ca: cadeia` trocaria as raizes da
 *     Mozilla pela cadeia ICP-Brasil e derrubaria servidor de certificado
 *     comercial, e nao somar a cadeia derrubaria servidor de certificado ICP.
 */
export function opcoesTlsDoA1(pfx, senha, caExtra) {
  const a1 = abrirA1(pfx, senha);
  const opcoes = { key: a1.key, cert: [a1.cert, ...a1.ca].join("") };
  const base = caExtra ? [].concat(caExtra) : null;
  if (a1.ca.length) opcoes.ca = [...(base || raizesPadrao()), ...a1.ca];
  else if (base) opcoes.ca = base;
  return opcoes;
}

/** Abre o PFX com a senha e devolve o contexto TLS. Lanca com codigo claro. */
export function contextoTls(pfx, senha) {
  const opcoes = opcoesTlsDoA1(pfx, senha);
  try {
    return tls.createSecureContext(opcoes);
  } catch (erro) {
    throw falha(ERRO_ARQUIVO, "O TLS recusou a chave do certificado: " + String(erro.message || ""),
      "Envie o arquivo .pfx ou .p12 do certificado A1.");
  }
}

/** CNPJ do titular: no e-CNPJ da ICP-Brasil o CN e "RAZAO SOCIAL:14 digitos". */
function cnpjDoTitular(subject) {
  const cn = subject.split("\n").find((linha) => linha.startsWith("CN=")) || "";
  const doCn = cn.match(/:(\d{14})\s*$/);
  if (doCn) return doCn[1];
  const solto = subject.match(/\b(\d{14})\b/);
  return solto ? solto[1] : null;
}

function nomeDoTitular(subject) {
  const cn = (subject.split("\n").find((linha) => linha.startsWith("CN=")) || "").slice(3);
  return cn.replace(/:\d{11,14}\s*$/, "").trim();
}

function campo(subject, chave) {
  const linha = subject.split("\n").find((item) => item.startsWith(chave + "="));
  return linha ? linha.slice(chave.length + 1) : "";
}

/**
 * Le arquivo e senha e devolve o que o cadastro precisa, sem guardar nada.
 * Lanca ERRO_SENHA, ERRO_LEGADO ou ERRO_ARQUIVO.
 */
export function lerPfx(pfx, senha, { agora = new Date() } = {}) {
  const a1 = abrirA1(pfx, senha);
  // O PEM tem de servir ao TLS ja no cadastro: chave de tipo que o TLS nao
  // aceita apareceria so na primeira captura, longe de quem enviou o arquivo.
  try {
    tls.createSecureContext({ key: a1.key, cert: a1.cert });
  } catch (erro) {
    throw falha(ERRO_ARQUIVO, "O TLS recusou a chave do certificado: " + String(erro.message || ""),
      "Envie o arquivo .pfx ou .p12 do certificado A1.");
  }
  const x509 = a1.certificado;

  const validoDe = new Date(x509.validFrom);
  const validoAte = new Date(x509.validTo);
  const dias = Math.floor((validoAte - agora) / 86_400_000);
  const titularCnpj = cnpjDoTitular(x509.subject);

  return {
    titular: nomeDoTitular(x509.subject),
    titularCnpj,
    raizCnpj: titularCnpj ? titularCnpj.slice(0, 8) : null,
    emissor: campo(x509.issuer, "CN") || campo(x509.issuer, "O"),
    serie: x509.serialNumber,
    impressaoDigital: x509.fingerprint256,
    validoDe: validoDe.toISOString().slice(0, 10),
    validoAte: validoAte.toISOString().slice(0, 10),
    diasParaVencer: dias,
    vencido: dias < 0,
    tipo: "A1",
    sha256Arquivo: crypto.createHash("sha256").update(pfx).digest("hex")
  };
}

/**
 * O certificado pode consultar este CNPJ por conta propria, sem procuracao?
 * O ADN aceita o mesmo CNPJ e, desde a versao atual, o mesmo CNPJ raiz
 * (matriz consultando filial). Fora disso, so com procuracao eletronica.
 */
export function cobreCnpj(certificado, cnpj) {
  const alvo = String(cnpj || "").replace(/\D/g, "");
  if (!certificado?.titularCnpj || alvo.length !== 14) return { cobre: false, motivo: "CNPJ invalido" };
  if (certificado.titularCnpj === alvo) return { cobre: true, motivo: "proprio CNPJ" };
  if (certificado.titularCnpj.slice(0, 8) === alvo.slice(0, 8)) return { cobre: true, motivo: "mesmo CNPJ raiz" };
  return { cobre: false, motivo: "CNPJ diferente: exige procuracao eletronica do cliente para o titular" };
}
