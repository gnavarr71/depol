const RDF_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const DC_NS = "http://purl.org/dc/elements/1.1/";
const X_NS = "adobe:ns:meta/";
const XMP_NS = "http://ns.adobe.com/xap/1.0/";
const JPEG_XMP_HEADER = asciiBytes("http://ns.adobe.com/xap/1.0/\0");
const PNG_XMP_KEYWORD = "XML:com.adobe.xmp";

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: false });
const latin1Decoder = new TextDecoder("windows-1252", { fatal: false });

export const SYNTHETIC_PERFORMER_SUBJECT = "contains-synthetic-performer";
export const SUPPORTED_FORMATS = Object.freeze(["jpeg", "png", "webp"]);

export function addAiSuffix(filename) {
  const safeName = String(filename || "image");
  const dotIndex = safeName.lastIndexOf(".");
  const hasExtension = dotIndex > 0 && dotIndex < safeName.length - 1;
  const stem = hasExtension ? safeName.slice(0, dotIndex) : safeName;
  const extension = hasExtension ? safeName.slice(dotIndex) : "";
  return stem.toLowerCase().endsWith("_ai") ? safeName : `${stem}_ai${extension}`;
}

export function detectFormat(bytes, hint = "") {
  const data = toUint8Array(bytes);
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "jpeg";
  if (data.length >= 8 && matchesAt(data, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), 0)) return "png";
  if (data.length >= 12 && asciiAt(data, 0, 4) === "RIFF" && asciiAt(data, 8, 4) === "WEBP") return "webp";

  const normalizedHint = String(hint).toLowerCase();
  if (normalizedHint.includes("jpeg") || normalizedHint.includes("jpg") || /\.jpe?g$/.test(normalizedHint)) return "jpeg";
  if (normalizedHint.includes("png") || /\.png$/.test(normalizedHint)) return "png";
  if (normalizedHint.includes("webp") || /\.webp$/.test(normalizedHint)) return "webp";
  return null;
}

export function extractXmpPacket(bytes, hint = "") {
  const data = toUint8Array(bytes);
  const format = detectFormat(data, hint);
  if (!format) return { format: null, xmp: null, warning: null };

  if (format === "jpeg") return { format, ...extractJpegXmp(data) };
  if (format === "png") return { format, ...extractPngXmp(data) };
  return { format, ...extractWebpXmp(data) };
}

export function xmpContainsSubject(xmp, subject = SYNTHETIC_PERFORMER_SUBJECT) {
  if (!xmp) return false;
  try {
    return readXmpSubjects(parseXml(xmp)).includes(subject);
  } catch {
    return false;
  }
}

export function getXmpSubjects(xmp) {
  if (!xmp) return [];
  try {
    return readXmpSubjects(parseXml(xmp));
  } catch {
    return [];
  }
}

function readXmpSubjects(doc) {
  const values = [];
  const descriptions = [...doc.getElementsByTagNameNS(RDF_NS, "Description")];
  for (const description of descriptions) {
    const attributeValue = description.getAttributeNS(DC_NS, "subject");
    if (attributeValue?.trim()) values.push(attributeValue.trim());
  }

  const subjectElements = [...doc.getElementsByTagNameNS(DC_NS, "subject")];
  for (const subjectElement of subjectElements) {
    const items = [...subjectElement.getElementsByTagNameNS(RDF_NS, "li")];
    if (items.length) {
      for (const item of items) {
        const value = item.textContent.trim();
        if (value) values.push(value);
      }
      continue;
    }

    const value = subjectElement.textContent.trim();
    if (value) values.push(value);
  }

  return [...new Set(values)];
}

export function writeSyntheticPerformerMetadata(bytes, hint = "") {
  const data = toUint8Array(bytes);
  const format = detectFormat(data, hint);
  if (!format || !SUPPORTED_FORMATS.includes(format)) {
    throw new Error("Formato no compatible para escribir metadatos XMP.");
  }

  const extracted = extractXmpPacket(data, format);
  const merged = mergeXmpSubject(extracted.xmp, SYNTHETIC_PERFORMER_SUBJECT);
  let embedded;

  if (format === "jpeg") embedded = embedJpegXmp(data, merged.xmp);
  else if (format === "png") embedded = embedPngXmp(data, merged.xmp);
  else embedded = embedWebpXmp(data, merged.xmp);

  const warning = [extracted.warning, merged.warning, embedded.warning].filter(Boolean).join(" ") || null;
  return {
    bytes: embedded.bytes,
    format,
    warning,
    preservedExistingXmp: merged.preservedExistingXmp,
  };
}

