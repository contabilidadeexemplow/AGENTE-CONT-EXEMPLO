// Guarda do NUCLEO no Supabase Storage.
//
// Para rodar no plano gratuito do Render, que apaga o disco sempre que o
// servico dorme (15 minutos sem acesso) ou reinicia. Tudo o que o NUCLEO
// grava em disco vai tambem para um bucket PRIVADO do Supabase:
//
//   - o BANCO (SQLite): uma copia consistente (VACUUM INTO), comprimida, sobe
//     alguns segundos depois de cada mudanca e no desligamento. Na subida, sem
//     banco no disco, a ultima copia e baixada antes de abrir o banco;
//   - o ACERVO (XML e PDF) e os UPLOADS: sobem na hora em que sao gravados, e
//     voltam sob demanda, na primeira leitura depois de uma subida.
//
// O que garante que nada se perde em silencio:
//
//   - subida com copia na nuvem que nao baixa (rede, chave, arquivo
//     corrompido) RECUSA subir: nunca abre banco vazio por cima do bom;
//   - a copia vai em duas vagas alternadas (a e b) e o manifesto so aponta para
//     a nova depois que todas as partes subiram: uma queda no meio deixa a
//     anterior intacta;
//   - uma copia por dia da semana (sete vagas, sobrescritas, nada e apagado);
//   - um arquivo do acervo que nao sobe faz a gravacao falhar, em vez de ficar
//     so num disco que vai sumir;
//   - cada pasta de dados tem uma ORIGEM: um segundo servidor com outro banco
//     apontando para o mesmo bucket recusa subir em vez de sobrescrever.
//
// So uma instancia por bucket (o render.yaml fixa numInstances: 1).
//
// A chave tem de ser a service_role LEGADA (JWT, comeca com "eyJ"): o Storage
// recusa a sb_secret_ com 403 "Invalid Compact JWS".

import crypto from "node:crypto";
import { promisify } from "node:util";
import { gzip as gzipCb, gunzip as gunzipCb } from "node:zlib";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, readdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";

const gzip = promisify(gzipCb);
const gunzip = promisify(gunzipCb);

export const MANIFESTO = "banco/atual.json";
const ARQUIVO_ORIGEM = "nuvem-origem.txt";
const PARTE_MAX_PADRAO = 40 * 1024 * 1024; // o Supabase gratuito recusa arquivo acima de 50 MB

export class ErroNuvem extends Error {
  constructor(mensagem, { status = 0, codigo = "NUVEM", transitorio = false } = {}) {
    super(mensagem);
    this.name = "ErroNuvem";
    this.status = status;
    this.codigo = codigo;
    this.transitorio = transitorio;
  }
}

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const caminhoUrl = (caminho) => caminho.split("/").map(encodeURIComponent).join("/");

/** O Storage responde "nao existe" ora com 404, ora com 400 e statusCode "404" no corpo. */
function naoExiste(status, corpo) {
  if (status === 404) return true;
  if (status !== 400 || !corpo) return false;
  return String(corpo.statusCode) === "404" || corpo.error === "not_found" || /not found/i.test(corpo.message || corpo.error || "");
}

export class ArmazemSupabase {
  constructor({ url, chave, bucket = "nucleo", timeoutMs = 60_000, tentativas = 3, esperaMs = 1000 }) {
    if (!url || !chave) throw new ErroNuvem("Supabase sem URL ou sem chave", { codigo: "NUVEM_CONFIG" });
    if (/^sb_/.test(chave.trim())) {
      throw new ErroNuvem(
        "A chave do Supabase e a nova (sb_...). O Storage so aceita a service_role LEGADA, que comeca com eyJ: " +
        "Supabase > Project Settings > API Keys > Legacy API Keys > service_role.", { codigo: "NUVEM_CONFIG" });
    }
    this.base = url.replace(/\/+$/, "") + "/storage/v1";
    this.chave = chave.trim();
    this.bucket = bucket;
    this.timeoutMs = timeoutMs;
    this.tentativas = tentativas;
    this.esperaMs = esperaMs;
  }

