import js from '@eslint/js'
import globals from 'globals'

export default [
  // supabase/ is SQL and config, except Edge Functions (JS run by Deno), which are linted
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'supabase/*', '!supabase/functions'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.browser } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // innerHTML must go through shared/ui/html.js (escaped templates)
      'no-restricted-properties': [
        'error',
        { property: 'outerHTML', message: 'Use render() from shared/ui/html.js' },
        { property: 'insertAdjacentHTML', message: 'Use render() from shared/ui/html.js' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: "AssignmentExpression[left.property.name='innerHTML']",
          message: 'Do not assign innerHTML directly; use render(el, html`...`) from shared/ui/html.js',
        },
      ],
    },
  },
  {
    files: ['src/shared/ui/html.js'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['supabase/functions/**/*.js'],
    languageOptions: { globals: { ...globals.serviceworker, Deno: 'readonly' } },
  },
  {
    files: ['tests/**/*.js', 'vite.config.js', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
]
