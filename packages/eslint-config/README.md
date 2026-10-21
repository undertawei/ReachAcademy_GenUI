# @reachany/eslint-config

Shared ESLint 9 flat config for ReachAcademy TypeScript and JavaScript packages.
It combines `@eslint/js` recommended rules with `typescript-eslint` recommended
rules for `*.ts` and `*.tsx` files.

Use it from package-level `eslint.config.js` files:

```js
export { default } from '@reachany/eslint-config';
```

The TypeScript file config disables core `no-unused-vars` and enables
`@typescript-eslint/no-unused-vars` with underscore-prefixed ignore patterns.
