import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  { ignores: ["dist/**", "node_modules/**", "test/fixtures/**"] },
  { files: ["**/*.ts"], languageOptions: { parserOptions: { project: "./tsconfig.json" } }, rules: { "@typescript-eslint/no-explicit-any": "off" } },
  { files: ["scripts/**/*.mjs"], languageOptions: { globals: { Buffer: "readonly", process: "readonly", setTimeout: "readonly", clearTimeout: "readonly", URL: "readonly" } } },
);
