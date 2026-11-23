#!/usr/bin/env node
"use strict";
/* riftw — see README.md. Build with `npm run build`, then run this file. */

const fs = require("fs");
const path = require("path");

const entry = path.join(__dirname, "..", "dist", "index.js");
if (!fs.existsSync(entry)) {
  console.error("riftw: dist/index.js is missing — run `npm run build` in " + path.join(__dirname, ".."));
  process.exit(1);
}
require(entry);
