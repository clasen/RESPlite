import { createHash } from 'node:crypto';
import { dispatch, resolveCommandName } from '../commands/registry.js';
import { SCRIPTABLE_COMMANDS } from './commands.js';

export function createScriptingPlugin(run, config) {
  const cache = new Map();
  let cacheBytes = 0;
  let owner = null;
  let closed = false;

  function checkOpen() {
    if (closed) throw new Error('Scripting plugin is closed');
  }

  function remember(source, sha = createHash('sha1').update(source).digest('hex')) {
    const existing = cache.get(sha);
    if (existing) {
      cache.delete(sha);
      cache.set(sha, existing);
      return sha;
    }
    if (source.length > config.maxCacheBytes) {
      throw new Error('ERR script exceeds scripting cache byte limit');
    }
    while (cache.size >= config.maxCachedScripts || cacheBytes + source.length > config.maxCacheBytes) {
      const oldest = cache.keys().next().value;
      cacheBytes -= cache.get(oldest).length;
      cache.delete(oldest);
    }
    cache.set(sha, Buffer.from(source));
    cacheBytes += source.length;
    return sha;
  }

  function validateSource(source) {
    if (source.length > config.maxScriptBytes) throw new Error('ERR script exceeds scripting source byte limit');
    if (source.length > config.maxCacheBytes) throw new Error('ERR script exceeds scripting cache byte limit');
  }

  return {
    attach(instance) {
      checkOpen();
      if (owner && owner !== instance) throw new Error('Scripting plugin already belongs to another server');
      owner = instance;
    },

    execute(command, engine, args, context) {
      checkOpen();
      if (command === 'SCRIPT') {
        const sub = args[0]?.toString('utf8').toUpperCase();
        if (sub === 'LOAD' && args.length === 2) {
          validateSource(args[1]);
          run(args[1], [], [], null, true);
          return remember(args[1]);
        }
        if (sub === 'EXISTS' && args.length >= 2) {
          return args.slice(1).map((sha) => cache.has(sha.toString('utf8').toLowerCase()) ? 1 : 0);
        }
        if (sub === 'FLUSH' && (args.length === 1
          || (args.length === 2 && args[1].toString('utf8').toUpperCase() === 'SYNC'))) {
          cache.clear();
          cacheBytes = 0;
          return { simple: 'OK' };
        }
        return { error: 'ERR unsupported SCRIPT subcommand or wrong number of arguments' };
      }
      if (args.length < 2) return { error: `ERR wrong number of arguments for '${command}' command` };
      const countString = args[1].toString('utf8');
      const count = Number(countString);
      if (!/^-?\d+$/.test(countString) || !Number.isSafeInteger(count)) {
        return { error: 'ERR value is not an integer or out of range' };
      }
      if (count < 0) return { error: "ERR Number of keys can't be negative" };
      if (count > args.length - 2) return { error: "ERR Number of keys can't be greater than number of args" };
      const sha = command === 'EVALSHA' ? args[0].toString('utf8').toLowerCase() : undefined;
      const source = command === 'EVAL' ? args[0] : cache.get(sha);
      if (!source) return { error: 'NOSCRIPT No matching script. Please use EVAL.' };
      validateSource(source);
      const call = (argv) => {
        if (!argv.length) return { error: 'ERR Please specify at least one argument for redis.call()' };
        const resolved = resolveCommandName(argv[0].toString('utf8'), context.commandPolicy);
        if (resolved === null) return { error: 'ERR command not supported yet' };
        if (!SCRIPTABLE_COMMANDS.has(resolved)) return { error: 'ERR command is not allowed from scripts' };
        const result = dispatch(engine, argv, { commandPolicy: context.commandPolicy });
        return result.error !== undefined ? { error: result.error } : result.result;
      };
      return engine.runScript(() => run(
        source, args.slice(2, 2 + count), args.slice(2 + count),
        call, false, () => remember(source, sha)
      ));
    },

    close() {
      if (closed) return;
      closed = true;
      cache.clear();
      cacheBytes = 0;
      owner = null;
    },
  };
}
