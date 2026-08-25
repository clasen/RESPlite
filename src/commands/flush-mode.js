export function validateFlushMode(command, args) {
  if (args && args.length > 1) {
    return `ERR wrong number of arguments for '${command}' command`;
  }
  if (args?.length === 1) {
    const mode = args[0].toString('utf8').toUpperCase();
    if (mode !== 'SYNC' && mode !== 'ASYNC') return 'ERR syntax error';
  }
  return null;
}
