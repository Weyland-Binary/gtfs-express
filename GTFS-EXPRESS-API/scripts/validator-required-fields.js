#!/usr/bin/env node
/**
 * Writes src/utils/validatorRequiredFields.json from the canonical validator's own table descriptors: for every GTFS
 * file, the columns its parser requires a value in. The parser refuses whole a row where such a value is missing or
 * cannot be read; a required field reported on any other column is a check's finding on a row that was read. The
 * second pass leaves out the former rows and never the latter.
 * Run again when GTFS_VALIDATOR_VERSION changes (it needs a JDK: the descriptors are read by a Java source run as is):
 *   GTFS_CANONICAL_VALIDATOR_JAR=… JAVA_BIN=… node scripts/validator-required-fields.js
 */

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const jar = process.env.GTFS_CANONICAL_VALIDATOR_JAR;
const java = process.env.JAVA_BIN || "java";
if (!jar || !fs.existsSync(jar)) {
  console.error("GTFS_CANONICAL_VALIDATOR_JAR must name the validator's JAR.");
  process.exit(1);
}
const version = (path.basename(jar).match(/(\d+\.\d+\.\d+)/) || [])[1];
if (!version) {
  console.error(`No version in the JAR's name: ${path.basename(jar)}`);
  process.exit(1);
}

const SOURCE = `
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.TreeMap;
import java.util.jar.JarEntry;
import java.util.jar.JarFile;

public class RequiredColumns {
  public static void main(String[] args) throws Exception {
    TreeMap<String, List<String>> required = new TreeMap<>();
    Class<?> column = Class.forName("org.mobilitydata.gtfsvalidator.table.GtfsColumnDescriptor");
    Method name = column.getMethod("columnName");
    Method level = column.getMethod("fieldLevel");
    try (JarFile jar = new JarFile(args[0])) {
      for (Enumeration<JarEntry> entries = jar.entries(); entries.hasMoreElements(); ) {
        String entry = entries.nextElement().getName();
        if (!entry.startsWith("org/mobilitydata/gtfsvalidator/table/") || !entry.endsWith("TableDescriptor.class")) continue;
        Class<?> type = Class.forName(entry.substring(0, entry.length() - 6).replace('/', '.'));
        if (Modifier.isAbstract(type.getModifiers())) continue;
        Object table = type.getDeclaredConstructor().newInstance();
        String file = (String) type.getMethod("gtfsFilename").invoke(table);
        List<String> fields = new ArrayList<>();
        for (Object col : (Iterable<?>) type.getMethod("getColumns").invoke(table)) {
          if ("REQUIRED".equals(String.valueOf(level.invoke(col)))) fields.add((String) name.invoke(col));
        }
        required.put(file, fields);
      }
    }
    StringBuilder out = new StringBuilder("{");
    for (var e : required.entrySet()) {
      if (out.length() > 1) out.append(",");
      out.append('"').append(e.getKey()).append("\\":[");
      for (int i = 0; i < e.getValue().size(); i++) out.append(i == 0 ? "" : ",").append('"').append(e.getValue().get(i)).append('"');
      out.append("]");
    }
    System.out.println(out.append("}"));
  }
}
`;

const work = fs.mkdtempSync(path.join(os.tmpdir(), "validator-required-"));
try {
  const source = path.join(work, "RequiredColumns.java");
  fs.writeFileSync(source, SOURCE);
  const files = JSON.parse(execFileSync(java, ["-cp", jar, source, jar], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  if (!Object.keys(files).length) throw new Error("the validator's JAR names no table");
  const target = path.join(__dirname, "..", "src", "utils", "validatorRequiredFields.json");
  fs.writeFileSync(target, JSON.stringify({ validator: version, files }, null, 2) + "\n");
  const count = Object.values(files).reduce((n, fields) => n + fields.length, 0);
  console.log(`${count} required columns in ${Object.keys(files).length} files; written to ${path.relative(process.cwd(), target)}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
