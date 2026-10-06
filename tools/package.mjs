// Builds dist/linkedin-reply-assistant.zip: only the files Chrome needs, inside one folder.
// Upload it to a GitHub release under this exact name so the landing page's download link keeps working.
//
//   node tools/package.mjs
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INCLUDE = ["manifest.json", "background.js", "lib", "content", "options", "icons", "LICENSE"];
const FOLDER = "linkedin-reply-assistant"; // what people get when they unzip
const OUT = path.join(ROOT, "dist", `${FOLDER}.zip`);

const files = INCLUDE.flatMap((entry) => walk(path.join(ROOT, entry)));
for (const file of files) {
  if (/api_key|\.env|\.key$/i.test(file) || /gsk_[A-Za-z0-9]{20,}/.test(fs.readFileSync(file, "latin1"))) {
    throw new Error(`Refusing to package something that looks like a secret: ${file}`);
  }
}

const version = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).version;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, zip(files.map((f) => [`${FOLDER}/${path.relative(ROOT, f).split(path.sep).join("/")}`, fs.readFileSync(f)])));
console.log(`Built ${path.relative(ROOT, OUT)}: version ${version}, ${files.length} files, ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);

function walk(p) {
  if (!fs.existsSync(p)) throw new Error(`Missing: ${p}`);
  return fs.statSync(p).isDirectory() ? fs.readdirSync(p).sort().flatMap((n) => walk(path.join(p, n))) : [p];
}

// Minimal ZIP writer (deflate, forward-slash paths) so the zip opens the same on Windows, macOS and Linux.
function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const crc = zlib.crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // version needed
    header.writeUInt16LE(0x0800, 6); // UTF-8 names
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt32LE(0x00210000, 10); // fixed date (1980-01-01) for reproducible builds
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    local.push(header, nameBuf, packed);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(0x00210000, 12);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += header.length + nameBuf.length + packed.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}
