"use strict";

const fs = require("node:fs");
const path = require("node:path");
const {
  DOCUMENTS,
  assertGeneratedDocuments,
  buildProductContractFromInputs,
  expectedDocuments,
  loadProductContractInputs,
} = require("./product-contract");

const root = path.resolve(__dirname, "..");
const check = process.argv.includes("--check");
const contractPath = path.join(root, "contracts", "product-contract.json");
const contract = buildProductContractFromInputs(loadProductContractInputs(root));
const serialized = `${JSON.stringify(contract, null, 2)}\n`;
const documents = Object.fromEntries(DOCUMENTS.map((name) => [name, fs.readFileSync(path.join(root, name), "utf8")]));

if (check) {
  if (!fs.existsSync(contractPath) || fs.readFileSync(contractPath, "utf8") !== serialized) {
    throw new Error("contracts/product-contract.json is stale. Run npm run generate:product-contract.");
  }
  assertGeneratedDocuments(contract, documents);
  process.stdout.write("Generated product contract and documentation are current.\n");
} else {
  fs.writeFileSync(contractPath, serialized);
  for (const [name, source] of Object.entries(expectedDocuments(contract, documents))) {
    fs.writeFileSync(path.join(root, name), source);
  }
  process.stdout.write("Generated product contract and documentation blocks.\n");
}
