// Armazem de arquivos (XML e PDF) enderecado pelo SHA-256 do conteudo.
//
// O mesmo arquivo nunca e gravado duas vezes, e o caminho prova o conteudo:
// se o hash de um arquivo lido nao bate com o nome dele, o arquivo foi alterado
// no disco. A verificacao acontece em toda leitura.
//
// Com ESPELHO (lib/nuvem.mjs), o disco vira so um cache: cada arquivo novo sobe
// para a nuvem antes de existir no disco, e um arquivo que falta no disco (o
// Render gratuito apaga o disco ao dormir) e baixado na primeira leitura.

import crypto from "node:crypto";
import { mkdir, readFile, writeFile, rename, access, rm } from "node:fs/promises";
import { join, dirname } from "node:path";

let raiz = null;
let espelho = null;

export function configurarAcervo(diretorio, espelhoNuvem = null) {
  raiz = diretorio;
  espelho = espelhoNuvem;
}

function exigirRaiz() {
  if (!raiz) throw new Error("Acervo nao configurado: chame configurarAcervo()");
  return raiz;
}

export function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

async function gravarNoDisco(absoluto, bytes, antesDeAparecer = null) {
  await mkdir(dirname(absoluto), { recursive: true });
  const temporario = absoluto + "." + process.pid + "." + Date.now() + ".tmp";
  await writeFile(temporario, bytes);
  try {
    if (antesDeAparecer) await antesDeAparecer();
  } catch (erro) {
    // Nao subiu para a nuvem: o arquivo nao pode ficar so num disco que some.
    await rm(temporario, { force: true });
    throw erro;
  }
  await rename(temporario, absoluto);
}

/** Grava o conteudo e devolve { caminho, sha256, tamanho }. Idempotente. */
export async function guardar(conteudo, extensao) {
  const bytes = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(String(conteudo), "utf8");
  const hash = sha256(bytes);
  const caminho = join(hash.slice(0, 2), hash + "." + extensao).replace(/\\/g, "/");
  const absoluto = join(exigirRaiz(), caminho);

  try {
    await access(absoluto);
  } catch {
    await gravarNoDisco(absoluto, bytes, espelho ? () => espelho.enviar(caminho, bytes) : null);
  }

  return { caminho, sha256: hash, tamanho: bytes.length };
}

function conferir(caminho, bytes) {
  const esperado = caminho.split("/").pop().split(".")[0];
  if (sha256(bytes) !== esperado) {
    const erro = new Error("Arquivo do acervo alterado no disco: " + caminho);
    erro.code = "ACERVO_CORROMPIDO";
    throw erro;
  }
  return bytes;
}

/** Le e confere a integridade pelo nome. Lanca se o arquivo foi alterado. */
export async function ler(caminho) {
  const absoluto = join(exigirRaiz(), caminho);
  try {
    return conferir(caminho, await readFile(absoluto));
  } catch (erro) {
    if (erro.code !== "ENOENT" || !espelho) throw erro;
    const daNuvem = await espelho.baixar(caminho);
    if (!daNuvem) throw erro;
    conferir(caminho, daNuvem);
    await gravarNoDisco(absoluto, daNuvem);
    return daNuvem;
  }
}
