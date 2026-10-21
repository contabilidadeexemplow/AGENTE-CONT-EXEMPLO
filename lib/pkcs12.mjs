// Abre o certificado A1 (PFX / PKCS#12) e entrega chave e certificados em PEM,
// sem dependencia e sem o provedor legado do OpenSSL.
//
// POR QUE ISTO EXISTE: o A1 brasileiro quase sempre vem com os certificados
// cifrados em RC2-40 e a chave em 3DES (pbeWithSHAAnd40BitRC2-CBC e
// pbeWithSHAAnd3-KeyTripleDES-CBC), que e o que o Windows exporta. O OpenSSL 3
// do Node so abre RC2 com o provedor legado: passar o .pfx cru ao https/tls
// falhava com "Unsupported PKCS12 PFX data" e a captura inteira so funcionava
// porque o `npm start` liga `--openssl-legacy-provider`. Trocado o comando de
// inicio (ou o Node deixando de aceitar a opcao), a captura parava. Aqui o
// PKCS#12 e lido em JavaScript, o RC2 e o RC4 sao decifrados em JavaScript, e o
// resto vai para cifras que o OpenSSL 3 tem no provedor padrao (3DES e AES).
//
// Estrutura (RFC 7292):
//   PFX            = SEQUENCE { version, authSafe ContentInfo, macData? }
//   authSafe       = ContentInfo(data) -> OCTET STRING -> SEQUENCE OF ContentInfo
//   ContentInfo    = data (SafeContents em claro) | encryptedData (SafeContents cifrado)
//   SafeContents   = SEQUENCE OF SafeBag { bagId, [0] bagValue, attributes? }
//
// O que o arquivo pode trazer e daqui sai lido:
//   - chave em pkcs8ShroudedKeyBag (cifrada) ou em keyBag (sem cifra);
//   - blocos cifrados com o PBE do PKCS#12 (RC2-40, RC2-128, RC4, 3DES de 2 e
//     de 3 chaves) ou com PBES2 (PBKDF2 + AES ou 3DES);
//   - MAC de integridade HMAC (SHA-1 a SHA-512) ou PBMAC1;
//   - BER com tamanho indefinido e OCTET STRING em pedacos (exportacao do
//     Firefox/NSS), que o OpenSSL aceitava e um leitor so de DER recusaria.

import crypto from "node:crypto";

/**
 * Erro de leitura do PKCS#12. `motivo` diz o que fazer com ele:
 *   "senha"     -> a senha nao confere com o arquivo;
 *   "algoritmo" -> o arquivo usa uma cifra que este leitor nao conhece;
 *   "arquivo"   -> nao e um PKCS#12 inteiro (corrompido, truncado, outro formato).
 */
export class ErroPkcs12 extends Error {
  constructor(mensagem, motivo) {
    super(mensagem);
    this.name = "ErroPkcs12";
    this.motivo = motivo;
  }
}

const arquivo = (mensagem) => new ErroPkcs12(mensagem, "arquivo");

const OID = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  envelopedData: "1.2.840.113549.1.7.3",
  encryptedData: "1.2.840.113549.1.7.6",
  keyBag: "1.2.840.113549.1.12.10.1.1",
  shroudedKeyBag: "1.2.840.113549.1.12.10.1.2",
  certBag: "1.2.840.113549.1.12.10.1.3",
  safeContentsBag: "1.2.840.113549.1.12.10.1.6",
  x509Certificate: "1.2.840.113549.1.9.22.1",
  pbes2: "1.2.840.113549.1.5.13",
  pbkdf2: "1.2.840.113549.1.5.12",
  pbmac1: "1.2.840.113549.1.5.14"
};

// PBE do proprio PKCS#12 (RFC 7292, apendice C): chave e IV saem do KDF do
// PKCS#12 com SHA-1 e a senha em BMPString.
const PBE_PKCS12 = {
  "1.2.840.113549.1.12.1.1": { cifra: "rc4", chave: 16 },
  "1.2.840.113549.1.12.1.2": { cifra: "rc4", chave: 5 },
  "1.2.840.113549.1.12.1.3": { cifra: "3des", chave: 24 },
  "1.2.840.113549.1.12.1.4": { cifra: "2des", chave: 16 },
  "1.2.840.113549.1.12.1.5": { cifra: "rc2", chave: 16 },
  "1.2.840.113549.1.12.1.6": { cifra: "rc2", chave: 5 }
};

