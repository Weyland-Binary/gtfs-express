const fs = require("fs");
const { UPLOAD_MAX_MB: MAX_MB } = require("../config");

// Every refusal names its code, so the web says it in the person's language (refusal.<CODE>.* texts).
const refuse = (res, status, code, message, details = {}) => res.status(status).json({ error: code, message, ...details });

/** The file's first four bytes, from memory or from the file it was received in. */
const headOf = (file) => {
  if (!file.tempFilePath) return file.data || Buffer.alloc(0);
  const head = Buffer.alloc(4);
  let fd = null;
  try {
    fd = fs.openSync(file.tempFilePath, "r");
    return head.subarray(0, fs.readSync(fd, head, 0, 4, 0));
  } catch {
    return Buffer.alloc(0);
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
};

const validateGTFSUpload = (req, res, next) => {
  if (!req.files || !req.files.gtfsZip) {
    return refuse(res, 400, "NO_FILE", "No file was uploaded. Please select a ZIP archive containing your GTFS files.");
  }

  const gtfsZip = req.files.gtfsZip;

  // ZIP magic bytes: PK\x03\x04. The signature alone tells an archive: its name and the type a browser gives it vary
  // with the system that sends it.
  const head = headOf(gtfsZip);
  if (head.length < 4 || head[0] !== 0x50 || head[1] !== 0x4b || head[2] !== 0x03 || head[3] !== 0x04) {
    return refuse(res, 400, "NOT_A_ZIP", "The file is not a valid ZIP archive (invalid magic bytes).");
  }

  // The parser already aborts past the ceiling (app.js); checked again here.
  if (gtfsZip.size > MAX_MB * 1024 * 1024) {
    return refuse(res, 413, "FILE_TOO_LARGE", `Max size: ${MAX_MB} MB. Received: ${Math.round(gtfsZip.size / 1024 / 1024)} MB`, { max_mb: MAX_MB });
  }

  next();
};

module.exports = { validateGTFSUpload };
