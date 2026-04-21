const fs = require("fs");
const path = require("path");

const distDir = path.join(__dirname, "..", "dist");
fs.rmSync(distDir, { recursive: true, force: true });