const HMAC = {
  "1.2.840.113549.2.7": "sha1",
  "1.2.840.113549.2.8": "sha224",
  "1.2.840.113549.2.9": "sha256",
  "1.2.840.113549.2.10": "sha384",
  "1.2.840.113549.2.11": "sha512"
};

const CIFRA_PBES2 = {
  "2.16.840.1.101.3.4.1.2": ["aes-128-cbc", 16],
  "2.16.840.1.101.3.4.1.22": ["aes-192-cbc", 24],
  "2.16.840.1.101.3.4.1.42": ["aes-256-cbc", 32],
  "1.2.840.113549.3.7": ["des-ede3-cbc", 24]
};

const HASH_DO_MAC = {
  "1.3.14.3.2.26": "sha1",
  "2.16.840.1.101.3.4.2.4": "sha224",
  "2.16.840.1.101.3.4.2.1": "sha256",
  "2.16.840.1.101.3.4.2.2": "sha384",
  "2.16.840.1.101.3.4.2.3": "sha512"
};

// Tamanho de saida (u) e de bloco (v) de cada hash, para o KDF do PKCS#12.
const MEDIDAS = { sha1: [20, 64], sha224: [28, 64], sha256: [32, 64], sha384: [48, 128], sha512: [64, 128] };

// O servidor do NUCLEO tem uma instancia so: um arquivo com contagem absurda
// de iteracoes travaria o processo inteiro (site e captura) enquanto o KDF gira.
// O Windows usa 2000, o OpenSSL 2048; a folga aqui e de centenas de vezes.
const ITERACOES_MAXIMAS = 1_000_000;

// ------------------------------------------------------------ DER / BER

function lerTlv(buffer, posicao) {
  if (posicao + 2 > buffer.length) throw arquivo("PFX truncado");
  const tag = buffer[posicao];
  if ((tag & 0x1f) === 0x1f) throw arquivo("PFX com etiqueta ASN.1 que o PKCS#12 nao usa");
  let tamanho = buffer[posicao + 1];
  let cabecalho = 2;
  if (tamanho === 0x80) {
    // BER de tamanho indefinido: o conteudo vai ate o par 00 00.
    if (!(tag & 0x20)) throw arquivo("PFX com tamanho indefinido em campo simples");
    const inicio = posicao + 2;
    let fim = inicio;
    for (;;) {
      if (fim + 2 > buffer.length) throw arquivo("PFX truncado");
      if (buffer[fim] === 0 && buffer[fim + 1] === 0) break;
      fim = lerTlv(buffer, fim).fim;
    }
    return { tag, fim: fim + 2, bruto: buffer.subarray(posicao, fim + 2), valor: buffer.subarray(inicio, fim) };
  }
  if (tamanho & 0x80) {
    const bytes = tamanho & 0x7f;
    if (bytes > 4) throw arquivo("PFX com campo grande demais");
    tamanho = 0;
    for (let i = 0; i < bytes; i += 1) tamanho = tamanho * 256 + buffer[posicao + 2 + i];
    cabecalho += bytes;
  }
  const inicio = posicao + cabecalho;
  const fim = inicio + tamanho;
  if (fim > buffer.length) throw arquivo("PFX truncado");
  return { tag, fim, bruto: buffer.subarray(posicao, fim), valor: buffer.subarray(inicio, fim) };
}

function filhos(no) {
  const lista = [];
  let posicao = 0;
  while (posicao < no.valor.length) {
    const filho = lerTlv(no.valor, posicao);
    lista.push(filho);
    posicao = filho.fim;
  }
  return lista;
}

function oid(no) {
  if (!no || no.tag !== 0x06 || !no.valor.length) throw arquivo("PFX sem o identificador esperado");
  const bytes = no.valor;
  const primeiro = Math.min(2, Math.floor(bytes[0] / 40));
  const partes = [primeiro, bytes[0] - 40 * primeiro];
  let acumulado = 0;
  for (let i = 1; i < bytes.length; i += 1) {
    acumulado = acumulado * 128 + (bytes[i] & 0x7f);
    if (!(bytes[i] & 0x80)) { partes.push(acumulado); acumulado = 0; }
  }
  return partes.join(".");
}

