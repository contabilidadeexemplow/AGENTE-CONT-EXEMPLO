// Fase 0: medicao, so leitura, contra os portais reais com o PRIMEIRO
// certificado A1 de verdade. Responde, antes de ligar a captura na carteira:
//
//   - o mTLS fecha com este certificado (ADN da NFS-e e SEFAZ)?
//   - quantos documentos ha, de que tipos, e desde quando o portal ainda
//     guarda (retencao real, nao a da documentacao)?
//   - qual a latencia por lote e quantos 429/5xx aparecem no ritmo atual?
//
// Nao grava nada no banco, nao manifesta ciencia, nao gera PDF. So consulta e
// conta. O relatorio JSON nao leva senha nem conteudo de nota (so contagens,
// datas e codigos).
//
// Uso (a senha vai por variavel de ambiente, nunca pela linha de comando,
// que fica no historico do terminal):
//
//   PowerShell:
//     $env:NUCLEO_MEDIR_SENHA = "senha-do-certificado"
//     npm run medir -- --pfx "C:\certs\cliente.pfx" --uf SP
//
//   Opcoes:
//     --pfx caminho        certificado A1 (.pfx/.p12)            obrigatorio
//     --cnpj 14digitos     CNPJ consultado (padrao: o do certificado)
//     --uf SP              UF da empresa (obrigatoria para NF-e/CT-e)
//     --fontes ADN,NFE,CTE o que medir (padrao: ADN; NF-e/CT-e so com --uf)
//     --max-lotes 20       limite de lotes por fonte (padrao 20)
//     --saida arquivo      relatorio JSON (padrao: medicao-<cnpj>-<data>.json)
//     --restrita           ADN de producao restrita em vez de producao
//     --homologacao        SEFAZ de homologacao em vez de producao
//     --adn-base URL, --sefaz-nfe URL, --sefaz-cte URL, --ca arquivo.pem
//                          so para apontar para os simuladores dos testes
//
// ATENCAO, SEFAZ: esta medicao conta como consulta. Se ela chegar ao fim da
// caixa, a SEFAZ exige uma hora antes da proxima consulta deste CNPJ; ligar a
// captura de NF-e/CT-e antes disso rende rejeicao 656 (consumo indevido).

import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { lerPfx, cobreCnpj } from "../lib/certificados.mjs";
import { ClienteAdn, ADN_PRODUCAO, ADN_RESTRITA } from "../lib/adn.mjs";
import { ClienteSefaz } from "../lib/sefaz.mjs";
import { lerDocumento, lerResumoNfe } from "../lib/documentos.mjs";

function argumentos(lista) {
  const saida = {};
  for (let i = 0; i < lista.length; i += 1) {
    if (!lista[i].startsWith("--")) continue;
    const nome = lista[i].slice(2);
    const proximo = lista[i + 1];
    if (proximo === undefined || proximo.startsWith("--")) saida[nome] = true;
    else { saida[nome] = proximo; i += 1; }
  }
  return saida;
}

const args = argumentos(process.argv.slice(2));
const senha = process.env.NUCLEO_MEDIR_SENHA;
if (!args.pfx || senha === undefined) {
  console.error("Uso: defina NUCLEO_MEDIR_SENHA e rode  npm run medir -- --pfx caminho.pfx [--uf SP] [--fontes ADN,NFE,CTE]");
  console.error("A senha nao e aceita pela linha de comando de proposito: ela ficaria no historico do terminal.");
  process.exit(2);
}

const pfx = readFileSync(args.pfx);
let certificado;
try {
  certificado = lerPfx(pfx, senha);
} catch (erro) {
  console.error(erro.message + (erro.comoResolver ? "\n" + erro.comoResolver : ""));
  process.exit(1);
}

const cnpj = String(args.cnpj || certificado.titularCnpj || "").replace(/\D/g, "");
const uf = args.uf ? String(args.uf).toUpperCase() : null;
const fontes = String(args.fontes || (uf ? "ADN,NFE,CTE" : "ADN")).toUpperCase().split(",").map((item) => item.trim()).filter(Boolean);
const maxLotes = Math.max(1, Number(args["max-lotes"] || 20));
const ca = args.ca ? readFileSync(args.ca) : undefined;

const relatorio = {
  geradoEm: new Date().toISOString(),
  ferramenta: "medir-portal (fase 0, so leitura)",
  certificado: {
    titular: certificado.titular, titularCnpj: certificado.titularCnpj, emissor: certificado.emissor,
    validoDe: certificado.validoDe, validoAte: certificado.validoAte, diasParaVencer: certificado.diasParaVencer,
    impressaoDigital: certificado.impressaoDigital
  },
  cnpjConsultado: cnpj,
  cobertura: cobreCnpj(certificado, cnpj),
  uf,
  limiteDeLotes: maxLotes,
  fontes: {}
};

console.log("Certificado: " + certificado.titular + " (" + certificado.titularCnpj + "), valido ate " + certificado.validoAte +
  (certificado.vencido ? "  VENCIDO" : ""));