export function mergeXmpSubject(existingXmp, subject = SYNTHETIC_PERFORMER_SUBJECT) {
  if (!existingXmp) {
    return { xmp: createXmpPacket(subject), warning: null, preservedExistingXmp: true };
  }

  try {
    const doc = parseXml(existingXmp);
    let rdf = doc.getElementsByTagNameNS(RDF_NS, "RDF")[0];
    if (!rdf) {
      return {
        xmp: createXmpPacket(subject),
        warning: "El XMP existente no contenía una estructura RDF válida y se reemplazó.",
        preservedExistingXmp: false,
      };
    }

    let description = rdf.getElementsByTagNameNS(RDF_NS, "Description")[0];
    if (!description) {
      description = doc.createElementNS(RDF_NS, "rdf:Description");
      description.setAttributeNS(RDF_NS, "rdf:about", "");
      rdf.appendChild(description);
    }

    let subjectElement = description.getElementsByTagNameNS(DC_NS, "subject")[0];
    const attributeValue = description.getAttributeNS(DC_NS, "subject") || "";
    if (attributeValue) description.removeAttributeNS(DC_NS, "subject");

    if (!subjectElement) {
      subjectElement = doc.createElementNS(DC_NS, "dc:subject");
      description.appendChild(subjectElement);
    }

    const priorValues = [];
    if (attributeValue.trim()) priorValues.push(attributeValue.trim());

    const existingItems = [...subjectElement.getElementsByTagNameNS(RDF_NS, "li")];
    for (const item of existingItems) {
      const value = item.textContent.trim();
      if (value) priorValues.push(value);
    }

    if (!existingItems.length) {
      const rawText = [...subjectElement.childNodes]
        .filter((node) => node.nodeType === 3)
        .map((node) => node.textContent.trim())
        .filter(Boolean)
        .join(" ");
      if (rawText) priorValues.push(rawText);
    }

    while (subjectElement.firstChild) subjectElement.removeChild(subjectElement.firstChild);
    const bag = doc.createElementNS(RDF_NS, "rdf:Bag");
    subjectElement.appendChild(bag);

    const uniqueValues = [...new Set([...priorValues, subject])];
    for (const value of uniqueValues) {
      const item = doc.createElementNS(RDF_NS, "rdf:li");
      item.textContent = value;
      bag.appendChild(item);
    }

    let serialized = new XMLSerializer().serializeToString(doc);
    if (!serialized.includes("<?xpacket")) {
      serialized = wrapXmpPacket(serialized);
    }

    return { xmp: serialized, warning: null, preservedExistingXmp: true };
  } catch {
    return {
      xmp: createXmpPacket(subject),
      warning: "El XMP existente no se pudo interpretar y se reemplazó.",
      preservedExistingXmp: false,
    };
  }
}

