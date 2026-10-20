/**
 * Inputs that would end the process are refused before they are parsed: a zipped workbook inflating past its bound
 * (utils/zipInflateBound, before SheetJS inflates it whole), a feed whose parse cannot fit in the heap still free
 * (sessionManager.loadData's reservation). Either used to take every user's session down with the process.
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const XLSX = require("xlsx");

const { assertZipInflatesWithin, isZip } = require("../../utils/zipInflateBound");
const { readWorkbook } = require("../../services/spreadsheet/workbook");
const { loadData } = require("../../services/sessionManager");

// A one-entry zip (deflated), written by hand: the central directory is what the bound reads.
const zipOf = (name, content) => {
  const data = zlib.deflateRawSync(content);
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(zlib.crc32 ? zlib.crc32(content) : 0, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  // The declared size lies, as a crafted file's does: a few bytes.
  central.writeUInt32LE(16, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const dirStart = local.length + nameBuf.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + nameBuf.length, 12);
  end.writeUInt32LE(dirStart, 16);
  return Buffer.concat([local, nameBuf, data, central, nameBuf, end]);
};

describe("zipInflateBound", () => {
  test("counts what an entry really inflates to, not what it declares", () => {
    const bomb = zipOf("xl/worksheets/sheet1.xml", Buffer.alloc(5 * 1024 * 1024));
    expect(isZip(bomb)).toBe(true);
    expect(bomb.length).toBeLessThan(20 * 1024);
    expect(() => assertZipInflatesWithin(bomb, 1024 * 1024)).toThrow(expect.objectContaining({ status: 413, code: "DOCUMENT_TOO_LARGE" }));
    expect(assertZipInflatesWithin(bomb, 10 * 1024 * 1024)).toBe(5 * 1024 * 1024);
  });

  test("an archive without a readable directory is refused, not guessed", () => {
    const zip = zipOf("a.xml", Buffer.from("<a/>"));
    expect(() => assertZipInflatesWithin(zip.subarray(0, zip.length - 22), 1024)).toThrow(expect.objectContaining({ status: 400, code: "UNREADABLE_DOCUMENT" }));
  });

  test("a real workbook still reads", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Arrêt", "Départ"], ["Gare", "07:12"]]), "Ligne 1");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const book = readWorkbook(buffer, { name: "offre.xlsx" });
    expect(book.sheets.map((s) => s.name)).toEqual(["Ligne 1"]);
  });
});

describe("loadData's memory reservation", () => {
  test("a feed that cannot fit in the free heap is refused before it is parsed", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gtfs-huge-"));
    try {
      const sample = path.join(__dirname, "..", "..", "..", "sample");
      for (const f of fs.readdirSync(sample)) fs.copyFileSync(path.join(sample, f), path.join(dir, f));
      // A sparse stop_times.txt of 4 GB: its size is what the reservation reads; no byte of it is parsed.
      fs.truncateSync(path.join(dir, "stop_times.txt"), 4 * 1024 * 1024 * 1024);
      await expect(loadData(dir)).rejects.toMatchObject({ status: 413, code: "FEED_TOO_LARGE" });
      // The reservation ended with the refusal: the sample itself still loads.
      fs.copyFileSync(path.join(sample, "stop_times.txt"), path.join(dir, "stop_times.txt"));
      await expect(loadData(dir)).resolves.toHaveProperty("stopTimes");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
