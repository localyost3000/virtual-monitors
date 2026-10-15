import eslint from '@eslint/js'
import { defineConfig } from 'eslint/config'
import prettier from 'eslint-config-prettier'
import simpleImportSort from 'eslint-plugin-simple-import-sort'
import unusedImports from 'eslint-plugin-unused-imports'

export default defineConfig(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'tmp/**'],
  },
  eslint.configs.recommended,
  prettier,
  {
    plugins: {
      'simple-import-sort': simpleImportSort,
      'unused-imports': unusedImports,
    },
    rules: {
      'simple-import-sort/imports': 'error',
      'simple-import-sort/exports': 'error',
      'no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'warn',
      curly: ['error', 'all'],
    },
  },
  {
    languageOptions: {
      globals: {
        console: 'readonly',
        global: 'readonly',
        imports: 'readonly',
        log: 'readonly',
        process: 'readonly',
      },
    },
  },
)