function inteiro(no) {
  if (!no || no.tag !== 0x02) throw arquivo("PFX sem o numero esperado");
  let valor = 0;
  for (const byte of no.valor) valor = valor * 256 + byte;
  return valor;
}

/** Conteudo de um [0] EXPLICIT: o unico filho do no de contexto. */
function explicito(no) {
  const [filho] = filhos(no);
  if (!filho) throw arquivo("PFX com campo vazio");
  return filho;
}

/** Bytes de um OCTET STRING, simples ou em pedacos (BER construido). */
function octetos(no) {
  if (no.tag === 0x04 || no.tag === 0x80) return no.valor;
  if (no.tag === 0x24 || no.tag === 0xa0) return Buffer.concat(filhos(no).map(octetos));
  throw arquivo("PFX sem os bytes esperados");
}

function iteracoesDe(no) {
  const valor = inteiro(no);
  if (valor < 1 || valor > ITERACOES_MAXIMAS) throw arquivo("PFX com contagem de iteracoes fora do comum: " + valor);
  return valor;
}

// ------------------------------------------------------------ KDF do PKCS#12

const resumo = (hash, dados) => (crypto.hash ? crypto.hash(hash, dados, "buffer") : crypto.createHash(hash).update(dados).digest());

function repetirAte(bytes, tamanho) {
  const saida = Buffer.alloc(tamanho);
  for (let i = 0; i < tamanho; i += 1) saida[i] = bytes[i % bytes.length];
  return saida;
}

/** RFC 7292, apendice B.2. id 1 = chave, 2 = IV, 3 = chave do MAC. */
function chavePkcs12(hash, senhaBmp, sal, id, iteracoes, tamanho) {
  const [u, v] = MEDIDAS[hash];
  const diversificador = Buffer.alloc(v, id);
  const s = sal.length ? repetirAte(sal, v * Math.ceil(sal.length / v)) : Buffer.alloc(0);
  const p = senhaBmp.length ? repetirAte(senhaBmp, v * Math.ceil(senhaBmp.length / v)) : Buffer.alloc(0);
  const I = Buffer.concat([s, p]);
  const blocos = [];
  for (let n = 0; n * u < tamanho; n += 1) {
    let A = resumo(hash, Buffer.concat([diversificador, I]));
    for (let i = 1; i < iteracoes; i += 1) A = resumo(hash, A);
    blocos.push(A);
    if ((n + 1) * u >= tamanho) break;
    const B = repetirAte(A, v);
    for (let j = 0; j < I.length; j += v) {
      let vaiUm = 1;
      for (let k = v - 1; k >= 0; k -= 1) {
        const soma = I[j + k] + B[k] + vaiUm;
        I[j + k] = soma & 0xff;
        vaiUm = soma >> 8;
      }
    }
  }
  return Buffer.concat(blocos).subarray(0, tamanho);
}

/** A senha como o PKCS#12 a usa: UTF-16 big-endian com dois zeros no fim. */
function senhaBmp(senha) {
  const bytes = Buffer.from(senha + "\0", "utf16le");
  return bytes.swap16();
}

// ------------------------------------------------------------ RC2 e RC4

// RFC 2268, PITABLE (permutacao tirada dos digitos de pi).
const PITABLE = Buffer.from(
  "d978f9c419ddb5ed28e9fd794aa0d89dc67e37832b76538e624c6488448bfba2" +
  "179a59f587b34f1361456d8d09817d32bd8f40eb86b77b0bf09521225c6b4e82" +
  "54d66593ce60b21c7356c014a78cf1dc1275ca1f3bbee4d1423dd430a33cb626" +
  "6fbf0eda4669075727f21d9bbc944303f811c7f690ef3ee706c3d52fc8661ed7" +
  "08e8eade8052eef784aa72ac354d6a2a961ad2715a1549744b9fd05e0418a4ec" +
  "c2e0416e0f51cbcc2491af50a1f47039997c3a8523b8b47afc02365b25559731" +
  "2d5dfa98e38a92ae05df2910676cbac9d300e6cfe19ea82c6316013f58e289a9" +
  "0d38341bab33ffb0bb480c5fb9b1cd2ec5f3db47e5a59c770aa62068fe7fc1ad", "hex");

