import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  { ignores: ["dist/**", "web-dist/**", "node_modules/**", "coverage/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/web/**/*.{ts,tsx}", "tests/ui.test.tsx"],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ["src/web/public/sw.js"],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    files: [
      "src/server/**/*.ts",
      "src/cli.ts",
      "tests/**/*.ts",
      "scripts/**/*.mjs",
      "vite.config.ts",
      "vitest.config.ts",
    ],
    languageOptions: { globals: globals.node },
    rules: { "@typescript-eslint/no-explicit-any": "error" },
  },
);
