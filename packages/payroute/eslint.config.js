import tseslint from 'typescript-eslint';
export default tseslint.config({ ignores: ['dist/**', 'playground/dist/**', 'node_modules/**'] }, ...tseslint.configs.recommended, { languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } }, rules: { '@typescript-eslint/no-explicit-any': 'error' } });
