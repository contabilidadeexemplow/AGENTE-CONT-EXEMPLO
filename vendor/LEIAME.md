# Codigo de terceiros

Copiado sem alteracao da extensao "EXT.ACAO CONTABIL P. BAIXAR NFSE SET 26",
para que o gerador de DANFSe rode no servidor exatamente como roda no navegador.

| Arquivo | Origem | Licenca |
|---|---|---|
| `danfse.cjs` | `danfse.js` da extensao (layout NT 008 SE/CGNFS-e) | da extensao |
| `ibge-municipios.cjs`, `nbs-tabela.cjs` | tabelas de apoio da extensao | da extensao |
| `pdf-lib.cjs` | pdf-lib (bundle UMD) | MIT |
| `fontkit.cjs` | fontkit (bundle UMD) | MIT |
| `qrcode.cjs` | qrcode-generator (Kazuhiko Arase) | MIT |
| `fonts/Arimo_*.ttf` | Arimo, metrica identica a Arial | Apache 2.0 |
| `nfse-logo.png` | logo da NFS-e usado no DANFSe | da extensao |

A extensao usa `DOMParser` do navegador. No Node, `lib/danfse.mjs` instala
um adaptador minimo de DOM sobre `lib/xml.mjs` antes de carregar `danfse.cjs`.
Nao edite os arquivos daqui: atualize copiando de novo da extensao.
