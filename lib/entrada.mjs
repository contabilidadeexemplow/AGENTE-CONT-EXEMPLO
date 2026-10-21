// Pasta de entrada de cada empresa: onde o escritorio (ou o sistema do
// cliente) solta os XML que nao vem de portal com NSU. O caso principal e a
// NFS-e de prefeitura com sistema proprio: o portal da prefeitura exporta os
// XML (e o PDF), alguem salva aqui, e o sistema importa sozinho.
//
//   <pasta da empresa>/ENTRADA/            arquivos novos (.xml, .zip, .pdf)
//   <pasta da empresa>/ENTRADA/IMPORTADOS/<AAAA-MM-DD>/   depois de importados
//   <pasta da empresa>/ENTRADA/COM_ERRO/   recusados, com <nome>.motivo.txt
//
// Usado pelo servidor (quando enxerga a pasta) e pelo agente local. Nada e
// apagado: o arquivo so muda de pasta, e nunca por cima de outro.

import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, extname, parse } from "node:path";

const EXTENSOES = new Set([".xml", ".zip", ".pdf"]);

// Arquivo modificado ha menos que isso ainda pode estar sendo copiado.
const ESTAVEL_MS = 5000;

// A pasta ja e da empresa: a entrada fica direto nela. O CNPJ continua no
// parametro para quem chama nao mudar.
export function caminhoEntrada(pasta, cnpj) {
  return join(pasta, "ENTRADA");
}

/** Caminho relativo, com "/", para mostrar na tela. */
export function entradaRelativa(cnpj) {
  return "ENTRADA";
}

/** Arquivos prontos para importar (so o primeiro nivel da pasta). */
export async function lerEntrada(diretorio, { agora = Date.now(), limiteBytes = 100 * 1024 * 1024 } = {}) {
  let nomes;
  try {
    nomes = await readdir(diretorio, { withFileTypes: true });
  } catch {
    return [];
  }
  const saida = [];
  let total = 0;
  for (const item of nomes) {
    if (!item.isFile() || !EXTENSOES.has(extname(item.name).toLowerCase())) continue;
    const caminho = join(diretorio, item.name);
    const info = await stat(caminho);
    if (agora - info.mtimeMs < ESTAVEL_MS) continue;
    if (total + info.size > limiteBytes) break;
    total += info.size;
    saida.push({ nome: item.name, caminho, bytes: await readFile(caminho) });
  }
  return saida;
}

async function destinoLivre(diretorio, nome) {
  await mkdir(diretorio, { recursive: true });
  const { name, ext } = parse(nome);
  for (let n = 0; ; n += 1) {
    const candidato = join(diretorio, n ? name + " (" + n + ")" + ext : nome);
    try {
      await stat(candidato);
    } catch {
      return candidato;
    }
  }
}

/**
 * Decide o destino de cada arquivo de entrada pelo resultado da importacao
 * (lista de { arquivo, situacao, motivo }) e move. Um arquivo vai para
 * COM_ERRO so quando nada dele entrou; importacao parcial vai para IMPORTADOS
 * com o motivo do que ficou de fora ao lado.
 */
export async function arquivarEntrada(diretorio, lidos, resultados, { hoje = new Date() } = {}) {
  const dia = hoje.toISOString().slice(0, 10);
  const movidos = [];
  for (const lido of lidos) {
    const dele = resultados.filter((item) => item.arquivo === lido.nome);
    const entrou = dele.some((item) => ["importado", "duplicado", "evento", "anexado"].includes(item.situacao));
    const recusas = dele.filter((item) => item.situacao === "recusado" || item.situacao === "ignorado");
    const pasta = entrou || !recusas.length ? join(diretorio, "IMPORTADOS", dia) : join(diretorio, "COM_ERRO");
    const destino = await destinoLivre(pasta, lido.nome);
    await rename(lido.caminho, destino);
    if (recusas.length) {
      await writeFile(destino + ".motivo.txt",
        recusas.map((item) => item.nome + ": " + (item.motivo || item.situacao)).join("\r\n") + "\r\n");
    }
    movidos.push({ nome: lido.nome, destino, entrou, recusas: recusas.length });
  }
  return movidos;
}