  async requisitar(metodo, caminho, { corpo, tipo, cabecalhos = {} } = {}) {
    let ultimoErro = null;
    for (let tentativa = 1; tentativa <= this.tentativas; tentativa += 1) {
      let resposta;
      try {
        resposta = await fetch(this.base + caminho, {
          method: metodo,
          headers: {
            authorization: "Bearer " + this.chave,
            apikey: this.chave,
            ...(tipo ? { "content-type": tipo } : {}),
            ...cabecalhos
          },
          body: corpo,
          signal: AbortSignal.timeout(this.timeoutMs)
        });
      } catch (erro) {
        ultimoErro = new ErroNuvem("Supabase fora do alcance: " + (erro.cause?.code || erro.message), { transitorio: true });
        if (tentativa < this.tentativas) await esperar(this.esperaMs * 2 ** (tentativa - 1));
        continue;
      }
      const bytes = Buffer.from(await resposta.arrayBuffer());
      if (resposta.ok) return { status: resposta.status, bytes };
      let corpoErro = null;
      try { corpoErro = JSON.parse(bytes.toString("utf8")); } catch { /* corpo nao e JSON */ }
      if (naoExiste(resposta.status, corpoErro)) return { status: 404, bytes: null, corpo: corpoErro };
      const mensagem = corpoErro?.message || corpoErro?.error || bytes.toString("utf8").slice(0, 200);
      if (resposta.status === 429 || resposta.status >= 500) {
        ultimoErro = new ErroNuvem("Supabase respondeu " + resposta.status + ": " + mensagem, { status: resposta.status, transitorio: true });
        if (tentativa < this.tentativas) await esperar(this.esperaMs * 2 ** (tentativa - 1));
        continue;
      }
      const recusada = resposta.status === 401 || resposta.status === 403 || /JWS|JWT|signature|Unauthorized/i.test(mensagem);
      return { status: resposta.status, bytes: null, corpo: corpoErro, mensagem, recusada };
    }
    throw ultimoErro;
  }

  falha(resposta, acao) {
    if (resposta.recusada) {
      return new ErroNuvem("O Supabase recusou a chave ao " + acao + " (" + resposta.mensagem + "). Use a service_role legada (eyJ...).",
        { status: resposta.status, codigo: "NUVEM_CHAVE" });
    }
    return new ErroNuvem("Supabase respondeu " + resposta.status + " ao " + acao + ": " + resposta.mensagem, { status: resposta.status });
  }

  /** Cria o bucket privado se ainda nao existir. */
  async garantirBucket() {
    const existe = await this.requisitar("GET", "/bucket/" + encodeURIComponent(this.bucket));
    if (existe.status === 200) return { criado: false };
    if (existe.status !== 404) throw this.falha(existe, "conferir o bucket");
    const criado = await this.requisitar("POST", "/bucket", {
      tipo: "application/json",
      corpo: JSON.stringify({ id: this.bucket, name: this.bucket, public: false })
    });
    if (criado.status === 200 || criado.status === 201) return { criado: true };
    if (String(criado.corpo?.statusCode) === "409" || /exist|duplicate/i.test(criado.mensagem || "")) return { criado: false };
    throw this.falha(criado, "criar o bucket");
  }

  async enviar(caminho, bytes, tipo = "application/octet-stream") {
    const resposta = await this.requisitar("POST", "/object/" + this.bucket + "/" + caminhoUrl(caminho), {
      corpo: bytes, tipo, cabecalhos: { "x-upsert": "true", "cache-control": "no-cache" }
    });
    if (resposta.status !== 200 && resposta.status !== 201) throw this.falha(resposta, "enviar " + caminho);
  }

  /** Bytes do objeto, ou null se ele nao existe. */
  async baixar(caminho) {
    const resposta = await this.requisitar("GET", "/object/authenticated/" + this.bucket + "/" + caminhoUrl(caminho));
    if (resposta.status === 404) return null;
    if (resposta.status !== 200) throw this.falha(resposta, "baixar " + caminho);
    return resposta.bytes;
  }

  async enviarJson(caminho, objeto) {
    await this.enviar(caminho, Buffer.from(JSON.stringify(objeto, null, 2)), "application/json");
  }

  async baixarJson(caminho) {
    const bytes = await this.baixar(caminho);
    return bytes ? JSON.parse(bytes.toString("utf8")) : null;
  }
}

/** Armazem a partir do ambiente, ou null quando a nuvem nao esta configurada. */
export function armazemDoAmbiente(env = process.env) {
  if (!env.NUCLEO_SUPABASE_URL && !env.NUCLEO_SUPABASE_CHAVE) return null;
  return new ArmazemSupabase({
    url: env.NUCLEO_SUPABASE_URL,
    chave: env.NUCLEO_SUPABASE_CHAVE,
    bucket: env.NUCLEO_SUPABASE_BUCKET || "nucleo",
    esperaMs: Number(env.NUCLEO_NUVEM_ESPERA_TENTATIVA_MS || 1000)
  });
}

/** Prefixo dentro do bucket, no formato que o acervo e os uploads esperam. */
export function espelho(armazem, prefixo) {
  return {
    enviar: (caminho, bytes) => armazem.enviar(prefixo + caminho, bytes),
    baixar: (caminho) => armazem.baixar(prefixo + caminho)
  };
}

function lerOrigem(dataDir) {
  const arquivo = join(dataDir, ARQUIVO_ORIGEM);
  return existsSync(arquivo) ? readFileSync(arquivo, "utf8").trim() : null;
}

