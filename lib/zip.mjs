// Leitura de arquivos ZIP usando apenas zlib do Node.
// Suporta store (0) e deflate (8), que cobrem o que prefeituras, ERPs e a
// Receita entregam. Le o diretorio central, nao confia no header local.

import { inflateRawSync } from "node:zlib";

const EOCD = 0x06054b50;
const EOCD64_LOCATOR = 0x07064b50;
const EOCD64 = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

function findEocd(buffer) {
  const floor = Math.max(0, buffer.length - 66_000);
  for (let at = buffer.length - 22; at >= floor; at -= 1) {
    if (buffer.readUInt32LE(at) === EOCD) return at;
  }
  throw new Error("ZIP invalido: fim do diretorio central nao encontrado");
}

function readZip64(buffer, eocdAt) {
  const locatorAt = eocdAt - 20;
  if (locatorAt < 0 || buffer.readUInt32LE(locatorAt) !== EOCD64_LOCATOR) return null;
  const at = Number(buffer.readBigUInt64LE(locatorAt + 8));
  if (at < 0 || at + 56 > buffer.length || buffer.readUInt32LE(at) !== EOCD64) return null;
  return {
    entries: Number(buffer.readBigUInt64LE(at + 32)),
    offset: Number(buffer.readBigUInt64LE(at + 48))
  };
}

function zip64Extra(extra, needSize, needOffset) {
  const patch = {};
  let at = 0;
  while (at + 4 <= extra.length) {
    const id = extra.readUInt16LE(at);
    const size = extra.readUInt16LE(at + 2);
    if (id === 0x0001) {
      let field = at + 4;
      if (needSize && field + 16 <= extra.length) {
        patch.uncompressedSize = Number(extra.readBigUInt64LE(field));
        patch.compressedSize = Number(extra.readBigUInt64LE(field + 8));
        field += 16;
      }
      if (needOffset && field + 8 <= extra.length) {
        patch.localOffset = Number(extra.readBigUInt64LE(field));
      }
      break;
    }
    at += 4 + size;
  }
  return patch;
}

/** Lista as entradas do ZIP sem descomprimir. */
export function listZip(buffer) {
  const eocdAt = findEocd(buffer);
  const big = readZip64(buffer, eocdAt);
  let count = big ? big.entries : buffer.readUInt16LE(eocdAt + 10);
  let at = big ? big.offset : buffer.readUInt32LE(eocdAt + 16);

  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL) break;
    const method = buffer.readUInt16LE(at + 10);
    let compressedSize = buffer.readUInt32LE(at + 20);
    let uncompressedSize = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    let localOffset = buffer.readUInt32LE(at + 42);
    const name = buffer.slice(at + 46, at + 46 + nameLength).toString("utf8");
    const extra = buffer.slice(at + 46 + nameLength, at + 46 + nameLength + extraLength);

    const patch = zip64Extra(
      extra,
      uncompressedSize === 0xffffffff || compressedSize === 0xffffffff,
      localOffset === 0xffffffff
    );
    if (patch.uncompressedSize !== undefined) uncompressedSize = patch.uncompressedSize;
    if (patch.compressedSize !== undefined) compressedSize = patch.compressedSize;
    if (patch.localOffset !== undefined) localOffset = patch.localOffset;

    if (!name.endsWith("/")) {
      entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Descomprime uma entrada listada por listZip. */
export function readEntry(buffer, entry) {
  const at = entry.localOffset;
  if (buffer.readUInt32LE(at) !== LOCAL) throw new Error(`ZIP invalido: header local de ${entry.name}`);
  const nameLength = buffer.readUInt16LE(at + 26);
  const extraLength = buffer.readUInt16LE(at + 28);
  const start = at + 30 + nameLength + extraLength;
  const raw = buffer.slice(start, start + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`ZIP com compressao nao suportada (metodo ${entry.method}) em ${entry.name}`);
}

/**
 * Extrai todos os arquivos cujo nome casa com `filter` (padrao: .xml).
 * Protege contra ZIP bomb por limite de bytes descomprimidos.
 */
export function extractXml(buffer, { maxBytes = 512 * 1024 * 1024, filter = /\.xml$/i } = {}) {
  const files = [];
  let total = 0;
  for (const entry of listZip(buffer)) {
    if (!filter.test(entry.name)) continue;
    total += entry.uncompressedSize;
    if (total > maxBytes) throw new Error("ZIP excede o limite de conteudo descomprimido");
    files.push({ name: entry.name, content: readEntry(buffer, entry).toString("utf8") });
  }
  return files;
}

export function isZip(buffer) {
  return buffer.length > 4 && buffer.readUInt32LE(0) === LOCAL;
}

// ------------------------------------------------------------------ escrita

import { deflateRawSync, crc32 } from "node:zlib";

/**
 * Monta um ZIP em memoria. `entradas` = [{ nome, conteudo }], com "/" nos nomes
 * para criar pastas. Compressao deflate; nomes em UTF-8 (bit 11).
 */
export function criarZip(entradas) {
  const locais = [];
  const centrais = [];
  let deslocamento = 0;
  const agora = new Date();
  const hora = (agora.getHours() << 11) | (agora.getMinutes() << 5) | Math.floor(agora.getSeconds() / 2);
  const data = ((agora.getFullYear() - 1980) << 9) | ((agora.getMonth() + 1) << 5) | agora.getDate();

  for (const { nome, conteudo } of entradas) {
    const nomeBytes = Buffer.from(nome, "utf8");
    const dados = Buffer.isBuffer(conteudo) ? conteudo : Buffer.from(String(conteudo), "utf8");
    const comprimido = deflateRawSync(dados);
    const soma = crc32(dados) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(hora, 10);
    local.writeUInt16LE(data, 12);
    local.writeUInt32LE(soma, 14);
    local.writeUInt32LE(comprimido.length, 18);
    local.writeUInt32LE(dados.length, 22);
    local.writeUInt16LE(nomeBytes.length, 26);
    locais.push(local, nomeBytes, comprimido);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(hora, 12);
    central.writeUInt16LE(data, 14);
    central.writeUInt32LE(soma, 16);
    central.writeUInt32LE(comprimido.length, 20);
    central.writeUInt32LE(dados.length, 24);
    central.writeUInt16LE(nomeBytes.length, 28);
    central.writeUInt32LE(deslocamento, 42);
    centrais.push(central, nomeBytes);

    deslocamento += 30 + nomeBytes.length + comprimido.length;
  }

  const corpo = Buffer.concat(locais);
  const diretorio = Buffer.concat(centrais);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(entradas.length, 8);
  fim.writeUInt16LE(entradas.length, 10);
  fim.writeUInt32LE(diretorio.length, 12);
  fim.writeUInt32LE(corpo.length, 16);
  return Buffer.concat([corpo, diretorio, fim]);
}
