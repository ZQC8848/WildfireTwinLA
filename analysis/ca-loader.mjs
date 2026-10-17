// Node >=22.18 adapter for the existing Vite-only @core alias and TS imports.
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
const core = new URL('../packages/core/src/index.ts', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@core') return next(core, context);
  if (specifier.startsWith('.') && context.parentURL) {
    const url = new URL(specifier, context.parentURL);
    if (!/\.[a-z]+$/i.test(url.pathname) && existsSync(new URL(url.href + '.ts'))) return next(url.href + '.ts', context);
  }
  return next(specifier, context);
}});
