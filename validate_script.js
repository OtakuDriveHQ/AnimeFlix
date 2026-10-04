import fs from "fs";

// Read worker.js and extract scriptBody
const workerCode = fs.readFileSync("src/worker.js", "utf8");
const match = workerCode.match(/const scriptBody = `([\s\S]*?)`;/);
if (!match) {
  console.error("Could not find scriptBody");
  process.exit(1);
}

// In the actual template, ${scriptBody} is injected into <script>...</script>
const scriptText = match[1].replace(/\\"/g, '"');

try {
  new Function(scriptText);
  console.log("SUCCESS! scriptText parsed with 0 errors!");
} catch (err) {
  console.error("SYNTAX ERROR in scriptText:", err);
  process.exit(1);
}