console.log("CNPJ consultado: " + cnpj + " (" + relatorio.cobertura.motivo + ")");
if (certificado.vencido) {
  console.error("Certificado vencido: nenhuma consulta foi feita.");
  process.exit(1);
}

/** Acumula datas, latencias e respostas de uma fonte. */
function novoPlacar() {
  return {
    ok: false, erro: null, autenticacao: null, lotes: 0, chamadas: 0, documentos: 0,
    porTipo: {}, papeis: { emitida: 0, recebida: 0, outro: 0 }, resumos: 0, ilegiveis: 0,
    emissaoMaisAntiga: null, emissaoMaisRecente: null, competencias: {},
    latenciaMs: { media: null, maxima: null, amostras: 0 }, statusHttp: {}, chegouAoFim: false, observacoes: []
  };
}

function registrarData(placar, data, competencia) {
  if (data) {
    const dia = String(data).slice(0, 10);
    if (!placar.emissaoMaisAntiga || dia < placar.emissaoMaisAntiga) placar.emissaoMaisAntiga = dia;
    if (!placar.emissaoMaisRecente || dia > placar.emissaoMaisRecente) placar.emissaoMaisRecente = dia;
  }
  const mes = competencia || (data ? String(data).slice(0, 7) : null);
  if (mes) placar.competencias[mes] = (placar.competencias[mes] || 0) + 1;
}

function fecharLatencias(placar, tempos) {
  if (!tempos.length) return;
  placar.latenciaMs = {
    media: Math.round(tempos.reduce((a, b) => a + b, 0) / tempos.length),
    maxima: Math.round(Math.max(...tempos)),
    amostras: tempos.length
  };
}

// ------------------------------------------------------------------- ADN

async function medirAdn() {
  const placar = novoPlacar();
  const base = args["adn-base"] || (args.restrita ? ADN_RESTRITA : ADN_PRODUCAO);
  placar.endpoint = base;
  const cliente = new ClienteAdn({ pfx, senha, base, ca, espacamentoMs: 700, tentativas: 4, esperaMaximaMs: 8000 });
  const tempos = [];
  const original = cliente.requisitar.bind(cliente);
  cliente.requisitar = async (url) => {
    const inicio = performance.now();
    const resposta = await original(url);
    tempos.push(performance.now() - inicio);
    placar.statusHttp[resposta.status] = (placar.statusHttp[resposta.status] || 0) + 1;
    return resposta;
  };
  const cnpjConsulta = certificado.titularCnpj === cnpj ? null : cnpj;
  let cursor = 0;
  try {
    for (let lote = 0; lote < maxLotes; lote += 1) {
      const resposta = await cliente.lote(cursor, { cnpjConsulta });
      if (resposta.fim) { placar.chegouAoFim = true; break; }
      placar.lotes += 1;
      for (const item of resposta.documentos) {
        placar.documentos += 1;
        placar.porTipo[item.tipo || "?"] = (placar.porTipo[item.tipo || "?"] || 0) + 1;
        if (item.resumo) { placar.resumos += 1; continue; }
        if (item.erro) { placar.ilegiveis += 1; continue; }
        try {
          const doc = lerDocumento(item.xml);
          if (doc.kind === "Evento") continue;
          registrarData(placar, doc.issuedAt, doc.competencia);
          const papel = doc.emitter?.cnpj === cnpj ? "emitida" : doc.recipient?.doc === cnpj ? "recebida" : "outro";
          placar.papeis[papel] += 1;
        } catch {
          placar.ilegiveis += 1;
        }
      }
      const maior = Math.max(...resposta.documentos.map((item) => item.nsu).filter(Number.isFinite));
      if (!Number.isFinite(maior) || maior <= cursor) break;
      cursor = maior;
    }
    placar.ok = true;
    placar.ultimoNsuLido = cursor;
    if (!placar.chegouAoFim) placar.observacoes.push("Limite de " + maxLotes + " lotes atingido antes do fim da caixa.");
  } catch (erro) {
    placar.erro = erro.message;
    placar.autenticacao = Boolean(erro.autenticacao);
  } finally {
    cliente.fechar();
  }
  placar.chamadas = cliente.chamadas;
  fecharLatencias(placar, tempos);
  if (placar.statusHttp[429]) {
    placar.observacoes.push(placar.statusHttp[429] + " resposta(s) 429: o ritmo de 700 ms entre chamadas esta no limite do ADN.");
  }
  return placar;
}

// ----------------------------------------------------------------- SEFAZ

