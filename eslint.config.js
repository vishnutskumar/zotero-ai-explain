import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["addon/content/", "coverage/", "dist/", "node_modules/"]
  },
  js.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/no-empty-object-type": "off"
    }
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: {
        APP_SHUTDOWN: "readonly",
        ChromeUtils: "readonly",
        console: "readonly",
        process: "readonly",
        Zotero: "readonly"
      }
    }
  },
  {
    files: ["addon/bootstrap.js"],
    rules: {
      "no-unused-vars": "off"
    }
  }
);
