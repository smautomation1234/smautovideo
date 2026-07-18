import { FlatCompat } from "@eslint/eslintrc";
import js from "@eslint/js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({
  baseDirectory: directory,
  recommendedConfig: js.configs.recommended,
});

const config = [
  {
    ignores: [".next/**", "node_modules/**", "coverage/**", "next-env.d.ts"],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // Timeline filmstrips and local Blob URLs cannot use next/image.
      "@next/next/no-img-element": "off",
    },
  },
];

export default config;
