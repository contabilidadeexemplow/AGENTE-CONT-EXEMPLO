// Agente local: espelha nas pastas do escritorio os XML e PDF capturados pelo
// servidor (quando o servidor roda na nuvem e nao enxerga o disco local), e
// leva ao servidor o que o escritorio solta na pasta de entrada de cada
// empresa (<pasta da empresa>/ENTRADA: NFS-e de prefeitura, NF-e do emissor).
//
// Uso (PowerShell):
//   $env:NUCLEO_SERVIDOR = "https://seu-servico.onrender.com"
//   $env:NUCLEO_AGENTE_TOKEN = "nucleoa_..."      # criado em Configuracoes > Agente local
//   npm run agente                            # fica rodando
//   npm run agente -- --uma-vez               # uma passada e sai
//
// Variaveis opcionais:
//   NUCLEO_AGENTE_INTERVALO_S  intervalo entre passadas (padrao 300)
//   NUCLEO_AGENTE_RAIZ         base para pastas configuradas como caminho relativo
//
// Regras, as mesmas do servidor (lib/pastas.mjs): grava em arquivo temporario
// e renomeia; arquivo igual ja existente nao e regravado; arquivo DIFERENTE
// com o mesmo nome nunca e sobrescrito, vira conflito no painel. Antes de
// gravar, confere o SHA-256 do que baixou contra o que o servidor declarou.

import crypto from "node:crypto";
import { resolve, isAbsolute } from "node:path";
import { gravarSemSobrescrever } from "../lib/pastas.mjs";
import { caminhoEntrada, lerEntrada, arquivarEntrada } from "../lib/entrada.mjs";

const servidor = String(process.env.NUCLEO_SERVIDOR || "").replace(/\/+$/, "");
const token = process.env.NUCLEO_AGENTE_TOKEN || "";
const intervalo = Number(process.env.NUCLEO_AGENTE_INTERVALO_S || 300) * 1000;
const raiz = process.env.NUCLEO_AGENTE_RAIZ || process.cwd();
const umaVez = process.argv.includes("--uma-vez");

function registrar(...partes) {
  console.log(new Date().toISOString().slice(0, 19).replace("T", " "), ...partes);
}

async function chamar(caminho, opcoes = {}) {
  const resposta = await fetch(servidor + caminho, {
    ...opcoes,
    headers: { "x-agente-token": token, "content-type": "application/json", ...(opcoes.headers || {}) }
  });
  if (resposta.status === 401) throw new Error("Token do agente recusado: crie outro no painel");
  return resposta;
}

/** Uma passada: baixa o que esta pendente, grava, confirma. */
export async function passada() {
  const resposta = await chamar("/api/agente/fila?limite=500");
  if (!resposta.ok) throw new Error("Servidor respondeu " + resposta.status + " ao pedir a fila");
  const fila = await resposta.json();
  if (!fila.length) return { itens: 0, porSituacao: {} };

  const resultados = [];
  for (const item of fila) {
    const pasta = isAbsolute(item.pastaDestino) ? item.pastaDestino : resolve(raiz, item.pastaDestino);
    const base = { documentoId: item.documentoId, tipoArquivo: item.tipoArquivo, clientId: item.clientId, destino: item.destino };
    try {
      const arquivo = await chamar("/api/agente/arquivo/" + item.documentoId + "/" + item.tipoArquivo);
      if (!arquivo.ok) throw new Error("download recusado (" + arquivo.status + ")");
      const bytes = Buffer.from(await arquivo.arrayBuffer());
      const hash = crypto.createHash("sha256").update(bytes).digest("hex");
      if (hash !== item.sha256) throw new Error("arquivo baixado nao confere com o SHA-256 informado");
      const gravado = await gravarSemSobrescrever(pasta, item.destino, bytes);
      resultados.push({ ...base, situacao: gravado.situacao });
      if (gravado.situacao === "conflito") registrar("CONFLITO", gravado.caminho, "(nada sobrescrito)");
    } catch (erro) {
      resultados.push({ ...base, situacao: "erro", erro: erro.message });
      registrar("ERRO", item.destino, erro.message);
    }
  }

  const confirmacao = await chamar("/api/agente/confirmar", {
    method: "POST",
    body: JSON.stringify({ resultados })
  });
  if (!confirmacao.ok) throw new Error("Servidor recusou a confirmacao (" + confirmacao.status + ")");

  const porSituacao = resultados.reduce((acc, item) => {
    acc[item.situacao] = (acc[item.situacao] || 0) + 1;
    return acc;
  }, {});
  return { itens: resultados.length, porSituacao };
}

/**
 * Pastas de entrada: envia ao servidor o que esta em <pasta da empresa>/ENTRADA
 * e move cada arquivo para IMPORTADOS ou COM_ERRO conforme a resposta.
 */
export async function lerEntradas() {
  const resposta = await chamar("/api/agente/entradas");
  if (!resposta.ok) throw new Error("Servidor respondeu " + resposta.status + " ao listar as pastas de entrada");
  const saida = { empresas: 0, arquivos: 0, novos: 0, recusados: 0 };
  for (const empresa of await resposta.json()) {
    const pasta = isAbsolute(empresa.pastaDestino) ? empresa.pastaDestino : resolve(raiz, empresa.pastaDestino);
    const diretorio = caminhoEntrada(pasta, empresa.cnpj);
    const lidos = await lerEntrada(diretorio);
    if (!lidos.length) continue;
    const envio = await chamar("/api/agente/importar/" + empresa.clientId, {
      method: "POST",
      body: JSON.stringify({ arquivos: lidos.map((item) => ({ nome: item.nome, conteudoBase64: item.bytes.toString("base64") })) })
    });
    if (!envio.ok) {
      registrar("ERRO", "servidor recusou a importacao de", diretorio, "(" + envio.status + "); arquivos mantidos");
      continue;
    }
    const resultado = await envio.json();
    await arquivarEntrada(diretorio, lidos, resultado.arquivos);
    saida.empresas += 1;
    saida.arquivos += lidos.length;
    saida.novos += resultado.novos;
    saida.recusados += resultado.recusados;
    registrar("entrada", empresa.nome + ":", resultado.novos, "nota(s) nova(s),", resultado.recusados, "recusada(s)");
  }
  return saida;
}

async function principal() {
  if (!servidor || !token) {
    console.error("Defina NUCLEO_SERVIDOR e NUCLEO_AGENTE_TOKEN. Veja o cabecalho de agente/agente.mjs.");
    process.exit(2);
  }
  registrar("agente iniciado; servidor", servidor, umaVez ? "(uma passada)" : "(a cada " + intervalo / 1000 + " s)");

  for (;;) {
    try {
      const resultado = await passada();
      if (resultado.itens) registrar("passada:", resultado.itens, "arquivo(s)", JSON.stringify(resultado.porSituacao));
      await lerEntradas();
      // exitCode em vez de process.exit: sair a forca com conexoes HTTP ainda
      // fechando derruba o Node no Windows (assercao do libuv).
      if (umaVez) { process.exitCode = resultado.porSituacao.erro ? 1 : 0; return; }
    } catch (erro) {
      registrar("falha na passada:", erro.message);
      if (umaVez) { process.exitCode = 1; return; }
    }
    await new Promise((fim) => setTimeout(fim, intervalo));
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  principal();
}
