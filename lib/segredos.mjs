// Cofre de segredos para credenciais de integracao.
//
// Antes, as credenciais ficavam em texto plano dentro do banco. Agora sao
// cifradas com AES-256-GCM, e a chave mestra NAO fica no banco nem no codigo:
// vem do ambiente (`NUCLEO_CHAVE_SEGREDOS`) ou de um arquivo de chave fora do
// diretorio de dados (`NUCLEO_ARQUIVO_CHAVE`).
//
// Regra que sustenta tudo: sem chave configurada, gravar segredo e RECUSADO.
// Nunca cai para texto plano em silencio, porque um cofre que as vezes nao
// cifra e pior do que nenhum cofre: passa confianca que nao existe.
//
// O que isto resolve: quem le o arquivo do banco (backup, copia, acesso ao
// disco) nao obtem as credenciais. O que NAO resolve: quem tem o processo e a
// chave ao mesmo tempo. Para esse nivel e preciso um cofre externo real
// (HashiCorp Vault, AWS KMS, Azure Key Vault), e a interface abaixo foi feita
// para ser trocada por um desses sem mexer no resto do sistema.

import crypto from "node:crypto";
import { readFileSync } from "node:fs";

export const CHAVE_AUSENTE = "CHAVE_SEGREDOS_AUSENTE";
export const CHAVE_INVALIDA = "CHAVE_SEGREDOS_INVALIDA";

const ALGORITMO = "aes-256-gcm";
const MASCARA = "(guardado no cofre)";

let cacheChave = null;
let cacheOrigem = null;

function erro(code, mensagem, comoResolver) {
  const excecao = new Error(mensagem);
  excecao.code = code;
  excecao.comoResolver = comoResolver;
  return excecao;
}

/**
 * Le a chave mestra. 32 bytes, em hex (64 caracteres) ou base64.
 * Resultado em cache para nao reler o arquivo a cada operacao; `limparCache`
 * existe para os testes, que trocam a variavel de ambiente.
 */
function chaveMestra() {
  const bruta = process.env.NUCLEO_CHAVE_SEGREDOS
    || (process.env.NUCLEO_ARQUIVO_CHAVE ? lerArquivoChave(process.env.NUCLEO_ARQUIVO_CHAVE) : "");

  if (!bruta) {
    cacheChave = null;
    cacheOrigem = null;
    throw erro(CHAVE_AUSENTE,
      "Chave do cofre de segredos nao configurada",
      "Gere uma com `node -e \"console.log(require('node:crypto').randomBytes(32).toString('hex'))\"` " +
      "e exporte em NUCLEO_CHAVE_SEGREDOS, ou aponte NUCLEO_ARQUIVO_CHAVE para um arquivo " +
      "fora do diretorio de dados. Nao guarde a chave junto do banco.");
  }

  if (cacheOrigem === bruta && cacheChave) return cacheChave;

  let chave;
  if (/^[0-9a-fA-F]{64}$/.test(bruta.trim())) {
    chave = Buffer.from(bruta.trim(), "hex");
  } else {
    chave = Buffer.from(bruta.trim(), "base64");
  }

  if (chave.length !== 32) {
    throw erro(CHAVE_INVALIDA,
      "Chave do cofre tem " + chave.length + " bytes; sao necessarios 32",
      "Use 64 caracteres hex ou 44 caracteres base64 representando 32 bytes.");
  }

  cacheChave = chave;
  cacheOrigem = bruta;
  return chave;
}

function lerArquivoChave(caminho) {
  try {
    return readFileSync(caminho, "utf8").trim();
  } catch {
    return "";
  }
}

/** Esquece a chave em cache. Usado pelos testes ao trocar o ambiente. */
export function limparCache() {
  cacheChave = null;
  cacheOrigem = null;
}

/** O cofre esta utilizavel? Nao lanca: serve para a interface avisar. */
export function chaveConfigurada() {
  try {
    chaveMestra();
    return true;
  } catch {
    return false;
  }
}

/** Diagnostico para a tela de integracoes, sem revelar a chave. */
export function estadoCofre() {
  try {
    chaveMestra();
    return {
      disponivel: true,
      origem: process.env.NUCLEO_CHAVE_SEGREDOS ? "variavel de ambiente" : "arquivo de chave",
      algoritmo: ALGORITMO
    };
  } catch (excecao) {
    return {
      disponivel: false,
      code: excecao.code,
      motivo: excecao.message,
      comoResolver: excecao.comoResolver
    };
  }
}

/**
 * Cifra um segredo. Devolve "iv:tag:conteudo", tudo em base64.
 * O IV e sorteado a cada chamada, entao o mesmo segredo nunca produz o mesmo
 * texto cifrado: ninguem descobre que duas empresas usam a mesma credencial.
 */
export function cifrar(texto) {
  const chave = chaveMestra();
  const iv = crypto.randomBytes(12);
  const cifra = crypto.createCipheriv(ALGORITMO, chave, iv);
  const conteudo = Buffer.concat([cifra.update(String(texto), "utf8"), cifra.final()]);
  const tag = cifra.getAuthTag();
  return [iv.toString("base64"), tag.toString("base64"), conteudo.toString("base64")].join(":");
}

/** Decifra. Lanca se a chave estiver errada ou o conteudo tiver sido alterado. */
export function decifrar(cifrado) {
  const chave = chaveMestra();
  const partes = String(cifrado || "").split(":");
  if (partes.length !== 3) throw erro(CHAVE_INVALIDA, "Formato de segredo invalido", "Esperado iv:tag:conteudo");

  const [iv, tag, conteudo] = partes.map((parte) => Buffer.from(parte, "base64"));
  const decifra = crypto.createDecipheriv(ALGORITMO, chave, iv);
  decifra.setAuthTag(tag);
  return Buffer.concat([decifra.update(conteudo), decifra.final()]).toString("utf8");
}

/**
 * Mascara um objeto de credenciais para exibicao e para a auditoria.
 * O valor nunca sai daqui: so os nomes das chaves e se cada uma esta preenchida.
 */
export function mascarar(credenciais) {
  const saida = {};
  for (const [chave, valor] of Object.entries(credenciais || {})) {
    saida[chave] = valor ? MASCARA : null;
  }
  return saida;
}

/** Gera uma chave nova, para o operador copiar. Nunca gravada pelo sistema. */
export function gerarChave() {
  return crypto.randomBytes(32).toString("hex");
}