// Quem restaura herda a origem da copia: e o mesmo banco, continuando.
async function novaOrigem(dataDir, id = crypto.randomUUID()) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, ARQUIVO_ORIGEM), id + "\n");
  return id;
}

async function baixarCopia(armazem, manifesto, prefixo) {
  const partes = [];
  for (let i = 0; i < manifesto.partes; i += 1) {
    const nome = prefixo + "/parte-" + String(i).padStart(3, "0") + ".gz";
    const bytes = await armazem.baixar(nome);
    if (!bytes) throw new ErroNuvem("Copia do banco incompleta na nuvem: falta " + nome, { codigo: "NUVEM_COPIA" });
    partes.push(bytes);
  }
  const comprimido = Buffer.concat(partes);
  if (sha256(comprimido) !== manifesto.sha256) {
    throw new ErroNuvem("Copia do banco na nuvem nao confere com o manifesto (sha256)", { codigo: "NUVEM_COPIA" });
  }
  return gunzip(comprimido);
}

/**
 * Antes de abrir o banco. Sem banco no disco e com copia na nuvem: baixa.
 * Com banco no disco: confere que ele e o mesmo que a nuvem guarda (origem).
 * Devolve { restaurado, motivo, origem, enviarArquivosLocais }.
 */
export async function restaurarBanco({ armazem, arquivo, dataDir }) {
  const manifesto = await armazem.baixarJson(MANIFESTO);
  if (existsSync(arquivo)) {
    const origem = lerOrigem(dataDir);
    if (manifesto && manifesto.origem !== origem) {
      throw new ErroNuvem(
        "Este servidor tem um banco proprio e a nuvem guarda o banco de outro servidor. Subir aqui sobrescreveria " +
        "o outro. Use outro bucket (NUCLEO_SUPABASE_BUCKET) ou suba numa pasta de dados vazia para baixar o da nuvem.",
        { codigo: "NUVEM_OUTRA_ORIGEM" });
    }
    return {
      restaurado: false,
      motivo: manifesto ? "banco do disco e o mesmo da nuvem" : "primeira guarda deste banco",
      origem: origem || await novaOrigem(dataDir),
      enviarArquivosLocais: !manifesto
    };
  }
  if (!manifesto) {
    return { restaurado: false, motivo: "primeira subida", origem: await novaOrigem(dataDir), enviarArquivosLocais: false };
  }
  const banco = await baixarCopia(armazem, manifesto, "banco/" + manifesto.vaga);
  await mkdir(dirname(arquivo), { recursive: true });
  const temporario = arquivo + ".restaurando";
  await writeFile(temporario, banco);
  await rename(temporario, arquivo);
  return {
    restaurado: true,
    motivo: "copia de " + manifesto.quando,
    tamanho: banco.length,
    origem: await novaOrigem(dataDir, manifesto.origem),
    enviarArquivosLocais: false
  };
}

/** Sobe o que ja estava no disco quando a nuvem foi ligada num NUCLEO que ja rodava. */
export async function enviarArquivosLocais({ armazem, dataDir }) {
  let enviados = 0;
  async function andar(pasta, aoAchar) {
    for (const item of await readdir(pasta, { withFileTypes: true }).catch(() => [])) {
      const caminho = join(pasta, item.name);
      if (item.isDirectory()) await andar(caminho, aoAchar);
      else if (!item.name.endsWith(".tmp")) await aoAchar(caminho);
    }
  }
  const acervo = join(dataDir, "acervo");
  await andar(acervo, async (caminho) => {
    await armazem.enviar("acervo/" + caminho.slice(acervo.length + 1).replace(/\\/g, "/"), await readFile(caminho));
    enviados += 1;
  });
  await andar(join(dataDir, "uploads"), async (caminho) => {
    const bytes = await readFile(caminho);
    await armazem.enviar("uploads/" + sha256(bytes), bytes);
    enviados += 1;
  });
  return enviados;
}

function diaDaSemana(agora, fuso) {
  const nome = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: fuso }).format(agora);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(nome);
}

function dataLocal(agora, fuso) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: fuso }).format(agora);
}

/**
 * Sobe a copia do banco alguns segundos depois de cada mudanca.
 *   - banco(): a conexao aberta (node:sqlite);
 *   - quietoMs: espera esse tempo sem mudanca antes de subir;
 *   - maxEsperaMs: com mudanca sem parar, sobe mesmo assim depois disso.
 */
