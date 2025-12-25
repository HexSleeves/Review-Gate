const path = require("path");
const os = require("os");

// Cross-platform temp directory helper
function getTempPath(filename) {
  // Use /tmp/ for macOS and Linux, system temp for Windows
  if (process.platform === "win32") {
    return path.join(os.tmpdir(), filename);
  } else {
    return path.join("/tmp", filename);
  }
}

function getMimeType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const mimeTypes = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".webp": "image/webp",
  };
  return mimeTypes[ext] || "image/jpeg";
}

module.exports = {
  getTempPath,
  getMimeType,
};
