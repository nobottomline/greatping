// Lets `node --test` load the CLI's TypeScript sources, whose relative
// imports omit the extension as the bundler allows.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith('.') || /\.[cm]?[jt]s$/.test(specifier)) throw error;
      for (const suffix of ['.ts', '/index.ts']) {
        try {
          return nextResolve(`${specifier}${suffix}`, context);
        } catch {
          // Try the next form.
        }
      }
      throw error;
    }
  },
});
