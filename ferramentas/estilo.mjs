// Monta o visual: copia a fonte Inter Tight para public/fonts e compila
// estilo/nucleo.css (Tailwind 4) em public/styles.css.
//
//   npm run css
//
// O resultado vai para o repositorio: o Render nao instala nem compila nada
// (buildCommand do render.yaml e so "node --version").

import { copyFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");
const origem = join(raiz, "node_modules", "@fontsource-variable", "inter-tight", "files");
const destino = join(raiz, "public", "fonts");

await mkdir(destino, { recursive: true });
for (const arquivo of ["inter-tight-latin-wght-normal.woff2", "inter-tight-latin-ext-wght-normal.woff2"]) {
  await copyFile(join(origem, arquivo), join(destino, arquivo));
}

const cli = join(raiz, "node_modules", "@tailwindcss", "cli", "dist", "index.mjs");
const resultado = spawnSync(process.execPath, [cli, "-i", join(raiz, "estilo", "nucleo.css"),
  "-o", join(raiz, "public", "styles.css"), "--minify"], { stdio: "inherit" });
process.exitCode = resultado.status ?? 1;
