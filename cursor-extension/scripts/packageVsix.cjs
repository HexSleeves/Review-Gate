const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const extensionDir = path.join(__dirname, "..");
const packageJsonPath = path.join(extensionDir, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const outputName = `review-gate-v3-${packageJson.version}.vsix`;

for (const entry of fs.readdirSync(extensionDir)) {
  if (/^review-gate-v3-.*\.vsix$/.test(entry)) {
    fs.rmSync(path.join(extensionDir, entry), { force: true });
  }
}

execFileSync("npx", ["@vscode/vsce", "package", "--out", outputName], {
  cwd: extensionDir,
  stdio: "inherit",
});