function createXmpPacket(subject) {
  const escaped = escapeXml(subject);
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n` +
    `<x:xmpmeta xmlns:x="${X_NS}" x:xmptk="Entorno AI Web">\n` +
    `  <rdf:RDF xmlns:rdf="${RDF_NS}">\n` +
    `    <rdf:Description rdf:about="" xmlns:dc="${DC_NS}" xmlns:xmp="${XMP_NS}">\n` +
    `      <dc:subject><rdf:Bag><rdf:li>${escaped}</rdf:li></rdf:Bag></dc:subject>\n` +
    `    </rdf:Description>\n` +
    `  </rdf:RDF>\n` +
    `</x:xmpmeta>\n` +
    `<?xpacket end="w"?>`;
}

function wrapXmpPacket(xml) {
  return `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>\n${xml}\n<?xpacket end="w"?>`;
}

function parseXml(value) {
  const cleaned = String(value)
    .replace(/^\uFEFF/, "")
    .replace(/\u0000+$/g, "")
    .trim();
  const doc = new DOMParser().parseFromString(cleaned, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("Invalid XML");
  return doc;
}

function extractJpegXmp(bytes) {
  const { segments } = parseJpeg(bytes);
  for (const segment of segments) {
    if (segment.marker !== 0xe1 || segment.payloadStart == null) continue;
    if (!matchesAt(bytes, JPEG_XMP_HEADER, segment.payloadStart)) continue;
    const start = segment.payloadStart + JPEG_XMP_HEADER.length;
    return { xmp: trimXmpText(utf8Decoder.decode(bytes.slice(start, segment.end))), warning: null };
  }
  return { xmp: null, warning: null };
}

function embedJpegXmp(bytes, xmp) {
  const parsed = parseJpeg(bytes);
  let xmpBytes = utf8Encoder.encode(xmp);
  let warning = null;
  const maxXmpBytes = 65533 - JPEG_XMP_HEADER.length;
  if (xmpBytes.length > maxXmpBytes) {
    xmpBytes = utf8Encoder.encode(createXmpPacket(SYNTHETIC_PERFORMER_SUBJECT));
    warning = "El paquete XMP existente era demasiado grande para JPEG y se reemplazó por uno mínimo.";
  }

  const payload = concatBytes(JPEG_XMP_HEADER, xmpBytes);
  const length = payload.length + 2;
  const app1 = new Uint8Array(payload.length + 4);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1[2] = (length >>> 8) & 0xff;
  app1[3] = length & 0xff;
  app1.set(payload, 4);

  const kept = parsed.segments.filter((segment) => {
    if (segment.marker !== 0xe1 || segment.payloadStart == null) return true;
    return !matchesAt(bytes, JPEG_XMP_HEADER, segment.payloadStart);
  });

  let insertIndex = 0;
  while (insertIndex < kept.length && isJpegMetadataMarker(kept[insertIndex].marker)) insertIndex += 1;

  const parts = [bytes.slice(0, 2)];
  for (let index = 0; index < insertIndex; index += 1) parts.push(bytes.slice(kept[index].start, kept[index].end));
  parts.push(app1);
  for (let index = insertIndex; index < kept.length; index += 1) parts.push(bytes.slice(kept[index].start, kept[index].end));

  return { bytes: concatBytes(...parts), warning };
}

function parseJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("JPEG no válido.");
  const segments = [];
  let cursor = 2;

  while (cursor < bytes.length) {
    const start = cursor;
    if (bytes[cursor] !== 0xff) {
      segments.push({ marker: null, start, end: bytes.length, payloadStart: null });
      break;
    }

    while (cursor < bytes.length && bytes[cursor] === 0xff) cursor += 1;
    if (cursor >= bytes.length) throw new Error("JPEG truncado.");
    const marker = bytes[cursor];
    cursor += 1;

    if (marker === 0xd9) {
      segments.push({ marker, start, end: cursor, payloadStart: null });
      if (cursor < bytes.length) segments.push({ marker: null, start: cursor, end: bytes.length, payloadStart: null });
      break;
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      segments.push({ marker, start, end: cursor, payloadStart: null });
      continue;
    }

    if (cursor + 1 >= bytes.length) throw new Error("JPEG truncado.");
    const length = (bytes[cursor] << 8) | bytes[cursor + 1];
    if (length < 2 || cursor + length > bytes.length) throw new Error("Segmento JPEG no válido.");
    const payloadStart = cursor + 2;
    const end = cursor + length;

    if (marker === 0xda) {
      segments.push({ marker, start, end: bytes.length, payloadStart });
      break;
    }

    segments.push({ marker, start, end, payloadStart });
    cursor = end;
  }

  return { segments };
}

function isJpegMetadataMarker(marker) {
  return marker === 0xfe || (marker >= 0xe0 && marker <= 0xef);
}

function extractPngXmp(bytes) {
  const chunks = parsePngChunks(bytes);
  let compressedFound = false;

  for (const chunk of chunks) {
    if (!["iTXt", "tEXt", "zTXt"].includes(chunk.type)) continue;
    const parsed = parsePngTextChunk(bytes.slice(chunk.dataStart, chunk.dataEnd), chunk.type);
    if (!parsed || parsed.keyword !== PNG_XMP_KEYWORD) continue;
    if (parsed.compressed) {
      compressedFound = true;
      continue;
    }
    return { xmp: trimXmpText(parsed.text), warning: null };
  }

  return {
    xmp: null,
    warning: compressedFound ? "El XMP PNG existente estaba comprimido y se reemplazó por un paquete nuevo." : null,
  };
}

function embedPngXmp(bytes, xmp) {
  const chunks = parsePngChunks(bytes);
  const xmpChunk = makePngChunk("iTXt", concatBytes(
    asciiBytes(PNG_XMP_KEYWORD),
    new Uint8Array([0, 0, 0, 0, 0]),
    utf8Encoder.encode(xmp),
  ));

  const parts = [bytes.slice(0, 8)];
  let inserted = false;
  let removedCompressed = false;

  for (const chunk of chunks) {
    let isXmp = false;
    if (["iTXt", "tEXt", "zTXt"].includes(chunk.type)) {
      const parsed = parsePngTextChunk(bytes.slice(chunk.dataStart, chunk.dataEnd), chunk.type);
      isXmp = parsed?.keyword === PNG_XMP_KEYWORD;
      if (isXmp && parsed?.compressed) removedCompressed = true;
    }

    if (chunk.type === "IEND" && !inserted) {
      parts.push(xmpChunk);
      inserted = true;
    }
    if (!isXmp) parts.push(bytes.slice(chunk.start, chunk.end));
  }

  if (!inserted) throw new Error("PNG sin bloque IEND.");
  return {
    bytes: concatBytes(...parts),
    warning: removedCompressed ? "Se reemplazó un bloque XMP PNG comprimido por uno estándar sin compresión." : null,
  };
}

function parsePngChunks(bytes) {
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 20 || !matchesAt(bytes, signature, 0)) throw new Error("PNG no válido.");
  const chunks = [];
  let cursor = 8;

  while (cursor + 12 <= bytes.length) {
    const length = readUint32BE(bytes, cursor);
    const type = asciiAt(bytes, cursor + 4, 4);
    const dataStart = cursor + 8;
    const dataEnd = dataStart + length;
    const end = dataEnd + 4;
    if (end > bytes.length) throw new Error("PNG truncado.");
    chunks.push({ type, start: cursor, dataStart, dataEnd, end });
    cursor = end;
    if (type === "IEND") break;
  }

  return chunks;
}

function parsePngTextChunk(data, type) {
  const zero = data.indexOf(0);
  if (zero < 1) return null;
  const keyword = latin1Decoder.decode(data.slice(0, zero));

  if (type === "tEXt") {
    return { keyword, compressed: false, text: latin1Decoder.decode(data.slice(zero + 1)) };
  }

  if (type === "zTXt") {
    return { keyword, compressed: true, text: null };
  }

  let cursor = zero + 1;
  if (cursor + 2 > data.length) return null;
  const compressionFlag = data[cursor];
  cursor += 2;

  const languageEnd = data.indexOf(0, cursor);
  if (languageEnd < 0) return null;
  cursor = languageEnd + 1;
  const translatedEnd = data.indexOf(0, cursor);
  if (translatedEnd < 0) return null;
  cursor = translatedEnd + 1;

  return {
    keyword,
    compressed: compressionFlag !== 0,
    text: compressionFlag === 0 ? utf8Decoder.decode(data.slice(cursor)) : null,
  };
}

function makePngChunk(type, data) {
  const typeBytes = asciiBytes(type);
  const output = new Uint8Array(12 + data.length);
  writeUint32BE(output, 0, data.length);
  output.set(typeBytes, 4);
  output.set(data, 8);
  writeUint32BE(output, 8 + data.length, crc32(concatBytes(typeBytes, data)));
  return output;
}

function extractWebpXmp(bytes) {
  const chunks = parseWebpChunks(bytes);
  const chunk = chunks.find((item) => item.type === "XMP ");
  return { xmp: chunk ? trimXmpText(utf8Decoder.decode(bytes.slice(chunk.dataStart, chunk.dataEnd))) : null, warning: null };
}

function embedWebpXmp(bytes, xmp) {
  const chunks = parseWebpChunks(bytes);
  const existingVp8x = chunks.find((chunk) => chunk.type === "VP8X");
  let vp8x;

  if (existingVp8x) {
    const payload = bytes.slice(existingVp8x.dataStart, existingVp8x.dataEnd);
    if (payload.length < 10) throw new Error("Bloque VP8X no válido.");
    vp8x = payload.slice(0, 10);
  } else {
    const dimensions = getWebpDimensions(bytes, chunks);
    if (!dimensions) throw new Error("No se pudieron leer las dimensiones WebP.");
    vp8x = new Uint8Array(10);
    writeUint24LE(vp8x, 4, dimensions.width - 1);
    writeUint24LE(vp8x, 7, dimensions.height - 1);
  }

  const types = new Set(chunks.map((chunk) => chunk.type));
  if (types.has("ICCP")) vp8x[0] |= 0x20;
  if (types.has("ALPH") || webpLosslessHasAlpha(bytes, chunks)) vp8x[0] |= 0x10;
  if (types.has("EXIF")) vp8x[0] |= 0x08;
  vp8x[0] |= 0x04;
  if (types.has("ANIM") || types.has("ANMF")) vp8x[0] |= 0x02;

  const body = [asciiBytes("WEBP"), makeWebpChunk("VP8X", vp8x)];
  for (const chunk of chunks) {
    if (chunk.type === "VP8X" || chunk.type === "XMP ") continue;
    body.push(bytes.slice(chunk.start, chunk.paddedEnd));
  }
  body.push(makeWebpChunk("XMP ", utf8Encoder.encode(xmp)));

  const bodyBytes = concatBytes(...body);
  const output = new Uint8Array(8 + bodyBytes.length);
  output.set(asciiBytes("RIFF"), 0);
  writeUint32LE(output, 4, output.length - 8);
  output.set(bodyBytes, 8);
  return { bytes: output, warning: null };
}

function parseWebpChunks(bytes) {
  if (bytes.length < 20 || asciiAt(bytes, 0, 4) !== "RIFF" || asciiAt(bytes, 8, 4) !== "WEBP") {
    throw new Error("WebP no válido.");
  }

  const declaredEnd = Math.min(bytes.length, readUint32LE(bytes, 4) + 8);
  const chunks = [];
  let cursor = 12;

  while (cursor + 8 <= declaredEnd) {
    const type = asciiAt(bytes, cursor, 4);
    const size = readUint32LE(bytes, cursor + 4);
    const dataStart = cursor + 8;
    const dataEnd = dataStart + size;
    const paddedEnd = dataEnd + (size & 1);
    if (paddedEnd > declaredEnd) throw new Error("WebP truncado.");
    chunks.push({ type, size, start: cursor, dataStart, dataEnd, paddedEnd });
    cursor = paddedEnd;
  }

  return chunks;
}

function getWebpDimensions(bytes, chunks) {
  const vp8x = chunks.find((chunk) => chunk.type === "VP8X");
  if (vp8x && vp8x.size >= 10) {
    return {
      width: readUint24LE(bytes, vp8x.dataStart + 4) + 1,
      height: readUint24LE(bytes, vp8x.dataStart + 7) + 1,
    };
  }

  const vp8 = chunks.find((chunk) => chunk.type === "VP8 ");
  if (vp8 && vp8.size >= 10) {
    const start = vp8.dataStart;
    if (bytes[start + 3] === 0x9d && bytes[start + 4] === 0x01 && bytes[start + 5] === 0x2a) {
      return {
        width: ((bytes[start + 7] << 8) | bytes[start + 6]) & 0x3fff,
        height: ((bytes[start + 9] << 8) | bytes[start + 8]) & 0x3fff,
      };
    }
  }

  const vp8l = chunks.find((chunk) => chunk.type === "VP8L");
  if (vp8l && vp8l.size >= 5 && bytes[vp8l.dataStart] === 0x2f) {
    const start = vp8l.dataStart;
    return {
      width: 1 + bytes[start + 1] + ((bytes[start + 2] & 0x3f) << 8),
      height: 1 + (bytes[start + 2] >> 6) + (bytes[start + 3] << 2) + ((bytes[start + 4] & 0x0f) << 10),
    };
  }

  return null;
}

function webpLosslessHasAlpha(bytes, chunks) {
  const vp8l = chunks.find((chunk) => chunk.type === "VP8L");
  return Boolean(vp8l && vp8l.size >= 5 && (bytes[vp8l.dataStart + 4] & 0x10));
}

function makeWebpChunk(type, data) {
  const padding = data.length & 1;
  const output = new Uint8Array(8 + data.length + padding);
  output.set(asciiBytes(type), 0);
  writeUint32LE(output, 4, data.length);
  output.set(data, 8);
  return output;
}

function trimXmpText(value) {
  const text = String(value || "").replace(/\u0000+$/g, "").trim();
  const packetStart = text.indexOf("<?xpacket");
  if (packetStart >= 0) return text.slice(packetStart);
  const xmpStart = text.indexOf("<x:xmpmeta");
  if (xmpStart >= 0) return text.slice(xmpStart);
  const rdfStart = text.indexOf("<rdf:RDF");
  return rdfStart >= 0 ? text.slice(rdfStart) : text;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError("Se esperaba un ArrayBuffer o Uint8Array.");
}

function concatBytes(...parts) {
  const valid = parts.filter(Boolean);
  const length = valid.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of valid) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function asciiBytes(value) {
  const output = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) output[index] = value.charCodeAt(index) & 0xff;
  return output;
}

function asciiAt(bytes, offset, length) {
  let output = "";
  for (let index = 0; index < length; index += 1) output += String.fromCharCode(bytes[offset + index]);
  return output;
}

function matchesAt(bytes, prefix, offset) {
  if (offset < 0 || offset + prefix.length > bytes.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (bytes[offset + index] !== prefix[index]) return false;
  }
  return true;
}

function readUint32BE(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function writeUint32BE(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function readUint32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function writeUint32LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function readUint24LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function writeUint24LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
}

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let number = 0; number < 256; number += 1) {
      let current = number;
      for (let bit = 0; bit < 8; bit += 1) current = current & 1 ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
      crcTable[number] = current >>> 0;
    }
  }

  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
