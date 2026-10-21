// Espelho dos documentos na pasta de cada cliente.
//
//   <pasta da empresa>/<ANO>/<MES>/<NF-e|NFS-e|CT-e|NFC-e|EVENTOS>/<EMITIDAS|RECEBIDAS>/<XML|PDF>/<arquivo>
//
// A pasta e da EMPRESA (cada uma tem a sua, escolhida no computador do
// escritorio por agente/escolher-pastas.ps1); dentro dela, o mes e depois o
// tipo de nota. O ZIP de exportacao, que junta varias empresas, poe antes
// EMPRESAS/<CNPJ>/ (comEmpresa).
//
// Regras de gravacao:
//   - o mes vem da COMPETENCIA da nota (dCompet), como faz a extensao;
//   - grava em arquivo temporario e renomeia: nunca deixa arquivo pela metade;
//   - arquivo ja existente com o mesmo conteudo: nada a fazer;
//   - arquivo ja existente com conteudo DIFERENTE: nao sobrescreve. Devolve
//     "conflito" e o painel mostra a pendencia; quem decide e uma pessoa.
//
// Usado pelo servidor (quando a pasta e acessivel a ele) e pelo agente local.

import crypto from "node:crypto";
import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { join, dirname, isAbsolute, parse, sep } from "node:path";

const PAPEL_PASTA = { emitida: "EMITIDAS", recebida: "RECEBIDAS", outro: "OUTRAS" };
const TIPO_PASTA = { "NF-e": "NF-e", "NFC-e": "NFC-e", "NFS-e": "NFS-e", "CT-e": "CT-e", Evento: "EVENTOS" };

function limpar(texto, limite = 60) {
  const limpo = String(texto || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/[^A-Za-z0-9 _-]/g, "")
    .trim().replace(/\s+/g, "_");
  if (limpo.length <= limite) return limpo || "sem-nome";
  // Corta em fronteira de palavra: "EMPRESA_DEMONSTRATIVA_QUATRO_L" nao ajuda ninguem.
  const cortado = limpo.slice(0, limite);
  const fronteira = cortado.lastIndexOf("_");
  return (fronteira > limite / 2 ? cortado.slice(0, fronteira) : cortado) || "sem-nome";
}

// NF-e e CT-e dividem a pasta com a NFS-e e tem NSU proprio: o prefixo evita
// que dois documentos diferentes caiam no mesmo nome.
const PREFIXO_TIPO = { "NF-e": "NFe", "NFC-e": "NFCe", "CT-e": "CTe" };

/**
 * Nome do arquivo no esquema da extensao: numero + contraparte + NSU.
 * A contraparte e o outro lado: o tomador nas emitidas, o prestador nas recebidas.
 */
export function nomeArquivo({ numero, papel, emitente, destinatario, nsu, chave, tipo }, extensao) {
  const contraparte = papel === "emitida" ? destinatario : emitente;
  const sufixo = nsu !== null && nsu !== undefined ? String(nsu)
    : /^\d+$/.test(String(chave || "")) ? String(chave).slice(-8) : "";
  return [PREFIXO_TIPO[tipo], String(numero || "sn"), limpar(contraparte), sufixo]
    .filter(Boolean).join("_") + "." + extensao;
}

// Nome curto do evento no arquivo da pasta (NF-e, CT-e e NFS-e).
const NOME_EVENTO = {
  "110111": "CANCELAMENTO", "110112": "CANCELAMENTO-SUBSTITUICAO", "110110": "CARTA-CORRECAO",
  "210200": "CONFIRMACAO", "210210": "CIENCIA", "210220": "DESCONHECIMENTO", "210240": "NAO-REALIZADA",
  "101101": "CANCELAMENTO", "105102": "SUBSTITUICAO", "105104": "CANCELAMENTO-DEFERIDO", "305101": "CANCELAMENTO-OFICIO"
};

/** Arquivo do evento: EVT_<o que e>_<numero da nota>_<inicio do hash>.xml (o hash separa dois eventos iguais). */
export function nomeEvento({ tipo, numero, chave, sha256 }) {
  const nota = numero ? String(numero) : /^\d+$/.test(String(chave || "")) ? String(chave).slice(-9) : "sn";
  return ["EVT", NOME_EVENTO[tipo] || String(tipo || "EVENTO"), nota, String(sha256 || "").slice(0, 6)]
    .filter(Boolean).join("_") + ".xml";
}

/** Caminho relativo dentro da pasta da empresa, com separador "/". */
export function caminhoRelativo({ cnpj, competencia, papel, tipoArquivo, arquivo, tipo, comEmpresa = false }) {
  const [ano, mes] = /^\d{4}-\d{2}$/.test(String(competencia || ""))
    ? competencia.split("-")
    : ["sem-competencia", ""];
  return [...(comEmpresa ? ["EMPRESAS", String(cnpj).replace(/\D/g, "")] : []), ano, mes,
    TIPO_PASTA[tipo] || "OUTROS", PAPEL_PASTA[papel] || "OUTRAS", tipoArquivo === "pdf" ? "PDF" : "XML", arquivo]
    .filter(Boolean).join("/");
}

/** A mesma pasta escrita de jeitos diferentes (barra, maiuscula, barra no fim) e a mesma pasta. */
export function mesmaPasta(a, b) {
  const normal = (p) => String(p || "").trim().replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
  return Boolean(normal(a)) && normal(a) === normal(b);
}

/**
 * O servidor so grava direto se a pasta for um caminho absoluto DESTA maquina
 * e a raiz dela ja existir. Num servidor Linux, "C:\Clientes" nao e absoluto
 * e seria criado como subpasta do diretorio de trabalho: essa checagem impede.
 */
export async function pastaAcessivel(pasta) {
  if (!pasta || !isAbsolute(pasta)) return false;
  try {
    const { root } = parse(pasta);
    await stat(root);
    const info = await stat(pasta).catch(() => null);
    return info ? info.isDirectory() : true;
  } catch {
    return false;
  }
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Grava `bytes` em `<pasta>/<relativo>` sem nunca sobrescrever conteudo diferente.
 * Devolve { situacao: "gravado" | "ja_existia" | "conflito", caminho }.
 */
export async function gravarSemSobrescrever(pasta, relativo, bytes) {
  const destino = join(pasta, ...relativo.split("/"));
  if (!destino.startsWith(join(pasta) + sep) && destino !== join(pasta)) {
    throw new Error("Caminho de destino fora da pasta do cliente");
  }

  const existente = await readFile(destino).catch(() => null);
  if (existente) {
    return existente.length === bytes.length && sha256(existente) === sha256(bytes)
      ? { situacao: "ja_existia", caminho: destino }
      : { situacao: "conflito", caminho: destino };
  }

  await mkdir(dirname(destino), { recursive: true });
  const temporario = destino + "." + process.pid + "." + Date.now() + ".tmp";
  await writeFile(temporario, bytes);
  await rename(temporario, destino);

  // Le de volta: gravacao que nao confere e falha, nao sucesso.
  const conferido = await readFile(destino);
  if (sha256(conferido) !== sha256(bytes)) {
    throw new Error("Arquivo gravado nao confere com o original: " + destino);
  }
  return { situacao: "gravado", caminho: destino };
}