function expandirRc2(chave, bitsEfetivos) {
  const L = Buffer.alloc(128);
  chave.copy(L);
  const T = chave.length;
  const T8 = Math.ceil(bitsEfetivos / 8);
  const TM = 0xff >> (8 * T8 - bitsEfetivos);
  for (let i = T; i < 128; i += 1) L[i] = PITABLE[(L[i - 1] + L[i - T]) & 0xff];
  L[128 - T8] = PITABLE[L[128 - T8] & TM];
  for (let i = 127 - T8; i >= 0; i -= 1) L[i] = PITABLE[L[i + 1] ^ L[i + T8]];
  const K = new Uint16Array(64);
  for (let i = 0; i < 64; i += 1) K[i] = L[2 * i] + 256 * L[2 * i + 1];
  return K;
}

const GIRO = [1, 2, 3, 5];

function decifrarBlocoRc2(K, bloco) {
  const R = [bloco.readUInt16LE(0), bloco.readUInt16LE(2), bloco.readUInt16LE(4), bloco.readUInt16LE(6)];
  let j = 63;
  const mistura = () => {
    for (let i = 3; i >= 0; i -= 1) {
      R[i] = ((R[i] >>> GIRO[i]) | (R[i] << (16 - GIRO[i]))) & 0xffff;
      R[i] = (R[i] - K[j] - (R[(i + 3) % 4] & R[(i + 2) % 4]) - (~R[(i + 3) % 4] & R[(i + 1) % 4])) & 0xffff;
      j -= 1;
    }
  };
  const amasso = () => {
    for (let i = 3; i >= 0; i -= 1) R[i] = (R[i] - K[R[(i + 3) % 4] & 63]) & 0xffff;
  };
  for (let n = 0; n < 5; n += 1) mistura();
  amasso();
  for (let n = 0; n < 6; n += 1) mistura();
  amasso();
  for (let n = 0; n < 5; n += 1) mistura();
  const saida = Buffer.alloc(8);
  R.forEach((palavra, i) => saida.writeUInt16LE(palavra, 2 * i));
  return saida;
}

function tirarEnchimento(dados, bloco) {
  const n = dados.length ? dados[dados.length - 1] : 0;
  if (!dados.length || dados.length % bloco || n < 1 || n > bloco) throw new Error("bad decrypt");
  for (let i = dados.length - n; i < dados.length; i += 1) if (dados[i] !== n) throw new Error("bad decrypt");
  return dados.subarray(0, dados.length - n);
}

function decifrarRc2Cbc(chave, bitsEfetivos, iv, cifrado) {
  if (!cifrado.length || cifrado.length % 8) throw new Error("bad decrypt");
  const K = expandirRc2(chave, bitsEfetivos);
  const claro = Buffer.alloc(cifrado.length);
  let anterior = iv;
  for (let p = 0; p < cifrado.length; p += 8) {
    const bloco = cifrado.subarray(p, p + 8);
    const decifrado = decifrarBlocoRc2(K, bloco);
    for (let i = 0; i < 8; i += 1) claro[p + i] = decifrado[i] ^ anterior[i];
    anterior = bloco;
  }
  return tirarEnchimento(claro, 8);
}

function rc4(chave, dados) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i += 1) S[i] = i;
  for (let i = 0, j = 0; i < 256; i += 1) {
    j = (j + S[i] + chave[i % chave.length]) & 0xff;
    [S[i], S[j]] = [S[j], S[i]];
  }
  const saida = Buffer.alloc(dados.length);
  for (let n = 0, i = 0, j = 0; n < dados.length; n += 1) {
    i = (i + 1) & 0xff;
    j = (j + S[i]) & 0xff;
    [S[i], S[j]] = [S[j], S[i]];
    saida[n] = dados[n] ^ S[(S[i] + S[j]) & 0xff];
  }
  return saida;
}

function decifrarNoNode(nome, chave, iv, cifrado) {
  const decifra = crypto.createDecipheriv(nome, chave, iv);
  return Buffer.concat([decifra.update(cifrado), decifra.final()]);
}

// ------------------------------------------------------------ decifrar

