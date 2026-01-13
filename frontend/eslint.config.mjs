import next from '@next/eslint-plugin-next';
import tseslint from 'typescript-eslint';
import reactCompiler from 'eslint-plugin-react-compiler';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['.next/**', 'node_modules/**', 'out/**', 'build/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs}'],
    plugins: {
      '@next/next': next,
      'react-compiler': reactCompiler,
    },
    rules: {
      ...next.configs.recommended.rules,
      ...next.configs['core-web-vitals'].rules,
      'react-compiler/react-compiler': 'error',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  prettier,
);
