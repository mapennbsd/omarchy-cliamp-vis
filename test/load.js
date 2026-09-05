// Model.js is a plain-script QML JS resource: no exports, no module system, so
// that Panel.qml can `import "Model.js" as Model`. Rather than add test-only
// plumbing to the shipped file, wrap it in a function that returns everything
// it declares and evaluate that.
//
// This runs in the current realm on purpose: values built inside a fresh vm
// context carry that context's prototypes, which makes assert.deepStrictEqual
// reject structurally identical objects.
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const source = fs.readFileSync(path.join(__dirname, "..", "Model.js"), "utf8")
const declared = [...source.matchAll(/^function\s+([A-Za-z0-9_$]+)\s*\(/gm)].map(m => m[1])
if (declared.length === 0) throw new Error("Model.js declared no top-level functions")

const factory = vm.runInThisContext(
  "(function () {\n" + source + "\nreturn { " + declared.join(", ") + " }\n})",
  { filename: "Model.js" }
)

module.exports = factory()
