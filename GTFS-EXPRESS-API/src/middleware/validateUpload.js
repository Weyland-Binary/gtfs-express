// 🛡️ Validation middleware for GTFS file uploads
const validateGTFSUpload = (req, res, next) => {
  if (!req.files || !req.files.gtfsZip) {
    return res.status(400).json({
      error: "No file received",
      message:
        "No file was uploaded. Please select a ZIP archive containing your GTFS files.",
    });
  }

  const gtfsZip = req.files.gtfsZip;

  // 🛡️ Validate ZIP magic bytes (PK\x03\x04)
  if (
    !gtfsZip.data ||
    gtfsZip.data.length < 4 ||
    gtfsZip.data[0] !== 0x50 ||
    gtfsZip.data[1] !== 0x4b ||
    gtfsZip.data[2] !== 0x03 ||
    gtfsZip.data[3] !== 0x04
  ) {
    return res.status(400).json({
      error: "Invalid file",
      message: "The file is not a valid ZIP archive (invalid magic bytes).",
    });
  }

  // 🛡️ Strict MIME type validation
  const allowedMimeTypes = [
    "application/zip",
    "application/x-zip-compressed",
    "application/octet-stream",
  ];

  if (!allowedMimeTypes.includes(gtfsZip.mimetype)) {
    return res.status(400).json({
      error: "Invalid file type",
      message: `Only ZIP files are accepted. Received type: ${gtfsZip.mimetype}`,
    });
  }

  // 🛡️ Validate file extension
  if (!gtfsZip.name.toLowerCase().endsWith(".zip")) {
    return res.status(400).json({
      error: "Invalid extension",
      message: "File must have a .zip extension.",
    });
  }

  // 🛡️ Validate file size (double-check)
  const maxSize = 50 * 1024 * 1024; // 50 MB
  if (gtfsZip.size > maxSize) {
    return res.status(400).json({
      error: "File too large",
      message: `Max size: 50 MB. Received: ${Math.round(gtfsZip.size / 1024 / 1024)} MB`,
    });
  }

  next();
};

module.exports = { validateGTFSUpload };