class AlgoritmoDesconhecido extends ErroPkcs12 {
  constructor(id) {
    super("Certificado cifrado com um algoritmo que o NUCLEO nao le (" + id + ")", "algoritmo");
  }
}

function decifrarPbePkcs12(regra, parametros, cifrado, senha) {
  const [sal, iteracoes] = filhos(parametros);
  const bmp = senha.bmp;
  const n = iteracoesDe(iteracoes);
  const chave = chavePkcs12("sha1", bmp, octetos(sal), 1, n, regra.chave);
  if (regra.cifra === "rc4") return rc4(chave, cifrado);
  const iv = chavePkcs12("sha1", bmp, octetos(sal), 2, n, 8);
  if (regra.cifra === "rc2") return decifrarRc2Cbc(chave, regra.chave * 8, iv, cifrado);
  // 3DES de duas chaves e o de tres com K3 = K1.
  const chave3 = regra.cifra === "2des" ? Buffer.concat([chave, chave.subarray(0, 8)]) : chave;
  return decifrarNoNode("des-ede3-cbc", chave3, iv, cifrado);
}

/** PBKDF2 a partir do AlgorithmIdentifier dele: { chave(tamanho), prf }. */
function pbkdf2De(kdf, senhaUtf8, tamanhoPadrao) {
  const [kdfOid, kdfParams] = filhos(kdf);
  if (oid(kdfOid) !== OID.pbkdf2) throw new AlgoritmoDesconhecido(oid(kdfOid));
  const campos = filhos(kdfParams);
  if (campos[0].tag !== 0x04) throw new AlgoritmoDesconhecido("PBKDF2 com sal de outra fonte");
  const sal = campos[0].valor;
  const iteracoes = iteracoesDe(campos[1]);
  let tamanho = tamanhoPadrao;
  let prf = "sha1";
  for (const campo of campos.slice(2)) {
    if (campo.tag === 0x02) tamanho = inteiro(campo);
    if (campo.tag === 0x30) {
      const idPrf = oid(filhos(campo)[0]);
      prf = HMAC[idPrf];
      if (!prf) throw new AlgoritmoDesconhecido(idPrf);
    }
  }
  if (!tamanho) throw arquivo("PBKDF2 sem o tamanho da chave");
  return crypto.pbkdf2Sync(senhaUtf8, sal, iteracoes, tamanho, prf);
}

function decifrarPbes2(parametros, cifrado, senha) {
  const [kdf, esquema] = filhos(parametros);
  const [esquemaOid, iv] = filhos(esquema);
  const cifra = CIFRA_PBES2[oid(esquemaOid)];
  if (!cifra) throw new AlgoritmoDesconhecido(oid(esquemaOid));
  const chave = pbkdf2De(kdf, senha.utf8, cifra[1]);
  return decifrarNoNode(cifra[0], chave, octetos(iv), cifrado);
}

/**
 * Decifra um bloco (EncryptedContentInfo ou EncryptedPrivateKeyInfo) pelo
 * AlgorithmIdentifier dele. Bloco que nao abre, com o MAC ja conferido, e
 * arquivo estragado; sem MAC, so pode ser a senha.
 */
function decifrar(algoritmo, cifrado, senha, temMac) {
  const [idNo, parametros] = filhos(algoritmo);
  const id = oid(idNo);
  try {
    if (PBE_PKCS12[id]) return decifrarPbePkcs12(PBE_PKCS12[id], parametros, cifrado, senha);
    if (id === OID.pbes2) return decifrarPbes2(parametros, cifrado, senha);
  } catch (erro) {
    if (erro instanceof ErroPkcs12) throw erro;
    if (/unsupported/i.test(String(erro.message))) throw new AlgoritmoDesconhecido(id);
    throw temMac
      ? arquivo("PFX com um bloco cifrado que nao abre com a senha que confere o arquivo")
      : new ErroPkcs12("Senha do certificado incorreta", "senha");
  }
  throw new AlgoritmoDesconhecido(id);
}

// ------------------------------------------------------------ MAC

