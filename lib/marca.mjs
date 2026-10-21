// Marca do escritorio: nome, logo, cores, tema, textos e contato de suporte.
//
// Vem de NUCLEO_MARCA_JSON, no mesmo formato do manifesto do escritorio que o
// kit da PONTE ja monta (escritorio-template/src/escritorio.manifest.json):
//
//   {
//     "escritorio": { "name": "...", "brandName": "...", "cnpj": "..." },
//     "branding":   { "primary": "#4f46e5", "secondary": "#1e293b", "accent": "#4f46e5",
//                     "theme": (ignorado: so o tema claro), "logo": "...", "logoDark": "...", "favicon": "..." },
//     "telas":      { "painel": true, "simples": false, ... },
//     "support":    { "email": "", "whatsapp": "", "telefone": "", "site": "" },
//     "ui":         { "browserTitle": "...", "loginMessage": "...", "footer": "...", "credit": "..." }
//   }
//
// O bloco "api" do manifesto (com o segredo) e ignorado: a chave da PONTE vem
// de NUCLEO_PONTE_CHAVE e fica no cofre. Imagem so por https ou data:image em
// base64; cor so em hexadecimal. Campo invalido cai no padrao, sem derrubar a
// subida.

export const MARCA_PADRAO = {
  nome: "NÚCLEO FISCAL",
  subtitulo: "Operação fiscal do escritório",
  tituloNavegador: "NÚCLEO FISCAL",
  mensagemLogin: "Operação fiscal do escritório",
  rodape: "",
  credito: "",
  logo: null,
  logoEscuro: null,
  favicon: null,
  cores: { primaria: null, secundaria: null, destaque: null },
  tema: "claro",
  suporte: { email: null, whatsapp: null, telefone: null, site: null },
  telas: {}
};

/** Telas do manifesto do escritorio e as do NUCLEO que cada uma liga ou desliga. */
export const TELAS_DO_MANIFESTO = {
  painel: ["dashboard"],
  empresas: ["carteira", "empresas"],
  certificados: ["certificadosA1", "certificates"],
  documentos: ["acervo"],
  conferencia: ["conferencias"],
  alertas: ["alerts"],
  simples: ["simples"],
  agenda: ["agendamentos"],
  equipe: ["users"]
};

const texto = (valor, limite = 120) => (typeof valor === "string" && valor.trim() ? valor.trim().slice(0, limite) : null);
const cor = (valor) => (typeof valor === "string" && /^#[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?$/i.test(valor.trim()) ? valor.trim() : null);
const imagem = (valor) => {
  if (typeof valor !== "string") return null;
  const v = valor.trim();
  if (/^https:\/\/[^\s"'<>]+$/i.test(v) && v.length <= 2000) return v;
  if (/^data:image\/(png|jpeg|webp|svg\+xml|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=]+$/.test(v) && v.length <= 400_000) return v;
  return null;
};
const site = (valor) => {
  const v = texto(valor, 300);
  if (!v) return null;
  const comProtocolo = /^https?:\/\//i.test(v) ? v : "https://" + v;
  return /^https?:\/\/[^\s"'<>]+$/i.test(comProtocolo) ? comProtocolo : null;
};

/** A marca valida a partir do JSON do ambiente; devolve tambem os avisos do que foi ignorado. */
export function lerMarca(json) {
  const marca = structuredClone(MARCA_PADRAO);
  const avisos = [];
  if (!json || !String(json).trim()) return { marca, avisos, personalizada: false };
  let m;
  try {
    m = JSON.parse(json);
  } catch (erro) {
    return { marca, avisos: ["NUCLEO_MARCA_JSON nao e JSON valido: " + erro.message], personalizada: false };
  }
  const esc = m.escritorio || {};
  const br = m.branding || {};
  const ui = m.ui || {};
  const sup = m.support || m.suporte || {};
  const usar = (campo, valor, original) => {
    if (valor !== null) marca[campo] = valor;
    else if (original !== undefined && original !== null && original !== "") avisos.push("marca: " + campo + " invalido, ignorado");
  };
  usar("nome", texto(esc.brandName || esc.name, 60), esc.brandName || esc.name);
  if (esc.brandName && esc.name && esc.brandName !== esc.name) marca.subtitulo = texto(esc.name, 80);
  usar("tituloNavegador", texto(ui.browserTitle, 60), ui.browserTitle);
  if (!ui.browserTitle && marca.nome !== MARCA_PADRAO.nome) marca.tituloNavegador = marca.nome;
  usar("mensagemLogin", texto(ui.loginMessage, 160), ui.loginMessage);
  usar("rodape", texto(ui.footer, 200), ui.footer);
  usar("credito", texto(ui.credit || ui.credito, 120), ui.credit || ui.credito);
  usar("logo", imagem(br.logo), br.logo);
  usar("logoEscuro", imagem(br.logoDark), br.logoDark);
  usar("favicon", imagem(br.favicon), br.favicon);
  marca.cores = { primaria: cor(br.primary), secundaria: cor(br.secondary), destaque: cor(br.accent) };
  for (const [nome, valor] of [["primary", br.primary], ["secondary", br.secondary], ["accent", br.accent]]) {
    if (valor && !cor(valor)) avisos.push("marca: cor " + nome + " invalida (use #rrggbb), ignorada");
  }
  // So o tema claro (decisao do dono, 14/10/2026): `branding.theme = "dark"`,
  // de manifesto antigo, nao escurece mais a tela.
  marca.tema = "claro";
  marca.suporte = {
    email: texto(sup.email, 120) && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(sup.email.trim()) ? sup.email.trim() : null,
    whatsapp: texto(sup.whatsapp, 30) ? sup.whatsapp.replace(/[^\d+]/g, "") || null : null,
    telefone: texto(sup.telefone || sup.phone, 30),
    site: site(sup.site || sup.website)
  };
  if (m.telas && typeof m.telas === "object") {
    for (const [tela, ligada] of Object.entries(m.telas)) {
      for (const view of TELAS_DO_MANIFESTO[tela] || []) marca.telas[view] = ligada !== false;
    }
  }
  return { marca, avisos, personalizada: true };
}