export function iniciarGuarda({
  armazem, banco, origem, intervaloMs = 5000, quietoMs = 10_000, maxEsperaMs = 60_000,
  parteMax = PARTE_MAX_PADRAO, fuso = "America/Sao_Paulo", agora = () => new Date(), log = console
}) {
  let mudancasEnviadas = -1;
  let mudancasVistas = -1;
  let sujoDesde = 0;
  let ultimaMudanca = 0;
  let enviando = null;
  let diaCopiado = null;
  let falhasSeguidas = 0;
  let naoAntesDe = 0;
  const estado = { ultimoEnvio: null, ultimoTamanho: 0, envios: 0, ultimoErro: null, pendente: false };

  const mudancas = () => Number(banco().prepare("SELECT total_changes() AS n").get().n);

  async function subirCopia(prefixo, comprimido, extra) {
    const partes = Math.max(1, Math.ceil(comprimido.length / parteMax));
    for (let i = 0; i < partes; i += 1) {
      await armazem.enviar(prefixo + "/parte-" + String(i).padStart(3, "0") + ".gz",
        comprimido.subarray(i * parteMax, (i + 1) * parteMax), "application/gzip");
    }
    return { partes, sha256: sha256(comprimido), tamanhoComprimido: comprimido.length, ...extra };
  }

  async function enviarAgora() {
    const marca = mudancas();
    const temporario = join(tmpdir(), "nucleo-copia-" + process.pid + "-" + Date.now() + ".db");
    try {
      banco().exec("VACUUM INTO '" + temporario.replace(/'/g, "''") + "'");
      const bruto = await readFile(temporario);
      const comprimido = await gzip(bruto);
      const instante = agora();
      const anterior = await armazem.baixarJson(MANIFESTO);
      if (anterior && anterior.origem !== origem) {
        throw new ErroNuvem("Outro servidor assumiu o bucket; esta copia nao sobe para nao sobrescreve-lo",
          { codigo: "NUVEM_OUTRA_ORIGEM" });
      }
      const vaga = anterior?.vaga === "a" ? "b" : "a";
      const comum = { quando: instante.toISOString(), origem, tamanho: bruto.length };
      const manifesto = { ...(await subirCopia("banco/" + vaga, comprimido, comum)), vaga };
      await armazem.enviarJson(MANIFESTO, manifesto);

      const hoje = dataLocal(instante, fuso);
      if (diaCopiado !== hoje) {
        const dia = "dia-" + diaDaSemana(instante, fuso);
        const diario = await subirCopia("banco/" + dia, comprimido, { ...comum, dia: hoje });
        await armazem.enviarJson("banco/" + dia + "/manifesto.json", { ...diario, vaga: dia });
        diaCopiado = hoje;
      }

      mudancasEnviadas = marca;
      estado.ultimoEnvio = manifesto.quando;
      estado.ultimoTamanho = bruto.length;
      estado.envios += 1;
      estado.ultimoErro = null;
      return manifesto;
    } finally {
      await rm(temporario, { force: true });
    }
  }

  function enviar() {
    if (!enviando) {
      enviando = enviarAgora()
        .catch((erro) => {
          estado.ultimoErro = erro.message;
          log.error("nuvem: copia do banco nao subiu:", erro.message);
          throw erro;
        })
        .finally(() => { enviando = null; });
    }
    return enviando;
  }

  function tique() {
    let atual;
    try { atual = mudancas(); } catch { return; } // banco fechado no desligamento
    const instante = Date.now();
    if (atual !== mudancasVistas) {
      mudancasVistas = atual;
      ultimaMudanca = instante;
      if (!sujoDesde && atual !== mudancasEnviadas) sujoDesde = instante;
    }
    estado.pendente = atual !== mudancasEnviadas;
    if (!estado.pendente || enviando || instante < naoAntesDe) return;
    if (instante - ultimaMudanca >= quietoMs || instante - sujoDesde >= maxEsperaMs) {
      sujoDesde = 0;
      enviar()
        .then(() => { falhasSeguidas = 0; naoAntesDe = 0; })
        .catch(() => {
          // Supabase fora: tenta de novo em 10 s, 20 s, 40 s... ate 5 minutos.
          falhasSeguidas += 1;
          naoAntesDe = Date.now() + Math.min(300_000, 10_000 * 2 ** (falhasSeguidas - 1));
          sujoDesde = Date.now();
        });
    }
  }

  const relogio = setInterval(tique, intervaloMs);
  relogio.unref?.();

  return {
    estado: () => ({ ...estado, pendente: (() => { try { return mudancas() !== mudancasEnviadas; } catch { return estado.pendente; } })() }),
    /** Sobe ja (usado no desligamento e nos testes). */
    async agora() {
      if (enviando) await enviando.catch(() => {});
      return enviar();
    },
    /** Para o relogio e sobe o que faltou. */
    async parar() {
      clearInterval(relogio);
      if (enviando) await enviando.catch(() => {});
      let pendente = true;
      try { pendente = mudancas() !== mudancasEnviadas; } catch { pendente = false; }
      if (pendente) await enviar();
    }
  };
}