function conferirMac(macData, conteudo, senha) {
  const [digestInfo, macSalt, macIter] = filhos(macData);
  const [algoritmo, digest] = filhos(digestInfo);
  const [idNo, parametros] = filhos(algoritmo);
  const id = oid(idNo);
  let hash;
  let chave;
  if (id === OID.pbmac1) {
    // RFC 9579: a chave sai do PBKDF2 dos parametros; macSalt e iteracoes
    // do MacData ficam so por compatibilidade e nao entram na conta.
    const [kdf, esquema] = filhos(parametros);
    const idEsquema = oid(filhos(esquema)[0]);
    hash = HMAC[idEsquema];
    if (!hash) throw new AlgoritmoDesconhecido(idEsquema);
    chave = pbkdf2De(kdf, senha.utf8, 0);
  } else {
    hash = HASH_DO_MAC[id];
    if (!hash) throw new AlgoritmoDesconhecido(id);
    const iteracoes = macIter ? iteracoesDe(macIter) : 1;
    chave = chavePkcs12(hash, senha.bmp, octetos(macSalt), 3, iteracoes, MEDIDAS[hash][0]);
  }
  const calculado = crypto.createHmac(hash, chave).update(conteudo).digest();
  const esperado = octetos(digest);
  return calculado.length === esperado.length && crypto.timingSafeEqual(calculado, esperado);
}

/**
 * As formas da senha a experimentar. Senha vazia tem duas leituras no
 * PKCS#12 (sem bytes, ou so o terminador 00 00) e cada programa grava de um
 * jeito; o OpenSSL experimenta as duas, nessa ordem, e aqui tambem.
 */
function formasDaSenha(senha) {
  const utf8 = Buffer.from(senha, "utf8");
  if (senha === "") return [{ bmp: Buffer.alloc(0), utf8 }, { bmp: senhaBmp(""), utf8 }];
  return [{ bmp: senhaBmp(senha), utf8 }];
}

// ------------------------------------------------------------ extracao

function coletarBags(safeContents, bags, profundidade = 0) {
  if (profundidade > 4) throw arquivo("PFX com bolsas aninhadas demais");
  for (const bag of filhos(safeContents)) {
    const [id, valorCtx, atributos] = filhos(bag);
    const tipo = oid(id);
    const valor = explicito(valorCtx);
    if (tipo === OID.safeContentsBag) coletarBags(valor, bags, profundidade + 1);
    else bags.push({ tipo, valor, atributos });
  }
}

function chaveDoBag(bag, senha, temMac) {
  if (bag.tipo === OID.keyBag) {
    return crypto.createPrivateKey({ key: bag.valor.bruto, format: "der", type: "pkcs8" });
  }
  const [algoritmo, cifrado] = filhos(bag.valor);
  try {
    const claro = decifrar(algoritmo, octetos(cifrado), senha, temMac);
    return crypto.createPrivateKey({ key: claro, format: "der", type: "pkcs8" });
  } catch (erro) {
    // Cifra de chave que este leitor nao conhece (PBES1 com DES, por exemplo):
    // o OpenSSL do Node ainda pode conhece-la, entao ele tenta antes de recusar.
    if (!(erro instanceof AlgoritmoDesconhecido)) throw erro;
    try {
      return crypto.createPrivateKey({ key: bag.valor.bruto, format: "der", type: "pkcs8", passphrase: senha.utf8 });
    } catch {
      throw erro;
    }
  }
}

/**
 * Abre o PFX com a senha. Devolve { chavePrivada: KeyObject, certificado:
 * X509Certificate (o do titular, par da chave), cadeia: X509Certificate[] (os
 * demais, na ordem do arquivo) }. Lanca ErroPkcs12.
 */
export function abrirPkcs12(pfx, senha) {
  const bytes = Buffer.isBuffer(pfx) ? pfx : Buffer.from(pfx ?? []);
  const texto = String(senha ?? "");
  try {
    return abrir(bytes, texto);
  } catch (erro) {
    if (erro instanceof ErroPkcs12) throw erro;
    // Indice fora do lugar, OID onde devia vir numero: arquivo que nao e PFX.
    throw arquivo("Arquivo nao e um PKCS#12 legivel (" + erro.message + ")");
  }
}

