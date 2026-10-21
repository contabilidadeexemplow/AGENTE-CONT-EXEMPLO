// Parser XML minimalista, sem dependencias externas.
// Suficiente para NF-e 4.00, NFC-e, NFS-e ABRASF e NFS-e nacional.
// Namespaces sao descartados do nome do no (nfe:infNFe -> infNFe).

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(value) {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, code) => {
    if (code[0] === "#") {
      const point = code[1] === "x" || code[1] === "X"
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : full;
    }
    return ENTITIES[code] ?? full;
  });
}

function localName(raw) {
  const cut = raw.indexOf(":");
  return cut === -1 ? raw : raw.slice(cut + 1);
}

function parseAttrs(raw) {
  const attrs = {};
  const pattern = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(raw))) {
    attrs[localName(match[1])] = decodeEntities(match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function node(name, attrs) {
  return { name, attrs, children: [], text: "" };
}

/** Converte uma string XML em arvore de nos. Lanca Error em XML malformado. */
export function parseXml(source) {
  const input = String(source).replace(/^\uFEFF/, "");
  const root = node("#document", {});
  const stack = [root];
  let cursor = 0;

  while (cursor < input.length) {
    const open = input.indexOf("<", cursor);
    if (open === -1) break;

    if (open > cursor) {
      const chunk = input.slice(cursor, open);
      if (chunk.trim()) stack[stack.length - 1].text += decodeEntities(chunk);
    }

    if (input.startsWith("<!--", open)) {
      const end = input.indexOf("-->", open);
      cursor = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", open)) {
      const end = input.indexOf("]]>", open);
      const stop = end === -1 ? input.length : end;
      stack[stack.length - 1].text += input.slice(open + 9, stop);
      cursor = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<?", open) || input.startsWith("<!", open)) {
      const end = input.indexOf(">", open);
      cursor = end === -1 ? input.length : end + 1;
      continue;
    }

    const close = input.indexOf(">", open);
    if (close === -1) throw new Error("XML malformado: tag sem fechamento");
    const body = input.slice(open + 1, close).trim();

    if (body.startsWith("/")) {
      const name = localName(body.slice(1).trim());
      for (let depth = stack.length - 1; depth > 0; depth -= 1) {
        if (stack[depth].name === name) { stack.length = depth; break; }
      }
      cursor = close + 1;
      continue;
    }

    const selfClosing = body.endsWith("/");
    const inner = selfClosing ? body.slice(0, -1).trim() : body;
    const space = inner.search(/[\s]/);
    const name = localName(space === -1 ? inner : inner.slice(0, space));
    const attrs = space === -1 ? {} : parseAttrs(inner.slice(space + 1));
    const created = node(name, attrs);
    stack[stack.length - 1].children.push(created);
    if (!selfClosing) stack.push(created);
    cursor = close + 1;
  }

  if (!root.children.length) throw new Error("XML sem elemento raiz");
  return root;
}

/** Primeiro no que corresponde ao caminho "a/b/c", em qualquer profundidade a partir de `from`. */
export function pick(from, path) {
  return find(from, path)[0] ?? null;
}

/** Todos os nos que correspondem ao caminho "a/b/c". */
export function find(from, path) {
  if (!from) return [];
  const steps = String(path).split("/").filter(Boolean);
  if (!steps.length) return [from];
  let level = [from];
  for (const step of steps) {
    const next = [];
    for (const current of level) {
      for (const child of current.children) {
        if (child.name === step) next.push(child);
      }
    }
    level = next;
    if (!level.length) return [];
  }
  return level;
}

/** Busca o primeiro descendente com esse nome, em qualquer profundidade. */
export function deep(from, name) {
  if (!from) return null;
  const queue = [...from.children];
  while (queue.length) {
    const current = queue.shift();
    if (current.name === name) return current;
    queue.push(...current.children);
  }
  return null;
}

/** Todos os descendentes com esse nome, em qualquer profundidade. */
export function deepAll(from, name) {
  const found = [];
  if (!from) return found;
  const queue = [...from.children];
  while (queue.length) {
    const current = queue.shift();
    if (current.name === name) found.push(current);
    queue.push(...current.children);
  }
  return found;
}

/** Texto de um descendente, aceitando varios nomes alternativos. */
export function text(from, ...names) {
  for (const name of names) {
    const node = name.includes("/") ? pick(from, name) : deep(from, name);
    if (node && node.text.trim()) return node.text.trim();
  }
  return "";
}

/** Numero de um descendente. Aceita "1.234,56" e "1234.56". Retorna 0 quando ausente. */
export function num(from, ...names) {
  const raw = text(from, ...names);
  if (!raw) return 0;
  const normalized = raw.includes(",") && raw.lastIndexOf(",") > raw.lastIndexOf(".")
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw.replace(/,/g, "");
  const value = Number.parseFloat(normalized);
  return Number.isFinite(value) ? value : 0;
}
