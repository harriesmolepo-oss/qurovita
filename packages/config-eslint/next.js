import base from "./base.js";

/** @type {import("eslint").Linter.FlatConfig[]} */
export default [
  ...base,
  {
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];
