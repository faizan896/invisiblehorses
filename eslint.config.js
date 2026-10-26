import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['**/dist/**', 'public/playground/**', 'worker-dist/**', '.wrangler/**', '**/node_modules/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
  { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } } },
  { rules: { '@typescript-eslint/no-explicit-any': 'error' } },
);