async function medirSefaz(modelo) {
  const placar = novoPlacar();
  if (!uf) {
    placar.erro = "UF nao informada (--uf): a SEFAZ exige a UF do interessado";
    return placar;
  }
  if (String(certificado.titularCnpj || "").slice(0, 8) !== cnpj.slice(0, 8)) {
    placar.erro = "Certificado de outra raiz de CNPJ: a SEFAZ recusa (593). Procuracao nao vale aqui.";
    placar.autenticacao = true;
    return placar;
  }
  const endpoints = {};
  if (args["sefaz-nfe"]) endpoints.nfeDistribuicao = args["sefaz-nfe"];
  if (args["sefaz-cte"]) endpoints.cteDistribuicao = args["sefaz-cte"];
  const cliente = new ClienteSefaz({ pfx, senha, ca, endpoints, ambiente: args.homologacao ? "homologacao" : "producao", tentativas: 2 });
  placar.endpoint = modelo === "nfe" ? cliente.endpoints.nfeDistribuicao : cliente.endpoints.cteDistribuicao;
  const tempos = [];
  const original = cliente.postar.bind(cliente);
  cliente.postar = async (...parametros) => {
    const inicio = performance.now();
    const resposta = await original(...parametros);
    tempos.push(performance.now() - inicio);
    placar.statusHttp[resposta.status] = (placar.statusHttp[resposta.status] || 0) + 1;
    return resposta;
  };
  let cursor = 0;
  try {
    for (let lote = 0; lote < maxLotes; lote += 1) {
      const resposta = await cliente.distribuicao(modelo, { cnpj, uf, ultNSU: cursor });
      placar.maxNSU = resposta.maxNSU;
      placar.ultimoCStat = resposta.cStat + " " + resposta.motivo;
      if (resposta.documentos.length) placar.lotes += 1;
      for (const doc of resposta.documentos) {
        placar.documentos += 1;
        const schema = String(doc.schema || "?").replace(/_v[\d.]+\.xsd$/, "");
        placar.porTipo[schema] = (placar.porTipo[schema] || 0) + 1;
        if (!doc.xml) { placar.ilegiveis += 1; continue; }
        try {
          if (schema === "resNFe") {
            placar.resumos += 1;
            registrarData(placar, lerResumoNfe(doc.xml)?.emissao);
            continue;
          }
          const lido = lerDocumento(doc.xml);
          if (lido.kind === "Evento") continue;
          registrarData(placar, lido.issuedAt, lido.competencia);
          const papel = lido.emitter?.cnpj === cnpj ? "emitida" : lido.recipient?.doc === cnpj ? "recebida" : "outro";
          placar.papeis[papel] += 1;
        } catch {
          placar.ilegiveis += 1;
        }
      }
      const proximo = Math.max(cursor, resposta.ultNSU || 0);
      if (resposta.fim) { placar.chegouAoFim = true; cursor = proximo; break; }
      if (proximo <= cursor) break;
      cursor = proximo;
    }
    placar.ok = true;
    placar.ultimoNsuLido = cursor;
    if (placar.chegouAoFim) {
      placar.proximaConsultaLiberadaApos = new Date(Date.now() + 61 * 60_000).toISOString();
      placar.observacoes.push("Chegou ao fim da caixa: a SEFAZ so aceita nova consulta deste CNPJ depois de uma hora.");
    } else {
      placar.observacoes.push("Limite de " + maxLotes + " lotes atingido antes do fim da caixa.");
    }
    if (placar.resumos) {
      placar.observacoes.push(placar.resumos + " NF-e so em resumo: o XML completo exige Ciencia da Operacao (a medicao nao manifesta).");
    }
  } catch (erro) {
    placar.erro = erro.message;
    placar.autenticacao = Boolean(erro.autenticacao);
    if (erro.cStat) placar.ultimoCStat = erro.cStat;
  } finally {
    cliente.fechar();
  }
  placar.chamadas = cliente.chamadas;
  fecharLatencias(placar, tempos);
  return placar;
}

for (const fonte of fontes) {
  console.log("");
  console.log("Medindo " + fonte + "...");
  const placar = fonte === "ADN" ? await medirAdn()
    : fonte === "NFE" ? await medirSefaz("nfe")
    : fonte === "CTE" ? await medirSefaz("cte")
    : { ok: false, erro: "Fonte desconhecida: " + fonte };
  relatorio.fontes[fonte] = placar;
  if (!placar.ok) {
    console.log("  FALHOU: " + placar.erro + (placar.autenticacao ? "  (autenticacao)" : ""));
    continue;
  }
  console.log("  mTLS ok, " + placar.chamadas + " chamada(s), " + placar.lotes + " lote(s), " + placar.documentos + " documento(s)");
  console.log("  por tipo: " + (Object.entries(placar.porTipo).map(([k, v]) => k + " " + v).join(", ") || "-"));
  console.log("  papeis: emitidas " + placar.papeis.emitida + ", recebidas " + placar.papeis.recebida + ", outras " + placar.papeis.outro +
    (placar.resumos ? "; resumos sem XML " + placar.resumos : ""));
  console.log("  emissao mais antiga ainda no portal: " + (placar.emissaoMaisAntiga || "-") +
    "  | mais recente: " + (placar.emissaoMaisRecente || "-"));
  console.log("  latencia: media " + (placar.latenciaMs.media ?? "-") + " ms, maxima " + (placar.latenciaMs.maxima ?? "-") +
    " ms; HTTP " + JSON.stringify(placar.statusHttp));
  for (const observacao of placar.observacoes) console.log("  * " + observacao);
}

const saida = args.saida || "medicao-" + cnpj + "-" + new Date().toISOString().slice(0, 10) + ".json";
writeFileSync(saida, JSON.stringify(relatorio, null, 2));
console.log("");
console.log("Relatorio: " + saida + " (sem senha e sem conteudo de nota)");
