import tseslint from "typescript-eslint";

export default tseslint.config(
    {
        ignores: ["**/dist/**", "**/out/**", "**/node_modules/**", "stubs/**", "*.js", "cli/*.js"],
    },
    ...tseslint.configs.recommended,
    {
        files: ["**/*.ts"],
        languageOptions: {
            parser: tseslint.parser,
            ecmaVersion: 2022,
            sourceType: "module",
        },
        rules: {
            "@typescript-eslint/naming-convention": ["error", {
                selector: "import",
                format: ["camelCase", "PascalCase"],
            }],
            "@typescript-eslint/no-unused-vars": ["error", {
                argsIgnorePattern: "^_",
                varsIgnorePattern: "^_",
                caughtErrorsIgnorePattern: "^_",
            }],
            curly: ["error", "multi-line"],
            eqeqeq: "error",
            "no-throw-literal": "error",
            semi: "error",
        },
    },
    {
        // Webview scripts: plain browser JavaScript, loaded as classic scripts
        files: ["media/**/*.js"],
        languageOptions: {
            ecmaVersion: 2022,
            sourceType: "script",
        },
        rules: {
            "@typescript-eslint/no-unused-vars": ["error", {
                argsIgnorePattern: "^_",
                varsIgnorePattern: "^_",
                caughtErrorsIgnorePattern: "^_",
            }],
            curly: ["error", "multi-line"],
            eqeqeq: ["error", "smart"],
            "no-throw-literal": "error",
            semi: "error",
        },
    },
);
