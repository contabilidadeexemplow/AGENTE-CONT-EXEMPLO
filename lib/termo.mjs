// Termo de autorizacao e guarda do certificado A1 do cliente, em PDF, para o
// cliente assinar. Modelo: o texto e do escritorio e deve ser conferido pelo
// juridico dele antes do primeiro uso.
//
// O termo e aviso, nao trava (decisao do dono em 10/10/2026): o A1 e usado sem
// ele, e a pendencia aparece no painel da empresa ate o assinado chegar.

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const vendor = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor");
let bibliotecas = null;

function carregar() {
  if (!bibliotecas) {
    bibliotecas = {
      PDFLib: require(join(vendor, "pdf-lib.cjs")),
      fontkit: require(join(vendor, "fontkit.cjs")),
      arimo: readFileSync(join(vendor, "fonts", "Arimo_400Regular.ttf")),
      arimoBold: readFileSync(join(vendor, "fonts", "Arimo_700Bold.ttf"))
    };
  }
  return bibliotecas;
}

const cnpjBr = (cnpj) => {
  const d = String(cnpj || "").replace(/\D/g, "");
  return d.length === 14 ? d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, "$1.$2.$3/$4-$5") : (d || "____________________");
};
const dataBr = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(String(iso || "")) ? String(iso).slice(8, 10) + "/" + String(iso).slice(5, 7) + "/" +
  String(iso).slice(0, 4) : "__/__/____");

/** As clausulas do termo, em texto: o PDF e o teste leem a mesma lista. */
export function textoDoTermo({ escritorio, cliente, certificado, termo }) {
  return {
    titulo: "TERMO DE AUTORIZAÇÃO E GUARDA DE CERTIFICADO DIGITAL A1",
    partes: [
      ["CLIENTE (titular do certificado)", cliente.nome + ", CNPJ " + cnpjBr(cliente.cnpj)],
      ["ESCRITÓRIO (guardião)", (escritorio.nome || "____________________") + ", CNPJ " + cnpjBr(escritorio.cnpj)]
    ],
    certificado: [
      ["Titular", certificado.titular || "-"],
      ["CNPJ do titular", cnpjBr(certificado.titularCnpj)],
      ["Emissor", certificado.emissor || "-"],
      ["Número de série", certificado.serie || "-"],
      ["Validade", dataBr(certificado.validoDe) + " a " + dataBr(certificado.validoAte)],
      ["Impressão digital (SHA-256)", certificado.impressaoDigital || "-"]
    ],
    clausulas: [
      "1. FINALIDADE. O CLIENTE autoriza o ESCRITÓRIO a guardar o certificado acima e a usá-lo somente para consultar e " +
        "baixar, nos ambientes oficiais (Ambiente Nacional da NFS-e e SEFAZ), os documentos fiscais em que o CLIENTE é parte " +
        "(NF-e, NFC-e, NFS-e e CT-e) e os eventos deles, para a escrituração e as obrigações fiscais a cargo do ESCRITÓRIO.",
      "2. MANIFESTAÇÃO. A Ciência da Operação e as demais manifestações do destinatário só são registradas por ordem expressa " +
        "do CLIENTE ou do responsável do ESCRITÓRIO, nota a nota, e ficam registradas com quem ordenou.",
      "3. VEDAÇÕES. O certificado não será usado para emitir documento fiscal, assinar contrato ou declaração, acessar conta " +
        "bancária ou para qualquer outro fim além do previsto na cláusula 1.",
      "4. GUARDA. O arquivo do certificado e a senha ficam cifrados (AES-256-GCM) no sistema do ESCRITÓRIO, com chave que não " +
        "fica no banco de dados. Cada uso fica registrado na trilha de auditoria do sistema.",
      "5. PRAZO E REVOGAÇÃO. Este termo vale até o vencimento do certificado ou até o CLIENTE revogá-lo por escrito. Na " +
        "revogação, o certificado é retirado do sistema em até 2 (dois) dias úteis. Certificado novo exige novo termo.",
      "6. DADOS PESSOAIS. Os dados tratados por força deste termo seguem a Lei 13.709/2018 (LGPD) e só são usados para a " +
        "finalidade da cláusula 1."
    ],
    rodape: "Autorizado por (informado no cadastro): " + (termo.autorizadoPor || "____________________") +
      (termo.referencia ? ". Referência: " + termo.referencia : "") + ". Termo nº " + String(termo.id || "").slice(0, 8).toUpperCase() +
      ", gerado em " + dataBr(new Date().toISOString()) + "."
  };
}

