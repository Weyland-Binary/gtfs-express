// Every refusal names its code, so the web says it in the person's language (refusal.<CODE>.* texts).
const refuse = (res, status, code, message, details = {}) => res.status(status).json({ error: code, message, ...details });

const MAX_MB = 50;

const validateGTFSUpload = (req, res, next) => {
  if (!req.files || !req.files.gtfsZip) {
    return refuse(res, 400, "NO_FILE", "No file was uploaded. Please select a ZIP archive containing your GTFS files.");
  }

  const gtfsZip = req.files.gtfsZip;

  // ZIP magic bytes: PK\x03\x04.
  if (
    !gtfsZip.data ||
    gtfsZip.data.length < 4 ||
    gtfsZip.data[0] !== 0x50 ||
    gtfsZip.data[1] !== 0x4b ||
    gtfsZip.data[2] !== 0x03 ||
    gtfsZip.data[3] !== 0x04
  ) {
    return refuse(res, 400, "NOT_A_ZIP", "The file is not a valid ZIP archive (invalid magic bytes).");
  }

  const allowedMimeTypes = [
    "application/zip",
    "application/x-zip-compressed",
    "application/octet-stream",
  ];

  if (!allowedMimeTypes.includes(gtfsZip.mimetype) || !gtfsZip.name.toLowerCase().endsWith(".zip")) {
    return refuse(res, 400, "NOT_A_ZIP", `Only ZIP files with a .zip extension are accepted (received ${gtfsZip.mimetype}).`);
  }

  // fileUpload already aborts past 50 MB (app.js); checked again here.
  if (gtfsZip.size > MAX_MB * 1024 * 1024) {
    return refuse(res, 413, "FILE_TOO_LARGE", `Max size: ${MAX_MB} MB. Received: ${Math.round(gtfsZip.size / 1024 / 1024)} MB`, { max_mb: MAX_MB });
  }

  next();
};

module.exports = { validateGTFSUpload };
