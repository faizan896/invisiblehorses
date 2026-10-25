import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['dist/**', 'worker-dist/**', '.wrangler/**', 'node_modules/**', 'coverage/**'] },
  ...tseslint.configs.recommended,
  { rules: { '@typescript-eslint/no-explicit-any': 'error' } },
);