/** PDF A4 em pe do termo, para imprimir ou assinar digitalmente. Devolve um Buffer. */
export async function gerarPdfTermo(dados) {
  const { PDFLib, fontkit, arimo, arimoBold } = carregar();
  const { PDFDocument, rgb } = PDFLib;
  const texto = textoDoTermo(dados);
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle(texto.titulo);
  pdf.setProducer(dados.marca || "NÚCLEO FISCAL");
  const fonte = await pdf.embedFont(arimo, { subset: true });
  const negrito = await pdf.embedFont(arimoBold, { subset: true });
  const LARGURA = 595.28;
  const ALTURA = 841.89;
  const MARGEM = 56;
  const util = LARGURA - MARGEM * 2;
  const tinta = rgb(0.12, 0.13, 0.2);
  const cinza = rgb(0.42, 0.45, 0.5);
  let pagina = pdf.addPage([LARGURA, ALTURA]);
  let y = ALTURA - MARGEM;

  const quebrar = (frase, f, tamanho, largura) => {
    const linhas = [];
    let atual = "";
    for (const palavra of String(frase).split(/\s+/)) {
      const tentativa = atual ? atual + " " + palavra : palavra;
      if (f.widthOfTextAtSize(tentativa, tamanho) > largura && atual) { linhas.push(atual); atual = palavra; }
      else atual = tentativa;
    }
    if (atual) linhas.push(atual);
    return linhas;
  };
  const escrever = (frase, { f = fonte, tamanho = 10, cor = tinta, recuo = 0, depois = 4 } = {}) => {
    for (const linha of quebrar(frase, f, tamanho, util - recuo)) {
      if (y < MARGEM + 40) { pagina = pdf.addPage([LARGURA, ALTURA]); y = ALTURA - MARGEM; }
      pagina.drawText(linha, { x: MARGEM + recuo, y: y - tamanho, size: tamanho, font: f, color: cor });
      y -= tamanho * 1.45;
    }
    y -= depois;
  };

  escrever((dados.marca || "NÚCLEO FISCAL").toUpperCase(), { f: negrito, tamanho: 8, cor: cinza, depois: 8 });
  escrever(texto.titulo, { f: negrito, tamanho: 13, depois: 12 });
  for (const [rotulo, valor] of texto.partes) escrever(rotulo + ": " + valor, { depois: 2 });
  y -= 8;
  escrever("CERTIFICADO", { f: negrito, tamanho: 10, depois: 2 });
  for (const [rotulo, valor] of texto.certificado) escrever(rotulo + ": " + valor, { tamanho: 9, recuo: 10, depois: 1 });
  y -= 8;
  for (const clausula of texto.clausulas) escrever(clausula, { tamanho: 9.5, depois: 6 });
  y -= 4;
  escrever(texto.rodape, { tamanho: 8.5, cor: cinza, depois: 22 });
  escrever("Local e data: ______________________________, ____/____/________", { depois: 30 });
  const assinatura = (rotulo) => {
    if (y < MARGEM + 70) { pagina = pdf.addPage([LARGURA, ALTURA]); y = ALTURA - MARGEM; }
    pagina.drawLine({ start: { x: MARGEM, y: y - 2 }, end: { x: MARGEM + 300, y: y - 2 }, thickness: 0.6, color: tinta });
    y -= 6;
    escrever(rotulo, { tamanho: 8.5, cor: cinza, depois: 26 });
  };
  assinatura("CLIENTE: nome, CPF e cargo de quem assina");
  assinatura("ESCRITÓRIO: nome, CPF e cargo de quem assina");
  return Buffer.from(await pdf.save());
}
