// Resolve this next to the running code, independently of the project's cwd.
import manifest from '../package.json' with { type: 'json' };

export const packaged = manifest.name === 'katatay';