function abrir(pfx, texto) {
  const raiz = lerTlv(pfx, 0);
  if (raiz.tag !== 0x30) throw arquivo("Arquivo nao e um PKCS#12");
  const [, authSafe, macData] = filhos(raiz);
  if (!authSafe) throw arquivo("Arquivo nao e um PKCS#12");
  const [tipoAuth, conteudoAuth] = filhos(authSafe);
  const tipo = oid(tipoAuth);
  if (tipo === OID.signedData) {
    throw new ErroPkcs12("PFX com integridade por chave publica, que o NUCLEO nao le", "algoritmo");
  }
  if (tipo !== OID.data) throw arquivo("Arquivo nao e um PKCS#12");
  const conteudo = octetos(explicito(conteudoAuth));

  const formas = formasDaSenha(texto);
  let senha = formas[0];
  const temMac = Boolean(macData);
  if (temMac) {
    senha = formas.find((forma) => conferirMac(macData, conteudo, forma));
    if (!senha) throw new ErroPkcs12("Senha do certificado incorreta", "senha");
  }

  const bags = [];
  for (const contentInfo of filhos(lerTlv(conteudo, 0))) {
    const [tipoNo, valor] = filhos(contentInfo);
    const tipoConteudo = oid(tipoNo);
    if (tipoConteudo === OID.data) {
      coletarBags(lerTlv(octetos(explicito(valor)), 0), bags);
    } else if (tipoConteudo === OID.encryptedData) {
      const [, encryptedContentInfo] = filhos(explicito(valor));
      const [, algoritmo, cifradoNo] = filhos(encryptedContentInfo);
      if (!cifradoNo) continue;
      coletarBags(lerTlv(decifrar(algoritmo, octetos(cifradoNo), senha, temMac), 0), bags);
    } else if (tipoConteudo === OID.envelopedData) {
      throw new ErroPkcs12("PFX cifrado por chave publica, que o NUCLEO nao le", "algoritmo");
    }
  }

  const chaves = [];
  const certificados = [];
  for (const bag of bags) {
    if (bag.tipo === OID.keyBag || bag.tipo === OID.shroudedKeyBag) {
      chaves.push(chaveDoBag(bag, senha, temMac));
    } else if (bag.tipo === OID.certBag) {
      const [tipoCert, valorCert] = filhos(bag.valor);
      if (oid(tipoCert) !== OID.x509Certificate) continue;
      certificados.push(new crypto.X509Certificate(octetos(explicito(valorCert))));
    }
  }
  if (!chaves.length) throw arquivo("Chave privada nao encontrada no PFX");
  if (!certificados.length) throw arquivo("PFX sem certificado de usuario");

  // O do titular e o par da chave: o mesmo que o OpenSSL escolhia. Nao vale
  // "o primeiro", porque ha exportador que grava a cadeia antes do titular.
  for (const chavePrivada of chaves) {
    const certificado = certificados.find((item) => item.checkPrivateKey(chavePrivada));
    if (certificado) {
      return { chavePrivada, certificado, cadeia: certificados.filter((item) => item !== certificado) };
    }
  }
  throw arquivo("A chave privada do PFX nao corresponde a nenhum certificado dele");
}

/**
 * O A1 em PEM: { key, cert, ca }, pronto para o https/tls do Node.
 *
 *   key  -> chave privada em PKCS#8 sem cifra (fica so na memoria do processo,
 *           como ficava dentro do OpenSSL quando ele abria o .pfx);
 *   cert -> o certificado do titular;
 *   ca   -> os demais certificados do arquivo (a cadeia da AC), na ordem dele.
 *
 * Tambem devolve os objetos ja abertos (chavePrivada, certificado, cadeia),
 * para quem assina ou confere titular e validade nao abrir o arquivo de novo.
 */
export function pfxParaPem(pfx, senha) {
  const { chavePrivada, certificado, cadeia } = abrirPkcs12(pfx, senha);
  return {
    key: chavePrivada.export({ type: "pkcs8", format: "pem" }),
    cert: certificado.toString(),
    ca: cadeia.map((item) => item.toString()),
    chavePrivada,
    certificado,
    cadeia
  };
}

/**
 * Abre o PFX e devolve { chavePrivada: KeyObject, certificadoDer: Buffer, x509 },
 * para ASSINAR (XMLDSig da manifestacao da NF-e). A chave ja sai conferida como
 * par do certificado.
 */
export function abrirParaAssinatura(pfx, senha) {
  const { chavePrivada, certificado } = abrirPkcs12(pfx, senha);
  return { chavePrivada, certificadoDer: certificado.raw, x509: certificado };
}
