import "dotenv/config";
import fs from "fs";
import path from "path";
import { refineLog } from "../src/services/openai";

// ==========================================
// PASTE YOUR RAW LOG HERE 👇
// ==========================================
const RAW_LOG = ``;
// ==========================================

async function main() {
  console.log("🚀 Starting refinement...");
  console.log("-----------------------------------");
  console.log("Input:\n", RAW_LOG.trim());
  console.log("-----------------------------------");

  try {
    const refined = await refineLog(RAW_LOG);

    console.log("✅ Refinement complete!");
    console.log("-----------------------------------");
    console.log(refined);
    console.log("-----------------------------------");

    // Output to file
    const outputPath = path.resolve(process.cwd(), "REFINED_OUTPUT.md");
    
    const fileContent = `
# Refinement Test - ${new Date().toLocaleString()}

## Raw Input
${RAW_LOG.trim()}

## Refined Output
${refined}

---
`;

    // Append to file so we keep a history of tests
    fs.appendFileSync(outputPath, fileContent);
    console.log(`💾 Saved to: ${outputPath}`);

  } catch (error) {
    console.error("❌ Error refining log:", error);
  }
}

main();
